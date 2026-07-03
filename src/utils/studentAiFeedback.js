/**
 * 학생 화면용 AI 피드백 — 연구원·교사·가이드 작성용 문구는 노출하지 않는다.
 */
import { listVisibleAiCheckRows, isSolutionOnlyCheckFailure } from './teacherAiFeedback';
import {
  SUBMISSION_STATUS_APPROVED,
  SUBMISSION_STATUS_APPROVED_PARTIAL,
  SUBMISSION_STATUS_REGISTERED,
  SUBMISSION_STATUS_REJECTED,
} from '../constants/aiSubmissionPolicy';

const RESEARCHER_ONLY_PATTERNS = [
  /가이드에\s*든/i,
  /□\s*·\s*답\s*칸/i,
  /단서\s*\(/i,
  /goal_alignment/i,
  /research_ethics/i,
  /strategy_match/i,
  /problem_solvable/i,
  /전체\s*=\s*한\s*조각/i,
  /나누어떨어짐이\s*맞는지/i,
  /Cursor/i,
];

/** 교사·AI용 용어 → 초등 쉬운 말 (백엔드 sanitize_student_facing_text 와 동일) */
const TEACHER_JARGON_REPLACEMENTS = [
  [/이분모\s*분수/g, '분모가 다른 분수'],
  [/등분제/g, '똑같이 나누기'],
  [/포함제/g, '몇 개씩 묶어 나누기'],
  [/연속량/g, '길이·시간처럼 끊기지 않는 양'],
  [/이산량/g, '개수로 세는 양'],
  [/이분모/g, '분모가 다른'],
  [/동수누가/g, '같은 수를 여러 번 더하기'],
  [/분배법칙/g, '나누어서 곱하기'],
  [/교환법칙/g, '곱하는 순서 바꾸기'],
  [/피연산자/g, '계산에 쓰는 수'],
  [/피곱수/g, '곱해지는 수'],
  [/승수/g, '곱하는 수'],
  [/메커니즘/g, '하는 일'],
];

const STUDENT_REJECT_FALLBACK = '만든 문제를 한 번 더 확인해 볼까요? 식과 정답이 서로 맞는지 살펴봐 주세요.';
const STUDENT_APPROVE_FALLBACK = '잘 만든 문제예요!';

function replaceTeacherJargon(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  TEACHER_JARGON_REPLACEMENTS.forEach(([re, repl]) => {
    s = s.replace(re, repl);
  });
  return s.replace(/\s{2,}/g, ' ').trim();
}

/** "연구원님," 호칭만 제거하고 본문은 학생에게 그대로 전달 */
function stripResearcherGreeting(text) {
  return String(text || '')
    .replace(/^연구원님[,，]\s*/i, '')
    .trim();
}

function isResearcherOnlyFeedback(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  return RESEARCHER_ONLY_PATTERNS.some((re) => re.test(raw));
}

/**
 * @param {string} feedback
 * @param {{ approved?: boolean }} [opts]
 * @returns {string}
 */
export function sanitizeAiFeedbackForStudent(feedback, opts = {}) {
  let raw = replaceTeacherJargon(feedback);
  raw = stripResearcherGreeting(raw);
  if (!raw) return '';

  if (isResearcherOnlyFeedback(raw)) {
    return opts.approved ? STUDENT_APPROVE_FALLBACK : STUDENT_REJECT_FALLBACK;
  }

  return raw;
}

/**
 * @param {string[]} hints
 * @returns {string[]}
 */
export function sanitizeAiHintsForStudent(hints) {
  if (!Array.isArray(hints)) return [];
  return hints
    .map((h) => sanitizeAiFeedbackForStudent(h, { approved: false }))
    .filter((h, i, arr) => h && arr.indexOf(h) === i)
    .slice(0, 3);
}

/** @param {{ status?: string, teacherStatus?: string, teacherReviewStatus?: string }} item */
export function getItemReviewStatus(item) {
  const teacherReview = item?.teacherReviewStatus;
  if (teacherReview) return teacherReview;
  const status = item?.status ?? item?.teacherStatus ?? null;
  // 구버전: 학생 problemBank status에 rejected가 직접 저장된 경우
  if (status === SUBMISSION_STATUS_REJECTED) return SUBMISSION_STATUS_REJECTED;
  return status;
}

/** @param {string|null|undefined} status */
export function isTeacherReviewResolved(status) {
  return status === SUBMISSION_STATUS_APPROVED
    || status === SUBMISSION_STATUS_APPROVED_PARTIAL
    || status === SUBMISSION_STATUS_REJECTED;
}

/**
 * 학생 화면 "선생님 확인 완료" 표시 기준.
 * 학급 문제은행은 status가 registered(노출용)로 유지되므로 teacherReviewStatus를 우선합니다.
 * @param {{ status?: string, teacherReviewStatus?: string }} item
 */
export function isTeacherReviewConfirmed(item) {
  const teacherReview = item?.teacherReviewStatus;
  if (teacherReview === SUBMISSION_STATUS_APPROVED
    || teacherReview === SUBMISSION_STATUS_APPROVED_PARTIAL) {
    return true;
  }
  const status = item?.status;
  if (status === SUBMISSION_STATUS_REGISTERED) return false;
  return status === SUBMISSION_STATUS_APPROVED
    || status === SUBMISSION_STATUS_APPROVED_PARTIAL;
}

/** @param {{ status?: string, teacherStatus?: string, aiReviewStatus?: string }} item */
export function isStudentAiReviewPending(item) {
  if (!item?.aiReviewStatus || item.aiReviewStatus === 'done') return false;
  return !isTeacherReviewResolved(getItemReviewStatus(item));
}

/**
 * @param {{ status?: string, teacherStatus?: string, teacherComment?: string }} item
 * @returns {string}
 */
export function getStudentVisibleTeacherComment(item) {
  const status = getItemReviewStatus(item);
  if (!isTeacherReviewResolved(status)) return '';
  return String(item?.teacherComment ?? '').trim();
}

/**
 * @param {{ status?: string, teacherStatus?: string, aiNote?: string, aiApproved?: boolean|null }} item
 * @returns {string}
 */
export function getStudentVisibleAiNote(item) {
  const status = getItemReviewStatus(item);
  if (getStudentVisibleTeacherComment(item)) return '';

  const rawNote = String(item?.aiNote || '').trim();

  if (!rawNote) {
    if (status === SUBMISSION_STATUS_APPROVED) return STUDENT_APPROVE_FALLBACK;
    if (status === SUBMISSION_STATUS_APPROVED_PARTIAL) return '';
    if (status === SUBMISSION_STATUS_REJECTED) return STUDENT_REJECT_FALLBACK;
    return '';
  }

  const hideUntilApproval = process.env.REACT_APP_HIDE_AI_NOTE_UNTIL_TEACHER_APPROVAL === 'true';
  if (hideUntilApproval && !isTeacherReviewResolved(status)) return '';

  const approved = item.aiApproved === true || status === SUBMISSION_STATUS_APPROVED;
  return sanitizeAiFeedbackForStudent(item.aiNote, { approved });
}

/**
 * problemBank 행에 variantReviews AI·검수 필드를 보강합니다 (읽기 전용 병합).
 * @param {object} bankItem
 * @param {object|null|undefined} variantReview
 */
export function mergeVariantReviewIntoProblemBankItem(bankItem, variantReview) {
  if (!bankItem || !variantReview) return bankItem;

  const merged = { ...bankItem };
  const bankStatus = getItemReviewStatus(bankItem);
  const vrStatus = getItemReviewStatus(variantReview);

  if (isTeacherReviewResolved(vrStatus) && !isTeacherReviewResolved(bankStatus)) {
    merged.teacherReviewStatus = vrStatus;
    if (vrStatus === SUBMISSION_STATUS_APPROVED) {
      merged.status = SUBMISSION_STATUS_APPROVED;
    }
  } else if (variantReview.teacherReviewStatus) {
    merged.teacherReviewStatus = variantReview.teacherReviewStatus;
  }
  if (!String(merged.teacherComment || '').trim() && String(variantReview.teacherComment || '').trim()) {
    merged.teacherComment = variantReview.teacherComment;
  }

  const bankAiDone = merged.aiReviewStatus === 'done';
  const vrAiDone = variantReview.aiReviewStatus === 'done';
  if (vrAiDone && !bankAiDone) merged.aiReviewStatus = 'done';
  else if (!merged.aiReviewStatus && variantReview.aiReviewStatus) {
    merged.aiReviewStatus = variantReview.aiReviewStatus;
  }

  if (!String(merged.aiNote || '').trim() && String(variantReview.aiNote || '').trim()) {
    merged.aiNote = variantReview.aiNote;
  }
  if (merged.aiApproved == null && variantReview.aiApproved != null) {
    merged.aiApproved = variantReview.aiApproved;
  }
  if (!merged.aiChecks && variantReview.aiChecks) merged.aiChecks = variantReview.aiChecks;
  if (!merged.aiMode && variantReview.aiMode) merged.aiMode = variantReview.aiMode;
  if (!merged.aiCompletionLevel && variantReview.aiCompletionLevel) {
    merged.aiCompletionLevel = variantReview.aiCompletionLevel;
  }

  return merged;
}

/** @param {object} bankItem @param {object} merged */
export function problemBankNeedsAiBackfill(bankItem, merged) {
  if (!bankItem || !merged) return false;
  const bankAiDone = bankItem.aiReviewStatus === 'done';
  const mergedAiDone = merged.aiReviewStatus === 'done';
  if (mergedAiDone && !bankAiDone) return true;
  if (!String(bankItem.aiNote || '').trim() && String(merged.aiNote || '').trim()) return true;
  if (bankItem.aiApproved == null && merged.aiApproved != null) return true;
  if (!bankItem.aiChecks && merged.aiChecks) return true;
  const bankTeacherStatus = bankItem.teacherReviewStatus
    || (bankItem.status === SUBMISSION_STATUS_REJECTED ? SUBMISSION_STATUS_REJECTED : null);
  const mergedTeacherStatus = merged.teacherReviewStatus
    || (merged.status === SUBMISSION_STATUS_REJECTED ? SUBMISSION_STATUS_REJECTED : null);
  if (isTeacherReviewResolved(mergedTeacherStatus) && !isTeacherReviewResolved(bankTeacherStatus)) return true;
  if (!String(bankItem.teacherComment || '').trim() && String(merged.teacherComment || '').trim()) return true;
  return false;
}

/** @param {object} merged */
export function pickProblemBankAiBackfillPatch(merged) {
  const patch = {};
  const status = getItemReviewStatus(merged);
  if (isTeacherReviewResolved(status)) {
    patch.teacherReviewStatus = status;
    if (status === SUBMISSION_STATUS_APPROVED) patch.status = SUBMISSION_STATUS_APPROVED;
  }
  if (merged.teacherComment) patch.teacherComment = merged.teacherComment;
  if (merged.aiReviewStatus) patch.aiReviewStatus = merged.aiReviewStatus;
  if (merged.aiNote != null) patch.aiNote = merged.aiNote;
  if (merged.aiApproved != null) patch.aiApproved = merged.aiApproved;
  if (merged.aiChecks != null) patch.aiChecks = merged.aiChecks;
  if (merged.aiMode) patch.aiMode = merged.aiMode;
  if (merged.aiCompletionLevel) patch.aiCompletionLevel = merged.aiCompletionLevel;
  return patch;
}

/**
 * @param {{ status?: string, teacherStatus?: string, aiNote?: string, aiApproved?: boolean|null, aiChecks?: Record<string,boolean>|null, aiReviewStatus?: string, teacherComment?: string }} item
 */
export function hasStudentVisibleAiFeedback(item) {
  if (!item) return false;
  if (isStudentAiReviewPending(item)) return true;
  if (isTeacherReviewResolved(getItemReviewStatus(item))) return true;
  if (getStudentVisibleAiNote(item)) return true;
  if (getStudentVisibleTeacherComment(item)) return true;
  if (listVisibleAiCheckRows(item.aiChecks, item).length > 0) return true;
  return item.aiApproved === true || item.aiApproved === false;
}

/**
 * @param {{ status?: string, teacherStatus?: string, aiApproved?: boolean|null }} item
 */
export function studentAiFeedbackBoxClass(item) {
  const status = getItemReviewStatus(item);
  if (status === SUBMISSION_STATUS_APPROVED_PARTIAL) return 'stu-ai-feedback--warn';
  if (status === SUBMISSION_STATUS_APPROVED) return 'stu-ai-feedback--ok';
  if (status === SUBMISSION_STATUS_REJECTED) return 'stu-ai-feedback--fail';
  if (isSolutionOnlyCheckFailure(item?.aiChecks)) return 'stu-ai-feedback--warn';
  if (item?.aiApproved === true) return 'stu-ai-feedback--ok';
  if (item?.aiApproved === false) return 'stu-ai-feedback--fail';
  return '';
}
