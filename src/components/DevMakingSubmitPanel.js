/**
 * DevMakingSubmitPanel — 개발용 문제 만들기 제출 현황 (교사 대시보드)
 */
import React from 'react';
import HudFrame from './HudFrame';
import './DevMakingSubmitPanel.css';

function CountCell({ today, total }) {
  const todayColor = today > 0 ? '#dc2626' : '#111827';
  return (
    <span className="dmsp-count">
      <span className="dmsp-today" style={{ color: todayColor }}>{today}</span>
      <span className="dmsp-sep"> / </span>
      <span className="dmsp-total">{total}</span>
    </span>
  );
}

function ZeroTodayList({ title, names }) {
  return (
    <div className="dmsp-zero-block">
      <h4 className="dmsp-zero-title">{title}</h4>
      {names.length === 0 ? (
        <p className="dmsp-zero-empty">모두 오늘 제출했습니다.</p>
      ) : (
        <p className="dmsp-zero-names">{names.join(', ')}</p>
      )}
    </div>
  );
}

export default function DevMakingSubmitPanel({
  students,
  statsByUuid,
  loading,
  onRefresh,
  embedded = false,
}) {
  const rows = (students || []).filter((s) => s.uuid);

  const variantZeroToday = [];
  const newZeroToday = [];

  rows.forEach((st) => {
    const stats = statsByUuid.get(st.uuid) || {
      variant: { today: 0, total: 0 },
      new: { today: 0, total: 0 },
    };
    const label = st.studentNumber != null
      ? `${st.displayName} (${st.studentNumber}번)`
      : st.displayName;
    if ((stats.variant?.today || 0) === 0) variantZeroToday.push(label);
    if ((stats.new?.today || 0) === 0) newZeroToday.push(label);
  });

  const content = (
    <>
      {!embedded && (
        <div className="section-header">
          <h2 className="section-title">
            🧪 문제 만들기 제출 현황
          </h2>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={onRefresh}
            disabled={loading}
          >
            {loading ? '불러오는 중…' : '🔄 새로고침'}
          </button>
        </div>
      )}
      <p className="dmsp-desc">
        제출만 하면 집계됩니다 (완성도·승인 여부 무관). 오늘 수는 빨간색, 0은 검은색입니다.
      </p>

      {loading && rows.length === 0 ? (
        <div className="loading-box"><div className="spinner-large" /><p>불러오는 중...</p></div>
      ) : rows.length === 0 ? (
        <div className="empty-box">
          <p>등록된 학생이 없습니다.</p>
        </div>
      ) : (
        <>
          <div className="table-wrapper">
            <table className="data-table dmsp-table">
              <thead>
                <tr>
                  <th>번호</th>
                  <th>이름</th>
                  <th className="text-center">기존 문제 변형하기</th>
                  <th className="text-center">새로운 문제 만들기</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((st) => {
                  const stats = statsByUuid.get(st.uuid) || {
                    variant: { today: 0, total: 0 },
                    new: { today: 0, total: 0 },
                  };
                  return (
                    <tr key={st.uuid}>
                      <td className="text-center">{st.studentNumber || '-'}</td>
                      <td><strong>{st.displayName}</strong></td>
                      <td className="text-center">
                        <CountCell today={stats.variant.today} total={stats.variant.total} />
                      </td>
                      <td className="text-center">
                        <CountCell today={stats.new.today} total={stats.new.total} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="dmsp-zero-section">
            <h3 className="dmsp-zero-heading">오늘 아직 제출하지 않은 학생</h3>
            <ZeroTodayList
              title="기존 문제 변형하기"
              names={variantZeroToday}
            />
            <ZeroTodayList
              title="새로운 문제 만들기"
              names={newZeroToday}
            />
          </div>
        </>
      )}
    </>
  );

  if (embedded) return content;
  return <HudFrame>{content}</HudFrame>;
}
