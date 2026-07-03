/**
 * 인라인 저장 포맷:
 * - 일반 텍스트 + $LaTeX$ 수식 칩 + ⟦UNIT:…⟧ 원자 단위
 * Firestore 저장용.
 */
import katex from 'katex';
import { isComplexLatexForPlainTransform, latexToPlain } from './latexPlainTransform';
import {
  BARGRAPH_MARK,
  BARGRAPH_END,
  INLINE_BARGRAPH_CLASS,
  decodeBarGraphPayload,
  normalizeBarGraphConfig,
} from './barGraphStorage';
import {
  EXAM_INLINE_BLANK_CLASS,
  EXAM_INLINE_BLANK_DATA,
  appendTextWithExamBlanks,
} from './examBlankBrackets';
import { normalizeVerticalArithmeticRow } from './verticalArithmeticCells';

/** @typedef {{ type: 'text' | 'math' | 'unit' | 'bargraph', v: string }} InlinePart */

export const INLINE_MATH_FROZEN_CLASS = 'inline-math-frozen';
export const INLINE_ATOMIC_UNIT_CLASS = 'inline-math-atomic-unit';

const UNIT_MARK = '⟦UNIT:';
const UNIT_END = '⟧';

/** index.css Noto 다국어 스택과 동일 (인라인 HTML style용) */
const INLINE_UI_FONT_SERIF =
  "'Noto Sans', 'Noto Sans KR', 'Noto Sans SC', 'Noto Sans TC', 'Noto Sans JP', 'Noto Sans Arabic', serif";

/** 교과서·툴바 표시용: ²³(유니코드) 또는 단위 뒤 ASCII 2·3 → 윗첨자 세그먼트 */
/** @typedef {{ type: 'text' | 'sup'; v: string }} UnitDisplayPart */

/**
 * 단위 문자열을 텍스트/윗첨자 조각으로 나눈다 (예: mm², cm³, 레거시 mm2).
 * @param {string} unit
 * @returns {UnitDisplayPart[]}
 */
export function parseUnitDisplaySegments(unit) {
  const u = String(unit ?? '');
  if (!u) return [];

  const hasUnicodePow = /[²³]/.test(u);
  if (!hasUnicodePow) {
    const m = u.match(/^([a-zA-Z]+)([23])$/);
    if (m) {
      return [
        { type: 'text', v: m[1] },
        { type: 'sup', v: m[2] },
      ];
    }
    return [{ type: 'text', v: u }];
  }

  /** @type {UnitDisplayPart[]} */
  const out = [];
  let i = 0;
  while (i < u.length) {
    if (u[i] === '²') {
      out.push({ type: 'sup', v: '2' });
      i += 1;
      continue;
    }
    if (u[i] === '³') {
      out.push({ type: 'sup', v: '3' });
      i += 1;
      continue;
    }
    let j = i;
    while (j < u.length && u[j] !== '²' && u[j] !== '³') j += 1;
    if (j > i) out.push({ type: 'text', v: u.slice(i, j) });
    i = j;
  }
  return out;
}

/**
 * 교과서형 단위 KaTeX: mm² → \mathrm{mm}^{2}
 * @param {string} unit canonical (parseUnitDisplaySegments 호환)
 * @returns {string}
 */
export function unitCanonicalToKatexLatex(unit) {
  const parts = parseUnitDisplaySegments(unit);
  if (parts.length === 2 && parts[0].type === 'text' && parts[1].type === 'sup') {
    const base = parts[0].v;
    const pow = parts[1].v;
    return `\\mathrm{${base}}^{${pow}}`;
  }
  if (parts.length === 1 && parts[0].type === 'text') {
    return `\\mathrm{${parts[0].v}}`;
  }
  const fallback = String(unit ?? '').replace(/[#$%&_{}]/g, '');
  return fallback ? `\\mathrm{${fallback}}` : '\\;';
}

/**
 * @param {string} input
 * @returns {InlinePart[]}
 */
export function parseInlineMathStorage(input) {
  const s = String(input ?? '');
  if (!s) return [{ type: 'text', v: '' }];

  /** @type {InlinePart[]} */
  const parts = [];
  let i = 0;
  let textBuf = '';

  /** @param {string} chunk */
  function flushText(chunk) {
    if (!chunk) return;
    const prev = parts[parts.length - 1];
    if (prev && prev.type === 'text') prev.v += chunk;
    else parts.push({ type: 'text', v: chunk });
  }

  while (i < s.length) {
    if (s.startsWith(BARGRAPH_MARK, i)) {
      flushText(textBuf);
      textBuf = '';
      const start = i + BARGRAPH_MARK.length;
      const end = s.indexOf(BARGRAPH_END, start);
      if (end === -1) {
        textBuf += s.slice(i);
        break;
      }
      const payload = s.slice(start, end);
      const cfg = decodeBarGraphPayload(payload);
      if (cfg) {
        parts.push({ type: 'bargraph', v: payload });
      } else {
        parts.push({ type: 'text', v: s.slice(i, end + BARGRAPH_END.length) });
      }
      i = end + BARGRAPH_END.length;
      continue;
    }
    if (s.startsWith(UNIT_MARK, i)) {
      flushText(textBuf);
      textBuf = '';
      const start = i + UNIT_MARK.length;
      const end = s.indexOf(UNIT_END, start);
      if (end === -1) {
        textBuf += s.slice(i);
        break;
      }
      try {
        parts.push({ type: 'unit', v: decodeURIComponent(s.slice(start, end)) });
      } catch {
        parts.push({ type: 'text', v: s.slice(i, end + UNIT_END.length) });
      }
      i = end + UNIT_END.length;
      continue;
    }
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === '$' || n === '\\') {
        textBuf += n === '$' ? '$' : '\\';
        i += 2;
        continue;
      }
    }
    if (s[i] === '$') {
      flushText(textBuf);
      textBuf = '';
      const j = s.indexOf('$', i + 1);
      if (j === -1) {
        textBuf += s.slice(i);
        break;
      }
      parts.push({ type: 'math', v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    textBuf += s[i];
    i++;
  }
  flushText(textBuf);
  if (parts.length === 0) return [{ type: 'text', v: '' }];
  return parts;
}

/**
 * @param {HTMLElement} el contenteditable 루트
 * @returns {string}
 */
export function serializeContentEditable(el) {
  if (!el) return '';

  /** @param {string} v */
  function escapePlain(v) {
    return v.replace(/\\/g, '\\\\').replace(/\$/g, '\\$');
  }

  /** @param {Node} node */
  function walk(node) {
    let out = '';
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) {
        out += escapePlain(c.textContent || '');
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const tag = c.nodeName.toLowerCase();
        if (tag === 'br') {
          out += '\n';
        } else if (tag === 'div') {
          if (out && !out.endsWith('\n')) out += '\n';
          out += walk(c);
        } else if (
          tag === 'span' &&
          /** @type {HTMLElement} */ (c).classList?.contains(INLINE_ATOMIC_UNIT_CLASS)
        ) {
          const unit = String(
            /** @type {HTMLElement} */ (c).getAttribute('data-unit') ?? ''
          );
          out += UNIT_MARK + encodeURIComponent(unit) + UNIT_END;
        } else if (
          tag === 'div' &&
          /** @type {HTMLElement} */ (c).classList?.contains(INLINE_BARGRAPH_CLASS)
        ) {
          const payload = String(
            /** @type {HTMLElement} */ (c).getAttribute('data-bar-graph') ?? ''
          );
          if (payload) {
            out += BARGRAPH_MARK + payload + BARGRAPH_END;
          }
        } else if (
          tag === 'span' &&
          /** @type {HTMLElement} */ (c).classList?.contains(EXAM_INLINE_BLANK_CLASS)
        ) {
          out += String(
            /** @type {HTMLElement} */ (c).getAttribute(EXAM_INLINE_BLANK_DATA) ??
              (c.textContent || '').replace(/\u00A0/g, ' '),
          );
        } else if (
          tag === 'span' &&
          /** @type {HTMLElement} */ (c).classList?.contains(INLINE_MATH_FROZEN_CLASS)
        ) {
          const latex = String(
            /** @type {HTMLElement} */ (c).getAttribute('data-latex') ?? ''
          ).trim();
          out += '$' + latex + '$';
        } else if (tag === 'math-field') {
          /** @type {{ value?: string }} */
          const mf = c;
          const latex = String(mf.value ?? '').trim();
          out += '$' + latex + '$';
        } else {
          out += walk(c);
        }
      }
    }
    return out;
  }

  return walk(el);
}

/**
 * @param {string} unit canonical (예 mm², 저장·data-unit 값)
 */
export function buildUnitDisplayFragment(unit) {
  const frag = document.createDocumentFragment();
  for (const part of parseUnitDisplaySegments(unit)) {
    if (part.type === 'text') {
      frag.appendChild(document.createTextNode(part.v));
    } else {
      const sup = document.createElement('sup');
      sup.className = 'inline-math-atomic-unit__sup';
      sup.textContent = part.v;
      frag.appendChild(sup);
    }
  }
  return frag;
}

/**
 * @param {string} unit
 * @returns {HTMLSpanElement}
 */
/**
 * @param {import('./barGraphStorage').BarGraphConfig} config
 * @returns {HTMLDivElement}
 */
export function createBarGraphChipElement(config) {
  const norm = normalizeBarGraphConfig(config);
  const payload = encodeURIComponent(JSON.stringify(norm));
  const wrap = document.createElement('div');
  wrap.className = INLINE_BARGRAPH_CLASS;
  wrap.contentEditable = 'false';
  wrap.setAttribute('data-bar-graph', payload);
  wrap.setAttribute('tabindex', '-1');

  const label = document.createElement('div');
  label.className = 'inline-bar-graph-chip__label';
  label.textContent = '📊 막대그래프 (탭하여 수정)';
  wrap.appendChild(label);

  const mount = document.createElement('div');
  mount.className = 'inline-bar-graph-chip__mount';
  mount.setAttribute('data-bar-graph-mount', '1');
  wrap.appendChild(mount);

  return wrap;
}

/**
 * @param {HTMLDivElement} chip
 * @param {import('./barGraphStorage').BarGraphConfig} config
 */
export function updateBarGraphChipElement(chip, config) {
  const norm = normalizeBarGraphConfig(config);
  chip.setAttribute('data-bar-graph', encodeURIComponent(JSON.stringify(norm)));
}

export function createAtomicUnitElement(unit) {
  const span = document.createElement('span');
  span.className = `${INLINE_ATOMIC_UNIT_CLASS} math-textbook-unit`;
  span.contentEditable = 'false';
  span.setAttribute('data-unit', unit);
  span.setAttribute('tabindex', '-1');
  span.appendChild(buildUnitDisplayFragment(unit));
  return span;
}

// ── 세로 나눗셈 인라인 스타일 렌더링 ──────────────────────────────────────

/** @param {string} s */
function escapeHTML(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** OCR·프롬프트 이중 중괄호 `{{45}}` → `{45}` (LONGDIV/MULTVERT/LADDER) */
function normalizeElementaryScriptBraces(s) {
  const t = String(s ?? '').trim();
  if (!/^(LONGDIV|MULTVERT|LADDER)\s*\{/i.test(t)) return t;
  return t.replace(/\{\{/g, '{').replace(/\}\}/g, '}');
}

/**
 * 저장된 LONGDIV LaTeX/스크립트 패턴을 분해한다.
 * 패턴 A (신형식): LONGDIV {d} {n} {q} [STEPS {s1#s2}]
 * 패턴 B (구형식): \begin{array}{r}q\\[-3pt]d\kern-2pt\Big)\kern-2pt n\end{array}
 * @param {string} latex
 * @returns {{ quotient: string; divisor: string; dividend: string; steps: string[] } | null}
 */
function parseLongDivLatex(latex) {
  const s = normalizeElementaryScriptBraces(String(latex).trim());
  // 신형식: LONGDIV {d} {n} {q} [STEPS {…}]
  const newFmt = s.match(
    /^LONGDIV\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}(?:\s+STEPS\s+\{([^}]*)\})?\s*$/i
  );
  if (newFmt) {
    const steps = newFmt[4] ? newFmt[4].split('#').map(x => x.trim()) : [];
    return {
      divisor:  newFmt[1].trim(),
      dividend: newFmt[2].trim(),
      quotient: newFmt[3].trim(),
      steps,
    };
  }
  // 구형식: KaTeX array
  const m = s.match(
    /^\\begin\{array\}\{r\}(.+?)\\\\(?:\[.*?\])?(.+?)\\kern-2pt\\Big\)\\kern-2pt(.+?)\\end\{array\}$/
  );
  if (!m) return null;
  /** @param {string} v */
  function extractVal(v) {
    const t = v.trim();
    const textMatch = t.match(/^\\text\{([^}]*)\}$/);
    if (textMatch) return textMatch[1];
    if (t === '\\;') return '';
    return t;
  }
  return {
    quotient: extractVal(m[1]),
    divisor:  extractVal(m[2]),
    dividend: extractVal(m[3]),
    steps:    [],
  };
}

/**
 * LADDER 스크립트를 파싱해 행 배열로 반환.
 * 각 행: { divisor: string, cells: string[] }
 * divisor가 빈 문자열이면 최종 행(나누는 수 없음).
 * @param {string} latex
 * @returns {{ rows: { divisor: string; cells: string[] }[] } | null}
 */
function parseLadderLatex(latex) {
  const s = String(latex).trim();
  const m = s.match(/^LADDER\s*\{([\s\S]*)\}\s*$/i);
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner) return null;
  const rows = inner.split(/\s*#\s*/).map(line => {
    const cells = line.trim().split(/\s*&\s*/).map(c => c.trim());
    const divisor = cells[0] || '';
    return { divisor, cells: cells.slice(1) };
  });
  return { rows };
}

/**
 * 약수/배수 사다리를 인라인 스타일만으로 렌더링 (contenteditable 삽입용).
 * @param {{ divisor: string; cells: string[] }[]} rows
 * @returns {string} HTML 문자열
 */
function buildLadderInlineHTML(rows) {
  const CELL_STYLE =
    'display:inline-flex;align-items:center;justify-content:center;' +
    'min-width:1.6em;padding:1px 4px;font-size:1em;font-family:' +
    INLINE_UI_FONT_SERIF +
    ';font-weight:600;';
  const DIVISOR_STYLE =
    'display:inline-flex;align-items:center;justify-content:flex-end;' +
    'min-width:2em;padding-right:4px;font-size:1em;font-family:' +
    INLINE_UI_FONT_SERIF +
    ';font-weight:600;';
  const BRACKET_STYLE =
    'border-left:2px solid #1e293b;border-bottom:2px solid #1e293b;' +
    'display:inline-flex;align-items:center;padding:2px 6px;gap:3px;';
  const NO_BRACKET_STYLE =
    'display:inline-flex;align-items:center;padding:2px 6px;gap:3px;';

  let html =
    '<span style="display:inline-flex;flex-direction:column;vertical-align:middle;' +
    'font-family:' + INLINE_UI_FONT_SERIF + ';">';

  rows.forEach((row, index) => {
    const isLast = index === rows.length - 1;
    const divisorHTML = row.divisor
      ? `<span style="${DIVISOR_STYLE}">${escapeHTML(row.divisor)}</span>`
      : `<span style="${DIVISOR_STYLE}"></span>`;
    const cellsHTML = row.cells
      .map(c => `<span style="${CELL_STYLE}">${escapeHTML(c)}</span>`)
      .join('');
    const wrapStyle = isLast ? NO_BRACKET_STYLE : BRACKET_STYLE;
    html +=
      `<span style="display:inline-flex;align-items:stretch;margin-bottom:1px;">` +
      divisorHTML +
      `<span style="${wrapStyle}">${cellsHTML}</span>` +
      '</span>';
  });

  html += '</span>';
  return html;
}


/**
 * MULTVERT 를 파싱해 rows 배열로 반환.
 * 두 가지 입력 형식을 모두 받는다:
 *   1) 신형 스크립트: `MULTVERT { rows: "r0 # r1 # r2" ; cols: N ; divLine: K ; opRow: J }`
 *      — 모델·수식 입력기에서 즐겨 쓰는 컴팩트 형태.
 *   2) 캐노니컬 KaTeX array: `\begin{array}{rr…} …\\ \times … \\ \hline …\end{array}`
 *      — `elementaryScriptToLatex` 가 (1) 을 변환한 결과 형태.
 * @param {string} latex
 * @returns {{ rows: string[]; opRow: number } | null}
 */
export function parseMultVertLatex(latex) {
  const s = normalizeElementaryScriptBraces(String(latex).trim());
  // 1) 신형 스크립트
  const scrMatch = s.match(/^MULTVERT\s*\{([\s\S]*)\}\s*$/i);
  if (scrMatch) {
    const inner = scrMatch[1];
    const rowsMatch = inner.match(/rows\s*:\s*"([^"]*)"/);
    if (!rowsMatch) return null;
    const rows = rowsMatch[1].split('#').map((r) => normalizeVerticalArithmeticRow(r.trim()));
    if (rows.length === 0) return null;
    const opMatch = inner.match(/opRow\s*:\s*(\d+)/);
    const opRow = opMatch ? parseInt(opMatch[1], 10) : 1;
    return { rows, opRow };
  }
  // 2) 캐노니컬 KaTeX array (\begin{array}{rr...} ... \end{array}) — 열 ≥2 (단일 {r}는 나눗셈 구형식)
  const m = s.match(/^\\begin\{array\}\{(r{2,})\}([\s\S]*)\\end\{array\}$/);
  if (!m) return null;
  const body = m[2];
  // 행 분리 (\\로 구분)
  const rawRows = body.split(/\\\\\s*(?:\\hline\s*)?/);
  // 각 행: "op & d1 & d2 & ..." — op는 \times 또는 \phantom{\times}
  const rows = [];
  let opRow = 1;
  rawRows.forEach((row, ri) => {
    const trimmed = row.trim();
    if (!trimmed) return;
    // 열 분리
    const cols = trimmed.split('&').map(c => c.trim());
    const opCell = cols[0] || '';
    if (opCell.includes('\\times') && !opCell.includes('phantom')) opRow = ri;
    // 글자 셀 복원 (숫자 또는 \\text{…})
    const digits = cols.slice(1).map(c => {
      if (!c || c.includes('phantom')) return '';
      const textM = c.match(/^\\text\{([^}]*)\}$/);
      return textM ? textM[1] : c;
    }).join('');
    rows.push(digits);
  });
  if (rows.length === 0) return null;
  return { rows, opRow };
}

/** 곱셈·나눗셈 세로셈 공통 격자(점선) 스타일 */
const GRID_VERT_WRAP =
  'display:inline-flex;flex-direction:column;align-items:flex-end;' +
  'vertical-align:middle;border:1.5px solid #e2e8f0;border-radius:4px;overflow:hidden;' +
  'background:#fff;';

const GRID_DIGIT_CELL =
  'display:inline-flex;align-items:center;justify-content:center;' +
  'width:1.4em;height:1.6em;font-size:1em;font-family:' +
  INLINE_UI_FONT_SERIF +
  ';font-weight:600;border-left:1px solid #d1d5db;border-top:1px solid #d1d5db;';

const GRID_SIDE_CELL =
  'display:inline-flex;align-items:center;justify-content:center;' +
  'min-width:1.4em;height:1.6em;padding:0 2px;font-size:1em;font-family:' +
  INLINE_UI_FONT_SERIF +
  ';font-weight:600;border-left:1px solid #d1d5db;border-top:1px solid #d1d5db;';

const LONGDIV_PAREN_W = 11;

/**
 * @param {string[]} chars
 * @param {number} cols
 * @param {number} rowIndex
 */
function buildGridDigitCells(chars, cols, rowIndex) {
  const padLeft = Math.max(0, cols - chars.length);
  const padded = [...Array(padLeft).fill(''), ...chars];
  return padded
    .map((ch) => {
      const borderT = rowIndex === 0 ? '' : 'border-top:1px solid #e2e8f0;';
      const bg = ch ? 'background:#f0f9ff;color:#1d4ed8;' : '';
      return `<span style="${GRID_DIGIT_CELL}${borderT}${bg}">${ch ? escapeHTML(ch) : ''}</span>`;
    })
    .join('');
}

/**
 * 곱셈 세로셈을 인라인 스타일만으로 렌더링한다 (외부 CSS 불필요).
 * @param {string[]} rows 각 행 글자 나열 문자열
 * @param {number} opRow × 기호 행 인덱스
 * @returns {string} HTML 문자열
 */
function buildMultVertInlineHTML(rows, opRow) {
  const normRows = rows.map((r) => normalizeVerticalArithmeticRow(r));
  const cols = Math.max(1, ...normRows.map((r) => Array.from(r).length));

  let html = `<span style="${GRID_VERT_WRAP}">`;

  normRows.forEach((rowVal, ri) => {
    const isOp  = ri === opRow;
    const isDivLine = ri >= opRow && (ri - opRow) % 2 === 0 && ri < rows.length - 1;
    const bb = isDivLine ? 'border-bottom:3px solid #0f172a;' : '';
    const chars = Array.from(rowVal);
    const padLeft = Math.max(0, cols - chars.length);
    const paddedChars = [...Array(padLeft).fill('\0'), ...chars]; // \0 = 빈 칸

    html += `<span style="display:inline-flex;align-items:center;${bb}">`;
    html += `<span style="display:inline-flex;align-items:center;justify-content:center;` +
      `width:1.4em;height:1.6em;font-size:1em;font-weight:700;">${isOp ? '×' : ''}</span>`;
    paddedChars.forEach((ch) => {
      const empty = (ch === '\0');
      const borderT = ri === 0 ? '' : 'border-top:1px solid #e2e8f0;';
      const bg = empty ? '' : 'background:#f0f9ff;color:#1d4ed8;';
      html += `<span style="${GRID_DIGIT_CELL}${borderT}${bg}">${empty ? '' : escapeHTML(ch)}</span>`;
    });
    html += '</span>';
  });

  html += '</span>';
  return html;
}

/**
 * LONGDIV 수식을 인라인 스타일만으로 렌더링 (contenteditable·미리보기 공용).
 * 자릿수 열 정렬(곱셈 세로셈과 동일), 중간과정(steps) 포함.
 * @param {string} divisor  나누는 수
 * @param {string} dividend 나뉘는 수
 * @param {string} quotient 몫
 * @param {string[]} [steps] 중간과정 행 배열
 * @returns {string} HTML 문자열
 */
function buildLongDivInlineHTML(divisor, dividend, quotient, steps = []) {
  const dStr = normalizeVerticalArithmeticRow(divisor);
  const qChars = Array.from(normalizeVerticalArithmeticRow(quotient));
  const nChars = Array.from(normalizeVerticalArithmeticRow(dividend));
  const stepRows = (steps || []).map((sv) => Array.from(normalizeVerticalArithmeticRow(sv)));
  const cols = Math.max(
    1,
    nChars.length,
    qChars.length,
    ...stepRows.map((r) => r.length),
  );

  const parenBase =
    `display:inline-block;width:${LONGDIV_PAREN_W}px;height:1.6em;flex-shrink:0;` +
    'border-top:1px solid #d1d5db;';
  const parenCurve =
    parenBase +
    'border-right:3px solid #1e293b;border-top-right-radius:50%;border-bottom-right-radius:50%;' +
    'clip-path:inset(0 0 0 50%);align-self:flex-end;';

  /**
   * @param {number} ri
   * @param {string} sideText
   * @param {boolean} showParen
   * @param {string[]} digitChars
   * @param {boolean} thickTop
   */
  const row = (ri, sideText, showParen, digitChars, thickTop) => {
    const sideBorderT = ri === 0 ? '' : 'border-top:1px solid #e2e8f0;';
    const side =
      `<span style="${GRID_SIDE_CELL}${sideBorderT}color:#0f172a;">` +
      `${sideText ? escapeHTML(sideText) : ''}</span>`;
    const paren = showParen
      ? `<span style="${parenCurve}" aria-hidden="true"></span>`
      : `<span style="${parenBase}"></span>`;
    const digits = buildGridDigitCells(digitChars, cols, ri);
    const digitWrap = thickTop
      ? `<span style="display:inline-flex;border-top:3px solid #0f172a;">${digits}</span>`
      : `<span style="display:inline-flex;">${digits}</span>`;
    return `<span style="display:inline-flex;align-items:flex-end;">${side}${paren}${digitWrap}</span>`;
  };

  let html =
    `<span style="${GRID_VERT_WRAP}font-family:${INLINE_UI_FONT_SERIF};line-height:1.2;font-size:1em;">`;
  html += row(0, '', false, qChars, false);
  html += row(1, dStr, true, nChars, true);
  stepRows.forEach((sr, si) => {
    html += row(2 + si, '', false, sr, si % 2 === 1);
  });
  html += '</span>';
  return html;
}

/**
 * LONGDIV / MULTVERT / LADDER 인라인 HTML (없으면 null → KaTeX 폴백)
 * @param {string} latex
 * @returns {string | null}
 */
export function getElementaryMathInlineHtml(latex) {
  const s = normalizeElementaryScriptBraces(String(latex ?? '').trim());
  const longdiv = parseLongDivLatex(s);
  if (longdiv) {
    return buildLongDivInlineHTML(
      longdiv.divisor,
      longdiv.dividend,
      longdiv.quotient,
      longdiv.steps || [],
    );
  }
  const multvert = parseMultVertLatex(s);
  if (multvert) {
    return buildMultVertInlineHTML(multvert.rows, multvert.opRow);
  }
  const ladder = parseLadderLatex(s);
  if (ladder) {
    return buildLadderInlineHTML(ladder.rows);
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────

/**
 * 편집 불가 인라인 수식 조각 (KaTeX 렌더 또는 LONGDIV / MULTVERT 인라인 스타일)
 * @param {string} latex
 * @returns {HTMLSpanElement}
 */
export function createFrozenMathElement(latex) {
  const span = document.createElement('span');
  span.className = `${INLINE_MATH_FROZEN_CLASS} math-katex-wrap`;
  span.contentEditable = 'false';
  span.setAttribute('data-latex', latex);
  span.setAttribute('tabindex', '-1');

  const elemHtml = getElementaryMathInlineHtml(latex);
  if (elemHtml) {
    span.innerHTML = elemHtml;
    return span;
  }

  try {
    span.innerHTML = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: false,
    });
  } catch (_) {
    span.textContent = latex;
  }
  return span;
}

/**
 * @param {HTMLSpanElement} span
 * @param {string} latex
 */
export function updateFrozenMathElement(span, latex) {
  span.setAttribute('data-latex', latex);

  const elemHtml = getElementaryMathInlineHtml(latex);
  if (elemHtml) {
    span.innerHTML = elemHtml;
    return;
  }

  try {
    span.innerHTML = katex.renderToString(latex, {
      throwOnError: false,
      displayMode: false,
    });
  } catch (_) {
    span.textContent = latex;
  }
}

/**
 * @param {HTMLElement} el
 * @param {string} storage
 */
export function hydrateContentEditable(el, storage) {
  if (!el) return;
  el.innerHTML = '';
  const parts = parseInlineMathStorage(storage);

  for (const p of parts) {
    if (p.type === 'text') {
      appendTextWithExamBlanks(el, p.v);
    } else if (p.type === 'unit') {
      el.appendChild(createAtomicUnitElement(p.v));
    } else if (p.type === 'bargraph') {
      const cfg = decodeBarGraphPayload(p.v);
      if (cfg) el.appendChild(createBarGraphChipElement(cfg));
    } else if (isComplexLatexForPlainTransform(p.v)) {
      el.appendChild(createFrozenMathElement(p.v));
    } else {
      const plain = latexToPlain(p.v);
      if (plain) el.appendChild(document.createTextNode(plain));
    }
  }
}
