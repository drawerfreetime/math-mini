/**
 * TeacherExamBank — 교사 문제 보관함 (시험지 OCR·단원평가 등으로 저장된 exams 목록)
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getExamsCreatedByTeacher, deleteTeacherExam } from '../firebase/firestoreOps';

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function sourceLabel(src) {
  if (src === 'pdf_extractor') return '시험지 OCR';
  if (src === 'unit-test-upload' || src === 'unit_test_upload' || src === 'unit_test') return '단원평가';
  return '기타·이전 저장';
}

export default function TeacherExamBank() {
  const { teacherUser } = useAuth();
  const navigate = useNavigate();

  const [exams, setExams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [removingId, setRemovingId] = useState(null);

  const load = useCallback(async () => {
    if (!teacherUser?.uid) {
      setLoading(false);
      setExams([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const list = await getExamsCreatedByTeacher(teacherUser.uid);
      setExams(list);
    } catch (e) {
      setError(e.message || '목록을 불러오지 못했습니다.');
      setExams([]);
    }
    setLoading(false);
  }, [teacherUser?.uid]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRemove(id, title) {
    if (
      !window.confirm(
        `「${title}」 시험을 삭제할까요?\nFirebase에 저장된 문항까지 모두 삭제되며 되돌릴 수 없습니다.`
      )
    ) {
      return;
    }
    setRemovingId(id);
    try {
      await deleteTeacherExam(id);
      setExams((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      alert('삭제 오류: ' + (e.message || String(e)));
    }
    setRemovingId(null);
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => navigate('/teacher')}>
            ← 대시보드
          </button>
          <span className="header-icon">📚</span>
          <div>
            <h1 className="header-title">문제 보관함</h1>
            <p className="header-subtitle">시험지 OCR·단원평가 등으로 저장한 시험 목록입니다.</p>
          </div>
        </div>
        <div className="header-right" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-sm" type="button" onClick={() => navigate('/pdf-extractor')}>
            📑 시험지 OCR
          </button>
        </div>
      </header>

      <main className="dashboard-main">
        {error && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {loading ? (
          <div className="loading-box">
            <div className="spinner-large" />
            <p>불러오는 중...</p>
          </div>
        ) : exams.length === 0 ? (
          <div className="empty-box">
            <span className="empty-icon">📂</span>
            <p>저장된 시험이 없습니다.</p>
            <p className="empty-sub">시험지 OCR에서 추출 후 Firebase에 저장하면 여기에 나타납니다.</p>
            <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 12 }}
              onClick={() => navigate('/pdf-extractor')}>
              시험지 OCR로 이동
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {exams.map((ex) => (
              <div
                key={ex.id}
                style={{
                  border: '1px solid #e2e8f0',
                  borderRadius: 14,
                  padding: '18px 20px',
                  background: '#fff',
                  boxShadow: '0 1px 3px rgba(0,0,0,.06)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 14,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 17, color: '#0f172a', marginBottom: 6 }}>
                    {ex.title || '(제목 없음)'}
                  </div>
                  <div style={{ fontSize: 13, color: '#64748b', display: 'flex', flexWrap: 'wrap', gap: '8px 16px' }}>
                    {ex.examGrade != null && ex.examGrade !== '' && (
                      <span><strong>학년</strong> {ex.examGrade}학년</span>
                    )}
                    <span><strong>문항</strong> {ex.questionCount ?? '—'}문제</span>
                    <span><strong>저장</strong> {fmtDate(ex.createdAt)}</span>
                    <span
                      style={{
                        background: '#eef2ff',
                        color: '#4338ca',
                        padding: '2px 8px',
                        borderRadius: 6,
                        fontSize: 12,
                      }}
                    >
                      {sourceLabel(ex.source)}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'stretch' }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => navigate(`/exam/${ex.id}`, { state: { backTo: '/exam-bank' } })}
                  >
                    열기
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{
                      whiteSpace: 'normal',
                      fontSize: 9,
                      lineHeight: 1.12,
                      fontWeight: 600,
                      padding: '6px 8px',
                      textAlign: 'center',
                      maxWidth: 100,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    title="문항별 전략 생략 추천을 분석합니다."
                    onClick={() =>
                      navigate(`/exam/${ex.id}?teacherAiGuide=1`, {
                        state: { backTo: '/exam-bank' },
                      })
                    }
                  >
                    문제 만들기
                    <br />
                    전략 AI추천
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => navigate(`/unit-test-review?edit=${encodeURIComponent(ex.id)}`)}
                  >
                    수정하기
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    style={{ color: '#dc2626', borderColor: '#fca5a5' }}
                    disabled={removingId === ex.id}
                    onClick={() => handleRemove(ex.id, ex.title || ex.id)}
                  >
                    {removingId === ex.id ? '삭제 중...' : '삭제'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
