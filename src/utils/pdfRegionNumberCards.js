/**
 * 「숫자 카드」 문항 — 카드 그림은 도형(hasImage)이 아니라 OCR 숫자 데이터로 취급.
 * (서버 server.py _normalize_number_cards_ocr 와 동일 정책)
 */

const NUMBER_CARD_Q_RE = /숫자\s*카드/;

export function isNumberCardStem(text) {
  return NUMBER_CARD_Q_RE.test(String(text || ''));
}

/** □ 빈칸·부분곱 분해식(316×25=ㄱ+ㄴ) — 장식 박스·화살표는 hasImage 아님 */
export function isBlankFillDecompositionStem(text) {
  const s = String(text || '');
  if (!/□\s*안에|써\s*넣|알맞은\s*수/.test(s)) return false;
  return /\d+\s*[×x＊*]\s*\d+/.test(s);
}

export function normalizeBlankFillArithmeticProblem(problem) {
  if (!problem) return problem;
  const combined = `${problem.question || ''}\n${problem.imageDescription || ''}`;
  if (!isBlankFillDecompositionStem(combined)) return problem;
  return {
    ...problem,
    hasImage: false,
    imageDescription: null,
  };
}

/** OCR·검수 결과에서 hasImage 를 끄고 텍스트 문항으로 정리 */
export function normalizeNumberCardProblem(problem) {
  if (!problem) return problem;
  const q = String(problem.question || '');
  const desc = String(problem.imageDescription || '');
  if (!isNumberCardStem(`${q}\n${desc}`)) return problem;
  return {
    ...problem,
    hasImage: false,
    imageDescription: null,
  };
}
