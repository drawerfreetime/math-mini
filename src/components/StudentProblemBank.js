/**
 * StudentProblemBank.js — 내 변형 문제 저장소 (학생 전용, UUID만 저장)
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getStudentProblemBank, deleteStudentProblemBank } from '../firebase/firestoreOps';
import { getClassProblems } from '../firebase/classProblemBankOps';
import { hasStudentVisibleAiFeedback, getItemReviewStatus } from '../utils/studentAiFeedback';
import { getStatusLabel, SUBMISSION_STATUS_REJECTED } from '../constants/aiSubmissionPolicy';
import StudentAiFeedbackBox from './StudentAiFeedbackBox';
import { renderMathText } from './ExamOCR';

const CHOICE_LABELS = ['①', '②', '③', '④', '⑤', '⑥'];

function parseChoiceNums(answerStr) {
  return String(answerStr || '')
    .split(/[,，\s]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export default function StudentProblemBank() {
  const navigate = useNavigate();
  const { studentSession, studentLogout } = useAuth();
  const { uuid, realName, classCode } = studentSession || {};
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!uuid) return;
    setLoading(true);
    try {
      const list = await getStudentProblemBank(uuid);
      if (classCode) {
        const classProblems = await getClassProblems(classCode);
        const labelById = new Map(classProblems.map((p) => [p.id, p.label]));
        setItems(list.map((it) => {
          const fresh = it.classProblemId ? labelById.get(it.classProblemId) : null;
          return fresh ? { ...it, classProblemLabel: fresh } : it;
        }));
      } else {
        setItems(list);
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, [uuid, classCode]);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(id) {
    if (!window.confirm('이 문제를 저장소에서 삭제할까요?')) return;
    try {
      await deleteStudentProblemBank(uuid, id);
      await load();
    } catch (e) {
      alert('삭제 오류: ' + e.message);
    }
  }

  function renderChoicesRow(it) {
    if (!Array.isArray(it.choices) || it.choices.length === 0) return null;
    const correctNums = new Set(parseChoiceNums(it.answer));

    return (
      <div className="pbank-choices">
        <span className="pbank-label">선지</span>
        <div className="prob-choices">
          {it.choices.map((c, ci) => {
            const num = ci + 1;
            const isCorrect = correctNums.has(num);
            return (
              <div key={ci} className={`prob-choice${isCorrect ? ' pbank-choice--correct' : ''}`}>
                <span className="prob-choice-num">{CHOICE_LABELS[ci]}</span>
                <span className="prob-choice-text">{renderMathText(c)}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderAnswerRow(it) {
    const isMultipleChoice = Array.isArray(it.choices) && it.choices.length > 0;
    const ansRaw = String(it.answer ?? '').trim();
    const correctNums = isMultipleChoice ? parseChoiceNums(ansRaw) : [];

    if (!isMultipleChoice) {
      return (
        <div className="pbank-ans">
          <span className="pbank-label">내 정답</span>{' '}
          <strong>{renderMathText(ansRaw)}</strong>
        </div>
      );
    }

    return (
      <div className="pbank-ans">
        <span className="pbank-label">내 정답</span>{' '}
        {correctNums.length > 0 ? (
          <strong>
            {correctNums.map((n, i) => {
              const idx = n - 1;
              return (
                <span key={n}>
                  {i > 0 && ', '}
                  {CHOICE_LABELS[idx] || n}
                  <span style={{ marginLeft: 8, color: '#6b7280', fontWeight: 500 }}>
                    {renderMathText(it.choices?.[idx] || '')}
                  </span>
                </span>
              );
            })}
          </strong>
        ) : (
          <strong>{ansRaw || '(미입력)'}</strong>
        )}
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/student')}>← 메인</button>
          <span style={{ fontSize: 26 }}>📚</span>
          <div>
            <h1 className="header-title">문제 저장소</h1>
            <p className="header-subtitle">내가 만든 문제와 선생님 피드백이 여기에 남아요. 반려된 문제는 학급 문제 풀기에서만 숨겨집니다.</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge student-badge">학생</span>
          <span className="user-name">{realName}</span>
          <button className="btn btn-outline btn-sm" onClick={studentLogout}>로그아웃</button>
        </div>
      </header>

      <main className="dashboard-main" style={{ maxWidth: 720 }}>
        {loading ? (
          <div className="pmod-loading"><span className="spinner" /> 불러오는 중...</div>
        ) : items.length === 0 ? (
          <div className="pmod-empty" style={{ padding: '48px 0' }}>
            <div style={{ fontSize: 48 }}>📭</div>
            <p>저장된 변형 문제가 없어요.</p>
            <p style={{ fontSize: 13, color: '#9ca3af' }}>시험지 보기에서 변형 문제를 만들고 AI 검증을 통과하면 여기에 쌓여요.</p>
            <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={() => navigate('/student')}>메인으로</button>
          </div>
        ) : (
          <div className="pbank-list">
            {items.map((it) => (
              <div key={it.id} className="pbank-card">
                <div className="pbank-card-head">
                  <span className="pbank-meta">
                    {it.classProblemLabel && (
                      <strong style={{ marginRight: 8, color: '#4c1d95' }}>{it.classProblemLabel}</strong>
                    )}
                    {it.examGrade && `${it.examGrade} · `}{it.examTitle || '(시험)'}
                  </span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {it.examId && it.sourceNumber != null && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={() => navigate('/problem-modify', {
                          state: {
                            editFromBank: {
                              examId: it.examId,
                              sourceNumber: it.sourceNumber,
                              bankDocId: it.id,
                            },
                          },
                        })}
                      >
                        수정
                      </button>
                    )}
                    <button type="button" className="btn btn-ghost btn-xs" style={{ color: '#dc2626' }} onClick={() => handleDelete(it.id)}>
                      삭제
                    </button>
                  </div>
                </div>
                {it.savedAt && (
                  <div className="pbank-date">{String(it.savedAt).slice(0, 16).replace('T', ' ')}</div>
                )}
                <div className="pbank-q">
                  <strong>{it.sourceNumber != null ? `${it.sourceNumber}번 변형` : (it.examTitle || '직접 만든 문제')}</strong>
                  {getItemReviewStatus(it) === SUBMISSION_STATUS_REJECTED && (
                    <span style={{ marginLeft: 8, color: '#dc2626', fontWeight: 600, fontSize: 13 }}>
                      · {getStatusLabel(SUBMISSION_STATUS_REJECTED)}
                    </span>
                  )}
                  {it.variantStrategyName && (
                    <span style={{ marginLeft: 8, color: '#6b7280', fontWeight: 500 }}>
                      · {it.variantStrategyName}
                    </span>
                  )}
                </div>
                <div className="pbank-body">{renderMathText(it.question || '')}</div>
                {it.bogi && (
                  <div className="pbank-bogi">
                    <span className="pbank-label">보기</span>
                    {String(it.bogi).split('\n').map((l, i) => <p key={i}>{renderMathText(l)}</p>)}
                  </div>
                )}
                {renderChoicesRow(it)}
                {it.requiresSolution && it.solutionProcess && (
                  <div className="pbank-sol">
                    <span className="pbank-label">풀이</span>
                    <div className="pbank-text">{it.solutionProcess}</div>
                  </div>
                )}
                {renderAnswerRow(it)}
                {hasStudentVisibleAiFeedback(it) && (
                  <StudentAiFeedbackBox item={it} />
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
