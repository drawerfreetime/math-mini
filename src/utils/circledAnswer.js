/**
 * 해설지·AI 파싱 결과에 흔한 원문자(①②…)를 객관식 번호로 통일합니다.
 */

const CIRCLED_TO_NUM = {
  '①': 1,
  '②': 2,
  '③': 3,
  '④': 4,
  '⑤': 5,
  '⑥': 6,
  '⑦': 7,
  '⑧': 8,
  '⑨': 9,
  '⑩': 10,
};

/**
 * @param {*} raw 문자열 원문자, 숫자 문자열 등
 * @returns {number|*} 객관식이면 1~10 숫자, 아니면 원본 유지
 */
export function circledDigitsToMcNumber(raw) {
  if (raw == null || raw === '') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.round(raw);
    return n >= 1 && n <= 10 ? n : raw;
  }
  const s = String(raw).trim();
  if (!s.length) return raw;

  if (Object.prototype.hasOwnProperty.call(CIRCLED_TO_NUM, s)) return CIRCLED_TO_NUM[s];

  const first = s[0];
  if (CIRCLED_TO_NUM[first] != null) return CIRCLED_TO_NUM[first];

  const m = s.match(/^(\d+)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 10) return n;
  }

  return raw;
}

const CIRCLED_PREFIX_RE = /^[①②③④⑤⑥⑦⑧⑨⑩]+[\s.:)·]*/u;

/** 선지 입력란용 — UI가 ①~⑤ 라벨을 붙이므로 본문 앞 원숫자 제거 */
export function stripLeadingCircledFromChoiceText(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  while (s.length && CIRCLED_PREFIX_RE.test(s)) {
    s = s.replace(CIRCLED_PREFIX_RE, '').trim();
  }
  return s;
}

function normalizeProblemChoices(choices) {
  if (!Array.isArray(choices) || !choices.length) return choices;
  return choices.map((c) => stripLeadingCircledFromChoiceText(c));
}

/** 그룹·선잇기 제외 평문제: 선지 앞 원숫자 제거 + 객관식 정답 원문자→숫자 */
export function normalizeProblemsCircledMcAnswers(list) {
  if (!Array.isArray(list)) return list;
  return list.map((p) => {
    if (p.type === 'group' && Array.isArray(p.questions)) {
      return { ...p, questions: normalizeProblemsCircledMcAnswers(p.questions) };
    }
    if (p.problemType === '선잇기') return p;
    let next = p;
    if (p.choices?.length) {
      next = { ...next, choices: normalizeProblemChoices(p.choices) };
    }
    if (next.choices?.length && next.answer != null && next.answer !== '') {
      const nums = String(next.answer)
        .split(/[,，\s]+/)
        .map((s) => circledDigitsToMcNumber(s.trim()))
        .filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 1);
      next = {
        ...next,
        answer: nums.length ? [...nums].sort((a, b) => a - b).join(', ') : next.answer,
      };
    }
    return next;
  });
}
