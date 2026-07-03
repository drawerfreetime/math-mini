/**
 * 학생 AI 피드백 유틸리티
 */

export function sanitizeAiFeedbackForStudent(_feedback, _opts) { return ''; }
export function sanitizeAiHintsForStudent(_hints) { return []; }
export function getItemReviewStatus(_item) { return null; }
export function isTeacherReviewResolved(_status) { return false; }
export function isTeacherReviewConfirmed(_item) { return false; }
export function isStudentAiReviewPending(_item) { return false; }
export function getStudentVisibleTeacherComment(_item) { return ''; }
export function getStudentVisibleAiNote(_item) { return ''; }
export function mergeVariantReviewIntoProblemBankItem(_bankItem, _variantReview) { return _bankItem; }
export function problemBankNeedsAiBackfill(_bankItem, _merged) { return false; }
export function pickProblemBankAiBackfillPatch(_merged) { return null; }
export function hasStudentVisibleAiFeedback(_item) { return false; }
export function studentAiFeedbackBoxClass(_item) { return ''; }
