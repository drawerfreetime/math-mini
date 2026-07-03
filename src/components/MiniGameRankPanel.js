import React, { useState } from 'react';
import { MAKE_TEN_RANK_TABS } from '../constants/miniGameDaily';
import { useMiniGameRankBoard } from '../hooks/useMiniGameRankBoard';
import MiniGameRankBoard from './MiniGameRankBoard';

/**
 * @param {{
 *   open: boolean;
 *   variant?: 'single' | 'make_ten';
 *   gameId?: string;
 * }} props
 */
export default function MiniGameRankPanel({
  open,
  variant = 'single',
  gameId = '',
}) {
  const [makeTenTab, setMakeTenTab] = useState('easy');
  const activeGameId = variant === 'make_ten'
    ? (MAKE_TEN_RANK_TABS.find((t) => t.difficultyId === makeTenTab)?.gameId || MAKE_TEN_RANK_TABS[0].gameId)
    : gameId;

  const { loading, ranking, error, reload } = useMiniGameRankBoard({
    gameId: activeGameId,
    enabled: open && Boolean(activeGameId),
  });

  if (!open) return null;

  return (
    <div className="mmg-rank-panel">
      {variant === 'make_ten' && (
        <div className="mmg-rank-panel-tabs" role="tablist" aria-label="10만들기 난이도별 랭킹">
          {MAKE_TEN_RANK_TABS.map((tab) => (
            <button
              key={tab.difficultyId}
              type="button"
              role="tab"
              aria-selected={makeTenTab === tab.difficultyId}
              className={[
                'mmg-rank-panel-tab',
                makeTenTab === tab.difficultyId ? 'mmg-rank-panel-tab--active' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => setMakeTenTab(tab.difficultyId)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      <MiniGameRankBoard
        loading={loading}
        ranking={ranking}
        gameId={activeGameId}
        error={error}
        onRetry={reload}
      />
    </div>
  );
}
