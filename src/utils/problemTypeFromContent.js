/**
 * OCR·추출 결과에서 problem_type 보정 (표 마크다운 등).
 */

const MD_TABLE_ROW = /^\s*\|[^\n|]+\|\s*$/m;
const MD_TABLE_SEP = /^\s*\|[\s\-:|]+\|\s*$/m;

/** question 등에 GitHub 마크다운 표가 포함됐는지 */
export function hasMarkdownTable(text) {
  const s = String(text ?? '');
  return MD_TABLE_ROW.test(s) && MD_TABLE_SEP.test(s);
}

/** ①②③④⑤ 선지가 3개 이상이면 객관식(기타)으로 본다 */
export function looksLikeMultipleChoice(text) {
  const s = String(text ?? '');
  return (s.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g) || []).length >= 3;
}

/**
 * 사전 분류·AI 유형·question 본문을 합쳐 최종 유형 결정.
 * @param {string} userHint  사용자/휴리스틱 확정 유형
 * @param {string} aiType    모델이 준 problem_type
 * @param {string} question  추출된 지문
 */
export function resolveProblemType(userHint, aiType, question) {
  const hint = String(userHint || '').trim();
  if (hint) return hint;
  const ai = String(aiType || '기타').trim();
  if (ai === '표' || ai === '선잇기' || ai === '세로셈') return ai;
  if (hasMarkdownTable(question)) return '표';
  if (ai === '빈칸채우기' && looksLikeMultipleChoice(question)) return '기타';
  return ai || '기타';
}
