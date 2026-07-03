/**
 * 전략 생략 추천 API용 평문 — 세로셈(LONGDIV/MULTVERT) 안의 숫자를 보존한다.
 * (미리보기용 mathTextToPlainString 은 [세로나눗셈] 치환으로 숫자가 빠짐)
 */
import { isComplexLatexForPlainTransform, latexToPlain } from './latexPlainTransform';
import { parseMultVertLatex } from './inlineMathStorage';

function normalizeMathSource(text) {
  return String(text)
    .replace(/\uFF04/g, '$')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function normalizeScriptBraces(s) {
  const t = String(s ?? '').trim();
  if (!/^(LONGDIV|MULTVERT|LADDER)\s*\{/i.test(t)) return t;
  return t.replace(/\{\{/g, '{').replace(/\}\}/g, '}');
}

function complexLatexToStrategyPlain(inner) {
  const t = normalizeScriptBraces(inner);
  const ld = t.match(/^LONGDIV\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}/i);
  if (ld) {
    const divisor = ld[1].trim();
    const dividend = ld[2].trim();
    const hasDiv = /\d/.test(divisor);
    const hasN = /\d/.test(dividend);
    if (hasDiv && hasN) return `${dividend} ÷ ${divisor}`;
    if (hasN) return dividend;
    if (hasDiv) return divisor;
    return '';
  }

  if (/^MULTVERT\s*\{/i.test(t)) {
    const parsed = parseMultVertLatex(t);
    if (parsed?.rows?.length) {
      const rows = parsed.rows.map((r) => String(r || '').trim()).filter(Boolean);
      if (rows.length) return rows.join(' ');
    }
    const nums = t.match(/\d+/g);
    if (nums && nums.length >= 2) return nums.join(' ');
    if (nums?.length === 1) return nums[0];
    return '';
  }

  if (/^LADDER\s*\{/i.test(t)) {
    const nums = t.match(/\d+/g);
    if (nums && nums.length >= 2) return nums.join(' ');
    if (nums?.length === 1) return nums[0];
    return '';
  }

  if (/\\begin\{array\}/.test(t)) {
    const nums = t.match(/\d+/g);
    if (nums && nums.length >= 2) return nums.join(' ');
    if (nums?.length === 1) return nums[0];
    return '';
  }

  return latexToPlain(t);
}

/**
 * @param {string} text
 * @returns {string}
 */
export function mathTextToStrategyPlainString(text) {
  if (!text) return '';
  const s = normalizeMathSource(text);
  return s
    .replace(/\$\$([^$]+)\$\$/g, (_, inner) =>
      isComplexLatexForPlainTransform(inner)
        ? complexLatexToStrategyPlain(inner)
        : latexToPlain(inner))
    .replace(/\$([^$]+)\$/g, (_, inner) =>
      isComplexLatexForPlainTransform(inner)
        ? complexLatexToStrategyPlain(inner)
        : latexToPlain(inner))
    .replace(/\[분수:([^/\]]+)\/([^\]]+)\]/g, '$1/$2')
    .replace(/⟦UNIT:([^⟧]+)⟧/g, (_, enc) => {
      try {
        return decodeURIComponent(enc);
      } catch {
        return '';
      }
    })
    .replace(/⟦BARGRAPH:[^⟧]+⟧/g, '[막대그래프]');
}
