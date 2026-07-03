import React from 'react';
import {
  RANKING_EXPLORATION_POINTS_LABEL,
  formatExplorationPoints,
} from '../constants/explorationRewards';
import './ClassRankingList.css';

const RANK_MEDALS = ['🥇', '🥈', '🥉'];

function LevelBadge({ level, name }) {
  return (
    <span className={`cr-level-badge cr-level-badge--${level}`}>
      {name}
    </span>
  );
}

function PodiumCard({ row, slot, showSelfSuffix }) {
  const name = showSelfSuffix && row.isSelf
    ? `${row.displayName}(나)`
    : row.displayName;
  const medal = RANK_MEDALS[row.rank - 1] || row.rank;

  return (
    <div className={`cr-podium-card cr-podium-card--${slot}${row.isSelf ? ' cr-podium-card--self' : ''}`}>
      <span className="cr-podium-medal" aria-label={`${row.rank}위`}>
        {medal}
      </span>
      <div className="cr-podium-photo-wrap">
        <img
          src={row.otterImageSrc}
          alt={row.characterName}
          className="cr-podium-photo"
        />
      </div>
      <p className="cr-podium-name">{name}</p>
      <LevelBadge level={row.characterLevel} name={row.characterName} />
      <p className="cr-podium-points">{formatExplorationPoints(row.xp)}</p>
    </div>
  );
}

function scoreBarTone(pct) {
  if (pct >= 70) return 'warm';
  if (pct >= 30) return 'mid';
  return 'low';
}

function TableRow({ row, showSelfSuffix, maxXp }) {
  const name = showSelfSuffix && row.isSelf
    ? `${row.displayName}(나)`
    : row.displayName;
  const isInactive = !row.xp;
  const barPct = maxXp > 0 ? Math.round((row.xp / maxXp) * 100) : 0;

  return (
    <div
      className={[
        'cr-table-row',
        row.isSelf ? 'cr-table-row--self' : '',
        isInactive ? 'cr-table-row--inactive' : '',
      ].filter(Boolean).join(' ')}
    >
      <span className="cr-table-rank">{row.rank}</span>
      <img
        src={row.otterImageSrc}
        alt={row.characterName}
        className="cr-table-photo"
      />
      <span className="cr-table-name">{name}</span>
      <LevelBadge level={row.characterLevel} name={row.characterName} />
      <div className="cr-table-score">
        <div
          className="cr-score-bar"
          role="presentation"
          aria-hidden="true"
        >
          <div
            className={`cr-score-bar-fill cr-score-bar-fill--${scoreBarTone(barPct)}`}
            style={{ width: `${barPct}%` }}
          />
        </div>
        <span className="cr-table-points">{formatExplorationPoints(row.xp)}</span>
      </div>
    </div>
  );
}

export default function ClassRankingList({
  rows,
  loading,
  emptyMessage = '등록된 학생이 없어요',
  showSelfSuffix = true,
}) {
  if (loading) {
    return (
      <p className="section-desc" style={{ textAlign: 'center', padding: '20px 0' }}>
        랭킹 불러오는 중…
      </p>
    );
  }

  if (!rows?.length) {
    return (
      <p className="section-desc" style={{ textAlign: 'center', padding: '20px 0' }}>
        {emptyMessage}
      </p>
    );
  }

  const top3 = rows.slice(0, 3);
  const rest = rows.slice(3);
  const maxXp = Math.max(...rows.map((row) => row.xp), 0);

  const podiumSlots = [
    top3[1] ? { row: top3[1], slot: 'second' } : null,
    top3[0] ? { row: top3[0], slot: 'first' } : null,
    top3[2] ? { row: top3[2], slot: 'third' } : null,
  ].filter(Boolean);

  return (
    <div className="cr-ranking">
      {podiumSlots.length > 0 && (
        <div className="cr-podium" aria-label="상위 3명">
          {podiumSlots.map(({ row, slot }) => (
            <PodiumCard
              key={row.uuid}
              row={row}
              slot={slot}
              showSelfSuffix={showSelfSuffix}
            />
          ))}
        </div>
      )}

      {rest.length > 0 && (
        <div className="cr-table-wrap">
          <div className="cr-table-header" aria-hidden="true">
            <span>순위</span>
            <span />
            <span>이름</span>
            <span>수달 단계</span>
            <span>{RANKING_EXPLORATION_POINTS_LABEL}</span>
          </div>
          <div className="cr-table-body">
            {rest.map((row) => (
              <TableRow
                key={row.uuid}
                row={row}
                showSelfSuffix={showSelfSuffix}
                maxXp={maxXp}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
