/**
 * 단순 LaTeX → 편집용 평문. 세로셈·배열 등 복잡 수식은 그대로 $…$ 로 둔다.
 * (inlineMathStorage·ExamOCR 공용 — 순환 import 방지)
 */

const OCR_TIMES_RHS = '[□▢☐]|\\d+';

function fixOcrBrokenHorizontalTimes(text) {
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

function fixOcrBrokenTextCommand(text) {
  let s = String(text ?? '');
  s = s.replace(/\text\{([^}]*)\}/g, '\\text{$1}');
  s = s.replace(/\rmathrm\{([^}]*)\}/g, '\\mathrm{$1}');
  s = s.replace(/(\d)\s*ext\{([^}]+)\}/g, '$1\\text{$2}');
  s = s.replace(/(\d)ext([a-zA-Zμ°²³]+)/g, '$1 $2');
  return s;
}

/**
 * latexToPlain 이 깨뜨리는(배열·세로셈 등) LaTeX 인지
 * @param {string} inner `$` 안쪽 LaTeX
 */
export function isComplexLatexForPlainTransform(inner) {
  const s = String(inner ?? '').trim();
  if (!s) return false;
  if (/\\begin\{|\\end\{/.test(s)) return true;
  if (/\\\\/.test(s)) return true;
  if (/\\(?:hline|phantom|Big|kern|quad|qquad)\b/.test(s)) return true;
  if (/\\(?:left|right|middle)\b/.test(s)) return true;
  if (/^(LONGDIV|MULTVERT|LADDER)\s*\{/i.test(s)) return true;
  if (/\\array\b/.test(s)) return true;
  return false;
}

/** $512 \\times 20$ → 512×20 */
export function latexToPlain(latex) {
  let s = fixOcrBrokenTextCommand(fixOcrBrokenHorizontalTimes(latex.trim()));

  s = s.replace(/\\text\{([^}]*)\}/g, '$1');
  s = s.replace(/\\mathrm\{([^}]*)\}/g, '$1');
  s = s.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1/$2)');
  s = s.replace(/\\sqrt\{([^}]+)\}/g, '√$1');
  s = s.replace(/\\sqrt\s+(\S+)/g, '√$1');
  s = s.replace(/\^\{([^}]+)\}/g, (_, e) => {
    const supMap = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','n':'ⁿ' };
    if (e.length === 1 && supMap[e]) return supMap[e];
    return `^${e}`;
  });
  s = s.replace(/\^\s*(\d)/g, (_, d) => {
    const supMap = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹' };
    return supMap[d] || `^${d}`;
  });
  s = s.replace(/_\{([^}]+)\}/g, '_$1');
  s = s.replace(/\\times/g, '×');
  s = s.replace(/\\div/g, '÷');
  s = s.replace(/(\d)\s*×\s*(\d)/g, '$1×$2');
  s = s.replace(/\\cdot/g, '·');
  s = s.replace(/\\pm/g, '±');
  s = s.replace(/\\mp/g, '∓');
  s = s.replace(/\\neq|\\ne/g, '≠');
  s = s.replace(/\\leq|\\le/g, '≤');
  s = s.replace(/\\geq|\\ge/g, '≥');
  s = s.replace(/\\approx/g, '≈');
  s = s.replace(/\\equiv/g, '≡');
  s = s.replace(/\\infty/g, '∞');
  s = s.replace(/\\sin/g, 'sin');
  s = s.replace(/\\cos/g, 'cos');
  s = s.replace(/\\tan/g, 'tan');
  s = s.replace(/\\log/g, 'log');
  s = s.replace(/\\ln/g, 'ln');
  s = s.replace(/\\in/g, '∈');
  s = s.replace(/\\notin/g, '∉');
  s = s.replace(/\\subset/g, '⊂');
  s = s.replace(/\\cup/g, '∪');
  s = s.replace(/\\cap/g, '∩');
  s = s.replace(/\\emptyset/g, '∅');
  s = s.replace(/\\ldots|\\cdots|\\dots/g, '...');
  s = s.replace(/\\quad|\\qquad/g, '  ');
  s = s.replace(/\\,|\\;|\\!/g, '');
  s = s.replace(/\\space/g, ' ');
  s = s.replace(/\\alpha/g, 'α');
  s = s.replace(/\\beta/g, 'β');
  s = s.replace(/\\gamma/g, 'γ');
  s = s.replace(/\\delta/g, 'δ');
  s = s.replace(/\\pi/g, 'π');
  s = s.replace(/\\theta/g, 'θ');
  s = s.replace(/\\sigma/g, 'σ');
  s = s.replace(/\\mu/g, 'μ');
  s = s.replace(/\\omega/g, 'ω');
  s = s.replace(/\\phi/g, 'φ');
  s = s.replace(/\\rightarrow|\\to/g, '→');
  s = s.replace(/\\leftarrow/g, '←');
  s = s.replace(/\\Rightarrow/g, '⇒');
  s = s.replace(/\\Leftrightarrow/g, '⟺');
  // 각도(°) — 비교용 \circ·\bigcirc 보다 먼저
  s = s.replace(/\^\s*\\circ\b/g, '°');
  s = s.replace(/\^\{\\circ\}/g, '°');
  // 초등 시험지 빈칸·비교 기호 (OCR·KaTeX — 사라지면 「○ 안에」·식 사이 ○ 유실)
  s = s.replace(/\\bigcirc/g, '○');
  s = s.replace(/\\square|\\Box/g, '□');
  s = s.replace(/\\circ\b/g, '○');
  s = s.replace(/\\[a-zA-Z]+/g, '');
  s = s.replace(/[{}]/g, '');
  return s;
}
