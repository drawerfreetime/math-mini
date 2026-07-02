/**
 * 학생 답안 비교 — 쉼표·띄어쓰기 허용, 단위 무시·숫자만 러프 비교
 */
import { mathTextToPlainString } from '../components/ExamOCR';

const SEPARATOR_RE = /[,，、;；/\\|]+/;

/**
 * 답안 문자열을 비교용 토큰 배열로 분해
 * @param {string} raw
 * @returns {string[]}
 */
export function tokenizeStudentAnswer(raw) {
  const plain = mathTextToPlainString(String(raw || '')).trim();
  if (!plain) return [];

  const sepParts = plain
    .split(SEPARATOR_RE)
    .map((p) => p.trim().replace(/\s+/g, ''))
    .filter(Boolean);
  if (sepParts.length > 1) return sepParts;

  const spaceParts = plain.split(/\s+/).filter(Boolean);
  if (spaceParts.length > 1 && spaceParts.every((p) => /^\d/.test(p))) {
    return spaceParts.map((p) => p.replace(/\s+/g, ''));
  }

  return [plain.replace(/\s+/g, '')];
}

/**
 * 토큰에서 비교용 숫자(또는 분수) 추출 — 단위·한글 등은 무시
 * @param {string} token
 * @returns {string}
 */
export function extractComparableNumber(token) {
  const t = String(token || '').trim();
  if (!t) return '';

  const frac = t.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) return `${frac[1]}/${frac[2]}`;

  const leading = t.match(/^(\d+(?:\.\d+)?)/);
  if (leading) return leading[1];

  const anyNum = t.match(/(\d+(?:\.\d+)?)/);
  if (anyNum) return anyNum[1];

  return t.replace(/\s+/g, '');
}

function normalizeTokens(tokens) {
  return tokens.map(extractComparableNumber).filter(Boolean);
}

function sortNumericTokens(tokens) {
  return [...tokens].sort((a, b) => Number(a) - Number(b));
}

/**
 * @param {string} submitted 학생이 입력한 답
 * @param {string} expected 정답
 * @param {{ multipleChoice?: boolean }} [opts]
 * @returns {boolean}
 */
export function compareStudentAnswers(submitted, expected, opts = {}) {
  const aRaw = tokenizeStudentAnswer(submitted);
  const bRaw = tokenizeStudentAnswer(expected);
  if (!aRaw.length || !bRaw.length) return false;

  const a = normalizeTokens(aRaw);
  const b = normalizeTokens(bRaw);

  if (aRaw.length !== bRaw.length) {
    // 몫·나머지: 정답이 몫만 있어도 나머지 0과 함께 제출하면 정답
    if (a.length > b.length && b.length >= 1) {
      if (b.every((part, i) => part === a[i])) {
        const extras = a.slice(b.length);
        if (extras.every((n) => n === '0' || n === '0.0')) return true;
      }
    }
    return false;
  }

  if (a.length !== b.length) return false;

  if (opts.multipleChoice) {
    const aSorted = sortNumericTokens(a);
    const bSorted = sortNumericTokens(b);
    return aSorted.every((part, i) => part === bSorted[i]);
  }

  return a.every((part, i) => part === b[i]);
}
