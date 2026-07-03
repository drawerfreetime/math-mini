/**
 * 창의달 수집 도감 v0 — 단원별 그리드 (공용 otter-4 / 실루엣)
 */
import React from 'react';
import { getOtterImageSrc } from '../constants/studentCharacterLevels';
import { listKnownUnitKeys, getUnitLabel } from '../constants/unitProgress';
import './CreativeOtterCollection.css';

/**
 * @param {{
 *   creativeOtterCollection?: Record<string, { earnedAt?: string, unitLabel?: string }>;
 *   loading?: boolean;
 * }} props
 */
export default function CreativeOtterCollection({ creativeOtterCollection, loading }) {
  const unitKeys = listKnownUnitKeys();
  const coll = creativeOtterCollection || {};
  const earnedCount = unitKeys.filter((k) => coll[k]).length;

  if (loading) {
    return <p className="creative-otter-coll__loading">도감을 불러오는 중…</p>;
  }

  return (
    <div className="creative-otter-coll">
      <header className="creative-otter-coll__head">
        <h3 className="creative-otter-coll__title">창의달 수집 도감</h3>
        <p className="creative-otter-coll__summary">창의달 수집 {earnedCount}개</p>
      </header>
      <ul className="creative-otter-coll__grid">
        {unitKeys.map((unitKey) => {
          const earned = Boolean(coll[unitKey]);
          const label = coll[unitKey]?.unitLabel || getUnitLabel(unitKey);
          return (
            <li
              key={unitKey}
              className={`creative-otter-coll__cell${earned ? ' creative-otter-coll__cell--earned' : ''}`}
              title={label}
            >
              <img
                src={getOtterImageSrc(4, !earned)}
                alt={earned ? `${label} 창의달` : `${label} 미수집`}
                className="creative-otter-coll__img"
              />
              <span className="creative-otter-coll__label">{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
