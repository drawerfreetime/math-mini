/**
 * 검수 페이지 우측 — 인라인 초등 수식 편집기 + 단위/기호 바
 */
import React from 'react';
import ElementaryMathOverlay from './ElementaryMathOverlay';
import ReviewUnitSymbolBar from './ReviewUnitSymbolBar';
import './ReviewMathToolsSidebar.css';

/**
 * @param {object} p
 * @param {boolean} p.mathOpen
 * @param {() => void} p.onToggleMath
 * @param {(e: React.MouseEvent) => void} [p.onMathTogglePointerDown]
 * @param {(script: string) => void} p.onInsertMathScript
 * @param {(kind: 'op' | 'unit', symbol: string) => void} p.onPickSymbol
 */
export default function ReviewMathToolsSidebar({
  mathOpen,
  onToggleMath,
  onMathTogglePointerDown,
  onInsertMathScript,
  onPickSymbol,
}) {
  return (
    <aside className="review-tools-sidebar">
      <div className="review-tools-sidebar__inner">
        <h3 className="review-tools-sidebar__title">수식 · 단위</h3>
        <p className="review-tools-sidebar__hint">
          입력란을 선택한 뒤 아래에서 수식·기호를 넣을 수 있어요.
        </p>

        <div className="review-tools-block">
          <button
            type="button"
            className={`btn btn-outline btn-xs review-tools-math-toggle ${mathOpen ? 'is-active' : ''}`}
            onMouseDown={onMathTogglePointerDown}
            onClick={onToggleMath}
          >
            {mathOpen ? '▼ 수식 접기' : '➕ 수식 넣기'}
          </button>
          {mathOpen ? (
            <div className="review-tools-math-panel">
              <ElementaryMathOverlay
                variant="sidebar"
                open={true}
                onClose={() => onToggleMath()}
                onConfirm={onInsertMathScript}
                title="수식 입력"
              />
            </div>
          ) : null}
        </div>

        <div className="review-tools-block review-tools-block--unit">
          <h4 className="review-tools-sidebar__subtitle">단위 / 기호</h4>
          <ReviewUnitSymbolBar onPick={onPickSymbol} />
        </div>
      </div>
    </aside>
  );
}
