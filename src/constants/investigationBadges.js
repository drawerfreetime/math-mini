/**
 * 수사연 — 변형 전략별 뱃지(수사관 등급) 메타데이터
 * strategyCounts / strategyBadges 필드와 strategyBadgeEngine.js 가 여기 정의와 동기화됩니다.
 */
import { VARIANT_STRATEGIES } from './variantStrategies';

/** @type {readonly string[]} */
export const VARIANT_STRATEGY_IDS = VARIANT_STRATEGIES.map((s) => s.id);

export const VARIANT_STRATEGY_ID_SET = new Set(VARIANT_STRATEGY_IDS);

/**
 * 뱃지 단계 — 단원별 최종 승인 횟수 기준 (UI·도감용)
 * novice(1회)는 추론달 진화 조건만, 뱃지 티어로 부여하지 않음
 * @type {readonly { id: 'adept' | 'legendary'; labelKo: string; threshold: number }[]}
 */
export const INVESTIGATION_BADGE_TIERS = [
  { id: 'adept', labelKo: '참된 수사관', threshold: 5 },
  { id: 'legendary', labelKo: '전설의 수사관', threshold: 12 },
];

/** @deprecated 레거시 Firestore 읽기 호환 */
export const LEGACY_NOVICE_BADGE_THRESHOLD = 1;

/** @returns {Record<string, number>} */
export function createEmptyStrategyCounts() {
  return Object.fromEntries(VARIANT_STRATEGY_IDS.map((sid) => [sid, 0]));
}

function emptyTierRecord() {
  return { adept: false, legendary: false };
}

/** @returns {Record<string, { adept: boolean; legendary: boolean }>} */
export function createEmptyStrategyBadges() {
  return Object.fromEntries(VARIANT_STRATEGY_IDS.map((sid) => [sid, emptyTierRecord()]));
}

function emptyUnlockRecord() {
  return { adept: null, legendary: null };
}

/**
 * 티어별 획득 시각(ISO 문자열)
 * @returns {Record<string, { adept: string | null; legendary: string | null }>}
 */
export function createEmptyStrategyBadgeUnlockTimes() {
  return Object.fromEntries(VARIANT_STRATEGY_IDS.map((sid) => [sid, emptyUnlockRecord()]));
}
