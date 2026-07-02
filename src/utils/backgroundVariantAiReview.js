/**
 * 변형 문제 — 백그라운드 AI 검수 (등록을 막지 않음)
 * 뱃지·단원 승인 집계는 최종 승인 시에만 반영 (AI 통과만으로 증가하지 않음)
 */
import { doc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { getFirebaseDb } from '../firebase/config';
import { reviewStudentVariant } from './reviewStudentVariant';
import {
  updateClassProblemAiReview,
} from '../firebase/classProblemBankOps';
import {
  resolveVariantReviewIdsForClassProblem,
  applyAiReviewToVariantReviewDocs,
} from './variantReviewAiSync';
import { deriveCompletionLevelFromAiReview } from './deriveCompletionLevel';
import {
  SUBMISSION_STATUS_PEER_REVIEW,
  SUBMISSION_STATUS_REGISTERED,
  TEACHER_RESOLVED_SUBMISSION_STATUSES,
} from '../constants/aiSubmissionPolicy';

/**
 * @param {object} p
 */
export async function runBackgroundVariantAiReview(p) {
  const db = getFirebaseDb();
  if (!db) return null;
  const {
    classCode,
    problemId,
    reviewId,
    studentUUID,
    bankDocId,
    anonPayload,
    teacherGeminiKey,
  } = p;

  try {
    const review = await reviewStudentVariant({
      ...anonPayload,
      teacherGeminiKey,
    });

    const completionLevel = deriveCompletionLevelFromAiReview(review);
    const nextStatus = review.peerReview ? SUBMISSION_STATUS_PEER_REVIEW : SUBMISSION_STATUS_REGISTERED;

    if (classCode && problemId) {
      await updateClassProblemAiReview(classCode, problemId, {
        ...review,
        completionLevel,
      });
    }

    const linkedReviewIds = await resolveVariantReviewIdsForClassProblem(
      classCode,
      problemId,
      reviewId,
      studentUUID,
    );
    if (linkedReviewIds.length > 0) {
      await applyAiReviewToVariantReviewDocs(linkedReviewIds, {
        ...review,
        completionLevel,
      });
    }

    if (studentUUID && bankDocId) {
      const bankRef = doc(db, 'students', studentUUID, 'problemBank', bankDocId);
      const bankSnap = await getDoc(bankRef).catch(() => null);
      const bankData = bankSnap?.exists() ? bankSnap.data() : null;
      const teacherResolved = TEACHER_RESOLVED_SUBMISSION_STATUSES.includes(
        bankData?.teacherReviewStatus,
      );

      const bankPatch = {
        aiNote: review.feedback || '',
        aiMode: review.aiMode || '',
        aiApproved: !!review.approved,
        aiChecks: review.checks || null,
        aiCompletionLevel: completionLevel,
        aiReviewStatus: 'done',
      };
      if (!teacherResolved) {
        bankPatch.status = nextStatus;
      }

      await updateDoc(bankRef, bankPatch);
    }

    return review;
  } catch (e) {
    console.error('[backgroundVariantAiReview]', e);
    const errorNote = 'AI 검수를 나중에 다시 시도할게요.';
    const errorPatch = {
      aiReviewStatus: 'error',
      aiNote: errorNote,
      updatedAt: serverTimestamp(),
    };

    if (classCode && problemId) {
      await updateDoc(doc(db, 'classes', classCode, 'problemBank', problemId), errorPatch).catch(() => {});
    }

    const linkedReviewIds = await resolveVariantReviewIdsForClassProblem(
      classCode,
      problemId,
      reviewId,
      studentUUID,
    ).catch(() => []);
    const reviewIds = [...new Set(
      [reviewId, ...(linkedReviewIds || [])].map((id) => String(id || '').trim()).filter(Boolean),
    )];
    for (const id of reviewIds) {
      // eslint-disable-next-line no-await-in-loop
      await updateDoc(doc(db, 'variantReviews', id), errorPatch).catch(() => {});
    }

    if (studentUUID && bankDocId) {
      await updateDoc(doc(db, 'students', studentUUID, 'problemBank', bankDocId), {
        aiReviewStatus: 'error',
        aiNote: errorNote,
      }).catch(() => {});
    }
    return null;
  }
}
