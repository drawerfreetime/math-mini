import {
  normalizeExamQuestionText,
  unwrapBlankBracketsInsideParens,
  splitExamBlankSegments,
} from '../src/utils/examBlankBrackets.js';

const PAD = ' '.repeat(10);

const raw = '(몫: [          ], 나머지: [          ])';
const unwrapped = unwrapBlankBracketsInsideParens(raw);
const expected = `(몫:${PAD}, 나머지:${PAD})`;
if (unwrapped !== expected) {
  console.error('unwrap FAIL', JSON.stringify(unwrapped), 'want', JSON.stringify(expected));
  process.exit(1);
}

const norm = normalizeExamQuestionText(raw);
if (norm.includes('[          ]')) {
  console.error('normalize should not keep brackets inside parens', norm);
  process.exit(1);
}
if (!norm.includes(`몫:${PAD}`)) {
  console.error('normalize missing quotient blank', norm);
  process.exit(1);
}

const segs = splitExamBlankSegments(`(몫:${PAD}, 나머지:${PAD})`);
const blanks = segs.filter((s) => s.type === 'blank');
if (blanks.length !== 2) {
  console.error('expected 2 blank segments, got', blanks.length, segs);
  process.exit(1);
}

const chain = normalizeExamQuestionText(`15 × 9[          ] × 82[          ]`);
if (chain.includes('] ×') || chain.includes(']  ×')) {
  console.error('should collapse space between ] and ×', chain);
  process.exit(1);
}
if (!chain.includes(']× 82')) {
  console.error('expected ]× 82 in chain blank', chain);
  process.exit(1);
}

console.log('paren blank unwrap tests OK');
