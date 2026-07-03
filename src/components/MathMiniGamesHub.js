/**
 * MathMiniGamesHub.js — 수학 미니게임 모음
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import HudFrame from './HudFrame';
import './MathMiniGames.css';

export default function MathMiniGamesHub() {
  const navigate = useNavigate();
  const { studentSession, studentLogout } = useAuth();
  const { realName } = studentSession || {};

  return (
    <div className="dashboard-container dashboard-container--brand-bg">
      <header className="dashboard-header">
        <div className="header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/student')}>
            ← 메인 메뉴
          </button>
          <span style={{ fontSize: 26 }}>🎮</span>
          <div>
            <h1 className="header-title">수학 미니게임</h1>
            <p className="header-subtitle">문제 은행 없이 즉석 연산으로 즐겨요!</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge student-badge">학생</span>
          <span className="user-name">{realName}</span>
          <button type="button" onClick={studentLogout} className="btn btn-outline btn-sm">로그아웃</button>
        </div>
      </header>

      <main className="dashboard-main mmg-main">
        <HudFrame>
          <div className="mmg-hub-grid">
            <button
              type="button"
              className="mmg-hub-card"
              onClick={() => navigate('/student/games/speed-quiz')}
            >
              <p className="mmg-hub-card-title">⚡ 스피드 퀴즈</p>
              <p className="mmg-hub-card-desc">
                4지선다로 빠르게 연산 문제를 풀어요. 60초 챌린지!
              </p>
            </button>
            <button
              type="button"
              className="mmg-hub-card"
              onClick={() => navigate('/student/games/whack')}
            >
              <p className="mmg-hub-card-title">🎯 답 맞히기</p>
              <p className="mmg-hub-card-desc">
                문제에 맞는 답이 나온 구멍을 눌러요. 수학 두더지 스타일!
              </p>
            </button>
            <button
              type="button"
              className="mmg-hub-card"
              onClick={() => navigate('/student/games/make-ten')}
            >
              <p className="mmg-hub-card-title">🔟 10만들기</p>
              <p className="mmg-hub-card-desc">
                사각형으로 드래그해 합이 10인 숫자를 지워요. 사과게임 스타일!
              </p>
            </button>
          </div>
        </HudFrame>
      </main>
    </div>
  );
}
