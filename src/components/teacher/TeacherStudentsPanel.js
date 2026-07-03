import React from 'react';
import HudFrame from '../HudFrame';
import ClassRankingList from '../ClassRankingList';
import { buildClassRanking } from '../../utils/classRanking';
import { WRONG_NOTE_CHECK_KEYS, WRONG_NOTE_CHECK_LABELS } from '../../constants/wrongNoteCompetency';
import DevMakingSubmitPanel from '../DevMakingSubmitPanel';
import TeacherStudentDetailPanel from './TeacherStudentDetailPanel';
import {
  formatStudentNameWithNickname,
  shouldShowKimchiNicknameLabels,
} from '../../utils/kimchiNicknames';

export default function TeacherStudentsPanel({
  teacherEmail,
  classCode,
  mergedStudents,
  loading,
  evaluationSubTab,
  onEvaluationSubTabChange,
  competencyRowsSorted,
  wrongNoteCompetencyRowsSorted,
  classSolveStatsSorted,
  competencyLoading,
  wrongNoteCompetencyLoading,
  classSolveStatsLoading,
  onRefreshEvaluation,
  selectedStudentUuid,
  onSelectStudent,
  studentDetailTab,
  onStudentDetailTabChange,
  variantReviews,
  wrongNoteReviews,
  competencyByUuid,
  wrongNoteCompetencyByUuid,
  classSolveStatsByUuid,
  onGoInbox,
  onShowAddModal,
  onRefreshList,
  selectedStudentUuids,
  selectAllCheckboxRef,
  onSelectAll,
  onToggleStudent,
  onDeleteSelected,
  onBulkPinReset,
  onDeleteStudent,
  onShowPinModal,
  onShowBulkLinkModal,
  missingLocalStudents,
  inlineNameDrafts,
  inlineNameSavingUuid,
  onInlineNameDraftChange,
  onSaveInlineRealName,
  showDevMakingSubmitPanel,
  makingSubmitStatsByUuid,
  makingSubmitStatsLoading,
  onRefreshMakingSubmitStats,
}) {
  const selectedStudent = mergedStudents.find((s) => s.uuid === selectedStudentUuid) || null;
  const showStudentDbDetail = Boolean(selectedStudentUuid && selectedStudent);

  const showKimchiNicknameInStudentDb = React.useMemo(
    () => shouldShowKimchiNicknameLabels({ teacherEmail, classCode }),
    [teacherEmail, classCode],
  );

  const studentDbLabelByUuid = React.useMemo(() => {
    const map = new Map();
    if (!showKimchiNicknameInStudentDb) return map;

    (mergedStudents || []).forEach((s, idx) => {
      const uuid = String(s?.uuid || '').trim();
      if (!uuid) return;
      const base = String(s?.displayName || '').trim();
      map.set(
        uuid,
        formatStudentNameWithNickname(base, s, idx) || uuid.slice(0, 8),
      );
    });
    return map;
  }, [mergedStudents, showKimchiNicknameInStudentDb]);

  const labelForStudentDb = React.useCallback((uuid, fallback = '') => {
    const key = String(uuid || '').trim();
    if (!key) return fallback;
    if (!showKimchiNicknameInStudentDb) return fallback || key.slice(0, 8);
    return studentDbLabelByUuid.get(key) || fallback || key.slice(0, 8);
  }, [showKimchiNicknameInStudentDb, studentDbLabelByUuid]);

  const classRanking = React.useMemo(
    () => buildClassRanking(mergedStudents),
    [mergedStudents],
  );

  const pendingVariantByUuid = React.useMemo(() => {
    const map = new Map();
    variantReviews.forEach((item) => {
      const id = item.studentUUID;
      if (id) map.set(id, (map.get(id) || 0) + 1);
    });
    return map;
  }, [variantReviews]);

  const pendingWrongNoteByUuid = React.useMemo(() => {
    const map = new Map();
    wrongNoteReviews.forEach((item) => {
      const id = item.studentUUID;
      if (id) map.set(id, (map.get(id) || 0) + 1);
    });
    return map;
  }, [wrongNoteReviews]);

  const studentDetailPanel = selectedStudent ? (
    <TeacherStudentDetailPanel
      student={selectedStudent}
      detailTab={studentDetailTab}
      onDetailTabChange={onStudentDetailTabChange}
      onClose={() => onSelectStudent(null)}
      pendingVariantCount={pendingVariantByUuid.get(selectedStudent.uuid) || 0}
      pendingWrongNoteCount={pendingWrongNoteByUuid.get(selectedStudent.uuid) || 0}
      makingCompetency={competencyByUuid?.get(selectedStudent.uuid)}
      wrongNoteCompetency={wrongNoteCompetencyByUuid?.get(selectedStudent.uuid)}
      classSolveStats={classSolveStatsByUuid?.get(selectedStudent.uuid)}
      onGoInbox={onGoInbox}
    />
  ) : null;

  const evaluationTabs = [
    { id: 'studentDb', label: '학생DB' },
    { id: 'classRanking', label: '우리 반 랭킹' },
    { id: 'making', label: '문제 만들기' },
    { id: 'wrongNote', label: '오답노트' },
    { id: 'classSolve', label: '학급 문제 풀이' },
    ...(showDevMakingSubmitPanel ? [{ id: 'makingSubmit', label: '제출 현황' }] : []),
  ];

  const showEvaluationRefresh =
    evaluationSubTab !== 'studentDb'
    && evaluationSubTab !== 'classRanking'
    && evaluationSubTab !== 'makingSubmit';

  return (
    <div>
      <HudFrame>
        <div className="section-header">
          <h2 className="section-title">📊 학생 데이터</h2>
          {evaluationSubTab === 'makingSubmit' ? (
            <button type="button" className="btn btn-outline btn-sm" onClick={onRefreshMakingSubmitStats} disabled={makingSubmitStatsLoading}>
              🔄 새로고침
            </button>
          ) : showEvaluationRefresh && (
            <button type="button" className="btn btn-outline btn-sm" onClick={onRefreshEvaluation} disabled={competencyLoading || wrongNoteCompetencyLoading || classSolveStatsLoading}>
              🔄 새로고침
            </button>
          )}
        </div>

        <div className="pmc-subtabs" role="tablist" aria-label="학생 데이터 유형">
          {evaluationTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={evaluationSubTab === tab.id}
              className={`pmc-subtabs__btn${evaluationSubTab === tab.id ? ' pmc-subtabs__btn--active' : ''}`}
              onClick={() => onEvaluationSubTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {evaluationSubTab === 'studentDb' && (
          <>
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12,
              padding: '10px 16px', fontSize: 13, color: '#15803d', marginBottom: 16 }}>
              🔒 학생 실명은 이 기기(IndexedDB)에만 저장됩니다. 서버에는 UUID와 해시값만 저장됩니다.
            </div>

            {showStudentDbDetail ? (
              <div className="td-student-db-detail">
                <div style={{ marginBottom: 12 }}>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => onSelectStudent(null)}>
                    ← 학생 목록
                  </button>
                </div>
                {studentDetailPanel}
              </div>
            ) : (
              <>
                <div className="section-header" style={{ marginBottom: 12 }}>
                  <h3 className="section-title" style={{ fontSize: 15, margin: 0 }}>
                    학생DB
                    <span style={{ marginLeft: 8, fontSize: 13, color: '#9ca3af', fontWeight: 400 }}>
                      {mergedStudents.length}명 · 이름을 눌러 상세 보기
                    </span>
                  </h3>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-danger btn-sm" disabled={!selectedStudentUuids.length} onClick={onDeleteSelected}>
                      선택 삭제{selectedStudentUuids.length ? ` (${selectedStudentUuids.length})` : ''}
                    </button>
                    <button type="button" className="btn btn-outline btn-sm" disabled={!selectedStudentUuids.length} onClick={onBulkPinReset}>
                      비밀번호 일괄 초기화
                    </button>
                    {missingLocalStudents.length > 0 && (
                      <button type="button" className="btn btn-outline btn-sm" onClick={onShowBulkLinkModal}>
                        🧾 로컬 이름 연결 ({missingLocalStudents.length})
                      </button>
                    )}
                    <button type="button" className="btn btn-outline btn-sm" onClick={onRefreshList}>🔄</button>
                    <button type="button" className="btn btn-primary btn-sm" onClick={onShowAddModal}>+ 학생 추가</button>
                  </div>
                </div>

                {loading ? (
                  <div className="loading-box"><div className="spinner-large" /><p>불러오는 중...</p></div>
                ) : mergedStudents.length === 0 ? (
                  <div className="empty-box">
                    <span className="empty-icon">👨‍🎓</span>
                    <p>등록된 학생이 없습니다.</p>
                  </div>
                ) : (
                  <div className="table-wrapper">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th style={{ width: 44 }}>
                            <input
                              ref={selectAllCheckboxRef}
                              type="checkbox"
                              checked={mergedStudents.length > 0 && selectedStudentUuids.length === mergedStudents.length}
                              onChange={onSelectAll}
                              aria-label="목록 전체 선택"
                            />
                          </th>
                          <th>번호</th>
                          <th>이름</th>
                          <th>풀이</th>
                          <th>정답률</th>
                          <th>검수 대기</th>
                          <th>마지막 접속</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mergedStudents.map((s) => {
                          const rate = s.totalSolved
                            ? Math.round((s.totalCorrect / s.totalSolved) * 100)
                            : null;
                          const pending = (pendingVariantByUuid.get(s.uuid) || 0) + (pendingWrongNoteByUuid.get(s.uuid) || 0);
                          const needsLocalName = !s.hasLocalData || s.displayName === '[이름 없음]';
                          const label = labelForStudentDb(s.uuid, s.displayName);
                          return (
                            <tr
                              key={s.uuid}
                              className={`td-student-row--clickable${selectedStudentUuid === s.uuid ? ' td-student-row--selected' : ''}`}
                              onClick={() => onSelectStudent(s.uuid)}
                              style={!s.hasLocalData ? { opacity: 0.6 } : undefined}
                            >
                              <td className="text-center" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={selectedStudentUuids.includes(s.uuid)}
                                  onChange={() => onToggleStudent(s.uuid)}
                                  aria-label={`${label} 선택`}
                                />
                              </td>
                              <td className="text-center">{s.studentNumber || '-'}</td>
                              <td>
                                <strong>{label}</strong>
                                {needsLocalName && (
                                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                                    <input
                                      className="input"
                                      style={{ width: 160, padding: '6px 8px' }}
                                      placeholder="이름 입력(로컬)"
                                      value={inlineNameDrafts?.[s.uuid] ?? ''}
                                      onChange={(e) => onInlineNameDraftChange(s.uuid, e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          onSaveInlineRealName(s);
                                        }
                                      }}
                                      disabled={inlineNameSavingUuid === s.uuid}
                                    />
                                    <button type="button" className="btn btn-outline btn-xs" onClick={() => onSaveInlineRealName(s)} disabled={inlineNameSavingUuid === s.uuid}>
                                      {inlineNameSavingUuid === s.uuid ? '…' : '저장'}
                                    </button>
                                  </div>
                                )}
                              </td>
                              <td className="text-center">{s.totalSolved || 0}</td>
                              <td className="text-center">
                                <span className={`badge ${
                                  rate === null ? 'badge-gray'
                                    : rate >= 80 ? 'badge-green'
                                      : rate >= 60 ? 'badge-yellow'
                                        : 'badge-red'
                                }`}>
                                  {rate === null ? '—' : `${rate}%`}
                                </span>
                              </td>
                              <td className="text-center">
                                {pending > 0 ? (
                                  <span style={{ fontSize: 12, fontWeight: 600, color: '#b45309' }}>{pending}건</span>
                                ) : '—'}
                              </td>
                              <td className="text-center" style={{ fontSize: 12, color: '#9ca3af' }}>
                                {s.lastActive ? s.lastActive.slice(0, 10) : '-'}
                              </td>
                              <td onClick={(e) => e.stopPropagation()}>
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <button type="button" className="btn btn-outline btn-xs" onClick={() => onShowPinModal(s)}>
                                    🔑 비밀번호
                                  </button>
                                  <button type="button" className="btn btn-danger btn-xs" onClick={() => onDeleteStudent(s)}>
                                    삭제
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {evaluationSubTab === 'classRanking' && (
          <>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px' }}>
              최근 30일 탐구점수 기준
            </p>
            <ClassRankingList rows={classRanking} loading={loading} showSelfSuffix={false} />
          </>
        )}

        {evaluationSubTab === 'making' && (
          competencyLoading ? (
            <p style={{ color: '#6b7280' }}>불러오는 중…</p>
          ) : competencyRowsSorted.length === 0 ? (
            <p style={{ color: '#6b7280' }}>아직 제출 기록이 없습니다.</p>
          ) : (
            <table className="pmc-teacher-table">
              <thead>
                <tr>
                  <th>학생</th>
                  <th>유창성</th>
                  <th>융통성</th>
                  <th>평균 시도</th>
                  <th>평균 시간(분)</th>
                  <th>한 번에 성공</th>
                </tr>
              </thead>
              <tbody>
                {competencyRowsSorted.map((row) => {
                  const st = mergedStudents.find((m) => m.uuid === row.uuid);
                  const label = st?.displayName || row.uuid?.slice(0, 8);
                  const c = row.competency;
                  return (
                    <tr
                      key={row.uuid}
                      className={`td-student-row--clickable${selectedStudentUuid === row.uuid ? ' td-student-row--selected' : ''}`}
                      onClick={() => onSelectStudent(row.uuid)}
                    >
                      <td>{label}</td>
                      <td>{c.fluency}</td>
                      <td>{Math.round((c.flexibility?.evenness ?? 0) * 100)}%</td>
                      <td>{c.accuracy?.avgAttempts ?? '—'}</td>
                      <td>{c.accuracy?.avgDurationMinutes ?? '—'}</td>
                      <td>{c.accuracy?.firstTrySuccessRate != null ? `${Math.round(c.accuracy.firstTrySuccessRate * 100)}%` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}

        {evaluationSubTab === 'wrongNote' && (
          wrongNoteCompetencyLoading ? (
            <p style={{ color: '#6b7280' }}>불러오는 중…</p>
          ) : wrongNoteCompetencyRowsSorted.length === 0 ? (
            <p style={{ color: '#6b7280' }}>학생 데이터가 없습니다.</p>
          ) : (
            <table className="pmc-teacher-table">
              <thead>
                <tr>
                  <th>학생</th>
                  <th>완료</th>
                  <th>틀린 문항</th>
                  <th>완료율</th>
                  <th>AI 통과</th>
                  {WRONG_NOTE_CHECK_KEYS.map((key) => (
                    <th key={key}>{WRONG_NOTE_CHECK_LABELS[key]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {wrongNoteCompetencyRowsSorted.map((row) => {
                  const st = mergedStudents.find((m) => m.uuid === row.uuid);
                  const label = st?.displayName || row.uuid?.slice(0, 8);
                  const c = row.competency;
                  const fmtPct = (v) => (v != null ? `${Math.round(v * 100)}%` : '—');
                  return (
                    <tr
                      key={row.uuid}
                      className={`td-student-row--clickable${selectedStudentUuid === row.uuid ? ' td-student-row--selected' : ''}`}
                      onClick={() => onSelectStudent(row.uuid)}
                    >
                      <td>{label}</td>
                      <td>{c.fluency}</td>
                      <td>{c.wrongTotal || '—'}</td>
                      <td>{fmtPct(c.completionRate)}</td>
                      <td>{fmtPct(c.aiPassRate)}</td>
                      {WRONG_NOTE_CHECK_KEYS.map((key) => (
                        <td key={key}>{fmtPct(c.checks?.[key])}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}

        {evaluationSubTab === 'classSolve' && (
          classSolveStatsLoading ? (
            <p style={{ color: '#6b7280' }}>불러오는 중…</p>
          ) : classSolveStatsSorted.length === 0 ? (
            <p style={{ color: '#6b7280' }}>학생 데이터가 없습니다.</p>
          ) : (
            <table className="pmc-teacher-table">
              <thead>
                <tr>
                  <th>학생</th>
                  <th>맞힌 문제</th>
                  <th>푼 문제</th>
                  <th>정답률</th>
                </tr>
              </thead>
              <tbody>
                {classSolveStatsSorted.map((row) => {
                  const st = mergedStudents.find((m) => m.uuid === row.uuid);
                  const label = st?.displayName || row.uuid?.slice(0, 8);
                  const pct = row.total > 0 ? Math.round((row.correct / row.total) * 100) : null;
                  return (
                    <tr
                      key={row.uuid}
                      className={`td-student-row--clickable${selectedStudentUuid === row.uuid ? ' td-student-row--selected' : ''}`}
                      onClick={() => onSelectStudent(row.uuid)}
                    >
                      <td>{label}</td>
                      <td>{row.correct}</td>
                      <td>{row.total}</td>
                      <td>{pct != null ? `${pct}%` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}

        {evaluationSubTab === 'makingSubmit' && (
          <DevMakingSubmitPanel
            embedded
            students={mergedStudents}
            statsByUuid={makingSubmitStatsByUuid}
            loading={makingSubmitStatsLoading}
            onRefresh={onRefreshMakingSubmitStats}
          />
        )}

        {evaluationSubTab !== 'studentDb'
          && evaluationSubTab !== 'classRanking'
          && evaluationSubTab !== 'makingSubmit'
          && selectedStudent && (
          <div className="td-students-layout" style={{ marginTop: 16 }}>
            <div className="td-students-layout__detail">
              {studentDetailPanel}
            </div>
          </div>
        )}
      </HudFrame>
    </div>
  );
}
