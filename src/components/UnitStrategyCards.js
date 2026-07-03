/**
 * 단원별 전략 카드 6개 — 승인 횟수·심사위원·뱃지 표시
 */
import React from 'react';
import { VARIANT_STRATEGIES } from '../constants/variantStrategies';
import {
  normalizeUnitProgress,
  isPeerJudge,
  hasAdeptBadge,
  hasLegendaryBadge,
  PEER_JUDGE_APPROVAL_THRESHOLD,
  ADEPT_BADGE_THRESHOLD,
  LEGENDARY_BADGE_THRESHOLD,
} from '../constants/unitProgress';
import './UnitStrategyCards.css';

/**
 * @param {{
 *   unitProgress?: import('../constants/unitProgress').UnitProgressEntry | null;
 *   loading?: boolean;
 * }} props
 */
export default function UnitStrategyCards({ unitProgress, loading }) {
  const p = normalizeUnitProgress(unitProgress);

  if (loading) {
    return <p className="unit-strategy-cards__loading">전략 카드를 불러오는 중…</p>;
  }

  return (
    <div className="unit-strategy-cards">
      <header className="unit-strategy-cards__head">
        <h3 className="unit-strategy-cards__title">이번 단원 전략 카드</h3>
        <p className="unit-strategy-cards__desc">
          승인 {PEER_JUDGE_APPROVAL_THRESHOLD}회 → 심사위원 🪪 · {ADEPT_BADGE_THRESHOLD}회 → 참된 · {LEGENDARY_BADGE_THRESHOLD}회 → 전설
        </p>
      </header>
      <ul className="unit-strategy-cards__grid">
        {VARIANT_STRATEGIES.map((s) => {
          const count = p.approvedByStrategy[s.id] || 0;
          const judge = isPeerJudge(p, s.id);
          const adept = hasAdeptBadge(p, s.id);
          const legendary = hasLegendaryBadge(p, s.id);
          return (
            <li key={s.id} className="unit-strategy-card">
              <div className="unit-strategy-card__top">
                <h4 className="unit-strategy-card__title">{s.title}</h4>
                <span className="unit-strategy-card__count">승인 {count}회</span>
              </div>
              <p className="unit-strategy-card__blurb">{s.blurb}</p>
              <div className="unit-strategy-card__marks">
                {judge && (
                  <span className="unit-strategy-card__mark unit-strategy-card__mark--judge" title="동료평가 심사위원">
                    🪪 심사위원
                  </span>
                )}
                {adept && (
                  <span className="unit-strategy-card__mark unit-strategy-card__mark--adept" title="참된 수사관">
                    ⭐ 참된
                  </span>
                )}
                {legendary && (
                  <span className="unit-strategy-card__mark unit-strategy-card__mark--legendary" title="전설의 수사관">
                    👑 전설
                  </span>
                )}
                {!judge && !adept && !legendary && count > 0 && (
                  <span className="unit-strategy-card__mark unit-strategy-card__mark--progress">
                    진행 중
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
