/**
 * CharacterLevelInfo — 캐릭터 설명 모달
 * 호버: 표시 / 이탈: 숨김 · 클릭: 고정 · 화살표: 단계 탐색 · X: 닫기
 */
import React, {
  useState, useRef, useEffect, useId, useLayoutEffect,
} from 'react';
import { createPortal } from 'react-dom';
import {
  getStudentCharacterByLevel,
  getOtterImageSrc,
  MAX_STUDENT_CHARACTER_LEVEL,
} from '../constants/studentCharacterLevels';
import { useOtterExplain } from '../hooks/useOtterExplain';
import './CharacterLevelInfo.css';

const POPOVER_WIDTH = 400;

function NavChevron({ direction }) {
  const isPrev = direction === 'prev';
  return (
    <svg
      className="character-level-info__nav-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden
    >
      <path
        d={isPrev ? 'M14 6l-6 6 6 6' : 'M10 6l6 6-6 6'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function updatePopoverPosition(triggerEl, setStyle) {
  if (!triggerEl) return;
  const width = Math.min(POPOVER_WIDTH, window.innerWidth - 24);
  const rect = triggerEl.getBoundingClientRect();
  const left = Math.min(
    Math.max(rect.left + rect.width / 2, 12 + width / 2),
    window.innerWidth - 12 - width / 2,
  );
  setStyle({
    position: 'fixed',
    top: rect.bottom + 8,
    left,
    width,
    transform: 'translateX(-50%)',
    zIndex: 10000,
  });
}

export default function CharacterLevelInfo({ level: userLevel, className = '' }) {
  const userCharacter = getStudentCharacterByLevel(userLevel);
  const { explains, loading: explainLoading } = useOtterExplain();

  const [viewLevel, setViewLevel] = useState(userLevel);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState(null);
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverId = useId();

  const show = hovered || pinned;
  const isLocked = viewLevel > userLevel;
  const viewExplain = explains[viewLevel];
  const viewCharacter = getStudentCharacterByLevel(viewLevel);
  const displayTitle = viewExplain?.subtitle ?? viewCharacter.name;
  const displayDesc = (() => {
    if (explainLoading && !viewExplain) return '설명 불러오는 중…';
    if (isLocked) {
      return viewExplain?.lockedDescription
        || '아직 이 모습을 볼 수 없어요.';
    }
    return viewExplain?.description || '캐릭터 설명을 불러올 수 없어요.';
  })();
  const profileSrc = getOtterImageSrc(viewLevel, isLocked);

  useEffect(() => {
    if (show) setViewLevel(userLevel);
  }, [show, userLevel]);

  useLayoutEffect(() => {
    if (!show) {
      setPopoverStyle(null);
      return undefined;
    }
    const sync = () => updatePopoverPosition(triggerRef.current, setPopoverStyle);
    sync();
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
    };
  }, [show, userLevel, viewLevel]);

  useEffect(() => {
    if (!pinned) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setPinned(false);
        setHovered(false);
      }
      if (e.key === 'ArrowLeft') setViewLevel((v) => Math.max(1, v - 1));
      if (e.key === 'ArrowRight') {
        setViewLevel((v) => Math.min(MAX_STUDENT_CHARACTER_LEVEL, v + 1));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pinned]);

  const pinOpen = (e) => {
    e.stopPropagation();
    setPinned(true);
    setHovered(false);
  };

  const closePinned = (e) => {
    e?.stopPropagation();
    setPinned(false);
    setHovered(false);
  };

  const goPrev = (e) => {
    e.stopPropagation();
    setViewLevel((v) => Math.max(1, v - 1));
  };

  const goNext = (e) => {
    e.stopPropagation();
    setViewLevel((v) => Math.min(MAX_STUDENT_CHARACTER_LEVEL, v + 1));
  };

  const handleTriggerEnter = () => {
    if (!pinned) setHovered(true);
  };

  const handleTriggerLeave = () => {
    if (!pinned) setHovered(false);
  };

  const handlePopoverEnter = () => {
    if (!pinned) setHovered(true);
  };

  const handlePopoverLeave = () => {
    if (!pinned) setHovered(false);
  };

  const popover = show && popoverStyle && (
    <div
      id={popoverId}
      role={pinned ? 'dialog' : 'tooltip'}
      aria-modal={pinned ? 'true' : undefined}
      className={[
        'character-level-info__popover',
        'character-level-info__popover--portal',
        isLocked ? 'character-level-info__popover--locked' : '',
      ].filter(Boolean).join(' ')}
      style={popoverStyle}
      onMouseEnter={handlePopoverEnter}
      onMouseLeave={handlePopoverLeave}
    >
      {viewLevel > 1 && (
        <button
          type="button"
          className="character-level-info__nav character-level-info__nav--prev"
          onClick={goPrev}
          aria-label="이전 단계 설명"
        >
          <NavChevron direction="prev" />
        </button>
      )}

      <div className="character-level-info__popover-inner">
        <div className="character-level-info__profile">
          <img
            src={profileSrc}
            alt={isLocked ? `${displayTitle} 실루엣` : displayTitle}
            className="character-level-info__profile-img"
          />
        </div>

        <div className="character-level-info__text">
          <div className="character-level-info__popover-head">
            <p className="character-level-info__popover-title">
              Lv.{viewLevel} {displayTitle}
              {isLocked && (
                <span className="character-level-info__lock-badge" aria-hidden="true">🔒</span>
              )}
            </p>
            {pinned && (
              <button
                type="button"
                className="character-level-info__close"
                onClick={closePinned}
                aria-label="설명 닫기"
              >
                ×
              </button>
            )}
          </div>
          <p className={[
            'character-level-info__popover-desc',
            isLocked ? 'character-level-info__popover-desc--locked' : '',
          ].filter(Boolean).join(' ')}
          >
            {displayDesc}
          </p>
        </div>
      </div>

      {viewLevel < MAX_STUDENT_CHARACTER_LEVEL && (
        <button
          type="button"
          className="character-level-info__nav character-level-info__nav--next"
          onClick={goNext}
          aria-label="다음 단계 설명"
        >
          <NavChevron direction="next" />
        </button>
      )}
    </div>
  );

  return (
    <div
      ref={wrapRef}
      className={[
        'character-level-info',
        show ? 'character-level-info--open' : '',
        className,
      ].filter(Boolean).join(' ')}
      onMouseEnter={handleTriggerEnter}
      onMouseLeave={handleTriggerLeave}
    >
      <button
        ref={triggerRef}
        type="button"
        className="character-level-info__trigger sidebar-level-chip"
        onClick={pinOpen}
        aria-expanded={show}
        aria-controls={popoverId}
        aria-label={`${userCharacter.name} 캐릭터 설명 보기`}
      >
        <span className="character-level-info__name">{userCharacter.name}</span>
        <span className="character-level-info__help" aria-hidden="true">?</span>
      </button>

      {popover && createPortal(popover, document.body)}
    </div>
  );
}
