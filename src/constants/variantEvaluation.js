/**
 * 변형 문제 동료 평가 — 전략·완성도 선택지 (초등 눈높이 문구)
 */
import { VARIANT_STRATEGIES } from './variantStrategies';

/** 단순 변형 — 완성도 2단계만 */
export const SIMPLE_VARIANT_STRATEGY_IDS = ['change_numbers', 'change_context'];

/** 깊은 변형 — 완성도 3단계 */
export const DEEP_VARIANT_STRATEGY_IDS = [
  'change_conditions',
  'change_goal',
  'add_conditions',
  'reverse_setup',
];

export const COMPLETION_LEVELS = {
  unsolvable: {
    id: 'unsolvable',
    label: '잘못 만든 문제',
    hint: '정보가 부족하거나, 조건이 맞지 않거나, 정답이 틀림',
  },
  strategy_faithful: {
    id: 'strategy_faithful',
    label: '원래 문제를 전략에 맞게 잘 바꾼 문제',
    hint: '출제자가 고른 전략대로 적절히 변형됨',
  },
  creative: {
    id: 'creative',
    label: '원래 문제를 창의적으로 멋지게 바꾼 문제',
    hint: '전략을 넘어 생각이 더 깊어지거나 재구성이 뛰어남',
  },
};

/** 난이도 순(최하→최상) — 평가 1 선택지 순서 */
export const STRATEGIES_BY_DIFFICULTY = [...VARIANT_STRATEGIES];

/**
 * @param {string} strategyId
 * @returns {boolean}
 */
export function isSimpleVariantStrategy(strategyId) {
  return SIMPLE_VARIANT_STRATEGY_IDS.includes(strategyId);
}

/**
 * @param {string} creatorStrategyId
 * @returns {Array<{ id: string, label: string, hint?: string }>}
 */
export function getCompletionChoicesForStrategy(creatorStrategyId) {
  const base = [COMPLETION_LEVELS.unsolvable, COMPLETION_LEVELS.strategy_faithful];
  if (isSimpleVariantStrategy(creatorStrategyId)) return base;
  return [...base, COMPLETION_LEVELS.creative];
}

/**
 * @param {string} strategyId
 * @returns {{ id: string, title: string, evalBlurb: string } | null}
 */
export function getStrategyEvalOption(strategyId) {
  const s = VARIANT_STRATEGIES.find((x) => x.id === strategyId);
  if (!s) return null;
  return { id: s.id, title: s.title, evalBlurb: s.evalBlurb || s.blurb || '' };
}

/** 평가 1 — 전략 선택지 (난이도 순) */
export function getStrategyEvalOptions() {
  return STRATEGIES_BY_DIFFICULTY.map((s) => ({
    id: s.id,
    title: s.title,
    evalBlurb: s.evalBlurb || s.blurb || '',
  }));
}
