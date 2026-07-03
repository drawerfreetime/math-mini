import React from 'react';
import { miniGameTitle } from '../constants/miniGameDaily';

const RANK_MEDALS = ['🥇', '🥈', '🥉'];

export default function MiniGameEndRank({ loading, ranking, gameId }) {
  if (loading) {
    return (
      <div className="mmg-end-rank mmg-end-rank--loading">
        우리 반 순위 불러오는 중…
      </div>
    );
  }

  if (!ranking || ranking.playerCount <= 0) return null;

  const {
    top3,
    selfRank,
    selfTodayBest,
    sessionScore,
    playerCount,
    isNewBest,
  } = ranking;

  const gameTitle = miniGameTitle(gameId);
  const selfInTop3 = top3.some((row) => row.isSelf);

  return (
    <div className="mmg-end-rank" aria-label={`오늘의 ${gameTitle} 순위`}>
      <p className="mmg-end-rank-title">오늘의 {gameTitle}</p>

      {isNewBest && sessionScore > 0 && (
        <p className="mmg-end-rank-badge">🎉 오늘 최고 기록!</p>
      )}
      {!isNewBest && sessionScore > 0 && sessionScore < selfTodayBest && (
        <p className="mmg-end-rank-sub">
          이번 {sessionScore.toLocaleString()}점 · 오늘 최고 {selfTodayBest.toLocaleString()}점
        </p>
      )}

      <ol className="mmg-end-rank-list">
        {top3.map((row, idx) => (
          <li
            key={row.uuid}
            className={`mmg-end-rank-row${row.isSelf ? ' mmg-end-rank-row--self' : ''}`}
          >
            <span className="mmg-end-rank-medal" aria-hidden="true">
              {RANK_MEDALS[idx]}
            </span>
            <span className="mmg-end-rank-name">
              {row.displayName}
              {row.isSelf ? '(나)' : ''}
            </span>
            <span className="mmg-end-rank-score">{row.score.toLocaleString()}</span>
          </li>
        ))}
      </ol>

      {!selfInTop3 && selfRank != null && (
        <p className="mmg-end-rank-self">
          … {selfRank}위 · {selfTodayBest.toLocaleString()}점
        </p>
      )}

      <p className="mmg-end-rank-foot">
        우리 반 {playerCount}명이 플레이했어요
      </p>
    </div>
  );
}
