import React from 'react';
import { useNavigate } from 'react-router-dom';
import HudFrame from './HudFrame';
import { useAuth } from '../contexts/AuthContext';

export default function TeacherHomeLite() {
  const navigate = useNavigate();
  const { teacherUser, teacherLogout } = useAuth();

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <span className="header-icon">🏫</span>
          <div>
            <h1 className="header-title">교사 도구</h1>
            <p className="header-subtitle">
              시험지 업로드 → 문항 영역 선택 → 학생별 인쇄 → 스캔본 자동정리
            </p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge" style={{ background: '#eef2ff', color: '#4338ca' }}>
            교사
          </span>
          <span className="user-name">{teacherUser?.email || ''}</span>
          <button className="btn btn-outline btn-sm" onClick={() => teacherLogout()}>
            로그아웃
          </button>
        </div>
      </header>

      <main className="dashboard-main" style={{ maxWidth: 920 }}>
        <HudFrame>
          <div className="section-header">
            <h2 className="section-title">필수 흐름</h2>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button className="btn btn-primary" onClick={() => navigate('/exam-papers')}>
              1) 시험지 업로드
            </button>
            <button className="btn btn-primary" onClick={() => navigate('/pdf-region')}>
              2) 시험지OCR(문항 영역 선택)
            </button>
            <button className="btn btn-primary" onClick={() => navigate('/exam-pdf-labels')}>
              3) 학생별 시험지 인쇄
            </button>
            <button className="btn btn-primary" onClick={() => navigate('/scan-organize')}>
              4) 스캔본 자동정리
            </button>
          </div>
          <p style={{ marginTop: 12, fontSize: 13, color: '#64748b' }}>
            ‘검수 시작’(자동 OCR/검수 워크플로우)은 삭제되었고, 현재는 영역 선택과 인쇄/스캔 정리 기능만 남아 있습니다.
          </p>
        </HudFrame>
      </main>
    </div>
  );
}

