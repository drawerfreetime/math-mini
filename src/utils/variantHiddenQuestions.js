/** 변형 목록(기존 문제 변형하기)에서 숨긴 문항 번호 */
export function normalizeVariantHiddenQuestionNumbers(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((n) => Number(n)).filter((n) => Number.isFinite(n)))];
}

export function getVariantHideNumbersForProblem(problem) {
  if (!problem) return [];
  if (problem.type === 'group') {
    return normalizeVariantHiddenQuestionNumbers(
      (problem.questions || []).map((q) => q?.number),
    );
  }
  const n = Number(problem.number);
  return Number.isFinite(n) ? [n] : [];
}

export function isProblemHiddenFromVariantList(problem, hiddenNumbers) {
  const hidden = new Set(normalizeVariantHiddenQuestionNumbers(hiddenNumbers));
  const nums = getVariantHideNumbersForProblem(problem);
  return nums.length > 0 && nums.every((n) => hidden.has(n));
}
