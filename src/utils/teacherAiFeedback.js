/**
 * 교사 AI 피드백 유틸리티
 */

export const VARIANT_TEACHER_MANUAL_CHECK_KEYS = ['answer_ok', 'solution_ok', 'strategy_match_ok'];
export const NEW_PROBLEM_TEACHER_MANUAL_CHECK_KEYS = ['goal_alignment_ok', 'answer_ok', 'solution_ok'];
export const UI_HIDDEN_AI_CHECK_KEYS = ['problem_solvable_ok'];

export const VARIANT_AI_CHECK_LABELS = {};

export function isNewProblemItem(_item) { return false; }
export function isAiReviewFallbackNote(_note) { return false; }
export function normalizeVariantQuestionForMatch(_text) { return ''; }
export function buildClassProblemReviewsPool(_inboxVariantReviews, _extraReviews) { return []; }
export function findClassProblemForVariantReview(_review, _problems) { return null; }
export function mergeVariantReviewWithClassProblemAi(_review, _problem) { return _review; }
export function enrichVariantReviewsWithClassProblemAi(_reviews, _problems) { return []; }
export function buildVariantReviewLookupMaps(_variantReviews) { return {}; }
export function mergeVariantReviewLookupMaps(..._lookups) { return {}; }
export function variantReviewMatchesProblem(_problem, _vr) { return false; }
export function collectVariantReviewCandidatesForProblem(_problem, _lookup, _allReviews) { return []; }
export function pickPreferredVariantReview(_candidates) { return null; }
export function resolveVariantReviewForProblem(_problem, _lookup, _allReviews) { return null; }
export function findBestVariantReviewForClassProblem(_problem, _pool) { return null; }
export function resolveClassProblemAiDisplay(_problem, _inboxVariantReviews, _extraReviews) { return null; }
export function diagnoseClassProblemAiLink(_problem, _inboxVariantReviews, _extraReviews) { return null; }
export function mergeProblemWithVariantReviewAi(_problem, _lookup, _allReviews) { return _problem; }
export function buildVariantReviewByIdMap(_variantReviews) { return {}; }
export function aiFeedbackBoxClass(_aiApproved, _checks) { return ''; }
export function isSolutionOnlyCheckFailure(_checks) { return false; }
export function formatAiCompletionLabel(_levelId) { return ''; }
export function formatAiModeLabel(_mode) { return ''; }
export function isAiReviewPending(_aiReviewStatus, _item) { return false; }
export function hasStoredAiCheckBooleans(_row) { return false; }
export function isAiReviewResultIncomplete(_row) { return false; }
export function listAiCheckRows(_checks) { return []; }
export function resolveTeacherManualCheckKeys(_item) { return []; }
export function listVisibleAiCheckRows(_checks, _item) { return []; }
export function listStudentWrongNoteCheckRows(_checks, _item) { return []; }
export function ensureTeacherManualChecks(_checks, _requiredKeys, _opts) { return _checks ?? {}; }
export function listTeacherReviewCheckRows(_checks, _requiredKeys, _opts) { return []; }
export function cloneAiChecks(_checks) { return {}; }
export function deriveAiApprovedFromChecks(_checks, _item) { return null; }
export function isWrongNoteReviewItem(_item) { return false; }
export function teacherChecksMatchBaseline(_checks, _baselineChecks) { return false; }
export function syncTeacherFeedbackNote(_p) { return _p; }
export function deriveTeacherFeedbackNoteFromChecks(_checks, _item) { return ''; }
export function finalizeTeacherFeedbackDraft(_item, _draft) { return _draft; }
export function buildTeacherReviewFeedbackDraft(_item) { return {}; }
export function deriveReviewStatusFromChecks(_checks, _approvedStatus, _rejectedStatus, _item) { return null; }
export function deriveVariantReviewStatusFromChecks(_checks, _item) { return null; }
export function hasVisibleAiFeedback(_item) { return false; }
export function formatAiFeedbackForReport(_item) { return ''; }
