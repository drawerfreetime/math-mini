import React from 'react';
import HudFrame from '../HudFrame';

export default function TeacherHomePanel({
  mergedStudents,
  totalSolved,
  totalCorrect,
  variantReviewCount,
  wrongNoteReviewCount,
  onGoInbox,
  onGoInboxFilter,
  onGoStudents,
  onGoProblemBank,
  navigate,
  onShowExamResultModal,
}) {
  const avgRate = totalSolved > 0 ? Math.round((totalCorrect / totalSolved) * 100) : 0;
  const pendingTotal = variantReviewCount + wrongNoteReviewCount;
  const inactiveCount = mergedStudents.filter((s) => !s.lastActive).length;

  return (
    <div>
      <HudFrame>
        <div className="section-header">
          <h2 className="section-title">오늘 할 일</h2>
        </div>
        <div className="td-home-cards">
          <button
            type="button"
            className={`td-home-card${pendingTotal > 0 ? ' td-home-card--alert' : ''}`}
            onClick={() => onGoInbox('all')}
          >
            <p className="td-home-card__label">검수 대기 (전체)</p>
            <p className="td-home-card__value">{pendingTotal}건</p>
          </button>
          <button
            type="button"
            className={`td-home-card${variantReviewCount > 0 ? ' td-home-card--alert' : ''}`}
            onClick={() => onGoInboxFilter('variant')}
          >
            <p className="td-home-card__label">변형 문제</p>
            <p className="td-home-card__value">{variantReviewCount}건</p>
          </button>
          <button
            type="button"
            className={`td-home-card${wrongNoteReviewCount > 0 ? ' td-home-card--alert' : ''}`}
            onClick={() => onGoInboxFilter('wrongNote')}
          >
            <p className="td-home-card__label">오답노트</p>
            <p className="td-home-card__value">{wrongNoteReviewCount}건</p>
          </button>
        </div>
        {pendingTotal > 0 && (
          <p style={{ fontSize: 13, color: '#92400e', margin: '0 0 4px' }}>
            검수 대기가 있습니다. 카드를 눌러 검수함으로 이동하세요.
          </p>
        )}
      </HudFrame>

      <HudFrame style={{ marginTop: 16 }}>
        <div className="section-header">
          <h2 className="section-title">🛠 수업 도구</h2>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/exam-papers')}>
            📤 시험지 업로드
          </button>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/pdf-extractor')}>
            📑 시험지 OCR
          </button>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/exam-pdf-labels')}>
            📎 학생별 시험지 인쇄
          </button>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/exam-bank')}>
            📚 문제 보관함
          </button>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/scan-organize')}>
            📑 스캔본 자동 정리
          </button>
          <button type="button" className="btn btn-outline" onClick={onShowExamResultModal}>
            👁 채점 결과 공개
          </button>
          <button type="button" className="btn btn-outline" onClick={onGoProblemBank}>
            📚 학급 문제은행
          </button>
        </div>
      </HudFrame>

      <HudFrame style={{ marginTop: 16 }}>
        <div className="section-header">
          <h2 className="section-title">반 요약</h2>
          <button type="button" className="btn btn-outline btn-sm" onClick={onGoStudents}>
            학생 기록 보기
          </button>
        </div>
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon">👨‍🎓</div>
            <div className="stat-info">
              <p className="stat-label">등록 학생</p>
              <p className="stat-value">{mergedStudents.length}명</p>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">📝</div>
            <div className="stat-info">
              <p className="stat-label">총 풀이</p>
              <p className="stat-value">{totalSolved}문제</p>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">🎯</div>
            <div className="stat-info">
              <p className="stat-label">반 평균 정답률</p>
              <p className="stat-value">{avgRate}%</p>
            </div>
          </div>
          {inactiveCount > 0 && (
            <div className="stat-card">
              <div className="stat-icon">💤</div>
              <div className="stat-info">
                <p className="stat-label">접속 기록 없음</p>
                <p className="stat-value">{inactiveCount}명</p>
              </div>
            </div>
          )}
        </div>
      </HudFrame>
    </div>
  );
}
