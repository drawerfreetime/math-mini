/**
 * 기존 문제 변형하기 — 변형 전략 (표시용 메타데이터)
 */
export const VARIANT_STRATEGIES = [
  {
    id: 'change_numbers',
    title: '숫자 바꾸기',
    blurb: '숫자만 달라졌어요',
    evalBlurb: '숫자만 달라졌어요',
  },
  {
    id: 'change_context',
    title: '상황 바꾸기',
    blurb: '이야기가 달라졌어요',
    evalBlurb: '이야기가 달라졌어요/이야기가 생겼어요',
  },
  {
    id: 'change_conditions',
    title: '조건 바꾸기',
    blurb: '규칙이나 조건이 바뀌었어요',
    evalBlurb: '규칙이나 조건이 바뀌었어요',
  },
  {
    id: 'change_goal',
    title: '구하는 것 바꾸기',
    blurb: '묻는 것만 바꿨어요',
    evalBlurb: '묻는 것만 바꿨어요',
  },
  {
    id: 'add_conditions',
    title: '조건 추가하기',
    blurb: '조건이 더 생겼어요',
    evalBlurb: '조건이 더 생겼어요',
  },
  {
    id: 'reverse_setup',
    title: '역방향 구성',
    blurb: '결과를 보고 거꾸로 문제를 만들었어요',
    evalBlurb: '결과를 보고 거꾸로 문제를 만들었어요',
  },
];

/**
 * 변형 전략 보너스 탐구점수 (문제 만들기 승인 시 1회 추가 적립)
 * - 단순 변형: +2
 * - 구조 변형: +4
 * - 고난도 설계: +6
 */
export const VARIANT_STRATEGY_BONUS_POINTS = {
  change_numbers: 2,
  change_context: 2,
  change_conditions: 4,
  change_goal: 4,
  add_conditions: 6,
  reverse_setup: 6,
};
