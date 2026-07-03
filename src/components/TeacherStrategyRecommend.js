/**
 * TeacherStrategyRecommend — 교사용 문제 만들기 전략 AI추천 (생략 분류만)
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  doc, getDoc, getDocs, collection, setDoc, updateDoc,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import { renderMathText } from './ExamOCR';
import { ProblemCard } from './ExamOCR';
import { VARIANT_STRATEGIES } from '../constants/variantStrategies';
import { firebaseExamQuestionsToReviewProblems } from '../utils/examToReview';
import { expandExamQuestionDoc } from '../utils/examSolutionArea';
import {
  fetchStrategyApplicability,
  shouldRecommendStrategySkip,
} from '../utils/assessStrategyApplicability';
import {
  getTeacherGuideDocIdsForProblem,
  getStrategyRecommendInputsForIdx,
} from '../utils/teacherStrategyRecommendInputs';
import {
  getVariantHideNumbersForProblem,
  isProblemHiddenFromVariantList,
  normalizeVariantHiddenQuestionNumbers,
} from '../utils/variantHiddenQuestions';
import './TeacherStrategyRecommend.css';

const TAB_PAGE_SIZE = 20;

function cleanSkippedMap(skippedMap) {
  return VARIANT_STRATEGIES.reduce((acc, s) => {
    if (skippedMap?.[s.id]) acc[s.id] = true;
    return acc;
  }, {});
}

function countSkipRecommendations(applicabilityMap) {
  if (!applicabilityMap) return 0;
  return VARIANT_STRATEGIES.filter((s) => {
    const level = applicabilityMap[s.id]?.level;
    return shouldRecommendStrategySkip(level);
  }).length;
}

export default function TeacherStrategyRecommend({ examId, backPath = '/teacher' }) {
  const navigate = useNavigate();
  const { teacherUser } = useAuth();

  const [exam, setExam] = useState(null);
  const [problems, setProblems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [tabPage, setTabPage] = useState(0);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisStarted, setAnalysisStarted] = useState(false);
  const [showOnlyWithRecs, setShowOnlyWithRecs] = useState(true);

  const [skippedByIdx, setSkippedByIdx] = useState({});
  const [applicabilityByIdx, setApplicabilityByIdx] = useState({});
  const [applicabilityMcqNoteByIdx, setApplicabilityMcqNoteByIdx] = useState({});
  const [variantHiddenQuestionNumbers, setVariantHiddenQuestionNumbers] = useState([]);
  const [variantHideSaving, setVariantHideSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const examSnap = await getDoc(doc(db, 'exams', examId));
        if (!examSnap.exists()) {
          if (!cancelled) {
            setError('시험지를 찾을 수 없습니다.');
            setLoading(false);
          }
          return;
        }
        const examData = { id: examSnap.id, ...examSnap.data() };
        const qSnap = await getDocs(collection(db, 'exams', examId, 'questions'));
        const rows = qSnap.docs.map((d) => expandExamQuestionDoc({ id: d.id, ...d.data() }));
        const probs = firebaseExamQuestionsToReviewProblems(rows);

        const guideSnap = await getDocs(collection(db, 'exams', examId, 'teacherAiGuides'));
        const skippedDocs = {};
        guideSnap.forEach((d) => {
          const data = d.data();
          skippedDocs[d.id] = data.draftGuideSkippedByStrategyId
            || data.publishedGuideSkippedByStrategyId
            || {};
        });
        const savedSkippedByIdx = {};
        probs.forEach((p, idx) => {
          const docIds = getTeacherGuideDocIdsForProblem(p);
          const saved = docIds
            .map((id) => skippedDocs[String(id)])
            .find((g) => g && Object.keys(g).length > 0);
          if (saved) savedSkippedByIdx[idx] = saved;
        });

        if (!cancelled) {
          setExam(examData);
          setProblems(probs);
          setVariantHiddenQuestionNumbers(
            normalizeVariantHiddenQuestionNumbers(examData.variantHiddenQuestionNumbers),
          );
          setSkippedByIdx(savedSkippedByIdx);
          if (Object.keys(savedSkippedByIdx).length > 0) {
            setAnalysisStarted(true);
            setStatus('저장된 생략 설정을 불러왔습니다.');
          }
        }
      } catch (e) {
        if (!cancelled) setError(e.message || '불러오기 오류');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [examId]);

  useEffect(() => {
    const next = Math.floor((selectedIdx || 0) / TAB_PAGE_SIZE);
    setTabPage((prev) => {
      const maxPage = Math.max(0, Math.ceil((problems?.length || 0) / TAB_PAGE_SIZE) - 1);
      return Math.max(0, Math.min(next, maxPage));
    });
  }, [selectedIdx, problems?.length]);

  const recCountByIdx = useMemo(() => {
    const out = {};
    problems.forEach((_, idx) => {
      out[idx] = countSkipRecommendations(applicabilityByIdx[idx]);
    });
    return out;
  }, [problems, applicabilityByIdx]);

  const visibleTabIndices = useMemo(() => {
    const all = problems.map((_, i) => i);
    if (!analysisStarted || !showOnlyWithRecs) return all;
    const withRecs = all.filter((i) => (recCountByIdx[i] || 0) > 0);
    return withRecs.length > 0 ? withRecs : all;
  }, [problems, analysisStarted, showOnlyWithRecs, recCountByIdx]);

  const runBatchAnalysis = useCallback(async () => {
    if (!problems.length || analyzing) return;
    setAnalyzing(true);
    setAnalysisStarted(true);
    setStatus('전략 AI추천 분석 중…');
    const nextApplicability = { ...applicabilityByIdx };
    const nextMcqNotes = { ...applicabilityMcqNoteByIdx };
    const nextSkipped = { ...skippedByIdx };

    for (let idx = 0; idx < problems.length; idx++) {
      const inputs = getStrategyRecommendInputsForIdx(problems, idx, exam);
      if (!inputs?.questionPlain) continue;
      try {
        const result = await fetchStrategyApplicability({
          questionPlain: inputs.questionPlain,
          bogi: inputs.bogi,
          choices: inputs.choices,
          questionNumber: inputs.questionNumber,
          unitLabel: inputs.unitLabel,
        });
        const byStrategy = result.byStrategy || {};
        nextApplicability[idx] = byStrategy;
        if (result.mcqNote) nextMcqNotes[idx] = result.mcqNote;

        const autoSkip = { ...(nextSkipped[idx] || {}) };
        VARIANT_STRATEGIES.forEach((s) => {
          if (shouldRecommendStrategySkip(byStrategy[s.id]?.level)) {
            autoSkip[s.id] = true;
          }
        });
        if (Object.keys(autoSkip).length > 0) nextSkipped[idx] = autoSkip;
      } catch (err) {
        console.warn('[strategy-applicability]', idx, err);
      }
    }

    setApplicabilityByIdx(nextApplicability);
    setApplicabilityMcqNoteByIdx(nextMcqNotes);
    setSkippedByIdx(nextSkipped);
    setAnalyzing(false);
    const totalRecs = Object.values(nextApplicability).reduce(
      (n, m) => n + countSkipRecommendations(m),
      0,
    );
    setStatus(
      totalRecs > 0
        ? `분석 완료 — 생략 추천이 있는 문항·전략을 확인하고 저장하세요.`
        : '분석 완료 — 생략 추천이 거의 없습니다. 필요하면 직접 생략을 조정하세요.',
    );
  }, [problems, exam, analyzing, applicabilityByIdx, applicabilityMcqNoteByIdx, skippedByIdx]);

  function toggleStrategySkip(idx, strategyId) {
    setSkippedByIdx((prev) => {
      const row = { ...(prev[idx] || {}) };
      if (row[strategyId]) delete row[strategyId];
      else row[strategyId] = true;
      const next = { ...prev };
      if (Object.keys(row).length > 0) next[idx] = row;
      else delete next[idx];
      return next;
    });
  }

  async function saveRecommendations({ publish = false } = {}) {
    if (!teacherUser?.uid) {
      alert('교사 로그인 후 이용할 수 있습니다.');
      return;
    }
    const rows = [];
    problems.forEach((p, idx) => {
      const skippedByStrategyId = cleanSkippedMap(skippedByIdx[idx]);
      if (Object.keys(skippedByStrategyId).length === 0) return;
      getTeacherGuideDocIdsForProblem(p).forEach((docId) => {
        rows.push({
          docId: String(docId),
          questionNumber: Number.isFinite(Number(docId)) ? Number(docId) : null,
          skippedByStrategyId,
        });
      });
    });

    if (rows.length === 0) {
      alert('저장할 생략 설정이 없습니다. 분석 후 생략할 전략을 선택하거나 분석 결과를 확인하세요.');
      return;
    }

    setSaving(true);
    setStatus('');
    const now = new Date().toISOString();
    try {
      await Promise.all(rows.map((row) => {
        const payload = {
          examId,
          questionNumber: row.questionNumber,
          draftGuideSkippedByStrategyId: row.skippedByStrategyId,
          updatedAt: now,
          updatedBy: teacherUser.uid,
        };
        if (publish) {
          payload.published = true;
          payload.publishedGuideSkippedByStrategyId = row.skippedByStrategyId;
          payload.publishedAt = now;
          payload.publishedBy = teacherUser.uid;
        }
        return setDoc(
          doc(db, 'exams', examId, 'teacherAiGuides', row.docId),
          payload,
          { merge: true },
        );
      }));
      setStatus(
        publish
          ? '학생에게 전송했습니다. 생략된 전략은 학생 화면에서 선택할 수 없습니다.'
          : '저장했습니다. 아직 학생에게는 반영되지 않습니다.',
      );
    } catch (e) {
      console.error(e);
      setStatus(e.message || '저장 중 오류가 났습니다.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleVariantListVisibility() {
    const problem = problems[selectedIdx];
    if (!examId || !problem || variantHideSaving) return;
    const nums = getVariantHideNumbersForProblem(problem);
    if (!nums.length) return;

    const set = new Set(variantHiddenQuestionNumbers);
    const allHidden = nums.every((n) => set.has(n));
    if (allHidden) nums.forEach((n) => set.delete(n));
    else nums.forEach((n) => set.add(n));
    const next = [...set].sort((a, b) => a - b);

    setVariantHideSaving(true);
    try {
      await updateDoc(doc(db, 'exams', examId), { variantHiddenQuestionNumbers: next });
      setVariantHiddenQuestionNumbers(next);
      setExam((prev) => (prev ? { ...prev, variantHiddenQuestionNumbers: next } : prev));
      if (!allHidden) {
        const allSkip = VARIANT_STRATEGIES.reduce((acc, s) => {
          acc[s.id] = true;
          return acc;
        }, {});
        setSkippedByIdx((prev) => ({ ...prev, [selectedIdx]: allSkip }));
      }
      setStatus(
        allHidden ? '변형 목록에 다시 표시했습니다.' : '변형 목록에서 숨겼습니다. 6개 전략을 모두 생략했습니다.',
      );
    } catch (e) {
      setStatus(e.message || '저장 실패');
    } finally {
      setVariantHideSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="ocr-processing-container">
        <div className="ocr-processing-card">
          <div className="ocr-processing-icon">📚</div>
          <p className="ocr-processing-msg">시험지를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ocr-processing-container">
        <div className="ocr-processing-card">
          <div className="ocr-processing-icon">⚠️</div>
          <p className="ocr-processing-msg">{error}</p>
          <button type="button" className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => navigate(backPath)}>
            돌아가기
          </button>
        </div>
      </div>
    );
  }

  const cur = problems[selectedIdx];
  const skippedMap = skippedByIdx[selectedIdx] || {};
  const needsPaging = problems.length > TAB_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(problems.length / TAB_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(tabPage, pageCount - 1));
  const start = needsPaging ? safePage * TAB_PAGE_SIZE : 0;
  const end = needsPaging ? Math.min(problems.length, start + TAB_PAGE_SIZE) : problems.length;
  const pageProblems = problems.slice(start, end);

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(backPath)}>← 뒤로</button>
          <span style={{ fontSize: 22 }}>📋</span>
          <div>
            <h1 className="header-title">{exam?.title}</h1>
            <p className="header-subtitle">문제 만들기 전략 AI추천</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge teacher-badge">교사</span>
        </div>
      </header>

      <main className="dashboard-main tsr-main">
        <div className="tsr-control-card">
          <div>
            <h2 className="tsr-control-title">문제 만들기 전략 AI추천</h2>
            <p className="tsr-control-desc">
              AI가 문항마다 어울리지 않는 전략만 «생략»으로 추천합니다. 멘트 생성은 하지 않습니다.
              분석 후 생략을 조정하고 «학생에게 전송»하면 학생 문제 만들기 화면에 반영됩니다.
            </p>
            {status && <p className="tsr-status">{status}</p>}
          </div>
          <div className="tsr-control-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={runBatchAnalysis}
              disabled={analyzing || !problems.length}
            >
              {analyzing ? <><span className="spinner" /> 분석 중…</> : '▶ 전략 AI추천 분석'}
            </button>
            {analysisStarted && (
              <label className="tsr-filter-toggle">
                <input
                  type="checkbox"
                  checked={showOnlyWithRecs}
                  onChange={(e) => setShowOnlyWithRecs(e.target.checked)}
                />
                생략 추천 있는 문항만 보기
              </label>
            )}
          </div>
        </div>

        <div className="prob-num-tabs-row">
          <div className="prob-num-tabs-group">
            <div className="prob-num-tabs">
              {pageProblems.map((p, localIdx) => {
                const i = start + localIdx;
                if (!visibleTabIndices.includes(i)) return null;
                const label = p.type === 'group' ? (p.label || '묶음') : p.number;
                const recN = recCountByIdx[i] || 0;
                const hasRec = analysisStarted && recN > 0;
                const cls = [
                  'prob-num-tab',
                  selectedIdx === i ? 'prob-num-tab-active' : '',
                  hasRec ? 'prob-num-tab--rec' : '',
                ].filter(Boolean).join(' ');
                return (
                  <button
                    key={p.type === 'group' ? `g-${p.label}` : p.number}
                    type="button"
                    className={cls}
                    onClick={() => setSelectedIdx(i)}
                    title={hasRec ? `생략 추천 ${recN}개` : '추천 없음'}
                  >
                    {label}
                    {analysisStarted && (
                      <span className="tsr-tab-badge">
                        {hasRec ? `생략 ${recN}` : '—'}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {needsPaging && (
              <div className="prob-num-tabs-pager" aria-label="문항 페이지">
                <button type="button" className="prob-num-nav" onClick={() => setTabPage((p) => Math.max(0, p - 1))} disabled={safePage <= 0}>‹</button>
                <div className="prob-num-page-indicator">{safePage * TAB_PAGE_SIZE + 1}-{end} / {problems.length}</div>
                <button type="button" className="prob-num-nav" onClick={() => setTabPage((p) => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1}>›</button>
              </div>
            )}
          </div>
          <div className="teacher-guide-actions">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => saveRecommendations({ publish: false })} disabled={saving}>
              {saving ? '저장 중…' : '저장'}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => saveRecommendations({ publish: true })} disabled={saving}>
              학생에게 전송
            </button>
          </div>
        </div>

        {cur && (
          <div className="tsr-body-grid">
            <div className="tsr-image-panel">
              <div className="tsr-panel-label">원본 문항 이미지</div>
              {cur.type === 'group' ? (
                <div className="tsr-image-stack">
                  {(cur.questions || []).map((q) => (
                    q.image_b64 ? (
                      <img key={q.number} src={q.image_b64} alt="" className="tsr-q-image" />
                    ) : null
                  ))}
                </div>
              ) : cur.image_b64 ? (
                <img src={cur.image_b64} alt="" className="tsr-q-image tsr-q-image--solo" />
              ) : (
                <p className="tsr-muted">저장된 원본 이미지가 없습니다.</p>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm tsr-hide-btn"
                onClick={toggleVariantListVisibility}
                disabled={variantHideSaving}
              >
                {isProblemHiddenFromVariantList(cur, variantHiddenQuestionNumbers)
                  ? '변형 목록에 다시 표시'
                  : '변형 목록에서 숨기기'}
              </button>
            </div>

            <div className="tsr-strategy-panel">
              {applicabilityMcqNoteByIdx[selectedIdx] && (
                <div className="tsr-mcq-note">{applicabilityMcqNoteByIdx[selectedIdx]}</div>
              )}
              <div className="tsr-strategy-grid">
                {VARIANT_STRATEGIES.map((s) => {
                  const isSkipped = !!skippedMap[s.id];
                  const applicability = applicabilityByIdx[selectedIdx]?.[s.id];
                  const skipRecommended = shouldRecommendStrategySkip(applicability?.level);
                  return (
                    <div
                      key={s.id}
                      className={`tsr-strategy-card ${isSkipped ? 'tsr-strategy-card--skipped' : ''} ${skipRecommended && !isSkipped ? 'tsr-strategy-card--rec' : ''}`}
                    >
                      <div className="tsr-strategy-head">
                        <strong>{s.title}</strong>
                        {skipRecommended && !isSkipped && (
                          <span className="tsr-rec-tag">생략 추천</span>
                        )}
                        {isSkipped && <span className="tsr-skip-tag">생략</span>}
                      </div>
                      <p className="tsr-strategy-blurb">{s.blurb}</p>
                      {skipRecommended && applicability?.message && (
                        <p className="tsr-rec-reason">{applicability.message}</p>
                      )}
                      <button
                        type="button"
                        className={`btn btn-sm ${isSkipped ? 'btn-outline' : 'btn-secondary'}`}
                        onClick={() => toggleStrategySkip(selectedIdx, s.id)}
                      >
                        {isSkipped ? '생략 취소' : '생략하기'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {cur && (
          <details className="tsr-ocr-preview">
            <summary>인식된 문항 텍스트 보기</summary>
            <div className="tsr-ocr-preview-body">
              {cur.type === 'group' ? (
                <div>
                  <div style={{ marginBottom: 8 }}>{renderMathText(cur.passage || '')}</div>
                  {(cur.questions || []).map((q, qi) => (
                    <ProblemCard key={q.number ?? qi} problem={q} idx={qi} editingIdx={null} editText="" readOnly />
                  ))}
                </div>
              ) : (
                <ProblemCard problem={cur} idx={selectedIdx} editingIdx={null} editText="" readOnly />
              )}
            </div>
          </details>
        )}
      </main>
    </div>
  );
}
