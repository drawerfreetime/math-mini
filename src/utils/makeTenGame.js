/**
 * 10만들기 — 사각형 드래그로 합이 10인 숫자 제거
 */

export const MAKE_TEN_COLS = 16;
export const MAKE_TEN_ROWS = 6;
export const MAKE_TEN_ROUND_SEC = 120;
/** 쉬움 난이도 숫자 블록 기준 크기(px) */
export const MAKE_TEN_CELL_SIZE_BASE = 70;
/** 제거 +10점 대비 남은 블록 감점 (약 30%) */
export const MAKE_TEN_REMAINING_PENALTY_PER_CELL = 3;

/** 합이 10이 되는 한 자리 짝 */
const MAKE_TEN_PAIRS = [
  [1, 9], [2, 8], [3, 7], [4, 6], [5, 5],
];

function randDigit() {
  return Math.floor(Math.random() * 9) + 1;
}

export function createMakeTenGrid(rows = MAKE_TEN_ROWS, cols = MAKE_TEN_COLS) {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => randDigit())
  );
}

/** 인접(가로·세로)한 두 칸에 합 10 짝을 여러 개 심은 뒤 나머지는 랜덤 */
export function createMakeTenGridEasy(rows, cols) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(null));
  const targetPairs = Math.max(8, Math.floor((rows * cols) * 0.22));
  let placed = 0;
  let attempts = 0;
  const maxAttempts = targetPairs * 30;

  while (placed < targetPairs && attempts < maxAttempts) {
    attempts += 1;
    const r = Math.floor(Math.random() * rows);
    const c = Math.floor(Math.random() * cols);
    const horizontal = Math.random() < 0.5;
    const r2 = horizontal ? r : r + 1;
    const c2 = horizontal ? c + 1 : c;
    if (r2 >= rows || c2 >= cols) continue;
    if (grid[r][c] != null || grid[r2][c2] != null) continue;
    const [a, b] = MAKE_TEN_PAIRS[Math.floor(Math.random() * MAKE_TEN_PAIRS.length)];
    grid[r][c] = a;
    grid[r2][c2] = b;
    placed += 1;
  }

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (grid[r][c] == null) grid[r][c] = randDigit();
    }
  }
  return grid;
}

export const MAKE_TEN_DIFFICULTIES = {
  easy: {
    id: 'easy',
    label: '쉬움',
    emoji: '🌱',
    cellSize: 70,
    rows: 5,
    cols: 12,
    roundSec: 90,
    pointsPerCell: 10,
    timeBonusPerSec: 10,
    remainingPenaltyPerCell: MAKE_TEN_REMAINING_PENALTY_PER_CELL,
    trophyScore: 120,
    createGrid: (rows, cols) => createMakeTenGridEasy(rows, cols),
    idleDesc: '인접한 10 짝이 곳곳에 있어요. 90초 챌린지!',
    hint: '사각형 드래그 · 숫자 2개 이상 · 합 10 · 손을 떼면 확인!',
  },
  normal: {
    id: 'normal',
    label: '보통',
    emoji: '⚡',
    cellSize: 55,
    rows: MAKE_TEN_ROWS,
    cols: MAKE_TEN_COLS,
    roundSec: MAKE_TEN_ROUND_SEC,
    pointsPerCell: 10,
    timeBonusPerSec: 10,
    remainingPenaltyPerCell: MAKE_TEN_REMAINING_PENALTY_PER_CELL,
    trophyScore: 200,
    createGrid: (rows, cols) => createMakeTenGrid(rows, cols),
    idleDesc: '선택한 숫자(2개 이상)의 합이 10이면 사라져요. 120초 챌린지!',
    hint: '사각형 드래그 · 숫자 2개 이상 · 합 10 · 손을 떼면 확인!',
  },
  hard: {
    id: 'hard',
    label: '어려움',
    emoji: '🔥',
    cellSize: 52,
    rows: 7,
    cols: 18,
    roundSec: 120,
    pointsPerCell: 10,
    timeBonusPerSec: 10,
    remainingPenaltyPerCell: MAKE_TEN_REMAINING_PENALTY_PER_CELL,
    trophyScore: 250,
    createGrid: (rows, cols) => createMakeTenGrid(rows, cols),
    idleDesc: '넓은 판에서 10 만들기. 120초 챌린지!',
    hint: '사각형 드래그 · 숫자 2개 이상 · 합 10 · 더 못 만들면 시간 보너스!',
  },
};

/** 앵커·커서 칸으로 사각형 안의 모든 칸 */
export function cellsInRect(anchor, cursor) {
  if (!anchor || !cursor) return [];
  const rMin = Math.min(anchor.r, cursor.r);
  const rMax = Math.max(anchor.r, cursor.r);
  const cMin = Math.min(anchor.c, cursor.c);
  const cMax = Math.max(anchor.c, cursor.c);
  const cells = [];
  for (let r = rMin; r <= rMax; r += 1) {
    for (let c = cMin; c <= cMax; c += 1) {
      cells.push({ r, c });
    }
  }
  return cells;
}

export function rectBounds(anchor, cursor) {
  if (!anchor || !cursor) return null;
  return {
    rMin: Math.min(anchor.r, cursor.r),
    rMax: Math.max(anchor.r, cursor.r),
    cMin: Math.min(anchor.c, cursor.c),
    cMax: Math.max(anchor.c, cursor.c),
  };
}

export function rectSum(grid, cells) {
  return cells.reduce((sum, { r, c }) => {
    const v = grid[r]?.[c];
    return v != null ? sum + v : sum;
  }, 0);
}

export function rectFilledCount(grid, cells) {
  return cells.reduce((n, { r, c }) => (grid[r]?.[c] != null ? n + 1 : n), 0);
}

/** 선택 칸의 숫자만 제거 (빈 칸 유지, 사과게임 방식) */
export function removeCells(grid, cells) {
  const next = grid.map((row) => [...row]);
  cells.forEach(({ r, c }) => {
    if (next[r]?.[c] != null) next[r][c] = null;
  });
  return next;
}

function rectRegionSum(grid, rMin, rMax, cMin, cMax) {
  let sum = 0;
  let filled = 0;
  for (let r = rMin; r <= rMax; r += 1) {
    for (let c = cMin; c <= cMax; c += 1) {
      const v = grid[r]?.[c];
      if (v != null) {
        sum += v;
        filled += 1;
      }
    }
  }
  return { sum, filled };
}

/** 격자에 남은 숫자 칸 수 */
export function countFilledCells(grid) {
  return grid.reduce(
    (n, row) => n + row.reduce((m, v) => (v != null ? m + 1 : m), 0),
    0,
  );
}

/** 사각형 선택으로 합 10을 만들 수 있는 조합이 남아 있는지 */
export function hasAnyMakeTenMove(grid) {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (!rows || !cols) return false;

  for (let rMin = 0; rMin < rows; rMin += 1) {
    for (let rMax = rMin; rMax < rows; rMax += 1) {
      for (let cMin = 0; cMin < cols; cMin += 1) {
        for (let cMax = cMin; cMax < cols; cMax += 1) {
          const { sum, filled } = rectRegionSum(grid, rMin, rMax, cMin, cMax);
          if (filled >= 2 && sum === 10) return true;
        }
      }
    }
  }
  return false;
}

export function cellFromGridPoint(gridEl, clientX, clientY, cols, rows) {
  if (!gridEl) return null;

  const hits = document.elementsFromPoint(clientX, clientY);
  const cellEl = hits.find((el) => el.dataset?.mmtR != null && gridEl.contains(el));
  if (cellEl) {
    return {
      r: Number(cellEl.dataset.mmtR),
      c: Number(cellEl.dataset.mmtC),
    };
  }

  const rect = gridEl.getBoundingClientRect();
  const styles = window.getComputedStyle(gridEl);
  const gap = parseFloat(styles.columnGap) || 5;

  const x = Math.min(rect.right - 1, Math.max(rect.left, clientX));
  const y = Math.min(rect.bottom - 1, Math.max(rect.top, clientY));

  const cellSize = (rect.width - gap * (cols - 1)) / cols;
  const c = Math.min(
    cols - 1,
    Math.max(0, Math.floor((x - rect.left) / (cellSize + gap))),
  );
  const r = Math.min(
    rows - 1,
    Math.max(0, Math.floor((y - rect.top) / (cellSize + gap))),
  );
  return { r, c };
}

/** 격자 셀 DOM 기준으로 선택 박스 픽셀 위치 계산 */
export function marqueePixelsFromBounds(gridEl, wrapEl, bounds) {
  if (!gridEl || !wrapEl || !bounds) return null;

  const topLeft = gridEl.querySelector(
    `[data-mmt-r="${bounds.rMin}"][data-mmt-c="${bounds.cMin}"]`,
  );
  const bottomRight = gridEl.querySelector(
    `[data-mmt-r="${bounds.rMax}"][data-mmt-c="${bounds.cMax}"]`,
  );
  if (!topLeft || !bottomRight) return null;

  const wrapBox = wrapEl.getBoundingClientRect();
  const tl = topLeft.getBoundingClientRect();
  const br = bottomRight.getBoundingClientRect();

  return {
    left: tl.left - wrapBox.left,
    top: tl.top - wrapBox.top,
    width: br.right - tl.left,
    height: br.bottom - tl.top,
  };
}
