/**
 * 문제 만들기 역량 — 제출 이벤트·문항별 집계 (Firestore)
 *
 * students/{uuid}/makingEvents/{autoId}   — append
 * students/{uuid}/makingProblems/{problemKey} — 문항별 롤업
 */
import {
  doc, getDoc, setDoc, updateDoc, addDoc, getDocs,
  collection, increment,
} from 'firebase/firestore';
import { db } from './config';
import {
  MAKING_OUTCOME,
  MAKING_SUCCESS_PATH,
  MAKING_EVENT_TYPE,
} from '../constants/problemMakingCompetency';
import {
  buildVariantProblemKey,
  buildNewProblemKey,
  computeProblemMakingCompetency,
} from '../utils/computeProblemMakingCompetency';
import {
  SUBMISSION_STATUS_APPROVED,
  SUBMISSION_STATUS_PEER_REVIEW,
  SUBMISSION_STATUS_REJECTED,
} from '../constants/aiSubmissionPolicy';
import { countMakingSubmitsByKind } from '../utils/makingSubmitCounts';

export { buildVariantProblemKey, buildNewProblemKey };

function problemRef(uuid, problemKey) {
  return doc(db, 'students', uuid, 'makingProblems', problemKey);
}

function eventsCol(uuid) {
  return collection(db, 'students', uuid, 'makingEvents');
}

/**
 * @param {string} uuid
 * @param {string} problemKey
 * @param {{
 *   kind: 'variant'|'new';
 *   examId?: string | null;
 *   questionNumber?: number | null;
 *   bankDocId?: string | null;
 *   reviewId?: string | null;
 *   classCode?: string;
 * }} meta
 */
export async function ensureMakingProblemSession(uuid, problemKey, meta) {
  if (!uuid || !problemKey) return;
  const ref = problemRef(uuid, problemKey);
  const snap = await getDoc(ref);
  const now = new Date().toISOString();

  if (!snap.exists()) {
    await setDoc(ref, {
      problemKey,
      kind: meta.kind,
      examId: meta.examId ?? null,
      questionNumber: meta.questionNumber ?? null,
      bankDocId: meta.bankDocId ?? null,
      reviewId: meta.reviewId ?? null,
      classCode: meta.classCode ?? '',
      strategyId: null,
      firstStartedAt: now,
      lastSubmittedAt: null,
      submitCount: 0,
      succeeded: false,
      successAt: null,
      successPath: null,
      submitCountAtSuccess: null,
      updatedAt: now,
    });
    await addDoc(eventsCol(uuid), {
      eventType: MAKING_EVENT_TYPE.SESSION_START,
      problemKey,
      outcome: null,
      kind: meta.kind,
      createdAt: now,
    });
    return;
  }

  const patch = { updatedAt: now };
  if (meta.reviewId && !snap.data().reviewId) patch.reviewId = meta.reviewId;
  if (meta.bankDocId && !snap.data().bankDocId) patch.bankDocId = meta.bankDocId;
  await updateDoc(ref, patch);
}

/**
 * @param {string} uuid
 * @param {string} problemKey
 * @param {string|null} strategyId
 */
export async function updateMakingProblemStrategy(uuid, problemKey, strategyId) {
  if (!uuid || !problemKey || !strategyId) return;
  const ref = problemRef(uuid, problemKey);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  await updateDoc(ref, { strategyId, updatedAt: new Date().toISOString() });
}

/**
 * AI 거절·연구용 — 학생이 제출한 전문(문제·풀이·정답 등)
 * @param {object} fields
 */
export function buildMakingSubmissionPayload(fields = {}) {
  const trimOrNull = (v) => {
    if (v == null) return null;
    const s = typeof v === 'string' ? v.trim() : String(v).trim();
    return s || null;
  };
  return {
    question: trimOrNull(fields.question) ?? '',
    bogi: trimOrNull(fields.bogi),
    choices: Array.isArray(fields.choices) ? fields.choices : null,
    solutionProcess: trimOrNull(fields.solutionProcess),
    answer: fields.answer != null ? String(fields.answer).trim() : '',
    examId: fields.examId ?? null,
    questionNumber: fields.questionNumber ?? null,
    variantStrategyId: fields.variantStrategyId ?? null,
    variantStrategyName: fields.variantStrategyName ?? null,
  };
}

/** @param {object} review — reviewStudentVariant / API 응답 */
export function buildMakingAiReviewPayload(review = {}) {
  return {
    approved: !!review.approved,
    feedback: review.feedback || '',
    hints: Array.isArray(review.hints) ? review.hints : [],
    checks: review.checks ?? null,
    aiMode: review.aiMode || '',
    peerReview: !!review.peerReview,
  };
}

/**
 * @param {string} uuid
 * @param {string} problemKey
 * @param {string} outcome — MAKING_OUTCOME.*
 * @param {{
 *   strategyId?: string;
 *   reviewId?: string;
 *   checks?: object;
 *   submission?: object;
 *   aiReview?: object;
 * }} [extra]
 */
export async function logMakingSubmit(uuid, problemKey, outcome, extra = {}) {
  if (!uuid || !problemKey) return { submitCount: 0 };

  const ref = problemRef(uuid, problemKey);
  const snap = await getDoc(ref);
  const now = new Date().toISOString();

  if (!snap.exists()) {
    await ensureMakingProblemSession(uuid, problemKey, {
      kind: problemKey.startsWith('n_') ? 'new' : 'variant',
      examId: extra.examId ?? null,
      questionNumber: extra.questionNumber ?? null,
      bankDocId: extra.bankDocId ?? null,
      reviewId: extra.reviewId ?? null,
      classCode: extra.classCode ?? '',
    });
  }

  const existing = snap.exists() ? snap.data() : null;
  const patch = {
    lastSubmittedAt: now,
    submitCount: increment(1),
    updatedAt: now,
  };
  if (!existing?.firstSubmittedAt) patch.firstSubmittedAt = now;
  if (extra.strategyId) patch.strategyId = extra.strategyId;

  await updateDoc(ref, patch);

  await addDoc(eventsCol(uuid), {
    eventType: MAKING_EVENT_TYPE.SUBMIT,
    problemKey,
    outcome,
    strategyId: extra.strategyId ?? null,
    reviewId: extra.reviewId ?? null,
    checks: extra.checks ?? null,
    ...(extra.submission ? { submission: extra.submission } : {}),
    ...(extra.aiReview ? { aiReview: extra.aiReview } : {}),
    createdAt: now,
  });

  const after = await getDoc(ref);
  return { submitCount: after.data()?.submitCount ?? 1 };
}

/**
 * 최종 성공 — 교사 승인 또는 동료 승인 완료 시 1회
 *
 * @param {'teacher'|'peer'} successPath
 */
export async function markProblemMakingSuccess(uuid, problemKey, successPath, extra = {}) {
  if (!uuid || !problemKey) return;

  const ref = problemRef(uuid, problemKey);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;

  const d = snap.data();
  if (d.succeeded) return;

  const now = new Date().toISOString();
  const submitCountAtSuccess = Number(d.submitCount) || 1;
  const outcome =
    successPath === MAKING_SUCCESS_PATH.PEER
      ? MAKING_OUTCOME.SUCCESS_PEER
      : MAKING_OUTCOME.SUCCESS_TEACHER;

  await updateDoc(ref, {
    succeeded: true,
    successAt: now,
    successPath,
    submitCountAtSuccess,
    updatedAt: now,
    ...(extra.strategyId ? { strategyId: extra.strategyId } : {}),
  });

  await addDoc(eventsCol(uuid), {
    eventType: MAKING_EVENT_TYPE.SUCCESS,
    problemKey,
    outcome,
    successPath,
    submitCountAtSuccess,
    strategyId: extra.strategyId ?? d.strategyId ?? null,
    ...(extra.teacherComment != null ? { teacherComment: extra.teacherComment } : {}),
    createdAt: now,
  });
}

/** @param {string} uuid */
export async function getMakingProblemsForStudent(uuid) {
  if (!uuid) return [];
  const snap = await getDocs(collection(db, 'students', uuid, 'makingProblems'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * 학급 학생별 문제 만들기 제출 수 (완성도·승인 여부 무관, 제출 1회 이상)
 *
 * @param {string[]} studentUuids
 * @returns {Promise<Array<{ uuid: string; variant: { today: number; total: number }; new: { today: number; total: number } }>>}
 */
export async function getClassMakingSubmitStats(studentUuids) {
  const rows = await Promise.all(
    (studentUuids || []).map(async (uuid) => {
      const problems = await getMakingProblemsForStudent(uuid);
      const counts = countMakingSubmitsByKind(problems);
      return { uuid, ...counts };
    }),
  );
  return rows;
}

/**
 * @param {string} classCode
 * @param {string[]} studentUuids
 */
export async function getClassMakingCompetency(classCode, studentUuids) {
  const rows = await Promise.all(
    (studentUuids || []).map(async (uuid) => {
      const problems = await getMakingProblemsForStudent(uuid);
      const competency = computeProblemMakingCompetency(problems);
      return { uuid, classCode, problems, competency };
    })
  );
  return rows;
}

/**
 * variantReviews 승인/반려 시 역량 집계 연동
 *
 * @param {object} review — variantReviews 문서 필드
 * @param {'approved'|'rejected'} newStatus
 */
/**
 * 새 문제(problemBank) 교사 승인 시 역량 반영
 *
 * @param {string} uuid
 * @param {string} bankDocId
 * @param {'approved'|'rejected'} newStatus
 */
export async function syncMakingCompetencyFromProblemBank(uuid, bankDocId, newStatus, teacherComment = '') {
  if (!uuid || !bankDocId) return;
  const problemKey = buildNewProblemKey(bankDocId);
  if (newStatus === SUBMISSION_STATUS_APPROVED) {
    await markProblemMakingSuccess(uuid, problemKey, MAKING_SUCCESS_PATH.TEACHER, {
      teacherComment,
    });
    return;
  }
  if (newStatus === SUBMISSION_STATUS_REJECTED) {
    await addDoc(eventsCol(uuid), {
      eventType: MAKING_EVENT_TYPE.TEACHER_REJECT,
      problemKey,
      outcome: MAKING_OUTCOME.TEACHER_REJECT,
      teacherComment: teacherComment || '',
      createdAt: new Date().toISOString(),
    });
  }
}

export async function syncMakingCompetencyFromVariantReview(review, newStatus, teacherComment = '') {
  const studentUUID = review?.studentUUID;
  const examId = review?.examId;
  const questionNumber = review?.questionNumber;
  if (!studentUUID || examId == null || questionNumber == null) return;

  const problemKey = buildVariantProblemKey(examId, questionNumber);
  const strategyId = review?.variantStrategyId || null;

  if (newStatus === SUBMISSION_STATUS_APPROVED) {
    const path =
      review?.status === SUBMISSION_STATUS_PEER_REVIEW || review?.aiMode === 'peer_review'
        ? MAKING_SUCCESS_PATH.PEER
        : MAKING_SUCCESS_PATH.TEACHER;
    await markProblemMakingSuccess(studentUUID, problemKey, path, {
      strategyId,
      teacherComment,
      reviewId: review?.id || review?.reviewId || null,
      classCode: review?.classCode || '',
    });
    return;
  }

  if (newStatus === SUBMISSION_STATUS_REJECTED) {
    await addDoc(eventsCol(studentUUID), {
      eventType: MAKING_EVENT_TYPE.TEACHER_REJECT,
      problemKey,
      outcome: MAKING_OUTCOME.TEACHER_REJECT,
      teacherComment: teacherComment || '',
      strategyId: strategyId ?? null,
      createdAt: new Date().toISOString(),
    });
  }
}
