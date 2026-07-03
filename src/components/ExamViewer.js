/**
 * ExamViewer — 저장된 시험지 번호 탭 뷰어
 * 교사: 읽기 전용 | 학생: 문제 변형하기 가능
 * 변형 저장 전 AI 검토 통과 시 → 시험지 variants + 학생 문제 저장소(problemBank) + 학급 문제은행 즉시 등록
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  doc, getDoc, collection, getDocs, setDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import { renderMathText, mathTextToPlainString, ProblemCard } from './ExamOCR';
import { problemNeedsSolutionFromDoc } from '../utils/problemMeta';
import { reviewStudentVariant } from '../utils/reviewStudentVariant';
import { resolveExamCurriculumForReview, resolveUnitGoalLabelForReview } from '../utils/examCurriculum';
import { SUBMISSION_STATUS_REGISTERED } from '../constants/aiSubmissionPolicy';
import StudentAiFeedbackBox from './StudentAiFeedbackBox';
import { registerClassProblem, updateClassProblemAiReview } from '../firebase/classProblemBankOps';
import { saveVariantReview } from '../firebase/firestoreOps';
import { anonymizeText, nameMapToObject } from '../utils/anonymizeText';
import { deriveCompletionLevelFromAiReview } from '../utils/deriveCompletionLevel';
import { MAKING_OUTCOME } from '../constants/problemMakingCompetency';
import { useAsyncLock } from '../hooks/useAsyncLock.js';
import {
  buildVariantProblemKey,
  buildMakingSubmissionPayload,
  buildMakingAiReviewPayload,
  ensureMakingProblemSession,
  logMakingSubmit,
} from '../firebase/makingEventsOps';
import { firebaseExamQuestionsToReviewProblems } from '../utils/examToReview';
import { expandExamQuestionDoc } from '../utils/examSolutionArea';

const CHOICE_ICONS = ['①', '②', '③', '④', '⑤', '⑥'];

export default function ExamViewer() {
  const { examId } = useParams();
  const navigate      = useNavigate();
  const location      = useLocation();
  const { teacherUser, studentSession, userType } = useAuth();
  const studentUid = studentSession?.uuid;

  const currentUser = useMemo(
    () => teacherUser || (studentUid ? { uid: studentUid } : null),
    [teacherUser, studentUid],
  );
  const isTeacher   = userType === 'teacher';

  const [exam, setExam]             = useState(null);
  const [problems, setProblems]     = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');

  const [variantText, setVariantText]     = useState('');
  const [variantBogi, setVariantBogi]     = useState('');
  const [variantSolution, setVariantSolution] = useState('');
  const [studentAnswer, setStudentAnswer]   = useState('');
  const [showVariantEditor, setShowVariantEditor] = useState(false);
  const { locked: variantSaving, acquire: acquireVariantSave, release: releaseVariantSave } = useAsyncLock();
  const [variantSaved, setVariantSaved]   = useState(false);
  const [savedVariants, setSavedVariants] = useState({});

  const [aiFeedback, setAiFeedback]     = useState(null);
  const [aiError, setAiError]           = useState('');

  const backPath  = location.state?.backTo ?? (isTeacher ? '/teacher' : '/student');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const examSnap = await getDoc(doc(db, 'exams', examId));
        if (!examSnap.exists()) {
          if (!cancelled) { setError('시험지를 찾을 수 없습니다.'); setLoading(false); }
          return;
        }
        const examData = { id: examSnap.id, ...examSnap.data() };
        if (cancelled) return;
        setExam(examData);

        const qSnap = await getDocs(collection(db, 'exams', examId, 'questions'));
        const rows = qSnap.docs.map((d) => expandExamQuestionDoc({ id: d.id, ...d.data() }));
        const probs = firebaseExamQuestionsToReviewProblems(rows);
        if (cancelled) return;
        setProblems(probs);

        const lookupUID = studentUid || currentUser?.uid;
        if (lookupUID) {
          try {
            const varSnap = await getDocs(
              collection(db, 'exams', examId, 'variants', lookupUID, 'questions')
            );
            const vars = {};
            varSnap.forEach((d) => { vars[d.data().number] = d.data(); });
            setSavedVariants(vars);
          } catch { /* ignore */ }
        }
      } catch (err) {
        setError('불러오기 오류: ' + err.message);
      }
      if (!cancelled) setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [examId, currentUser, studentUid]);

  function selectProblem(i) {
    setSelectedIdx(i);
    setShowVariantEditor(false);
    setVariantSaved(false);
    setAiFeedback(null);
    setAiError('');
  }

  function openVariantEditor() {
    const cur = problems[selectedIdx];
    const existing = savedVariants[cur.number];
    const qRaw = existing?.question ?? cur.question ?? '';
    const bRaw = existing?.bogi ?? cur.bogi ?? '';
    setVariantText(mathTextToPlainString(qRaw));
    setVariantBogi(mathTextToPlainString(bRaw));
    setVariantSolution(mathTextToPlainString(existing?.solutionProcess ?? ''));
    setStudentAnswer(
      existing?.studentAnswer != null && String(existing.studentAnswer).trim() !== ''
        ? String(existing.studentAnswer)
        : ''
    );
    setAiFeedback(null);
    setAiError('');
    setShowVariantEditor(true);
    setVariantSaved(false);
  }

  async function saveVariant() {
    if (variantSaving) return;
    const cur = problems[selectedIdx];
    const uuid = studentSession?.uuid;
    if (!uuid) {
      alert('학생 로그인 후 이용할 수 있습니다.');
      return;
    }
    const needsSol = problemNeedsSolutionFromDoc(cur);

    if (!variantText.trim()) {
      alert('문제 내용을 입력해 주세요.');
      return;
    }
    if (needsSol && !variantSolution.trim()) {
      alert('이 문항은 풀이 과정을 쓰도록 되어 있어요. 풀이 과정을 입력해 주세요.');
      return;
    }
    if (!String(studentAnswer ?? '').trim()) {
      alert('정답을 선택하거나 입력해 주세요.');
      return;
    }

    if (!acquireVariantSave()) return;
    setAiError('');
    setAiFeedback(null);

    try {
      const curriculum = resolveExamCurriculumForReview(exam);
      const originalQuestionPlain = mathTextToPlainString(cur.question || cur.text || '');
      const originalBogiPlain = mathTextToPlainString(cur.bogi || '');
      const originalChoicesPlain = (cur.choices || []).map((c) => mathTextToPlainString(String(c)));
      const review = await reviewStudentVariant({
        question: variantText.trim(),
        originalQuestion: originalQuestionPlain,
        bogi: variantBogi || null,
        choices: cur.choices || null,
        solutionProcess: variantSolution,
        answer: String(studentAnswer).trim(),
        requiresSolution: needsSol,
        examGrade: exam?.examGrade || '',
        grade: curriculum.grade,
        semester: curriculum.semester,
        unit: curriculum.unit,
      });

      if (!review.approved) {
        const classCode = studentSession?.classCode || '';
        const variantProblemKey = buildVariantProblemKey(examId, cur.number);
        const reviewId = `exam_${examId}_s${uuid}_q${cur.number}`;
        await ensureMakingProblemSession(uuid, variantProblemKey, {
          kind: 'variant',
          examId,
          questionNumber: cur.number,
          bankDocId: `exam_${examId}_q${cur.number}`,
          reviewId,
          classCode,
        }).catch((e) => console.warn('[makingProblems session]', e));
        await logMakingSubmit(uuid, variantProblemKey, MAKING_OUTCOME.AI_REJECT, {
          reviewId,
          examId,
          questionNumber: cur.number,
          classCode,
          submission: buildMakingSubmissionPayload({
            question: variantText.trim(),
            bogi: variantBogi || null,
            choices: cur.choices || null,
            solutionProcess: needsSol ? variantSolution.trim() : null,
            answer: String(studentAnswer).trim(),
            examId,
            questionNumber: cur.number,
          }),
          aiReview: buildMakingAiReviewPayload(review),
        }).catch((e) => console.warn('[makingEvents ai_reject]', e));
        setAiFeedback({
          approved: false,
          feedback: review.feedback,
          hints: review.hints || [],
          checks: review.checks || null,
        });
        return;
      }

      const classCode = studentSession?.classCode || '';
      const reviewId = `exam_${examId}_s${uuid}_q${cur.number}`;
      const bankDocId = `exam_${examId}_q${cur.number}`;
      const answerStr = String(studentAnswer).trim();
      const completionLevel = deriveCompletionLevelFromAiReview(review);

      const { anonymized: anonQuestion, nameMap } = anonymizeText(variantText.trim());
      const { anonymized: anonBogi } = variantBogi
        ? anonymizeText(variantBogi)
        : { anonymized: variantBogi };
      const { anonymized: anonSolution } = needsSol && variantSolution
        ? anonymizeText(variantSolution)
        : { anonymized: variantSolution };
      const nameMapObj = nameMapToObject(nameMap);

      let classProblemId = '';
      let classProblemLabel = '';

      if (classCode) {
        const curriculum = resolveExamCurriculumForReview(exam);
        const unitGoalLabel = resolveUnitGoalLabelForReview(exam, curriculum);
        const reg = await registerClassProblem({
          classCode,
          createdBy: uuid,
          reviewId,
          examId,
          examTitle: exam?.title || '',
          examGrade: exam?.examGrade || '',
          unitGoal: unitGoalLabel,
          curriculumGrade: curriculum.grade,
          curriculumSemester: curriculum.semester,
          curriculumUnit: curriculum.unit,
          sourceNumber: cur.number,
          originalQuestion: originalQuestionPlain,
          originalBogi: originalBogiPlain || null,
          originalChoices: originalChoicesPlain.length ? originalChoicesPlain : null,
          variantQuestion: variantText.trim(),
          variantBogi: variantBogi || null,
          variantChoices: cur.choices || null,
          variantAnswer: answerStr,
          variantSolutionProcess: needsSol ? (anonSolution || variantSolution.trim() || null) : null,
          variantStrategyId: '',
          variantStrategyName: '',
          tableData: cur.tableData || null,
          requiresSolution: needsSol,
        });
        classProblemId = reg.problemId;
        classProblemLabel = reg.label;
        await updateClassProblemAiReview(classCode, classProblemId, {
          ...review,
          completionLevel,
        });
      }

      const submissionStatus = SUBMISSION_STATUS_REGISTERED;

      await setDoc(
        doc(db, 'exams', examId, 'variants', uuid, 'questions', String(cur.number)),
        {
          number:           cur.number,
          question:       variantText.trim(),
          anonymizedQuestion: anonQuestion,
          bogi:           variantBogi || null,
          solutionProcess: needsSol ? variantSolution.trim() : null,
          studentAnswer: answerStr,
          tableData:      cur.tableData || null,
          svgCode:        cur.svgCode  || null,
          hasImage:       cur.hasImage || false,
          requiresSolution: needsSol,
          createdBy:      uuid,
          savedAt:        serverTimestamp(),
          status: submissionStatus,
          classProblemId,
          classProblemLabel,
          nameMap: nameMapObj,
        }
      );

      await setDoc(
        doc(db, 'students', uuid, 'problemBank', bankDocId),
        {
          examId,
          examTitle: exam?.title || '',
          examGrade: exam?.examGrade || '',
          sourceNumber: cur.number,
          question: variantText.trim(),
          bogi: variantBogi || null,
          choices: cur.choices || null,
          solutionProcess: needsSol ? variantSolution.trim() : null,
          answer: answerStr,
          requiresSolution: needsSol,
          aiNote: review.feedback || '',
          aiMode: review.aiMode || '',
          aiCompletionLevel: completionLevel,
          savedAt: new Date().toISOString(),
          status: submissionStatus,
          classProblemId,
          classProblemLabel,
          aiReviewStatus: 'done',
        }
      );

      await saveVariantReview({
        reviewId,
        bankDocId,
        examId,
        examTitle: exam?.title || '',
        examGrade: exam?.examGrade || '',
        studentUUID: uuid,
        classCode,
        questionNumber: cur.number,
        question: anonQuestion,
        bogi: anonBogi || null,
        choices: cur.choices || null,
        solutionProcess: anonSolution || null,
        answer: answerStr,
        nameMap: nameMapObj,
        status: submissionStatus,
        aiNote: review.feedback || '',
        aiMode: review.aiMode || '',
        aiApproved: !!review.approved,
        aiChecks: review.checks || null,
        aiReviewStatus: 'done',
        aiCompletionLevel: completionLevel,
        variantStrategyId: '',
        variantStrategyName: '',
        classProblemId,
        classProblemLabel,
      });

      setSavedVariants((prev) => ({
        ...prev,
        [cur.number]: {
          number: cur.number,
          question: variantText.trim(),
          bogi: variantBogi || null,
          solutionProcess: variantSolution,
          studentAnswer: String(studentAnswer).trim(),
        },
      }));
      setAiFeedback({
        approved: true,
        feedback: review.feedback || (classProblemLabel
          ? `학급 문제은행(${classProblemLabel})과 문제 저장소에 저장했어요!`
          : '문제 저장소에 저장했어요!'),
        hints: [],
        checks: review.checks || null,
      });
      setVariantSaved(true);
    } catch (err) {
      console.error(err);
      setAiError(err.message || '저장 중 오류가 났습니다.');
    } finally {
      releaseVariantSave();
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
          <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => navigate(backPath)}>돌아가기</button>
        </div>
      </div>
    );
  }

  const cur     = problems[selectedIdx];
  const curNumberForVariant = cur?.type === 'group' ? (cur.questions?.[0]?.number ?? null) : (cur?.number ?? null);
  const myVar   = curNumberForVariant != null ? savedVariants[curNumberForVariant] : null;
  const needSol = cur ? problemNeedsSolutionFromDoc(cur?.type === 'group' ? (cur.questions?.[0] || cur) : cur) : false;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(backPath)}>← 뒤로</button>
          <span style={{ fontSize: 22 }}>📋</span>
          <div>
            <h1 className="header-title">{exam?.title}</h1>
            <p className="header-subtitle">
              {exam?.examGrade && <span className="badge badge-blue" style={{ marginRight: 6 }}>{exam.examGrade}</span>}
              수학 · 총 {problems.length}문제
            </p>
          </div>
        </div>
        <div className="header-right">
          <span className={`user-badge ${isTeacher ? 'teacher-badge' : 'student-badge'}`}>
            {isTeacher ? '교사' : '학생'}
          </span>
        </div>
      </header>

      <main className="dashboard-main" style={{ maxWidth: 1340 }}>
        <div className="prob-num-tabs-row">
          <div className="prob-num-tabs-group">
            <div className="prob-num-tabs">
              {problems.map((p, i) => {
                const label = p.type === 'group' ? (p.label || '묶음') : p.number;
                const baseCls = `prob-num-tab ${selectedIdx === i ? 'prob-num-tab-active' : ''}`;
                return (
                  <button
                    key={p.type === 'group' ? `g-${p.label}` : p.number}
                    className={baseCls}
                    onClick={() => selectProblem(i)}
                    title={savedVariants[p.number] ? '내 변형 저장됨' : ''}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {cur && (
          <>
            {cur.type === 'group' ? (
              <div className="utr-group-card" style={{ marginTop: 0 }}>
                <div className="utr-group-header">
                  <div className="utr-group-header-left">
                    <span className="utr-group-badge">묶음</span>
                    <span style={{ fontWeight: 800 }}>{cur.label || '묶음'}</span>
                    <span className="utr-group-count">{(cur.questions || []).length}문항</span>
                  </div>
                </div>
                <div className="utr-group-body">
                  <div className="utr-group-passage">
                    <div className="utr-group-passage-label">[{cur.label || '보기'}]</div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{renderMathText(cur.passage || '')}</div>
                  </div>
                  {(() => {
                    const passageSrc =
                      cur.passageImage_b64 ||
                      (cur.questions || []).find((q) => q?.passageImage_b64)?.passageImage_b64 ||
                      cur.groupStackImage_b64 ||
                      (cur.questions || []).find((q) => q?.groupStackImage_b64)?.groupStackImage_b64 ||
                      null;
                    const hasAnyQImg = (cur.questions || []).some((q) => q.image_b64);
                    return (passageSrc || hasAnyQImg) ? (
                    <div style={{ display: 'grid', gridTemplateRows: 'repeat(3, minmax(0, 1fr))', gap: 8, marginTop: 10 }}>
                      {passageSrc && (
                        <img src={passageSrc} alt="" style={{ width: '100%', maxHeight: 260, objectFit: 'contain', borderRadius: 10, background: '#f8fafc' }} />
                      )}
                      {(cur.questions || []).map((q) => (
                        q.image_b64 ? (
                          <img key={q.number} src={q.image_b64} alt="" style={{ width: '100%', maxHeight: 260, objectFit: 'contain', borderRadius: 10, background: '#f8fafc' }} />
                        ) : null
                      ))}
                    </div>
                    ) : null;
                  })()}
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {(cur.questions || []).map((q, qi) => (
                      <ProblemCard key={q.number ?? qi} problem={q} idx={qi} editingIdx={null} editText="" readOnly />
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <ProblemCard problem={cur} idx={selectedIdx} editingIdx={null} editText="" readOnly />
            )}

            {cur.image_b64 && (
              <div
                style={{
                  marginBottom: 14,
                  padding: 12,
                  background: '#f8fafc',
                  borderRadius: 10,
                  border: '1px solid #e2e8f0',
                  textAlign: 'center',
                }}
              >
                <p style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>PDF 추출 도형·그림</p>
                <img
                  src={cur.image_b64}
                  alt=""
                  style={{ maxWidth: '100%', maxHeight: 280, borderRadius: 8 }}
                />
              </div>
            )}

            {!isTeacher && needSol && !showVariantEditor && (
              <div style={{
                fontSize: 13, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a',
                borderRadius: 8, padding: '8px 12px', marginBottom: 10,
              }}>
                📝 이 문항은 <strong>풀이 과정</strong>을 요구하는 유형으로 표시되어 있어요. 변형 시 풀이 칸이 열립니다.
              </div>
            )}

            {!isTeacher && myVar && !showVariantEditor && (
              <div className="variant-saved-banner">
                <span>✅ 이 문제에 대한 내 변형이 저장되어 있어요</span>
                <button className="btn btn-outline btn-xs" onClick={openVariantEditor}>수정하기</button>
              </div>
            )}

            {!isTeacher && !showVariantEditor && (
              <button className="btn btn-variant-open" onClick={openVariantEditor}>
                ✏️ 이 문제를 변형해서 내 문제 만들기
              </button>
            )}

            {!isTeacher && showVariantEditor && (
              <div className="variant-editor">
                <div className="variant-editor-header">
                  <span className="variant-editor-title">✏️ {cur.number}번 문제 변형하기</span>
                  <button className="btn btn-ghost btn-xs" onClick={() => setShowVariantEditor(false)}>닫기</button>
                </div>

                <div className="variant-editor-tip">
                  💡 문제를 바꾼 뒤, 풀이(필요 시)와 정답을 입력하고 저장하면 AI가 검토한 뒤 문제 저장소에 들어갑니다.
                </div>

                <label className="form-label" style={{ marginTop: 12 }}>문제 내용</label>
                <textarea
                  className="form-input variant-textarea"
                  value={variantText}
                  onChange={(e) => setVariantText(e.target.value)}
                  rows={5}
                  placeholder="문제 내용을 자유롭게 수정하세요"
                />

                {cur.bogi != null && (
                  <>
                    <label className="form-label" style={{ marginTop: 10 }}>보기 내용 (선택)</label>
                    <textarea
                      className="form-input variant-textarea"
                      value={variantBogi}
                      onChange={(e) => setVariantBogi(e.target.value)}
                      rows={3}
                      placeholder="보기 내용을 수정하세요 (없애려면 지우기)"
                    />
                  </>
                )}

                {needSol && (
                  <>
                    <label className="form-label" style={{ marginTop: 10 }}>
                      풀이 과정 <span style={{ color: '#b45309' }}>(필수)</span>
                    </label>
                    <textarea
                      className="form-input variant-textarea"
                      value={variantSolution}
                      onChange={(e) => setVariantSolution(e.target.value)}
                      rows={5}
                      placeholder="풀이 과정을 단계별로 적어 보세요."
                    />
                  </>
                )}

                <label className="form-label" style={{ marginTop: 12 }}>정답</label>
                {cur.choices && cur.choices.length > 0 ? (
                  <div className="utr-answer-choices" style={{ flexWrap: 'wrap' }}>
                    {cur.choices.map((_, ci) => (
                      <button
                        key={ci}
                        type="button"
                        className={`utr-answer-btn ${String(studentAnswer) === String(ci + 1) ? 'selected' : ''}`}
                        onClick={() => setStudentAnswer(String(ci + 1))}
                      >
                        {CHOICE_ICONS[ci] || ci + 1}
                      </button>
                    ))}
                  </div>
                ) : (
                  <input
                    className="form-input"
                    value={studentAnswer}
                    onChange={(e) => setStudentAnswer(e.target.value)}
                    placeholder="정답을 입력하세요"
                  />
                )}

                {aiError && (
                  <div className="alert alert-error" style={{ marginTop: 12 }}>⚠️ {aiError}</div>
                )}

                {aiFeedback && !aiFeedback.approved && (
                  <div style={{ marginTop: 12 }}>
                    <StudentAiFeedbackBox
                      item={{
                        aiNote: aiFeedback.feedback,
                        aiApproved: false,
                        aiChecks: aiFeedback.checks,
                        aiReviewStatus: 'done',
                      }}
                      hints={aiFeedback.hints}
                    />
                  </div>
                )}

                {aiFeedback && aiFeedback.approved && variantSaved && (
                  <div style={{ marginTop: 12 }}>
                    <StudentAiFeedbackBox
                      item={{
                        aiNote: aiFeedback.feedback,
                        aiApproved: true,
                        aiChecks: aiFeedback.checks,
                        aiReviewStatus: 'done',
                      }}
                    />
                    <p style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>문제 저장소에서 언제든 볼 수 있어요.</p>
                  </div>
                )}

                <div className="variant-editor-actions">
                  {variantSaved && <span className="variant-saved-msg">💾 저장 완료!</span>}
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowVariantEditor(false)}>취소</button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={saveVariant}
                    disabled={variantSaving || !variantText.trim()}
                  >
                    {variantSaving ? <><span className="spinner" /> AI 검토 중...</> : '🔍 AI 검토 후 문제 저장소에 저장'}
                  </button>
                </div>

                {variantText && (
                  <div className="variant-preview">
                    <div className="variant-preview-label">미리보기</div>
                    <div className="prob-card" style={{ marginBottom: 0 }}>
                      <div className="prob-text-row">
                        <span className="prob-num-badge">{cur.number}</span>
                        <p className="prob-question">{renderMathText(variantText)}</p>
                      </div>
                      {variantBogi && (
                        <div className="bogi-box" style={{ marginTop: 10 }}>
                          <div className="bogi-title">〈 보 기 〉</div>
                          <div className="bogi-content">
                            {variantBogi.split('\n').map((l, i) => <p key={i}>{renderMathText(l)}</p>)}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

    </div>
  );
}
