import {
  fixOcrBrokenTextCommand,
  normalizeElementaryScriptDollars,
  rewriteMessyVerticalMultiplyDollars,
} from './elementaryMathScript';
import { parseMultVertLatex } from './inlineMathStorage';
import { normalizeVerticalScriptsInText } from './verticalArithmeticCells';

/** OCR·시험 빈칸 — 괄호·대괄호 안 공백 칸 수 (통일) */
export const EXAM_BLANK_INNER_SPACES = 10;
/** @deprecated — EXAM_BLANK_INNER_SPACES 와 동일 */
export const PAREN_BLANK_INNER_SPACES = EXAM_BLANK_INNER_SPACES;

const BLANK_INNER_PAD = ' '.repeat(EXAM_BLANK_INNER_SPACES);
/** 긴 직사각형 빈칸 — 대괄호 */
export const EXAM_LONG_BLANK = `[${BLANK_INNER_PAD}]`;
const PAREN_INNER_PAD = BLANK_INNER_PAD;

const LONG_BLANK_INNER_RE = /\[(\s*)\]/g;
const HORIZONTAL_TIMES_BLANK_RE = /(\d+)\s*[×x*＊]\s*(\d+)\s*=\s*\[[\s]*\]/;

/** `47×4=[ ]`·`…=□` 등 답란 줄이 있는지 (단원평가 검수 빈칸 UI 전환용) */
export const EXAM_BLANK_LINE_HINT_RE = /=\s*$|=\s*□|=\s*\[\s*\]|=\s*\[\s{6,}\]/;

export function hasExamAnswerBlankLines(text) {
  return EXAM_BLANK_LINE_HINT_RE.test(normalizeExamQuestionText(text || ''));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** (답: [ ] ), ( [ ] ) — 괄호가 빈칸이면 [] 제거 */
const PAREN_ANSWER_BLANK_RE = /\(답:\s*\[\s*\]\s*\)/g;
const PAREN_ONLY_BLANK_RE = /\(\s*\[\s*\]\s*\)/g;
/** OCR이 `(답: )`, `( )`처럼 공백이 적게 인식된 소괄호 빈칸 — 안쪽 공백 10칸 */
const PAREN_ANSWER_EMPTY_RE = new RegExp(`\\(답:\\s{0,${EXAM_BLANK_INNER_SPACES - 1}}\\)`, 'g');
const PAREN_WHITESPACE_ONLY_RE = new RegExp(`\\(\\s{0,${EXAM_BLANK_INNER_SPACES - 1}}\\)`, 'g');
const PAREN_SPACES_BLANK = `(${PAREN_INNER_PAD})`;
const PAREN_ANSWER_SPACES_BLANK = `(답:${PAREN_INNER_PAD})`;

/** `[     ] (\text{ㄱ})`·`[] (ㄱ)` → `[  (ㄱ)  ]` / `[  ㉠  ]` */
const LABELED_BLANK_SUFFIX_RE =
  /\[\s{3,}\]\s*(?:\(\\text\{([ㄱ-ㅎ])\}\)|\(([ㄱ-ㅎ])\)|([㉠-㉣]))/gu;
const EMPTY_BRACKET_LABEL_RE = /\[\s*\]\s*\(([ㄱ-ㅎ])\)/gu;
const TEXT_LABEL_COLON_RE = /\\text\{([ㄱ-ㅎ㉠-㉣])\}\s*:/gu;

function labeledBlankInner(label) {
  if (!label) return label;
  if (/^[\u3260-\u3267]$/.test(label) || /^[㉠-㉣]$/.test(label)) return label;
  if (label.length === 1 && label >= 'ㄱ' && label <= 'ㅎ') return `(${label})`;
  return label;
}

export function normalizeLabeledBlankBoxes(text) {
  if (text == null || text === '') return text ?? '';
  let s = String(text);
  s = s.replace(LABELED_BLANK_SUFFIX_RE, (_full, g1, g2, g3) => {
    const label = g1 || g2 || g3;
    return `[  ${labeledBlankInner(label)}  ]`;
  });
  s = s.replace(EMPTY_BRACKET_LABEL_RE, (_full, g1) => `[  (${g1})  ]`);
  s = s.replace(TEXT_LABEL_COLON_RE, '$1:');
  return s;
}

/** `$…$` 안이 같은 피연산자의 세로 곱셈 array/MULTVERT 인지 */
function isRedundantVerticalMultiplyBlock(inner, a, b) {
  const t = String(inner ?? '').trim();
  if (!t.includes(a) || !t.includes(b)) return false;
  if (!/\\begin\{array\}|MULTVERT|\\times|×/.test(t)) return false;
  if (parseMultVertLatex(t)) return true;
  return (
    /\\begin\{array\}\{r\}/.test(t) &&
    /\\times|×/.test(t) &&
    /\\hline/.test(t)
  );
}

/**
 * 가로 `47×4=[          ]` 가 있으면 OCR이 넣은 줄단위 세로곱(47 / × / 4 / = / []) 제거.
 */
export function stripPlainTextRedundantVerticalMultiply(text) {
  if (text == null || text === '') return text ?? '';
  let s = String(text);
  const hm = HORIZONTAL_TIMES_BLANK_RE.exec(s);
  if (!hm) return s;
  const a = escapeRegExp(hm[1]);
  const b = escapeRegExp(hm[2]);
  const vertStack = new RegExp(
    `(?:^|\\n)` +
      `(?:\\s*${a}\\s*\\n)` +
      `(?:\\s*[×x*＊]\\s*\\n)` +
      `(?:\\s*${b}\\s*\\n)` +
      `(?:\\s*=\\s*\\n)` +
      `(?:\\s*\\[\\s*\\]\\s*\\n?)`,
    'gm',
  );
  s = s.replace(vertStack, '\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 가로 `176×76=[     ]` 와 같은 줄이 있으면, 같은 수의 세로곱 `$…$` 블록 제거.
 * (편집기 세로 칩 + 가로 줄이 같이 있으면 복붙 시 세로 배치가 따라옴)
 */
export function stripRedundantVerticalMultiplyLatex(text) {
  let s = String(text ?? '');
  const pm = s.match(HORIZONTAL_TIMES_BLANK_RE);
  if (!pm) return s;
  const a = pm[1];
  const b = pm[2];

  const drop = (full, inner) =>
    isRedundantVerticalMultiplyBlock(inner, a, b) ? '' : full;

  s = s.replace(/\$\$([\s\S]+?)\$\$/g, drop);
  s = s.replace(/\$([^$\n]+)\$/g, drop);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 소괄호·대괄호 그룹 안의 `[]`·`[          ]` → 공백 패딩만 (괄호 중복 방지) */
function unwrapBracketBlanksInGroupContent(inner) {
  return String(inner).replace(/\[\s*\]/g, BLANK_INNER_PAD);
}

/**
 * `(답: [ ] )`, `( [ ] )`, `(몫: [          ], 나머지: [          ])` 등
 * → 괄호 안에는 공백만. `(답: )`, `( )` 등 짧은 공백도 10칸으로 맞춤.
 */
export function unwrapBlankBracketsInsideParens(text) {
  if (text == null || text === '') return text ?? '';
  let s = String(text)
    .replace(PAREN_ANSWER_BLANK_RE, PAREN_ANSWER_SPACES_BLANK)
    .replace(PAREN_ONLY_BLANK_RE, PAREN_SPACES_BLANK)
    .replace(PAREN_ANSWER_EMPTY_RE, PAREN_ANSWER_SPACES_BLANK)
    .replace(PAREN_WHITESPACE_ONLY_RE, PAREN_SPACES_BLANK);
  s = s.replace(/\(([^()]*)\)/g, (full, inner) => {
    if (!/\[\s*\]/.test(inner)) return full;
    return `(${unwrapBracketBlanksInGroupContent(inner)})`;
  });
  s = s.replace(/\[([^\[\]]*)\]/g, (full, inner) => {
    if (!/\[\s*\]/.test(inner)) return full;
    return `[${unwrapBracketBlanksInGroupContent(inner)}]`;
  });
  return s;
}

/** contentEditable 직렬화 등으로 늘어난 빈 줄 축소 */
export function collapseExamQuestionNewlines(text) {
  return String(text ?? '').replace(/\n{3,}/g, '\n\n');
}

/** `[]`·`[  ]` 등 → `[          ]` (공백만 있으면 항상 10칸으로 고정). `[분수:…]`·`[  ㉠  ]` 등은 제외. */
export function normalizeLongBlankBrackets(text) {
  if (text == null || text === '') return text ?? '';
  let s = unwrapBlankBracketsInsideParens(text);
  return s.replace(LONG_BLANK_INNER_RE, (full, inner) =>
    /^\s*$/.test(inner) ? EXAM_LONG_BLANK : full,
  );
}

/** `]` 뒤·숫자 뒤 빈칸 대괄호 앞 불필요 공백 제거 (`9[          ] × 82` → `9[          ]× 82`) */
export function collapseBlankBracketOperatorSpaces(text) {
  if (text == null || text === '') return text ?? '';
  let s = String(text).replace(/\u00A0/g, ' ');
  s = s.replace(/(\d)\s+(\[)/g, '$1$2');
  s = s.replace(/(\])\s+([×x*＊÷+\-=])/g, '$1$2');
  return s;
}

/** OCR·parse-problem 직후 question 등에 적용 */
export function normalizeExamQuestionText(text) {
  return normalizeVerticalScriptsInText(
    normalizeLabeledBlankBoxes(
      collapseBlankBracketOperatorSpaces(
        normalizeLongBlankBrackets(
          stripPlainTextRedundantVerticalMultiply(
            stripRedundantVerticalMultiplyLatex(
              normalizeElementaryScriptDollars(
                rewriteMessyVerticalMultiplyDollars(
                  fixOcrBrokenTextCommand(collapseExamQuestionNewlines(text)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** 표 셀·지문에서 긴 빈칸 기호인지 (`□` 또는 공백만 있는 `[]`) */
export function isExamLongBlankBracket(value) {
  const t = String(value ?? '').trim();
  if (t === '□') return true;
  return /^\[\s*\]$/.test(t);
}

/** contentEditable·renderMathText 공통 — 빈칸 스팬 클래스 */
export const EXAM_INLINE_BLANK_CLASS = 'exam-inline-blank';
export const EXAM_INLINE_BLANK_DATA = 'data-exam-blank';

/** 화면에 그릴 빈칸 토큰(공백만·라벨+공백·라벨 포함 대괄호·소괄호) */
const EXAM_VISUAL_BLANK_RE =
  /(\[[\s]+\]|\(답:\s+\)|\([\s]+\)|[가-힣A-Za-z㉠-㉣]+:\s{10,}|\[[\s]*[^\s\[\]]+[\s]*\])/g;

function canonicalizeBlankToken(token) {
  const t = String(token ?? '');
  if (/^\[[\s]+\]$/.test(t)) return EXAM_LONG_BLANK;
  if (/^\(답:\s+\)$/.test(t)) return `(답:${PAREN_INNER_PAD})`;
  if (/^\([\s]+\)$/.test(t)) return `(${PAREN_INNER_PAD})`;
  const labeledParen = t.match(/^([가-힣A-Za-z㉠-㉣]+:)(\s+)$/);
  if (labeledParen) return `${labeledParen[1]}${PAREN_INNER_PAD}`;
  return t;
}

function blankTokenToDisplay(canonical) {
  return String(canonical).replace(/ /g, '\u00A0');
}

/**
 * @returns {{ type: 'text' | 'blank', value?: string, canonical?: string, display?: string }[]}
 */
export function splitExamBlankSegments(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const out = [];
  let last = 0;
  let m;
  const re = new RegExp(EXAM_VISUAL_BLANK_RE.source, 'g');
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: s.slice(last, m.index) });
    const canonical = canonicalizeBlankToken(m[0]);
    out.push({ type: 'blank', canonical, display: blankTokenToDisplay(canonical) });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ type: 'text', value: s.slice(last) });
  return out.length ? out : [{ type: 'text', value: s }];
}

/** contentEditable hydrate용 */
export function createExamBlankElement(canonical) {
  const span = document.createElement('span');
  span.className = EXAM_INLINE_BLANK_CLASS;
  span.setAttribute(EXAM_INLINE_BLANK_DATA, canonical);
  span.contentEditable = 'false';
  span.textContent = blankTokenToDisplay(canonical);
  return span;
}

/** 줄바꿈을 보존하며 DOM에 텍스트·빈칸 스팬 추가 */
export function appendTextWithExamBlanks(el, text) {
  const chunks = String(text ?? '').split('\n');
  chunks.forEach((line, lineIdx) => {
    if (lineIdx > 0) el.appendChild(document.createElement('br'));
    for (const seg of splitExamBlankSegments(line)) {
      if (seg.type === 'text') {
        if (seg.value) el.appendChild(document.createTextNode(seg.value));
      } else {
        el.appendChild(createExamBlankElement(seg.canonical));
      }
    }
  });
  if (chunks.length && chunks[chunks.length - 1] === '' && String(text).endsWith('\n')) {
    el.appendChild(document.createElement('br'));
  }
}
