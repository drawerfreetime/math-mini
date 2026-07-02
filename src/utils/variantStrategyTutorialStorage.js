import { VARIANT_STRATEGY_TUTORIAL_VERSION } from '../constants/variantStrategyTutorialData';

const KEY_PREFIX = 'variant_strategy_tutorial_done_';

export function isVariantStrategyTutorialDone(uuid) {
  if (!uuid) return false;
  try {
    return localStorage.getItem(`${KEY_PREFIX}${VARIANT_STRATEGY_TUTORIAL_VERSION}_${uuid}`) === '1';
  } catch {
    return false;
  }
}

export function markVariantStrategyTutorialDone(uuid) {
  if (!uuid) return;
  try {
    localStorage.setItem(`${KEY_PREFIX}${VARIANT_STRATEGY_TUTORIAL_VERSION}_${uuid}`, '1');
  } catch {
    /* ignore */
  }
}
