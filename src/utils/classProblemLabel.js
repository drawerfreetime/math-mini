/**
 * 학급 문제은행 라벨 — MMDD 문제N
 *
 * 표시용 날짜(MMDD)와 카운터 키(YYYYMMDD)를 분리합니다.
 * MMDD만 쓰면 매년 같은 날(예: 6/24)의 순번이 이어져 0624 문제256처럼 보일 수 있습니다.
 */

/**
 * @param {Date} [date]
 * @returns {string} MMDD — 라벨 표시용
 */
export function formatLabelDateKey(date = new Date()) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

/**
 * @param {Date} [date]
 * @returns {string} YYYYMMDD — 당일 순번 카운터 문서 ID
 */
export function formatCounterDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

/**
 * @param {string} dateKey MMDD
 * @param {number} seq 1-based
 * @returns {string} 예: 0615 문제1
 */
export function buildClassProblemLabel(dateKey, seq) {
  return `${dateKey} 문제${seq}`;
}

/**
 * @param {object} row problemBank 행
 * @returns {number}
 */
export function resolveProblemLabelYear(row) {
  const y = Number(row?.labelYear);
  if (Number.isFinite(y) && y >= 2000 && y <= 2100) return y;
  const ra = row?.registeredAt;
  if (ra?.toDate) return ra.toDate().getFullYear();
  if (typeof ra?.toMillis === 'function') return new Date(ra.toMillis()).getFullYear();
  return new Date().getFullYear();
}

/**
 * @param {object} row
 * @returns {string} YYYY:MMDD
 */
export function problemLabelDayKey(row) {
  const mmdd = String(row?.labelDate || '').trim() || formatLabelDateKey();
  return `${resolveProblemLabelYear(row)}:${mmdd}`;
}

function problemRegisteredMillis(row) {
  return row?.registeredAt?.toMillis?.() || 0;
}

/**
 * Firestore에 저장된 잘못된 순번을 읽기 시점에 1,2,3… 으로 보정합니다.
 * (학생은 problemBank 라벨 필드 수정 권한이 없어 표시용 정규화가 필요)
 *
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function normalizeClassProblemLabelsForDisplay(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const byDay = new Map();
  for (const row of rows) {
    const key = problemLabelDayKey(row);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  }

  const patchById = new Map();
  for (const group of byDay.values()) {
    const sorted = [...group].sort(
      (a, b) => problemRegisteredMillis(a) - problemRegisteredMillis(b),
    );
    for (let i = 0; i < sorted.length; i += 1) {
      const row = sorted[i];
      const mmdd = String(row.labelDate || '').trim() || formatLabelDateKey();
      patchById.set(row.id, {
        dailySeq: i + 1,
        label: buildClassProblemLabel(mmdd, i + 1),
      });
    }
  }

  return rows.map((row) => {
    const patch = patchById.get(row.id);
    return patch ? { ...row, ...patch } : row;
  });
}
