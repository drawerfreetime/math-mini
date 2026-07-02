/**
 * 학급 문제은행 — 즉시 등록 · 동료 평가 · AI 괴리 로그
 *
 * classes/{classCode}/problemBank/{problemId}
 * classes/{classCode}/dailyProblemCounters/{YYYYMMDD}
 * variantEvaluations/{evalId}
 *   peer_evaluation — 동료 평가 원장
 *     evaluatorIsPeerJudge, judgeAiMatchPending(심사위원×AI full 일치, 점수 미지급),
 *     aiFullMatch, aiApproved/aiChecks 스냅샷
 * students/{uuid}/evalGameStats/summary — judgeEval* 집계
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  limit,
  setDoc,
  updateDoc,
  writeBatch,
  runTransaction,
  serverTimestamp,
  increment,
} from 'firebase/firestore';
import { db } from './config';
import {
  formatLabelDateKey,
  formatCounterDateKey,
  buildClassProblemLabel,
  resolveProblemLabelYear,
  problemLabelDayKey,
  normalizeClassProblemLabelsForDisplay,
} from '../utils/classProblemLabel';
import { deriveCompletionLevelFromAiReview } from '../utils/deriveCompletionLevel';
import { deriveCompletionLevelFromPeerChecks } from '../constants/peerEvalChecks';
import {
  SUBMISSION_STATUS_REGISTERED,
  SUBMISSION_STATUS_REJECTED,
  TEACHER_RESOLVED_SUBMISSION_STATUSES,
} from '../constants/aiSubmissionPolicy';
import { buildVariantReviewId, inferClassProblemReviewIds } from '../utils/variantBankIds';
import { runBackgroundVariantAiReview } from '../utils/backgroundVariantAiReview';
import { isAiReviewFallbackNote, findBestVariantReviewForClassProblem, isAiReviewResultIncomplete, isNewProblemItem } from '../utils/teacherAiFeedback';
import {
  resolveVariantReviewIdsForClassProblem,
  applyAiReviewToVariantReviewDocs,
  syncClassProblemLabelToVariantReviews,
} from '../utils/variantReviewAiSync';
import { awardExplorationPoints, revokeExplorationReward } from './explorationRewardsOps';
import { recordUnitSolveDone, recordUnitPeerEvalSuccess, resolveUnitKeyFromSource, resolveEvaluatorJudgeContext } from './unitProgressOps';
import {
  EXPLORATION_REWARD_KIND,
  EXPLORATION_REWARD_POINTS,
  computePeerEvalCheckRewardPoints,
} from '../constants/explorationRewards';
import { computePeerEvalAiMatch } from '../utils/peerEvalAiMatch';
import { anonymizeText } from '../utils/anonymizeText';
import { normalizeClassCode } from '../utils/classCode';
import { getTeacherGeminiKeyForClass, saveVariantReview, resolveVariantSolutionProcess } from './firestoreOps';

function problemRegisteredMillis(row) {
  return row?.registeredAt?.toMillis?.() || 0;
}

/** @param {object} a @param {object} b */
export function compareClassProblemsByLabel(a, b) {
  const ya = resolveProblemLabelYear(a);
  const yb = resolveProblemLabelYear(b);
  if (ya !== yb) return ya - yb;
  const da = String(a.labelDate || '').trim();
  const db = String(b.labelDate || '').trim();
  if (da && db && da !== db) return da.localeCompare(db);
  const sa = Number(a.dailySeq || 0);
  const sb = Number(b.dailySeq || 0);
  if (sa !== sb) return sa - sb;
  return problemRegisteredMillis(a) - problemRegisteredMillis(b);
}

/**
 * 학급 당일 순번 할당 (트랜잭션)
 * @param {string} classCode
 * @param {Date} [date]
 * @returns {Promise<{ dateKey: string, dailySeq: number, label: string }>}
 */
export async function allocateClassProblemLabel(classCode, date = new Date()) {
  const dateKey = formatLabelDateKey(date);
  const counterKey = formatCounterDateKey(date);
  const labelYear = date.getFullYear();
  const counterRef = doc(db, 'classes', classCode, 'dailyProblemCounters', counterKey);

  const dailySeq = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const prev = snap.exists() ? (snap.data().count || 0) : 0;
    const next = prev + 1;
    tx.set(counterRef, {
      count: next,
      dateKey,
      counterKey,
      labelYear,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return next;
  });

  return {
    dateKey,
    counterKey,
    labelYear,
    dailySeq,
    label: buildClassProblemLabel(dateKey, dailySeq),
  };
}

/**
 * @param {object} p
 * @returns {Promise<{ problemId: string, label: string, dateKey: string, dailySeq: number }>}
 */
export async function registerClassProblem(p) {
  const {
    classCode,
    createdBy,
    reviewId,
    examId,
    examTitle,
    examGrade,
    unitGoal,
    curriculumGrade,
    curriculumSemester,
    curriculumUnit,
    sourceNumber,
    originalQuestion,
    originalBogi,
    originalChoices,
    variantQuestion,
    variantBogi,
    variantChoices,
    variantAnswer,
    variantSolutionProcess,
    variantStrategyId,
    variantStrategyName,
    tableData,
    requiresSolution,
  } = p;

  if (!classCode || !createdBy) {
    throw new Error('학급·출제자 정보가 필요합니다.');
  }

  const { dateKey, counterKey, labelYear, dailySeq, label } = await allocateClassProblemLabel(classCode);
  const problemId = `${counterKey}_${dailySeq}_${createdBy.slice(0, 8)}`;

  const payload = {
    classCode,
    problemId,
    label,
    labelDate: dateKey,
    labelYear,
    counterDateKey: counterKey,
    dailySeq,
    reviewId: reviewId || null,
    examId: examId || null,
    examTitle: examTitle || '',
    examGrade: examGrade || '',
    unitGoal: unitGoal || '',
    curriculumGrade: curriculumGrade || '',
    curriculumSemester: curriculumSemester || '',
    curriculumUnit: curriculumUnit || '',
    sourceNumber: sourceNumber ?? null,
    originalQuestion: originalQuestion || '',
    originalBogi: originalBogi || null,
    originalChoices: originalChoices || null,
    variantQuestion: variantQuestion || '',
    variantBogi: variantBogi || null,
    variantChoices: variantChoices || null,
    variantAnswer: variantAnswer || '',
    variantSolutionProcess: variantSolutionProcess ? String(variantSolutionProcess).trim() : null,
    variantStrategyId: variantStrategyId || '',
    variantStrategyName: variantStrategyName || '',
    tableData: tableData || null,
    requiresSolution: !!requiresSolution,
    createdBy,
    status: SUBMISSION_STATUS_REGISTERED,
    aiReviewStatus: 'pending',
    aiApproved: null,
    aiCompletionLevel: null,
    aiChecks: null,
    aiNote: '',
    aiMode: '',
    evalCount: 0,
    registeredAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  await setDoc(doc(db, 'classes', classCode, 'problemBank', problemId), payload);

  return { problemId, label, dateKey, dailySeq };
}

/**
 * 같은 달·일(MMDD)에 누적된 잘못된 순번을 등록 시각 기준 1,2,3… 으로 보정합니다.
 * (과거 MMDD-only 카운터로 0624 문제256처럼 표시된 데이터 정리)
 *
 * @param {string} classCode
 * @returns {Promise<{ scanned: number, updated: number }>}
 */
export async function reconcileClassProblemLabels(classCode) {
  if (!classCode) return { scanned: 0, updated: 0 };

  const snap = await getDocs(collection(db, 'classes', classCode, 'problemBank'));
  const rows = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((row) => row.status === SUBMISSION_STATUS_REGISTERED);

  const byDay = new Map();
  for (const row of rows) {
    const key = problemLabelDayKey(row);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }

  let updated = 0;
  for (const group of byDay.values()) {
    group.sort((a, b) => problemRegisteredMillis(a) - problemRegisteredMillis(b));
    for (let i = 0; i < group.length; i += 1) {
      const row = group[i];
      const nextSeq = i + 1;
      const mmdd = String(row.labelDate || '').trim() || formatLabelDateKey();
      const nextLabel = buildClassProblemLabel(mmdd, nextSeq);
      const year = resolveProblemLabelYear(row);
      const counterKey = row.counterDateKey || `${year}${mmdd}`;
      const needsUpdate =
        Number(row.dailySeq || 0) !== nextSeq
        || String(row.label || '').trim() !== nextLabel
        || Number(row.labelYear || 0) !== year;

      if (!needsUpdate) continue;

      // eslint-disable-next-line no-await-in-loop
      await updateDoc(doc(db, 'classes', classCode, 'problemBank', row.id), {
        dailySeq: nextSeq,
        label: nextLabel,
        labelYear: year,
        counterDateKey: counterKey,
        updatedAt: serverTimestamp(),
      });
      // eslint-disable-next-line no-await-in-loop
      await syncClassProblemLabelToVariantReviews(
        classCode,
        row.id,
        nextLabel,
        row.reviewId,
        row.createdBy,
      ).catch((e) => {
        console.warn('[reconcileClassProblemLabels] sync variant label', row.id, e?.code);
      });
      updated += 1;
    }
  }

  return { scanned: rows.length, updated };
}

/** 개발 초기 미라벨 학급 문제 — 초4 1학기 3. 곱셈과 나눗셈 */
export const DEFAULT_CLASS_PROBLEM_CURRICULUM = {
  examGrade: '초4',
  unitGoal: '곱셈과 나눗셈',
  curriculumGrade: '4',
  curriculumSemester: '1학기',
  curriculumUnit: '3',
  unitKey: '4-1-3',
};

function isClassProblemCurriculumLabeled(row, target = DEFAULT_CLASS_PROBLEM_CURRICULUM) {
  const unitGoal = String(row.unitGoal || '').trim();
  const examGrade = String(row.examGrade || '').trim();
  const cg = String(row.curriculumGrade || '').trim();
  const cs = String(row.curriculumSemester || '').trim();
  const cu = String(row.curriculumUnit || '').trim();
  if (!unitGoal || !examGrade || !cg || !cs || !cu) return false;
  return (
    examGrade === target.examGrade
    && unitGoal === target.unitGoal
    && cg === target.curriculumGrade
    && cs === target.curriculumSemester
    && cu === target.curriculumUnit
  );
}

/**
 * 학급 problemBank 에 단원·학년 라벨이 비어 있는 문제를 일괄 보정합니다.
 * (현재 등록분은 모두 초4 1학기 3. 곱셈과 나눗셈)
 *
 * @param {string} classCode
 * @param {object} [opts]
 * @param {boolean} [opts.forceAll] true면 이미 라벨된 문서도 대상 단원으로 덮어씀
 * @returns {Promise<{ scanned: number, updated: number, variantSynced: number }>}
 */
export async function backfillClassProblemCurriculumLabels(classCode, opts = {}) {
  if (!classCode) return { scanned: 0, updated: 0, variantSynced: 0 };

  const target = DEFAULT_CLASS_PROBLEM_CURRICULUM;
  const forceAll = !!opts.forceAll;

  const snap = await getDocs(collection(db, 'classes', classCode, 'problemBank'));
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  let updated = 0;
  let variantSynced = 0;

  for (const row of rows) {
    if (!forceAll && isClassProblemCurriculumLabeled(row, target)) continue;

    const patch = {
      examGrade: target.examGrade,
      unitGoal: target.unitGoal,
      curriculumGrade: target.curriculumGrade,
      curriculumSemester: target.curriculumSemester,
      curriculumUnit: target.curriculumUnit,
      updatedAt: serverTimestamp(),
    };

    // eslint-disable-next-line no-await-in-loop
    await updateDoc(doc(db, 'classes', classCode, 'problemBank', row.id), patch);
    updated += 1;

    const reviewId = String(row.reviewId || '').trim();
    if (!reviewId) continue;

    const variantPatch = {
      examGrade: target.examGrade,
      unitGoal: target.unitGoal,
      curriculumGrade: target.curriculumGrade,
      curriculumSemester: target.curriculumSemester,
      curriculumUnit: target.curriculumUnit,
      unitKey: target.unitKey,
      updatedAt: serverTimestamp(),
    };

    // eslint-disable-next-line no-await-in-loop
    const variantRef = doc(db, 'variantReviews', reviewId);
    // eslint-disable-next-line no-await-in-loop
    const variantSnap = await getDoc(variantRef).catch(() => null);
    if (!variantSnap?.exists()) continue;

    // eslint-disable-next-line no-await-in-loop
    await updateDoc(variantRef, variantPatch).catch((e) => {
      console.warn('[backfillClassProblemCurriculumLabels] variantReviews', reviewId, e?.code);
    });
    variantSynced += 1;
  }

  return { scanned: rows.length, updated, variantSynced };
}

/**
 * 학급 problemBank 표시 라벨을 연결된 variantReviews 에 반영합니다.
 * @param {string} classCode
 * @param {Array<object>} problems
 * @returns {Promise<{ synced: number }>}
 */
export async function syncClassProblemBankLabelsToVariantReviews(classCode, problems) {
  if (!classCode || !Array.isArray(problems) || problems.length === 0) {
    return { synced: 0 };
  }

  let synced = 0;
  for (const problem of problems) {
    const label = String(problem.label || '').trim();
    if (!label) continue;
    // eslint-disable-next-line no-await-in-loop
    const count = await syncClassProblemLabelToVariantReviews(
      classCode,
      problem.id,
      label,
      problem.reviewId,
      problem.createdBy,
    );
    synced += count;
  }
  return { synced };
}

/**
 * 본인이 등록한 학급 문제 내용 수정 (라벨·순번 유지)
 * @param {object} p
 * @returns {Promise<{ problemId: string, label: string, dateKey: string, dailySeq: number }>}
 */
export async function updateClassProblem(p) {
  const {
    classCode,
    problemId,
    createdBy,
    reviewId,
    unitGoal,
    curriculumGrade,
    curriculumSemester,
    curriculumUnit,
    variantQuestion,
    variantBogi,
    variantChoices,
    variantAnswer,
    variantSolutionProcess,
    variantStrategyId,
    variantStrategyName,
    tableData,
    requiresSolution,
  } = p;

  if (!classCode || !problemId || !createdBy) {
    throw new Error('학급·문제 정보가 필요합니다.');
  }

  const ref = doc(db, 'classes', classCode, 'problemBank', problemId);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new Error('수정할 문제를 찾을 수 없습니다.');
  }
  const data = snap.data();
  if (data.createdBy !== createdBy) {
    throw new Error('본인이 등록한 문제만 수정할 수 있습니다.');
  }

  await updateDoc(ref, {
    reviewId: reviewId || data.reviewId || null,
    unitGoal: unitGoal != null ? String(unitGoal) : (data.unitGoal || ''),
    curriculumGrade: curriculumGrade != null ? String(curriculumGrade) : (data.curriculumGrade || ''),
    curriculumSemester: curriculumSemester != null ? String(curriculumSemester) : (data.curriculumSemester || ''),
    curriculumUnit: curriculumUnit != null ? String(curriculumUnit) : (data.curriculumUnit || ''),
    variantQuestion: variantQuestion || '',
    variantBogi: variantBogi || null,
    variantChoices: variantChoices || null,
    variantAnswer: variantAnswer || '',
    variantSolutionProcess: variantSolutionProcess != null
      ? (String(variantSolutionProcess).trim() || null)
      : (data.variantSolutionProcess || null),
    variantStrategyId: variantStrategyId || '',
    variantStrategyName: variantStrategyName || '',
    tableData: tableData || null,
    requiresSolution: !!requiresSolution,
    status: SUBMISSION_STATUS_REGISTERED,
    aiReviewStatus: 'pending',
    aiApproved: null,
    aiCompletionLevel: null,
    aiChecks: null,
    aiNote: '',
    aiMode: '',
    updatedAt: serverTimestamp(),
  });

  return {
    problemId,
    label: data.label || '',
    dateKey: data.labelDate || '',
    dailySeq: data.dailySeq || 0,
  };
}

/**
 * 내 문제 저장소에만 있고 학급 문제은행에 없는 항목을 등록 (이전 저장분 보정)
 * @param {string} uuid
 * @param {string} classCode
 */
export async function syncStudentProblemsToClassBank(uuid, classCode) {
  if (!uuid || !classCode) return;

  const snap = await getDocs(collection(db, 'students', uuid, 'problemBank'));
  const tasks = snap.docs.map(async (d) => {
    const item = d.data();
    if (item.classProblemId || !item.examId || item.sourceNumber == null) return;

    const qSnap = await getDoc(
      doc(db, 'exams', item.examId, 'questions', String(item.sourceNumber)),
    );
    const orig = qSnap.exists() ? qSnap.data() : {};
    const bankDocId = d.id;
    const reviewId = item.reviewId || buildVariantReviewId(uuid, bankDocId);
    const rawSolution = String(item.solutionProcess || '').trim();
    const variantSolutionProcess = rawSolution
      ? (anonymizeText(rawSolution).anonymized || rawSolution)
      : null;

    const reg = await registerClassProblem({
      classCode,
      createdBy: uuid,
      reviewId,
      examId: item.examId,
      examTitle: item.examTitle || '',
      examGrade: item.examGrade || '',
      sourceNumber: item.sourceNumber,
      originalQuestion: String(orig.question || orig.text || '').trim(),
      originalBogi: orig.bogi ? String(orig.bogi).trim() : null,
      originalChoices: Array.isArray(orig.choices) && orig.choices.length ? orig.choices : null,
      variantQuestion: item.question || '',
      variantBogi: item.bogi || null,
      variantChoices: item.choices || null,
      variantAnswer: item.answer || '',
      variantSolutionProcess,
      variantStrategyId: item.variantStrategyId || '',
      variantStrategyName: item.variantStrategyName || '',
      tableData: item.tableData || null,
      requiresSolution: !!item.requiresSolution,
    });

    if (item.aiReviewStatus === 'done') {
      await updateClassProblemAiReview(classCode, reg.problemId, {
        approved: item.aiApproved !== false,
        feedback: item.aiNote || '',
        aiMode: item.aiMode || '',
        checks: item.aiChecks || null,
        completionLevel: item.aiCompletionLevel || null,
      });
    }

    await updateDoc(doc(db, 'students', uuid, 'problemBank', d.id), {
      classProblemId: reg.problemId,
      classProblemLabel: reg.label,
      status: SUBMISSION_STATUS_REGISTERED,
    });

    await saveVariantReview({
      reviewId,
      bankDocId,
      examId: item.examId,
      examTitle: item.examTitle || '',
      examGrade: item.examGrade || '',
      studentUUID: uuid,
      classCode,
      questionNumber: item.sourceNumber ?? null,
      question: String(item.question || '').trim(),
      bogi: item.bogi || null,
      choices: Array.isArray(item.choices) && item.choices.length ? item.choices : null,
      solutionProcess: item.solutionProcess || null,
      answer: String(item.answer || '').trim(),
      nameMap: {},
      status: SUBMISSION_STATUS_REGISTERED,
      aiNote: item.aiNote || '',
      aiMode: item.aiMode || '',
      aiApproved: item.aiApproved ?? null,
      aiChecks: item.aiChecks || null,
      aiReviewStatus: item.aiReviewStatus || 'pending',
      aiCompletionLevel: item.aiCompletionLevel ?? null,
      variantStrategyId: item.variantStrategyId || '',
      variantStrategyName: item.variantStrategyName || '',
      classProblemId: reg.problemId,
      classProblemLabel: reg.label,
    }).catch((e) => {
      console.warn('[syncStudentProblemsToClassBank] saveVariantReview', reviewId, e?.code);
    });
  });

  await Promise.all(tasks);
}

/**
 * @param {string} classCode
 * @param {string} problemId
 * @param {object} aiReview reviewStudentVariant 응답
 */
export async function updateClassProblemAiReview(classCode, problemId, aiReview) {
  if (!classCode || !problemId) return;

  const completionLevel = deriveCompletionLevelFromAiReview(aiReview);
  const ref = doc(db, 'classes', classCode, 'problemBank', problemId);

  await updateDoc(ref, {
    aiReviewStatus: 'done',
    aiApproved: !!aiReview.approved,
    aiCompletionLevel: completionLevel,
    aiChecks: aiReview.checks || null,
    aiNote: aiReview.feedback || '',
    aiMode: aiReview.aiMode || '',
    updatedAt: serverTimestamp(),
  });
}

/**
 * 교사 승인·반려에 따라 학급 문제은행 노출 상태를 동기화합니다.
 * getClassProblems는 status === 'registered' 만 표시합니다.
 *
 * @param {string} classCode
 * @param {string} problemId
 * @param {'registered'|'rejected'} status
 */
export async function setClassProblemVisibilityStatus(classCode, problemId, status) {
  if (!classCode || !problemId) return;
  if (status !== SUBMISSION_STATUS_REGISTERED && status !== SUBMISSION_STATUS_REJECTED) return;

  const ref = doc(db, 'classes', classCode, 'problemBank', problemId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;

  await updateDoc(ref, {
    status,
    updatedAt: serverTimestamp(),
  });
}

/**
 * @param {string} classCode
 * @param {string} [excludeUuid] 본인 문제 제외
 * @param {number} [maxItems]
 */
export async function getClassProblems(classCode, excludeUuid = '', maxItems = 500) {
  if (!classCode) return [];

  const q = query(
    collection(db, 'classes', classCode, 'problemBank'),
    where('status', '==', SUBMISSION_STATUS_REGISTERED),
    limit(maxItems),
  );
  const snap = await getDocs(q);
  const rows = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((row) => !excludeUuid || row.createdBy !== excludeUuid);
  return normalizeClassProblemLabelsForDisplay(
    rows.sort(compareClassProblemsByLabel),
  );
}

/**
 * @param {string} classCode
 * @param {string} problemId
 */
export async function getClassProblem(classCode, problemId) {
  if (!classCode || !problemId) return null;
  const norm = normalizeClassCode(classCode);
  const problems = await getClassProblems(norm, '', 200);
  const found = problems.find((p) => p.id === problemId) || null;
  if (!found) return null;
  return { ...found, classCode: normalizeClassCode(found.classCode || norm) };
}

function pickCreatorSolutionText(...candidates) {
  for (const raw of candidates) {
    const text = String(raw || '').trim();
    if (text) return text;
  }
  return '';
}

/**
 * 풀이 후 출제자 정답·풀이 확인용 — problemBank 저장분 우선, 없으면 variantReviews 조회
 * @param {object} problem
 * @param {string} [classCodeHint] 라우트·세션 classCode (문서에 classCode 없을 때)
 * @returns {Promise<string>}
 */
export async function fetchClassProblemCreatorReveal(problem, classCodeHint = '') {
  const problemId = String(problem?.id || problem?.problemId || '').trim();
  const classCode = normalizeClassCode(problem?.classCode || classCodeHint);

  const fromProp = pickCreatorSolutionText(problem?.variantSolutionProcess);
  if (fromProp) return fromProp;

  if (classCode && problemId) {
    try {
      const snap = await getDoc(doc(db, 'classes', classCode, 'problemBank', problemId));
      if (snap.exists()) {
        const row = snap.data() || {};
        const fromDoc = pickCreatorSolutionText(row.variantSolutionProcess, row.solutionProcess);
        if (fromDoc) return fromDoc;
      }
    } catch (e) {
      console.warn('[creator reveal] class bank', e);
    }
  }

  const reviewIds = inferClassProblemReviewIds(problem);
  for (const reviewId of reviewIds) {
    // eslint-disable-next-line no-await-in-loop
    const { text } = await resolveVariantSolutionProcess(
      problem?.createdBy,
      reviewId,
      problemId,
    );
    const fromReview = pickCreatorSolutionText(text);
    if (fromReview) return fromReview;
  }

  return '';
}

/**
 * 학급 problemBank 에 variantSolutionProcess 가 비어 있는 등록 문제를
 * variantReviews·학생 problemBank 에서 보정합니다 (교사·관리용).
 *
 * @param {string} classCode
 * @param {{ maxItems?: number }} [opts]
 * @returns {Promise<{ scanned: number, updated: number }>}
 */
export async function backfillClassProblemCreatorSolutions(classCode, opts = {}) {
  const norm = normalizeClassCode(classCode);
  if (!norm) return { scanned: 0, updated: 0 };

  const maxItems = Number.isFinite(opts.maxItems) ? Math.max(1, opts.maxItems) : 500;
  const snap = await getDocs(query(
    collection(db, 'classes', norm, 'problemBank'),
    where('status', '==', SUBMISSION_STATUS_REGISTERED),
    limit(maxItems),
  ));

  let scanned = 0;
  let updated = 0;

  for (const d of snap.docs) {
    scanned += 1;
    const row = { id: d.id, ...d.data() };
    if (pickCreatorSolutionText(row.variantSolutionProcess, row.solutionProcess)) continue;

    // eslint-disable-next-line no-await-in-loop
    const solutionText = await fetchClassProblemCreatorReveal(row, norm);
    if (!solutionText) continue;

    // eslint-disable-next-line no-await-in-loop
    await updateDoc(doc(db, 'classes', norm, 'problemBank', d.id), {
      variantSolutionProcess: solutionText,
      updatedAt: serverTimestamp(),
    });
    updated += 1;
  }

  return { scanned, updated };
}

/**
 * aiReviewStatus는 'done'이지만 실질적으로 AI 검수가 끝나지 않은 건 — 재검수 대상
 * - validation: 풀이과정 누락 등 사전 검증만 수행
 * - peer_review: AI API 전체 실패 → 교사/동료 검수 대기
 */
function shouldRerunAiReviewDespiteDone(row) {
  const mode = String(row.aiMode || '').trim();
  if (mode === 'validation' || mode === 'peer_review') return true;
  if (isAiReviewFallbackNote(row.aiNote)) return true;
  return isAiReviewResultIncomplete(row);
}

/**
 * problemBank AI 피드백을 검수함(variantReviews)으로 복사합니다 (API 재호출 없음).
 * @param {string} classCode
 * @param {Array<object>} problems
 * @param {Array<object>|null|undefined} [allReviews]
 * @returns {Promise<{ synced: number }>}
 */
export async function syncClassProblemBankAiToVariantReviews(classCode, problems, allReviews) {
  if (!classCode || !Array.isArray(problems) || problems.length === 0) {
    return { synced: 0 };
  }

  let synced = 0;
  const pool = allReviews || [];

  for (const problem of problems) {
    const pbNote = String(problem.aiNote || '').trim();
    if (!pbNote || isAiReviewFallbackNote(pbNote)) continue;
    if (String(problem.aiReviewStatus || '').trim() !== 'done') continue;

    const vr = findBestVariantReviewForClassProblem(problem, pool);
    const vrNote = String(vr?.aiNote || '').trim();
    const vrIsFallback = isAiReviewFallbackNote(vrNote);
    const alreadySynced = vrNote && !vrIsFallback
      && vrNote === pbNote
      && vr.aiApproved === problem.aiApproved
      && vr.aiMode === problem.aiMode
      && vr.aiCompletionLevel === problem.aiCompletionLevel;
    if (alreadySynced) continue;

    const shouldSync = !vrNote || vrIsFallback || vrNote !== pbNote;
    if (!shouldSync) continue;

    // eslint-disable-next-line no-await-in-loop
    const reviewIds = await resolveVariantReviewIdsForClassProblem(
      classCode,
      problem.id,
      problem.reviewId,
      problem.createdBy,
    );
    if (reviewIds.length === 0) continue;

    // eslint-disable-next-line no-await-in-loop
    const count = await applyAiReviewToVariantReviewDocs(reviewIds, {
      feedback: pbNote,
      approved: problem.aiApproved,
      aiMode: problem.aiMode,
      checks: problem.aiChecks,
      completionLevel: problem.aiCompletionLevel,
      peerReview: problem.aiMode === 'peer_review',
    });
    synced += count;
  }

  return { synced };
}

/**
 * 검수함(variantReviews)에 있는 AI 피드백을 problemBank 문서로 복사합니다 (API 재호출 없음).
 * @param {string} classCode
 * @param {Array<object>} problems
 * @param {{ byReviewId?: Map<string, object>, byClassProblemId?: Map<string, object> }|null} lookup
 * @param {Array<object>|null|undefined} [allReviews]
 * @returns {Promise<{ synced: number }>}
 */
export async function syncClassProblemBankAiFromVariantReviews(classCode, problems, lookup, allReviews) {
  if (!classCode || !lookup || !Array.isArray(problems) || problems.length === 0) {
    return { synced: 0 };
  }

  let synced = 0;

  for (const problem of problems) {
    const vr = findBestVariantReviewForClassProblem(problem, allReviews);
    if (!vr) continue;

    const vrNote = String(vr.aiNote || '').trim();
    if (!vrNote || isAiReviewFallbackNote(vrNote)) continue;

    const pbNote = String(problem.aiNote || '').trim();
    const pbIsFallback = isAiReviewFallbackNote(pbNote);
    if (pbNote === vrNote
      && problem.aiApproved === vr.aiApproved
      && problem.aiMode === vr.aiMode
      && problem.aiCompletionLevel === vr.aiCompletionLevel) {
      continue;
    }
    // problemBank 에 이미 다른 정상 피드백이 있으면 덮어쓰지 않음
    if (pbNote && !pbIsFallback) continue;

    // eslint-disable-next-line no-await-in-loop
    await updateClassProblemAiReview(classCode, problem.id, {
      approved: vr.aiApproved,
      feedback: vrNote,
      aiMode: vr.aiMode || '',
      checks: vr.aiChecks || null,
      completionLevel: vr.aiCompletionLevel || null,
    });
    synced += 1;
  }

  return { synced };
}

/**
 * 검수함(variantReviews)의 교사 검수 결과를 학급 problemBank에 반영합니다.
 * @param {string} classCode
 * @param {Array<object>} problems
 * @param {Array<object>|null|undefined} [allReviews]
 * @returns {Promise<{ synced: number }>}
 */
export async function syncClassProblemBankTeacherReviewFromVariantReviews(
  classCode,
  problems,
  allReviews,
) {
  if (!classCode || !Array.isArray(problems) || problems.length === 0) {
    return { synced: 0 };
  }

  let synced = 0;
  const pool = allReviews || [];

  for (const problem of problems) {
    const vr = findBestVariantReviewForClassProblem(problem, pool);
    if (!vr) continue;

    const vrStatus = String(vr.teacherReviewStatus || '').trim()
      || (TEACHER_RESOLVED_SUBMISSION_STATUSES.includes(String(vr.status || '').trim())
        ? String(vr.status).trim()
        : '');
    if (!vrStatus || vrStatus === SUBMISSION_STATUS_REJECTED) continue;

    const curStatus = String(problem.teacherReviewStatus || '').trim();
    if (curStatus === vrStatus) continue;

    // eslint-disable-next-line no-await-in-loop
    await updateDoc(doc(db, 'classes', classCode, 'problemBank', problem.id), {
      teacherReviewStatus: vrStatus,
      teacherResolvedAt: vr.resolvedAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    synced += 1;
  }

  return { synced };
}

/**
 * @param {object} row
 * @param {string} solutionText
 * @returns {Promise<string>}
 */
async function anonymizeSolutionForAiReview(row, solutionText) {
  const raw = String(solutionText || '').trim();
  if (!raw) return '';
  const { anonymized } = anonymizeText(raw);
  return anonymized || raw;
}

/**
 * 학급 문제은행의 "AI 미검수/오류" 문제를 다시 AI 검수합니다.
 * - 기존 문서를 삭제/복사하지 않고, aiReviewStatus만 갱신합니다.
 * - 백엔드(/api/review-student-variant)가 실행 중이어야 합니다.
 *
 * @param {string} classCode
 * @param {{ maxItems?: number, onlyNotDone?: boolean }} [opts]
 * @returns {Promise<{ scanned: number, queued: number, skippedDone: number }>}
 */
export async function rerunClassProblemAiReviews(classCode, opts = {}) {
  if (!classCode) throw new Error('classCode가 필요합니다.');
  const maxItems = Number.isFinite(opts.maxItems) ? Math.max(1, opts.maxItems) : 200;
  const onlyNotDone = opts.onlyNotDone !== false; // default true
  const problemIds = Array.isArray(opts.problemIds)
    ? opts.problemIds.map((id) => String(id || '').trim()).filter(Boolean)
    : null;

  const teacherGeminiKey = await getTeacherGeminiKeyForClass(classCode).catch(() => '');

  const snap = problemIds?.length === 1
    ? {
        docs: [
          await getDoc(doc(db, 'classes', classCode, 'problemBank', problemIds[0])),
        ].filter((d) => d.exists()),
      }
    : await getDocs(query(
        collection(db, 'classes', classCode, 'problemBank'),
        limit(maxItems),
      ));

  let scanned = 0;
  let queued = 0;
  let skippedDone = 0;

  // 과도한 동시 요청을 피하려고 순차 실행 (AI API는 비용/속도 민감)
  for (const d of snap.docs) {
    scanned += 1;
    const row = d.data() || {};
    const problemId = d.id;

    if (problemIds && problemIds.length > 0 && !problemIds.includes(problemId)) {
      continue;
    }

    const aiReviewStatus = String(row.aiReviewStatus || '').trim();

    if (onlyNotDone && aiReviewStatus === 'done' && !shouldRerunAiReviewDespiteDone(row)) {
      skippedDone += 1;
      continue;
    }

    // 재검수 시작 표시
    await updateDoc(doc(db, 'classes', classCode, 'problemBank', problemId), {
      aiReviewStatus: 'pending',
      updatedAt: serverTimestamp(),
    }).catch(() => {});

    const { anonymized: anonQuestion } = anonymizeText(String(row.variantQuestion || '').trim());
    const { anonymized: anonBogi } = row.variantBogi ? anonymizeText(String(row.variantBogi)) : { anonymized: row.variantBogi };

    const reviewId = row.reviewId || '';
    const studentUUID = String(row.createdBy || '').trim();
    const { text: solutionText, source: solutionSource } = await resolveVariantSolutionProcess(
      studentUUID,
      reviewId,
      problemId,
    );
    const anonSolution = solutionSource === 'variantReview'
      ? solutionText
      : await anonymizeSolutionForAiReview(row, solutionText);

    const anonPayload = {
      question: anonQuestion,
      bogi: anonBogi || null,
      choices: Array.isArray(row.variantChoices) && row.variantChoices.length ? row.variantChoices : null,
      solutionProcess: anonSolution,
      answer: String(row.variantAnswer || '').trim(),
      requiresSolution: !!row.requiresSolution,
      examGrade: row.examGrade || row.grade || '',
      originalQuestion: String(row.originalQuestion || '').trim(),
      originalBogi: row.originalBogi ? String(row.originalBogi).trim() : '',
      originalChoices: Array.isArray(row.originalChoices) && row.originalChoices.length ? row.originalChoices : null,
      variantStrategyId: row.variantStrategyId || '',
      variantStrategyName: row.variantStrategyName || '',
      unitGoal: row.unitGoal || '',
      teacherGeminiKey,
    };

    queued += 1;
    // eslint-disable-next-line no-await-in-loop
    await runBackgroundVariantAiReview({
      classCode,
      problemId,
      reviewId,
      studentUUID,
      teacherGeminiKey,
      anonPayload,
    });
  }

  return { scanned, queued, skippedDone };
}

/**
 * 학급 문제은행에서 특정 문제 1건을 AI 재검수합니다 (완료 건도 포함).
 * @param {string} classCode
 * @param {string} problemId
 */
export async function rerunSingleClassProblemAiReview(classCode, problemId) {
  return rerunClassProblemAiReviews(classCode, {
    problemIds: [problemId],
    onlyNotDone: false,
    maxItems: 1,
  });
}

function resolveCurriculumUnitNum(row) {
  const uk = resolveUnitKeyFromSource(row);
  if (uk) {
    const parts = uk.split('-');
    if (parts[2]) return parts[2];
  }
  const m = String(row.curriculumUnit || row.unit || '').match(/^(\d+)/);
  return m ? m[1] : '3';
}

/**
 * variantReviews 행 → AI 검수 API 페이로드
 * @param {object} row
 * @param {string} teacherGeminiKey
 */
export function buildAnonPayloadForVariantReview(row, teacherGeminiKey) {
  const question = String(row.question || row.variantQuestion || '').trim();
  const solutionProcess = String(row.solutionProcess || row.variantSolutionProcess || '').trim();
  return {
    question,
    bogi: row.bogi || row.variantBogi || null,
    choices: Array.isArray(row.choices) && row.choices.length
      ? row.choices
      : (Array.isArray(row.variantChoices) && row.variantChoices.length ? row.variantChoices : null),
    solutionProcess,
    answer: String(row.answer || row.variantAnswer || '').trim(),
    requiresSolution: row.requiresSolution !== false,
    examGrade: row.examGrade || row.curriculumGrade || row.grade || '',
    grade: row.curriculumGrade || row.examGrade || row.grade || '',
    semester: row.curriculumSemester || row.semester || '1학기',
    unit: resolveCurriculumUnitNum(row),
    originalQuestion: String(row.originalQuestion || '').trim(),
    originalBogi: row.originalBogi ? String(row.originalBogi).trim() : '',
    originalChoices: Array.isArray(row.originalChoices) && row.originalChoices.length
      ? row.originalChoices
      : null,
    variantStrategyId: row.variantStrategyId || '',
    variantStrategyName: row.variantStrategyName || '',
    unitGoal: row.unitGoal || '',
    teacherGeminiKey,
    problemKind: isNewProblemItem(row) ? 'new' : 'variant',
  };
}

function variantReviewNeedsAiRerun(row, onlyNotDone) {
  const st = String(row.aiReviewStatus || 'pending').trim();
  if (!onlyNotDone) return true;
  if (st === 'pending' || st === 'error' || st === '') return true;
  if (st === 'done' && shouldRerunAiReviewDespiteDone(row)) return true;
  return false;
}

/**
 * 검수함(variantReviews)에 있는 문제를 직접 AI 재검수합니다.
 * 새 문제 만들기는 학급 problemBank에 없어도 여기서 처리됩니다.
 *
 * @param {string} classCode
 * @param {Array<object>} reviews getVariantReviewsByClass 등으로 조회한 목록
 * @param {{ maxItems?: number, onlyNotDone?: boolean, onlyNewProblem?: boolean }} [opts]
 * @returns {Promise<{ scanned: number, queued: number, skippedDone: number }>}
 */
export async function rerunVariantReviewsAiReviews(classCode, reviews, opts = {}) {
  if (!classCode) throw new Error('classCode가 필요합니다.');
  const maxItems = Number.isFinite(opts.maxItems) ? Math.max(1, opts.maxItems) : 200;
  const onlyNotDone = opts.onlyNotDone !== false;
  const onlyNewProblem = opts.onlyNewProblem === true;
  const teacherGeminiKey = await getTeacherGeminiKeyForClass(classCode).catch(() => '');

  let scanned = 0;
  let queued = 0;
  let skippedDone = 0;

  const pool = Array.isArray(reviews) ? reviews : [];
  for (const row of pool) {
    if (scanned >= maxItems) break;
    scanned += 1;

    if (onlyNewProblem && !isNewProblemItem(row)) {
      skippedDone += 1;
      continue;
    }
    if (!variantReviewNeedsAiRerun(row, onlyNotDone)) {
      skippedDone += 1;
      continue;
    }

    const reviewId = String(row.id || row.reviewId || '').trim();
    const studentUUID = String(row.studentUUID || row.createdBy || '').trim();
    const classProblemId = String(row.classProblemId || '').trim();
    const bankDocId = String(row.bankDocId || '').trim();
    if (!reviewId) continue;

    await updateDoc(doc(db, 'variantReviews', reviewId), {
      aiReviewStatus: 'pending',
      updatedAt: serverTimestamp(),
    }).catch(() => {});

    if (bankDocId && studentUUID) {
      await updateDoc(doc(db, 'students', studentUUID, 'problemBank', bankDocId), {
        aiReviewStatus: 'pending',
      }).catch(() => {});
    }

    if (classProblemId) {
      await updateDoc(doc(db, 'classes', classCode, 'problemBank', classProblemId), {
        aiReviewStatus: 'pending',
        updatedAt: serverTimestamp(),
      }).catch(() => {});
    }

    queued += 1;
    // eslint-disable-next-line no-await-in-loop
    await runBackgroundVariantAiReview({
      classCode,
      problemId: classProblemId,
      reviewId,
      studentUUID,
      bankDocId: bankDocId || undefined,
      teacherGeminiKey,
      anonPayload: buildAnonPayloadForVariantReview(row, teacherGeminiKey),
    });
  }

  return { scanned, queued, skippedDone };
}

/**
 * 본인이 등록한 학급 문제 중 AI 검수가 끝나지 않은 항목을 다시 검수합니다.
 * (제출 직후 페이지를 떠나 백그라운드 검수가 중단된 경우 보정)
 *
 * @param {string} uuid
 * @param {string} classCode
 * @param {Array<object>} problems getClassProblems 결과
 */
export async function retryOwnPendingClassProblemAiReviews(uuid, classCode, problems) {
  if (!uuid || !classCode || !Array.isArray(problems) || problems.length === 0) return;

  const teacherGeminiKey = await getTeacherGeminiKeyForClass(classCode).catch(() => '');
  const pending = problems.filter((p) => {
    if (p.createdBy !== uuid) return false;
    const st = String(p.aiReviewStatus || 'pending').trim();
    return st === 'pending' || st === 'error' || st === '';
  });
  if (pending.length === 0) return;

  for (const row of pending) {
    const problemId = row.id;
    const { anonymized: anonQuestion } = anonymizeText(String(row.variantQuestion || '').trim());
    const { anonymized: anonBogi } = row.variantBogi
      ? anonymizeText(String(row.variantBogi))
      : { anonymized: row.variantBogi };

    const reviewId = row.reviewId || '';
    const { text: solutionText, source: solutionSource } = await resolveVariantSolutionProcess(
      uuid,
      reviewId,
      problemId,
    );
    const anonSolution = solutionSource === 'variantReview'
      ? solutionText
      : await anonymizeSolutionForAiReview(row, solutionText);

    // eslint-disable-next-line no-await-in-loop
    await runBackgroundVariantAiReview({
      classCode,
      problemId,
      reviewId,
      studentUUID: uuid,
      bankDocId: '',
      strategyId: row.variantStrategyId || '',
      teacherGeminiKey,
      anonPayload: {
        question: anonQuestion,
        bogi: anonBogi || null,
        choices: Array.isArray(row.variantChoices) && row.variantChoices.length ? row.variantChoices : null,
        solutionProcess: anonSolution,
        answer: String(row.variantAnswer || '').trim(),
        requiresSolution: !!row.requiresSolution,
        examGrade: row.examGrade || row.grade || '',
        originalQuestion: String(row.originalQuestion || '').trim(),
        originalBogi: row.originalBogi ? String(row.originalBogi).trim() : '',
        originalChoices: Array.isArray(row.originalChoices) && row.originalChoices.length
          ? row.originalChoices
          : null,
        variantStrategyId: row.variantStrategyId || '',
        variantStrategyName: row.variantStrategyName || '',
        unitGoal: row.unitGoal || '',
      },
    }).catch((e) => console.warn('[retryOwnPendingClassProblemAiReviews]', problemId, e));
  }
}

/**
 * 학급 문제 풀이 시도 기록 (정답 여부 · AI 검수 상태 — 개발·분석용)
 * @param {object} p
 */
export async function recordClassProblemSolveAttempt(p) {
  const {
    classCode,
    problemId,
    problemLabel,
    creatorUUID,
    evaluatorUUID,
    solvedCorrect,
    submittedAnswer,
    submittedSolutionProcess,
    aiApproved,
    aiCompletionLevel,
    aiReviewStatus,
    aiGradedCorrect,
    curriculumGrade,
    curriculumSemester,
    curriculumUnit,
  } = p;

  const unitKey = resolveUnitKeyFromSource({
    curriculumGrade,
    curriculumSemester,
    curriculumUnit,
  });

  const attemptId = `solve_${problemId}_${evaluatorUUID}_${Date.now()}`;

  await setDoc(doc(db, 'variantEvaluations', attemptId), {
    recordType: 'solve_attempt',
    classCode,
    problemId,
    problemLabel: problemLabel || '',
    creatorUUID,
    evaluatorUUID,
    solvedCorrect: !!solvedCorrect,
    aiGradedCorrect: typeof aiGradedCorrect === 'boolean' ? aiGradedCorrect : !!solvedCorrect,
    submittedAnswer: submittedAnswer || '',
    submittedSolutionProcess: submittedSolutionProcess || '',
    aiApproved: aiApproved ?? null,
    aiCompletionLevel: aiCompletionLevel ?? null,
    aiReviewStatus: aiReviewStatus || '',
    attemptedAt: serverTimestamp(),
  });

  if (solvedCorrect && evaluatorUUID && problemId) {
    await awardExplorationPoints(evaluatorUUID, {
      eventId: `solve_${problemId}`,
      kind: EXPLORATION_REWARD_KIND.SOLVE_CORRECT,
      points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.SOLVE_CORRECT],
      classCode,
      problemId,
      awardDate: new Date(),
      unitKey,
    });
    if (unitKey) {
      await recordUnitSolveDone(evaluatorUUID, unitKey)
        .catch((e) => console.warn('[recordClassProblemSolveAttempt] unit solve', e));
    }
  }
}

/**
 * 동료 평가 제출 + AI 일치 로그 + (일반) 탐구 포인트
 * 심사위원×AI 일치 점수는 scorePending 으로만 표시 — 점수 체계 확정 후 지급
 * @param {object} p
 * @param {boolean} [p.skipGameStats=false] false면 동료평가 탐구 포인트 반영
 */
export async function submitVariantPeerEvaluation(p) {
  const {
    classCode,
    problemId,
    problemLabel,
    creatorUUID,
    evaluatorUUID,
    solvedCorrect,
    guessedStrategyId,
    creatorStrategyId,
    peerChecks,
    problemThought,
    aiApproved,
    aiChecks,
    aiReviewStatus,
    aiMode,
    aiCompletionLevel: aiCompletionLevelIn,
    skipGameStats = false,
    curriculumGrade,
    curriculumSemester,
    curriculumUnit,
  } = p;

  const unitKey = resolveUnitKeyFromSource({
    curriculumGrade,
    curriculumSemester,
    curriculumUnit,
  });

  const strategyMatch = guessedStrategyId === creatorStrategyId;
  const guessedCompletionLevel = deriveCompletionLevelFromPeerChecks(peerChecks);
  const aiCompletionLevel = aiCompletionLevelIn || null;
  const aiMatch = computePeerEvalAiMatch({
    strategyMatch,
    peerChecks,
    aiChecks,
    aiCompletionLevel,
  });
  const completionMatch = aiMatch.completionMatch;
  const checksMatch = aiMatch.checksMatch;
  const peerCheckRewardPoints = aiMatch.hasChecksAxis
    ? computePeerEvalCheckRewardPoints(aiMatch.checkHitCount)
    : 0;
  const earnedCheckReward = peerCheckRewardPoints > 0;

  const judgeCtx = await resolveEvaluatorJudgeContext(
    evaluatorUUID,
    creatorStrategyId,
    unitKey,
  );
  const resolvedUnitKey = unitKey || judgeCtx.unitKey || '';
  const evaluatorIsPeerJudge = judgeCtx.isPeerJudge;
  const judgeAiMatchPending =
    evaluatorIsPeerJudge && aiMatch.aiFullMatch;

  const evalId = `peer_${problemId}_${evaluatorUUID}_${Date.now()}`;

  await setDoc(doc(db, 'variantEvaluations', evalId), {
    recordType: 'peer_evaluation',
    classCode,
    problemId,
    problemLabel: problemLabel || '',
    creatorUUID,
    evaluatorUUID,
    unitKey: resolvedUnitKey || null,
    evaluatorIsPeerJudge,
    evaluatorStrategyApprovalCount: judgeCtx.strategyApprovalCount,
    evaluatorJudgeThreshold: judgeCtx.judgeThreshold,
    solvedCorrect: !!solvedCorrect,
    guessedStrategyId,
    creatorStrategyId,
    strategyMatch,
    peerChecks: peerChecks || null,
    guessedCompletionLevel,
    aiCompletionLevel: aiCompletionLevel || null,
    completionMatch,
    checksMatch,
    checkHitCount: aiMatch.checkHitCount,
    hasChecksAxis: aiMatch.hasChecksAxis,
    peerCheckRewardPoints,
    aiFullMatch: aiMatch.aiFullMatch,
    hasCompletionAxis: aiMatch.hasCompletionAxis,
    strategyDiscrepancy: !strategyMatch,
    completionDiscrepancy: aiCompletionLevel ? !completionMatch : null,
    checksDiscrepancy: aiMatch.hasChecksAxis ? !checksMatch : null,
    aiApproved: aiApproved ?? null,
    aiChecks: aiChecks || null,
    aiReviewStatus: aiReviewStatus || '',
    aiMode: aiMode || null,
    judgeAiMatchPending,
    ...(problemThought ? { problemThought } : {}),
    evaluatedAt: serverTimestamp(),
  });

  const problemRef = doc(db, 'classes', classCode, 'problemBank', problemId);
  try {
    await updateDoc(problemRef, {
      evalCount: increment(1),
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    console.warn('[submitVariantPeerEvaluation] evalCount', e?.code, e?.message);
  }

  if (!skipGameStats) {
    const statsRef = doc(db, 'students', evaluatorUUID, 'evalGameStats', 'summary');
    const statsPatch = {
      classCode,
      strategyAttempts: increment(1),
      strategyHits: increment(strategyMatch ? 1 : 0),
      completionAttempts: increment(aiMatch.hasChecksAxis ? 1 : 0),
      completionHits: increment(earnedCheckReward ? 1 : 0),
      lastEvaluatedAt: serverTimestamp(),
    };
    if (evaluatorIsPeerJudge) {
      statsPatch.judgeEvalAttempts = increment(1);
      statsPatch.judgeEvalStrategyHits = increment(strategyMatch ? 1 : 0);
      statsPatch.judgeEvalCompletionHits = increment(earnedCheckReward ? 1 : 0);
      statsPatch.judgeEvalFullHits = increment(aiMatch.aiFullMatch ? 1 : 0);
      statsPatch.judgeAiMatchPendingCount = increment(judgeAiMatchPending ? 1 : 0);
    }
    try {
      await setDoc(statsRef, statsPatch, { merge: true });
    } catch (e) {
      console.warn('[submitVariantPeerEvaluation] evalGameStats', e?.code, e?.message);
    }

    if (strategyMatch) {
      await awardExplorationPoints(evaluatorUUID, {
        eventId: `peer_strategy_${problemId}`,
        kind: EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY,
        points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY],
        classCode,
        problemId,
        awardDate: new Date(),
        unitKey,
      });
      if (resolvedUnitKey) {
        await recordUnitPeerEvalSuccess(evaluatorUUID, resolvedUnitKey, creatorStrategyId)
          .catch((e) => console.warn('[submitVariantPeerEvaluation] unit peer eval', e));
      }
    }
    if (earnedCheckReward) {
      await awardExplorationPoints(evaluatorUUID, {
        eventId: `peer_completion_${problemId}`,
        kind: EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION,
        points: peerCheckRewardPoints,
        classCode,
        problemId,
        awardDate: new Date(),
        unitKey,
      });
    }
  }

  return {
    evalId,
    strategyMatch,
    completionMatch,
    checksMatch,
    checkRows: aiMatch.checkRows,
    checkHitCount: aiMatch.checkHitCount,
    hasChecksAxis: aiMatch.hasChecksAxis,
    peerCheckRewardPoints,
    aiCompletionLevel,
    aiFullMatch: aiMatch.aiFullMatch,
    evaluatorIsPeerJudge,
    judgeAiMatchPending,
  };
}

function attemptTimestamp(row) {
  return row.attemptedAt?.toMillis?.() || row.evaluatedAt?.toMillis?.() || 0;
}

/** 문제별 최신 풀이 시도만 남김 */
function latestSolveAttemptPerProblem(rows) {
  const byProblem = new Map();
  for (const row of rows) {
    if (row.recordType !== 'solve_attempt') continue;
    const key = row.problemId;
    if (!key) continue;
    const prev = byProblem.get(key);
    if (!prev || attemptTimestamp(row) >= attemptTimestamp(prev)) {
      byProblem.set(key, row);
    }
  }
  return [...byProblem.values()].sort((a, b) => attemptTimestamp(b) - attemptTimestamp(a));
}

/**
 * 학생의 학급 문제 풀이 기록 (문제별 최신 시도)
 * @param {string} evaluatorUUID
 * @param {string} classCode
 * @param {number} [maxItems]
 */
export async function getStudentClassSolveAttempts(evaluatorUUID, classCode, maxItems = 200) {
  if (!evaluatorUUID || !classCode) return [];

  const q = query(
    collection(db, 'variantEvaluations'),
    where('evaluatorUUID', '==', evaluatorUUID),
    limit(maxItems),
  );
  const snap = await getDocs(q);
  const rows = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.classCode === classCode && r.recordType === 'solve_attempt');

  return latestSolveAttemptPerProblem(rows);
}

/**
 * 학생의 학급 문제별 풀이·동료 평가 상태 (문제별 최신 건)
 * @param {string} evaluatorUUID
 * @param {string} classCode
 * @param {number} [maxItems]
 * @returns {Promise<Map<string, { solve: object|null, peer: object|null }>>}
 */
export async function getStudentClassProblemStatuses(evaluatorUUID, classCode, maxItems = 200) {
  const result = new Map();
  const normClass = normalizeClassCode(classCode);
  if (!evaluatorUUID || !normClass) return result;

  const q = query(
    collection(db, 'variantEvaluations'),
    where('evaluatorUUID', '==', evaluatorUUID),
    limit(maxItems),
  );
  const snap = await getDocs(q);
  for (const d of snap.docs) {
    const row = { id: d.id, ...d.data() };
    if (normalizeClassCode(row.classCode) !== normClass) continue;
    if (row.recordType !== 'solve_attempt' && row.recordType !== 'peer_evaluation') continue;
    const pid = row.problemId;
    if (!pid) continue;

    if (!result.has(pid)) result.set(pid, { solve: null, peer: null });
    const entry = result.get(pid);
    if (row.recordType === 'solve_attempt') {
      if (!entry.solve || attemptTimestamp(row) >= attemptTimestamp(entry.solve)) {
        entry.solve = row;
      }
    } else if (!entry.peer || attemptTimestamp(row) >= attemptTimestamp(entry.peer)) {
      entry.peer = row;
    }
  }
  return result;
}

/**
 * 한 문제에 대한 학생 풀이·동료 평가 최신 기록
 * @param {string} evaluatorUUID
 * @param {string} classCode
 * @param {string} problemId
 */
export async function getStudentClassProblemProgress(evaluatorUUID, classCode, problemId) {
  const normClass = normalizeClassCode(classCode);
  if (!evaluatorUUID || !normClass || !problemId) {
    return { solve: null, peer: null };
  }

  // Firestore 규칙: 학생은 evaluatorUUID가 본인인 variantEvaluations만 읽을 수 있음.
  // classCode+problemId로 전체 조회하면 다른 학생 기록이 섞여 쿼리가 거부됨.
  const q = query(
    collection(db, 'variantEvaluations'),
    where('evaluatorUUID', '==', evaluatorUUID),
    limit(200),
  );
  const snap = await getDocs(q);
  let solve = null;
  let peer = null;
  for (const d of snap.docs) {
    const row = { id: d.id, ...d.data() };
    if (normalizeClassCode(row.classCode) !== normClass || row.problemId !== problemId) continue;
    if (row.recordType === 'solve_attempt') {
      if (!solve || attemptTimestamp(row) >= attemptTimestamp(solve)) solve = row;
    } else if (row.recordType === 'peer_evaluation') {
      if (!peer || attemptTimestamp(row) >= attemptTimestamp(peer)) peer = row;
    }
  }
  return { solve, peer };
}

/**
 * 학급 전체 학생 풀이 통계 (문제별 최신 시도 기준)
 * @param {string} classCode
 * @param {number} [maxItems]
 * @returns {Promise<Array<{ uuid: string, total: number, correct: number, attempts: object[] }>>}
 */
export async function getClassSolveStatsByStudent(classCode, maxItems = 500) {
  if (!classCode) return [];

  const q = query(
    collection(db, 'variantEvaluations'),
    where('classCode', '==', classCode),
    limit(maxItems),
  );
  const snap = await getDocs(q);
  const solveRows = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.recordType === 'solve_attempt');

  const latestByStudentProblem = new Map();
  for (const row of solveRows) {
    const sid = row.evaluatorUUID;
    const pid = row.problemId;
    if (!sid || !pid) continue;
    const key = `${sid}::${pid}`;
    const prev = latestByStudentProblem.get(key);
    if (!prev || attemptTimestamp(row) >= attemptTimestamp(prev)) {
      latestByStudentProblem.set(key, row);
    }
  }

  const byStudent = new Map();
  for (const row of latestByStudentProblem.values()) {
    const sid = row.evaluatorUUID;
    if (!byStudent.has(sid)) {
      byStudent.set(sid, { uuid: sid, total: 0, correct: 0, attempts: [] });
    }
    const agg = byStudent.get(sid);
    agg.total += 1;
    if (row.solvedCorrect) agg.correct += 1;
    agg.attempts.push(row);
  }

  return [...byStudent.values()].map((row) => ({
    ...row,
    attempts: row.attempts.sort((a, b) => attemptTimestamp(b) - attemptTimestamp(a)),
  }));
}

/**
 * 개발용 — 학생 본인 풀이·동료평가 기록을 삭제해 처음부터 다시 풀 수 있게 함
 * @param {string} evaluatorUUID
 * @param {string} classCode
 * @param {string} problemId
 */
export async function devRevertStudentClassProblemProgress(evaluatorUUID, classCode, problemId) {
  if (!evaluatorUUID || !classCode || !problemId) {
    throw new Error('uuid, classCode, problemId가 필요합니다.');
  }

  const { solve, peer } = await getStudentClassProblemProgress(evaluatorUUID, classCode, problemId);

  const q = query(
    collection(db, 'variantEvaluations'),
    where('evaluatorUUID', '==', evaluatorUUID),
    limit(200),
  );
  const snap = await getDocs(q);
  const evalIds = snap.docs
    .filter((d) => {
      const row = d.data();
      return row.classCode === classCode
        && row.problemId === problemId
        && (row.recordType === 'solve_attempt' || row.recordType === 'peer_evaluation');
    })
    .map((d) => d.id);

  if (!evalIds.length && !solve && !peer) {
    return { deletedEvals: 0, hadPeer: false };
  }

  const batch = writeBatch(db);
  evalIds.forEach((id) => {
    batch.delete(doc(db, 'variantEvaluations', id));
  });
  await batch.commit();

  if (peer) {
    try {
      await updateDoc(doc(db, 'classes', classCode, 'problemBank', problemId), {
        evalCount: increment(-1),
        updatedAt: serverTimestamp(),
      });
    } catch (e) {
      console.warn('[devRevert] evalCount decrement', e?.code, e?.message);
    }

    try {
      const statsRef = doc(db, 'students', evaluatorUUID, 'evalGameStats', 'summary');
      const statsPatch = {
        strategyAttempts: increment(-1),
        strategyHits: increment(peer.strategyMatch ? -1 : 0),
        completionAttempts: increment(peer.hasChecksAxis ? -1 : 0),
        completionHits: increment(
          (peer.hasChecksAxis && Number(peer.peerCheckRewardPoints || peer.checkHitCount || 0) > 0)
            ? -1
            : 0,
        ),
      };
      if (peer.evaluatorIsPeerJudge) {
        const earnedCheckReward = peer.hasChecksAxis
          && (Number(peer.peerCheckRewardPoints) > 0
            || Number(peer.checkHitCount) > 0);
        const aiMatch = computePeerEvalAiMatch({
          strategyMatch: !!peer.strategyMatch,
          peerChecks: peer.peerChecks,
          aiChecks: peer.aiChecks,
          aiCompletionLevel: peer.aiCompletionLevel,
        });
        statsPatch.judgeEvalAttempts = increment(-1);
        statsPatch.judgeEvalStrategyHits = increment(peer.strategyMatch ? -1 : 0);
        statsPatch.judgeEvalCompletionHits = increment(earnedCheckReward ? -1 : 0);
        statsPatch.judgeEvalFullHits = increment(aiMatch.aiFullMatch ? -1 : 0);
        statsPatch.judgeAiMatchPendingCount = increment(peer.judgeAiMatchPending ? -1 : 0);
      }
      await setDoc(statsRef, statsPatch, { merge: true });
    } catch (e) {
      console.warn('[devRevert] evalGameStats', e?.code, e?.message);
    }
  }

  const rewardEventIds = [
    `solve_${problemId}`,
    `peer_strategy_${problemId}`,
    `peer_completion_${problemId}`,
  ];
  await Promise.all(
    rewardEventIds.map((eventId) => revokeExplorationReward(evaluatorUUID, eventId)),
  );

  return { deletedEvals: evalIds.length, hadPeer: !!peer };
}

/**
 * @param {string} classCode
 * @param {string} problemId
 */
export async function getEvaluationsForProblem(classCode, problemId) {
  const q = query(
    collection(db, 'variantEvaluations'),
    where('classCode', '==', classCode),
    where('problemId', '==', problemId),
    limit(100),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * 학급 전체 variantEvaluations (교사 문제은행 통계용)
 * @param {string} classCode
 * @param {number} [maxItems]
 */
export async function getClassProblemEvaluations(classCode, maxItems = 2000) {
  if (!classCode) return [];

  const q = query(
    collection(db, 'variantEvaluations'),
    where('classCode', '==', classCode),
    limit(maxItems),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * 한 문제의 풀이·평가 기록을 학생별 최신 건으로 묶음
 * @param {Array<object>} evaluations
 */
export function aggregateProblemEvaluationRows(evaluations) {
  const solveByStudent = new Map();
  const peerByStudent = new Map();

  for (const row of evaluations || []) {
    const sid = row.evaluatorUUID;
    if (!sid) continue;
    if (row.recordType === 'solve_attempt') {
      const prev = solveByStudent.get(sid);
      if (!prev || attemptTimestamp(row) >= attemptTimestamp(prev)) {
        solveByStudent.set(sid, row);
      }
    } else if (row.recordType === 'peer_evaluation') {
      const prev = peerByStudent.get(sid);
      if (!prev || attemptTimestamp(row) >= attemptTimestamp(prev)) {
        peerByStudent.set(sid, row);
      }
    }
  }

  const studentIds = new Set([...solveByStudent.keys(), ...peerByStudent.keys()]);
  const studentRows = [...studentIds].map((uuid) => ({
    uuid,
    solve: solveByStudent.get(uuid) || null,
    peer: peerByStudent.get(uuid) || null,
  }));

  const solved = studentRows.filter((r) => r.solve);
  const correctCount = solved.filter((r) => r.solve.solvedCorrect).length;
  const evalCount = studentRows.filter((r) => r.peer).length;
  const pendingEvalCount = studentRows.filter((r) => r.solve && !r.peer).length;
  const unsolvableCount = studentRows.filter(
    (r) => r.peer?.guessedCompletionLevel === 'unsolvable',
  ).length;
  const comments = studentRows
    .filter((r) => String(r.peer?.problemThought || '').trim())
    .map((r) => ({
      uuid: r.uuid,
      thought: String(r.peer.problemThought).trim(),
      completionLevel: r.peer.guessedCompletionLevel || '',
      evaluatedAt: r.peer.evaluatedAt || null,
    }))
    .sort((a, b) => {
      const ta = a.evaluatedAt?.toMillis?.() || 0;
      const tb = b.evaluatedAt?.toMillis?.() || 0;
      return tb - ta;
    });

  return {
    studentRows,
    stats: {
      solveCount: solved.length,
      correctCount,
      evalCount,
      pendingEvalCount,
      unsolvableCount,
      commentCount: comments.length,
    },
    comments,
  };
}

/**
 * @param {string} evaluatorUUID
 */
export async function getEvaluatorGameStats(evaluatorUUID) {
  const snap = await getDoc(doc(db, 'students', evaluatorUUID, 'evalGameStats', 'summary'));
  if (!snap.exists()) {
    return {
      strategyAttempts: 0,
      strategyHits: 0,
      completionAttempts: 0,
      completionHits: 0,
      judgeEvalAttempts: 0,
      judgeEvalStrategyHits: 0,
      judgeEvalCompletionHits: 0,
      judgeEvalFullHits: 0,
      judgeAiMatchPendingCount: 0,
    };
  }
  const d = snap.data();
  return {
    strategyAttempts: d.strategyAttempts || 0,
    strategyHits: d.strategyHits || 0,
    completionAttempts: d.completionAttempts || 0,
    completionHits: d.completionHits || 0,
    judgeEvalAttempts: d.judgeEvalAttempts || 0,
    judgeEvalStrategyHits: d.judgeEvalStrategyHits || 0,
    judgeEvalCompletionHits: d.judgeEvalCompletionHits || 0,
    judgeEvalFullHits: d.judgeEvalFullHits || 0,
    judgeAiMatchPendingCount: d.judgeAiMatchPendingCount || 0,
  };
}
