import {
  pickFailNoteForChecks,
  pickVariantApprovalPraise,
  resolveCheckFailPriority,
  WRONG_NOTE_APPROVAL_DEFAULT_NOTE,
} from '../constants/aiCheckDefaultFeedback';
import { AI_MODE_LABELS, SUBMISSION_STATUS_APPROVED, SUBMISSION_STATUS_APPROVED_PARTIAL, SUBMISSION_STATUS_REJECTED } from '../constants/aiSubmissionPolicy';
import { WRONG_NOTE_CHECK_KEYS, WRONG_NOTE_CHECK_LABELS } from '../constants/wrongNoteCompetency';
import { COMPLETION_LEVELS } from '../constants/variantEvaluation';
import { inferClassProblemReviewIds } from './variantBankIds';

/** 교사 검수함 — AI 미반영이어도 항상 표시할 변형 문제 O/X 항목 */
export const VARIANT_TEACHER_MANUAL_CHECK_KEYS = [
  'answer_ok',
  'solution_ok',
  'strategy_match_ok',
];

/** 교사 검수함 — 새 문제 만들기(전략·원본 없음) O/X 항목 */
export const NEW_PROBLEM_TEACHER_MANUAL_CHECK_KEYS = [
  'goal_alignment_ok',
  'answer_ok',
  'solution_ok',
];

/**
 * UI에 표시하지 않는 항목 — 백엔드 `run_variant_problem_checks` 결과만 저장·승인에 반영.
 * (자릿수 조건 모순, □식 무해, 지문 정답 노출 등)
 */
export const UI_HIDDEN_AI_CHECK_KEYS = ['problem_solvable_ok'];

/** @param {object|null|undefined} item */
export function isNewProblemItem(item) {
  if (item?.aiMode === 'new_problem' || item?.kind === 'new' || item?.source === 'new_problem') {
    return true;
  }
  const bankDocId = String(item?.bankDocId || '').trim();
  if (bankDocId.startsWith('new_')) return true;
  const hasExamSource = item?.examId != null && item?.examId !== ''
    && item?.questionNumber != null;
  if (!hasExamSource && !String(item?.variantStrategyId || '').trim()) return true;
  return false;
}

export const VARIANT_AI_CHECK_LABELS = {
  /** UI 미표시 — `UI_HIDDEN_AI_CHECK_KEYS`, 백엔드 검수·피드백 생성용 */
  problem_solvable_ok: '풀 수 있는 문제',
  answer_ok: '정답',
  solution_ok: '풀이 과정',
  strategy_match_ok: '전략 일치',
  goal_alignment_ok: '학습목표',
  research_ethics_ok: '연구 윤리',
  ethics_ok: '윤리·표절',
  verified: '검산 확인',
  reason_ok: '틀린 이유',
  prevention_ok: '다시 틀리지 않으려면',
};

/** AI API 전부 실패 시 저장되는 peer_review 폴백 문구 */
export function isAiReviewFallbackNote(note) {
  return String(note || '').trim().includes('AI 검토 시스템이 일시적으로 사용 불가');
}

/** 검수함·학급은행 문제 지문 비교용 (공백·수식 기호 정규화) */
export function normalizeVariantQuestionForMatch(text) {
  return String(text || '')
    .replace(/\$\$?/g, '')
    .replace(/\\square/g, '□')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, 160);
}

export function buildClassProblemReviewsPool(inboxVariantReviews, extraReviews) {
  const byId = new Map();
  for (const row of [...(inboxVariantReviews || []), ...(extraReviews || [])]) {
    if (row?.id) byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

/**
 * 검수함(variantReviews) 행에 대응하는 학급 problemBank 행을 찾습니다.
 * @param {object} review
 * @param {Array<object>|null|undefined} problems
 */
export function findClassProblemForVariantReview(review, problems) {
  if (!review || !Array.isArray(problems) || problems.length === 0) return null;
  const cpid = String(review.classProblemId || '').trim();
  if (cpid) {
    const hit = problems.find((p) => p.id === cpid);
    if (hit) return hit;
  }
  const rid = String(review.id || '').trim();
  if (rid) {
    const byReview = problems.find((p) => String(p.reviewId || '').trim() === rid);
    if (byReview) return byReview;
  }
  for (const p of problems) {
    if (variantReviewMatchesProblem(p, review)) return p;
  }
  return null;
}

/**
 * 검수함 표시용 — problemBank 에만 있는 AI 피드백을 variantReviews 행에 합칩니다.
 * @param {object} review
 * @param {object|null|undefined} problem
 */
export function mergeVariantReviewWithClassProblemAi(review, problem) {
  if (!review || !problem) return review;

  const vrNote = String(review.aiNote ?? '').trim();
  const pbNote = String(problem.aiNote ?? '').trim();
  const vrIsFallback = isAiReviewFallbackNote(vrNote);
  const pbIsFallback = isAiReviewFallbackNote(pbNote);
  const pbDone = String(problem.aiReviewStatus || '').trim() === 'done';
  const vrDone = String(review.aiReviewStatus || '').trim() === 'done';

  const preferPb = pbDone && pbNote && !pbIsFallback && (
    !vrDone
    || !vrNote
    || vrIsFallback
    || vrNote !== pbNote
  );

  if (!preferPb) return review;

  return {
    ...review,
    aiNote: pbNote,
    aiApproved: problem.aiApproved ?? review.aiApproved,
    aiChecks: problem.aiChecks ?? review.aiChecks,
    aiCompletionLevel: problem.aiCompletionLevel ?? review.aiCompletionLevel,
    aiMode: problem.aiMode || review.aiMode,
    aiReviewStatus: problem.aiReviewStatus || review.aiReviewStatus,
    classProblemId: review.classProblemId || problem.id,
    classProblemLabel: review.classProblemLabel || problem.label,
  };
}

/**
 * @param {Array<object>|null|undefined} reviews
 * @param {Array<object>|null|undefined} problems
 */
export function enrichVariantReviewsWithClassProblemAi(reviews, problems) {
  if (!Array.isArray(reviews) || reviews.length === 0) return reviews || [];
  if (!Array.isArray(problems) || problems.length === 0) return reviews;
  return reviews.map((review) => mergeVariantReviewWithClassProblemAi(
    review,
    findClassProblemForVariantReview(review, problems),
  ));
}

/**
 * 검수함(variantReviews) AI 필드를 학급 problemBank 행 위에 덮어씁니다.
 * 검수함과 동일한 피드백을 보여 주기 위한 단일 소스 — API 재호출 없음.
 */
function mergeProblemWithVariantReviewRow(problem, vr) {
  if (!vr) return problem;
  const vrNote = String(vr.aiNote ?? '').trim();
  const pbNote = String(problem.aiNote ?? '').trim();
  const pbIsFallback = isAiReviewFallbackNote(pbNote);
  const vrIsFallback = isAiReviewFallbackNote(vrNote);
  const note = (vrNote && (!vrIsFallback || !pbNote || pbIsFallback))
    ? vrNote
    : (!pbIsFallback ? pbNote : vrNote);
  const preferVr = vrNote && (!vrIsFallback || pbIsFallback || !pbNote);
  return {
    ...problem,
    aiNote: note,
    aiApproved: preferVr ? (vr.aiApproved ?? problem.aiApproved) : (problem.aiApproved ?? vr.aiApproved),
    aiChecks: preferVr ? (vr.aiChecks ?? problem.aiChecks) : (problem.aiChecks ?? vr.aiChecks),
    aiCompletionLevel: preferVr
      ? (vr.aiCompletionLevel ?? problem.aiCompletionLevel)
      : (problem.aiCompletionLevel ?? vr.aiCompletionLevel),
    aiMode: preferVr ? (vr.aiMode ?? problem.aiMode) : (problem.aiMode ?? vr.aiMode),
    aiReviewStatus: preferVr
      ? (vr.aiReviewStatus ?? problem.aiReviewStatus)
      : (problem.aiReviewStatus ?? vr.aiReviewStatus),
    solutionProcess: vr.solutionProcess ?? problem.solutionProcess ?? null,
    nameMap: vr.nameMap ?? problem.nameMap ?? {},
  };
}

/**
 * 검수 문서 조회용 맵 (reviewId · classProblemId)
 * @param {Array<object>|null|undefined} variantReviews
 */
export function buildVariantReviewLookupMaps(variantReviews) {
  const byReviewId = new Map();
  const byClassProblemId = new Map();
  for (const row of variantReviews || []) {
    if (row?.id) byReviewId.set(row.id, row);
    const classProblemId = String(row.classProblemId || '').trim();
    if (classProblemId) byClassProblemId.set(classProblemId, row);
  }
  return { byReviewId, byClassProblemId };
}

/** 검수함 목록 + 학급 문제별 직접 조회 결과를 하나의 lookup 으로 합칩니다. */
export function mergeVariantReviewLookupMaps(...lookups) {
  const byReviewId = new Map();
  const byClassProblemId = new Map();
  for (const lookup of lookups) {
    if (!lookup) continue;
    const ridMap = lookup instanceof Map ? lookup : lookup.byReviewId;
    const cpMap = lookup instanceof Map ? null : lookup.byClassProblemId;
    if (ridMap) {
      for (const [k, v] of ridMap.entries()) byReviewId.set(k, v);
    }
    if (cpMap) {
      for (const [k, v] of cpMap.entries()) byClassProblemId.set(k, v);
    }
  }
  return { byReviewId, byClassProblemId };
}

function scoreVariantReviewQuality(vr) {
  const note = String(vr?.aiNote || '').trim();
  let score = 0;
  if (note) {
    if (isAiReviewFallbackNote(note)) score = 1;
    else {
      const mode = String(vr?.aiMode || '').trim();
      if (mode === 'peer_review') score = 2;
      else if (mode === 'validation' || mode === 'deterministic') score = 4;
      else if (mode.startsWith('gemini') || mode === 'claude') score = 5;
      else score = 3;
    }
  }
  const checks = listAiCheckRows(vr?.aiChecks);
  if (checks.length > 0) {
    const checkScore = checks.some((c) => !c.ok) ? 3 : 4;
    score = Math.max(score, checkScore);
  }
  return score;
}

const MIN_QUESTION_MATCH_LEN = 8;

function normalizedQuestionsMatch(leftText, rightText) {
  const left = normalizeVariantQuestionForMatch(leftText);
  const right = normalizeVariantQuestionForMatch(rightText);
  if (left.length < MIN_QUESTION_MATCH_LEN || right.length < MIN_QUESTION_MATCH_LEN) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/** @param {object} problem @param {object} vr */
export function variantReviewMatchesProblem(problem, vr) {
  if (!problem || !vr) return false;
  const classProblemId = String(problem.id || problem.problemId || '').trim();
  const vrCpid = String(vr.classProblemId || '').trim();
  if (classProblemId && vrCpid === classProblemId) return true;
  for (const rid of inferClassProblemReviewIds(problem)) {
    if (vr.id === rid) return true;
  }
  const uuid = String(problem.createdBy || '').trim();
  const examId = String(problem.examId || '').trim();
  const srcNum = problem.sourceNumber;
  if (
    uuid
    && examId
    && srcNum != null
    && srcNum !== ''
    && String(vr.studentUUID || '') === uuid
    && String(vr.examId || '') === examId
    && Number(vr.questionNumber) === Number(srcNum)
  ) {
    return true;
  }
  const label = String(problem.label || '').trim();
  const vrLabel = String(vr.classProblemLabel || '').trim();
  // 학급 라벨(예: 0615 문제1)은 학급당 하루에 하나 — UUID 없이도 연결 가능
  if (label && vrLabel === label) return true;
  if (
    uuid
    && String(vr.studentUUID || '') === uuid
    && normalizedQuestionsMatch(problem.variantQuestion, vr.question)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {object} problem
 * @param {Map<string, object>|{ byReviewId?: Map<string, object>, byClassProblemId?: Map<string, object> }|null} lookup
 * @param {Array<object>|null|undefined} [allReviews]
 */
export function collectVariantReviewCandidatesForProblem(problem, lookup, allReviews) {
  if (!problem) return [];
  const byReviewId = lookup instanceof Map ? lookup : lookup?.byReviewId;
  const byClassProblemId = lookup instanceof Map ? null : lookup?.byClassProblemId;
  const classProblemId = String(problem.id || problem.problemId || '').trim();
  const seen = new Set();
  const out = [];

  const add = (vr) => {
    if (!vr?.id || seen.has(vr.id)) return;
    seen.add(vr.id);
    out.push(vr);
  };

  for (const rid of inferClassProblemReviewIds(problem)) {
    add(byReviewId?.get(rid));
  }
  if (classProblemId) {
    add(byClassProblemId?.get(classProblemId));
  }
  for (const vr of allReviews || []) {
    if (variantReviewMatchesProblem(problem, vr)) add(vr);
  }
  return out;
}

export function pickPreferredVariantReview(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return [...candidates].sort((a, b) => scoreVariantReviewQuality(b) - scoreVariantReviewQuality(a))[0];
}

/**
 * 학급 problemBank 한 건에 대응하는 variantReviews 행을 찾습니다.
 * @param {object} problem
 * @param {Map<string, object>|{ byReviewId?: Map<string, object>, byClassProblemId?: Map<string, object> }|null} lookup
 * @param {Array<object>|null|undefined} [allReviews]
 */
export function resolveVariantReviewForProblem(problem, lookup, allReviews) {
  let candidates = collectVariantReviewCandidatesForProblem(problem, lookup, allReviews);
  const uuid = String(problem.createdBy || '').trim();
  const seen = new Set(candidates.map((c) => c.id));
  for (const vr of allReviews || []) {
    if (!vr?.id || seen.has(vr.id)) continue;
    if (uuid && String(vr.studentUUID || '') !== uuid) continue;
    if (normalizedQuestionsMatch(problem.variantQuestion, vr.question)) {
      candidates.push(vr);
      seen.add(vr.id);
    }
  }
  return pickPreferredVariantReview(candidates);
}

function findNonFallbackReviews(rows) {
  return (rows || []).filter((vr) => {
    const note = String(vr?.aiNote || '').trim();
    return note && !isAiReviewFallbackNote(note);
  });
}

/**
 * problemBank ↔ variantReviews 연결 — 1차 매칭 후 라벨·시험 문항으로 재시도합니다.
 */
export function findBestVariantReviewForClassProblem(problem, pool) {
  if (!problem || !Array.isArray(pool) || pool.length === 0) return null;
  const lookup = buildVariantReviewLookupMaps(pool);
  const primary = resolveVariantReviewForProblem(problem, lookup, pool);
  if (primary && !isAiReviewFallbackNote(primary.aiNote)) return primary;

  const label = String(problem.label || '').trim();
  if (label) {
    const byLabel = pool.filter((vr) => String(vr.classProblemLabel || '').trim() === label);
    const bestByLabel = pickPreferredVariantReview(findNonFallbackReviews(byLabel));
    if (bestByLabel) return bestByLabel;
  }

  const uuid = String(problem.createdBy || '').trim();
  const examId = String(problem.examId || '').trim();
  const srcNum = problem.sourceNumber;
  if (uuid && examId && srcNum != null && srcNum !== '') {
    const byExam = pool.filter((vr) =>
      String(vr.studentUUID || '') === uuid
      && String(vr.examId || '') === examId
      && Number(vr.questionNumber) === Number(srcNum),
    );
    const bestByExam = pickPreferredVariantReview(findNonFallbackReviews(byExam));
    if (bestByExam) return bestByExam;
  }

  return primary;
}

/**
 * 학급 문제은행 표시용 — 검수함(inbox) variantReviews 를 우선해 AI 피드백을 합칩니다.
 */
export function resolveClassProblemAiDisplay(problem, inboxVariantReviews, extraReviews) {
  if (!problem) return null;
  const pool = buildClassProblemReviewsPool(inboxVariantReviews, extraReviews);
  const vr = findBestVariantReviewForClassProblem(problem, pool);
  if (!vr) return problem;
  return mergeProblemWithVariantReviewRow(problem, vr);
}

/**
 * 연결 실패 원인 파악용 (개발·지원)
 */
export function diagnoseClassProblemAiLink(problem, inboxVariantReviews, extraReviews) {
  if (!problem) return null;
  const pool = buildClassProblemReviewsPool(inboxVariantReviews, extraReviews);
  const lookup = buildVariantReviewLookupMaps(pool);
  const candidates = collectVariantReviewCandidatesForProblem(problem, lookup, pool);
  const picked = findBestVariantReviewForClassProblem(problem, pool);
  const label = String(problem.label || '').trim();
  const byLabel = label
    ? pool.filter((vr) => String(vr.classProblemLabel || '').trim() === label)
    : [];
  const pbFallback = isAiReviewFallbackNote(problem.aiNote);
  const uuid = String(problem.createdBy || '').trim();
  const examId = String(problem.examId || '').trim();
  const srcNum = problem.sourceNumber;
  const sameExamQuestion = (uuid && examId && srcNum != null && srcNum !== '')
    ? pool.filter((vr) =>
      String(vr.studentUUID || '') === uuid
      && String(vr.examId || '') === examId
      && Number(vr.questionNumber) === Number(srcNum),
    )
    : [];
  const sameExamNonFallback = findNonFallbackReviews(sameExamQuestion);
  const linkingOk = Boolean(picked?.id) && (
    String(problem.reviewId || '').trim() === picked.id
    || candidates.some((c) => c.id === picked.id)
  );
  let conclusion = '';
  if (linkingOk && !pbFallback && !isAiReviewFallbackNote(picked?.aiNote)) {
    conclusion = '연결 정상 · 정상 AI 피드백';
  } else if (linkingOk && (pbFallback || isAiReviewFallbackNote(picked?.aiNote))
    && !sameExamNonFallback.length && !findNonFallbackReviews(byLabel).length) {
    conclusion = '연결 정상 · 검수함·학급은행 모두 AI API 실패(폴백) 데이터 — 재검수 필요';
  } else if (!linkingOk || candidates.length === 0) {
    conclusion = '검수 문서 연결 실패 — reviewId·라벨 불일치';
  } else {
    conclusion = '연결됐으나 더 나은 검수 문서를 찾지 못함';
  }
  return {
    problemId: problem.id || '',
    reviewId: String(problem.reviewId || '').trim(),
    label,
    createdBy: uuid,
    examId,
    sourceNumber: srcNum ?? null,
    inboxHint: examId && srcNum != null
      ? `검수함에서 같은 항목: ${problem.examTitle || '(시험)'} — ${srcNum}번 · reviewId=${String(problem.reviewId || picked?.id || '').trim()}`
      : '',
    poolSize: pool.length,
    candidateCount: candidates.length,
    candidateIds: candidates.map((c) => c.id),
    pickedReviewId: picked?.id || null,
    pickedAiMode: picked?.aiMode || '',
    pickedIsFallback: isAiReviewFallbackNote(picked?.aiNote),
    problemBankIsFallback: pbFallback,
    labelMatchCount: byLabel.length,
    labelMatchIds: byLabel.map((vr) => vr.id),
    labelMatchHasNonFallback: findNonFallbackReviews(byLabel).length > 0,
    sameExamQuestionCount: sameExamQuestion.length,
    sameExamQuestionIds: sameExamQuestion.map((vr) => vr.id),
    sameExamHasNonFallback: sameExamNonFallback.length > 0,
    linkingOk,
    conclusion,
  };
}

/**
 * @param {{ aiNote?: string, aiApproved?: boolean|null, aiReviewStatus?: string, aiChecks?: Record<string,boolean>|null, aiCompletionLevel?: string, aiMode?: string, reviewId?: string, id?: string, problemId?: string }} problem
 * @param {Map<string, object>|{ byReviewId?: Map<string, object>, byClassProblemId?: Map<string, object> }|null} lookup
 * @param {Array<object>|null|undefined} [allReviews]
 */
export function mergeProblemWithVariantReviewAi(problem, lookup, allReviews) {
  if (!problem) return null;
  const vr = findBestVariantReviewForClassProblem(problem, allReviews || []);
  if (!vr) return problem;
  return mergeProblemWithVariantReviewRow(problem, vr);
}

/**
 * @param {Array<object>|null|undefined} variantReviews
 * @returns {Map<string, object>}
 */
export function buildVariantReviewByIdMap(variantReviews) {
  return buildVariantReviewLookupMaps(variantReviews).byReviewId;
}

export function aiFeedbackBoxClass(aiApproved, checks) {
  if (isSolutionOnlyCheckFailure(checks)) return 'td-ai-feedback td-ai-feedback--warn';
  if (aiApproved === true) return 'td-ai-feedback td-ai-feedback--ok';
  if (aiApproved === false) return 'td-ai-feedback td-ai-feedback--fail';
  return 'td-ai-feedback';
}

/** @param {Record<string, boolean>|null|undefined} checks */
export function isSolutionOnlyCheckFailure(checks) {
  const rows = listAiCheckRows(checks);
  if (rows.length === 0) return false;
  let hasSolutionFailure = false;
  for (const row of rows) {
    if (row.ok) continue;
    if (row.key !== 'solution_ok') return false;
    hasSolutionFailure = true;
  }
  return hasSolutionFailure;
}

export function formatAiCompletionLabel(levelId) {
  return COMPLETION_LEVELS[levelId]?.label || levelId || '';
}

export function formatAiModeLabel(mode) {
  const key = String(mode || '').trim();
  if (!key) return '';
  return AI_MODE_LABELS[key] || key;
}

/** @param {string|null|undefined} aiReviewStatus */
export function isAiReviewPending(aiReviewStatus, item = null) {
  const status = String(aiReviewStatus || item?.aiReviewStatus || 'pending').trim();
  if (status === 'done') return false;
  // 오답노트 등: aiReviewStatus 미저장 구문서도 aiNote·aiMode가 있으면 검수 완료로 본다
  if (item && status === 'pending') {
    const note = String(item.aiNote || '').trim();
    const mode = String(item.aiMode || '').trim();
    if (note && mode) return false;
  }
  return status !== 'done';
}

/** @param {object|null|undefined} row */
export function hasStoredAiCheckBooleans(row) {
  const checks = row?.aiChecks;
  if (!checks || typeof checks !== 'object') return false;
  return Object.values(checks).some((v) => typeof v === 'boolean');
}

/**
 * aiReviewStatus=done 이지만 피드백·체크가 비어 있는 반쪽 결과
 * @param {object|null|undefined} row
 */
export function isAiReviewResultIncomplete(row) {
  if (!row || isAiReviewPending(row.aiReviewStatus)) return false;
  const note = String(row.aiNote || '').trim();
  if (note && !isAiReviewFallbackNote(note)) return false;
  return !hasStoredAiCheckBooleans(row);
}

/**
 * @param {Record<string, boolean>|null|undefined} checks
 * @returns {Array<{ key: string, label: string, ok: boolean }>}
 */
export function listAiCheckRows(checks) {
  if (!checks || typeof checks !== 'object') return [];
  return Object.entries(checks)
    .filter(([, v]) => typeof v === 'boolean')
    .map(([key, ok]) => ({
      key,
      label: VARIANT_AI_CHECK_LABELS[key] || WRONG_NOTE_CHECK_LABELS[key] || key,
      ok,
    }));
}

/** @param {{ wrongReason?: string, questionText?: string }} item */
export function resolveTeacherManualCheckKeys(item) {
  if (item?.wrongReason != null || item?.questionText != null) {
    return WRONG_NOTE_CHECK_KEYS;
  }
  if (isNewProblemItem(item)) {
    return NEW_PROBLEM_TEACHER_MANUAL_CHECK_KEYS;
  }
  return VARIANT_TEACHER_MANUAL_CHECK_KEYS;
}

/**
 * 화면에 보여 줄 AI 체크 행.
 * - 숨김 항목(`UI_HIDDEN_AI_CHECK_KEYS`) 제외
 * - 새 문제: 학습목표·정답·풀이 3항목만
 * @param {Record<string, boolean>|null|undefined} checks
 * @param {object|null|undefined} [item]
 */
export function listVisibleAiCheckRows(checks, item) {
  if (item?.wrongReason != null) {
    return listStudentWrongNoteCheckRows(checks, item);
  }
  const hidden = new Set(UI_HIDDEN_AI_CHECK_KEYS);
  let rows = listAiCheckRows(checks).filter((row) => !hidden.has(row.key));
  if (item && isNewProblemItem(item)) {
    const allowed = new Set(NEW_PROBLEM_TEACHER_MANUAL_CHECK_KEYS);
    rows = rows.filter((row) => allowed.has(row.key));
  }
  return rows;
}

/**
 * 학생 오답노트 — 교사 검수함과 동일한 4항목(정답·풀이·틀린 이유·재발 방지)을 고정 순서로 표시.
 * @param {Record<string, boolean>|null|undefined} checks
 * @param {{ aiChecks?: Record<string, boolean>, aiApproved?: boolean|null, wrongReason?: string }} item
 */
export function listStudentWrongNoteCheckRows(checks, item) {
  const source = checks || item?.aiChecks || {};
  const approved = item?.aiApproved === true;
    return WRONG_NOTE_CHECK_KEYS.map((key) => {
    const stored = source[key];
    const ok = typeof stored === 'boolean'
      ? stored
      : (approved ? true : false);
    return {
      key,
      label: VARIANT_AI_CHECK_LABELS[key] || WRONG_NOTE_CHECK_LABELS[key] || key,
      ok,
    };
  });
}

/**
 * 교사 수동 검수용 — 필수 항목이 없으면 기본값으로 채웁니다.
 * @param {Record<string, boolean>|null|undefined} checks
 * @param {string[]} requiredKeys
 * @param {{ pending?: boolean }} [opts] — pending 이면 미정(null), 아니면 false(미통과)
 */
export function ensureTeacherManualChecks(checks, requiredKeys, opts = {}) {
  const pending = opts.pending === true;
  const base = cloneAiChecks(checks);
  for (const key of requiredKeys || []) {
    if (typeof base[key] !== 'boolean') {
      base[key] = pending ? null : false;
    }
  }
  return base;
}

/**
 * 교사 검수함 O/X 행 — 필수 항목을 고정 순서로 먼저 보여 주고, AI 추가 항목은 뒤에 붙입니다.
 * @param {Record<string, boolean>|null|undefined} checks
 * @param {string[]} requiredKeys
 */
export function listTeacherReviewCheckRows(checks, requiredKeys, opts = {}) {
  const ensured = ensureTeacherManualChecks(checks, requiredKeys, opts);
  const seen = new Set(requiredKeys || []);
  const rows = (requiredKeys || []).map((key) => ({
    key,
    label: VARIANT_AI_CHECK_LABELS[key] || WRONG_NOTE_CHECK_LABELS[key] || key,
    ok: ensured[key],
    pending: ensured[key] == null,
  }));
  for (const row of listAiCheckRows(ensured)) {
    if (seen.has(row.key) || UI_HIDDEN_AI_CHECK_KEYS.includes(row.key)) continue;
    rows.push(row);
  }
  return rows;
}

/** @param {Record<string, boolean>|null|undefined} checks */
export function cloneAiChecks(checks) {
  if (!checks || typeof checks !== 'object') return {};
  return Object.fromEntries(
    Object.entries(checks).filter(([, v]) => typeof v === 'boolean'),
  );
}

/** @param {Record<string, boolean>|null|undefined} checks @param {object|null|undefined} [item] */
export function deriveAiApprovedFromChecks(checks, item) {
  const manualKeys = resolveTeacherManualCheckKeys(item);
  if (manualKeys.some((key) => checks?.[key] == null)) return null;

  const rows = listVisibleAiCheckRows(checks, item);
  if (rows.length === 0) return null;
  if (!rows.every((row) => row.ok)) return false;
  for (const key of UI_HIDDEN_AI_CHECK_KEYS) {
    if (checks?.[key] === false) return false;
  }
  return true;
}

/** @param {object} item */
export function isWrongNoteReviewItem(item) {
  return item?.wrongReason != null || item?.questionText != null;
}

/**
 * @param {Record<string, boolean>|null|undefined} checks
 * @param {Record<string, boolean>|null|undefined} baselineChecks
 */
export function teacherChecksMatchBaseline(checks, baselineChecks) {
  const keys = new Set([
    ...Object.keys(checks || {}),
    ...Object.keys(baselineChecks || {}),
  ]);
  for (const key of keys) {
    const current = checks?.[key];
    const baseline = baselineChecks?.[key];
    if (typeof current === 'boolean' || typeof baseline === 'boolean') {
      if (current !== baseline) return false;
    }
  }
  return true;
}

/**
 * 교사가 O/X를 바꿀 때 피드백 문장을 동기화합니다.
 * - AI 초기 상태와 같아지면 baselineNote 복원
 * - 전부 O이면 승인 칭찬
 * - 하나라도 X이면 해당 항목 기본 1문장
 *
 * @param {{
 *   checks: Record<string, boolean>,
 *   baselineNote: string,
 *   baselineChecks: Record<string, boolean>,
 *   item?: object,
 * }} p
 */
export function syncTeacherFeedbackNote(p) {
  const {
    checks,
    baselineNote = '',
    baselineChecks = {},
    item,
  } = p;
  const baseline = String(baselineNote || '').trim();

  if (teacherChecksMatchBaseline(checks, baselineChecks)) {
    return baseline;
  }

  return deriveTeacherFeedbackNoteFromChecks(checks, item);
}

/**
 * AI 체크 결과만 있고 aiNote 가 비어 있을 때 검수함·학급은행에 쓸 피드백 문장을 만듭니다.
 * @param {Record<string, boolean>|null|undefined} checks
 * @param {object} [item]
 */
export function deriveTeacherFeedbackNoteFromChecks(checks, item) {
  const approved = deriveAiApprovedFromChecks(checks, item);
  if (approved === true) {
    return isWrongNoteReviewItem(item)
      ? WRONG_NOTE_APPROVAL_DEFAULT_NOTE
      : pickVariantApprovalPraise(item);
  }
  const priority = resolveCheckFailPriority(isWrongNoteReviewItem(item));
  const wrongNote = isWrongNoteReviewItem(item);
  if (approved === false) {
    return pickFailNoteForChecks(checks, priority, { wrongNote });
  }
  const visibleFails = listVisibleAiCheckRows(checks, item).some((row) => row.ok === false);
  if (visibleFails) {
    return pickFailNoteForChecks(checks, priority, { wrongNote });
  }
  return '';
}

/**
 * @param {object} item
 * @param {{
 *   checks: Record<string, boolean>,
 *   note?: string,
 *   baselineNote?: string,
 *   baselineChecks?: Record<string, boolean>,
 *   noteEditedByTeacher?: boolean,
 * }} draft
 */
export function finalizeTeacherFeedbackDraft(item, draft) {
  if (!draft) return { checks: {}, note: '', baselineNote: '', baselineChecks: {}, noteEditedByTeacher: false };
  if (draft.noteEditedByTeacher) return draft;
  const note = syncTeacherFeedbackNote({
    checks: draft.checks,
    baselineNote: draft.baselineNote ?? String(item?.aiNote || '').trim(),
    baselineChecks: draft.baselineChecks ?? cloneAiChecks(item?.aiChecks),
    item,
  });
  return { ...draft, note };
}

/**
 * @param {object|null|undefined} item
 */
export function buildTeacherReviewFeedbackDraft(item) {
  const requiredKeys = resolveTeacherManualCheckKeys(item);
  const aiPending = isAiReviewPending(item?.aiReviewStatus, item);
  const checks = ensureTeacherManualChecks(item?.aiChecks, requiredKeys, { pending: aiPending });
  const baselineNote = String(item?.aiNote || '').trim();
  let note = baselineNote;
  if (!note && !aiPending && listVisibleAiCheckRows(checks, item).length > 0) {
    note = deriveTeacherFeedbackNoteFromChecks(checks, item);
  }
  return {
    checks,
    note,
    baselineNote,
    baselineChecks: cloneAiChecks(item?.aiChecks),
    noteEditedByTeacher: false,
    sourceAiReviewStatus: item?.aiReviewStatus || 'pending',
    sourceAiMode: item?.aiMode || '',
    sourceAiCompletionLevel: item?.aiCompletionLevel || '',
  };
}

/**
 * 검수함 피드백 전송 시 승인/반려 판정 — 항목이 없으면 승인으로 처리합니다.
 * @param {Record<string, boolean>|null|undefined} checks
 * @param {'approved'|'rejected'} approvedStatus
 * @param {'approved'|'rejected'} rejectedStatus
 */
export function deriveReviewStatusFromChecks(checks, approvedStatus, rejectedStatus, item) {
  const approved = deriveAiApprovedFromChecks(checks, item);
  if (approved === null) return approvedStatus;
  return approved ? approvedStatus : rejectedStatus;
}

/**
 * 변형 문제 검수 — 풀이 과정만 X이면 부분 승인(학급 문제은행 유지·15점)
 * @param {Record<string, boolean>|null|undefined} checks
 * @param {object|null|undefined} [item]
 */
export function deriveVariantReviewStatusFromChecks(checks, item) {
  if (isSolutionOnlyCheckFailure(checks)) {
    return SUBMISSION_STATUS_APPROVED_PARTIAL;
  }
  return deriveReviewStatusFromChecks(
    checks,
    SUBMISSION_STATUS_APPROVED,
    SUBMISSION_STATUS_REJECTED,
    item,
  );
}

export function hasVisibleAiFeedback(item) {
  if (!item) return false;
  const note = String(item.aiNote || '').trim();
  if (note) return true;
  if (isAiReviewPending(item.aiReviewStatus, item)) return true;
  if (item.aiApproved === true || item.aiApproved === false) return true;
  return listVisibleAiCheckRows(item.aiChecks, item).length > 0;
}

export function formatAiFeedbackForReport(item) {
  if (!item) return [];
  const lines = [];
  const status = item.aiReviewStatus || '—';
  const approved = item.aiApproved === true
    ? '승인'
    : item.aiApproved === false
      ? '미승인'
      : '—';
  lines.push(`- AI 검수 상태: ${status} (${approved})`);
  const mode = formatAiModeLabel(item.aiMode);
  if (mode) lines.push(`- AI 모드: ${mode}`);
  const completion = formatAiCompletionLabel(item.aiCompletionLevel);
  if (completion) lines.push(`- AI 완성도 판정: ${completion}`);
  const checks = listVisibleAiCheckRows(item.aiChecks, item);
  if (checks.length > 0) {
    lines.push('- AI 항목별:', ...checks.map((c) => `  - ${c.label}: ${c.ok ? '통과' : '미통과'}`));
  }
  const note = String(item.aiNote || '').trim();
  if (note) {
    lines.push('', '**AI 피드백**', '```', note, '```');
  }
  return lines;
}
