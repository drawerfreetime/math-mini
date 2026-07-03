/** 한국 시각(KST, UTC+9) 기준 최근 30일(오늘 포함) 랭킹 롤업 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const ROLLING_RANKING_DAYS = 30;

/**
 * @param {Date} [date]
 * @returns {string} YYYY-MM-DD (KST 달력 날짜)
 */
export function getKstDateKey(date = new Date()) {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** @param {string} dateKey YYYY-MM-DD @param {Date} [anchorDate] */
export function isDateKeyInRollingWindow(dateKey, anchorDate = new Date()) {
  const key = String(dateKey || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const startKey = getRollingWindowStartKey(anchorDate);
  const endKey = getKstDateKey(anchorDate);
  return key >= startKey && key <= endKey;
}

/** 오늘(KST) 포함 과거 29일 — 총 30일 */
export function getRollingWindowStartKey(anchorDate = new Date()) {
  const endKey = getKstDateKey(anchorDate);
  const [y, mo, d] = endKey.split('-').map(Number);
  const endUtcMs = Date.UTC(y, mo - 1, d);
  const startUtcMs = endUtcMs - (ROLLING_RANKING_DAYS - 1) * 86400000;
  const startKst = new Date(startUtcMs + KST_OFFSET_MS);
  const sy = startKst.getUTCFullYear();
  const sm = String(startKst.getUTCMonth() + 1).padStart(2, '0');
  const sd = String(startKst.getUTCDate()).padStart(2, '0');
  return `${sy}-${sm}-${sd}`;
}

/**
 * @param {Record<string, number>|null|undefined} dailyMap
 * @param {Date} [anchorDate]
 */
export function sumRolling30Daily(dailyMap, anchorDate = new Date()) {
  if (!dailyMap || typeof dailyMap !== 'object') return 0;
  const startKey = getRollingWindowStartKey(anchorDate);
  const endKey = getKstDateKey(anchorDate);
  let sum = 0;
  for (const [key, val] of Object.entries(dailyMap)) {
    if (key >= startKey && key <= endKey) {
      sum += Math.max(0, Number(val) || 0);
    }
  }
  return sum;
}

/** 창 밖 날짜 제거(저장 용량 절약) */
export function pruneDailyToRollingWindow(dailyMap, anchorDate = new Date()) {
  const startKey = getRollingWindowStartKey(anchorDate);
  const out = {};
  if (!dailyMap || typeof dailyMap !== 'object') return out;
  for (const [key, val] of Object.entries(dailyMap)) {
    if (key >= startKey) {
      const n = Math.max(0, Number(val) || 0);
      if (n > 0) out[key] = n;
    }
  }
  return out;
}

/**
 * @param {Record<string, number>|null|undefined} dailyMap
 * @param {string} dateKey KST YYYY-MM-DD
 * @param {number} points
 * @param {Date} [anchorDate] prune·합산 기준 '오늘'
 */
export function applyDailyPoints(dailyMap, dateKey, points, anchorDate = new Date()) {
  const pts = Math.max(0, Math.floor(Number(points) || 0));
  const daily = pruneDailyToRollingWindow({ ...(dailyMap || {}) }, anchorDate);
  if (pts > 0 && isDateKeyInRollingWindow(dateKey, anchorDate)) {
    daily[dateKey] = (Number(daily[dateKey]) || 0) + pts;
  }
  return {
    explorationDaily: daily,
    explorationRolling30: sumRolling30Daily(daily, anchorDate),
  };
}

/**
 * @param {{ explorationDaily?: Record<string, number>; explorationRolling30?: number }} student
 * @param {Date} [anchorDate]
 */
export function getStudentRolling30Points(student, anchorDate = new Date()) {
  if (!student) return 0;
  if (student.explorationDaily && typeof student.explorationDaily === 'object') {
    return sumRolling30Daily(student.explorationDaily, anchorDate);
  }
  return Math.max(0, Number(student.explorationRolling30) || 0);
}
