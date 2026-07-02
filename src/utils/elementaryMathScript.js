/**
 * 초등 수식 스크립트 → KaTeX LaTeX (기존 인라인 수식 칩 $…$ 저장과 호환)
 *
 * 문법:
 * - 분수: {분자} over {분모}
 * - 대분수: {정수} {분자} over {분모}
 * - 나눗셈: LONGDIV {제수} {피제수} {몫}
 * - 선분: bar {문자열}
 * - 사다리: LADDER { a & b # c & d }
 */

import { parseMultVertLatex } from './inlineMathStorage';

/** OCR·프롬프트 이중 중괄호 `{{45}}` → `{45}` */
export function normalizeElementaryScriptBraces(s) {
  const t = String(s ?? '').trim();
  if (!/^(LONGDIV|MULTVERT|LADDER)\s*\{/i.test(t)) return t;
  return t.replace(/\{\{/g, '{').replace(/\}\}/g, '}');
}

/**
 * `$…$` 안 LONGDIV/MULTVERT/LADDER 스크립트의 이중 중괄호 정규화
 * @param {string} text
 * @returns {string}
 */
export function normalizeElementaryScriptDollars(text) {
  let out = String(text ?? '');
  const fixInner = (full, inner) => {
    const norm = normalizeElementaryScriptBraces(inner.trim());
    return norm !== inner.trim() ? `$${norm}$` : full;
  };
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (full, inner) => {
    const norm = normalizeElementaryScriptBraces(inner.trim());
    return norm !== inner.trim() ? `$$${norm}$$` : full;
  });
  out = out.replace(/\$([^$]+)\$/g, fixInner);
  return out;
}

/** @param {string} frag OCR·모델이 낸 array 조각 (공백·\\quad 등) */
function ocrSpacingFragmentToCellString(frag) {
  let t = String(frag ?? '');
  t = t.replace(/\\text\{([^}]*)\}/g, '$1');
  t = t.replace(/\\quad|\\qquad/g, ' ');
  t = t.replace(/\\[,:;!]/g, ' ');
  t = t.replace(/\\ /g, ' ');
  t = t.replace(/~/g, ' ');
  t = t.replace(/\\\\\s*/g, ' ');
  t = t.replace(/\\[a-zA-Z]+\s*(?:\[[^\]]*\])?/g, ' ');
  t = t.replace(/&+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.split(/\s+/).filter(Boolean).join('');
}

/**
 * OCR 전용: 단열 \\begin{array}{r} … \\times … \\hline … \\end{array}
 * @returns {{ rows: string[]; opRow: number } | null}
 */
function parseOcrMessySingleColumnMultvert(latex) {
  const s0 = String(latex ?? '').trim();
  if (!/\\begin\{array\}\{r\}\b/.test(s0) || !/\\hline/.test(s0)) return null;
  if (/\\kern-2pt\s*\\Big\)/.test(s0)) return null;
  const m = s0.match(/^\\begin\{array\}\{r\}([\s\S]*?)\\end\{array\}$/);
  if (!m) return null;
  const body = m[1];
  if (!/\\times\b|×/.test(body)) return null;
  const hlParts = body.split(/\\hline/);
  if (hlParts.length < 2) return null;
  const upper = hlParts[0];
  const lowerRest = hlParts.slice(1).join('\\hline');
  const lowerMain = (lowerRest.split(/\\hline/)[0] ?? lowerRest).trim();
  const upperNorm = upper.replace(/×/g, '\\times');
  const ts = upperNorm.split(/\\times\b/);
  if (ts.length !== 2) return null;
  const row0 = ocrSpacingFragmentToCellString(ts[0]);
  const row1 = ocrSpacingFragmentToCellString(ts[1]);
  const row2 = ocrSpacingFragmentToCellString(lowerMain);
  if (!row0 || !row1) return null;
  return { rows: [row0, row1, row2], opRow: 1 };
}

/** @param {string[]} rows @param {number} opRow */
function multRowsToMultvertCanonicalLatex(rows, opRow) {
  const safe = rows.map((r) => String(r ?? ''));
  const multCols = Math.max(1, ...safe.map((r) => Array.from(r).length));
  const rowStr = safe.join(' # ');
  const divLine = opRow;
  const script = `MULTVERT { rows: "${rowStr}" ; cols: ${multCols} ; divLine: ${divLine} ; opRow: ${opRow} }`;
  return elementaryScriptToLatex(script).trim();
}

/**
 * OCR이 낸 세로 곱셈용 단열 array 한 덩어리 → 앱 표준 \\begin{array}{rr…} (MULTVERT와 동일).
 * 이미 표준 multvert LaTeX이거나 변환 불가하면 null.
 * @param {string} inner $…$ 내부 LaTeX
 * @returns {string | null}
 */
export function convertOcrVerticalMultiplyArrayLatexToCanonical(inner) {
  const s = String(inner ?? '').trim();
  if (!s) return null;
  if (parseMultVertLatex(s)) return null;
  const messy = parseOcrMessySingleColumnMultvert(s);
  if (!messy) return null;
  const latex = multRowsToMultvertCanonicalLatex(messy.rows, messy.opRow);
  return latex || null;
}

/** OCR 빈칸·피연산자 (□ 등) */
const OCR_TIMES_RHS = '[□▢☐]|\\d+';

/**
 * OCR·JSON에서 `\times`가 `\t`(탭)+`imes`, `472imes28`, `180imes□`처럼 깨진 가로 곱셈 복구.
 * ×가 줄마다 i/m/e/s 로 쪼개진 경우(180↵i↵m↵e↵s↵□)도 복구.
 * @param {string} text
 * @returns {string}
 */
export function fixOcrBrokenHorizontalTimes(text) {
  let s = String(text ?? '');
  s = s.replace(
    new RegExp(
      `(\\d+)(?:\\s*\\n\\s*)?i(?:\\s*\\n\\s*)?m(?:\\s*\\n\\s*)?e(?:\\s*\\n\\s*)?s(?:\\s*\\n\\s*)?(${OCR_TIMES_RHS})`,
      'gi',
    ),
    '$1 \\times $2',
  );
  s = s.replace(
    new RegExp(`(\\d+)[\\s\\t]*imes[\\s\\t]*(${OCR_TIMES_RHS})`, 'gi'),
    '$1 \\times $2',
  );
  return s;
}

/**
 * OCR·JSON에서 `\text{cm}`·`\mathrm{cm}` 이 `\t`+`ext{…}` / `\r`+`mathrm{…}` 로 깨진 경우 복구.
 * 이미 `210extcm` 처럼 노출된 문자열도 `210 cm` 으로 정리.
 * @param {string} text
 * @returns {string}
 */
export function fixOcrBrokenTextCommand(text) {
  let s = String(text ?? '');
  // \text{…} → TAB+ext{…} (JS·JSON 이스케이프)
  s = s.replace(/\text\{([^}]*)\}/g, '\\text{$1}');
  // \mathrm{…} → CR+mathrm{…}
  s = s.replace(/\rmathrm\{([^}]*)\}/g, '\\mathrm{$1}');
  // 백슬래시 없이 ext{…} 만 남은 경우
  s = s.replace(/(\d)\s*ext\{([^}]+)\}/g, '$1\\text{$2}');
  // latexToPlain 실패 후 210extcm 형태
  s = s.replace(/(\d)ext([a-zA-Zμ°²³]+)/g, '$1 $2');
  return s;
}

/**
 * 문항 텍스트 등: $…$/$$…$$ 안의 OCR용 세로곱 array만 표준 LaTeX로 교체
 * @param {string} text
 * @returns {string}
 */
export function rewriteMessyVerticalMultiplyDollars(text) {
  let out = fixOcrBrokenHorizontalTimes(text);
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (full, inner) => {
    const t = String(inner).trim();
    const conv = convertOcrVerticalMultiplyArrayLatexToCanonical(t);
    return conv ? `$$${conv}$$` : full;
  });
  out = out.replace(/\$([^$]+)\$/g, (full, inner) => {
    const t = String(inner).trim();
    const conv = convertOcrVerticalMultiplyArrayLatexToCanonical(t);
    return conv ? `$${conv}$` : full;
  });
  return out;
}

/** @param {string} v */
function texCell(v) {
  const t = String(v ?? '').trim();
  if (!t) return '';
  if (/^\d+$/.test(t)) return t;
  return `\\text{${escapeForText(t)}}`;
}

/** @param {string} s */
function escapeForText(s) {
  return String(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/#/g, '\\#')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/&/g, '\\&');
}

/**
 * @param {string} script
 * @returns {string} KaTeX용 LaTeX (비어 있으면 '')
 */
export function elementaryScriptToLatex(script) {
  const raw = normalizeElementaryScriptBraces(String(script ?? '').trim());
  if (!raw) return '';

  // ── MULTVERT: 곱셈 세로셈 ──
  // 형식: MULTVERT { rows: "r0 # r1 # r2" ; cols: N ; divLine: K ; opRow: J }
  const multvert = raw.match(/^MULTVERT\s*\{([^}]*)\}\s*$/i);
  if (multvert) {
    const inner = multvert[1];
    const rowsMatch  = inner.match(/rows\s*:\s*"([^"]*)"/);
    const colsMatch  = inner.match(/cols\s*:\s*(\d+)/);
    const opMatch    = inner.match(/opRow\s*:\s*(\d+)/);
    if (!rowsMatch) return '';
    const rowVals = rowsMatch[1].split('#').map(s => s.trim());
    const cols    = colsMatch  ? parseInt(colsMatch[1],  10) : 4;
    const opRow   = opMatch    ? parseInt(opMatch[1],    10) : 1;

    // ×기호 행 구분을 위해 배열로 LaTeX 행 구성 (한 칸 = 문자 1개, Array.from으로 유니코드 안전)
    const latexRows = rowVals.map((val, ri) => {
      const prefix = ri === opRow ? '\\times' : '\\phantom{\\times}';
      const chars = Array.from(val);
      const pad = Math.max(0, cols - chars.length);
      const paddedChars = [...Array(pad).fill(' '), ...chars];
      const cells = paddedChars.map(ch => (ch === ' ' ? '\\phantom{0}' : texCell(ch)));
      return `${prefix} & ${cells.join(' & ')}`;
    });

    // hline: × 행(opRow)부터 2행마다 (마지막 행 아래 제외)
    const body = latexRows.map((row, ri) => {
      const needsHline = ri >= opRow && (ri - opRow) % 2 === 0 && ri < latexRows.length - 1;
      const line = needsHline ? ' \\\\ \\hline' : ri === latexRows.length - 1 ? '' : ' \\\\';
      return row + line;
    }).join('\n');

    const colSpec = 'r' + 'r'.repeat(cols);
    return `\\begin{array}{${colSpec}}${body}\\end{array}`;
  }

  const ladder = raw.match(/^LADDER\s*\{([\s\S]*)\}\s*$/i);
  if (ladder) {
    // inlineMathStorage에서 인라인 스타일로 렌더링하므로 스크립트 그대로 반환
    return raw.trim();
  }

  const longdiv = raw.match(/^LONGDIV\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}(?:\s+STEPS\s+\{([^}]*)\})?\s*$/i);
  if (longdiv) {
    // 항상 스크립트 원문 유지 → inlineMathStorage·renderMathText 가 세로 나눗셈 HTML로 렌더
    return raw.trim();
  }

  const bar = raw.match(/^bar\s*\{([^}]*)\}\s*$/i);
  if (bar) {
    const inner = bar[1].trim();
    if (!inner) return '';
    if (/^\d+$/.test(inner)) return `\\overline{${inner}}`;
    return `\\overline{\\text{${escapeForText(inner)}}}`;
  }

  const mixed = raw.match(/^\{([^}]*)\}\s+\{([^}]*)\}\s+over\s+\{([^}]*)\}\s*$/i);
  if (mixed) {
    const a = texCell(mixed[1]);
    const b = texCell(mixed[2]);
    const c = texCell(mixed[3]);
    if (!a || !b || !c) return '';
    return `${a}\\frac{${b}}{${c}}`;
  }

  const frac = raw.match(/^\{([^}]*)\}\s+over\s+\{([^}]*)\}\s*$/i);
  if (frac) {
    const a = texCell(frac[1]);
    const b = texCell(frac[2]);
    if (!a || !b) return '';
    return `\\frac{${a}}{${b}}`;
  }

  return `\\text{${escapeForText(raw)}}`;
}

// ─── MULTVERT: 곱셈 세로셈 ───────────────────────────────────────────
// 스크립트 형식: MULTVERT { rows: "314 # 42 # # 628 # 1256 # 13188" ; cols: 5 ; divLine: 1 }
// rows: 각 행값 #으로 구분, 빈 행은 빈 문자열, divLine은 구분선 아래 첫 행 인덱스(0-based)
// ─────────────────────────────────────────────────────────────────────

/**
 * 편집 시 칩의 data-latex 에서 초기 칸 값 복원 (일부 패턴만)
 * @param {string} latex
 * @returns {{ templateId: string, values: string[] } | { templateId: 'longdiv'; longDiv: { divisor: string; dividend: string; quotient: string } } | { templateId: 'ladder'; rows: string[][] } | { templateId: 'multvert'; multRows: string[]; multOpRow: number; multDivLine: number } | null}
 */
export function tryParseLatexForElementaryEditor(latex) {
  const s = normalizeElementaryScriptBraces(String(latex ?? '').trim());
  if (!s) return null;

  // ── 새 스크립트 형식: LONGDIV {d} {n} {q} [STEPS {s1#s2}] ──
  const newLongDiv = s.match(
    /^LONGDIV\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}(?:\s+STEPS\s+\{([^}]*)\})?\s*$/i
  );
  if (newLongDiv) {
    const steps = newLongDiv[4] ? newLongDiv[4].split('#').map(x => x.trim()) : [];
    return {
      templateId: 'longdiv',
      longDiv: {
        divisor:  newLongDiv[1].trim(),
        dividend: newLongDiv[2].trim(),
        quotient: newLongDiv[3].trim(),
        steps,
      },
    };
  }

  // ── MULTVERT 스크립트 (저장 원문) ──
  const mvScr = s.match(/^MULTVERT\s*\{([\s\S]*)\}\s*$/i);
  if (mvScr) {
    const inner = mvScr[1];
    const rowsM = inner.match(/rows\s*:\s*"([^"]*)"/);
    if (rowsM) {
      const rowVals = rowsM[1].split('#').map((x) => x.trim());
      const opM = inner.match(/opRow\s*:\s*(\d+)/);
      const divM = inner.match(/divLine\s*:\s*(\d+)/);
      const multOpRow = opM ? parseInt(opM[1], 10) : 1;
      const multDivLine = divM ? parseInt(divM[1], 10) : multOpRow;
      return { templateId: 'multvert', multRows: rowVals, multOpRow, multDivLine };
    }
  }

  // ── 곱셈 세로셈: 표준 \\begin{array}{rr…} ──
  const parsedMv = parseMultVertLatex(s);
  if (parsedMv && parsedMv.rows.length >= 2) {
    const hasAny = parsedMv.rows.some((r) => Array.from(r).length > 0);
    if (hasAny) {
      return {
        templateId: 'multvert',
        multRows: parsedMv.rows,
        multOpRow: parsedMv.opRow,
        multDivLine: parsedMv.opRow,
      };
    }
  }

  // ── 곱셈 세로셈: OCR 단열 array (\\begin{array}{r} … \\hline …) ──
  const messyMv = parseOcrMessySingleColumnMultvert(s);
  if (messyMv) {
    return {
      templateId: 'multvert',
      multRows: messyMv.rows,
      multOpRow: messyMv.opRow,
      multDivLine: messyMv.opRow,
    };
  }

  // ── 구 KaTeX 형식: \begin{array}{r}q\\[-3pt]d\kern-2pt\Big)\kern-2pt n\end{array} ──
  const longdivMatch = s.match(
    /^\\begin\{array\}\{r\}(.+?)\\\\(?:\[.*?\])?(.+?)\\kern-2pt\\Big\)\\kern-2pt(.+?)\\end\{array\}$/
  );
  if (longdivMatch) {
    /** @param {string} v */
    function extractVal(v) {
      const t = v.trim();
      const m = t.match(/^\\text\{([^}]*)\}$/);
      if (m) return m[1];
      if (t === '\\;') return '';
      return t;
    }
    return {
      templateId: 'longdiv',
      longDiv: {
        quotient: extractVal(longdivMatch[1]),
        divisor:  extractVal(longdivMatch[2]),
        dividend: extractVal(longdivMatch[3]),
        steps: [],
      },
    };
  }

  const mixed = s.match(
    /^\s*(\d+)\s*\\frac\s*\{\s*(\d+)\s*\}\s*\{\s*(\d+)\s*\}\s*$/
  );
  if (mixed) {
    return { templateId: 'mixed', values: [mixed[1], mixed[2], mixed[3]] };
  }

  const frac = s.match(/^\s*\\frac\s*\{\s*(\d+)\s*\}\s*\{\s*(\d+)\s*\}\s*$/);
  if (frac) {
    return { templateId: 'fraction', values: [frac[1], frac[2]] };
  }

  const oDigits = s.match(/^\s*\\overline\s*\{\s*(\d+)\s*\}\s*$/);
  if (oDigits) {
    return { templateId: 'bar', values: [oDigits[1]] };
  }

  const oText = s.match(/^\s*\\overline\s*\{\s*\\text\s*\{([^}]*)\}\s*\}\s*$/);
  if (oText) {
    return { templateId: 'bar', values: [oText[1]] };
  }

  return null;
}
