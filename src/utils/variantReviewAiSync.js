import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  limit,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import {
  SUBMISSION_STATUS_REGISTERED,
  SUBMISSION_STATUS_PEER_REVIEW,
  TEACHER_RESOLVED_SUBMISSION_STATUSES,
} from '../constants/aiSubmissionPolicy';
import { buildVariantReviewId, inferClassProblemReviewIds } from './variantBankIds';
import { deriveCompletionLevelFromAiReview } from './deriveCompletionLevel';

/**
 * 학급 problemBank 행과 연결된 variantReviews 문서 ID 후보를 모읍니다.
 * @param {string} classCode
 * @param {string} problemId
 * @param {string} [reviewId]
 * @param {string} [studentUUID]
 * @returns {Promise<string[]>}
 */
export async function resolveVariantReviewIdsForClassProblem(
  classCode,
  problemId,
  reviewId = '',
  studentUUID = '',
) {
  const ids = new Set();
  const rid = String(reviewId || '').trim();
  if (rid) ids.add(rid);

  let row = null;
  if (classCode && problemId) {
    try {
      const snap = await getDoc(doc(db, 'classes', classCode, 'problemBank', problemId));
      if (snap.exists()) {
        row = { id: problemId, ...snap.data() };
        for (const candidate of inferClassProblemReviewIds(row)) ids.add(candidate);
      }
    } catch {
      /* ignore */
    }
  }

  const cpid = String(problemId || '').trim();
  if (cpid) {
    try {
      const q = await getDocs(query(
        collection(db, 'variantReviews'),
        where('classProblemId', '==', cpid),
        limit(20),
      ));
      q.docs.forEach((d) => ids.add(d.id));
    } catch {
      /* ignore */
    }
  }

  const uuid = String(studentUUID || row?.createdBy || '').trim();
  if (uuid && cpid) {
    try {
      const bankSnap = await getDocs(query(
        collection(db, 'students', uuid, 'problemBank'),
        where('classProblemId', '==', cpid),
        limit(5),
      ));
      for (const d of bankSnap.docs) {
        ids.add(buildVariantReviewId(uuid, d.id));
        const bankReviewId = String(d.data()?.reviewId || '').trim();
        if (bankReviewId) ids.add(bankReviewId);
      }
    } catch {
      /* ignore */
    }
  }

  return [...ids];
}

/**
 * AI 검수 결과를 연결된 variantReviews 문서에 반영합니다.
 * @param {string[]} reviewIds
 * @param {object} review
 * @returns {Promise<number>}
 */
export async function applyAiReviewToVariantReviewDocs(reviewIds, review) {
  const ids = [...new Set(
    (reviewIds || []).map((id) => String(id || '').trim()).filter(Boolean),
  )];
  if (ids.length === 0) return 0;

  const feedback = String(review.feedback ?? review.aiNote ?? '').trim();
  const approved = review.approved ?? review.aiApproved;
  const aiMode = String(review.aiMode || '').trim();
  const checks = review.checks ?? review.aiChecks ?? null;
  const completionLevel = review.completionLevel
    ?? review.aiCompletionLevel
    ?? deriveCompletionLevelFromAiReview(review);
  const peerReview = !!review.peerReview || aiMode === 'peer_review';
  const nextStatus = peerReview ? SUBMISSION_STATUS_PEER_REVIEW : SUBMISSION_STATUS_REGISTERED;

  let updated = 0;
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await getDoc(doc(db, 'variantReviews', id)).catch(() => null);
    const existing = snap?.exists() ? snap.data() : null;
    const resolvedStatus = existing?.teacherReviewStatus || existing?.status;
    const teacherResolved = TEACHER_RESOLVED_SUBMISSION_STATUSES.includes(resolvedStatus);

    const patch = {
      aiNote: feedback,
      aiMode,
      aiApproved: !!approved,
      aiChecks: checks,
      aiCompletionLevel: completionLevel,
      aiReviewStatus: 'done',
      updatedAt: serverTimestamp(),
    };
    if (!teacherResolved) {
      patch.status = nextStatus;
      if (peerReview) {
        patch.peerApprovals = [];
        patch.peerApprovalRequired = 2;
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await updateDoc(doc(db, 'variantReviews', id), patch).catch((e) => {
      console.warn('[applyAiReviewToVariantReviewDocs]', id, e?.code);
    });
    updated += 1;
  }
  return updated;
}

/**
 * 학급 problemBank 라벨·연결 정보를 검수함(variantReviews)에 맞춥니다.
 * reconcileClassProblemLabels 로 은행 번호가 0624 문제14처럼 바뀌어도
 * 검수함에 0624 문제86 이 남는 현상을 줄입니다.
 *
 * @param {string} classCode
 * @param {string} problemId
 * @param {string} label
 * @param {string} [reviewId]
 * @param {string} [studentUUID]
 * @returns {Promise<number>}
 */
export async function syncClassProblemLabelToVariantReviews(
  classCode,
  problemId,
  label,
  reviewId = '',
  studentUUID = '',
) {
  const nextLabel = String(label || '').trim();
  const cpid = String(problemId || '').trim();
  if (!nextLabel || !cpid) return 0;

  const reviewIds = await resolveVariantReviewIdsForClassProblem(
    classCode,
    cpid,
    reviewId,
    studentUUID,
  );
  if (reviewIds.length === 0) return 0;

  let updated = 0;
  for (const id of reviewIds) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await getDoc(doc(db, 'variantReviews', id)).catch(() => null);
    if (!snap?.exists()) continue;
    const curLabel = String(snap.data()?.classProblemLabel || '').trim();
    const curCpid = String(snap.data()?.classProblemId || '').trim();
    if (curLabel === nextLabel && curCpid === cpid) continue;

    // eslint-disable-next-line no-await-in-loop
    await updateDoc(doc(db, 'variantReviews', id), {
      classProblemLabel: nextLabel,
      classProblemId: cpid,
      updatedAt: serverTimestamp(),
    }).catch((e) => {
      console.warn('[syncClassProblemLabelToVariantReviews]', id, e?.code);
    });
    updated += 1;
  }
  return updated;
}
