/**
 * ClassProblemBank.js — 학급 문제은행 (풀이·평가)
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  getClassProblems,
  syncStudentProblemsToClassBank,
  getStudentClassProblemStatuses,
  devRevertStudentClassProblemProgress,
  retryOwnPendingClassProblemAiReviews,
  compareClassProblemsByLabel,
} from '../firebase/classProblemBankOps';
import { isTeacherReviewConfirmed } from '../utils/studentAiFeedback';
import { renderMathText } from './ExamOCR';
import { getExamQuestionStemForStudent } from '../utils/examSolutionArea';
import { isDevClassProblemSolveResetEnabled } from '../utils/devClassProblemSolveReset';
import { CheckCircle, ListChecks, Pencil, SquarePen } from 'lucide-react';
import './ClassProblemBank.css';

function ClassProblemCardPreview({ problem }) {
  const stem = getExamQuestionStemForStudent(problem.variantQuestion);

  return (
    <div className="cpb-card-preview">
      <div className="cpb-card-stem">{renderMathText(stem)}</div>
    </div>
  );
}

export default function ClassProblemBank() {
  const navigate = useNavigate();
  const { studentSession, studentLogout } = useAuth();
  const { uuid, realName, classCode } = studentSession || {};

  const [problems, setProblems] = useState([]);
  const [statusMap, setStatusMap] = useState(/** @type {Map<string, { solve: object|null, peer: object|null }>} */ (new Map()));
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('unsolved'); // all | solved | unsolved | mine
  const [unitFilter, setUnitFilter] = useState('all'); // all | unitGoal string
  const [revertingId, setRevertingId] = useState('');
  const showDevReset = isDevClassProblemSolveResetEnabled();

  const load = useCallback(async () => {
    if (!classCode) return;
    setLoading(true);
    try {
      if (uuid) {
        await syncStudentProblemsToClassBank(uuid, classCode);
      }
      const [list, statuses] = await Promise.all([
        getClassProblems(classCode),
        uuid ? getStudentClassProblemStatuses(uuid, classCode) : Promise.resolve(new Map()),
      ]);
      setProblems(list);
      setStatusMap(statuses);

      if (uuid && list.length > 0) {
        retryOwnPendingClassProblemAiReviews(uuid, classCode, list)
          .then(() => {
            getClassProblems(classCode).then((refreshed) => {
              setProblems(refreshed);
            }).catch(() => {});
          })
          .catch(() => {});
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, [classCode, uuid]);

  useEffect(() => { load(); }, [load]);

  async function handleDevRevertFromList(e, problemId) {
    e.preventDefault();
    e.stopPropagation();
    if (
      !window.confirm(
        '[개발용] 이 문제의 풀이·동료평가 기록을 모두 지우고 처음부터 다시 풀 수 있게 할까요?',
      )
    ) {
      return;
    }
    setRevertingId(problemId);
    try {
      await devRevertStudentClassProblemProgress(uuid, classCode, problemId);
      await load();
    } catch (err) {
      console.warn('[dev revert from list]', err);
      alert(`기록 초기화 실패: ${err?.message || err}`);
    }
    setRevertingId('');
  }

  const unitOptions = React.useMemo(() => {
    const set = new Set();
    for (const p of problems) {
      const u = String(p.unitGoal || '').trim();
      if (u) set.add(u);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
  }, [problems]);

  const visibleProblems = React.useMemo(() => {
    const bySolve = (p) => Boolean(statusMap.get(p.id)?.solve);
    const list = (problems || []).filter((p) => {
      const solved = bySolve(p);
      const isMine = p.createdBy === uuid;
      // 분류 정책:
      // - 안 푼/푼: "친구가 만든 문제"만 대상으로 함
      // - 내가 만든 문제: 별도 탭에서만 표시
      // - 전체: 모두 표시
      if (statusFilter === 'mine' && !isMine) return false;
      if (statusFilter === 'solved' && (isMine || !solved)) return false;
      if (statusFilter === 'unsolved' && (isMine || solved)) return false;
      const u = String(p.unitGoal || '').trim();
      if (unitFilter !== 'all' && u !== unitFilter) return false;
      return true;
    });

    // 오름차순: 연도 → 날짜(라벨) → 당일 순번 → 등록시간
    return list.sort(compareClassProblemsByLabel);
  }, [problems, statusMap, statusFilter, unitFilter, uuid]);

  function TypeBadge({ isObjective }) {
    const Icon = isObjective ? ListChecks : SquarePen;
    return (
      <span className="cpb-card-type cpb-card-type--meta">
        <span className="cpb-card-type__inner">
          <Icon size={15} strokeWidth={2} aria-hidden="true" />
          {isObjective ? '객관식' : '주관식'}
        </span>
      </span>
    );
  }

  function MetaTag({ icon: Icon, variant, children }) {
    return (
      <span className={`cpb-card-tag cpb-card-tag--${variant}`}>
        <Icon size={15} strokeWidth={2} aria-hidden="true" />
        <span>{children}</span>
      </span>
    );
  }

  return (
    <div className="dashboard-container dashboard-container--brand-bg">
      <header className="dashboard-header">
        <div className="header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/student')}>
            ← 메인
          </button>
          <span style={{ fontSize: 26 }}>🏫</span>
          <div>
            <h1 className="header-title">학급 문제은행</h1>
            <p className="header-subtitle">친구가 만든 문제를 풀고, 어떤 전략인지 맞혀 봐요!</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge student-badge">학생</span>
          <span className="user-name">{realName}</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={studentLogout}>로그아웃</button>
        </div>
      </header>

      <main className="dashboard-main cpb-main">
        {loading ? (
          <div className="pmod-loading"><span className="spinner" /> 불러오는 중...</div>
        ) : problems.length === 0 ? (
          <div className="pmod-empty" style={{ padding: '48px 0' }}>
            <div style={{ fontSize: 48 }}>📭</div>
            <p>아직 학급에 등록된 문제가 없어요.</p>
            <p style={{ fontSize: 13, color: '#9ca3af' }}>문제 만들기에서 변형 문제를 제출하면 바로 여기에 올라와요.</p>
            <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => navigate('/problem-maker')}>
              문제 만들기
            </button>
          </div>
        ) : (
          <>
            <div className="cpb-filters">
              <div className="cpb-filter-group">
                <span className="cpb-filter-label">보기</span>
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === 'unsolved' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setStatusFilter('unsolved')}
                >
                  안 푼 문제
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === 'solved' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setStatusFilter('solved')}
                >
                  푼 문제
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === 'mine' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setStatusFilter('mine')}
                >
                  내가 만든 문제
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${statusFilter === 'all' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setStatusFilter('all')}
                >
                  전체
                </button>
              </div>

              <div className="cpb-filter-group">
                <span className="cpb-filter-label">단원</span>
                <select
                  className="cpb-filter-select"
                  value={unitFilter}
                  onChange={(e) => setUnitFilter(e.target.value)}
                >
                  <option value="all">전체 단원</option>
                  {unitOptions.map((u) => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>

            {visibleProblems.length === 0 ? (
              <div className="pmod-empty" style={{ padding: '48px 0' }}>
                <div style={{ fontSize: 44 }}>🔎</div>
                <p>선택한 조건에 해당하는 문제가 없어요.</p>
              </div>
            ) : (
              <div className="cpb-list">
                {visibleProblems.map((p) => {
              const progress = statusMap.get(p.id);
              const solved = progress?.solve;
              const evalDone = Boolean(progress?.peer);
              const isMine = p.createdBy === uuid;
              const showEvalBadge = statusFilter === 'solved' && Boolean(solved);
              const teacherConfirmed = isTeacherReviewConfirmed(p);
              const isObjective = Array.isArray(p.variantChoices) && p.variantChoices.length > 0;
              const hasStatusTags = isMine || teacherConfirmed;
              const hasMetaRow = Boolean(
                p.examGrade
                || p.unitGoal
                || hasStatusTags
                || showEvalBadge
                || (showDevReset && solved && p.createdBy !== uuid),
              );
              return (
              <button
                key={p.id}
                type="button"
                className="cpb-card"
                onClick={() => navigate(`/class-problems/${p.id}`)}
              >
                <TypeBadge isObjective={isObjective} />
                <div className="cpb-card-label">{p.label}</div>
                {hasMetaRow && (
                  <div className="cpb-card-meta">
                    {p.examGrade && <span>{p.examGrade}</span>}
                    {p.unitGoal && <span>{p.unitGoal}</span>}
                    {isMine && (
                      <MetaTag icon={Pencil} variant="mine">내가 만든 문제</MetaTag>
                    )}
                    {teacherConfirmed && (
                      <MetaTag icon={CheckCircle} variant="teacher-confirmed">선생님 확인 완료</MetaTag>
                    )}
                    {showEvalBadge && !evalDone && (
                      <span className="cpb-tag cpb-tag--eval-pending">평가 미완료</span>
                    )}
                    {showEvalBadge && evalDone && (
                      <span className="cpb-tag cpb-tag--done">평가 완료</span>
                    )}
                    {showDevReset && solved && p.createdBy !== uuid && (
                      <button
                        type="button"
                        className="cpb-dev-reset-inline"
                        disabled={revertingId === p.id}
                        onClick={(e) => handleDevRevertFromList(e, p.id)}
                        title="개발용: 풀이 기록 초기화"
                      >
                        {revertingId === p.id ? '초기화…' : '↩ 원상복귀'}
                      </button>
                    )}
                  </div>
                )}
                <ClassProblemCardPreview problem={p} />
              </button>
              );
              })}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
