import React, { useEffect, useRef } from 'react';
import './BadgeCelebrationModal.css';

const TIER_ORDER = { legendary: 3, adept: 2, novice: 1 };

function dominantTier(unlockedTiers) {
  if (!unlockedTiers?.length) return 'novice';
  return unlockedTiers.reduce(
    (best, t) => ((TIER_ORDER[t.tierId] || 0) > (TIER_ORDER[best.tierId] || 0) ? t : best),
    unlockedTiers[0]
  ).tierId;
}

/**
 * @param {{
 *   open: boolean;
 *   strategyTitle: string;
 *   unlockedTiers: { tierId: string; labelKo: string }[];
 *   onConfirm: () => void;
 * }} props
 */
export default function BadgeCelebrationModal({ open, strategyTitle, unlockedTiers, onConfirm }) {
  const confirmRef = useRef(null);

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  if (!open || !unlockedTiers?.length) return null;

  const strategyLabel = (strategyTitle || '선택한 전략').trim();
  const dominant = dominantTier(unlockedTiers);
  const tierClass = `badge-celeb-tier--${dominant}`;

  const lines = unlockedTiers.map((t) => t.labelKo).filter(Boolean);
  const message =
    lines.length === 1
      ? `축하합니다! ${strategyLabel} 분야의 ${lines[0]} 배지를 획득하셨습니다!`
      : `축하합니다! ${strategyLabel} 분야의 ${lines.join(', ')} 배지를 획득하셨습니다!`;

  return (
    <div
      className="badge-celeb-root"
      role="dialog"
      aria-modal="true"
      aria-labelledby="badge-celeb-title"
    >
      <div
        className={`badge-celeb-panel ${tierClass}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {dominant === 'legendary' && (
          <div className="badge-celeb-sparkles" aria-hidden>
            <span className="badge-celeb-spark badge-celeb-spark--1">✦</span>
            <span className="badge-celeb-spark badge-celeb-spark--2">✧</span>
            <span className="badge-celeb-spark badge-celeb-spark--3">✦</span>
            <span className="badge-celeb-spark badge-celeb-spark--4">✧</span>
            <span className="badge-celeb-spark badge-celeb-spark--5">✦</span>
            <span className="badge-celeb-spark badge-celeb-spark--6">✧</span>
          </div>
        )}

        <div className="badge-celeb-inner">
          <p id="badge-celeb-title" className="badge-celeb-kicker">
            수사봇이 전해요
          </p>

          <div className="badge-celeb-mascot" aria-hidden>
            <div className="badge-celeb-mascot-face">
              <span className="badge-celeb-mascot-eye badge-celeb-mascot-eye--l" />
              <span className="badge-celeb-mascot-eye badge-celeb-mascot-eye--r" />
              <span className="badge-celeb-mascot-mouth" />
            </div>
            <div className="badge-celeb-mascot-antenna" />
            <span className="badge-celeb-mascot-badge">🔍</span>
          </div>

          <div className="badge-celeb-bubble">
            <p className="badge-celeb-msg">{message}</p>
            <p className="badge-celeb-sub">
              변형한 문제는 문제 저장소에도 잘 담겼어요. 계속 다른 문항도 변형해 보세요!
            </p>
          </div>

          <button ref={confirmRef} type="button" className="badge-celeb-btn" onClick={onConfirm}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}
