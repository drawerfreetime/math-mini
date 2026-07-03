import React, { useEffect, useRef, useMemo } from 'react';
import {
  EXPLORATION_POINTS_LABEL,
  formatExplorationPoints,
  isPartialMakingApprovalReward,
} from '../constants/explorationRewards';
import './ExplorationRewardModal.css';

/**
 * @param {{
 *   open: boolean;
 *   items: { id: string; labelKo?: string; points: number; awardDayKst?: string; kind?: string }[];
 *   onConfirm: () => void;
 * }} props
 */
export default function ExplorationRewardModal({ open, items, onConfirm }) {
  const confirmRef = useRef(null);
  const total = useMemo(
    () => (items || []).reduce((s, it) => s + (Number(it.points) || 0), 0),
    [items],
  );

  const hasPartialMaking = useMemo(
    () => (items || []).some((it) => isPartialMakingApprovalReward(it.kind)),
    [items],
  );

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  if (!open || !items?.length) return null;

  return (
    <div
      className="explore-reward-root"
      role="dialog"
      aria-modal="true"
      aria-labelledby="explore-reward-title"
    >
      <div className="explore-reward-panel" onMouseDown={(e) => e.stopPropagation()}>
        <p id="explore-reward-title" className="explore-reward-kicker">
          탐구달이 전해요
        </p>
        <div className="explore-reward-icon" aria-hidden>🏆</div>
        <h2 className="explore-reward-headline">
          {EXPLORATION_POINTS_LABEL}가 올랐어요!
        </h2>
        <ul className="explore-reward-list">
          {items.map((it) => (
            <li key={it.id} className="explore-reward-row">
              <span className="explore-reward-label">{it.labelKo || '탐구 활동'}</span>
              <span className="explore-reward-pts">{formatExplorationPoints(it.points, { signed: true })}</span>
            </li>
          ))}
        </ul>
        <p className="explore-reward-total">
          합계 <strong>{formatExplorationPoints(total, { signed: true })}</strong>
        </p>
        {hasPartialMaking && (
          <p className="explore-reward-hint">
            풀이 과정을 잘 작성해서 다시 확인받으면 15점을 더 얻을 수 있습니다.
          </p>
        )}
        <p className="explore-reward-sub">
          누적 {EXPLORATION_POINTS_LABEL}와 최근 30일 랭킹에 반영됐어요!
        </p>
        <button
          ref={confirmRef}
          type="button"
          className="explore-reward-btn"
          onClick={onConfirm}
        >
          확인
        </button>
      </div>
    </div>
  );
}
