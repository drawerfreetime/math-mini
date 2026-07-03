/**
 * StudentMenuSidebar — 학생 메뉴 사이드바
 *
 * 표시 내용
 *   - 캐릭터 이미지 (totalSolved 기반 레벨 1~4, otter-1~4.png)
 *   - 학생 이름 + 레벨 칩
 *   - 통계 3행 (푼 문제 / 맞힌 문제 / 정답률)
 *   - 마이페이지 이동 버튼
 *
 * 뱃지 색 연동은 다음 단계에서 추가 예정.
 */
import React from 'react';
import './StudentMenuSidebar.css';

const CHARACTER_BASE = `${process.env.PUBLIC_URL}/brand/student/character`;

/** 레벨별 캐릭터 이름 */
const LEVEL_NAMES = {
  1: '탐구달',
  2: '분석달',
  3: '추론달',
  4: '창의달',
};

/**
 * totalSolved → 레벨(1~4)
 * 0~9   → 1 / 10~29 → 2 / 30~59 → 3 / 60+ → 4
 * @param {number} totalSolved
 * @returns {number}
 */
function calcLevel(totalSolved) {
  if (totalSolved >= 60) return 4;
  if (totalSolved >= 30) return 3;
  if (totalSolved >= 10) return 2;
  return 1;
}

/**
 * @param {{
 *   realName: string;
 *   totalSolved: number;
 *   totalCorrect: number;
 *   accuracyPct: number;
 *   loadingData: boolean;
 *   onOpenMypage: () => void;
 * }} props
 */
export default function StudentMenuSidebar({
  realName,
  totalSolved,
  totalCorrect,
  accuracyPct,
  loadingData,
  onOpenMypage,
}) {
  const level = calcLevel(totalSolved);
  const imgSrc = `${CHARACTER_BASE}/otter-${level}.png`;
  const characterName = LEVEL_NAMES[level];

  return (
    <aside className="student-menu-sidebar">
      {/* 캐릭터 카드 */}
      <div className="sidebar-character-card">
        <div className="sidebar-character-frame">
          <img
            src={imgSrc}
            alt={characterName}
            className="sidebar-character-img"
          />
        </div>
        <p className="sidebar-character-name">{realName || '학생'}</p>
        <span className="sidebar-level-chip">Lv. {level} · {characterName}</span>
      </div>

      <hr className="sidebar-divider" />

      {/* 통계 */}
      <div className="sidebar-stats">
        <div className="sidebar-stat-row">
          <span className="sidebar-stat-label">📝 푼 문제</span>
          {loadingData
            ? <span className="sidebar-stat-loading">…</span>
            : <span className="sidebar-stat-value">{totalSolved}</span>
          }
        </div>
        <div className="sidebar-stat-row">
          <span className="sidebar-stat-label">✅ 정답</span>
          {loadingData
            ? <span className="sidebar-stat-loading">…</span>
            : <span className="sidebar-stat-value">{totalCorrect}</span>
          }
        </div>
        <div className="sidebar-stat-row">
          <span className="sidebar-stat-label">🎯 정답률</span>
          {loadingData
            ? <span className="sidebar-stat-loading">…</span>
            : <span className="sidebar-stat-value">{accuracyPct}%</span>
          }
        </div>
      </div>

      {/* 마이페이지 */}
      <button
        type="button"
        className="sidebar-mypage-btn"
        onClick={onOpenMypage}
      >
        🔍 마이페이지 →
      </button>
    </aside>
  );
}
