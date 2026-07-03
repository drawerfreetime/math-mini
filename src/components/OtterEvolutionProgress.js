/**
 * 수달 진화 진행 — 랭킹 점수·미니 레벨·진화 조건
 */
import React from 'react';
import { buildEvolutionProgressView } from '../constants/unitProgress';
import {
  EXPLORATION_POINTS_GUIDE,
  RANKING_EXPLORATION_POINTS_LABEL,
  formatExplorationPointsAmount,
} from '../constants/explorationRewards';
import './OtterEvolutionProgress.css';

const ROW_TIPS = {
  solve: '학급 문제 풀기에서 동료가 만든 문제를 맞힌 횟수예요.',
  peer: '학급 문제를 푼 뒤 동료평가에서 전략을 맞히면 3점, O/X 항목을 AI와 일치하면 항목당 2점이에요.',
  points: '이번 수달 단계에서 모은 점수예요. 레벨업·진화에 쓰여요.',
};

function LabelWithTip({ tip, wide, children }) {
  return (
    <span className={`otter-evo-tip${wide ? ' otter-evo-tip--wide' : ''}`}>
      {children}
      {tip != null && (
        <span className="otter-evo-tip__popup" role="tooltip">
          {tip}
        </span>
      )}
    </span>
  );
}

function RankingPointsLabel() {
  return (
    <LabelWithTip tip="최근 30일 동안 모은 탐구점수예요. 우리 반 순위에 쓰여요.">
      <span className="otter-evo__summary-label">{RANKING_EXPLORATION_POINTS_LABEL}</span>
    </LabelWithTip>
  );
}

function PointsRowLabel({ label }) {
  return (
    <LabelWithTip wide tip={null}>
      <span className="otter-evo-check__label">{label}</span>
      <span className="otter-evo-tip__popup otter-evo-tip__popup--table" role="tooltip">
        <span className="otter-evo-tip__table-title">탐구점수 얻는 방법</span>
        <table className="otter-evo-tip__table">
          <tbody>
            {EXPLORATION_POINTS_GUIDE.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>+{row.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </span>
    </LabelWithTip>
  );
}

function renderRowLabel(row) {
  if (row.key === 'points') return <PointsRowLabel label={row.label} />;
  return (
    <LabelWithTip tip={ROW_TIPS[row.key]}>
      <span className="otter-evo-check__label">{row.label}</span>
    </LabelWithTip>
  );
}

export default function OtterEvolutionProgress({ unitProgress, rankingPoints = 0 }) {
  const view = buildEvolutionProgressView(unitProgress);
  const displayRankingPoints = Math.max(0, Number(rankingPoints) || 0);

  if (view.complete) {
    return (
      <div className="otter-evo">
        <div className="otter-evo__summary">
          <div className="otter-evo__summary-row">
            <RankingPointsLabel />
            <span className="otter-evo__summary-val">{formatExplorationPointsAmount(displayRankingPoints)}</span>
          </div>
        </div>
        <p className="otter-evo__done">이번 단원 창의달 달성!</p>
      </div>
    );
  }

  return (
    <div className="otter-evo">
      <div className="otter-evo__summary">
        <div className="otter-evo__summary-row">
          <RankingPointsLabel />
          <span className="otter-evo__summary-val">{formatExplorationPointsAmount(displayRankingPoints)}</span>
        </div>
        <div className="otter-evo__summary-row">
          <span className="otter-evo__summary-label">{view.remainingLabel}</span>
        </div>
      </div>

      <div className="sd-char-progress-track otter-evo__bar">
        <div className="sd-char-progress-fill" style={{ width: `${view.barPct}%` }} />
      </div>

      <div className="otter-evo__checks">
        <p className="otter-evo__checks-head">다음 진화: {view.nextLabel}</p>
        <ul className="otter-evo-check-list">
          {view.rows.map((row) => (
            <li
              key={row.key}
              className={`otter-evo-check${row.done ? ' otter-evo-check--done' : ''}`}
            >
              {renderRowLabel(row)}
              <span className="otter-evo-check__score">
                {row.current}/{row.target}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
