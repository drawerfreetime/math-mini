/**
 * 문제 만들기 역량 — 유창성·융통성·정확도 (순수 계산)
 */
import { VARIANT_STRATEGY_IDS } from '../constants/investigationBadges';
import { MAKING_SUCCESS_PATH } from '../constants/problemMakingCompetency';

/**
 * @param {string} examId
 * @param {number|string} questionNumber
 */
export function buildVariantProblemKey(examId, questionNumber) {
  return `v_${String(examId).trim()}_q${Number(questionNumber)}`;
}

/** @param {string} bankDocId */
export function buildNewProblemKey(bankDocId) {
  return `n_${String(bankDocId).trim()}`;
}

/**
 * @param {Record<string, number>} strategyCounts — 성공한 변형만 집계된 전략별 횟수
 */
export function computeFlexibilityFromCounts(strategyCounts) {
  const n = VARIANT_STRATEGY_IDS.length;
  const counts = VARIANT_STRATEGY_IDS.map((id) => Math.max(0, Number(strategyCounts?.[id]) || 0));
  const total = counts.reduce((a, b) => a + b, 0);

  if (total === 0) {
    return {
      strategiesUsed: 0,
      evenness: 0,
      dominantShare: 0,
      total,
      byStrategy: Object.fromEntries(VARIANT_STRATEGY_IDS.map((id) => [id, 0])),
    };
  }

  const probs = counts.map((c) => c / total).filter((p) => p > 0);
  const H = probs.reduce((s, p) => s - p * Math.log(p), 0);
  const evenness = n > 1 ? H / Math.log(n) : (total > 0 ? 1 : 0);
  const dominantShare = Math.max(...counts) / total;

  return {
    strategiesUsed: probs.length,
    evenness: Math.round(evenness * 1000) / 1000,
    dominantShare: Math.round(dominantShare * 1000) / 1000,
    total,
    byStrategy: Object.fromEntries(VARIANT_STRATEGY_IDS.map((id, i) => [id, counts[i]])),
  };
}

/**
 * @param {Array<{
 *   succeeded?: boolean;
 *   kind?: string;
 *   strategyId?: string | null;
 *   submitCountAtSuccess?: number;
 *   submitCount?: number;
 *   firstStartedAt?: string | null;
 *   successAt?: string | null;
 *   successPath?: string | null;
 * }>} problems
 * @param {{ since?: string; until?: string }} [opts]
 */
export function computeProblemMakingCompetency(problems, opts = {}) {
  const since = opts.since ? Date.parse(opts.since) : null;
  const until = opts.until ? Date.parse(opts.until) : null;

  const inRange = (iso) => {
    if (!iso) return true;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return true;
    if (since != null && !Number.isNaN(since) && t < since) return false;
    if (until != null && !Number.isNaN(until) && t > until) return false;
    return true;
  };

  const list = (problems || []).filter((p) => p && p.succeeded && inRange(p.successAt));

  const fluency = list.length;

  const strategySuccessCounts = Object.fromEntries(VARIANT_STRATEGY_IDS.map((id) => [id, 0]));
  for (const p of list) {
    if (p.kind === 'variant' && p.strategyId && strategySuccessCounts[p.strategyId] !== undefined) {
      strategySuccessCounts[p.strategyId] += 1;
    }
  }
  const flexibility = computeFlexibilityFromCounts(strategySuccessCounts);

  const accuracyRows = list
    .map((p) => {
      const attempts = Number(p.submitCountAtSuccess ?? p.submitCount) || 0;
      const start = p.firstStartedAt ? Date.parse(p.firstStartedAt) : NaN;
      const end = p.successAt ? Date.parse(p.successAt) : NaN;
      const durationMs =
        Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
      return {
        problemKey: p.problemKey,
        kind: p.kind,
        attempts,
        durationMs,
        successPath: p.successPath,
      };
    })
    .filter((r) => r.attempts > 0);

  const avgAttempts =
    accuracyRows.length > 0
      ? Math.round((accuracyRows.reduce((s, r) => s + r.attempts, 0) / accuracyRows.length) * 10) / 10
      : null;

  const withDuration = accuracyRows.filter((r) => r.durationMs != null);
  const avgDurationMs =
    withDuration.length > 0
      ? Math.round(withDuration.reduce((s, r) => s + r.durationMs, 0) / withDuration.length)
      : null;

  const firstTrySuccessRate =
    accuracyRows.length > 0
      ? Math.round((accuracyRows.filter((r) => r.attempts === 1).length / accuracyRows.length) * 1000) / 1000
      : null;

  return {
    fluency,
    flexibility,
    accuracy: {
      problemCount: accuracyRows.length,
      avgAttempts,
      avgDurationMs,
      avgDurationMinutes:
        avgDurationMs != null ? Math.round((avgDurationMs / 60000) * 10) / 10 : null,
      firstTrySuccessRate,
      byPath: {
        teacher: list.filter((p) => p.successPath === MAKING_SUCCESS_PATH.TEACHER).length,
        peer: list.filter((p) => p.successPath === MAKING_SUCCESS_PATH.PEER).length,
      },
      problems: accuracyRows,
    },
    meta: {
      totalProblemsTracked: (problems || []).length,
      successInRange: fluency,
    },
  };
}
