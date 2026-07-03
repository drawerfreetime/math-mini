/**
 * 검수 우측 패널용 단위·기호 바
 */
import React, { useState } from 'react';

const CATEGORIES = ['연산기호', '길이', '무게', '들이', '넓이/부피', '시간', '각도', '화폐'];

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
  const [expandedCategory, setExpandedCategory] = useState(null);

  return (
    <div className="review-unit-bar" aria-label="연산 및 단위">
      <div className="review-unit-bar__cats">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            className={`review-unit-bar__cat ${expandedCategory === cat ? 'is-active' : ''}`}
            aria-label={cat}
            aria-expanded={expandedCategory === cat}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setExpandedCategory((prev) => (prev === cat ? null : cat))}
          >
            <CategoryToolbarLabel category={cat} />
          </button>
        ))}
      </div>
      {expandedCategory ? (
        <div className="review-unit-bar__panel" role="region" aria-label={`${expandedCategory} 목록`}>
          <div className="review-unit-bar__grid" style={{ padding: '12px', color: '#94a3b8', fontSize: 12, textAlign: 'center' }}>
            기호 목록을 불러오는 중…
          </div>
        </div>
      ) : null}
    </div>
  );
}
