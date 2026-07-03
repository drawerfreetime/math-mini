/**
 * 수사연 — 전략별 무료 정적 가이드 (API 비용 없음)
 * 키: variantStrategies.js 의 id (change_numbers …)
 */

const DOMAIN_PATTERNS = [
  { re: /삼각형|사각형|평행사변형|원|각|도|넓이|둘레|부피|대칭|평행|수직|직육면체|정육면체/, tag: '도형' },
  { re: /나머지|나눗셈|몫|곱셈|덧셈|뺄셈|분수|소수|비율|비례|%,퍼센트/, tag: '연산·수' },
  { re: /시간|분|초|시속|거리|m\b|cm\b|km\b|리터|㎖|㎏/, tag: '측정' },
  { re: /규칙|배열|규칙을 찾|다음 수|틀린|규칙에 맞/, tag: '규칙·규칙찾기' },
];

/**
 * @param {string} problemPlain
 * @returns {string}
 */
function keywordSuffix(problemPlain) {
  const tags = [];
  const p = String(problemPlain || '');
  for (const { re, tag } of DOMAIN_PATTERNS) {
    if (re.test(p) && !tags.includes(tag)) tags.push(tag);
  }
  if (tags.length === 0) return '';
  return ` (연구원님 문제는 [${tags.join(', ')}] 느낌이에요. 예시를 그에 맞춰 보세요!)`;
}

/** @type {Record<string, { name: string; guide: string }>} */
export const STRATEGY_STATIC_BY_ID = {
  change_numbers: {
    name: '숫자 바꾸기',
    guide:
      '연구원님, 숫자를 다른 수로 바꿔볼까요? 단원의 계산 범위 안에서 숫자를 골라보세요!',
  },
  change_context: {
    name: '상황(이야기 배경) 바꾸기',
    guide:
      '연구원님, 배경을 우리 학교나 게임 속으로 옮기거나(배경 교체), 식에 어울리는 재미있는 이야기를 만들어 보세요(상황 만들기)!',
  },
  change_conditions: {
    name: '조건 변경하기',
    guide:
      '연구원님, 붙어 있는 규칙·조건 하나를 비틀어 보세요. 예: 세 식의 곱하는 수를 항상 같게↔식마다 다르게, 나눗셈에서 딱 나누어떨어짐↔나머지 생김·몫이 두 자리 수↔한 자리 수, 도형 모양 바꾸기.',
  },
  change_goal: {
    name: '구하는 것 바꾸기',
    guide:
      '연구원님, 식 구조는 그대로 두고 묻는 것만 바꿔 보세요. 예: 곱 결과를 주고 □에 (세 자리 수)를 찾게, 또는 크기 비교 대신 □×(두 자리 수)=(그 곱)처럼 같게 만드는 문제로 바꿔 보세요.',
  },
  add_conditions: {
    name: '조건 추가하기',
    guide:
      '연구원님, 지금 문제에 규칙을 하나 더해 보세요. 조건이 맞도록 식의 숫자를 바꿔도 돼요. 예: 세 식을 다 푼 뒤 정답이 네 자리 수인 것만 □에 쓰기, 7은 쓰지 않기, 곱해지는 수와 곱하는 수를 모두 홀수로 골라 각 곱이 홀수가 되게 하기.',
  },
  reverse_setup: {
    name: '역방향 구성',
    guide:
      '연구원님, 결과를 단서로 조건을 여러 가지 짜 보세요. 예: 넓이가 같은 직사각형을 여러 가지로 그리기, 7조각이면 전체=한 조각×7인 나눗셈 식·이야기를 여러 가지로 만들기.',
  },
};

/**
 * @param {string} strategyId  VARIANT_STRATEGIES[].id
 * @param {string} [problemPlain] 지금 문제 평문 — 도형/연산 등 힌트 접미사용
 * @returns {string}
 */
export function getStaticGuide(strategyId, problemPlain = '') {
  const row = STRATEGY_STATIC_BY_ID[strategyId];
  if (!row) return '';
  return row.guide + keywordSuffix(problemPlain);
}

export function getStaticStrategyName(strategyId) {
  return STRATEGY_STATIC_BY_ID[strategyId]?.name || '';
}
