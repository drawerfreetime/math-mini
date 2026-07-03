/**
 * ProblemMaker.js — 문제 만들기 허브 (학생 전용)
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import HudFrame from './HudFrame';
import VariantStrategyTutorial from './VariantStrategyTutorial';
import {
  isVariantStrategyTutorialDone,
  markVariantStrategyTutorialDone,
} from '../utils/variantStrategyTutorialStorage';

export default function ProblemMaker() {
  const navigate = useNavigate();
  const { studentSession, studentLogout } = useAuth();
  const { realName, uuid } = studentSession || {};
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialNavigateAfter, setTutorialNavigateAfter] = useState(false);
  const [tutorialSessionKey, setTutorialSessionKey] = useState(0);

  function openTutorial(navigateAfter) {
    setTutorialNavigateAfter(navigateAfter);
    setTutorialSessionKey((k) => k + 1);
    setShowTutorial(true);
  }

  function handleVariantClick() {
    if (uuid && !isVariantStrategyTutorialDone(uuid)) {
      openTutorial(true);
      return;
    }
    navigate('/problem-modify');
  }

  function handleTutorialStartClick() {
    openTutorial(false);
  }

  function finishTutorial() {
    if (uuid) markVariantStrategyTutorialDone(uuid);
    setShowTutorial(false);
    if (tutorialNavigateAfter) navigate('/problem-modify');
  }

  function skipTutorial() {
    if (uuid) markVariantStrategyTutorialDone(uuid);
    setShowTutorial(false);
    if (tutorialNavigateAfter) navigate('/problem-modify');
  }

  return (
    <div className="dashboard-container dashboard-container--brand-bg">
      <VariantStrategyTutorial
        key={tutorialSessionKey}
        open={showTutorial}
        onComplete={finishTutorial}
        onSkip={skipTutorial}
      />

      <header className="dashboard-header">
        <div className="header-left">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/student')}>
            ← 메인 메뉴
          </button>
          <span style={{ fontSize: 26 }}>✏️</span>
          <div>
            <h1 className="header-title">문제 만들기</h1>
            <p className="header-subtitle">내가 직접 수학 문제를 만들어 봐요!</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge student-badge">학생</span>
          <span className="user-name">{realName}</span>
          <button onClick={studentLogout} className="btn btn-outline btn-sm">로그아웃</button>
        </div>
      </header>

      <main className="dashboard-main pm-hub-main">
        <HudFrame>
          <div className="section-header">
            <h2 className="section-title">✏️ 문제 만들기 방식 선택</h2>
          </div>
          <p className="section-desc">어떤 방식으로 문제를 만들어 볼까요?</p>

          <div className="pm-mode-grid">
            <button
              type="button"
              className="pm-mode-card pm-mode-card--modify"
              onClick={handleVariantClick}
            >
              <div className="pm-mode-icon">🔄</div>
              <div className="pm-mode-content">
                <h2 className="pm-mode-title">기존 문제 변형하기</h2>
                <p className="pm-mode-desc">
                  선생님이 만든 시험지에서 문제를 골라<br />
                  숫자, 조건, 보기를 바꿔 새로운 문제로 만들어요.
                </p>
                <span className="pm-mode-badge pm-mode-badge--active">시작하기 →</span>
              </div>
            </button>

            <button
              type="button"
              className="pm-mode-card pm-mode-card--new"
              onClick={() => navigate('/problem-create')}
            >
              <div className="pm-mode-icon">🌟</div>
              <div className="pm-mode-content">
                <h2 className="pm-mode-title">새로운 문제 만들기</h2>
                <p className="pm-mode-desc">
                  아무것도 없는 빈 칸에서<br />
                  처음부터 나만의 문제를 만들어요.
                </p>
                <span className="pm-mode-badge pm-mode-badge--active">시작하기 →</span>
              </div>
            </button>
          </div>
        </HudFrame>

        <div className="pm-tutorial-footer">
          <button
            type="button"
            className="pm-tutorial-start-btn"
            onClick={handleTutorialStartClick}
          >
            <span className="pm-tutorial-start-icon" aria-hidden>📘</span>
            튜토리얼 시작
          </button>
        </div>
      </main>
    </div>
  );
}
