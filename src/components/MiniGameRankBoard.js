import React from 'react';
import { miniGameTitle } from '../constants/miniGameDaily';

const RANK_MEDALS = ['🥇', '🥈', '🥉'];
const DEFAULT_MAX_ROWS = 10;

function RankRow({ row }) {
  const medal = row.rank <= 3 ? RANK_MEDALS[row.rank - 1] : row.rank;

  return (
    <li
      className={`mmg-rank-board-row${row.isSelf ? ' mmg-rank-board-row--self' : ''}`}
    >
      <span className="mmg-rank-board-rank" aria-hidden="true">{medal}</span>
      <span className="mmg-rank-board-name">
        {row.displayName}
        {row.isSelf ? '(나)' : ''}
      </span>
      <span className="mmg-rank-board-score">{row.score.toLocaleString()}</span>
    </li>
  );
}

export default function MiniGameRankBoard({
  loading,
  ranking,
  gameId,
  error = false,
  maxRows = DEFAULT_MAX_ROWS,
  onRetry,
}) {
  const gameTitle = miniGameTitle(gameId);

  if (loading) {
    return (
      <div className="mmg-rank-board mmg-rank-board--loading">
        오늘의 {gameTitle} 순위 불러오는 중…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mmg-rank-board mmg-rank-board--empty">
        <p>순위를 불러오지 못했어요.</p>
        {onRetry && (
          <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
            다시 시도
          </button>
        )}
      </div>
    );
  }

  if (!ranking || ranking.playerCount <= 0) {
    return (
      <div className="mmg-rank-board mmg-rank-board--empty">
        <p className="mmg-rank-board-title">오늘의 {gameTitle}</p>
        <p>아직 오늘 플레이한 친구가 없어요.</p>
      </div>
    );
  }

  const { rows, selfRank, selfTodayBest, playerCount } = ranking;
  const visible = rows.slice(0, maxRows);
  const selfInVisible = visible.some((row) => row.isSelf);
  const selfRow = rows.find((row) => row.isSelf);

  return (
    <div className="mmg-rank-board" aria-label={`오늘의 ${gameTitle} 순위`}>
      <p className="mmg-rank-board-title">오늘의 {gameTitle}</p>
      <ol className="mmg-rank-board-list">
        {visible.map((row) => (
          <RankRow key={row.uuid} row={row} />
        ))}
      </ol>
      {!selfInVisible && selfRow && (
        <>
          <p className="mmg-rank-board-ellipsis">…</p>
          <ol className="mmg-rank-board-list mmg-rank-board-list--self">
            <RankRow row={selfRow} />
          </ol>
        </>
      )}
      <p className="mmg-rank-board-foot">
        우리 반 {playerCount}명이 플레이했어요
        {selfRank != null && selfTodayBest > 0 && !selfInVisible && (
          <> · 내 순위 {selfRank}위</>
        )}
      </p>
    </div>
  );
}
