/**
 * 탐구점수(랭킹·보상) — 활동별 점수
 */
import { getStudentRolling30Points, getKstDateKey } from '../utils/explorationRolling30.js';

/** 학생·교사 UI 표시명 (구 TP / 탐구 포인트) */
export const EXPLORATION_POINTS_LABEL = '탐구점수';

/** 반 랭킹용 — 최근 30일 누적 (단원 진행 점수와 구분) */
export const RANKING_EXPLORATION_POINTS_LABEL = '랭킹 탐구점수';

/** @param {number} points @param {{ signed?: boolean }} [opts] */
export function formatExplorationPointsAmount(points, { signed = false } = {}) {
  const n = Math.max(0, Number(points) || 0);
  const formatted = n.toLocaleString();
  return signed && n > 0 ? `+${formatted}` : formatted;
}

/** @param {number} points @param {{ signed?: boolean; withLabel?: boolean }} [opts] */
export function formatExplorationPoints(points, { signed = false, withLabel = true } = {}) {
  const amount = formatExplorationPointsAmount(points, { signed });
  return withLabel ? `${amount} ${EXPLORATION_POINTS_LABEL}` : amount;
}

/** 동료평가 — 전략 맞히기 */
export const PEER_EVAL_STRATEGY_POINTS = 3;
/** 동료평가 — O/X 항목 AI 일치 (항목당) */
export const PEER_EVAL_CHECK_MATCH_POINTS = 2;

export const EXPLORATION_REWARD_KIND = {
  SOLVE_CORRECT: 'solve_correct',
  PEER_EVAL_STRATEGY: 'peer_eval_strategy',
  PEER_EVAL_COMPLETION: 'peer_eval_completion',
  WRONG_NOTE_APPROVED: 'wrong_note_approved',
  MAKING_APPROVED: 'making_approved',
  MAKING_APPROVED_PARTIAL: 'making_approved_partial',
  MAKING_SOLUTION_BONUS: 'making_solution_bonus',
  MAKING_STRATEGY_BONUS: 'making_strategy_bonus',
};

export const EXPLORATION_REWARD_POINTS = {
  [EXPLORATION_REWARD_KIND.SOLVE_CORRECT]: 10,
  [EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY]: PEER_EVAL_STRATEGY_POINTS,
  [EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION]: PEER_EVAL_CHECK_MATCH_POINTS,
  [EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED]: 20,
  [EXPLORATION_REWARD_KIND.MAKING_APPROVED]: 30,
  [EXPLORATION_REWARD_KIND.MAKING_APPROVED_PARTIAL]: 15,
  [EXPLORATION_REWARD_KIND.MAKING_SOLUTION_BONUS]: 15,
};

export const EXPLORATION_REWARD_LABELS = {
  [EXPLORATION_REWARD_KIND.SOLVE_CORRECT]: '학급 문제 정답',
  [EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY]: '동료평가 전략 맞히기',
  [EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION]: '동료평가 O/X 항목 (AI 일치·항목당)',
  [EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED]: '오답노트 승인',
  [EXPLORATION_REWARD_KIND.MAKING_APPROVED]: '문제 만들기 승인',
  [EXPLORATION_REWARD_KIND.MAKING_APPROVED_PARTIAL]: '문제 만들기 승인 (풀이 보완)',
  [EXPLORATION_REWARD_KIND.MAKING_SOLUTION_BONUS]: '풀이 과정 확인 보너스',
  [EXPLORATION_REWARD_KIND.MAKING_STRATEGY_BONUS]: '전략 보너스',
};

/** 교사 승인형 — 로그인 알림 대상 */
export const EXPLORATION_NOTIFICATION_KINDS = new Set([
  EXPLORATION_REWARD_KIND.MAKING_APPROVED,
  EXPLORATION_REWARD_KIND.MAKING_APPROVED_PARTIAL,
  EXPLORATION_REWARD_KIND.MAKING_SOLUTION_BONUS,
  EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED,
]);

export function isPartialMakingApprovalReward(kind) {
  return kind === EXPLORATION_REWARD_KIND.MAKING_APPROVED_PARTIAL;
}

export function isTeacherApprovedRewardKind(kind) {
  return EXPLORATION_NOTIFICATION_KINDS.has(kind);
}

/** @param {string} dateKey YYYY-MM-DD */
export function formatExplorationDateLabel(dateKey) {
  const m = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${Number(m[2])}월 ${Number(m[3])}일`;
}

/** @param {Date} [date] */
export function getExplorationMonthKey(date = new Date()) {
  return getKstDateKey(date).slice(0, 7);
}

/** @deprecated 승인 월 표시용 — formatExplorationDateLabel 권장 */
export function formatExplorationMonthLabel(monthKey) {
  const m = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return '';
  return `${Number(m[2])}월`;
}

/** 최근 30일(한국 시각, 오늘 포함) 랭킹 점수 */
export function getStudentRankingPoints(student, anchorDate = new Date()) {
  return getStudentRolling30Points(student, anchorDate);
}

export function explorationRewardLabel(kind) {
  return EXPLORATION_REWARD_LABELS[kind] || '탐구 활동';
}

/**
 * @param {number} checkHitCount AI와 일치한 O/X 항목 수
 * @returns {number}
 */
export function computePeerEvalCheckRewardPoints(checkHitCount) {
  const hits = Math.max(0, Number(checkHitCount) || 0);
  return hits * PEER_EVAL_CHECK_MATCH_POINTS;
}

/** @param {number} points */
export function isPeerEvalCheckRewardPointsAllowed(points) {
  const n = Number(points) || 0;
  return n >= PEER_EVAL_CHECK_MATCH_POINTS
    && n <= PEER_EVAL_CHECK_MATCH_POINTS * 3
    && n % PEER_EVAL_CHECK_MATCH_POINTS === 0;
}

/** 학생 대시보드 툴팁용 — 탐구점수 획득 방법 */
export const EXPLORATION_POINTS_GUIDE = [
  { label: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.SOLVE_CORRECT], points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.SOLVE_CORRECT] },
  { label: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY], points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY] },
  { label: `${EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION]} (최대 6)`, points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION] },
  { label: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED], points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED] },
  { label: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.MAKING_APPROVED], points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.MAKING_APPROVED] },
];
