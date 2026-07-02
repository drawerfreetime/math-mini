/**
 * 교사 검수함 — 항목을 X로 바꿀 때 자동 입력할 1문장 기본 피드백
 * (백엔드 server.py · teacher_guide_eval_core.py 폴백 문구와 동일한 톤)
 */

/** 변형 문제 — 실패 항목 우선순위 (앞에서 먼저 매칭) */
export const VARIANT_CHECK_FAIL_PRIORITY = [
  'research_ethics_ok',
  'strategy_match_ok',
  'goal_alignment_ok',
  'problem_solvable_ok',
  'answer_ok',
  'solution_ok',
  'ethics_ok',
  'verified',
];

/** 오답노트 — 실패 항목 우선순위 */
export const WRONG_NOTE_CHECK_FAIL_PRIORITY = [
  'reason_ok',
  'prevention_ok',
  'solution_ok',
  'answer_ok',
];

/** @type {Record<string, string>} */
export const AI_CHECK_FAIL_DEFAULT_NOTES = {
  research_ethics_ok: '연구원님, 원본과 너무 비슷해요. 숫자·조건·이야기 중 하나라도 바꿔 주세요.',
  strategy_match_ok: '연구원님, 선택한 전략대로 문제를 바꿔 주세요.',
  goal_alignment_ok: '연구원님, 이 단원에 맞는 문제로 다시 만들어 주세요.',
  /** UI 미표시 — 구조 오류 시 `aiNote`/교사 피드백 자동 문구용 */
  problem_solvable_ok: '연구원님, 만든 문제가 수학적으로 성립하지 않아요. 식과 조건을 확인해 주세요.',
  answer_ok: '연구원님, 정답 칸의 계산이 맞지 않아요. 문제에 나온 식을 다시 확인해 주세요.',
  solution_ok: '연구원님, 풀이에 적은 계산 결과가 맞지 않아요. 풀이를 다시 확인해 주세요.',
  ethics_ok: '연구원님, 연구 윤리에 맞게 문제를 다시 만들어 주세요.',
  verified: '연구원님, 계산을 다시 검산해 주세요.',
  reason_ok: '틀린 이유를 조금 더 구체적으로 적어 주세요.',
  prevention_ok: '같은 실수를 줄이려면, 다음에 무엇을 확인하거나 어떻게 풀지 구체적으로 적어 주세요.',
};

/** 오답노트 전용 — 톤이 다름 */
export const WRONG_NOTE_CHECK_FAIL_DEFAULT_NOTES = {
  answer_ok: '정답이 아직 맞지 않아요. 문제를 다시 읽고 계산해 보세요.',
  solution_ok: '풀이 과정을 단계별로 다시 확인해 보세요.',
  reason_ok: AI_CHECK_FAIL_DEFAULT_NOTES.reason_ok,
  prevention_ok: AI_CHECK_FAIL_DEFAULT_NOTES.prevention_ok,
};

export const WRONG_NOTE_APPROVAL_DEFAULT_NOTE =
  '이번에는 올바르게 풀었어요! 오답노트를 잘 정리했네요.';

/** 변형 문제 — 풀이 과정만 X (정답·전략 등은 통과) */
export const VARIANT_SOLUTION_ONLY_FAIL_NOTE =
  '연구원님, 정답은 맞아요! 풀이 과정에 왜 그렇게 생각했는지 단계별로 더 자세히 적어 주세요.';

/**
 * @param {Record<string, boolean>|null|undefined} checks
 * @param {string} failKey
 */
export function isOnlyCheckFailure(checks, failKey) {
  if (!checks || typeof checks !== 'object') return false;
  const rows = Object.entries(checks).filter(([, v]) => typeof v === 'boolean');
  if (rows.length === 0) return false;
  let hasTargetFail = false;
  for (const [key, ok] of rows) {
    if (!ok) {
      if (key !== failKey) return false;
      hasTargetFail = true;
    }
  }
  return hasTargetFail;
}

const VARIANT_STRATEGY_NAME_TO_ID = {
  '숫자 바꾸기': 'change_numbers',
  '상황 바꾸기': 'change_context',
  '조건 바꾸기': 'change_conditions',
  '구하는 것 바꾸기': 'change_goal',
  '조건 추가하기': 'add_conditions',
  '역방향 구성': 'reverse_setup',
};

/** @type {Record<string, string[]>} */
const VARIANT_APPROVAL_PRAISE_BY_STRATEGY = {
  change_numbers: [
    '연구원님, 숫자 바꾸기 전략에 맞게 숫자를 자연스럽게 바꿔 주셨어요! 원본 문제의 느낌은 살리면서 새로운 식이 됐어요.',
  ],
  change_context: [
    '연구원님, 이야기와 상황을 바꿔서 문제가 더 생동감 있어졌어요! 수학 구조도 잘 유지해서 멋진 변형이에요.',
  ],
  change_conditions: [
    '연구원님, 규칙과 조건을 바꿔서 문제의 성격이 확실히 달라졌어요! 식과 조건이 서로 잘 맞아요.',
  ],
  change_goal: [
    '연구원님, 구하는 것을 바꾼 변형이 참 재미있어요! 빈칸과 식이 잘 연결된 좋은 문제예요.',
  ],
  add_conditions: [
    '연구원님, 조건을 하나 더 넣어서 문제가 한층 더 탄탄해졌어요! 추가한 규칙과 기존 식이 잘 어울려요.',
  ],
  reverse_setup: [
    '연구원님, 역방향으로 구성한 문제가 참 잘 만들어졌어요! 거꾸로 생각해 볼 수 있는 좋은 변형이에요.',
  ],
};

const VARIANT_APPROVAL_PRAISE_GENERAL = [
  '연구원님, 선택한 변형 전략을 정확히 이해하고 잘 적용해 주셨어요! 정답과 풀이도 서로 잘 맞아요.',
  '연구원님, 문제 지문이 읽기 쉽고 수학적으로도 탄탄해요! 연구원님만의 아이디어가 문제에 잘 담겨 있어요.',
  '연구원님, 친구들이 풀기 좋은 문제로 잘 만들었어요! 풀이 과정까지 꼼꼼해서 완성도가 높아요.',
];

/**
 * @param {{ variantStrategyId?: string, variantStrategyName?: string, id?: string }} [item]
 */
export function pickVariantApprovalPraise(item) {
  const sidRaw = String(item?.variantStrategyId || '').trim();
  const name = String(item?.variantStrategyName || '').trim();
  const sid = VARIANT_STRATEGY_NAME_TO_ID[name] || sidRaw;
  const pool = VARIANT_APPROVAL_PRAISE_BY_STRATEGY[sid] || VARIANT_APPROVAL_PRAISE_GENERAL;
  const seed = String(item?.id || sid || '0');
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % pool.length;
  }
  return pool[hash] || pool[0];
}

/**
 * @param {boolean|undefined} isWrongNote
 */
export function resolveCheckFailPriority(isWrongNote) {
  return isWrongNote ? WRONG_NOTE_CHECK_FAIL_PRIORITY : VARIANT_CHECK_FAIL_PRIORITY;
}

/**
 * @param {Record<string, boolean>|null|undefined} checks
 * @param {string[]} priority
 * @param {{ wrongNote?: boolean }} [opts]
 */
export function pickFailNoteForChecks(checks, priority, { wrongNote = false } = {}) {
  const map = wrongNote
    ? WRONG_NOTE_CHECK_FAIL_DEFAULT_NOTES
    : AI_CHECK_FAIL_DEFAULT_NOTES;
  if (!checks || typeof checks !== 'object') {
    return map.answer_ok || '다시 한 번 확인해 주세요.';
  }
  if (!wrongNote && isOnlyCheckFailure(checks, 'solution_ok')) {
    return VARIANT_SOLUTION_ONLY_FAIL_NOTE;
  }
  for (const key of priority) {
    if (checks[key] === false) {
      return map[key]
        || (wrongNote ? '다시 한 번 확인해 주세요.' : '연구원님, 다시 한 번 확인해 주세요.');
    }
  }
  return wrongNote ? '다시 한 번 확인해 주세요.' : '연구원님, 다시 한 번 확인해 주세요.';
}
