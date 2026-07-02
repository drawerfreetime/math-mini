/**
 * 변형 전략 최종 승인 시 카운트·뱃지 갱신 (단원별 unitProgress 우선)
 * AI 검증 통과만으로는 호출하지 않음 — 교사·동료 최종 승인 시에만
 */
import {
  VARIANT_STRATEGY_ID_SET,
  VARIANT_STRATEGY_IDS,
  INVESTIGATION_BADGE_TIERS,
  createEmptyStrategyCounts,
  createEmptyStrategyBadges,
  createEmptyStrategyBadgeUnlockTimes,
} from '../constants/investigationBadges';
import { applyUnitStrategyApproval } from './unitProgressEngine';
import { normalizeUnitProgress } from '../constants/unitProgress';

/**
 * @deprecated 전역 strategyCounts — unitProgress로 대체. 레거시 호출 호환용.
 */
export function applyVerifiedStrategySuccess(state, strategyId, unlockedAtIso = '') {
  return applyStrategyApprovalSuccess(state, strategyId, unlockedAtIso);
}

/**
 * @param {{
 *   unitProgress?: Record<string, import('../constants/unitProgress').UnitProgressEntry> | null;
 *   strategyCounts?: Record<string, number> | null;
 *   strategyBadges?: Record<string, Partial<Record<string, boolean>>> | null;
 *   strategyBadgeUnlockedAt?: Record<string, Partial<Record<string, string | null>>> | null;
 * }} state
 * @param {string} strategyId
 * @param {string} [unlockedAtIso]
 * @param {string} [unitKey]
 */
export function applyStrategyApprovalSuccess(state, strategyId, unlockedAtIso = '', unitKey = '') {
  const id = String(strategyId || '').trim();
  if (!VARIANT_STRATEGY_ID_SET.has(id)) return null;

  const key = String(unitKey || '').trim();
  if (key && /^\d+-\d+-\d+$/.test(key)) {
    const prevUnit = normalizeUnitProgress(state.unitProgress?.[key]);
    const applied = applyUnitStrategyApproval(prevUnit, id, unlockedAtIso);
    if (!applied) return null;
    const unitProgress = { ...(state.unitProgress || {}), [key]: applied.progress };
    return {
      unitProgress,
      activeUnitKey: key,
      newlyUnlocked: applied.newlyUnlocked,
      strategyId: id,
      newCount: applied.newCount,
      unitKey: key,
    };
  }

  const counts = { ...createEmptyStrategyCounts(), ...(state.strategyCounts || {}) };
  const badgesAll = { ...createEmptyStrategyBadges() };
  const unlockAll = { ...createEmptyStrategyBadgeUnlockTimes() };

  for (const sid of VARIANT_STRATEGY_IDS) {
    const prev = state.strategyBadges?.[sid] || {};
    badgesAll[sid] = {
      adept: Boolean(prev.adept),
      legendary: Boolean(prev.legendary),
    };
    const prevU = state.strategyBadgeUnlockedAt?.[sid] || {};
    unlockAll[sid] = {
      adept: typeof prevU.adept === 'string' && prevU.adept ? prevU.adept : null,
      legendary: typeof prevU.legendary === 'string' && prevU.legendary ? prevU.legendary : null,
    };
  }

  const newCount = (Number(counts[id]) || 0) + 1;
  counts[id] = newCount;

  const prevB = badgesAll[id];
  const nextB = { ...prevB };
  const nextUnlock = { ...unlockAll[id] };
  /** @type {{ tierId: string; labelKo: string; threshold: number }[]} */
  const newlyUnlocked = [];
  const stamp = unlockedAtIso || new Date().toISOString();

  for (const tier of INVESTIGATION_BADGE_TIERS) {
    if (newCount >= tier.threshold && !prevB[tier.id]) {
      nextB[tier.id] = true;
      newlyUnlocked.push({ tierId: tier.id, labelKo: tier.labelKo, threshold: tier.threshold });
      if (!nextUnlock[tier.id]) nextUnlock[tier.id] = stamp;
    }
  }

  badgesAll[id] = nextB;
  unlockAll[id] = nextUnlock;

  return {
    strategyCounts: counts,
    strategyBadges: badgesAll,
    strategyBadgeUnlockedAt: unlockAll,
    newlyUnlocked,
    strategyId: id,
    newCount,
  };
}
