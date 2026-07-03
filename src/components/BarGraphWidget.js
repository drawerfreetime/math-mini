/**
 * 막대그래프 미리보기(SVG) + 편집 모달 — 교과서 격자형
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  barColorAt,
  computeBarGraphScale,
  createDefaultBarGraphConfig,
  createDefaultGroupedBarGraphConfig,
  getBarGraphValuePool,
  isGroupedBarGraph,
  normalizeBarGraphConfig,
  seriesColorAt,
  snapBarGraphValue,
} from '../utils/barGraphStorage';
import './BarGraphWidget.css';

const CHART_W = 460;
const CHART_H = 290;
const THICK = 2;
const LABEL_BG = '#ececec';
const GRID_MAJOR = '#111';
const GRID_MINOR = '#888';

/** @param {{ compact?: boolean }} p */
function chartFonts(p = {}) {
  const { compact = false } = p;
  return {
    tick: compact ? 9 : 10,
    cat: compact ? 10 : 11,
    corner: compact ? 8 : 9,
    unit: compact ? 9 : 10,
  };
}

/** @param {number} tick @param {number} scaleMax */
function tickAnchor(tick, scaleMax) {
  if (tick <= 0) return 'start';
  if (tick >= scaleMax) return 'end';
  return 'middle';
}

/** @param {number} tick @param {number} scaleMax @param {number} x @param {number} plotX */
function tickX(tick, scaleMax, x, plotX) {
  if (tick <= 0) return plotX + 3;
  if (tick >= scaleMax) return x - 2;
  return x;
}

/**
 * 교과서 원점 칸 — 대각선: 왼쪽 아래 → 오른쪽 위(원점)
 * 세로 막대: 위·왼쪽=값(yLabel) / 아래·오른쪽=항목(xLabel)
 * 가로 막대: 위·왼쪽=항목(xLabel) / 아래·오른쪽=값(yLabel)
 * @param {{
 *   cornerH: number,
 *   originX: number,
 *   originY: number,
 *   topLeftLabel: string,
 *   bottomRightLabel: string,
 *   fontSize: number,
 * }} p
 */
function CornerAxisCell(p) {
  const { cornerH, originX, originY, topLeftLabel, bottomRightLabel, fontSize } = p;
  const bottomY = originY + cornerH;

  return (
    <g>
      <rect x={0} y={originY} width={originX} height={cornerH} fill={LABEL_BG} stroke="none" />
      {/* 왼쪽·아래 테두리 (위·오른쪽은 격자와 연결) */}
      <line x1={0} y1={originY} x2={0} y2={bottomY} stroke={GRID_MAJOR} strokeWidth={THICK} />
      <line x1={0} y1={bottomY} x2={originX} y2={bottomY} stroke={GRID_MAJOR} strokeWidth={THICK} />
      {/* 대각선: 왼쪽 아래 → 원점(오른쪽 위) */}
      <line x1={0} y1={bottomY} x2={originX} y2={originY} stroke={GRID_MAJOR} strokeWidth={1} />

      <text
        x={originX * 0.34}
        y={originY + cornerH * 0.30}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize}
        fill="#222"
      >
        {topLeftLabel}
      </text>
      <text
        x={originX * 0.66}
        y={originY + cornerH * 0.72}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize}
        fill="#222"
      >
        {bottomRightLabel}
      </text>
    </g>
  );
}

/**
 * @param {import('../utils/barGraphStorage').BarGraphConfig} config
 * @param {{ compact?: boolean, interactive?: boolean, onBarPick?: (index: number, value: number, seriesIndex?: number) => void }} [opts]
 */
export function BarGraphSvg({ config, opts = {} }) {
  const { compact = false, interactive = false, onBarPick } = opts;
  const norm = normalizeBarGraphConfig(config);
  const {
    categories,
    values,
    yLabel,
    xLabel,
    unit,
    orientation,
    title,
    series,
  } = norm;

  const grouped = isGroupedBarGraph(norm);
  const seriesList = grouped ? series : null;
  const valuePool = getBarGraphValuePool(norm);
  const { scaleMax, scaleStep, minorStep } = computeBarGraphScale(valuePool);

  const isVertical = orientation === 'vertical';
  const unitSlotW = unit && !isVertical ? Math.max(36, unit.length * 7 + 10) : 0;
  const baseW = compact ? 380 : CHART_W;
  const h = compact ? 230 : CHART_H;
  const font = chartFonts({ compact });

  const legendMetrics = grouped && seriesList?.length
    ? (() => {
        const itemH = compact ? 12 : 14;
        const swatch = compact ? 10 : 12;
        const fontSize = compact ? 8 : 9;
        const maxLabelW = Math.max(...seriesList.map((s) => s.name.length * (compact ? 6.5 : 7.5)));
        const legendW = swatch + 4 + maxLabelW;
        const legendH = seriesList.length * itemH + (seriesList.length - 1) * 2;
        const legendGap = compact ? 6 : 8;
        const legendSlotW = legendW + legendGap + (compact ? 4 : 6);
        return { itemH, swatch, fontSize, legendW, legendH, legendGap, legendSlotW };
      })()
    : null;

  const w = baseW + (legendMetrics?.legendSlotW ?? 0);

  const cornerW = compact ? 52 : 62;
  const cornerH = compact ? 36 : 42;
  const topPad = compact ? 20 : 24;
  const rightPad = isVertical ? (compact ? 10 : 12) : Math.max(compact ? 10 : 12, unitSlotW + 6);

  const plotX = cornerW;
  const plotY = topPad;
  const plotW = baseW - cornerW - rightPad;
  const plotH = h - topPad - cornerH;
  const tickLabelX = plotX - 6;
  const scaleBandY = plotY + plotH + cornerH / 2;
  const originX = plotX;
  const originY = plotY + plotH;
  const n = Math.max(categories.length, 1);

  const majorTicks = [];
  for (let v = 0; v <= scaleMax; v += scaleStep) majorTicks.push(v);

  const minorTicks = [];
  for (let major = 0; major < scaleMax; major += scaleStep) {
    for (let k = 1; k < 5; k += 1) {
      minorTicks.push(major + k * minorStep);
    }
  }

  const displayMax = Math.max(scaleMax, ...valuePool, scaleStep);

  const valPos = (val) => {
    const ratio = val / displayMax;
    return isVertical
      ? plotY + plotH - ratio * plotH
      : plotX + ratio * plotW;
  };

  const snapValue = (raw) => snapBarGraphValue(raw, minorStep);

  const handlePlotClick = (e, index, seriesIndex = 0) => {
    if (!interactive || !onBarPick) return;
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const loc = pt.matrixTransform(ctm.inverse());
    let raw;
    if (isVertical) {
      raw = ((plotY + plotH - loc.y) / plotH) * displayMax;
    } else {
      raw = ((loc.x - plotX) / plotW) * displayMax;
    }
    onBarPick(index, snapValue(raw), grouped ? seriesIndex : undefined);
  };

  const renderLegend = () => {
    if (!legendMetrics || !seriesList?.length) return null;
    const { itemH, swatch, fontSize, legendH, legendGap } = legendMetrics;
    const legendX = plotX + plotW + legendGap;
    const legendY = plotY + (plotH - legendH) / 2;

    return (
      <g aria-hidden="true">
        {seriesList.map((ser, si) => {
          const y = legendY + si * (itemH + 2);
          return (
            <g key={`legend-${si}`}>
              <rect
                x={legendX}
                y={y}
                width={swatch}
                height={swatch}
                fill={seriesColorAt(si)}
                stroke="#333"
                strokeWidth={0.5}
              />
              <text
                x={legendX + swatch + 4}
                y={y + swatch / 2}
                dominantBaseline="middle"
                alignmentBaseline="middle"
                fontSize={fontSize}
                fill="#222"
              >
                {ser.name}
              </text>
            </g>
          );
        })}
      </g>
    );
  };

  const diagonalCorner = (
    <CornerAxisCell
      cornerH={cornerH}
      originX={originX}
      originY={originY}
      topLeftLabel={isVertical ? yLabel : xLabel}
      bottomRightLabel={isVertical ? xLabel : yLabel}
      fontSize={font.corner}
    />
  );

  const renderVertical = () => {
    const colW = plotW / n;
    return (
      <>
        <rect
          x={0}
          y={plotY}
          width={cornerW}
          height={plotH}
          fill={LABEL_BG}
          stroke={GRID_MAJOR}
          strokeWidth={THICK}
        />

        {unit ? (
          <text
            x={cornerW / 2}
            y={plotY - 7}
            textAnchor="middle"
            fontSize={font.unit}
            fill="#333"
          >
            {unit}
          </text>
        ) : null}

        <rect
          x={plotX}
          y={plotY}
          width={plotW}
          height={plotH}
          fill="#fff"
          stroke={GRID_MAJOR}
          strokeWidth={THICK}
        />

        {minorTicks.map((tick) => {
          const y = valPos(tick);
          return (
            <line
              key={`min-h-${tick}`}
              x1={plotX}
              y1={y}
              x2={plotX + plotW}
              y2={y}
              stroke={GRID_MINOR}
              strokeWidth={0.8}
              strokeDasharray="3,3"
            />
          );
        })}

        {majorTicks.map((tick) => {
          const y = valPos(tick);
          return (
            <g key={`maj-h-${tick}`}>
              <line
                x1={plotX}
                y1={y}
                x2={plotX + plotW}
                y2={y}
                stroke={GRID_MAJOR}
                strokeWidth={THICK}
              />
              <text
                x={tickLabelX}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                alignmentBaseline="middle"
                fontSize={font.tick}
                fill="#222"
              >
                {tick}
              </text>
            </g>
          );
        })}

        {Array.from({ length: n + 1 }, (_, i) => {
          const x = plotX + i * colW;
          return (
            <line
              key={`vcol-${i}`}
              x1={x}
              y1={plotY}
              x2={x}
              y2={plotY + plotH}
              stroke={GRID_MAJOR}
              strokeWidth={THICK}
            />
          );
        })}

        {categories.map((cat, i) => {
          const cx = plotX + i * colW + colW / 2;
          const cellX = plotX + i * colW;
          const seriesCount = grouped && seriesList ? seriesList.length : 1;
          const groupW = colW * 0.72;
          const slotW = groupW / seriesCount;

          return (
            <g key={`vbar-${i}`}>
              <rect
                x={cellX}
                y={plotY + plotH}
                width={colW}
                height={cornerH}
                fill={LABEL_BG}
                stroke={GRID_MAJOR}
                strokeWidth={THICK}
              />
              <text
                x={cx}
                y={plotY + plotH + cornerH / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                alignmentBaseline="middle"
                fontSize={font.cat}
                fill="#222"
              >
                {cat.length > 8 ? `${cat.slice(0, 7)}…` : cat}
              </text>

              {grouped && seriesList
                ? seriesList.map((ser, si) => {
                    const val = ser.values[i] ?? 0;
                    const barW = slotW * 0.82;
                    const barX = cellX + (colW - groupW) / 2 + si * slotW + (slotW - barW) / 2;
                    const y0 = valPos(0);
                    const y1 = valPos(val);
                    const barH = Math.max(0, y0 - y1);
                    return (
                      <g key={`vbar-${i}-${si}`}>
                        {val > 0 ? (
                          <rect
                            x={barX}
                            y={y1}
                            width={barW}
                            height={barH}
                            fill={seriesColorAt(si)}
                            stroke="none"
                            pointerEvents="none"
                          />
                        ) : null}
                        {interactive ? (
                          <rect
                            x={barX}
                            y={plotY}
                            width={barW}
                            height={plotH}
                            fill="transparent"
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => handlePlotClick(e, i, si)}
                          />
                        ) : null}
                      </g>
                    );
                  })
                : (() => {
                    const val = values[i] ?? 0;
                    const barW = colW * 0.55;
                    const barX = cx - barW / 2;
                    const y0 = valPos(0);
                    const y1 = valPos(val);
                    const barH = Math.max(0, y0 - y1);
                    return (
                      <>
                        {val > 0 ? (
                          <rect
                            x={barX}
                            y={y1}
                            width={barW}
                            height={barH}
                            fill={barColorAt(i)}
                            stroke="none"
                            pointerEvents="none"
                          />
                        ) : null}
                        {interactive ? (
                          <rect
                            x={cellX}
                            y={plotY}
                            width={colW}
                            height={plotH}
                            fill="transparent"
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => handlePlotClick(e, i)}
                          />
                        ) : null}
                      </>
                    );
                  })()}
            </g>
          );
        })}
      </>
    );
  };

  const renderHorizontal = () => {
    const rowH = plotH / n;
    return (
      <>
        <rect
          x={plotX}
          y={plotY}
          width={plotW}
          height={plotH}
          fill="#fff"
          stroke={GRID_MAJOR}
          strokeWidth={THICK}
        />

        {minorTicks.map((tick) => {
          const x = valPos(tick);
          return (
            <line
              key={`min-v-${tick}`}
              x1={x}
              y1={plotY}
              x2={x}
              y2={plotY + plotH}
              stroke={GRID_MINOR}
              strokeWidth={0.8}
              strokeDasharray="3,3"
            />
          );
        })}

        <rect
          x={plotX}
          y={plotY + plotH}
          width={plotW}
          height={cornerH}
          fill={LABEL_BG}
          stroke={GRID_MAJOR}
          strokeWidth={THICK}
        />

        {unit && !isVertical ? (
          <rect
            x={plotX + plotW}
            y={plotY + plotH}
            width={unitSlotW}
            height={cornerH}
            fill={LABEL_BG}
            stroke={GRID_MAJOR}
            strokeWidth={THICK}
          />
        ) : null}

        {majorTicks.map((tick) => {
          const x = valPos(tick);
          const labelX = tickX(tick, scaleMax, x, plotX);
          const anchor = tickAnchor(tick, scaleMax);
          return (
            <g key={`maj-v-${tick}`}>
              <line
                x1={x}
                y1={plotY}
                x2={x}
                y2={plotY + plotH}
                stroke={GRID_MAJOR}
                strokeWidth={THICK}
              />
              <text
                x={labelX}
                y={scaleBandY}
                textAnchor={anchor}
                dominantBaseline="middle"
                alignmentBaseline="middle"
                fontSize={font.tick}
                fill="#222"
              >
                {tick}
              </text>
            </g>
          );
        })}

        {unit && !isVertical ? (
          <text
            x={plotX + plotW + unitSlotW / 2}
            y={scaleBandY}
            textAnchor="middle"
            dominantBaseline="middle"
            alignmentBaseline="middle"
            fontSize={font.unit}
            fill="#333"
          >
            {unit}
          </text>
        ) : null}

        {Array.from({ length: n + 1 }, (_, i) => {
          const y = plotY + i * rowH;
          return (
            <line
              key={`hrow-${i}`}
              x1={plotX}
              y1={y}
              x2={plotX + plotW}
              y2={y}
              stroke={GRID_MAJOR}
              strokeWidth={THICK}
            />
          );
        })}

        {categories.map((cat, i) => {
          const cy = plotY + i * rowH + rowH / 2;
          const cellY = plotY + i * rowH;
          const seriesCount = grouped && seriesList ? seriesList.length : 1;
          const groupH = rowH * 0.72;
          const slotH = groupH / seriesCount;

          return (
            <g key={`hbar-${i}`}>
              <rect
                x={0}
                y={cellY}
                width={cornerW}
                height={rowH}
                fill={LABEL_BG}
                stroke={GRID_MAJOR}
                strokeWidth={THICK}
              />
              <text
                x={cornerW / 2}
                y={cy}
                textAnchor="middle"
                dominantBaseline="middle"
                alignmentBaseline="middle"
                fontSize={font.cat}
                fill="#222"
              >
                {cat.length > 6 ? `${cat.slice(0, 5)}…` : cat}
              </text>

              {grouped && seriesList
                ? seriesList.map((ser, si) => {
                    const val = ser.values[i] ?? 0;
                    const barH = slotH * 0.82;
                    const barY = cellY + (rowH - groupH) / 2 + si * slotH + (slotH - barH) / 2;
                    const x0 = valPos(0);
                    const x1 = valPos(val);
                    const barW = Math.max(0, x1 - x0);
                    return (
                      <g key={`hbar-${i}-${si}`}>
                        {val > 0 ? (
                          <rect
                            x={x0}
                            y={barY}
                            width={barW}
                            height={barH}
                            fill={seriesColorAt(si)}
                            stroke="none"
                            pointerEvents="none"
                          />
                        ) : null}
                        {interactive ? (
                          <rect
                            x={plotX}
                            y={barY}
                            width={plotW}
                            height={barH}
                            fill="transparent"
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => handlePlotClick(e, i, si)}
                          />
                        ) : null}
                      </g>
                    );
                  })
                : (() => {
                    const val = values[i] ?? 0;
                    const barH = rowH * 0.55;
                    const barY = cy - barH / 2;
                    const x0 = valPos(0);
                    const x1 = valPos(val);
                    const barW = Math.max(0, x1 - x0);
                    return (
                      <>
                        {val > 0 ? (
                          <rect
                            x={x0}
                            y={barY}
                            width={barW}
                            height={barH}
                            fill={barColorAt(i)}
                            stroke="none"
                            pointerEvents="none"
                          />
                        ) : null}
                        {interactive ? (
                          <rect
                            x={plotX}
                            y={cellY}
                            width={plotW}
                            height={rowH}
                            fill="transparent"
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => handlePlotClick(e, i)}
                          />
                        ) : null}
                      </>
                    );
                  })()}
            </g>
          );
        })}

        <line
          x1={plotX}
          y1={plotY + plotH}
          x2={plotX + plotW}
          y2={plotY + plotH}
          stroke={GRID_MAJOR}
          strokeWidth={THICK}
        />
      </>
    );
  };

  return (
    <svg
      className="bar-graph-widget__svg"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      role="img"
      aria-label={title || '막대그래프'}
      textRendering="geometricPrecision"
    >
      {title ? (
        <text x={w / 2} y={12} textAnchor="middle" fontSize="12" fontWeight="700" fill="#334155">
          {title}
        </text>
      ) : null}

      {isVertical ? renderVertical() : renderHorizontal()}
      {renderLegend()}
      {diagonalCorner}
    </svg>
  );
}

/** @param {{ config: import('../utils/barGraphStorage').BarGraphConfig, compact?: boolean }} props */
export function BarGraphPreview({ config, compact = false }) {
  return (
    <div className="bar-graph-widget bar-graph-widget--preview">
      <BarGraphSvg config={config} opts={{ compact }} />
    </div>
  );
}

/**
 * @param {{
 *   open: boolean,
 *   initialConfig?: import('../utils/barGraphStorage').BarGraphConfig | null,
 *   onConfirm: (config: import('../utils/barGraphStorage').BarGraphConfig) => void,
 *   onCancel: () => void,
 * }} props
 */
export function BarGraphEditorModal({ open, initialConfig, onConfirm, onCancel }) {
  const [draft, setDraft] = useState(() => normalizeBarGraphConfig(initialConfig || createDefaultBarGraphConfig()));
  const undoStack = useRef(/** @type {import('../utils/barGraphStorage').BarGraphConfig[]} */ ([]));
  const [canUndo, setCanUndo] = useState(false);

  const resetFromProps = useCallback(() => {
    setDraft(normalizeBarGraphConfig(initialConfig || createDefaultBarGraphConfig()));
    undoStack.current = [];
    setCanUndo(false);
  }, [initialConfig]);

  React.useEffect(() => {
    if (open) resetFromProps();
  }, [open, resetFromProps]);

  const pushUndo = useCallback((prev) => {
    undoStack.current = [...undoStack.current.slice(-19), normalizeBarGraphConfig(prev)];
    setCanUndo(undoStack.current.length > 0);
  }, []);

  const applyDraft = useCallback((updater) => {
    setDraft((prev) => {
      pushUndo(prev);
      const next = typeof updater === 'function' ? updater(prev) : updater;
      return normalizeBarGraphConfig(next);
    });
  }, [pushUndo]);

  const handleUndo = useCallback(() => {
    const stack = undoStack.current;
    if (!stack.length) return;
    const prev = stack[stack.length - 1];
    undoStack.current = stack.slice(0, -1);
    setCanUndo(undoStack.current.length > 0);
    setDraft(normalizeBarGraphConfig(prev));
  }, []);

  const setCategory = useCallback((index, name) => {
    applyDraft((d) => {
      const categories = [...d.categories];
      categories[index] = name;
      return { ...d, categories };
    });
  }, [applyDraft]);

  const setValue = useCallback((index, value) => {
    applyDraft((d) => {
      const values = [...d.values];
      values[index] = value;
      if (isGroupedBarGraph(d) && d.series?.[0]) {
        const series = d.series.map((s, si) => {
          if (si !== 0) return s;
          const nextValues = [...s.values];
          nextValues[index] = value;
          return { ...s, values: nextValues };
        });
        return { ...d, values, series };
      }
      return { ...d, values };
    });
  }, [applyDraft]);

  const setSeriesValue = useCallback((seriesIndex, categoryIndex, value) => {
    applyDraft((d) => {
      if (!d.series?.[seriesIndex]) return d;
      const series = d.series.map((s, si) => {
        if (si !== seriesIndex) return s;
        const nextValues = [...s.values];
        nextValues[categoryIndex] = value;
        return { ...s, values: nextValues };
      });
      const values = seriesIndex === 0 ? [...series[0].values] : [...d.values];
      if (seriesIndex === 0) values[categoryIndex] = value;
      return { ...d, series, values };
    });
  }, [applyDraft]);

  const setSeriesName = useCallback((seriesIndex, name) => {
    applyDraft((d) => {
      if (!d.series?.[seriesIndex]) return d;
      const series = d.series.map((s, si) => (si === seriesIndex ? { ...s, name } : s));
      return { ...d, series };
    });
  }, [applyDraft]);

  const bumpValue = useCallback((index, delta, seriesIndex = 0) => {
    applyDraft((d) => {
      const pool = isGroupedBarGraph(d) ? d.series[seriesIndex].values : d.values;
      const cur = pool[index] ?? 0;
      const { minorStep } = computeBarGraphScale(getBarGraphValuePool(d));
      const step = minorStep >= 1 ? minorStep : 1;
      const nextVal = Math.max(0, cur + delta * step);
      if (isGroupedBarGraph(d)) {
        const series = d.series.map((s, si) => {
          if (si !== seriesIndex) return s;
          const nextValues = [...s.values];
          nextValues[index] = nextVal;
          return { ...s, values: nextValues };
        });
        const values = seriesIndex === 0 ? [...series[0].values] : [...d.values];
        return { ...d, series, values };
      }
      const values = [...d.values];
      values[index] = nextVal;
      return { ...d, values };
    });
  }, [applyDraft]);

  const switchToGrouped = useCallback(() => {
    applyDraft((d) => {
      if (isGroupedBarGraph(d)) return d;
      return createDefaultGroupedBarGraphConfig();
    });
  }, [applyDraft]);

  const switchToSingle = useCallback(() => {
    applyDraft((d) => {
      if (!isGroupedBarGraph(d)) return d;
      const { series, ...rest } = d;
      return normalizeBarGraphConfig({
        ...rest,
        values: [...(series?.[0]?.values ?? d.values)],
      });
    });
  }, [applyDraft]);

  const addSeries = useCallback(() => {
    applyDraft((d) => {
      if (!isGroupedBarGraph(d) || (d.series?.length ?? 0) >= 4) return d;
      const series = [
        ...d.series,
        {
          name: `그룹${d.series.length + 1}`,
          values: d.categories.map(() => 0),
        },
      ];
      return normalizeBarGraphConfig({ ...d, series });
    });
  }, [applyDraft]);

  const removeSeries = useCallback((seriesIndex) => {
    applyDraft((d) => {
      if (!isGroupedBarGraph(d) || (d.series?.length ?? 0) <= 2) return d;
      const series = d.series.filter((_, i) => i !== seriesIndex);
      return normalizeBarGraphConfig({ ...d, series });
    });
  }, [applyDraft]);

  const addCategory = useCallback(() => {
    applyDraft((d) => {
      if (d.categories.length >= 8) return d;
      const next = {
        ...d,
        categories: [...d.categories, `항목${d.categories.length + 1}`],
        values: [...d.values, 0],
      };
      if (isGroupedBarGraph(d)) {
        next.series = d.series.map((s) => ({
          ...s,
          values: [...s.values, 0],
        }));
      }
      return next;
    });
  }, [applyDraft]);

  const removeCategory = useCallback((index) => {
    applyDraft((d) => {
      if (d.categories.length <= 2) return d;
      const next = {
        ...d,
        categories: d.categories.filter((_, i) => i !== index),
        values: d.values.filter((_, i) => i !== index),
      };
      if (isGroupedBarGraph(d)) {
        next.series = d.series.map((s) => ({
          ...s,
          values: s.values.filter((_, i) => i !== index),
        }));
      }
      return next;
    });
  }, [applyDraft]);

  const grouped = isGroupedBarGraph(draft);
  const autoScale = useMemo(() => computeBarGraphScale(getBarGraphValuePool(draft)), [draft]);
  const minorStep = autoScale.minorStep;
  const minorLabel = minorStep >= 1 ? minorStep : Number(minorStep.toFixed(1));

  if (!open) return null;

  return (
    <div
      className="bar-graph-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="bar-graph-modal" role="dialog" aria-modal="true" aria-labelledby="bar-graph-modal-title">
        <div className="bar-graph-modal__header">
          <h2 id="bar-graph-modal-title" className="bar-graph-modal__title">
            📊 막대그래프 넣기
          </h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            닫기
          </button>
        </div>

        <div className="bar-graph-modal__body">
          <p className="bar-graph-modal__hint">
            항목과 값을 입력하세요. 그래프 칸을 클릭해 막대 길이를 조절하거나 <strong>＋／－</strong>로 변경할 수 있습니다.
            <strong> 묶음 막대</strong>를 선택하면 운동 예시가 자동으로 채워지며, 한 항목(예: 축구)에 남학생(빨강)·여학생(파랑) 막대 2개를 나란히 표시할 수 있습니다.
            눈금은 값에 따라 자동 조정됩니다 (0~{autoScale.scaleMax}, 굵은 선 {autoScale.scaleStep} 단위 · 점선 {minorLabel} 단위).
          </p>

          <div className="bar-graph-modal__orient">
            <span className="bar-graph-modal__orient-label">막대 종류</span>
            <button
              type="button"
              className={`bar-graph-modal__orient-btn${!grouped ? ' is-active' : ''}`}
              onClick={switchToSingle}
            >
              단일 막대
            </button>
            <button
              type="button"
              className={`bar-graph-modal__orient-btn${grouped ? ' is-active' : ''}`}
              onClick={switchToGrouped}
            >
              묶음 막대 (남·여 등)
            </button>
          </div>

          <div className="bar-graph-modal__orient">
            <span className="bar-graph-modal__orient-label">방향</span>
            <button
              type="button"
              className={`bar-graph-modal__orient-btn${draft.orientation === 'vertical' ? ' is-active' : ''}`}
              onClick={() => applyDraft((d) => ({ ...d, orientation: 'vertical' }))}
            >
              세로 막대
            </button>
            <button
              type="button"
              className={`bar-graph-modal__orient-btn${draft.orientation === 'horizontal' ? ' is-active' : ''}`}
              onClick={() => applyDraft((d) => ({ ...d, orientation: 'horizontal' }))}
            >
              가로 막대
            </button>
          </div>

          <div className="bar-graph-modal__chart-wrap">
            <BarGraphSvg
              config={draft}
              opts={{
                interactive: true,
                onBarPick: (i, v, seriesIndex) => {
                  if (grouped && seriesIndex != null) {
                    setSeriesValue(seriesIndex, i, v);
                  } else {
                    setValue(i, v);
                  }
                },
              }}
            />
          </div>

          <div className="bar-graph-modal__row">
            <div className="bar-graph-modal__field">
              <label htmlFor="bgraph-title">제목</label>
              <input
                id="bgraph-title"
                value={draft.title ?? ''}
                placeholder="좋아하는 운동별 학생 수"
                onChange={(e) => applyDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>
          </div>

          <div className="bar-graph-modal__row">
            <div className="bar-graph-modal__field">
              <label htmlFor="bgraph-ylabel">{draft.orientation === 'vertical' ? '세로축(값)' : '가로축(값)'}</label>
              <input
                id="bgraph-ylabel"
                value={draft.yLabel}
                onChange={(e) => applyDraft((d) => ({ ...d, yLabel: e.target.value }))}
              />
            </div>
            <div className="bar-graph-modal__field">
              <label htmlFor="bgraph-xlabel">{draft.orientation === 'vertical' ? '가로축(항목)' : '세로축(항목)'}</label>
              <input
                id="bgraph-xlabel"
                value={draft.xLabel}
                onChange={(e) => applyDraft((d) => ({ ...d, xLabel: e.target.value }))}
              />
            </div>
            <div className="bar-graph-modal__field">
              <label htmlFor="bgraph-unit">단위</label>
              <input
                id="bgraph-unit"
                value={draft.unit}
                placeholder="(kg), (명) …"
                onChange={(e) => applyDraft((d) => ({ ...d, unit: e.target.value }))}
              />
            </div>
          </div>

          <div className="bar-graph-modal__cats">
            <div className="bar-graph-modal__cats-head">
              <span>{grouped ? '항목 · 그룹별 값' : '항목 · 값 배열'}</span>
              <div className="bar-graph-modal__cats-actions">
                {grouped && (draft.series?.length ?? 0) < 4 ? (
                  <button type="button" className="btn btn-outline btn-xs" onClick={addSeries}>
                    + 그룹
                  </button>
                ) : null}
                {draft.categories.length < 8 ? (
                  <button type="button" className="btn btn-outline btn-xs" onClick={addCategory}>
                    + 항목
                  </button>
                ) : null}
              </div>
            </div>

            {grouped ? (
              <div className="bar-graph-modal__grouped-table">
                <div
                  className="bar-graph-modal__grouped-head"
                  style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${draft.series?.length ?? 2}, 96px) 48px` }}
                >
                  <span>항목</span>
                  {draft.series?.map((ser, si) => (
                    <span key={`ser-head-${si}`} className="bar-graph-modal__series-head">
                      <input
                        type="text"
                        value={ser.name}
                        onChange={(e) => setSeriesName(si, e.target.value)}
                        aria-label={`${si + 1}번 그룹 이름`}
                      />
                      {(draft.series?.length ?? 0) > 2 ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => removeSeries(si)}
                          style={{ color: 'var(--danger, #dc2626)' }}
                        >
                          ×
                        </button>
                      ) : null}
                    </span>
                  ))}
                  <span />
                </div>
                {draft.categories.map((cat, i) => (
                  <div
                    key={i}
                    className="bar-graph-modal__grouped-row"
                    style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${draft.series?.length ?? 2}, 96px) 48px` }}
                  >
                    <input
                      type="text"
                      value={cat}
                      onChange={(e) => setCategory(i, e.target.value)}
                      aria-label={`${i + 1}번 항목 이름`}
                    />
                    {draft.series?.map((ser, si) => (
                      <div key={`ser-val-${i}-${si}`} className="bar-graph-modal__val-controls">
                        <button
                          type="button"
                          className="bar-graph-modal__val-btn"
                          onClick={() => bumpValue(i, -1, si)}
                          disabled={(ser.values[i] ?? 0) <= 0}
                          aria-label="값 줄이기"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          className="bar-graph-modal__val-input"
                          min={0}
                          step={minorStep >= 1 ? minorStep : 'any'}
                          value={ser.values[i] ?? 0}
                          onChange={(e) => setSeriesValue(si, i, Number(e.target.value))}
                          aria-label={`${i + 1}번 항목 ${ser.name} 값`}
                        />
                        <button
                          type="button"
                          className="bar-graph-modal__val-btn"
                          onClick={() => bumpValue(i, 1, si)}
                          aria-label="값 늘리기"
                        >
                          +
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => removeCategory(i)}
                      disabled={draft.categories.length <= 2}
                      style={{ color: 'var(--danger, #dc2626)' }}
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bar-graph-modal__array-table">
                <div className="bar-graph-modal__array-head">
                  <span>항목</span>
                  <span>값</span>
                  <span />
                </div>
                {draft.categories.map((cat, i) => (
                  <div key={i} className="bar-graph-modal__cat-row">
                    <input
                      type="text"
                      value={cat}
                      onChange={(e) => setCategory(i, e.target.value)}
                      aria-label={`${i + 1}번 항목 이름`}
                    />
                    <div className="bar-graph-modal__val-controls">
                      <button
                        type="button"
                        className="bar-graph-modal__val-btn"
                        onClick={() => bumpValue(i, -1)}
                        disabled={(draft.values[i] ?? 0) <= 0}
                        aria-label="값 줄이기"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        className="bar-graph-modal__val-input"
                        min={0}
                        step={minorStep >= 1 ? minorStep : 'any'}
                        value={draft.values[i] ?? 0}
                        onChange={(e) => setValue(i, Number(e.target.value))}
                        aria-label={`${i + 1}번 값`}
                      />
                      <button
                        type="button"
                        className="bar-graph-modal__val-btn"
                        onClick={() => bumpValue(i, 1)}
                        aria-label="값 늘리기"
                      >
                        +
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => removeCategory(i)}
                      disabled={draft.categories.length <= 2}
                      style={{ color: 'var(--danger, #dc2626)' }}
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="bar-graph-modal__footer">
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleUndo} disabled={!canUndo}>
            ↩ 실행 취소
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            취소
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onConfirm(normalizeBarGraphConfig(draft))}
          >
            문제에 넣기
          </button>
        </div>
      </div>
    </div>
  );
}
