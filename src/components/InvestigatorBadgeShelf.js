/**
 * 학생 마이페이지 — 수사관 뱃지 진열대 (6전략 × 참된·전설)
 */
import React, { useMemo, useState } from 'react';
import { VARIANT_STRATEGIES } from '../constants/variantStrategies';
import { INVESTIGATION_BADGE_TIERS } from '../constants/investigationBadges';
import {
  normalizeUnitProgress,
  hasAdeptBadge,
  hasLegendaryBadge,
  isPeerJudge,
} from '../constants/unitProgress';
import './InvestigatorBadgeShelf.css';

/** @param {string | undefined | null} iso */
function formatKoDate(iso) {
  if (!iso || typeof iso !== 'string') return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return null;
  }
}

/** @param {{
 *   unitProgress?: import('../constants/unitProgress').UnitProgressEntry | null;
 *   loading?: boolean;
 * }} props */
export default function InvestigatorBadgeShelf({ unitProgress, loading }) {
  const [pick, setPick] = useState(null);
  const p = normalizeUnitProgress(unitProgress);

  const rows = useMemo(() => {
    return VARIANT_STRATEGIES.map((s) => {
      const count = p.approvedByStrategy[s.id] || 0;
      const unlocked = p.badgeUnlockedAt?.[s.id] || {};
      const tiers = INVESTIGATION_BADGE_TIERS.map((tier) => ({
        tierId: tier.id,
        labelKo: tier.labelKo,
        earned: tier.id === 'adept' ? hasAdeptBadge(p, s.id) : hasLegendaryBadge(p, s.id),
        unlockedAt: typeof unlocked[tier.id] === 'string' ? unlocked[tier.id] : null,
      }));
      return {
        strategy: s,
        tiers,
        count,
        isJudge: isPeerJudge(p, s.id),
      };
    });
  }, [p]);

  function handleTierClick(strategyId, strategyTitle, tier) {
    if (!tier.earned) return;
    const key = `${strategyId}:${tier.tierId}`;
    setPick((prev) => (prev?.key === key ? null : {
      key,
      strategyTitle,
      tierLabel: tier.labelKo,
      unlockedAt: tier.unlockedAt,
    }));
  }

  if (loading) {
    return (
      <div className="inv-badge-shelf inv-badge-shelf--loading" aria-busy="true">
        <p className="inv-badge-shelf__loading">뱃지 정보를 불러오는 중…</p>
      </div>
    );
  }

  return (
    <div className="inv-badge-shelf">
      <header className="inv-badge-shelf__head">
        <h2 className="inv-badge-shelf__title">수사관 뱃지 진열대</h2>
        <p className="inv-badge-shelf__desc">
          이번 단원에서 전략별로 승인을 모으면 참된(5회)·전설(12회) 뱃지를 받아요.
          심사위원 자격(🪪 2회)은 뱃지가 아니라 전략 카드에 표시돼요.
        </p>
      </header>

      {pick && (
        <div className="inv-badge-shelf__detail" role="status">
          <div className="inv-badge-shelf__detail-inner">
            <p className="inv-badge-shelf__detail-name">
              <span className="inv-badge-shelf__detail-kicker">뱃지</span>
              {pick.strategyTitle} 분야의 {pick.tierLabel}
            </p>
            <p className="inv-badge-shelf__detail-date">
              <span className="inv-badge-shelf__detail-kicker">획득일</span>
              {formatKoDate(pick.unlockedAt) || '기록된 획득일이 없어요.'}
            </p>
            <button
              type="button"
              className="inv-badge-shelf__detail-close btn btn-ghost btn-sm"
              onClick={() => setPick(null)}
            >
              닫기
            </button>
          </div>
        </div>
      )}

      <ul className="inv-badge-shelf__grid">
        {rows.map(({ strategy: s, tiers, count, isJudge }) => (
          <li key={s.id} className="inv-badge-card">
            <h3 className="inv-badge-card__title">
              {s.title}
              {isJudge && <span className="inv-badge-card__judge" title="심사위원"> 🪪</span>}
            </h3>
            <p className="inv-badge-card__meta">승인 {count}회</p>
            <p className="inv-badge-card__blurb">{s.blurb}</p>
            <div className="inv-badge-card__tiers">
              {tiers.map((tier) => {
                const tierClass = `inv-badge-pip inv-badge-pip--${tier.tierId}${tier.earned ? ' inv-badge-pip--earned' : ' inv-badge-pip--locked'}`;
                const selected = pick?.key === `${s.id}:${tier.tierId}`;
                return (
                  <button
                    key={tier.tierId}
                    type="button"
                    className={`${tierClass}${selected ? ' inv-badge-pip--selected' : ''}`}
                    disabled={!tier.earned}
                    title={tier.earned ? `${tier.labelKo} — 눌러 상세 보기` : '아직 획득하지 않은 등급'}
                    onClick={() => handleTierClick(s.id, s.title, tier)}
                  >
                    <span className="inv-badge-pip__glyph" aria-hidden>
                      {tier.tierId === 'adept' && '⚙️'}
                      {tier.tierId === 'legendary' && '✦'}
                    </span>
                    <span className="inv-badge-pip__label">{tier.labelKo.replace(' 수사관', '')}</span>
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
