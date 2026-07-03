import React from 'react';
import MiniGameRankPanel from './MiniGameRankPanel';

/**
 * @param {{
 *   title: string;
 *   showRank: boolean;
 *   onToggleRank: () => void;
 *   variant?: 'single' | 'make_ten';
 *   gameId?: string;
 * }} props
 */
export default function MiniGameRankToggle({
  title,
  showRank,
  onToggleRank,
  variant = 'single',
  gameId = '',
}) {
  return (
    <>
      <div className="mmg-card-head">
        <p className="mmg-title">{title}</p>
        <button
          type="button"
          className={`mmg-rank-toggle-btn${showRank ? ' mmg-rank-toggle-btn--active' : ''}`}
          onClick={onToggleRank}
          aria-expanded={showRank}
        >
          {showRank ? '닫기' : '🏆 랭킹 보기'}
        </button>
      </div>
      <MiniGameRankPanel open={showRank} variant={variant} gameId={gameId} />
    </>
  );
}
