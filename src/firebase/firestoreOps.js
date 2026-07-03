/**
 * firestoreOps.js — UUID 기반 Firebase 데이터 CRUD
 *
 * ★ 개인정보 보호 중심 설계 핵심 규칙 ★
 * 1. Firestore에 저장되는 학생 문서에는 실명(realName)이 절대 포함되지 않습니다.
 * 2. 학생은 UUID로만 식별됩니다.
 * 3. 실명 ↔ UUID 매핑은 교사 기기의 IndexedDB에만 존재합니다.
 * 4. nameHash는 SHA-256(실명+학급코드) — 단방향, 복호화 불가
 *
 * Firestore 컬렉션 구조:
 *   classes/{classCode}          교사 계정 정보 (실명 없음)
 *   students/{uuid}              학습 통계 + studentNumber(출석번호, 이름 아님) + strategyCounts / examResults[] / …
 *   students/{uuid}/quizResults  퀴즈 결과 (UUID 연결, 실명 없음)
 */

import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, query, where, orderBy, limit,
  writeBatch,
  arrayUnion,
  runTransaction,
  serverTimestamp,
  deleteField,
} from 'firebase/firestore';
import { db } from './config';
import { normalizeClassCode } from '../utils/classCode';
import { expandExamQuestionDoc } from '../utils/examSolutionArea';
import { applyStrategyApprovalSuccess } from '../utils/strategyBadgeEngine';
import { VARIANT_STRATEGY_ID_SET } from '../constants/investigationBadges';
import {
  recordUnitStrategyApproval,
  canStudentPeerApproveStrategy,
  resolveUnitKeyFromSource,
} from './unitProgressOps';
import {
  SUBMISSION_STATUS_PENDING,
  SUBMISSION_STATUS_PENDING_REVIEW,
  SUBMISSION_STATUS_PEER_REVIEW,
  SUBMISSION_STATUS_REGISTERED,
  SUBMISSION_STATUS_APPROVED,
  SUBMISSION_STATUS_APPROVED_PARTIAL,
  SUBMISSION_STATUS_REJECTED,
  PEER_APPROVAL_REQUIRED,
  VARIANT_REVIEW_OPEN_STATUSES,
} from '../constants/aiSubmissionPolicy';
import {
  syncMakingCompetencyFromVariantReview,
  syncMakingCompetencyFromProblemBank,
} from './makingEventsOps';
import {
  awardExplorationPoints,
  awardMakingExplorationFromVariantReview,
  awardMakingExplorationFromNewProblem,
} from './explorationRewardsOps';
import {
  EXPLORATION_REWARD_KIND,
  EXPLORATION_REWARD_POINTS,
} from '../constants/explorationRewards';
import { inferClassProblemReviewIds, buildVariantReviewId, legacyBankDocIdFromReviewId, resolveReviewIdForBankItem } from '../utils/variantBankIds';
import {
  mergeVariantReviewIntoProblemBankItem,
  pickProblemBankAiBackfillPatch,
  problemBankNeedsAiBackfill,
} from '../utils/studentAiFeedback';
import { sortStudentsByAttendance } from '../utils/mergeTeacherStudents';

/** 출석번호 — 양의 정수만 저장, 미지정·불량 시 Firestore에는 필드 미기록 */
function finitePositiveStudentNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

// ─────────────────────────────────────────────
// 학급(Class) 관련
// ─────────────────────────────────────────────

/** 교사 이메일 표기 통일 — 같은 사람의 여러 로그인을 묶어 조회하기 위함 */
export function normalizeTeacherEmail(email) {
  if (!email || typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/**
 * 학급 생성 (교사가 처음 대시보드를 열 때)
 * @param {string} classCode - 6자리 랜덤 학급 코드
 * @param {string} teacherUID - Firebase Auth UID
 * @param {string} className  - 학급 이름 (예: "4-3반")
 * @param {string} [teacherEmail] - 현재 로그인 이메일 (teacherEmails 초기값)
 */
export async function createClass(classCode, teacherUID, className, teacherEmail) {
  const norm = normalizeTeacherEmail(teacherEmail);
  await setDoc(doc(db, 'classes', classCode), {
    classCode,
    teacherUID,
    className,
    createdAt: new Date().toISOString(),
    studentCount: 0,
    ...(norm ? { teacherEmails: [norm] } : {}),
  });
}

/**
 * 이 교사 UID로 만든 모든 학급에 현재 이메일을 추가합니다 (예전 문서에 teacherEmails 없어도 보조 검색 가능하게 함).
 */
export async function syncTeacherEmailOnTeacherClasses(teacherUID, teacherEmail) {
  const norm = normalizeTeacherEmail(teacherEmail);
  if (!teacherUID || !norm) return;
  const q = query(collection(db, 'classes'), where('teacherUID', '==', teacherUID));
  const snap = await getDocs(q);
  await Promise.all(
    snap.docs.map((d) =>
      updateDoc(doc(db, 'classes', d.id), { teacherEmails: arrayUnion(norm) }).catch(() => {})
    )
  );
}

export async function canTeacherAccessClass(classCode, teacherUID, teacherEmail) {
  const cls = await getClass(classCode);
  if (!cls) return false;
  if (cls.teacherUID === teacherUID) return true;
  const norm = normalizeTeacherEmail(teacherEmail);
  if (!norm) return false;
  const list = cls.teacherEmails || [];
  return list.some((e) => normalizeTeacherEmail(e) === norm);
}

export async function getClass(classCode) {
  const snap = await getDoc(doc(db, 'classes', classCode));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// ─────────────────────────────────────────────
// 학급 코드 이관(마이그레이션)
// ─────────────────────────────────────────────

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function copySubcollectionDocs(fromPathParts, toPathParts) {
  const fromCol = collection(db, ...fromPathParts);
  const toColBase = (...rest) => doc(db, ...toPathParts, ...rest);
  const snap = await getDocs(fromCol);
  const docs = snap.docs;
  for (const group of chunkArray(docs, 400)) {
    const batch = writeBatch(db);
    for (const d of group) {
      batch.set(toColBase(d.id), d.data(), { merge: false });
    }
    await batch.commit();
  }
  return docs.length;
}

async function updateDocsByQuery(q, patchFactory) {
  const snap = await getDocs(q);
  const docs = snap.docs;
  for (const group of chunkArray(docs, 400)) {
    const batch = writeBatch(db);
    for (const d of group) {
      const patch = patchFactory(d);
      if (patch && typeof patch === 'object') batch.update(d.ref, patch);
    }
    await batch.commit();
  }
  return docs.length;
}

/**
 * 학급코드 이관:
 * - classes/{old} → classes/{new} (문서 복사)
 * - classes/{old}/problemBank, dailyProblemCounters, trashedExamResults → new로 복사
 * - students where classCode==old → classCode new로 업데이트
 * - students/{uuid}/problemBank 문서의 classCode도 함께 업데이트
 * - variantReviews, wrongNoteReviews 의 classCode도 업데이트
 *
 * @param {string} oldClassCode 예: SVT2S9
 * @param {string} newClassCode 예: (S/2 없는 새 코드)
 * @param {{ teacherUID: string, teacherEmail?: string, dryRun?: boolean }} opts
 */
export async function migrateClassCode(oldClassCode, newClassCode, opts = {}) {
  const oldCode = String(oldClassCode || '').trim().toUpperCase();
  const newCode = String(newClassCode || '').trim().toUpperCase();
  if (!oldCode || !newCode) throw new Error('기존/새 학급 코드가 필요합니다.');
  if (oldCode === newCode) throw new Error('새 학급 코드는 기존과 달라야 합니다.');

  const teacherUID = String(opts.teacherUID || '').trim();
  const teacherEmail = opts.teacherEmail;
  const dryRun = !!opts.dryRun;
  if (!teacherUID) throw new Error('교사 UID가 필요합니다.');

  // 접근권한 + 소유 검증
  const allowed = await canTeacherAccessClass(oldCode, teacherUID, teacherEmail);
  if (!allowed) throw new Error('이 학급에 접근 권한이 없습니다.');
  const oldClass = await getClass(oldCode);
  if (!oldClass) throw new Error('기존 학급 정보를 찾을 수 없습니다.');
  if (oldClass.teacherUID !== teacherUID) {
    throw new Error('학급 소유 교사만 학급코드를 이관할 수 있습니다.');
  }

  // 새 코드가 이미 존재하는 경우:
  // - 과거 이관 중간 실패로 classes/{newCode}만 생성된 상태일 수 있음
  // - 또는 같은 교사가 미리 만들어 둔 빈 학급일 수 있음
  // 이런 경우 "이어하기"를 허용하되, 다른 교사 소유 문서는 절대 덮어쓰지 않는다.
  const newSnap = await getDoc(doc(db, 'classes', newCode));
  if (newSnap.exists()) {
    const existing = { id: newSnap.id, ...newSnap.data() };
    const sameTeacher = existing.teacherUID === teacherUID;
    const looksLikeResume =
      existing.migratedFrom === oldCode
      || oldClass.migratedTo === newCode
      || existing.classCode === newCode;
    if (!(sameTeacher && looksLikeResume)) {
      throw new Error('새 학급 코드가 이미 존재합니다. 다른 코드를 사용해 주세요.');
    }
  }

  // (1) classes/{new} 생성
  const newClassPayload = {
    ...oldClass,
    id: undefined,
    classCode: newCode,
    migratedFrom: oldCode,
    migratedAt: new Date().toISOString(),
  };
  delete newClassPayload.id;

  // (2) 하위 컬렉션 복사
  // (3) 참조 컬렉션/문서의 classCode 업데이트
  if (dryRun) {
    return {
      dryRun: true,
      oldCode,
      newCode,
      note: 'dryRun=true: 실제 쓰기 작업은 수행하지 않았습니다.',
    };
  }

  // 새 학급 문서 생성/갱신 (이어하기 케이스면 merge로 보강)
  try {
    await setDoc(doc(db, 'classes', newCode), newClassPayload, { merge: true });
  } catch (e) {
    const err = new Error(`[migrateClassCode:classes.write] ${e?.message || String(e)}`);
    err.cause = e;
    throw err;
  }
  // 기존 문서에도 마이그레이션 표시(삭제는 하지 않음)
  await updateDoc(doc(db, 'classes', oldCode), {
    migratedTo: newCode,
    migratedAt: new Date().toISOString(),
  }).catch(() => {});

  // students: classCode 갱신 + 학생 problemBank 문서도 갱신
  const studentsQ = query(collection(db, 'students'), where('classCode', '==', oldCode));
  let studentsSnap;
  try {
    studentsSnap = await getDocs(studentsQ);
  } catch (e) {
    const err = new Error(`[migrateClassCode:students.query] ${e?.message || String(e)}`);
    err.cause = e;
    throw err;
  }
  const studentDocs = studentsSnap.docs;
  try {
    for (const group of chunkArray(studentDocs, 350)) {
      const batch = writeBatch(db);
      for (const d of group) {
        batch.update(d.ref, { classCode: newCode });
      }
      await batch.commit();
    }
  } catch (e) {
    const err = new Error(`[migrateClassCode:students.updateClassCode] ${e?.message || String(e)}`);
    err.cause = e;
    throw err;
  }

  // 학생 classCode 갱신이 성공한 뒤에 하위/검수 데이터 이동
  const copied = {};
  try {
    copied.problemBank = await copySubcollectionDocs(
      ['classes', oldCode, 'problemBank'],
      ['classes', newCode, 'problemBank']
    );
    copied.dailyProblemCounters = await copySubcollectionDocs(
      ['classes', oldCode, 'dailyProblemCounters'],
      ['classes', newCode, 'dailyProblemCounters']
    );
    copied.trashedExamResults = await copySubcollectionDocs(
      ['classes', oldCode, 'trashedExamResults'],
      ['classes', newCode, 'trashedExamResults']
    );
  } catch (e) {
    const err = new Error(`[migrateClassCode:classes.subcollections.copy] ${e?.message || String(e)}`);
    err.cause = e;
    throw err;
  }

  let updatedStudentProblemBank = 0;
  try {
    for (const d of studentDocs) {
      const uuid = d.id;
      const pbSnap = await getDocs(collection(db, 'students', uuid, 'problemBank'));
      const toUpdate = pbSnap.docs.filter((x) => (x.data()?.classCode || '') === oldCode);
      for (const group of chunkArray(toUpdate, 400)) {
        const batch = writeBatch(db);
        for (const row of group) batch.update(row.ref, { classCode: newCode });
        await batch.commit();
      }
      updatedStudentProblemBank += toUpdate.length;
    }
  } catch (e) {
    const err = new Error(`[migrateClassCode:students.problemBank.updateClassCode] ${e?.message || String(e)}`);
    err.cause = e;
    throw err;
  }

  // variantReviews / wrongNoteReviews
  let updatedVariantReviews = 0;
  let updatedWrongNoteReviews = 0;
  try {
    updatedVariantReviews = await updateDocsByQuery(
      query(collection(db, 'variantReviews'), where('classCode', '==', oldCode)),
      () => ({ classCode: newCode })
    );
    updatedWrongNoteReviews = await updateDocsByQuery(
      query(collection(db, 'wrongNoteReviews'), where('classCode', '==', oldCode)),
      () => ({ classCode: newCode })
    );
  } catch (e) {
    const err = new Error(`[migrateClassCode:reviews.updateClassCode] ${e?.message || String(e)}`);
    err.cause = e;
    throw err;
  }

  return {
    dryRun: false,
    oldCode,
    newCode,
    copied,
    updated: {
      students: studentDocs.length,
      studentProblemBank: updatedStudentProblemBank,
      variantReviews: updatedVariantReviews,
      wrongNoteReviews: updatedWrongNoteReviews,
    },
  };
}

/**
 * 해당 교사의 학급 목록 (동일 UID 소유 + teacherEmails에 현재 이메일이 포함된 문서 통합)
 */
export async function getClassesByTeacher(teacherUID, teacherEmail) {
  const qUid = query(collection(db, 'classes'), where('teacherUID', '==', teacherUID));
  const snapUid = await getDocs(qUid);
  const byUid = snapUid.docs.map((d) => ({ id: d.id, ...d.data() }));
  const norm = normalizeTeacherEmail(teacherEmail);
  if (!norm) {
    return byUid.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  const qEmail = query(
    collection(db, 'classes'),
    where('teacherEmails', 'array-contains', norm)
  );
  const snapEmail = await getDocs(qEmail);
  const byEmail = snapEmail.docs.map((d) => ({ id: d.id, ...d.data() }));

  const byCode = new Map();
  [...byUid, ...byEmail].forEach((c) => {
    const code = c.classCode || c.id;
    if (!byCode.has(code)) byCode.set(code, c);
  });
  return Array.from(byCode.values()).sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || '')
  );
}

export async function updateClassStudentCount(classCode, delta) {
  const ref = doc(db, 'classes', classCode);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const current = snap.data().studentCount || 0;
    await updateDoc(ref, { studentCount: Math.max(0, current + delta) });
  }
}

// ─────────────────────────────────────────────
// 학생(Student) 관련 — 실명 없음, UUID + 해시만
// ─────────────────────────────────────────────

/**
 * 학생 계정 생성
 * @param {{ uuid: string, classCode: string, nameHash: string, pinHash: string, studentNumber?: number|string, displayName?: string }} studentData — studentNumber 출석번호(선택). displayName은 학급 랭킹 표시용.
 */
export async function createStudent({ uuid, classCode, nameHash, pinHash, studentNumber, displayName }) {
  const sn = finitePositiveStudentNumber(studentNumber);
  const dn = typeof displayName === 'string' ? displayName.trim() : '';
  await setDoc(doc(db, 'students', uuid), {
    uuid,
    classCode,
    nameHash,     // SHA-256(실명+학급코드) — 실명 자체는 미저장
    pinHash,      // SHA-256(PIN+학급코드) — 평문 PIN 미저장
    ...(sn !== null ? { studentNumber: sn } : {}),
    ...(dn ? { displayName: dn } : {}),
    totalSolved:  0,
    totalCorrect: 0,
    anonUID:      null,   // Firebase 익명 로그인 후 업데이트
    createdAt:    new Date().toISOString(),
    lastActive:   null,
    /** 변형 전략(6종)별 API 검증 통과 횟수 */
    strategyCounts: {},
    /** 전략별 { novice, adept, legendary } — 각각 해당 누적 횟수 도달 시 true */
    strategyBadges: {},
    /** 전략·티어별 획득 시각(ISO) — 마이페이지 진열대 표시용 */
    strategyBadgeUnlockedAt: {},
    explorationPoints: 0,
    explorationDaily: {},
    explorationRolling30: 0,
    unitProgress: {},
    creativeOtterCollection: {},
    activeUnitKey: '',
  });
  await updateClassStudentCount(classCode, +1);
}

/**
 * nameHash로 학생 조회 (동일 학급·동일 이름이 여러 명일 수 있음)
 * @param {string} classCode
 * @param {string} nameHash
 * @returns {Promise<Array<Object>>}
 */
export async function getStudentsByNameHash(classCode, nameHash) {
  return getStudentsByNameHashInClassCodes([classCode], nameHash);
}

/** @deprecated 단일 결과만 필요할 때 — 가능하면 getStudentsByNameHash 사용 */
export async function getStudentByNameHash(classCode, nameHash) {
  const rows = await getStudentsByNameHash(classCode, nameHash);
  return rows[0] || null;
}

/**
 * nameHash로 학생 조회 (동일 해시가 여러 학급 코드에 걸칠 수 있음 — 이관/레거시 대응)
 *
 * 주의:
 * - Firestore는 `where(nameHash == ...)`만 걸고,
 * - classCode는 클라이언트에서 후필터링합니다.
 *
 * 이관 시나리오:
 * - 학생 문서의 `classCode`는 새 코드로 갱신되었지만,
 * - nameHash/pinHash는 과거(이전 코드)를 salt로 생성되어 남아 있을 수 있습니다.
 * 이때 로그인(이전 코드로 해시 시도)이 실패하지 않도록
 * 허용 classCode 집합으로 필터링할 수 있게 합니다.
 *
 * @param {string[]} classCodes 허용할 classCode 목록(대소문자 혼용 가능)
 * @param {string} nameHash
 * @returns {Promise<Array<Object>>}
 */
export async function getStudentsByNameHashInClassCodes(classCodes, nameHash) {
  const allow = new Set(
    (Array.isArray(classCodes) ? classCodes : [])
      .map((cc) => normalizeClassCode(cc))
      .filter(Boolean)
  );
  if (!allow.size) return [];

  const q = query(
    collection(db, 'students'),
    where('nameHash', '==', nameHash),
    limit(20)
  );
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((row) => allow.has(normalizeClassCode(row.classCode)));
}

/**
 * UUID로 학생 조회
 */
export async function getStudentByUUID(uuid) {
  const snap = await getDoc(doc(db, 'students', uuid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * 학급 전체 학생 조회 (교사 대시보드용)
 *
 * 과거 저장본에 classCode 대소문자가 섞인 경우까지 합산·문서 ID 기준으로 중복 제거
 */
export async function getStudentsByClass(classCode) {
  const raw = String(classCode ?? '').trim();
  if (!raw) return [];

  const norm = normalizeClassCode(raw);
  const lower = norm.toLowerCase();

  async function fetchByCode(cc) {
    const qRef = query(
      collection(db, 'students'),
      where('classCode', '==', cc)
    );
    const snap = await getDocs(qRef);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  const byDocId = new Map();
  (await fetchByCode(norm)).forEach((row) => byDocId.set(row.id, row));
  // 일부 구버전/직접 입력에서 소문자 classCode 로 저장된 문서까지 포함
  if (lower && lower !== norm) {
    (await fetchByCode(lower)).forEach((row) => byDocId.set(row.id, row));
  }
  if (norm !== raw) {
    (await fetchByCode(raw)).forEach((row) => byDocId.set(row.id, row));
  }

  return sortStudentsByAttendance(Array.from(byDocId.values()));
}

/**
 * 학급 코드 + 출석번호로 학생 UUID 조회 (스캔 채점 저장용).
 * 복합 인덱스 없이 getStudentsByClass 결과에서 필터합니다.
 * @param {string} classCode
 * @param {number|string} studentNumber
 * @returns {Promise<string|null>}
 */
export async function getStudentUuidByClassAndStudentNumber(classCode, studentNumber) {
  const sn = finitePositiveStudentNumber(studentNumber);
  if (sn === null) return null;
  const rows = await getStudentsByClass(classCode);
  const found = rows.find((r) => finitePositiveStudentNumber(r.studentNumber) === sn);
  if (!found) return null;
  const id = String(found.uuid ?? found.id ?? '').trim();
  return id || null;
}

/**
 * 시험 채점 결과를 students/{uuid}.examResults 에追加 (arrayUnion).
 *
 * 주의: 이 함수는 교사의 「스캔본 자동 정리 → 학생DB 저장」 흐름에서만 호출됩니다.
 * 학생 본인의 접속/활동이 아니므로 `lastActive`(마지막 접속)는 갱신하지 않습니다.
 * lastActive 는 학생 본인의 행위(익명 로그인, 퀴즈 풀이, 변형 문제 검증 등)에서만 갱신됩니다.
 *
 * @param {string} uuid
 * @param {{
 *   examName: string,
 *   grade?: string,
 *   semester?: string,
 *   unit?: string,
 *   studentNumber: number|null,
 *   results: Array<{ problemNumber: number, correct: boolean }>,
 *   totalCorrect: number,
 *   totalCount: number,
 *   scoredAt: string,
 *   manualScore?: number|null,
 *   maxScore?: number,
 * }} entry
 */
export async function appendStudentExamResult(uuid, entry) {
  if (!uuid) throw new Error('uuid가 필요합니다.');
  const ref = doc(db, 'students', uuid);
  await updateDoc(ref, {
    examResults: arrayUnion(entry),
  });
}

/**
 * 단원평가 오답노트 (students/{uuid}/examWrongNotes/{examResultId})
 * @param {string} uuid
 * @param {string} examResultId examResultDocId(entry)
 */
export async function getExamWrongNote(uuid, examResultId) {
  if (!uuid || !examResultId) return null;
  const snap = await getDoc(doc(db, 'students', uuid, 'examWrongNotes', examResultId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** 학생의 단원평가 오답노트 전체 (홈 알림·역량 집계용) */
export async function getStudentExamWrongNotes(uuid) {
  if (!uuid) return [];
  const snap = await getDocs(collection(db, 'students', uuid, 'examWrongNotes'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * 학생이 저장한 오답노트가 "시험 재채점(새 scoredAt)"으로 인해 문서 ID가 달라져
 * 최신 채점본에서 못 보이는 문제를 완화합니다.
 *
 * - 현재 examResultId 문서가 없으면, 같은 시험 메타(examName/grade/semester/unit)로 저장된
 *   기존 오답노트를 examWrongNotes 서브컬렉션 전체에서 찾아 반환합니다.
 *
 * @param {string} uuid
 * @param {{ examName?: string, grade?: string, semester?: string, unit?: string }} entry
 * @returns {Promise<null | { id: string } & Record<string, any>>}
 */
export async function findExamWrongNoteByMeta(uuid, entry) {
  if (!uuid) return null;
  const examName = String(entry?.examName ?? '').trim();
  const grade = String(entry?.grade ?? '').trim();
  const semester = String(entry?.semester ?? '').trim();
  const unit = String(entry?.unit ?? '').trim();
  if (!examName) return null;

  const snap = await getDocs(collection(db, 'students', uuid, 'examWrongNotes'));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const matched = rows.filter((r) => {
    if (String(r?.examName ?? '').trim() !== examName) return false;
    if (grade && String(r?.grade ?? '').trim() !== grade) return false;
    if (semester && String(r?.semester ?? '').trim() !== semester) return false;
    if (unit && String(r?.unit ?? '').trim() !== unit) return false;
    return true;
  });
  if (!matched.length) return null;

  // 같은 메타로 여러 개면 최신 updatedAt/scoredAt 우선
  matched.sort((a, b) => {
    const ua = Date.parse(a?.updatedAt || a?.studentReviewedAt || a?.scoredAt || 0) || 0;
    const ub = Date.parse(b?.updatedAt || b?.studentReviewedAt || b?.scoredAt || 0) || 0;
    return ub - ua;
  });
  return matched[0];
}

/**
 * @param {string} uuid
 * @param {string} examResultId
 * @param {{
 *   examName?: string,
 *   grade?: string,
 *   semester?: string,
 *   unit?: string,
 *   scoredAt?: string,
 *   notes?: Record<string, string>,
 *   noteDetails?: Record<string, { reason?: string, prevention?: string, solution?: string, answer?: string, aiReview?: object, submittedAt?: string }>,
 *   studentProblemCorrect?: Record<string, boolean>,
 *   studentReviewedAt?: string,
 * }} payload
 */
export async function saveExamWrongNote(uuid, examResultId, payload) {
  if (!uuid || !examResultId) throw new Error('uuid와 examResultId가 필요합니다.');
  const ref = doc(db, 'students', uuid, 'examWrongNotes', examResultId);
  const data = {
    examName: payload.examName ?? '',
    grade: payload.grade ?? '',
    semester: payload.semester ?? '',
    unit: payload.unit ?? '',
    scoredAt: payload.scoredAt ?? '',
    notes: payload.notes ?? {},
    updatedAt: new Date().toISOString(),
  };
  if (payload.noteDetails && typeof payload.noteDetails === 'object') {
    data.noteDetails = payload.noteDetails;
  }
  if (payload.studentProblemCorrect && typeof payload.studentProblemCorrect === 'object') {
    data.studentProblemCorrect = payload.studentProblemCorrect;
  }
  if (payload.studentReviewedAt) {
    data.studentReviewedAt = payload.studentReviewedAt;
  }
  await setDoc(ref, data, { merge: true });
}

/**
 * 익명 UID 업데이트 (학생 첫 로그인 시 Firebase 익명 인증 연동)
 */
export async function updateStudentAnonUID(uuid, anonUID) {
  await updateDoc(doc(db, 'students', uuid), {
    anonUID,
    lastActive: new Date().toISOString(),
  });
}

/** 학급 랭킹 표시용 이름 (학생 본인 로그인 시 동기화) */
export async function updateStudentDisplayName(uuid, displayName) {
  const dn = typeof displayName === 'string' ? displayName.trim() : '';
  if (!uuid || !dn) return;
  await updateDoc(doc(db, 'students', uuid), { displayName: dn });
}

/**
 * PIN 초기화 (교사가 대시보드에서 실행)
 */
export async function resetStudentPIN(uuid, newPinHash) {
  await updateDoc(doc(db, 'students', uuid), { pinHash: newPinHash });
}

/** writeBatch 업데이트 한 번에 넣을 최대 문서 수(한도 여유) */
const STUDENT_BATCH_SIZE = 400;

/**
 * Firestore 학생 문서에 `studentNumber`가 없거나 파싱 불가일 때만,
 * 교사 IndexedDB 매핑(동일 학급·동일 UUID)의 출석번호로 백필합니다.
 * 실명은 전송하지 않습니다.
 *
 * 이미 서버에 유효한 출석번호가 있으면 덮어쓰지 않습니다.
 *
 * @param {string} classCode
 * @param {Array} serverStudents getStudentsByClass 결과
 * @param {Array} localMappings 동일 학급으로 필터된 IndexedDB 매핑
 * @returns {Promise<{ updated: number }>}
 */
export async function backfillStudentNumbersFromMappings(classCode, serverStudents, localMappings) {
  const wantCc = normalizeClassCode(classCode);
  if (!wantCc || !Array.isArray(localMappings) || !localMappings.length) {
    return { updated: 0 };
  }

  const byUuidLocalSn = new Map();
  localMappings.forEach((m) => {
    const id = String(m?.uuid ?? '').trim();
    if (!id) return;
    if (normalizeClassCode(m?.classCode) !== wantCc) return;
    const sn = finitePositiveStudentNumber(m.studentNumber);
    if (sn === null) return;
    byUuidLocalSn.set(id, sn);
  });

  if (!byUuidLocalSn.size) return { updated: 0 };

  const toWrite = [];

  (serverStudents || []).forEach((row) => {
    const sid = String((row.uuid ?? row.id) || '').trim();
    if (!sid) return;
    if (normalizeClassCode(row.classCode) !== wantCc) return;

    const localSn = byUuidLocalSn.get(sid);
    if (localSn === undefined) return;

    if (finitePositiveStudentNumber(row.studentNumber) !== null) return;

    toWrite.push({ uuid: sid, studentNumber: localSn });
  });

  let updated = 0;
  for (let i = 0; i < toWrite.length; i += STUDENT_BATCH_SIZE) {
    const slice = toWrite.slice(i, i + STUDENT_BATCH_SIZE);
    const batch = writeBatch(db);
    slice.forEach(({ uuid: u, studentNumber: sn }) => {
      batch.update(doc(db, 'students', u), { studentNumber: sn });
    });
    await batch.commit();
    updated += slice.length;
  }

  return { updated };
}

/**
 * 교사 IndexedDB 매핑의 실명을 학급 랭킹용 displayName 으로 Firestore에 백필합니다.
 * 서버 displayName 이 없거나 로컬과 다를 때만 갱신합니다.
 */
export async function backfillStudentDisplayNamesFromMappings(classCode, serverStudents, localMappings) {
  const wantCc = normalizeClassCode(classCode);
  if (!wantCc || !Array.isArray(localMappings) || !localMappings.length) {
    return { updated: 0 };
  }

  const byUuidLocalName = new Map();
  localMappings.forEach((m) => {
    const id = String(m?.uuid ?? '').trim();
    if (!id) return;
    if (normalizeClassCode(m?.classCode) !== wantCc) return;
    const name = typeof m.realName === 'string' ? m.realName.trim() : '';
    if (!name) return;
    byUuidLocalName.set(id, name);
  });

  if (!byUuidLocalName.size) return { updated: 0 };

  const toWrite = [];
  (serverStudents || []).forEach((row) => {
    const sid = String((row.uuid ?? row.id) || '').trim();
    if (!sid) return;
    if (normalizeClassCode(row.classCode) !== wantCc) return;

    const localName = byUuidLocalName.get(sid);
    if (!localName) return;

    const serverName = String(row.displayName || '').trim();
    if (serverName === localName) return;

    toWrite.push({ uuid: sid, displayName: localName });
  });

  let updated = 0;
  for (let i = 0; i < toWrite.length; i += STUDENT_BATCH_SIZE) {
    const slice = toWrite.slice(i, i + STUDENT_BATCH_SIZE);
    const batch = writeBatch(db);
    slice.forEach(({ uuid: u, displayName: dn }) => {
      batch.update(doc(db, 'students', u), { displayName: dn });
    });
    await batch.commit();
    updated += slice.length;
  }

  return { updated };
}

/**
 * 최종 승인 시 단원별 전략 승인·뱃지 갱신 (AI 통과만으로는 호출하지 않음)
 *
 * @param {string} uuid
 * @param {string} strategyId
 * @param {string} [unitKey]
 */
export async function recordVerifiedVariantStrategySuccess(uuid, strategyId, unitKey = '') {
  const sid = String(strategyId || '').trim();
  const key = String(unitKey || '').trim();
  if (!uuid || !VARIANT_STRATEGY_ID_SET.has(sid)) {
    return { ok: false, reason: 'invalid_strategy_or_uuid' };
  }
  if (key && /^\d+-\d+-\d+$/.test(key)) {
    return recordUnitStrategyApproval(uuid, key, sid);
  }

  const ref = doc(db, 'students', uuid);
  try {
    const out = await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists()) return { ok: false, reason: 'no_student' };
      const d = snap.data();
      const unlockedAtIso = new Date().toISOString();
      const patch = applyStrategyApprovalSuccess(
        {
          unitProgress: d.unitProgress || {},
          strategyCounts: d.strategyCounts || {},
          strategyBadges: d.strategyBadges || {},
          strategyBadgeUnlockedAt: d.strategyBadgeUnlockedAt || {},
        },
        sid,
        unlockedAtIso,
        key,
      );
      if (!patch) return { ok: false, reason: 'apply_failed' };
      transaction.update(ref, {
        ...patch,
        lastActive: unlockedAtIso,
      });
      return {
        ok: true,
        newlyUnlocked: patch.newlyUnlocked,
        newCount: patch.newCount,
        strategyId: patch.strategyId,
      };
    });
    return out;
  } catch (e) {
    console.error('[recordVerifiedVariantStrategySuccess]', e);
    return { ok: false, reason: 'transaction_error' };
  }
}

/** @param {object} review variantReviews 또는 class problem 스냅샷 */
export async function recordFinalApprovalUnitProgress(studentUUID, review) {
  const uuid = String(studentUUID || '').trim();
  const strategyId = String(review?.variantStrategyId || '').trim();
  if (!uuid || !strategyId) return { ok: false, reason: 'invalid_args' };

  let unitKey = resolveUnitKeyFromSource(review);
  if (!unitKey && review?.classCode && review?.classProblemId) {
    try {
      const classSnap = await getDoc(
        doc(db, 'classes', normalizeClassCode(review.classCode), 'problemBank', review.classProblemId),
      );
      if (classSnap.exists()) {
        unitKey = resolveUnitKeyFromSource(classSnap.data());
      }
    } catch (e) {
      console.warn('[recordFinalApprovalUnitProgress] class problem lookup', e?.message);
    }
  }
  if (!unitKey) return { ok: false, reason: 'no_unit_key' };
  return recordUnitStrategyApproval(uuid, unitKey, strategyId);
}

/**
 * 학생 삭제 (학습 기록 포함 — 복구 불가)
 */
export async function deleteStudent(uuid) {
  // 퀴즈 결과 먼저 일괄 삭제
  const resultsSnap = await getDocs(collection(db, 'students', uuid, 'quizResults'));
  const batch = writeBatch(db);
  resultsSnap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();

  // 학생 문서 삭제
  const studentSnap = await getDoc(doc(db, 'students', uuid));
  if (studentSnap.exists()) {
    const { classCode } = studentSnap.data();
    await deleteDoc(doc(db, 'students', uuid));
    await updateClassStudentCount(classCode, -1);
  }
}

// ─────────────────────────────────────────────
// 퀴즈 결과 — UUID로만 연결, 실명 없음
// ─────────────────────────────────────────────

/**
 * 퀴즈 결과 저장
 * studentName은 서버에 저장되지 않음
 */
export async function saveQuizResult(uuid, {
  topic, topicLabel, difficulty, difficultyLabel,
  problems, totalProblems, correctCount, score,
}) {
  await addDoc(collection(db, 'students', uuid, 'quizResults'), {
    uuid,           // 실명 아닌 UUID
    topic,
    topicLabel,
    difficulty,
    difficultyLabel,
    problems: problems.map((p) => ({
      questionNumber: p.questionNumber,
      isCorrect:      p.isCorrect,
      solveTime:      p.solveTime,
      // 문제 내용은 저장하지 않음 (불필요한 데이터 최소화)
    })),
    totalProblems,
    correctCount,
    score,
    completedAt: new Date().toISOString(),
  });

  // 통계 업데이트
  const ref  = doc(db, 'students', uuid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const prev = snap.data();
    await updateDoc(ref, {
      totalSolved:  (prev.totalSolved  || 0) + totalProblems,
      totalCorrect: (prev.totalCorrect || 0) + correctCount,
      lastActive:   new Date().toISOString(),
    });
  }
}

/**
 * 퀴즈 결과 목록 조회
 */
export async function getQuizResults(uuid, maxCount = 20) {
  const q = query(
    collection(db, 'students', uuid, 'quizResults'),
    orderBy('completedAt', 'desc'),
    limit(maxCount)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ─────────────────────────────────────────────
// 학생 변형 문제 저장소 (problemBank) — 실명 없음
// ─────────────────────────────────────────────

export async function addStudentProblemBank(uuid, data) {
  const ref = await addDoc(collection(db, 'students', uuid, 'problemBank'), {
    ...data,
    savedAt: new Date().toISOString(),
  });
  return ref.id;
}

/** @returns {Promise<Array<{ id: string } & Object>>} */
export async function getStudentProblemBank(uuid) {
  const snap = await getDocs(collection(db, 'students', uuid, 'problemBank'));
  let list = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));

  list = await backfillMissingStudentProblemBank(uuid, list);

  const reviewIds = list
    .map((item) => resolveReviewIdForBankItem(item, uuid))
    .filter(Boolean);
  if (reviewIds.length === 0) return list;

  const reviews = await getVariantReviewsByIds(reviewIds);
  const byReviewId = new Map(reviews.map((row) => [row.id, row]));

  return list.map((item) => {
    let row = item;
    if (row.status === SUBMISSION_STATUS_REJECTED && !row.teacherReviewStatus) {
      const repair = {
        teacherReviewStatus: SUBMISSION_STATUS_REJECTED,
        status: SUBMISSION_STATUS_REGISTERED,
      };
      row = { ...row, ...repair };
      updateDoc(doc(db, 'students', uuid, 'problemBank', row.id), repair).catch((e) => {
        console.warn('[getStudentProblemBank] legacy reject repair skipped', row.id, e?.code);
      });
    }

    const reviewId = resolveReviewIdForBankItem(row, uuid);
    const variantReview = reviewId ? byReviewId.get(reviewId) : null;
    const merged = mergeVariantReviewIntoProblemBankItem(row, variantReview);

    if (variantReview && problemBankNeedsAiBackfill(row, merged)) {
      const patch = pickProblemBankAiBackfillPatch(merged);
      updateDoc(doc(db, 'students', uuid, 'problemBank', row.id), patch).catch((e) => {
        console.warn('[getStudentProblemBank] ai backfill skipped', row.id, e?.code);
      });
    }

    return merged;
  });
}

/** 검수 대기 중 철회 시 variantReviews·exams/variants 도 함께 정리 */
const VARIANT_REVIEW_PENDING_STATUSES = new Set([
  SUBMISSION_STATUS_PENDING,
  SUBMISSION_STATUS_PENDING_REVIEW,
  SUBMISSION_STATUS_PEER_REVIEW,
]);

export async function deleteStudentProblemBank(uuid, docId) {
  const bankRef = doc(db, 'students', uuid, 'problemBank', docId);
  const snap = await getDoc(bankRef);
  if (!snap.exists()) return;

  const data = snap.data();
  const awaitingReview = VARIANT_REVIEW_PENDING_STATUSES.has(data.status);
  const examId = data.examId;
  const sourceNumber = data.sourceNumber;
  const bankDocId = data.bankDocId || docId;
  const reviewId = data.reviewId
    || (examId && sourceNumber != null
      ? `exam_${examId}_s${uuid}_q${sourceNumber}`
      : null);

  if (awaitingReview && reviewId) {
    const reviewRef = doc(db, 'variantReviews', reviewId);
    const deletes = [deleteDoc(reviewRef)];
    if (examId && bankDocId) {
      deletes.push(
        deleteDoc(doc(db, 'exams', examId, 'variants', uuid, 'questions', bankDocId)),
      );
    } else if (examId && sourceNumber != null) {
      deletes.push(
        deleteDoc(doc(db, 'exams', examId, 'variants', uuid, 'questions', String(sourceNumber))),
      );
    }
    await Promise.all(deletes);
  }

  await deleteDoc(bankRef);
}

// ─────────────────────────────────────────────
// 시험지 / 문항 조회 (학생 문제 변형용)
// ─────────────────────────────────────────────

/** studentVisible === false 인 시험지는 학생 「시험지 고르기」에서 제외 */
export function filterExamsVisibleToStudents(exams) {
  if (!Array.isArray(exams)) return [];
  return exams.filter((e) => e.studentVisible !== false);
}

/**
 * 저장된 시험지 목록 전체 조회
 * @param {{ forStudent?: boolean }} [opts] forStudent: true면 studentVisible===false 제외
 */
export async function getExamList({ forStudent = false } = {}) {
  const snap = await getDocs(collection(db, 'exams'));
  let list = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  if (forStudent) list = filterExamsVisibleToStudents(list);
  return list;
}

/**
 * 학급에서 학생에게 숨긴 채점 결과 그룹 키 목록
 * @param {string} classCode
 * @returns {Promise<string[]>}
 */
export async function getClassHiddenExamResultKeys(classCode) {
  const cls = await getClass(classCode);
  const raw = cls?.hiddenExamResultKeys;
  return Array.isArray(raw) ? raw.filter((k) => typeof k === 'string' && k) : [];
}

/**
 * 채점 결과 그룹(시험명·학년·학기·단원)을 학생에게 보이거나 숨깁니다.
 * @param {string} classCode
 * @param {string} groupKey examResultGroupKey()
 * @param {boolean} visible
 */
export async function setClassExamResultVisible(classCode, groupKey, visible) {
  if (!classCode || !groupKey) throw new Error('학급·시험 키가 필요합니다.');
  const ref = doc(db, 'classes', classCode);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('학급을 찾을 수 없습니다.');
  const prev = snap.data().hiddenExamResultKeys;
  const set = new Set(Array.isArray(prev) ? prev : []);
  if (visible) set.delete(groupKey);
  else set.add(groupKey);
  await updateDoc(ref, { hiddenExamResultKeys: [...set] });
}

/**
 * 「기존 문제 변형하기」 시험지 고르기 — 학생 노출 여부
 * @param {string} examId
 * @param {boolean} studentVisible
 */
export async function setExamStudentVisible(examId, studentVisible) {
  if (!examId) throw new Error('시험지 ID가 필요합니다.');
  await updateDoc(doc(db, 'exams', examId), { studentVisible: !!studentVisible });
}

/**
 * 현재 교사가 만든 시험지만 (시험지 OCR·단원평가 등 공통 exams 컬렉션)
 */
export async function getExamsCreatedByTeacher(teacherUid) {
  if (!teacherUid) return [];
  const q = query(collection(db, 'exams'), where('createdBy', '==', teacherUid));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * 시험지(exams)와 하위 questions 하위 문서만 삭제 (variants 등은 별도 보관 시 잔여 가능)
 */
export async function deleteTeacherExam(examId) {
  const qs = await getDocs(collection(db, 'exams', examId, 'questions'));
  for (const d of qs.docs) {
    await deleteDoc(d.ref);
  }
  await deleteDoc(doc(db, 'exams', examId));
}

/**
 * 특정 시험지의 문항 목록 조회
 * @param {string} examId
 */
export async function getExamQuestions(examId, { forDisplay = false } = {}) {
  const snap = await getDocs(collection(db, 'exams', examId, 'questions'));
  return snap.docs
    .map((d) => {
      const row = { id: d.id, ...d.data() };
      return forDisplay ? expandExamQuestionDoc(row) : row;
    })
    .sort((a, b) => (a.number || 0) - (b.number || 0));
}

// ─────────────────────────────────────────────
// 학급 전체 초기화 (복구 불가 영구 삭제)
// ─────────────────────────────────────────────

/**
 * 학급의 모든 데이터를 서버에서 영구 삭제합니다.
 * IndexedDB 삭제는 호출 측에서 deleteMappingsByClass()로 처리합니다.
 * @param {string} classCode
 */
export async function purgeClassData(classCode) {
  const students = await getStudentsByClass(classCode);

  for (const student of students) {
    await deleteStudent(student.uuid);
  }

  // 학급 문서 삭제
  await deleteDoc(doc(db, 'classes', classCode));
}

// ─────────────────────────────────────────────
// 교사 Gemini API 키 관리
// ─────────────────────────────────────────────

/**
 * 교사의 Gemini API 키를 저장합니다.
 * teachers/{uid}.geminiApiKey + 교사의 모든 학급 classes/{classCode}.teacherGeminiKey 에 반영
 * @param {string} teacherUID
 * @param {string} geminiKey  'AIza...' 형식의 Gemini API 키 (빈 문자열이면 제거)
 */
export async function saveTeacherGeminiKey(teacherUID, geminiKey) {
  if (!teacherUID) throw new Error('교사 UID가 필요합니다.');
  const trimmed = (geminiKey || '').trim();

  // 1. teachers/{uid} 에 저장
  await updateDoc(doc(db, 'teachers', teacherUID), { geminiApiKey: trimmed });

  // 2. 교사의 모든 학급에 전파
  const q = query(collection(db, 'classes'), where('teacherUID', '==', teacherUID));
  const snap = await getDocs(q);
  await Promise.all(
    snap.docs.map((d) =>
      updateDoc(doc(db, 'classes', d.id), { teacherGeminiKey: trimmed }).catch(() => {})
    )
  );
}

/**
 * 학급 코드로 교사의 Gemini API 키를 조회합니다. (학생 측에서 호출)
 * @param {string} classCode
 * @returns {Promise<string>} 키 문자열 (없으면 '')
 */
export async function getTeacherGeminiKeyForClass(classCode) {
  if (!classCode) return '';
  try {
    const snap = await getDoc(doc(db, 'classes', classCode));
    if (!snap.exists()) return '';
    return (snap.data().teacherGeminiKey || '').trim();
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────
// 변형 문제 검수 (variantReviews 컬렉션)
// ─────────────────────────────────────────────

/** Firestore 규칙 studentUpdatesOwnRegisteredVariantReview 와 동일 */
const REGISTERED_VARIANT_REVIEW_UPDATE_FIELDS = [
  'question', 'bogi', 'choices', 'solutionProcess', 'answer', 'nameMap',
  'variantStrategyId', 'variantStrategyName',
  'status', 'aiReviewStatus', 'aiNote', 'aiMode', 'aiApproved', 'aiChecks',
  'aiCompletionLevel', 'classProblemId', 'classProblemLabel', 'bankDocId',
  'resolvedAt', 'teacherComment',
];

/** 수정 시에도 문서 식별·생성(merge)에 필요 — 학생은 variantReviews 읽기 불가 */
const VARIANT_REVIEW_IDENTITY_FIELDS = [
  'studentUUID', 'examId', 'examTitle', 'examGrade', 'questionNumber', 'bankDocId',
];

/**
 * 학생 변형 문제를 variantReviews 컬렉션에 저장 (교사 검수 / 동료 검토용).
 *
 * peer_review 상태인 경우 peerApprovals 배열 초기화 포함.
 *
 * @param {object} data
 * @param {string} data.reviewId            고유 ID (exam_${examId}_s${uuid}_q${number})
 * @param {string} data.examId
 * @param {string} data.examTitle
 * @param {string} data.examGrade
 * @param {string} data.studentUUID
 * @param {string} data.classCode
 * @param {number} data.questionNumber
 * @param {string} data.question            익명화된 문제 텍스트
 * @param {string|null} data.bogi
 * @param {string[]|null} data.choices
 * @param {string|null} data.solutionProcess
 * @param {string} data.answer
 * @param {Record<string,string>} data.nameMap  { '철수': '학생1', ... }
 * @param {string} data.status              'pending_review' | 'peer_review'
 * @param {boolean} [data.aiApproved]       AI 승인 여부 (false 이면 AI 미승인·교사 확인)
 * @param {Record<string,boolean>|null} [data.aiChecks]
 * @param {string} data.aiNote
 * @param {string} data.aiMode
 */
/**
 * @param {object} data
 * @param {{ isUpdate?: boolean }} [opts] — true면 기존 검수 문서 갱신(createdAt 미설정)
 */
export async function saveVariantReview(data, opts = {}) {
  const { reviewId, ...rest } = data;
  const isUpdate = !!opts.isUpdate;

  // ★ classCode는 문자열 완전일치(where ==)로 조회되므로 저장 시점에 정규화한다.
  // (배포/로컬 환경에서 대소문자·공백이 달라지면 교사 검수 목록에 안 뜰 수 있음)
  const classCodeNorm = normalizeClassCode(rest.classCode);

  // legacy 호환: 구버전에서 status=pending 으로 저장된 케이스가 있어
  // 최신 파이프라인의 pending_review 로 정규화한다.
  const normalizedStatus = rest.status === SUBMISSION_STATUS_PENDING
    ? SUBMISSION_STATUS_PENDING_REVIEW
    : rest.status;

  const peerFields = normalizedStatus === 'peer_review'
    ? {
        peerApprovals: [],            // Array<{ studentUUID, approvedAt }>
        peerApprovalRequired: PEER_APPROVAL_REQUIRED,
        // TODO: 승인자 선정 방식 미정 (랜덤? 자원? 추후 결정)
        // TODO: peerReviewers 필드에 선정된 학생 UUID 목록 추가 예정
      }
    : {};

  let body = rest;
  if (
    isUpdate
    && (normalizedStatus === SUBMISSION_STATUS_REGISTERED || normalizedStatus === SUBMISSION_STATUS_APPROVED)
  ) {
    body = {};
    for (const key of VARIANT_REVIEW_IDENTITY_FIELDS) {
      if (key in rest) body[key] = rest[key];
    }
    for (const key of REGISTERED_VARIANT_REVIEW_UPDATE_FIELDS) {
      if (key in rest) body[key] = rest[key];
    }
    if (normalizedStatus === SUBMISSION_STATUS_REGISTERED) {
      body.resolvedAt = deleteField();
      body.teacherComment = rest.teacherComment ?? '';
      body.teacherReviewStatus = deleteField();
    }
  }
  body.status = normalizedStatus;

  const reviewRef = doc(db, 'variantReviews', reviewId);
  const payload = {
    ...body,
    classCode: classCodeNorm,
    ...peerFields,
    updatedAt: serverTimestamp(),
  };
  // 학생은 variantReviews 읽기 권한이 없어 getDoc으로 존재 여부를 확인할 수 없음.
  if (!isUpdate) {
    payload.createdAt = serverTimestamp();
  }

  await setDoc(reviewRef, payload, { merge: true });
}

/**
 * legacy 정리: variantReviews.status == 'pending' → 'pending_review'
 * (구배포본에서 생성된 레거시 문서가 교사 검수함 쿼리에서 누락되는 문제 방지)
 *
 * @param {string} classCode
 * @param {{ maxItems?: number }} [opts]
 * @returns {Promise<{ scanned: number, updated: number, errors: number }>}
 */
export async function migrateLegacyPendingVariantReviews(classCode, opts = {}) {
  const norm = normalizeClassCode(classCode);
  if (!norm) return { scanned: 0, updated: 0, errors: 0 };
  const maxItems = Number.isFinite(opts?.maxItems) ? Math.max(1, opts.maxItems) : 500;

  const q = query(
    collection(db, 'variantReviews'),
    where('classCode', '==', norm),
    where('status', '==', SUBMISSION_STATUS_PENDING),
    limit(maxItems),
  );
  const snap = await getDocs(q);
  if (snap.empty) return { scanned: 0, updated: 0, errors: 0 };

  let scanned = 0;
  let updated = 0;
  let errors = 0;

  const docs = snap.docs;
  const BATCH = 400;
  for (let i = 0; i < docs.length; i += BATCH) {
    const slice = docs.slice(i, i + BATCH);
    const batch = writeBatch(db);
    slice.forEach((d) => {
      scanned += 1;
      batch.update(d.ref, { status: SUBMISSION_STATUS_PENDING_REVIEW, updatedAt: serverTimestamp() });
      updated += 1;
    });
    try {
      // eslint-disable-next-line no-await-in-loop
      await batch.commit();
    } catch (e) {
      console.warn('[migrateLegacyPendingVariantReviews] batch commit', e?.code, e?.message);
      errors += slice.length;
    }
  }

  return { scanned, updated, errors };
}

/**
 * [SKELETON] 동료 학생이 peer_review 문제를 승인
 *
 * 승인자가 peerApprovalRequired 수에 도달하면 status를 'approved'로 바꾸고
 * students/{uuid}/problemBank 문서도 자동 등록해야 한다.
 *
 * @param {string} reviewId    variantReviews 문서 ID
 * @param {string} approverUUID  승인하는 학생의 UUID
 * @returns {Promise<{ done: boolean, count: number, required: number }>}
 *   done: true 이면 승인 완료 (2/2), problemBank 등록 트리거 실행됨
 *
 * TODO: 구현 필요 항목
 *   1. 자기 자신(studentUUID)은 승인 불가 검증
 *   2. 같은 학급 학생만 승인 가능 검증
 *   3. 중복 승인 방지 (이미 peerApprovals에 있으면 거부)
 *   4. 2명 승인 완료 시:
 *      - variantReviews.status → 'approved'
 *      - students/{uuid}/problemBank/{bankDocId} 생성/업데이트 (status: 'approved')
 *   5. 승인 요청 알림 방식 미정 (push? 인앱 알림?)
 */
export async function submitPeerApproval(reviewId, approverUUID) {
  const reviewRef = doc(db, 'variantReviews', reviewId);
  const snap = await getDoc(reviewRef);
  if (!snap.exists()) {
    return { done: false, count: 0, required: PEER_APPROVAL_REQUIRED, reason: 'not_found' };
  }

  const data = snap.data();
  const studentUUID = data.studentUUID;
  const required = data.peerApprovalRequired ?? PEER_APPROVAL_REQUIRED;

  if (data.status !== SUBMISSION_STATUS_PEER_REVIEW) {
    return { done: false, count: 0, required, reason: 'not_peer_review' };
  }
  if (studentUUID === approverUUID) {
    return { done: false, count: 0, required, reason: 'self' };
  }

  const strategyId = String(data.variantStrategyId || '').trim();
  const unitKey = resolveUnitKeyFromSource(data);
  const mayApprove = await canStudentPeerApproveStrategy(approverUUID, strategyId, unitKey);
  if (!mayApprove) {
    return { done: false, count: 0, required, reason: 'not_peer_judge' };
  }

  const approvals = Array.isArray(data.peerApprovals) ? [...data.peerApprovals] : [];
  if (approvals.some((a) => a.studentUUID === approverUUID)) {
    return { done: false, count: approvals.length, required, reason: 'duplicate' };
  }

  approvals.push({ studentUUID: approverUUID, approvedAt: new Date().toISOString() });
  const done = approvals.length >= required;

  const batch = writeBatch(db);
  batch.update(reviewRef, {
    peerApprovals: approvals,
    ...(done
      ? { status: SUBMISSION_STATUS_APPROVED, resolvedAt: serverTimestamp() }
      : {}),
  });

  const bankRef = await resolveExistingStudentBankRef(studentUUID, reviewId, data);
  if (bankRef) {
    batch.update(bankRef, {
      status: done ? SUBMISSION_STATUS_APPROVED : SUBMISSION_STATUS_PEER_REVIEW,
    });
  }

  await batch.commit();

  if (done) {
    await syncMakingCompetencyFromVariantReview(
      { id: reviewId, ...data, status: SUBMISSION_STATUS_PEER_REVIEW },
      SUBMISSION_STATUS_APPROVED
    );
    const reviewWithUnit = {
      ...data,
      unitKey: unitKey || resolveUnitKeyFromSource(data),
    };
    await recordFinalApprovalUnitProgress(studentUUID, reviewWithUnit)
      .catch((e) => console.warn('[submitPeerApproval] unit approval', e));
    await awardMakingExplorationFromVariantReview(
      { id: reviewId, ...reviewWithUnit },
      new Date(),
    ).catch((e) => console.warn('[submitPeerApproval] exploration award', e));
  }

  return { done, count: approvals.length, required };
}

/**
 * 교사 학급의 변형 문제 검수 목록 조회
 * @param {string} classCode
 * @param {string[]} statuses  조회할 상태 목록 (예: ['pending_review', 'peer_review'])
 * @returns {Promise<Array<{ id: string } & object>>}
 */
export async function getVariantReviewsByClass(classCode, statuses) {
  if (!classCode) return [];
  const norm = normalizeClassCode(classCode);
  const lower = norm.toLowerCase();
  const codes = norm === lower ? [norm] : [norm, lower];

  async function fetchByCode(cc) {
    const q = query(
      collection(db, 'variantReviews'),
      where('classCode', '==', cc),
      where('status', 'in', statuses),
      orderBy('createdAt', 'desc'),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  const byId = new Map();
  const results = await Promise.all(
    codes.map((cc) =>
      fetchByCode(cc).catch((e) => {
        // 에러를 삼키지 않고 콘솔에 남겨서 디버깅 가능하게
        console.warn('[getVariantReviewsByClass] query failed', { cc, code: e?.code, msg: e?.message });
        return [];
      })
    )
  );
  results.flat().forEach((row) => byId.set(row.id, row));

  const rows = Array.from(byId.values());
  rows.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() || 0;
    const tb = b.createdAt?.toMillis?.() || 0;
    return ta - tb;
  });
  return rows;
}

/**
 * reviewId 목록으로 variantReviews 문서를 직접 조회합니다.
 * 검수함 status 필터와 무관하게 학급 문제은행 AI 피드백 연결용.
 *
 * @param {string[]} reviewIds
 * @returns {Promise<Array<{ id: string, ... }>>}
 */
export async function getVariantReviewsByIds(reviewIds) {
  const uniq = [...new Set(
    (reviewIds || []).map((id) => String(id || '').trim()).filter(Boolean),
  )];
  if (uniq.length === 0) return [];

  const rows = [];
  for (const reviewId of uniq) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const snap = await getDoc(doc(db, 'variantReviews', reviewId));
      if (snap.exists()) {
        rows.push({ id: snap.id, ...snap.data() });
      }
    } catch (e) {
      if (e?.code !== 'permission-denied') {
        console.warn('[getVariantReviewsByIds]', reviewId, e?.code);
      }
    }
  }
  return rows;
}

/**
 * classProblemId 로 variantReviews 를 조회합니다 (reviewId 누락 시 학급 문제은행 연결용).
 * @param {string[]} classProblemIds
 * @returns {Promise<Array<{ id: string, ... }>>}
 */
export async function getVariantReviewsByClassProblemIds(classProblemIds) {
  const uniq = [...new Set(
    (classProblemIds || []).map((id) => String(id || '').trim()).filter(Boolean),
  )];
  if (uniq.length === 0) return [];

  const byId = new Map();
  const BATCH = 30;
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    try {
      // eslint-disable-next-line no-await-in-loop
      const snap = await getDocs(query(
        collection(db, 'variantReviews'),
        where('classProblemId', 'in', batch),
      ));
      snap.docs.forEach((d) => {
        if (!byId.has(d.id)) {
          byId.set(d.id, { id: d.id, ...d.data() });
        }
      });
    } catch (e) {
      console.warn('[getVariantReviewsByClassProblemIds]', e?.code, e?.message);
    }
  }
  return Array.from(byId.values());
}

function dedupeVariantReviewRows(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    if (row?.id) byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

/**
 * 학급 문제은행 AI 피드백 연결용 — 검수함과 동일한 variantReviews 를 모읍니다.
 * @param {string} classCode
 * @param {Array<object>} problems getClassProblems 결과
 * @param {string[]} [openStatuses]
 */
export async function loadVariantReviewsForClassProblemBank(
  classCode,
  problems,
  openStatuses,
) {
  const reviewIds = [...new Set(
    (problems || []).flatMap((p) => inferClassProblemReviewIds(p)),
  )];
  const problemIds = (problems || []).map((p) => p.id).filter(Boolean);

  const tasks = [
    getVariantReviewsByIds(reviewIds),
    getVariantReviewsByClassProblemIds(problemIds),
  ];
  if (classCode && Array.isArray(openStatuses) && openStatuses.length > 0) {
    tasks.push(getVariantReviewsByClass(classCode, openStatuses));
  }

  const chunks = await Promise.all(tasks);
  let merged = dedupeVariantReviewRows(chunks.flat());
  merged = await enrichVariantReviewsFromStudentBank(problems, merged);
  return merged;
}

/**
 * 학급 problemBank ↔ students problemBank ↔ variantReviews 연결 (vr_* reviewId 보정)
 * @param {Array<object>} problems
 * @param {Array<object>} rowsSoFar
 */
async function enrichVariantReviewsFromStudentBank(problems, rowsSoFar) {
  const byId = new Map((rowsSoFar || []).map((r) => [r.id, r]));

  for (const problem of problems || []) {
    const cpid = String(problem.id || problem.problemId || '').trim();
    const uuid = String(problem.createdBy || '').trim();
    if (!cpid || !uuid) continue;

    const alreadyHasGood = [...byId.values()].some((vr) => {
      const note = String(vr.aiNote || '').trim();
      if (!note || note.includes('AI 검토 시스템이 일시적으로 사용 불가')) return false;
      const vrCpid = String(vr.classProblemId || '').trim();
      if (vrCpid && vrCpid === cpid) return true;
      for (const rid of inferClassProblemReviewIds(problem)) {
        if (vr.id === rid) return true;
      }
      const label = String(problem.label || '').trim();
      return !!(
        label
        && String(vr.classProblemLabel || '').trim() === label
        && String(vr.studentUUID || '') === uuid
      );
    });
    if (alreadyHasGood) continue;

    try {
      // eslint-disable-next-line no-await-in-loop
      let bankSnap = await getDocs(query(
        collection(db, 'students', uuid, 'problemBank'),
        where('classProblemId', '==', cpid),
        limit(1),
      ));
      if (bankSnap.empty && problem.label) {
        // eslint-disable-next-line no-await-in-loop
        bankSnap = await getDocs(query(
          collection(db, 'students', uuid, 'problemBank'),
          where('classProblemLabel', '==', String(problem.label).trim()),
          limit(1),
        ));
      }
      if (bankSnap.empty) continue;

      const bankDoc = bankSnap.docs[0];
      const bankRow = bankDoc.data() || {};
      const bankDocId = bankDoc.id;
      const reviewIdCandidates = [...new Set([
        String(problem.reviewId || '').trim(),
        String(bankRow.reviewId || '').trim(),
        buildVariantReviewId(uuid, bankDocId),
        bankRow.examId && bankRow.sourceNumber != null
          ? `exam_${String(bankRow.examId).trim()}_s${uuid}_q${Number(bankRow.sourceNumber)}`
          : '',
        legacyBankDocIdFromReviewId(String(bankRow.reviewId || ''), uuid)
          ? buildVariantReviewId(uuid, legacyBankDocIdFromReviewId(String(bankRow.reviewId || ''), uuid))
          : '',
      ].filter(Boolean))];

      for (const rid of reviewIdCandidates) {
        if (byId.has(rid)) continue;
        // eslint-disable-next-line no-await-in-loop
        const vrSnap = await getDoc(doc(db, 'variantReviews', rid));
        if (vrSnap.exists()) {
          byId.set(rid, { id: rid, ...vrSnap.data() });
        }
      }
    } catch (e) {
      console.warn('[enrichVariantReviewsFromStudentBank]', cpid, e?.code, e?.message);
    }
  }

  return Array.from(byId.values());
}

/**
 * variantReviews 문서 존재 여부 (없는 문서는 규칙상 permission-denied 로 보일 수 있음)
 * @param {string} reviewId
 * @returns {Promise<boolean>}
 */
export async function variantReviewDocExists(reviewId) {
  const id = String(reviewId || '').trim();
  if (!id) return false;
  try {
    const snap = await getDoc(doc(db, 'variantReviews', id));
    return snap.exists();
  } catch (e) {
    if (e?.code === 'permission-denied') return false;
    throw e;
  }
}

/**
 * reviewId·학급 problemBank 행에서 students problemBank bankDocId 추론
 * @param {string} studentUUID
 * @param {string} reviewId
 * @param {object} [problemRow]
 * @returns {Promise<string|null>}
 */
async function resolveBankDocIdForClassProblem(studentUUID, reviewId, problemRow = {}) {
  const su = String(studentUUID || '').trim();
  const rid = String(reviewId || '').trim();
  if (!su || !rid) return null;

  const classProblemId = String(problemRow.problemId || '').trim();
  if (classProblemId) {
    try {
      const snap = await getDocs(query(
        collection(db, 'students', su, 'problemBank'),
        where('classProblemId', '==', classProblemId),
        limit(1),
      ));
      if (!snap.empty) return snap.docs[0].id;
    } catch {
      /* ignore */
    }
  }

  const vrPrefix = `vr_${su.slice(0, 8)}_`;
  if (rid.startsWith(vrPrefix)) return rid.slice(vrPrefix.length);

  return legacyBankDocIdFromReviewId(rid, su);
}

/**
 * AI 재검수·백필 시 풀이 과정을 variantReviews → students problemBank 순으로 조회합니다.
 * variantReviews 에 저장된 값은 이미 익명화된 텍스트입니다.
 *
 * @param {string} studentUUID
 * @param {string} reviewId
 * @param {string} [classProblemId]
 * @returns {Promise<{ text: string, source: 'variantReview'|'studentBank'|'' }>}
 */
export async function resolveVariantSolutionProcess(studentUUID, reviewId, classProblemId = '') {
  const su = String(studentUUID || '').trim();
  const rid = String(reviewId || '').trim();
  if (!su || !rid) return { text: '', source: '' };

  try {
    const vr = await getDoc(doc(db, 'variantReviews', rid));
    if (vr.exists()) {
      const data = vr.data() || {};
      const sp = String(data.solutionProcess || data.variantSolutionProcess || '').trim();
      if (sp) return { text: sp, source: 'variantReview' };
    }
  } catch {
    /* ignore */
  }

  try {
    const bankDocId = await resolveBankDocIdForClassProblem(su, rid, { problemId: classProblemId });
    if (bankDocId) {
      const snap = await getDoc(doc(db, 'students', su, 'problemBank', bankDocId));
      const sp = String(snap.data()?.solutionProcess || '').trim();
      if (sp) return { text: sp, source: 'studentBank' };
    }
  } catch {
    /* ignore */
  }

  return { text: '', source: '' };
}

/**
 * 학급 problemBank 에는 있는데 variantReviews 가 없는 검수 문서를 생성합니다.
 * (syncStudentProblemsToClassBank 등으로 problemBank 만 등록된 경우 교사 검수 탭에 안 뜸)
 *
 * @param {string} classCode
 * @param {{ maxItems?: number }} [opts]
 * @returns {Promise<{ scanned: number, created: number, skipped: number, errors: number }>}
 */
export async function backfillMissingVariantReviewsForClass(classCode, opts = {}) {
  const norm = normalizeClassCode(classCode);
  if (!norm) throw new Error('classCode가 필요합니다.');

  const maxItems = Number.isFinite(opts.maxItems) ? Math.max(1, opts.maxItems) : 500;
  const snap = await getDocs(query(
    collection(db, 'classes', norm, 'problemBank'),
    limit(maxItems),
  ));

  let scanned = 0;
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const d of snap.docs) {
    scanned += 1;
    const row = d.data() || {};
    const reviewId = String(row.reviewId || '').trim();
    const studentUUID = String(row.createdBy || '').trim();
    if (!reviewId || !studentUUID) {
      skipped += 1;
      continue;
    }
    if (row.status === SUBMISSION_STATUS_REJECTED) {
      skipped += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const exists = await variantReviewDocExists(reviewId);
      if (exists) {
        skipped += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const classProblemId = row.problemId || d.id;
      const bankDocId = await resolveBankDocIdForClassProblem(studentUUID, reviewId, {
        ...row,
        problemId: classProblemId,
      });

      const { text: solutionText } = await resolveVariantSolutionProcess(
        studentUUID,
        reviewId,
        classProblemId,
      );

      const openStatus = VARIANT_REVIEW_OPEN_STATUSES.includes(row.status)
        ? row.status
        : SUBMISSION_STATUS_REGISTERED;

      // eslint-disable-next-line no-await-in-loop
      await saveVariantReview({
        reviewId,
        bankDocId: bankDocId || null,
        examId: row.examId || null,
        examTitle: row.examTitle || '',
        examGrade: row.examGrade || '',
        studentUUID,
        classCode: norm,
        questionNumber: row.sourceNumber ?? null,
        question: String(row.variantQuestion || '').trim(),
        bogi: row.variantBogi || null,
        choices: Array.isArray(row.variantChoices) && row.variantChoices.length
          ? row.variantChoices
          : null,
        solutionProcess: solutionText || null,
        answer: String(row.variantAnswer || '').trim(),
        nameMap: {},
        status: openStatus,
        aiNote: row.aiNote || '',
        aiMode: row.aiMode || (String(bankDocId || '').startsWith('new_') ? 'new_problem' : ''),
        aiApproved: row.aiApproved ?? null,
        aiChecks: row.aiChecks || null,
        aiReviewStatus: row.aiReviewStatus || 'pending',
        aiCompletionLevel: row.aiCompletionLevel ?? null,
        variantStrategyId: row.variantStrategyId || '',
        variantStrategyName: row.variantStrategyName || '',
        classProblemId: row.problemId || d.id,
        classProblemLabel: row.label || '',
        ...(String(bankDocId || '').startsWith('new_') || row.source === 'new_problem' || row.aiMode === 'new_problem'
          ? { kind: 'new', source: 'new_problem' }
          : {}),
        unitKey: row.unitKey || '',
        curriculumGrade: row.curriculumGrade || '',
        curriculumSemester: row.curriculumSemester || '',
        curriculumUnit: row.curriculumUnit || '',
        unitGoal: row.unitGoal || '',
      });
      created += 1;
    } catch (e) {
      console.warn('[backfillMissingVariantReviews]', reviewId, e?.code, e?.message);
      errors += 1;
    }
  }

  return { scanned, created, skipped, errors };
}

/**
 * @param {string} reviewId
 * @param {string} studentUUID
 * @param {object|null|undefined} reviewData
 */
function resolveBankDocIdFromReview(reviewId, studentUUID, reviewData) {
  const fromData = String(reviewData?.bankDocId || '').trim();
  if (fromData) return fromData;

  const su = String(studentUUID || '').trim();
  const rid = String(reviewId || '').trim();
  if (su && rid) {
    const vrPrefix = `vr_${su.slice(0, 8)}_`;
    if (rid.startsWith(vrPrefix)) return rid.slice(vrPrefix.length);
  }

  return legacyBankDocIdFromReviewId(reviewId, studentUUID);
}

const STUDENT_BANK_BACKFILL_STATUSES = new Set([
  SUBMISSION_STATUS_REGISTERED,
  SUBMISSION_STATUS_APPROVED,
  SUBMISSION_STATUS_REJECTED,
  SUBMISSION_STATUS_PENDING_REVIEW,
  SUBMISSION_STATUS_PEER_REVIEW,
]);

/**
 * variantReviews / 학급 problemBank 행 → students problemBank 문서 필드
 * @param {object} review
 * @param {string} bankDocId
 */
function buildStudentProblemBankDocFromVariantReview(review, bankDocId) {
  const reviewStatus = String(review?.status || '').trim();
  const teacherReviewStatus = review?.teacherReviewStatus
    || (reviewStatus === SUBMISSION_STATUS_REJECTED
      || reviewStatus === SUBMISSION_STATUS_APPROVED
      || reviewStatus === SUBMISSION_STATUS_APPROVED_PARTIAL
      ? reviewStatus
      : null);
  const status = reviewStatus === SUBMISSION_STATUS_APPROVED
    ? SUBMISSION_STATUS_APPROVED
    : SUBMISSION_STATUS_REGISTERED;

  return {
    examId: review.examId || null,
    examTitle: review.examTitle || '',
    examGrade: review.examGrade || '',
    sourceNumber: review.questionNumber ?? review.sourceNumber ?? null,
    bankDocId,
    reviewId: review.id || review.reviewId || null,
    question: String(review.question || '').trim(),
    bogi: review.bogi || null,
    choices: Array.isArray(review.choices) && review.choices.length ? review.choices : null,
    solutionProcess: review.solutionProcess || null,
    answer: String(review.answer || '').trim(),
    requiresSolution: !!review.solutionProcess,
    savedAt: review.savedAt
      || (review.createdAt?.toDate?.() ? review.createdAt.toDate().toISOString() : null)
      || new Date().toISOString(),
    status,
    teacherReviewStatus: teacherReviewStatus || null,
    teacherComment: review.teacherComment || '',
    classProblemId: review.classProblemId || null,
    classProblemLabel: review.classProblemLabel || null,
    variantStrategyId: review.variantStrategyId || '',
    variantStrategyName: review.variantStrategyName || '',
    aiNote: review.aiNote || '',
    aiMode: review.aiMode || '',
    aiApproved: review.aiApproved ?? null,
    aiChecks: review.aiChecks || null,
    aiReviewStatus: review.aiReviewStatus || (review.aiNote ? 'done' : 'pending'),
    aiCompletionLevel: review.aiCompletionLevel || null,
  };
}

/** @param {object} classRow @param {string} classProblemId @param {string} [reviewId] */
function buildStudentProblemBankDocFromClassProblem(classRow, classProblemId, reviewId = '') {
  const classStatus = String(classRow.status || '').trim();
  const teacherReviewStatus = classStatus === SUBMISSION_STATUS_REJECTED
    ? SUBMISSION_STATUS_REJECTED
    : null;

  return {
    examId: classRow.examId || null,
    examTitle: classRow.examTitle || '',
    examGrade: classRow.examGrade || '',
    sourceNumber: classRow.sourceNumber ?? null,
    reviewId: reviewId || classRow.reviewId || null,
    question: String(classRow.variantQuestion || '').trim(),
    bogi: classRow.variantBogi || null,
    choices: Array.isArray(classRow.variantChoices) && classRow.variantChoices.length
      ? classRow.variantChoices
      : null,
    solutionProcess: null,
    answer: String(classRow.variantAnswer || '').trim(),
    requiresSolution: !!classRow.requiresSolution,
    savedAt: classRow.registeredAt?.toDate?.()
      ? classRow.registeredAt.toDate().toISOString()
      : new Date().toISOString(),
    status: SUBMISSION_STATUS_REGISTERED,
    teacherReviewStatus,
    classProblemId,
    classProblemLabel: classRow.label || classRow.classProblemLabel || null,
    variantStrategyId: classRow.variantStrategyId || '',
    variantStrategyName: classRow.variantStrategyName || '',
    aiNote: classRow.aiNote || '',
    aiMode: classRow.aiMode || '',
    aiApproved: classRow.aiApproved ?? null,
    aiChecks: classRow.aiChecks || null,
    aiReviewStatus: classRow.aiReviewStatus || (classRow.aiNote ? 'done' : 'pending'),
    aiCompletionLevel: classRow.aiCompletionLevel || null,
  };
}

/**
 * variantReviews·학급 problemBank에만 있고 학생 problemBank가 없을 때 복구합니다.
 * @param {string} uuid
 * @param {Array<object>} [existing]
 * @returns {Promise<Array<object>>}
 */
async function backfillMissingStudentProblemBank(uuid, existing = []) {
  const su = String(uuid || '').trim();
  if (!su) return existing;

  const byId = new Map(existing.map((row) => [row.id, row]));
  const linkedClassIds = new Set(
    existing.map((row) => String(row.classProblemId || '').trim()).filter(Boolean),
  );
  const linkedReviewIds = new Set(
    existing.map((row) => resolveReviewIdForBankItem(row, su)).filter(Boolean),
  );

  const upsert = async (bankDocId, payload) => {
    const id = String(bankDocId || '').trim();
    if (!id || byId.has(id)) return;
    const body = { ...payload, bankDocId: id };
    await setDoc(doc(db, 'students', su, 'problemBank', id), body, { merge: true });
    byId.set(id, { id, ...body });
    const rid = resolveReviewIdForBankItem(body, su);
    if (rid) linkedReviewIds.add(rid);
    if (body.classProblemId) linkedClassIds.add(String(body.classProblemId));
  };

  try {
    const vrSnap = await getDocs(query(
      collection(db, 'variantReviews'),
      where('studentUUID', '==', su),
      limit(120),
    ));
    for (const d of vrSnap.docs) {
      const review = { id: d.id, ...d.data() };
      if (!STUDENT_BANK_BACKFILL_STATUSES.has(review.status)) continue;
      if (!String(review.question || '').trim() && !review.examId) continue;

      const bankDocId = resolveBankDocIdFromReview(review.id, su, review);
      if (!bankDocId) continue;
      if (byId.has(bankDocId) || linkedReviewIds.has(review.id)) continue;

      await upsert(bankDocId, buildStudentProblemBankDocFromVariantReview(review, bankDocId));
    }
  } catch (e) {
    console.warn('[backfillMissingStudentProblemBank] variantReviews', e?.code, e?.message);
  }

  try {
    const studentSnap = await getDoc(doc(db, 'students', su));
    const classCode = normalizeClassCode(studentSnap.data()?.classCode);
    if (!classCode) {
      return [...byId.values()].sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    }

    const cpSnap = await getDocs(query(
      collection(db, 'classes', classCode, 'problemBank'),
      where('createdBy', '==', su),
      limit(120),
    ));
    for (const d of cpSnap.docs) {
      const classRow = { id: d.id, ...d.data() };
      if (linkedClassIds.has(d.id)) continue;

      const reviewId = String(classRow.reviewId || '').trim();
      let bankDocId = reviewId
        ? await resolveBankDocIdForClassProblem(su, reviewId, { problemId: d.id, ...classRow })
        : null;
      if (!bankDocId && classRow.examId && classRow.sourceNumber != null) {
        bankDocId = `exam_${String(classRow.examId).trim()}_q${Number(classRow.sourceNumber)}`;
      }
      if (!bankDocId) bankDocId = `cp_${d.id}`;
      if (byId.has(bankDocId)) continue;

      let payload = buildStudentProblemBankDocFromClassProblem(classRow, d.id, reviewId);
      if (reviewId) {
        try {
          const vrSnap = await getDoc(doc(db, 'variantReviews', reviewId));
          if (vrSnap.exists()) {
            const merged = buildStudentProblemBankDocFromVariantReview(
              { id: reviewId, ...vrSnap.data() },
              bankDocId,
            );
            payload = {
              ...payload,
              ...merged,
              question: payload.question || merged.question,
              bogi: payload.bogi ?? merged.bogi,
              choices: payload.choices ?? merged.choices,
              solutionProcess: merged.solutionProcess || payload.solutionProcess,
            };
          }
        } catch {
          /* ignore */
        }
      }

      await upsert(bankDocId, payload);
    }
  } catch (e) {
    console.warn('[backfillMissingStudentProblemBank] class problemBank', e?.code, e?.message);
  }

  return [...byId.values()].sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

/**
 * 검수 결과를 학생 problemBank에 반영합니다. 문서가 없으면 variantReviews에서 생성합니다.
 * @param {string} studentUUID
 * @param {string} reviewId
 * @param {object|null|undefined} reviewData
 * @param {object} patch
 */
async function ensureStudentProblemBankFromVariantReview(studentUUID, reviewId, reviewData, patch) {
  const su = String(studentUUID || '').trim();
  if (!su || !reviewData) return null;

  let bankRef = await resolveExistingStudentBankRef(su, reviewId, reviewData);
  if (!bankRef) {
    const bankDocId = resolveBankDocIdFromReview(reviewId, su, reviewData);
    if (!bankDocId) return null;
    const base = buildStudentProblemBankDocFromVariantReview({ id: reviewId, ...reviewData }, bankDocId);
    bankRef = doc(db, 'students', su, 'problemBank', bankDocId);
    await setDoc(bankRef, { ...base, ...patch }, { merge: true });
    return bankRef;
  }

  await updateDoc(bankRef, patch);
  return bankRef;
}

/**
 * 학생 problemBank 문서 ref — 실제 존재하는 문서만 반환 (없으면 null)
 * @param {string} studentUUID
 * @param {string} reviewId
 * @param {object|null|undefined} reviewData
 */
async function resolveExistingStudentBankRef(studentUUID, reviewId, reviewData) {
  const su = String(studentUUID || '').trim();
  if (!su) return null;

  const candidates = [];
  const primary = resolveBankDocIdFromReview(reviewId, su, reviewData);
  if (primary) candidates.push(primary);

  const classProblemId = String(reviewData?.classProblemId || '').trim();
  if (classProblemId) {
    try {
      const alt = await resolveBankDocIdForClassProblem(su, reviewId, {
        problemId: classProblemId,
        ...reviewData,
      });
      if (alt && !candidates.includes(alt)) candidates.push(alt);
    } catch {
      /* ignore */
    }
  }

  for (const bankDocId of candidates) {
    const ref = doc(db, 'students', su, 'problemBank', bankDocId);
    try {
      const snap = await getDoc(ref);
      if (snap.exists()) return ref;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 변형 문제 검수 결과 반영 (승인 또는 반려)
 * variantReviews + students/{uuid}/problemBank 양쪽을 업데이트
 *
 * @param {string} reviewId
 * @param {string} studentUUID
 * @param {'approved'|'approved_partial'|'rejected'} newStatus
 * @param {string} [teacherComment]
 * @param {{ aiNote?: string, aiChecks?: Record<string, boolean>, aiApproved?: boolean|null }} [aiPatch]
 */
export async function resolveVariantReview(reviewId, studentUUID, newStatus, teacherComment, aiPatch = null) {
  const reviewSnap = await getDoc(doc(db, 'variantReviews', reviewId));
  const reviewBefore = reviewSnap.exists()
    ? { id: reviewId, ...reviewSnap.data() }
    : null;

  const reviewUpdate = {
    status: newStatus,
    teacherReviewStatus: newStatus,
    resolvedAt: serverTimestamp(),
    teacherComment: aiPatch ? '' : (teacherComment || ''),
  };
  if (aiPatch) {
    if (aiPatch.aiNote != null) reviewUpdate.aiNote = aiPatch.aiNote;
    if (aiPatch.aiChecks != null) reviewUpdate.aiChecks = aiPatch.aiChecks;
    if (aiPatch.aiApproved != null) reviewUpdate.aiApproved = aiPatch.aiApproved;
  }

  await updateDoc(doc(db, 'variantReviews', reviewId), reviewUpdate);

  const bankPatch = {
    teacherReviewStatus: newStatus,
    teacherComment: aiPatch ? '' : (teacherComment || ''),
    resolvedAt: new Date().toISOString(),
  };
  if (newStatus === SUBMISSION_STATUS_APPROVED) {
    bankPatch.status = SUBMISSION_STATUS_APPROVED;
  }
  if (reviewBefore) {
    if (reviewBefore.aiReviewStatus) bankPatch.aiReviewStatus = reviewBefore.aiReviewStatus;
    if (aiPatch?.aiNote != null) bankPatch.aiNote = aiPatch.aiNote;
    else if (reviewBefore.aiNote != null) bankPatch.aiNote = reviewBefore.aiNote;
    if (aiPatch?.aiApproved != null) bankPatch.aiApproved = aiPatch.aiApproved;
    else if (reviewBefore.aiApproved != null) bankPatch.aiApproved = reviewBefore.aiApproved;
    if (aiPatch?.aiChecks != null) bankPatch.aiChecks = aiPatch.aiChecks;
    else if (reviewBefore.aiChecks != null) bankPatch.aiChecks = reviewBefore.aiChecks;
    if (reviewBefore.aiMode) bankPatch.aiMode = reviewBefore.aiMode;
    if (reviewBefore.aiCompletionLevel) bankPatch.aiCompletionLevel = reviewBefore.aiCompletionLevel;
  } else if (aiPatch) {
    if (aiPatch.aiNote != null) bankPatch.aiNote = aiPatch.aiNote;
    if (aiPatch.aiApproved != null) bankPatch.aiApproved = aiPatch.aiApproved;
    if (aiPatch.aiChecks != null) bankPatch.aiChecks = aiPatch.aiChecks;
  }

  if (reviewBefore) {
    try {
      await ensureStudentProblemBankFromVariantReview(
        studentUUID,
        reviewId,
        reviewBefore,
        bankPatch,
      );
    } catch (e) {
      console.warn('[resolveVariantReview] problemBank sync skipped', e?.code, e?.message);
    }
  }

  if (reviewBefore) {
    const classCode = normalizeClassCode(reviewBefore.classCode);
    const classProblemId = String(reviewBefore.classProblemId || '').trim();
    if (classCode && classProblemId) {
      try {
        const classRef = doc(db, 'classes', classCode, 'problemBank', classProblemId);
        const classSnap = await getDoc(classRef);
        if (classSnap.exists()) {
          const visibilityStatus = newStatus === SUBMISSION_STATUS_REJECTED
            ? SUBMISSION_STATUS_REJECTED
            : SUBMISSION_STATUS_REGISTERED;
          const classPatch = {
            status: visibilityStatus,
            updatedAt: serverTimestamp(),
          };
          if (newStatus === SUBMISSION_STATUS_APPROVED
            || newStatus === SUBMISSION_STATUS_APPROVED_PARTIAL
            || newStatus === SUBMISSION_STATUS_REJECTED) {
            classPatch.teacherReviewStatus = newStatus;
            classPatch.teacherResolvedAt = serverTimestamp();
          }
          await updateDoc(classRef, classPatch);
        }
      } catch (e) {
        console.warn('[resolveVariantReview] class problemBank sync skipped', e?.code, e?.message);
      }
    }
  }

  if (reviewBefore) {
    try {
      const feedbackNote = aiPatch?.aiNote != null
        ? String(aiPatch.aiNote).trim()
        : (teacherComment || '');
      await syncMakingCompetencyFromVariantReview(reviewBefore, newStatus, feedbackNote);
    } catch (e) {
      console.warn('[resolveVariantReview] competency sync skipped', e?.code, e?.message);
    }
    if (newStatus === SUBMISSION_STATUS_APPROVED) {
      const reviewWithUnit = {
        ...reviewBefore,
        unitKey: resolveUnitKeyFromSource(reviewBefore),
      };
      await recordFinalApprovalUnitProgress(studentUUID, reviewWithUnit)
        .catch((e) => console.warn('[resolveVariantReview] unit approval', e));
      await awardMakingExplorationFromVariantReview(
        { id: reviewId, ...reviewWithUnit },
        new Date(),
      ).catch((e) => console.warn('[resolveVariantReview] exploration award', e));
    } else if (newStatus === SUBMISSION_STATUS_APPROVED_PARTIAL) {
      const reviewWithUnit = {
        ...reviewBefore,
        unitKey: resolveUnitKeyFromSource(reviewBefore),
      };
      await awardMakingExplorationFromVariantReview(
        { id: reviewId, ...reviewWithUnit },
        new Date(),
        { partial: true },
      ).catch((e) => console.warn('[resolveVariantReview] partial exploration award', e));
    }
  }
}

// ─────────────────────────────────────────────
// 오답노트 검수 (wrongNoteReviews 컬렉션)
// ─────────────────────────────────────────────

/** @returns {string} wrongNoteReviews 문서 ID */
export function wrongNoteReviewId(examResultId, studentUUID, questionNumber) {
  return `wn_${examResultId}_s${studentUUID}_q${questionNumber}`;
}

/**
 * 학생 오답노트를 wrongNoteReviews에 저장 (교사 검수 대기)
 * @param {object} data
 */
export async function saveWrongNoteReview(data) {
  const { reviewId, ...rest } = data;
  const aiNote = String(rest.aiNote || '').trim();
  await setDoc(doc(db, 'wrongNoteReviews', reviewId), {
    ...rest,
    aiReviewStatus: rest.aiReviewStatus || (aiNote ? 'done' : 'pending'),
    createdAt: serverTimestamp(),
    teacherComment: rest.teacherComment ?? '',
    resolvedAt: deleteField(),
  }, { merge: true });
}

/**
 * @param {string} classCode
 * @param {string[]} statuses
 */
export async function getWrongNoteReviewsByClass(classCode, statuses) {
  if (!classCode || !statuses?.length) return [];
  const q = query(
    collection(db, 'wrongNoteReviews'),
    where('classCode', '==', classCode),
    where('status', 'in', statuses),
    orderBy('createdAt', 'desc'),
  );
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  rows.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() || 0;
    const tb = b.createdAt?.toMillis?.() || 0;
    return ta - tb;
  });
  return rows;
}

/**
 * 오답노트 검수 결과 반영 — wrongNoteReviews + examWrongNotes.noteDetails
 *
 * @param {string} reviewId
 * @param {string} studentUUID
 * @param {string} examResultId
 * @param {number|string} questionNumber
 * @param {'approved'|'rejected'} newStatus
 * @param {string} [teacherComment]
 * @param {{ aiNote?: string, aiChecks?: Record<string, boolean>, aiApproved?: boolean|null }} [aiPatch]
 */
export async function resolveWrongNoteReview(
  reviewId,
  studentUUID,
  examResultId,
  questionNumber,
  newStatus,
  teacherComment = '',
  aiPatch = null,
) {
  const qKey = String(questionNumber);
  const noteRef = doc(db, 'students', studentUUID, 'examWrongNotes', examResultId);
  const reviewRef = doc(db, 'wrongNoteReviews', reviewId);
  const [noteSnap, reviewSnap] = await Promise.all([getDoc(noteRef), getDoc(reviewRef)]);
  const unitKey = resolveUnitKeyFromSource(reviewSnap.exists() ? reviewSnap.data() : null);
  const noteDetails = noteSnap.exists() && noteSnap.data().noteDetails
    ? { ...noteSnap.data().noteDetails }
    : {};

  const feedbackText = aiPatch?.aiNote != null
    ? String(aiPatch.aiNote).trim()
    : (teacherComment || '');

  if (noteDetails[qKey]) {
    noteDetails[qKey] = {
      ...noteDetails[qKey],
      teacherStatus: newStatus,
      teacherComment: feedbackText,
      teacherResolvedAt: new Date().toISOString(),
    };
  }

  const batch = writeBatch(db);
  const reviewUpdate = {
    status: newStatus,
    resolvedAt: serverTimestamp(),
    teacherComment: aiPatch ? '' : (teacherComment || ''),
  };
  if (aiPatch) {
    if (aiPatch.aiNote != null) reviewUpdate.aiNote = aiPatch.aiNote;
    if (aiPatch.aiChecks != null) reviewUpdate.aiChecks = aiPatch.aiChecks;
    if (aiPatch.aiApproved != null) reviewUpdate.aiApproved = aiPatch.aiApproved;
  }
  batch.update(doc(db, 'wrongNoteReviews', reviewId), reviewUpdate);
  if (noteSnap.exists()) {
    batch.update(noteRef, { noteDetails, updatedAt: new Date().toISOString() });
  }
  await batch.commit();

  if (newStatus === SUBMISSION_STATUS_APPROVED) {
    await awardExplorationPoints(studentUUID, {
      eventId: `wrong_note_${reviewId}`,
      kind: EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED,
      points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED],
      reviewId,
      awardDate: new Date(),
      unitKey,
    });
  }
}

/**
 * 학생 problemBank(새 문제 등) 승인·반려 + 역량 집계
 *
 * @param {string} uuid
 * @param {string} bankDocId
 * @param {'approved'|'rejected'} newStatus
 * @param {string} [teacherComment]
 */
export async function resolveProblemBankItem(uuid, bankDocId, newStatus, teacherComment = '') {
  const patch = {
    teacherReviewStatus: newStatus,
    teacherComment: teacherComment || '',
    resolvedAt: new Date().toISOString(),
  };
  if (newStatus === SUBMISSION_STATUS_APPROVED) {
    patch.status = SUBMISSION_STATUS_APPROVED;
  }
  await updateDoc(doc(db, 'students', uuid, 'problemBank', bankDocId), patch);
  await syncMakingCompetencyFromProblemBank(uuid, bankDocId, newStatus, teacherComment || '');
  if (newStatus === SUBMISSION_STATUS_APPROVED) {
    const bankSnap = await getDoc(doc(db, 'students', uuid, 'problemBank', bankDocId));
    const bankData = bankSnap.exists() ? bankSnap.data() : {};
    await recordFinalApprovalUnitProgress(uuid, {
      variantStrategyId: bankData.variantStrategyId || bankData.strategyId,
      unitKey: bankData.unitKey,
      curriculumGrade: bankData.curriculumGrade,
      curriculumSemester: bankData.curriculumSemester,
      curriculumUnit: bankData.curriculumUnit,
    }).catch((e) => console.warn('[resolveProblemBankItem] unit approval', e));
    await awardMakingExplorationFromNewProblem(uuid, bankDocId, new Date())
      .catch((e) => console.warn('[resolveProblemBankItem] exploration award', e));
  }
}

/**
 * @param {string} teacherUID Firebase Auth UID of teacher
 * @returns {Promise<import('firebase/firestore').DocumentData|null>}
 */
export async function getTeacherProfile(teacherUID) {
  if (!teacherUID) return null;
  const snap = await getDoc(doc(db, 'teachers', teacherUID));
  return snap.exists() ? snap.data() : null;
}

/**
 * teachers/{uid} 문서를 초기화/업데이트합니다.
 * @param {string} teacherUID
 * @param {object} profileData
 */
export async function upsertTeacherProfile(teacherUID, profileData) {
  if (!teacherUID) return;
  await setDoc(doc(db, 'teachers', teacherUID), profileData, { merge: true });
}

// ─────────────────────────────────────────────
// 검수함 제출 완전 삭제 (개발·테스트 정리용)
// ─────────────────────────────────────────────

async function deleteDocIfExists(ref) {
  try {
    await deleteDoc(ref);
  } catch (e) {
    if (e?.code !== 'not-found') throw e;
  }
}

/**
 * 검수함 변형 문제 제출을 관련 문서까지 함께 삭제합니다.
 * variantReviews · 학생 problemBank · 시험 variants · 학급 problemBank
 *
 * @param {object} item — 검수함 목록 행 (id, studentUUID, …)
 */
export async function purgeVariantReviewSubmission(item) {
  const reviewId = String(item?.id || '').trim();
  const studentUUID = String(item?.studentUUID || '').trim();
  if (!reviewId || !studentUUID) {
    throw new Error('검수 항목 정보가 부족합니다.');
  }

  const bankDocId = resolveBankDocIdFromReview(reviewId, studentUUID, item);
  const examId = item.examId ? String(item.examId).trim() : '';
  const sourceNumber = item.questionNumber ?? item.sourceNumber;
  const classCode = item.classCode ? String(item.classCode).trim() : '';
  const classProblemId = item.classProblemId ? String(item.classProblemId).trim() : '';

  const targets = [
    doc(db, 'variantReviews', reviewId),
  ];

  if (bankDocId) {
    targets.push(doc(db, 'students', studentUUID, 'problemBank', bankDocId));
  }

  if (examId && bankDocId) {
    targets.push(doc(db, 'exams', examId, 'variants', studentUUID, 'questions', bankDocId));
  } else if (examId && sourceNumber != null && sourceNumber !== '') {
    targets.push(
      doc(db, 'exams', examId, 'variants', studentUUID, 'questions', String(sourceNumber)),
    );
  }

  if (classCode && classProblemId) {
    targets.push(doc(db, 'classes', classCode, 'problemBank', classProblemId));
  }

  await Promise.all(targets.map((ref) => deleteDocIfExists(ref)));
}

/**
 * 검수함 오답노트 제출을 삭제하고 학생 오답노트 초안의 교사 검수 상태를 제거합니다.
 *
 * @param {object} item — 검수함 목록 행
 */
export async function purgeWrongNoteReviewSubmission(item) {
  const reviewId = String(item?.id || '').trim();
  const studentUUID = String(item?.studentUUID || '').trim();
  const examResultId = String(item?.examResultId || '').trim();
  const questionNumber = item?.questionNumber;
  if (!reviewId || !studentUUID) {
    throw new Error('검수 항목 정보가 부족합니다.');
  }

  await deleteDocIfExists(doc(db, 'wrongNoteReviews', reviewId));

  if (!examResultId || questionNumber == null || questionNumber === '') return;

  const noteRef = doc(db, 'students', studentUUID, 'examWrongNotes', examResultId);
  const noteSnap = await getDoc(noteRef);
  if (!noteSnap.exists()) return;

  const qKey = String(questionNumber);
  const noteDetails = { ...(noteSnap.data().noteDetails || {}) };
  if (!noteDetails[qKey]) return;

  delete noteDetails[qKey];
  if (Object.keys(noteDetails).length === 0) {
    await deleteDocIfExists(noteRef);
    return;
  }

  await updateDoc(noteRef, {
    noteDetails,
    updatedAt: new Date().toISOString(),
  });
}
