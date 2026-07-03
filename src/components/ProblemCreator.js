/**
 * 새로운 문제 만들기 (학생) — 수식 인라인 에디터 + 문제 저장소 저장
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import { mathTextToPlainString } from './ExamOCR';
import { textContainsBarGraph } from '../utils/barGraphStorage';
import InlineMathEditor from './InlineMathEditor';
import { SUBMISSION_STATUS_PENDING_REVIEW, SUBMISSION_STATUS_REGISTERED } from '../constants/aiSubmissionPolicy';
import { CURRICULUM, GRADES, SEMESTERS } from '../constants/curriculum';
import { buildUnitKey, getUnitLabel } from '../constants/unitProgress';
import {
  buildNewProblemKey,
  ensureMakingProblemSession,
  logMakingSubmit,
} from '../firebase/makingEventsOps';
import { MAKING_OUTCOME } from '../constants/problemMakingCompetency';
import { useAsyncLock } from '../hooks/useAsyncLock.js';
import { saveVariantReview, getTeacherGeminiKeyForClass } from '../firebase/firestoreOps';
import { buildVariantReviewId } from '../utils/variantBankIds';
import { anonymizeText } from '../utils/anonymizeText';
import { runBackgroundVariantAiReview } from '../utils/backgroundVariantAiReview';
import { registerClassProblem } from '../firebase/classProblemBankOps';

export default function ProblemCreator() {
  const navigate = useNavigate();
  const { studentSession, studentLogout } = useAuth();
  const uuid = studentSession?.uuid;
  const classCode = studentSession?.classCode || '';
  const { realName } = studentSession || {};

  const [currGrade, setCurrGrade] = useState('');
  const [currSemester, setCurrSemester] = useState('');
  const [currUnitIdx, setCurrUnitIdx] = useState(-1);
  const [gradePickerOpen, setGradePickerOpen] = useState(true);
  const [semesterPickerOpen, setSemesterPickerOpen] = useState(true);
  const [unitPickerOpen, setUnitPickerOpen] = useState(true);

  const [title, setTitle] = useState('');
  const [question, setQuestion] = useState('');
  const [solution, setSolution] = useState('');
  const [answer, setAnswer] = useState('');
  const { locked: saving, withLock: withSaveLock } = useAsyncLock();
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const editorStartRef = useRef(null);

  const unitList = useMemo(() => {
    if (!currGrade || !currSemester) return [];
    return CURRICULUM[currGrade]?.[currSemester] || [];
  }, [currGrade, currSemester]);

  const pickedUnit = useMemo(() => {
    if (!Array.isArray(unitList)) return '';
    if (currUnitIdx < 0 || currUnitIdx >= unitList.length) return '';
    return unitList[currUnitIdx] || '';
  }, [currUnitIdx, unitList]);

  const selectionComplete = Boolean(currGrade && currSemester && pickedUnit);

  useEffect(() => {
    if (!selectionComplete) return;
    // 선택 완료 후 아래 입력 영역으로 자연스럽게 이동
    editorStartRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [selectionComplete]);

  useEffect(() => {
    // 선택 값이 있으면 기본적으로 접힌 상태로 시작
    if (currGrade) setGradePickerOpen(false);
    if (currSemester) setSemesterPickerOpen(false);
    if (pickedUnit) setUnitPickerOpen(false);
  }, []);

  async function handleSave() {
    if (saving) return;
    setErr('');
    if (!uuid) {
      alert('학생 로그인 후 이용할 수 있습니다.');
      return;
    }
    const unitKey = buildUnitKey(currGrade, currSemester, pickedUnit);
    if (!unitKey) {
      alert('저장하기 전에 학년·학기·단원을 먼저 선택해 주세요.');
      return;
    }
    if (!mathTextToPlainString(question).trim() && !textContainsBarGraph(question)) {
      alert('문제 내용을 입력해 주세요.');
      return;
    }
    if (!mathTextToPlainString(solution).trim()) {
      alert('풀이 과정을 입력해 주세요.');
      return;
    }
    if (!mathTextToPlainString(answer).trim()) {
      alert('정답을 입력해 주세요.');
      return;
    }

    await withSaveLock(async () => {
      try {
        const id = `new_${Date.now()}`;
        const problemKey = buildNewProblemKey(id);
        const reviewId = buildVariantReviewId(uuid, id);
        const unitKey = buildUnitKey(currGrade, currSemester, pickedUnit);
        const unitLabel = unitKey ? getUnitLabel(unitKey) : '';

        await ensureMakingProblemSession(uuid, problemKey, {
          kind: 'new',
          bankDocId: id,
          classCode,
          unitKey,
        });

        const unitGoalLabel = pickedUnit.replace(/^\d+\.\s*/, '').trim() || pickedUnit;
        const curriculumUnitNum = String(currUnitIdx + 1);

        const { anonymized: anonQuestion } = anonymizeText(question.trim());
        const { anonymized: anonSolution } = anonymizeText(solution.trim());

        const teacherGeminiKey = classCode
          ? await getTeacherGeminiKeyForClass(classCode).catch(() => '')
          : '';

        await setDoc(doc(db, 'students', uuid, 'problemBank', id), {
          examId: null,
          examTitle: title.trim() || '(직접 만든 문제)',
          examGrade: currGrade,
          sourceNumber: null,
          source: 'new_problem',
          question: question.trim(),
          bogi: null,
          choices: null,
          solutionProcess: solution.trim() || null,
          answer: answer.trim(),
          requiresSolution: true,
          createdBy: uuid,
          savedAt: new Date().toISOString(),
          status: SUBMISSION_STATUS_PENDING_REVIEW,
          makingProblemKey: problemKey,
          unitKey,
          unitLabel,
          curriculumGrade: currGrade,
          curriculumSemester: currSemester,
          curriculumUnit: pickedUnit || '',
          aiReviewStatus: 'pending',
          aiNote: '',
          aiMode: 'new_problem',
          aiApproved: null,
          aiChecks: null,
          // 교사 검수 대시보드(variantReviews) 연결용
          reviewId,
        });

        // 교사 대시보드의 "변형 문제 검수"는 variantReviews 컬렉션을 본다.
        // 새 문제도 동일 파이프라인으로 검수할 수 있게 variantReviews 문서를 함께 생성한다.
        await saveVariantReview({
          reviewId,
          bankDocId: id,
          examId: null,
          examTitle: title.trim() || '(직접 만든 문제)',
          examGrade: currGrade,
          studentUUID: uuid,
          classCode,
          questionNumber: null,
          question: anonQuestion,
          bogi: null,
          choices: null,
          solutionProcess: anonSolution || null,
          answer: answer.trim(),
          nameMap: {},
          status: SUBMISSION_STATUS_PENDING_REVIEW,
          aiApproved: null,
          aiChecks: null,
          aiNote: '',
          aiReviewStatus: 'pending',
          aiMode: 'new_problem',
          kind: 'new',
          source: 'new_problem',
          createdBy: uuid,
          unitKey,
          curriculumGrade: currGrade,
          curriculumSemester: currSemester,
          curriculumUnit: pickedUnit || '',
          unitGoal: unitGoalLabel,
        });

        let classProblemId = '';
        let classProblemLabel = '';
        if (classCode) {
          const reg = await registerClassProblem({
            classCode,
            createdBy: uuid,
            reviewId,
            examId: null,
            examTitle: title.trim() || '(직접 만든 문제)',
            examGrade: currGrade,
            unitGoal: unitGoalLabel,
            curriculumGrade: currGrade,
            curriculumSemester: currSemester,
            curriculumUnit: pickedUnit || '',
            sourceNumber: null,
            originalQuestion: '',
            originalBogi: null,
            originalChoices: null,
            variantQuestion: question.trim(),
            variantBogi: null,
            variantChoices: null,
            variantAnswer: answer.trim(),
            variantSolutionProcess: anonSolution || null,
            variantStrategyId: '',
            variantStrategyName: '',
            requiresSolution: true,
          });
          classProblemId = reg.problemId;
          classProblemLabel = reg.label;
          await updateDoc(doc(db, 'classes', classCode, 'problemBank', classProblemId), {
            aiMode: 'new_problem',
            source: 'new_problem',
            unitKey,
            unitLabel,
          }).catch(() => {});
          await updateDoc(doc(db, 'students', uuid, 'problemBank', id), {
            classProblemId,
            classProblemLabel,
          });
          await saveVariantReview({
            reviewId,
            bankDocId: id,
            studentUUID: uuid,
            classCode,
            classProblemId,
            classProblemLabel,
            status: SUBMISSION_STATUS_REGISTERED,
          }, { isUpdate: true });
        }

        await logMakingSubmit(uuid, problemKey, MAKING_OUTCOME.NEW_SUBMITTED, {
          bankDocId: id,
          classCode,
          unitKey,
        });

        runBackgroundVariantAiReview({
          classCode,
          problemId: classProblemId,
          reviewId,
          studentUUID: uuid,
          bankDocId: id,
          teacherGeminiKey,
          anonPayload: {
            question: anonQuestion,
            solutionProcess: anonSolution,
            answer: answer.trim(),
            requiresSolution: true,
            bogi: null,
            choices: null,
            grade: currGrade,
            semester: currSemester,
            unit: curriculumUnitNum,
            examGrade: currGrade,
            unitGoal: unitGoalLabel,
            originalQuestion: '',
            variantStrategyId: '',
            variantStrategyName: '',
            problemKind: 'new',
          },
        }).catch((e) => console.warn('[backgroundAi new_problem]', e));

        setDone(true);
      } catch (e) {
        setErr(e.message || '저장에 실패했습니다.');
      }
    });
  }

  if (done) {
    return (
      <div className="dashboard-container">
        <header className="dashboard-header">
          <div className="header-left">
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/problem-maker')}>
              ← 문제 만들기
            </button>
            <h1 className="header-title">저장됐어요!</h1>
          </div>
        </header>
        <main className="dashboard-main pmod-save-done" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 56 }}>✨</div>
          <h2>문제 저장소에 담았어요</h2>
          <p style={{ color: '#6b7280' }}>선생님이 확인할 때까지 잠시 기다려 주세요.</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 24, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => { setDone(false); setQuestion(''); setSolution(''); setAnswer(''); setTitle(''); }}>
              또 만들기
            </button>
            <button className="btn btn-outline" onClick={() => navigate('/problem-bank')}>
              문제 저장소
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/problem-maker')}>
            ← 문제 만들기
          </button>
          <span style={{ fontSize: 26 }}>🌟</span>
          <div>
            <h1 className="header-title">새로운 문제 만들기</h1>
            <p className="header-subtitle">수식·글자를 섞어 나만의 문제를 완성해 봐요!</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge student-badge">학생</span>
          <span className="user-name">{realName}</span>
          <button onClick={studentLogout} className="btn btn-outline btn-sm">로그아웃</button>
        </div>
      </header>

      <main className="dashboard-main">
        <div className="pmod-field-section" style={{ marginTop: 6 }}>
          <label className="pmod-field-label">
            학년·학기·단원 선택{' '}
            <span className="pmod-field-hint" style={{ color: '#b45309' }}>(필수)</span>
          </label>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(240px, 1fr) minmax(240px, 1fr) minmax(320px, 2fr)',
              gap: 12,
              alignItems: 'start',
            }}
          >
            {/* 학년 */}
            <div>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>학년</div>
              {currGrade && !gradePickerOpen ? (
                <button
                  type="button"
                  className="review-grade-btn active"
                  onClick={() => {
                    // 선택한 항목을 다시 누르면 재선택 가능
                    setGradePickerOpen(true);
                    setCurrGrade('');
                    setCurrSemester('');
                    setCurrUnitIdx(-1);
                    setSemesterPickerOpen(true);
                    setUnitPickerOpen(true);
                  }}
                >
                  {currGrade} (다시 선택)
                </button>
              ) : (
                <div className="review-grade-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {GRADES.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className={`review-grade-btn ${currGrade === g ? 'active' : ''}`}
                      onClick={() => {
                        setCurrGrade(g);
                        setCurrSemester('');
                        setCurrUnitIdx(-1);
                        setGradePickerOpen(false);
                        setSemesterPickerOpen(true);
                        setUnitPickerOpen(true);
                      }}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 학기 */}
            <div style={{ opacity: currGrade ? 1 : 0.5 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>학기</div>
              {!currGrade ? null : currSemester && !semesterPickerOpen ? (
                <button
                  type="button"
                  className="review-grade-btn active"
                  onClick={() => {
                    setSemesterPickerOpen(true);
                    setCurrSemester('');
                    setCurrUnitIdx(-1);
                    setUnitPickerOpen(true);
                  }}
                >
                  {currSemester} (다시 선택)
                </button>
              ) : (
                <div className="review-grade-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {SEMESTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`review-grade-btn ${currSemester === s ? 'active' : ''}`}
                      onClick={() => {
                        if (!currGrade) return;
                        setCurrSemester(s);
                        setCurrUnitIdx(-1);
                        setSemesterPickerOpen(false);
                        setUnitPickerOpen(true);
                      }}
                      disabled={!currGrade}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 단원 (학기 오른쪽) */}
            <div style={{ opacity: currGrade && currSemester ? 1 : 0.5 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>단원</div>
              {!currGrade || !currSemester ? null : pickedUnit && !unitPickerOpen ? (
                <button
                  type="button"
                  className="prs-sel-unit-btn active"
                  onClick={() => {
                    setUnitPickerOpen(true);
                    setCurrUnitIdx(-1);
                  }}
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                >
                  {pickedUnit} (다시 선택)
                </button>
              ) : (
                <div
                  className="prs-sel-unit-list"
                  role="list"
                  aria-label="단원 선택"
                  style={{ maxHeight: 220, overflowY: 'auto' }}
                >
                  {unitList.map((u, idx) => (
                    <button
                      key={`${currGrade}_${currSemester}_${idx}`}
                      type="button"
                      className={`prs-sel-unit-btn ${currUnitIdx === idx ? 'active' : ''}`}
                      onClick={() => {
                        if (!currGrade || !currSemester) return;
                        setCurrUnitIdx(idx);
                        setUnitPickerOpen(false);
                      }}
                      disabled={!currGrade || !currSemester}
                      style={{ width: '100%', justifyContent: 'flex-start' }}
                    >
                      {u}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {selectionComplete ? (
          <div ref={editorStartRef}>
            <div className="pmod-field-section">
              <label className="pmod-field-label">문제 제목(메모) <span className="pmod-field-hint">저장소에서만 보여요</span></label>
              <input
                className="form-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="예: 시험 대비 곱셈 응용"
              />
            </div>

            <div className="pmod-field-section">
              <label className="pmod-field-label">문제</label>
              <InlineMathEditor
                value={question}
                onChange={setQuestion}
                multiline
                enableGraphInsert
                placeholder="문제를 적어 보세요."
              />
            </div>

            <div className="pmod-field-section">
              <label className="pmod-field-label">풀이 과정</label>
              <InlineMathEditor value={solution} onChange={setSolution} multiline compact placeholder="풀이 과정을 단계별로 적어 보세요." />
            </div>

            <div className="pmod-field-section">
              <label className="pmod-field-label">
                정답{' '}
                <span className="pmod-field-hint">답이 여러 개일 경우 쉼표로 구분해주세요. (예시: 5상자, 3개)</span>
              </label>
              <InlineMathEditor value={answer} onChange={setAnswer} multiline={false} compact placeholder="정답" />
            </div>
          </div>
        ) : null}

        {err && <div className="alert alert-error">⚠️ {err}</div>}

        {selectionComplete ? (
          <div className="pmod-editor-footer" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? <><span className="spinner" /> 저장 중…</> : '💾 문제 저장소에 저장'}
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
