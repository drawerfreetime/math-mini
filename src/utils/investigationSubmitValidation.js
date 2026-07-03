/**
 * 수사연(기존 문제 변형) 제출 선검증 — 연구 윤리(유사도·복붙)만 클라이언트에서 차단.
 * 단원 학습목표(goal_alignment_ok)는 /api/review-student-variant AI 검토에 맡긴다.
 */

import { stripLeadingCircledFromChoiceText } from './circledAnswer';

const MCQ_NUM_PREFIX_RE = /^\d+\s*[.)]\s*/;
const MCQ_CIRCLED_LABELS = '①②③④⑤⑥⑦⑧⑨⑩';

function mcqChoiceLabel(index) {
  return MCQ_CIRCLED_LABELS[index] || `${index + 1}번`;
}

function normalizeMcqChoiceForCompare(text) {
  let s = stripLeadingCircledFromChoiceText(text);
  while (MCQ_NUM_PREFIX_RE.test(s)) {
    s = s.replace(MCQ_NUM_PREFIX_RE, '').trim();
  }
  return s.replace(/\s+/g, '').trim();
}

/**
 * @param {string[]} choices
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function validateMcqDuplicateChoices(choices) {
  if (!Array.isArray(choices) || choices.length < 2) return { ok: true };

  /** @type {Map<string, number>} */
  const seen = new Map();
  for (let i = 0; i < choices.length; i++) {
    const raw = String(choices[i] || '').trim();
    const key = normalizeMcqChoiceForCompare(raw);
    if (!key) continue;
    if (seen.has(key)) {
      const first = seen.get(key);
      const sample = stripLeadingCircledFromChoiceText(raw) || raw;
      return {
        ok: false,
        code: 'mcq_duplicate_choice',
        message:
          `선지 ${mcqChoiceLabel(first)}와 ${mcqChoiceLabel(i)} 내용이 똑같아요. ` +
          `(${sample}) 서로 다른 번호에는 다른 답을 넣어 주세요.`,
      };
    }
    seen.set(key, i);
  }
  return { ok: true };
}

/** @param {string} s */
function normalizeForCompare(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .trim();
}

/**
 * 문제·보기·선지를 한 덩어리로 묶어 연구 윤리 유사도를 본다.
 * @param {string} question
 * @param {string} [bogi]
 * @param {string[]} [choices]
 */
export function packVariantWorkForEthicsCompare(question, bogi = '', choices = []) {
  const norm = (s) => normalizeForCompare(String(s || ''));
  const parts = [norm(question), norm(bogi)];
  if (Array.isArray(choices) && choices.length > 0) {
    parts.push(JSON.stringify(choices.map((c) => norm(c))));
  }
  return parts.join('\x1e');
}

/**
 * 편집 거리 기반 유사도 (0~1, 1에 가까울수록 동일)
 * @param {string} a
 * @param {string} b
 */
export function textSimilarityRatio(a, b) {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  const dist = levenshtein(x, y);
  const denom = Math.max(x.length, y.length);
  return denom === 0 ? 1 : 1 - dist / denom;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  /** @type {number[]} */
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** 원본과 거의 동일할 때만 차단 (0.99 = 99% 이상 유사·숫자 동일 시) */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.99;

export const ETHICS_SIMILARITY_BLOCK_MSG =
  '🚨 연구 윤리 위반 감지! 원본 문제를 그대로 제출할 수 없습니다. 연구원님만의 창의적인 변형을 가미해 주세요!';

/** 원문과 100% 동일(공백 정규화 후) — API 호출 전 즉시 차단 */
export const ETHICS_EXACT_COPY_MSG =
  '🚨 연구 윤리 위반 감지! 원본 문제를 그대로 복사했습니다. 연구원님만의 변화를 조금이라도 가미해 주세요!';

/**
 * @param {string} oq
 * @param {string} sq
 * @param {string} ob
 * @param {string} sb
 * @param {string[]} oc
 * @param {string[]} sc
 */
export function isStudentWorkIdenticalToOriginal(oq, sq, ob, sb, oc, sc) {
  const norm = (s) => normalizeForCompare(String(s || ''));
  const packChoices = (arr) =>
    JSON.stringify((arr || []).map((c) => norm(c)));
  return (
    norm(oq) === norm(sq) &&
    norm(ob) === norm(sb) &&
    packChoices(oc) === packChoices(sc)
  );
}

/** @param {string} s */
function extractNumbers(s) {
  return String(s || '').match(/\d+/g) || [];
}

/** 숫자가 하나라도 달라지면 실질 변형으로 본다 */
function hasNumberChanges(a, b) {
  const na = extractNumbers(a);
  const nb = extractNumbers(b);
  if (na.length !== nb.length) return true;
  return na.some((n, i) => n !== nb[i]);
}

/**
 * @param {object} p
 * @param {string} p.originalQuestionPlain
 * @param {string} p.newQuestionPlain
 * @param {string} [p.originalBogiPlain]
 * @param {string} [p.newBogiPlain]
 * @param {string[]} [p.originalChoices]
 * @param {string[]} [p.newChoices]
 * @param {number} [p.similarityThreshold]
 */
export function validateInvestigationSubmit({
  originalQuestionPlain,
  newQuestionPlain,
  originalBogiPlain = '',
  newBogiPlain = '',
  originalChoices = [],
  newChoices = [],
  similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
}) {
  const origPack = packVariantWorkForEthicsCompare(
    originalQuestionPlain,
    originalBogiPlain,
    originalChoices
  );
  const newPack = packVariantWorkForEthicsCompare(newQuestionPlain, newBogiPlain, newChoices);
  const sim = textSimilarityRatio(origPack, newPack);
  if (sim >= similarityThreshold && !hasNumberChanges(origPack, newPack)) {
    return { ok: false, code: 'ethics_similarity', message: ETHICS_SIMILARITY_BLOCK_MSG };
  }

  return { ok: true };
}
