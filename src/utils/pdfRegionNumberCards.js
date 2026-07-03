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

const OPERATION_BOX_STEM_RE = /상자|넣었더니|나왔/;
const OPERATION_BOX_FORMULA_RE = /\d+\s*[×x＊*÷+\-−]\s*□\s*=/;
const OPERATION_BOX_EXAMPLE_RE = /(\d+)\s*을?\s*넣었더니\s*(\d+)\s*이?\s*나왔/;
const OPERATION_BOX_DESC_FORMULA_RE = /(\d+)\s*([×x＊*÷+\-−])\s*□\s*=\s*(\d+)/;

function inferOperationBoxOp(text) {
  if (/[÷／/]|나누/.test(text)) return '÷';
  if (/(?<!\d)[\-−](?!\d)|빼/.test(text)) return '-';
  if (/\+|더하|합/.test(text)) return '+';
  return '×';
}

/** 연산 상자(160×□=8000) — 그림 식을 question 가로식으로 보강 */
export function normalizeOperationBoxProblem(problem) {
  if (!problem) return problem;
  const q = String(problem.question || '');
  const desc = String(problem.imageDescription || '');
  const combined = `${q}\n${desc}`;
  if (!OPERATION_BOX_STEM_RE.test(combined)) return problem;

  let newQ = q;
  if (!OPERATION_BOX_FORMULA_RE.test(q)) {
    const dm = desc.match(OPERATION_BOX_DESC_FORMULA_RE);
    if (dm) {
      let op = dm[2];
      if (op === 'x' || op === 'X' || op === '*' || op === '＊') op = '×';
      newQ = `${q.trim()}\n\n${dm[1]}${op}□=${dm[3]}`.trim();
    } else {
      const em = q.match(OPERATION_BOX_EXAMPLE_RE) || desc.match(OPERATION_BOX_EXAMPLE_RE);
      if (em) {
        const op = inferOperationBoxOp(combined);
        newQ = `${q.trim()}\n\n${em[1]}${op}□=${em[2]}`.trim();
      }
    }
  }

  return {
    ...problem,
    question: newQ,
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
