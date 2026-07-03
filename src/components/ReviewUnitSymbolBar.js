/**
 * 검수 우측 패널용 단위·기호 바 — 카테고리는 가로 한 줄, 항목은 아래 4열 그리드.
 */
import React, { useMemo, useState, useCallback } from 'react';
import katex from 'katex';
import { mathUnits, mathUnitCategoryOrder } from '../constants/mathUnits';
import {
  parseUnitDisplaySegments,
  unitCanonicalToKatexLatex,
} from '../utils/inlineMathStorage';

/** @param {{ unit: string }} p */
function ToolbarAreaVolumeKatexLabel({ unit }) {
  const html = useMemo(() => {
    const latex = unitCanonicalToKatexLatex(unit);
    return katex.renderToString(latex, {
      throwOnError: false,
      displayMode: false,
      strict: 'ignore',
    });
  }, [unit]);
  return (
    <span
      className="review-unit-bar__katex"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** @param {{ symbol: string }} p */
function ToolbarSymbolLabel({ symbol }) {
  return (
    <span className="review-unit-bar__sym-label">
      {parseUnitDisplaySegments(symbol).map((part, idx) =>
        part.type === 'text' ? (
          <React.Fragment key={`${symbol}-t-${idx}`}>{part.v}</React.Fragment>
        ) : (
          <sup key={`${symbol}-s-${idx}`} className="review-unit-bar__sym-sup">
            {part.v}
          </sup>
        )
      )}
    </span>
  );
}

/** @param {{ category: string }} p */
function CategoryToolbarLabel({ category }) {
  const c = String(category);
  const i = c.indexOf('/');
  if (i === -1) return <>{c}</>;
  return (
    <span className="review-unit-bar__cat-label">
      <span className="review-unit-bar__cat-line">{c.slice(0, i)}</span>
      <span className="review-unit-bar__cat-line">{c.slice(i + 1)}</span>
    </span>
  );
}

/**
 * @param {object} p
 * @param {(kind: 'op' | 'unit', symbol: string) => void} p.onPick
 */
export default function ReviewUnitSymbolBar({ onPick }) {
  const [expandedCategory, setExpandedCategory] = useState(
    /** @type {string | null} */ (null)
  );

  const toggleCategory = useCallback((cat) => {
    setExpandedCategory((prev) => (prev === cat ? null : cat));
  }, []);

  const handleCell = useCallback(
    (sym, catKey) => {
      const mode = catKey === '연산기호' ? 'op' : 'unit';
      onPick(mode, sym);
    },
    [onPick]
  );

  return (
    <div className="review-unit-bar" aria-label="연산 및 단위">
      <div className="review-unit-bar__cats">
        {mathUnitCategoryOrder.map((cat) => (
          <button
            key={cat}
            type="button"
            className={`review-unit-bar__cat ${expandedCategory === cat ? 'is-active' : ''}`}
            aria-label={cat}
            aria-expanded={expandedCategory === cat}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleCategory(cat)}
          >
            <CategoryToolbarLabel category={cat} />
          </button>
        ))}
      </div>
      {expandedCategory ? (
        <div className="review-unit-bar__panel" role="region" aria-label={`${expandedCategory} 목록`}>
          <div className="review-unit-bar__grid">
            {(mathUnits[/** @type {keyof typeof mathUnits} */ (expandedCategory)] ?? []).map(
              (sym) => (
                <button
                  key={`${expandedCategory}-${sym}`}
                  type="button"
                  className="review-unit-bar__cell"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleCell(sym, expandedCategory)}
                >
                  {expandedCategory === '넓이/부피' ? (
                    <ToolbarAreaVolumeKatexLabel unit={sym} />
                  ) : (
                    <ToolbarSymbolLabel symbol={sym} />
                  )}
                </button>
              )
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
