/**
 * 오답노트 역량 — 완료·완료율·AI 통과·4항목 통과율 (순수 계산)
 */
import { WRONG_NOTE_CHECK_KEYS } from '../constants/wrongNoteCompetency';
import { SUBMISSION_STATUS_APPROVED, SUBMISSION_STATUS_PENDING_REVIEW } from '../constants/aiSubmissionPolicy';

/**
 * @param {Array<{
 *   studentProblemCorrect?: Record<string, boolean>;
 *   noteDetails?: Record<string, {
 *     reason?: string;
 *     prevention?: string;
 *     solution?: string;
 *     answer?: string;
 *     submittedAt?: string;
 *     teacherStatus?: string;
 *     aiReview?: { approved?: boolean; checks?: Record<string, boolean> };
 *   }>;
 * }>} examNotes
 */
export function computeWrongNoteCompetency(examNotes) {
  let wrongTotal = 0;
  let withSubmission = 0;
  let approved = 0;
  let pending = 0;
  let aiSubmitted = 0;
  let aiApproved = 0;
  const checkStats = Object.fromEntries(
    WRONG_NOTE_CHECK_KEYS.map((k) => [k, { pass: 0, total: 0 }]),
  );

  for (const exam of examNotes || []) {
    const correctMap = exam.studentProblemCorrect;
    if (correctMap && typeof correctMap === 'object') {
      wrongTotal += Object.values(correctMap).filter((v) => v === false).length;
    }

    const details = exam.noteDetails;
    if (!details || typeof details !== 'object') continue;

    for (const detail of Object.values(details)) {
      if (!detail || typeof detail !== 'object') continue;

      const hasContent = [detail.reason, detail.prevention, detail.solution, detail.answer].some(
        (v) => String(v ?? '').trim(),
      );
      if (!hasContent && !detail.submittedAt) continue;

      if (detail.submittedAt) withSubmission += 1;
      if (detail.teacherStatus === SUBMISSION_STATUS_APPROVED) approved += 1;
      else if (detail.teacherStatus === SUBMISSION_STATUS_PENDING_REVIEW) pending += 1;

      const ai = detail.aiReview;
      if (detail.submittedAt && ai && typeof ai === 'object') {
        aiSubmitted += 1;
        if (ai.approved) aiApproved += 1;
        const checks = ai.checks;
        if (checks && typeof checks === 'object') {
          for (const ck of WRONG_NOTE_CHECK_KEYS) {
            if (typeof checks[ck] === 'boolean') {
              checkStats[ck].total += 1;
              if (checks[ck]) checkStats[ck].pass += 1;
            }
          }
        }
      }
    }
  }

  const completionDenominator = wrongTotal > 0 ? wrongTotal : withSubmission;
  const completionRate =
    completionDenominator > 0
      ? Math.round((approved / completionDenominator) * 1000) / 1000
      : null;

  const aiPassRate =
    aiSubmitted > 0 ? Math.round((aiApproved / aiSubmitted) * 1000) / 1000 : null;

  const checks = {};
  for (const ck of WRONG_NOTE_CHECK_KEYS) {
    const { pass, total } = checkStats[ck];
    checks[ck] = total > 0 ? Math.round((pass / total) * 1000) / 1000 : null;
  }

  return {
    fluency: approved,
    wrongTotal,
    withSubmission,
    pending,
    completionRate,
    aiPassRate,
    checks,
    meta: {
      examCount: (examNotes || []).length,
      aiSubmitted,
    },
  };
}
