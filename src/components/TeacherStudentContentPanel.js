/**
 * TeacherStudentContentPanel — 학생이 보는 채점 결과·시험지 목록 미리보기 + 노출 토글
 */
import React, { useCallback, useEffect, useState } from 'react';
import HudFrame from './HudFrame';
import {
  getExamList,
  getClassHiddenExamResultKeys,
  setClassExamResultVisible,
  setExamStudentVisible,
  filterExamsVisibleToStudents,
} from '../firebase/firestoreOps';
import {
  EXAM_RESULT_TRASH_RETENTION_DAYS,
  getTrashedExamResults,
  trashClassExamResultGroup,
  restoreTrashedExamResult,
  permanentlyDeleteTrashedExamResult,
  daysUntilExamResultTrashPurge,
} from '../firebase/examResultTrashOps';
import {
  examResultLabel,
  formatScoredAt,
  aggregateClassExamResultGroups,
  formatAiScoreDisplay,
  formatAiScoreDetail,
  correctCountToHundredPoints,
  isHundredPointExamTotal,
} from '../utils/examResults';

function VisibilityToggle({ visible, disabled, onChange, id }) {
  return (
    <label
      htmlFor={id}
      className={`td-vis-toggle${visible ? ' td-vis-toggle--on' : ''}`}
      style={{ opacity: disabled ? 0.6 : 1 }}
    >
      <input
        id={id}
        type="checkbox"
        checked={visible}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="td-vis-toggle__track" aria-hidden />
      <span className="td-vis-toggle__label">{visible ? '학생에게 보임' : '숨김'}</span>
    </label>
  );
}

export default function TeacherStudentContentPanel({
  classCode,
  serverStudents,
  showToast,
  onStudentsRefresh,
}) {
  const [loading, setLoading] = useState(true);
  const [hiddenExamKeys, setHiddenExamKeys] = useState([]);
  const [allExams, setAllExams] = useState([]);
  const [trashedResults, setTrashedResults] = useState([]);
  const [togglingResultKey, setTogglingResultKey] = useState(null);
  const [togglingExamId, setTogglingExamId] = useState(null);
  const [trashingResultKey, setTrashingResultKey] = useState(null);
  const [restoringTrashId, setRestoringTrashId] = useState(null);
  const [purgingTrashId, setPurgingTrashId] = useState(null);

  const loadPanel = useCallback(async () => {
    if (!classCode) return;
    setLoading(true);
    try {
      const [hidden, exams, trash] = await Promise.all([
        getClassHiddenExamResultKeys(classCode),
        getExamList(),
        getTrashedExamResults(classCode),
      ]);
      setHiddenExamKeys(hidden);
      setAllExams(exams);
      setTrashedResults(trash);
    } catch (e) {
      showToast?.('학생 화면 목록 로드 오류: ' + e.message, 'error');
    }
    setLoading(false);
  }, [classCode, showToast]);

  useEffect(() => {
    loadPanel();
  }, [loadPanel]);

  const resultGroups = aggregateClassExamResultGroups(serverStudents, hiddenExamKeys);
  const studentVisibleExams = filterExamsVisibleToStudents(allExams);

  async function handleToggleExamResult(groupKey, visible) {
    setTogglingResultKey(groupKey);
    try {
      await setClassExamResultVisible(classCode, groupKey, visible);
      setHiddenExamKeys((prev) => {
        const set = new Set(prev);
        if (visible) set.delete(groupKey);
        else set.add(groupKey);
        return [...set];
      });
      showToast?.(visible ? '채점 결과를 학생에게 표시합니다.' : '채점 결과를 학생에게 숨겼습니다.');
    } catch (e) {
      showToast?.('저장 오류: ' + e.message, 'error');
    }
    setTogglingResultKey(null);
  }

  async function handleTrashExamResult(row) {
    const label = examResultLabel(row.entry);
    const ok = window.confirm(
      `「${label}」 채점 결과를 휴지통으로 옮길까요?\n\n`
      + `학생 화면에서 바로 사라지며, ${EXAM_RESULT_TRASH_RETENTION_DAYS}일 후 자동으로 영구 삭제됩니다. `
      + '그 전에는 아래 휴지통에서 복구할 수 있습니다.',
    );
    if (!ok) return;

    setTrashingResultKey(row.key);
    try {
      await trashClassExamResultGroup(classCode, row.key, serverStudents);
      await onStudentsRefresh?.();
      await loadPanel();
      showToast?.('채점 결과를 휴지통으로 옮겼습니다.');
    } catch (e) {
      showToast?.('휴지통 이동 오류: ' + e.message, 'error');
    }
    setTrashingResultKey(null);
  }

  async function handleRestoreTrash(trashId, label) {
    const ok = window.confirm(`「${label}」 채점 결과를 복구할까요?`);
    if (!ok) return;

    setRestoringTrashId(trashId);
    try {
      await restoreTrashedExamResult(classCode, trashId);
      await onStudentsRefresh?.();
      await loadPanel();
      showToast?.('채점 결과를 복구했습니다.');
    } catch (e) {
      showToast?.('복구 오류: ' + e.message, 'error');
    }
    setRestoringTrashId(null);
  }

  async function handlePurgeTrash(trashId, label) {
    const ok = window.confirm(
      `「${label}」을(를) 지금 영구 삭제할까요?\n\n복구할 수 없습니다.`,
    );
    if (!ok) return;

    setPurgingTrashId(trashId);
    try {
      await permanentlyDeleteTrashedExamResult(classCode, trashId);
      await loadPanel();
      showToast?.('영구 삭제했습니다.');
    } catch (e) {
      showToast?.('삭제 오류: ' + e.message, 'error');
    }
    setPurgingTrashId(null);
  }

  async function handleToggleExam(examId, visible) {
    setTogglingExamId(examId);
    try {
      await setExamStudentVisible(examId, visible);
      setAllExams((prev) =>
        prev.map((ex) => (ex.id === examId ? { ...ex, studentVisible: visible } : ex)),
      );
      showToast?.(visible ? '시험지를 학생에게 표시합니다.' : '시험지를 학생에게 숨겼습니다.');
    } catch (e) {
      showToast?.('저장 오류: ' + e.message, 'error');
    }
    setTogglingExamId(null);
  }

  return (
    <div>
      <HudFrame>
        <div className="section-header">
          <h2 className="section-title">📋 채점 결과 목록 (학생 화면)</h2>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={loadPanel}
            disabled={loading}
          >
            🔄 새로고침
          </button>
        </div>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
          표시 이름은 <strong>시험지 업로드</strong>에서만 바꿉니다. 저장하면 채점 결과·변형하기
          목록에 같은 이름이 쓰입니다. 토글을 끄면 우리 반 전체에 숨겨집니다.
          잘못 전송한 결과는 <strong>🗑️ 휴지통</strong>으로 옮길 수 있으며,{' '}
          {EXAM_RESULT_TRASH_RETENTION_DAYS}일 후 자동으로 영구 삭제됩니다.
        </p>

        {loading ? (
          <p style={{ color: '#6b7280' }}>불러오는 중…</p>
        ) : resultGroups.length === 0 ? (
          <div className="empty-box" style={{ padding: '24px 16px' }}>
            <span className="empty-icon">📭</span>
            <p>아직 저장된 채점 결과가 없습니다.</p>
            <p style={{ fontSize: 13, color: '#9ca3af' }}>
              스캔본 자동 정리에서 채점을 저장하면 여기에 나타납니다.
            </p>
          </div>
        ) : (
          <ul className="td-student-content-list">
            {resultGroups.map((row) => {
              const entry = row.entry;
              const stats = row.stats;
              const total = stats?.totalProblems ?? 0;
              const avg = stats?.avgCorrect ?? 0;
              const avgDisplay = formatAiScoreDisplay(avg, total);
              const range =
                stats && stats.minCorrect !== stats.maxCorrect
                  ? isHundredPointExamTotal(total)
                    ? ` (최저 ${correctCountToHundredPoints(stats.minCorrect, total)}~최고 ${correctCountToHundredPoints(stats.maxCorrect, total)})`
                    : ` (최저 ${stats.minCorrect}~최고 ${stats.maxCorrect})`
                  : '';
              const scoredAt = stats?.latestScoredAt || entry.scoredAt;
              const busy = togglingResultKey === row.key;
              const trashBusy = trashingResultKey === row.key;
              return (
                <li key={row.key} className="td-student-content-item">
                  <div className="td-student-content-item__main">
                    <div className="td-student-content-item__title">
                      {examResultLabel(entry)}
                    </div>
                    <div className="td-student-content-item__meta">
                      {formatScoredAt(scoredAt)}
                      {formatScoredAt(scoredAt) ? ' · ' : ''}
                      AI 채점 반 평균 {formatAiScoreDetail(avg, total)}{range}
                      {' · '}
                      학생 {row.studentCount}명에게 표시됨
                    </div>
                  </div>
                  <div className="td-student-content-item__aside">
                    <div className="td-student-content-item__score">
                      <span className="td-student-content-item__score-num">
                        {avgDisplay}
                      </span>
                      <span className="td-student-content-item__score-label">반 평균 (AI)</span>
                    </div>
                    <div className="td-student-content-item__controls">
                      <VisibilityToggle
                        id={`exam-result-vis-${row.key}`}
                        visible={row.visible}
                        disabled={busy || trashBusy}
                        onChange={(v) => handleToggleExamResult(row.key, v)}
                      />
                      <button
                        type="button"
                        className="td-student-content-trash-btn"
                        title="휴지통으로 이동"
                        aria-label="휴지통으로 이동"
                        disabled={busy || trashBusy}
                        onClick={() => handleTrashExamResult(row)}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {!loading && trashedResults.length > 0 && (
          <div className="td-exam-result-trash-panel">
            <h3 className="td-exam-result-trash-panel__title">
              🗑️ 휴지통 ({trashedResults.length})
            </h3>
            <ul className="td-exam-result-trash-list">
              {trashedResults.map((item) => {
                const daysLeft = daysUntilExamResultTrashPurge(item.purgeAfter);
                const restoreBusy = restoringTrashId === item.id;
                const purgeBusy = purgingTrashId === item.id;
                const itemBusy = restoreBusy || purgeBusy;
                return (
                  <li key={item.id} className="td-exam-result-trash-item">
                    <div className="td-exam-result-trash-item__main">
                      <div className="td-exam-result-trash-item__label">{item.label}</div>
                      <div className="td-exam-result-trash-item__meta">
                        {formatScoredAt(item.deletedAt) && `${formatScoredAt(item.deletedAt)} 삭제`}
                        {formatScoredAt(item.deletedAt) ? ' · ' : ''}
                        학생 {item.studentCount ?? 0}명
                        {' · '}
                        {daysLeft <= 0
                          ? '곧 영구 삭제'
                          : `${daysLeft}일 후 영구 삭제`}
                      </div>
                    </div>
                    <div className="td-exam-result-trash-item__actions">
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        disabled={itemBusy}
                        onClick={() => handleRestoreTrash(item.id, item.label)}
                      >
                        {restoreBusy ? '복구 중…' : '복구'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{ color: '#dc2626', borderColor: '#fecaca' }}
                        disabled={itemBusy}
                        onClick={() => handlePurgeTrash(item.id, item.label)}
                      >
                        {purgeBusy ? '삭제 중…' : '영구 삭제'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </HudFrame>

      <HudFrame style={{ marginTop: 24 }}>
        <div className="section-header">
          <h2 className="section-title">📄 시험지 고르기 (기존 문제 변형하기)</h2>
        </div>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
          학생이 「문제 만들기 → 기존 문제 변형하기」에서 보는 시험지 목록입니다.
          제목도 <strong>시험지 업로드</strong> 표시 이름과 같습니다.
          지금 학생에게 보이는 시험지는 <strong>{studentVisibleExams.length}개</strong>
          (전체 {allExams.length}개 중).
        </p>

        {loading ? (
          <p style={{ color: '#6b7280' }}>불러오는 중…</p>
        ) : allExams.length === 0 ? (
          <div className="empty-box" style={{ padding: '24px 16px' }}>
            <span className="empty-icon">📭</span>
            <p>저장된 시험지가 없습니다.</p>
            <p style={{ fontSize: 13, color: '#9ca3af' }}>
              시험지 OCR·문제 보관함에서 시험지를 저장하면 목록에 나타납니다.
            </p>
          </div>
        ) : (
          <ul className="td-student-content-list">
            {allExams.map((exam) => {
              const visible = exam.studentVisible !== false;
              const busy = togglingExamId === exam.id;
              return (
                <li key={exam.id} className="td-student-content-item">
                  <div className="td-student-content-item__main">
                    <div className="td-student-content-item__title">
                      {exam.title || '제목 없음'}
                    </div>
                    <div className="td-student-content-item__meta">
                      {exam.examGrade && (
                        <span className="pmod-grade-badge" style={{ marginRight: 6 }}>
                          {exam.examGrade}
                        </span>
                      )}
                      {exam.questionCount ? `${exam.questionCount}문항` : ''}
                      {exam.createdAt ? ` · ${exam.createdAt.slice(0, 10)}` : ''}
                    </div>
                  </div>
                  <VisibilityToggle
                    id={`exam-vis-${exam.id}`}
                    visible={visible}
                    disabled={busy}
                    onChange={(v) => handleToggleExam(exam.id, v)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </HudFrame>
    </div>
  );
}
