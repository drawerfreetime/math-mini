/**
 * 시험지 빈칸 처리 유틸리티
 */

export const EXAM_BLANK_INNER_SPACES = 10;
/** @deprecated */
export const PAREN_BLANK_INNER_SPACES = EXAM_BLANK_INNER_SPACES;

const BLANK_INNER_PAD = ' '.repeat(EXAM_BLANK_INNER_SPACES);
export const EXAM_LONG_BLANK = `[${BLANK_INNER_PAD}]`;
export const EXAM_BLANK_LINE_HINT_RE = /=\s*$|=\s*□|=\s*\[\s*\]|=\s*\[\s{6,}\]/;

export function hasExamAnswerBlankLines(_text) { return false; }
export function normalizeLabeledBlankBoxes(_text) { return _text ?? ''; }
export function stripPlainTextRedundantVerticalMultiply(_text) { return _text ?? ''; }
export function stripRedundantVerticalMultiplyLatex(_text) { return _text ?? ''; }
export function unwrapBlankBracketsInsideParens(_text) { return _text ?? ''; }
export function collapseExamQuestionNewlines(_text) { return _text ?? ''; }
export function normalizeLongBlankBrackets(_text) { return _text ?? ''; }
export function collapseBlankBracketOperatorSpaces(_text) { return _text ?? ''; }
export function normalizeExamQuestionText(_text) { return _text ?? ''; }
export function isExamLongBlankBracket(_value) { return false; }

export const EXAM_INLINE_BLANK_CLASS = 'exam-inline-blank';
export const EXAM_INLINE_BLANK_DATA = 'data-exam-blank';

export function splitExamBlankSegments(_text) { return []; }
export function createExamBlankElement(_canonical) { return document.createElement('span'); }
export function appendTextWithExamBlanks(_el, _text) {}
