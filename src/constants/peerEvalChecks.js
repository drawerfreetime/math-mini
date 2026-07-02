/**
 * 동료 평가 2단계 — AI 검수와 맞춘 O/X 항목 (전략 퀴즈 제외)
 */
export const PEER_EVAL_CHECK_KEYS = [
  'research_ethics_ok',
  'answer_ok',
  'solution_ok',
];

/** @type {Record<string, string>} */
export const PEER_EVAL_CHECK_LABELS = {
  research_ethics_ok: '연구 윤리',
  answer_ok: '정답',
  solution_ok: '풀이 과정',
};

/** @type {Record<string, string>} */
export const PEER_EVAL_CHECK_QUESTIONS = {
  research_ethics_ok: '원본과 완전히 똑같지 않나요?',
  answer_ok: '친구가 적은 정답이 맞나요?',
  solution_ok: '친구가 풀이를 잘 적었나요?',
};

/** 출제자 풀이가 problemBank·검수함에 없을 때 */
export const CREATOR_SOLUTION_STORAGE_EMPTY_MSG =
  '친구가 적은 풀이과정이 저장소에 없어요.';

/**
 * @param {Record<string, boolean|null>|null|undefined} peerChecks
 * @param {{ skipSolutionCheck?: boolean }} [opts]
 * @returns {string[]}
 */
export function getRequiredPeerEvalCheckKeys(peerChecks, opts = {}) {
  return PEER_EVAL_CHECK_KEYS.filter((key) => {
    if (key === 'solution_ok' && opts.skipSolutionCheck) return false;
    return true;
  });
}

/**
 * @param {Record<string, boolean>|null|undefined} peerChecks
 * @returns {'unsolvable'|'strategy_faithful'|null}
 */
export function deriveCompletionLevelFromPeerChecks(peerChecks) {
  if (!peerChecks || typeof peerChecks !== 'object') return null;
  const activeKeys = PEER_EVAL_CHECK_KEYS.filter((k) => typeof peerChecks[k] === 'boolean');
  if (activeKeys.length === 0) return null;
  return activeKeys.every((k) => peerChecks[k])
    ? 'strategy_faithful'
    : 'unsolvable';
}

/**
 * @returns {Record<string, null>}
 */
export function emptyPeerChecks() {
  return Object.fromEntries(PEER_EVAL_CHECK_KEYS.map((k) => [k, null]));
}
