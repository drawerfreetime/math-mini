/**

 * 단원 진행 객체 갱신 — 순수 로직 (단일 소스)

 */

import {

  VARIANT_STRATEGY_ID_SET,

  VARIANT_STRATEGY_IDS,

  INVESTIGATION_BADGE_TIERS,

} from '../constants/investigationBadges';

import {

  normalizeUnitProgress,

  computeOtterStage,

  createEmptyApprovedByStrategy,

  ADEPT_BADGE_THRESHOLD,

  LEGENDARY_BADGE_THRESHOLD,

  getUnitLabel,

} from '../constants/unitProgress';



/**

 * @param {import('../constants/unitProgress').UnitProgressEntry} prev

 * @param {import('../constants/unitProgress').UnitProgressEntry} next

 */

function finalizeOtterStage(prev, next) {

  const prevStage = prev.otterStage || computeOtterStage(prev);

  const newStage = computeOtterStage(next);

  next.otterStage = newStage;

  if (newStage > prevStage) {

    next.stagePoints = 0;

    next.stageSolveDone = 0;

    next.stagePeerEvalByStrategy = createEmptyApprovedByStrategy();

  }

  return finalizeCreativeOtter(next);

}



/**

 * @param {import('../constants/unitProgress').UnitProgressEntry} progress

 * @param {number} points

 */

export function applyUnitPoints(progress, points) {

  const p = normalizeUnitProgress(progress);

  const pts = Math.max(0, Math.floor(Number(points) || 0));

  const next = {

    ...p,

    points: p.points + pts,

    stagePoints: p.stagePoints + pts,

  };

  return finalizeOtterStage(p, next);

}



/**

 * @param {import('../constants/unitProgress').UnitProgressEntry} progress

 */

export function applyUnitSolveDone(progress) {

  const p = normalizeUnitProgress(progress);

  const next = {

    ...p,

    solveDone: p.solveDone + 1,

    stageSolveDone: p.stageSolveDone + 1,

  };

  return finalizeOtterStage(p, next);

}



/**

 * @param {import('../constants/unitProgress').UnitProgressEntry} progress

 * @param {string} strategyId

 * @param {string} [unlockedAtIso]

 */

export function applyUnitStrategyApproval(progress, strategyId, unlockedAtIso = '') {

  const id = String(strategyId || '').trim();

  if (!VARIANT_STRATEGY_ID_SET.has(id)) return null;



  const p = normalizeUnitProgress(progress);

  const approved = { ...p.approvedByStrategy };

  const newCount = (approved[id] || 0) + 1;

  approved[id] = newCount;



  const badgesEarned = { ...(p.badgesEarned || {}) };

  const badgeUnlockedAt = { ...(p.badgeUnlockedAt || {}) };

  const prevB = { adept: false, legendary: false, ...(badgesEarned[id] || {}) };

  const prevU = { adept: null, legendary: null, ...(badgeUnlockedAt[id] || {}) };

  const nextB = { ...prevB };

  const nextU = { ...prevU };

  const stamp = unlockedAtIso || new Date().toISOString();

  /** @type {{ tierId: string, labelKo: string, threshold: number }[]} */

  const newlyUnlocked = [];



  for (const tier of INVESTIGATION_BADGE_TIERS) {

    if (newCount >= tier.threshold && !prevB[tier.id]) {

      nextB[tier.id] = true;

      newlyUnlocked.push({ tierId: tier.id, labelKo: tier.labelKo, threshold: tier.threshold });

      if (!nextU[tier.id]) nextU[tier.id] = stamp;

    }

  }



  badgesEarned[id] = nextB;

  badgeUnlockedAt[id] = nextU;



  const next = {

    ...p,

    approvedByStrategy: approved,

    badgesEarned,

    badgeUnlockedAt,

  };

  const finalized = finalizeOtterStage(p, next);



  return {

    progress: finalized,

    strategyId: id,

    newCount,

    newlyUnlocked,

    isPeerJudge: newCount >= 2,

    hasAdept: newCount >= ADEPT_BADGE_THRESHOLD,

    hasLegendary: newCount >= LEGENDARY_BADGE_THRESHOLD,

  };

}



/**

 * 동료평가 전략 맞히기 성공 시 (이번 단계 진화용)

 * @param {import('../constants/unitProgress').UnitProgressEntry} progress

 * @param {string} strategyId

 */

export function applyUnitPeerEvalSuccess(progress, strategyId) {

  const id = String(strategyId || '').trim();

  if (!VARIANT_STRATEGY_ID_SET.has(id)) return null;



  const p = normalizeUnitProgress(progress);

  const stagePeerEvalByStrategy = { ...p.stagePeerEvalByStrategy };

  stagePeerEvalByStrategy[id] = (stagePeerEvalByStrategy[id] || 0) + 1;



  const next = { ...p, stagePeerEvalByStrategy };

  return {

    progress: finalizeOtterStage(p, next),

    strategyId: id,

    newCount: stagePeerEvalByStrategy[id],

  };

}



/**

 * @param {import('../constants/unitProgress').UnitProgressEntry} progress

 */

function finalizeCreativeOtter(progress) {

  const p = normalizeUnitProgress(progress);

  if (p.otterStage >= 4) {

    return { ...p, creativeOtterEarned: true };

  }

  return p;

}



/**

 * @param {string} unitKey

 * @param {import('../constants/unitProgress').UnitProgressEntry} progress

 */

export function buildCreativeOtterCollectionEntry(unitKey, progress) {

  const p = normalizeUnitProgress(progress);

  if (!p.creativeOtterEarned && p.otterStage < 4) return null;

  return {

    earnedAt: new Date().toISOString(),

    unitLabel: getUnitLabel(unitKey),

  };

}



/**

 * @param {string} unitKey

 * @param {import('../constants/unitProgress').UnitProgressEntry} progress

 */

export function buildUnitBadgeHistorySnapshot(unitKey, progress) {

  const p = normalizeUnitProgress(progress);

  return {

    unitKey,

    unitLabel: getUnitLabel(unitKey),

    approvedByStrategy: { ...p.approvedByStrategy },

    badgesEarned: { ...(p.badgesEarned || {}) },

    archivedAt: new Date().toISOString(),

  };

}



/** 레거시 strategyCounts → active unit approvedByStrategy (마이그레이션용) */

export function migrateLegacyStrategyCountsToUnit(strategyCounts) {

  const p = normalizeUnitProgress(null);

  const approved = { ...p.approvedByStrategy };

  for (const sid of VARIANT_STRATEGY_IDS) {

    const n = Math.max(0, Number(strategyCounts?.[sid]) || 0);

    if (n > 0) approved[sid] = n;

  }

  const next = { ...p, approvedByStrategy: approved };

  return finalizeOtterStage(p, next);

}


