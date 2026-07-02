/**
 * 문제 만들기 전략 튜토리얼 — 하드코딩 샘플 (전략 6개)
 */
import { VARIANT_STRATEGIES } from './variantStrategies';

export const VARIANT_STRATEGY_TUTORIAL_VERSION = 'v1';

/** @typedef {{ id: string; original: string; variant: string; peerChecks: { research_ethics_ok: boolean; answer_ok: boolean; solution_ok: boolean } }} TutorialStep */

/** @type {TutorialStep[]} */
export const VARIANT_STRATEGY_TUTORIAL_STEPS = [
  {
    id: 'change_numbers',
    original: '352 × 53 = □',
    variant: '418 × 67 = □',
    peerChecks: { research_ethics_ok: true, answer_ok: true, solution_ok: true },
  },
  {
    id: 'change_context',
    original: '한 상자에 사과가 24개 있습니다. 3상자에 사과는 모두 몇 개인가요?',
    variant: '한 바구니에 공이 24개 있습니다. 3바구니에 공은 모두 몇 개인가요?',
    peerChecks: { research_ethics_ok: true, answer_ok: true, solution_ok: true },
  },
  {
    id: 'change_conditions',
    original: '□ 안에 알맞은 수를 써넣으세요. 12 + □ = 20',
    variant: '□ 안에 알맞은 수를 써넣으세요. 12 + □ = 20 (□는 10보다 작은 수)',
    peerChecks: { research_ethics_ok: true, answer_ok: true, solution_ok: false },
  },
  {
    id: 'change_goal',
    original: '가로 8cm, 세로 5cm인 직사각형의 넓이는 몇 cm²인가요?',
    variant: '넓이가 40cm²인 직사각형의 가로가 8cm일 때, 세로는 몇 cm인가요?',
    peerChecks: { research_ethics_ok: true, answer_ok: true, solution_ok: true },
  },
  {
    id: 'add_conditions',
    original: '48 ÷ 6 = □',
    variant: '48 ÷ 6 = □ (나머지가 있으면 나머지도 써넣으세요)',
    peerChecks: { research_ethics_ok: true, answer_ok: true, solution_ok: true },
  },
  {
    id: 'reverse_setup',
    original: '7 × 9 = 63',
    variant: '곱이 63이 되도록 □ × 9 = 63 에서 □에 알맞은 수를 써넣으세요.',
    peerChecks: { research_ethics_ok: true, answer_ok: true, solution_ok: true },
  },
];

export function getTutorialStrategyMeta(strategyId) {
  return VARIANT_STRATEGIES.find((s) => s.id === strategyId) || null;
}

export function buildTutorialStrategyOptions(correctId) {
  const correct = getTutorialStrategyMeta(correctId);
  const others = VARIANT_STRATEGIES.filter((s) => s.id !== correctId);
  const options = correct ? [correct, ...others.slice(0, 5)] : VARIANT_STRATEGIES.slice(0, 6);
  return options.sort(() => Math.random() - 0.5).map((s) => ({
    id: s.id,
    title: s.title,
    evalBlurb: s.evalBlurb || s.blurb,
  }));
}
