import React from 'react';
import { WRONG_NOTE_CHECK_KEYS, WRONG_NOTE_CHECK_LABELS } from '../../constants/wrongNoteCompetency';
import { formatPct } from '../../utils/teacherDashboardUtils';

export default function TeacherStudentDetailPanel({
  student,
  detailTab,
  onDetailTabChange,
  onClose,
  pendingVariantCount,
  pendingWrongNoteCount,
  makingCompetency,
  wrongNoteCompetency,
  classSolveStats,
  onGoInbox,
}) {
  if (!student) return null;

  const lastActiveLabel = (() => {
    if (!student.lastActive) return '없음';
    const raw = typeof student.lastActive === 'string'
      ? student.lastActive
      : student.lastActive?.toDate?.()?.toISOString?.() || String(student.lastActive);
    return raw.slice(0, 10);
  })();

  const rate = student.totalSolved
    ? Math.round((student.totalCorrect / student.totalSolved) * 100)
    : null;
  const solvePct = classSolveStats?.total > 0
    ? Math.round((classSolveStats.correct / classSolveStats.total) * 100)
    : null;
  const pendingTotal = pendingVariantCount + pendingWrongNoteCount;
  const c = makingCompetency?.competency;
  const wn = wrongNoteCompetency?.competency;

  const tabs = [
    { id: 'summary', label: '요약' },
    { id: 'making', label: '변형' },
    { id: 'wrongNote', label: '오답' },
    { id: 'classSolve', label: '학급풀이' },
  ];

  return (
    <div className="td-detail-panel">
      <div className="td-detail-panel__header">
        <div>
          <h3 className="td-detail-panel__title">
            {student.studentNumber ? `${student.studentNumber}번 ` : ''}
            {student.displayName}
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#64748b' }}>
            마지막 접속: {lastActiveLabel}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>

      <div className="td-detail-panel__body">
        {pendingTotal > 0 && (
          <button type="button" className="td-pending-badge" onClick={onGoInbox} style={{ border: 'none', cursor: 'pointer' }}>
            🔔 검수 대기 {pendingTotal}건 — 검수함으로
          </button>
        )}

        <div className="pmc-subtabs" role="tablist" aria-label="학생 상세">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={detailTab === tab.id}
              className={`pmc-subtabs__btn${detailTab === tab.id ? ' pmc-subtabs__btn--active' : ''}`}
              onClick={() => onDetailTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {detailTab === 'summary' && (
          <div style={{ marginTop: 12 }}>
            <div className="td-detail-stat-grid">
              <div className="td-detail-stat">
                <p className="td-detail-stat__label">기본 풀이 / 정답률</p>
                <p className="td-detail-stat__value">
                  {student.totalSolved || 0}문제 · {rate != null ? `${rate}%` : '—'}
                </p>
              </div>
              <div className="td-detail-stat">
                <p className="td-detail-stat__label">변형 성공 (유창성)</p>
                <p className="td-detail-stat__value">{c?.fluency ?? '—'}</p>
              </div>
              <div className="td-detail-stat">
                <p className="td-detail-stat__label">오답노트 완료</p>
                <p className="td-detail-stat__value">{wn?.fluency ?? '—'}</p>
              </div>
              <div className="td-detail-stat">
                <p className="td-detail-stat__label">학급 문제 정답률</p>
                <p className="td-detail-stat__value">{solvePct != null ? `${solvePct}%` : '—'}</p>
              </div>
            </div>
          </div>
        )}

        {detailTab === 'making' && (
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.8 }}>
            {!c ? (
              <p style={{ color: '#6b7280' }}>아직 제출 기록이 없습니다.</p>
            ) : (
              <>
                <p><strong>유창성</strong> (성공 문제 수): {c.fluency}</p>
                <p><strong>융통성</strong> (전략 고른 정도): {formatPct(c.flexibility?.evenness)}</p>
                <p><strong>평균 시도</strong>: {c.accuracy?.avgAttempts ?? '—'}</p>
                <p><strong>평균 시간</strong>: {c.accuracy?.avgDurationMinutes != null ? `${c.accuracy.avgDurationMinutes}분` : '—'}</p>
                <p><strong>한 번에 성공</strong>: {formatPct(c.accuracy?.firstTrySuccessRate)}</p>
              </>
            )}
          </div>
        )}

        {detailTab === 'wrongNote' && (
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.8 }}>
            {!wn ? (
              <p style={{ color: '#6b7280' }}>오답노트 기록이 없습니다.</p>
            ) : (
              <>
                <p><strong>완료</strong>: {wn.fluency} / 틀린 문항 {wn.wrongTotal || '—'}</p>
                <p><strong>완료율</strong>: {formatPct(wn.completionRate)}</p>
                <p><strong>AI 통과율</strong>: {formatPct(wn.aiPassRate)}</p>
                {WRONG_NOTE_CHECK_KEYS.map((key) => (
                  <p key={key}><strong>{WRONG_NOTE_CHECK_LABELS[key]}</strong>: {formatPct(wn.checks?.[key])}</p>
                ))}
              </>
            )}
          </div>
        )}

        {detailTab === 'classSolve' && (
          <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.8 }}>
            {!classSolveStats || classSolveStats.total === 0 ? (
              <p style={{ color: '#6b7280' }}>학급 문제 풀이 기록이 없습니다.</p>
            ) : (
              <>
                <p><strong>맞힌 문제</strong>: {classSolveStats.correct}</p>
                <p><strong>푼 문제</strong>: {classSolveStats.total}</p>
                <p><strong>정답률</strong>: {solvePct != null ? `${solvePct}%` : '—'}</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
