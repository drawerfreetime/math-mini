/**
 * 동료 평가 ↔ AI 평가 일치 판정
 */
import {
  PEER_EVAL_CHECK_KEYS,
  deriveCompletionLevelFromPeerChecks,
} from '../constants/peerEvalChecks';

/**
 * @param {Record<string, boolean>|null|undefined} peerChecks
 * @param {Record<string, boolean>|null|undefined} aiChecks
 */
export function computePeerCheckMatches(peerChecks, aiChecks) {
  const rows = PEER_EVAL_CHECK_KEYS.map((key) => {
    const peerOk = peerChecks?.[key];
    const aiOk = aiChecks?.[key];
    const skipped = typeof peerOk !== 'boolean';
    const match = !skipped && typeof aiOk === 'boolean' && peerOk === aiOk;
    return { key, peerOk, aiOk, match, skipped };
  });
  const evaluableRows = rows.filter((r) => !r.skipped);
  const hasChecksAxis = evaluableRows.some((r) => typeof r.aiOk === 'boolean');
  const checksMatch = hasChecksAxis
    && evaluableRows.every((r) => typeof r.aiOk !== 'boolean' || r.match);
  const checkHitCount = evaluableRows.filter((r) => r.match).length;
  return { rows, hasChecksAxis, checksMatch, checkHitCount };
}

/**
 * @param {{
 *   strategyMatch?: boolean,
 *   peerChecks?: Record<string, boolean>|null,
 *   aiChecks?: Record<string, boolean>|null,
 *   aiCompletionLevel?: string|null,
 *   completionMatch?: boolean,
 * }} p
 */
export function computePeerEvalAiMatch(p) {
  const strategyMatch = !!p.strategyMatch;
  const checkResult = computePeerCheckMatches(p.peerChecks, p.aiChecks);
  const { hasChecksAxis, checksMatch, checkHitCount, rows } = checkResult;

  const guessedLevel = deriveCompletionLevelFromPeerChecks(p.peerChecks);
  const aiCompletionLevel = p.aiCompletionLevel || null;
  const hasCompletionAxis = !!aiCompletionLevel;
  const completionMatch = hasCompletionAxis && guessedLevel === aiCompletionLevel;

  const qualityMatch = hasChecksAxis ? checksMatch : (hasCompletionAxis ? completionMatch : null);
  const aiFullMatch = strategyMatch && (qualityMatch === null || !!qualityMatch);

  return {
    strategyMatch,
    completionMatch,
    checksMatch: hasChecksAxis ? checksMatch : null,
    checkRows: rows,
    checkHitCount,
    hasCompletionAxis,
    hasChecksAxis,
    aiFullMatch,
  };
}
