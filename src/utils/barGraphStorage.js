/**
 * 막대그래프 인라인 저장 — ⟦BARGRAPH:…⟧ (JSON, encodeURIComponent)
 */

export const BARGRAPH_MARK = '⟦BARGRAPH:';
export const BARGRAPH_END = '⟧';
export const INLINE_BARGRAPH_CLASS = 'inline-bar-graph-chip';

/** @typedef {{
 *   name: string,
 *   values: number[],
 *   color?: string,
 * }} BarGraphSeries */

/** @typedef {{
 *   version: number,
 *   title?: string,
 *   yLabel?: string,
 *   xLabel?: string,
 *   unit?: string,
 *   orientation?: 'vertical' | 'horizontal',
 *   categories: string[],
 *   scaleMax: number,
 *   scaleStep: number,
 *   values: number[],
 *   series?: BarGraphSeries[],
 * }} BarGraphConfig */

/** @typedef {{ scaleMax: number, scaleStep: number, minorStep: number }} BarGraphScale */

const DEFAULT_CATEGORIES = ['가', '나', '다', '라'];
const DEFAULT_VALUES = [140, 180, 80, 220];
const DEFAULT_GROUPED_CATEGORIES = ['축구', '수영', '피구', '배드민턴'];
const DEFAULT_GROUPED_SERIES = [
  { name: '남학생', values: [110, 70, 70, 110] },
  { name: '여학생', values: [60, 100, 80, 110] },
];
const BAR_COLORS = ['#ef4444', '#3b82f6', '#eab308', '#22c55e', '#a855f7', '#f97316', '#06b6d4', '#64748b'];
/** 묶음 막대: 남학생=빨강, 여학생=파랑 (그룹 추가 시 팔레트 순서) */
const GROUPED_SERIES_COLORS = ['#ef4444', '#3b82f6', '#eab308', '#22c55e'];

/**
 * @param {BarGraphConfig} config
 * @returns {boolean}
 */
export function isGroupedBarGraph(config) {
  return Array.isArray(config.series) && config.series.length >= 2;
}

/**
 * @param {BarGraphConfig} config
 * @returns {number[]}
 */
export function getBarGraphValuePool(config) {
  if (isGroupedBarGraph(config)) {
    return config.series.flatMap((s) => s.values);
  }
  return config.values;
}

/**
 * @param {unknown} raw
 * @param {number} catLen
 * @returns {BarGraphSeries[] | undefined}
 */
function normalizeBarGraphSeries(raw, catLen) {
  if (!Array.isArray(raw)) return undefined;
  const series = raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const o = /** @type {Record<string, unknown>} */ (item);
      const name = String(o.name ?? '').trim();
      if (!name) return null;
      const valuesIn = Array.isArray(o.values) ? o.values : [];
      const values = Array.from({ length: catLen }, (_, i) => {
        const v = Number(valuesIn[i]);
        if (!Number.isFinite(v) || v < 0) return 0;
        return Math.round(v * 1000) / 1000;
      });
      return { name, values };
    })
    .filter(Boolean);
  return series.length >= 2 ? /** @type {BarGraphSeries[]} */ (series) : undefined;
}

/**
 * 값 크기에 맞춰 굵은·점선 눈금 간격 자동 결정
 * @param {number[]} values
 * @returns {BarGraphScale}
 */
export function computeBarGraphScale(values) {
  const nums = (values || []).filter((v) => Number.isFinite(v) && v >= 0);
  const peak = nums.length ? Math.max(...nums) : 0;

  if (peak <= 0) {
    return { scaleMax: 10, scaleStep: 2, minorStep: 1 };
  }

  const rawStep = peak / 5;
  const mag = 10 ** Math.floor(Math.log10(Math.max(rawStep, 1e-9)));
  const norm = rawStep / mag;
  let nice;
  if (norm <= 1.5) nice = 1;
  else if (norm <= 3) nice = 2;
  else if (norm <= 7) nice = 5;
  else nice = 10;

  const scaleStep = Math.max(1, Math.round(nice * mag));
  const scaleMax = Math.max(scaleStep, Math.ceil(peak / scaleStep) * scaleStep);
  const minorStep = scaleStep / 5;

  return { scaleMax, scaleStep, minorStep };
}

/** @returns {BarGraphConfig} */
export function createDefaultBarGraphConfig() {
  const categories = [...DEFAULT_CATEGORIES];
  const values = [...DEFAULT_VALUES];
  const { scaleMax, scaleStep } = computeBarGraphScale(values);
  return {
    version: 1,
    title: '',
    yLabel: '배출량',
    xLabel: '마을',
    unit: '(kg)',
    orientation: 'vertical',
    categories,
    scaleMax,
    scaleStep,
    values,
  };
}

/** @returns {BarGraphConfig} */
export function createDefaultGroupedBarGraphConfig() {
  const categories = [...DEFAULT_GROUPED_CATEGORIES];
  const series = DEFAULT_GROUPED_SERIES.map((s) => ({
    name: s.name,
    values: [...s.values],
  }));
  const valuePool = series.flatMap((s) => s.values);
  const { scaleMax, scaleStep } = computeBarGraphScale(valuePool);
  return {
    version: 1,
    title: '좋아하는 운동별 학생 수',
    yLabel: '학생 수',
    xLabel: '운동',
    unit: '(명)',
    orientation: 'vertical',
    categories,
    scaleMax,
    scaleStep,
    values: series[0].values,
    series,
  };
}

/**
 * @param {unknown} raw
 * @returns {BarGraphConfig}
 */
export function normalizeBarGraphConfig(raw) {
  const base = createDefaultBarGraphConfig();
  if (!raw || typeof raw !== 'object') return base;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const categories = Array.isArray(o.categories)
    ? o.categories.map((c) => String(c ?? '').trim()).filter(Boolean)
    : base.categories;
  const cats = categories.length ? categories.slice(0, 8) : [...DEFAULT_CATEGORIES];

  const series = normalizeBarGraphSeries(o.series, cats.length);

  const valuesIn = Array.isArray(o.values) ? o.values : [];
  const values = cats.map((_, i) => {
    if (series?.[0]?.values?.[i] != null) return series[0].values[i];
    const v = Number(valuesIn[i]);
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.round(v * 1000) / 1000;
  });

  const valuePool = series ? series.flatMap((s) => s.values) : values;
  const { scaleMax, scaleStep } = computeBarGraphScale(valuePool);
  const orientation = o.orientation === 'horizontal' ? 'horizontal' : 'vertical';

  return {
    version: 1,
    title: String(o.title ?? '').trim(),
    yLabel: String(o.yLabel ?? base.yLabel).trim() || base.yLabel,
    xLabel: String(o.xLabel ?? base.xLabel).trim() || base.xLabel,
    unit: String(o.unit ?? base.unit).trim(),
    orientation,
    categories: cats,
    scaleMax,
    scaleStep,
    values,
    ...(series ? { series } : {}),
  };
}

/**
 * @param {BarGraphConfig} config
 * @returns {string}
 */
export function encodeBarGraphMarker(config) {
  const norm = normalizeBarGraphConfig(config);
  return `${BARGRAPH_MARK}${encodeURIComponent(JSON.stringify(norm))}${BARGRAPH_END}`;
}

/**
 * @param {string} markerSlice encoded payload without wrappers
 * @returns {BarGraphConfig | null}
 */
export function decodeBarGraphPayload(markerSlice) {
  try {
    const json = decodeURIComponent(String(markerSlice ?? ''));
    return normalizeBarGraphConfig(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function textContainsBarGraph(text) {
  return String(text ?? '').includes(BARGRAPH_MARK);
}

/**
 * @param {string} text
 * @returns {string}
 */
export function barGraphToPlainSummary(text) {
  const s = String(text ?? '');
  const re = new RegExp(`${escapeRegExp(BARGRAPH_MARK)}([^${escapeRegExp(BARGRAPH_END)}]+)${escapeRegExp(BARGRAPH_END)}`, 'g');
  return s.replace(re, () => '[막대그래프]');
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {number} index */
export function barColorAt(index) {
  return BAR_COLORS[index % BAR_COLORS.length];
}

/** @param {number} index */
export function seriesColorAt(index) {
  return GROUPED_SERIES_COLORS[index % GROUPED_SERIES_COLORS.length];
}

/**
 * @param {number} raw
 * @param {number} minorStep
 * @returns {number}
 */
export function snapBarGraphValue(raw, minorStep) {
  const step = minorStep > 0 ? minorStep : 1;
  const snapped = Math.round(raw / step) * step;
  return Math.max(0, Math.round(snapped * 1000) / 1000);
}
