/**

 * ClassProblemSolve.js — 학급 문제 풀이 → 정답 확인 → 동료 평가

 * 본인 제출 문제는 구경 전용. 풀이·평가 기록은 개발용으로만 저장 (보상 없음).

 */

import React, { useState, useEffect, useCallback, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';

import {

  getClassProblem,

  getStudentClassProblemProgress,

  recordClassProblemSolveAttempt,

  devRevertStudentClassProblemProgress,

  submitVariantPeerEvaluation,

  fetchClassProblemCreatorReveal,

} from '../firebase/classProblemBankOps';

import { renderMathText, mathTextToPlainString } from './ExamOCR';

import { QuestionBodyRenderer } from './QuestionBodyRenderer';

import VariantPeerEvaluation, {
  VariantEvalResult,
  ProblemThoughtPanel,
  AiVerifiedBanner,
  CreatorGradeReveal,
} from './VariantPeerEvaluation';

import { isTeacherReviewConfirmed } from '../utils/studentAiFeedback';

import InlineMathEditor from './InlineMathEditor';

import ReviewMathToolsSidebar from './ReviewMathToolsSidebar';

import { elementaryScriptToLatex } from '../utils/elementaryMathScript';
import { compareStudentAnswers, tokenizeStudentAnswer } from '../utils/compareStudentAnswers';
import { getExamQuestionStemForStudent } from '../utils/examSolutionArea';
import { isDevClassProblemSolveResetEnabled } from '../utils/devClassProblemSolveReset';

import './ClassProblemBank.css';

const CHOICE_LABELS = ['①', '②', '③', '④', '⑤', '⑥'];

const LEAVE_EVAL_MESSAGE =
  '아직 동료 평가를 마치지 않았어요. 나가면 평가 기록이 남지 않아요. 그래도 나갈까요?';

function parseChoiceNums(answerStr) {
  return String(answerStr || '')
    .split(/[,，\s]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function restoreSolveFieldsFromAttempt(attempt, problem) {
  const isMc = Array.isArray(problem?.variantChoices) && problem.variantChoices.length > 0;
  return {
    solvedCorrect: !!attempt.solvedCorrect,
    aiGradedCorrect:
      typeof attempt.aiGradedCorrect === 'boolean'
        ? attempt.aiGradedCorrect
        : !!attempt.solvedCorrect,
    solutionProcess: attempt.submittedSolutionProcess || '',
    answer: isMc ? '' : (attempt.submittedAnswer || ''),
    selectedChoiceNums: isMc ? parseChoiceNums(attempt.submittedAnswer) : [],
  };
}

function LeaveConfirmModal({ open, onStay, onLeave }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onStay}>
      <div className="modal cpb-leave-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>동료 평가를 마치지 않았어요</h3>
        </div>
        <div className="modal-body">
          <p className="cpb-leave-modal__text">{LEAVE_EVAL_MESSAGE}</p>
          <div className="cpb-leave-modal__actions">
            <button type="button" className="btn btn-primary" onClick={onStay}>
              평가 이어하기
            </button>
            <button type="button" className="btn btn-outline" onClick={onLeave}>
              나가기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TeacherConfirmedBadProblemModal({ open, onNo, onYes }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onNo}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>확인</h3>
          <button type="button" className="modal-close" onClick={onNo}>×</button>
        </div>
        <div className="modal-body">
          <p className="confirm-text">
            <span>선생님 확인을 거친 문제입니다.</span>
            <span>정말로 오류가 있나요?</span>
          </p>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onNo}>아니오</button>
            <button type="button" className="btn btn-danger" onClick={onYes}>예</button>
          </div>
        </div>
      </div>
    </div>
  );
}



function VariantQuestionPanel({ problem, showChoices = false }) {

  return (

    <>

      <QuestionBodyRenderer

        text={getExamQuestionStemForStudent(problem.variantQuestion)}

        tableData={problem.tableData}

        className="vpe-panel-body"

      />

      {problem.variantBogi && (

        <QuestionBodyRenderer

          text={problem.variantBogi}

          className="vpe-panel-body vpe-panel-bogi"

        />

      )}

      {showChoices && Array.isArray(problem.variantChoices) && problem.variantChoices.length > 0 && (
        <div className="prob-choices">
          {problem.variantChoices.map((c, ci) => (
            <div key={ci} className="prob-choice">
              <span className="prob-choice-num">{CHOICE_LABELS[ci]}</span>
              <span className="prob-choice-text">{renderMathText(c)}</span>
            </div>
          ))}
        </div>
      )}

    </>

  );

}



function BadProblemSolveSection({
  panelOpen,
  onOpenPanel,
  onClosePanel,
  thought,
  onThoughtChange,
  onConfirm,
  recording,
  layout = 'actions',
  children,
}) {
  return (
    <>
      {panelOpen && (
        <ProblemThoughtPanel
          className="cpb-problem-thought-panel--inline"
          value={thought}
          onChange={onThoughtChange}
          onConfirm={onConfirm}
          onCancel={onClosePanel}
          confirming={recording}
          disabled={recording}
        />
      )}
      {layout === 'actions' ? (
        <div className="cpb-solve-actions">{children}</div>
      ) : (
        children
      )}
      {!panelOpen && (
        <button
          type="button"
          className="cpb-bad-problem-link cpb-bad-problem-link--below"
          disabled={recording}
          onClick={onOpenPanel}
        >
          잘못 만든 문제인가요?
        </button>
      )}
    </>
  );
}


function OwnProblemPreview({ problem, onBack }) {
  return (
    <div className="cpb-own-preview">
      <p className="cpb-own-label">내가 만든 문제예요.</p>

      <div className="vpe-panel vpe-panel--variant">
        <VariantQuestionPanel problem={problem} showChoices />
      </div>

      <button type="button" className="btn btn-outline btn-sm" onClick={onBack}>목록으로</button>
    </div>
  );
}



export default function ClassProblemSolve() {

  const { problemId } = useParams();

  const navigate = useNavigate();

  const { studentSession, studentLogout } = useAuth();

  const { uuid, realName, classCode } = studentSession || {};



  const [problem, setProblem] = useState(null);

  const [loading, setLoading] = useState(true);

  const [answer, setAnswer] = useState('');

  const [selectedChoiceNums, setSelectedChoiceNums] = useState(/** @type {number[]} */ ([]));

  const [solutionProcess, setSolutionProcess] = useState('');

  const [phase, setPhase] = useState('solve'); // solve | gradeResult | eval | done

  const [solvedCorrect, setSolvedCorrect] = useState(false);

  const [aiGradedCorrect, setAiGradedCorrect] = useState(null);

  const [evalResult, setEvalResult] = useState(null);

  const [err, setErr] = useState('');

  const [recording, setRecording] = useState(false);
  const [confirmBadProblemOpen, setConfirmBadProblemOpen] = useState(false);

  const [reviewMathOpen, setReviewMathOpen] = useState(false);

  const [badProblemPanelOpen, setBadProblemPanelOpen] = useState(false);

  const [badProblemThought, setBadProblemThought] = useState('');

  const [earlyUnsolvableThought, setEarlyUnsolvableThought] = useState('');

  const [reportedBadProblemEarly, setReportedBadProblemEarly] = useState(false);

  const [resumedEval, setResumedEval] = useState(false);

  const [creatorSolution, setCreatorSolution] = useState('');

  const [creatorSolutionLoading, setCreatorSolutionLoading] = useState(false);

  const [leaveModalOpen, setLeaveModalOpen] = useState(false);

  const [hasRecordedProgress, setHasRecordedProgress] = useState(false);

  const [reverting, setReverting] = useState(false);

  const showDevReset = isDevClassProblemSolveResetEnabled();

  const leaveActionRef = useRef(null);

  const skipLeaveGuardRef = useRef(false);

  const creatorLoadSeqRef = useRef(0);

  const evalIncomplete = phase === 'gradeResult' || phase === 'eval';

  const requestLeave = useCallback((onConfirm) => {
    if (skipLeaveGuardRef.current || !evalIncomplete) {
      onConfirm();
      return;
    }
    leaveActionRef.current = onConfirm;
    setLeaveModalOpen(true);
  }, [evalIncomplete]);

  const goToProblemList = useCallback(() => {
    requestLeave(() => navigate('/class-problems'));
  }, [navigate, requestLeave]);

  const confirmLeave = useCallback(() => {
    setLeaveModalOpen(false);
    skipLeaveGuardRef.current = true;
    const action = leaveActionRef.current;
    leaveActionRef.current = null;
    action?.();
  }, []);

  const cancelLeave = useCallback(() => {
    setLeaveModalOpen(false);
    leaveActionRef.current = null;
  }, []);

  useEffect(() => {
    if (!evalIncomplete) return undefined;

    window.history.pushState({ cpbEvalBlock: true }, '');

    const onPopState = () => {
      if (skipLeaveGuardRef.current) return;
      leaveActionRef.current = () => navigate('/class-problems');
      setLeaveModalOpen(true);
      window.history.pushState({ cpbEvalBlock: true }, '');
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [evalIncomplete, navigate]);

  useEffect(() => {
    if (!evalIncomplete) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [evalIncomplete]);

  useEffect(() => {
    const shouldLoad =
      problem && (phase === 'gradeResult' || phase === 'eval');
    if (!shouldLoad) return undefined;

    const loadSeq = creatorLoadSeqRef.current + 1;
    creatorLoadSeqRef.current = loadSeq;
    setCreatorSolution('');
    setCreatorSolutionLoading(true);

    const timeoutMs = 8000;
    const timeoutId = window.setTimeout(() => {
      if (creatorLoadSeqRef.current === loadSeq) {
        setCreatorSolutionLoading(false);
      }
    }, timeoutMs);

    fetchClassProblemCreatorReveal(problem, classCode)
      .then((text) => {
        if (creatorLoadSeqRef.current !== loadSeq) return;
        setCreatorSolution(text);
      })
      .catch((e) => {
        console.warn('[creator reveal]', e);
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        if (creatorLoadSeqRef.current === loadSeq) {
          setCreatorSolutionLoading(false);
        }
      });

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [phase, problem, classCode]);

  const insertBridgeRef = useRef(
    /** @type {null | { insertElementaryFromLatex: (latex: string) => void; insertReviewChunk: (chunk: string) => void }} */ (
      null
    ),
  );

  const registerInsertBridge = useCallback((api) => {
    insertBridgeRef.current = api;
  }, []);

  const insertReviewMathFromScript = useCallback((script) => {
    const latex = elementaryScriptToLatex(script).trim();
    if (!latex) return;
    insertBridgeRef.current?.insertElementaryFromLatex(latex);
  }, []);

  const insertReviewSymbol = useCallback((kind, sym) => {
    const chunk = kind === 'op' ? sym : `⟦UNIT:${encodeURIComponent(sym)}⟧`;
    insertBridgeRef.current?.insertReviewChunk(chunk);
  }, []);

  const toggleReviewMathPanel = useCallback(() => {
    setReviewMathOpen((v) => !v);
  }, []);

  const handleSolutionChange = useCallback((val) => {
    setSolutionProcess(val);
  }, []);

  const toggleChoiceNum = useCallback((num) => {
    setSelectedChoiceNums((prev) => {
      if (prev.includes(num)) return prev.filter((n) => n !== num);
      const isMc = Array.isArray(problem?.variantChoices) && problem.variantChoices.length > 0;
      const max = isMc
        ? Math.min(3, Math.max(1, tokenizeStudentAnswer(problem?.variantAnswer || '').length))
        : 1;
      if (max === 1) return [num];
      if (prev.length >= max) return prev;
      return [...prev, num].sort((a, b) => a - b);
    });
  }, [problem?.variantAnswer, problem?.variantChoices]);

  const handleSubmitAndGrade = useCallback(async () => {
    if (!mathTextToPlainString(solutionProcess).trim()) {
      alert('풀이 과정을 단계별로 적어 주세요.');
      return;
    }
    const isMc =
      Array.isArray(problem?.variantChoices) && problem.variantChoices.length > 0;
    if (isMc ? selectedChoiceNums.length === 0 : !mathTextToPlainString(answer).trim()) {
      return;
    }

    const answerStr = isMc ? selectedChoiceNums.join(', ') : answer.trim();
    const correct = compareStudentAnswers(answerStr, problem.variantAnswer, {
      multipleChoice: isMc,
    });

    setSolvedCorrect(correct);
    setAiGradedCorrect(correct);
    setRecording(true);
    try {
      await recordClassProblemSolveAttempt({
        classCode,
        problemId: problem.id,
        problemLabel: problem.label,
        creatorUUID: problem.createdBy,
        evaluatorUUID: uuid,
        solvedCorrect: correct,
        aiGradedCorrect: correct,
        submittedAnswer: answerStr,
        submittedSolutionProcess: solutionProcess.trim(),
        aiApproved: problem.aiApproved,
        aiCompletionLevel: problem.aiCompletionLevel,
        aiReviewStatus: problem.aiReviewStatus,
        curriculumGrade: problem.curriculumGrade,
        curriculumSemester: problem.curriculumSemester,
        curriculumUnit: problem.curriculumUnit,
      });
    } catch (e) {
      console.warn('[solve attempt record]', e);
    }
    setHasRecordedProgress(true);
    setRecording(false);
    setPhase('gradeResult');
  }, [
    solutionProcess,
    answer,
    problem,
    selectedChoiceNums,
    classCode,
    uuid,
  ]);

  const load = useCallback(async () => {

    if (!classCode || !problemId) return;

    setLoading(true);
    setResumedEval(false);
    skipLeaveGuardRef.current = false;

    try {

      const p = await getClassProblem(classCode, problemId);

      setProblem(p);

      if (uuid && p.createdBy !== uuid) {
        const { solve, peer } = await getStudentClassProblemProgress(uuid, classCode, problemId);

        if (peer) {
          setHasRecordedProgress(true);
          setSolvedCorrect(!!peer.solvedCorrect);
          setEvalResult({
            strategyMatch: peer.strategyMatch,
            completionMatch: peer.completionMatch,
            aiCompletionLevel: peer.aiCompletionLevel,
          });
          setPhase('done');
        } else if (solve) {
          setHasRecordedProgress(true);
          const restored = restoreSolveFieldsFromAttempt(solve, p);
          setSolvedCorrect(restored.solvedCorrect);
          setAiGradedCorrect(restored.aiGradedCorrect);
          setSolutionProcess(restored.solutionProcess);
          setAnswer(restored.answer);
          setSelectedChoiceNums(restored.selectedChoiceNums);
          setPhase('eval');
          setResumedEval(true);
        } else {
          setHasRecordedProgress(false);
          setPhase('solve');
          setSolvedCorrect(false);
          setAiGradedCorrect(null);
          setEvalResult(null);
          setAnswer('');
          setSelectedChoiceNums([]);
          setSolutionProcess('');
          setReportedBadProblemEarly(false);
          setEarlyUnsolvableThought('');
        }
      }

    } catch (e) {

      setErr(e.message || '문제를 불러오지 못했습니다.');

    }

    setLoading(false);

  }, [classCode, problemId, uuid]);



  useEffect(() => { load(); }, [load]);



  const isOwnProblem = problem?.createdBy === uuid;



  const isMultipleChoice =
    Array.isArray(problem?.variantChoices) && problem.variantChoices.length > 0;

  const mcSelectMax = isMultipleChoice
    ? Math.min(3, Math.max(1, tokenizeStudentAnswer(problem?.variantAnswer || '').length))
    : 1;

  const hasAnswer = isMultipleChoice
    ? selectedChoiceNums.length > 0
    : mathTextToPlainString(answer).trim().length > 0;

  const submittedAnswerStr = isMultipleChoice
    ? selectedChoiceNums.join(', ')
    : answer.trim();

  async function persistSolveAttempt(correct) {
    await recordClassProblemSolveAttempt({
      classCode,
      problemId: problem.id,
      problemLabel: problem.label,
      creatorUUID: problem.createdBy,
      evaluatorUUID: uuid,
      solvedCorrect: correct,
      aiGradedCorrect: typeof aiGradedCorrect === 'boolean' ? aiGradedCorrect : correct,
      submittedAnswer: submittedAnswerStr,
      submittedSolutionProcess: solutionProcess.trim(),
      aiApproved: problem.aiApproved,
      aiCompletionLevel: problem.aiCompletionLevel,
      aiReviewStatus: problem.aiReviewStatus,
      curriculumGrade: problem.curriculumGrade,
      curriculumSemester: problem.curriculumSemester,
      curriculumUnit: problem.curriculumUnit,
    });
  }

  async function handleOverrideToCorrect() {
    setSolvedCorrect(true);
    setRecording(true);
    try {
      await persistSolveAttempt(true);
    } catch (e) {
      console.warn('[solve attempt override correct]', e);
    }
    setRecording(false);
    setPhase('eval');
  }

  async function handleRetryAsWrong() {
    setSolvedCorrect(false);
    setBadProblemPanelOpen(false);
    setBadProblemThought('');
    setEarlyUnsolvableThought('');
    setReportedBadProblemEarly(false);
    setRecording(true);
    try {
      await persistSolveAttempt(false);
    } catch (e) {
      console.warn('[solve attempt retry wrong]', e);
    }
    setRecording(false);
    setPhase('solve');
  }



  async function handleDevRevertProgress() {
    if (
      !window.confirm(
        '[개발용] 이 문제의 풀이·동료평가 기록을 모두 지우고 처음부터 다시 풀 수 있게 할까요?\n\n'
        + '탐구점수·통계도 되돌리려고 시도합니다. 되돌릴 수 없습니다.',
      )
    ) {
      return;
    }

    setReverting(true);
    skipLeaveGuardRef.current = true;
    try {
      await devRevertStudentClassProblemProgress(uuid, classCode, problem.id);
      setPhase('solve');
      setSolvedCorrect(false);
      setAiGradedCorrect(null);
      setEvalResult(null);
      setAnswer('');
      setSelectedChoiceNums([]);
      setSolutionProcess('');
      setReportedBadProblemEarly(false);
      setEarlyUnsolvableThought('');
      setBadProblemPanelOpen(false);
      setBadProblemThought('');
      setResumedEval(false);
      setHasRecordedProgress(false);
      setLeaveModalOpen(false);
      leaveActionRef.current = null;
    } catch (e) {
      console.warn('[dev revert progress]', e);
      alert(`기록 초기화 실패: ${e?.message || e}`);
    }
    setReverting(false);
  }

  async function handleBadProblemReport() {
    if (!mathTextToPlainString(solutionProcess).trim()) {
      alert('풀이 과정을 단계별로 적어 주세요.');
      return;
    }

    const thought = badProblemThought.trim();
    setSolvedCorrect(false);
    setRecording(true);
    try {
      await persistSolveAttempt(false);
    } catch (e) {
      console.warn('[solve attempt bad problem report]', e);
    }
    setRecording(false);
    setEarlyUnsolvableThought(thought);
    setReportedBadProblemEarly(true);
    setBadProblemPanelOpen(false);
    setPhase('eval');
  }



  async function handleEvalComplete(picks) {
    try {
      const res = await submitVariantPeerEvaluation({
        classCode,
        problemId: problem.id,
        problemLabel: problem.label,
        creatorUUID: problem.createdBy,
        evaluatorUUID: uuid,
        solvedCorrect,
        guessedStrategyId: picks.guessedStrategyId,
        creatorStrategyId: picks.creatorStrategyId,
        peerChecks: picks.peerChecks,
        problemThought: picks.problemThought,
        aiApproved: problem.aiApproved,
        aiChecks: problem.aiChecks,
        aiReviewStatus: problem.aiReviewStatus,
        aiMode: problem.aiMode,
        aiCompletionLevel: problem.aiCompletionLevel,
        curriculumGrade: problem.curriculumGrade,
        curriculumSemester: problem.curriculumSemester,
        curriculumUnit: problem.curriculumUnit,
      });

      setEvalResult(res);
      skipLeaveGuardRef.current = true;
      setPhase('done');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      console.warn('[eval complete]', e);
      alert(`평가를 저장하지 못했어요. 다시 시도해 주세요.\n(${e?.message || e})`);
      throw e;
    }
  }



  if (loading) {

    return (

      <div className="dashboard-container">

        <div className="pmod-loading"><span className="spinner" /> 불러오는 중...</div>

      </div>

    );

  }



  if (err || !problem) {

    return (

      <div className="dashboard-container">

        <main className="dashboard-main" style={{ maxWidth: 480, margin: '0 auto' }}>

          <div className="alert alert-error">{err || '문제를 찾을 수 없습니다.'}</div>

          <button type="button" className="btn btn-outline" onClick={() => navigate('/class-problems')}>목록으로</button>

        </main>

      </div>

    );

  }

  const teacherConfirmed = isTeacherReviewConfirmed(problem);

  function handleOpenBadProblemPanel() {
    if (teacherConfirmed) {
      setConfirmBadProblemOpen(true);
      return;
    }
    setBadProblemPanelOpen(true);
  }

  function handleConfirmBadProblemYes() {
    setConfirmBadProblemOpen(false);
    setBadProblemPanelOpen(true);
  }

  return (

    <div className="dashboard-container dashboard-container--brand-bg">

      <header className="dashboard-header">

        <div className="header-left">

          <button type="button" className="btn btn-ghost btn-sm" onClick={goToProblemList}>

            ← 목록

          </button>

          <span style={{ fontSize: 26 }}>🧩</span>

          <div className="cpb-solve-header-meta">
            <div className="cpb-solve-header-title-row">
              <h1 className="header-title">{problem.label}</h1>
              {!isOwnProblem && (
                <AiVerifiedBanner problem={problem} className="vpe-ai-verified--header" />
              )}
            </div>
            <p className="header-subtitle">{problem.examTitle || '변형 문제'}</p>
          </div>

        </div>

        <div className="header-right">
          {showDevReset && !isOwnProblem && hasRecordedProgress && (
            <button
              type="button"
              className="btn btn-outline btn-sm cpb-dev-reset-btn"
              disabled={reverting || recording}
              onClick={handleDevRevertProgress}
              title="개발용: 풀이·동료평가 기록 삭제"
            >
              {reverting ? '초기화 중…' : '↩ 원상복귀 (개발)'}
            </button>
          )}

          <span className="user-badge student-badge">학생</span>

          <span className="user-name">{realName}</span>

          <button type="button" className="btn btn-outline btn-sm" onClick={studentLogout}>로그아웃</button>

        </div>

      </header>



      <main
        className={`dashboard-main cpb-solve-main${
          phase === 'solve' ? ' cpb-solve-main--with-tools' : ''
        }${phase === 'eval' || phase === 'done' ? ' cpb-solve-main--eval' : ''}${
          phase === 'gradeResult' ? ' cpb-solve-main--grade-result' : ''
        }`}
      >

        {isOwnProblem ? (

          <OwnProblemPreview

            problem={problem}

            onBack={() => navigate('/class-problems')}

          />

        ) : (

          <>

            {phase === 'solve' && (
              <div className="review-body cpb-solve-math-layout">
                <div className="cpb-solve-math-main cpb-solve-math-main--with-corner-link">
                  <div className="vpe-panel" style={{ marginBottom: 16 }}>
                    <VariantQuestionPanel problem={problem} />
                  </div>

                  {isMultipleChoice ? (
                    <>
                      <label className="pmod-field-label">
                        선지{' '}
                        <span className="pmod-field-hint">
                          {mcSelectMax > 1
                            ? `${mcSelectMax}개 선택 · 다시 누르면 해제`
                            : '정답 선지를 골라 주세요'}
                        </span>
                      </label>
                      <div className="cpb-mc-choices" role="group" aria-label="선지 선택">
                        {problem.variantChoices.map((c, ci) => {
                          const choiceNum = ci + 1;
                          const isSelected = selectedChoiceNums.includes(choiceNum);
                          const isMaxed = !isSelected && selectedChoiceNums.length >= mcSelectMax;
                          return (
                            <button
                              key={ci}
                              type="button"
                              className={`cpb-mc-choice-btn${isSelected ? ' cpb-mc-choice-btn--selected' : ''}`}
                              disabled={isMaxed}
                              onClick={() => !isMaxed && toggleChoiceNum(choiceNum)}
                              aria-pressed={isSelected}
                            >
                              <span className="cpb-mc-choice-num">{CHOICE_LABELS[ci]}</span>
                              <span className="cpb-mc-choice-text">{renderMathText(c)}</span>
                            </button>
                          );
                        })}
                      </div>
                      {selectedChoiceNums.length > 0 && (
                        <p className="pmod-answer-selected" style={{ marginTop: 8 }}>
                          선택: {selectedChoiceNums.map((n) => CHOICE_LABELS[n - 1]).join(' ')}
                        </p>
                      )}

                      <label className="pmod-field-label" style={{ marginTop: 16 }}>
                        풀이 과정
                      </label>
                      <InlineMathEditor
                        className="cpb-solve-math-editor"
                        value={solutionProcess}
                        onChange={handleSolutionChange}
                        multiline
                        compact
                        toolbar="none"
                        registerInsertBridge={registerInsertBridge}
                        placeholder="풀이 과정을 단계별로 적어 보세요."
                      />

                      <BadProblemSolveSection
                        panelOpen={badProblemPanelOpen}
                        onOpenPanel={handleOpenBadProblemPanel}
                        onClosePanel={() => setBadProblemPanelOpen(false)}
                        thought={badProblemThought}
                        onThoughtChange={setBadProblemThought}
                        onConfirm={handleBadProblemReport}
                        recording={recording}
                      >
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={!hasAnswer || recording}
                          onClick={handleSubmitAndGrade}
                        >
                          {recording ? '채점 중…' : '확인'}
                        </button>
                      </BadProblemSolveSection>
                    </>
                  ) : (
                    <>
                      <label className="pmod-field-label">
                        풀이 과정
                      </label>
                      <InlineMathEditor
                        className="cpb-solve-math-editor"
                        value={solutionProcess}
                        onChange={handleSolutionChange}
                        multiline
                        compact
                        toolbar="none"
                        registerInsertBridge={registerInsertBridge}
                        placeholder="풀이 과정을 단계별로 적어 보세요."
                      />

                      <label className="pmod-field-label" style={{ marginTop: 16 }}>
                        정답{' '}
                        <span className="pmod-field-hint">빈칸이 여러 개면 쉼표(,)로 순서대로 · 예: 5, 3</span>
                      </label>
                      <BadProblemSolveSection
                        panelOpen={badProblemPanelOpen}
                        onOpenPanel={handleOpenBadProblemPanel}
                        onClosePanel={() => setBadProblemPanelOpen(false)}
                        thought={badProblemThought}
                        onThoughtChange={setBadProblemThought}
                        onConfirm={handleBadProblemReport}
                        recording={recording}
                        layout="subjective"
                      >
                        <div className="vpe-answer-row">
                          <InlineMathEditor
                            className="cpb-solve-math-editor cpb-solve-math-editor--answer"
                            value={answer}
                            onChange={setAnswer}
                            multiline={false}
                            compact
                            toolbar="none"
                            registerInsertBridge={registerInsertBridge}
                            placeholder="빈칸이 여러 개면 쉼표(,)로 순서대로"
                          />
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={!hasAnswer || recording}
                            onClick={handleSubmitAndGrade}
                          >
                            {recording ? '채점 중…' : '확인'}
                          </button>
                        </div>
                      </BadProblemSolveSection>
                    </>
                  )}
                </div>

                <ReviewMathToolsSidebar
                  mathOpen={reviewMathOpen}
                  onToggleMath={toggleReviewMathPanel}
                  onInsertMathScript={insertReviewMathFromScript}
                  onPickSymbol={insertReviewSymbol}
                />
              </div>
            )}



            {phase === 'gradeResult' && (
              <div className="cpb-grade-result">
                <p className="cpb-eval-pending-hint">
                  동료 평가를 마쳐야 기록이 완료돼요.
                </p>
                <p
                  className={`cpb-grade-result__verdict ${
                    solvedCorrect
                      ? 'cpb-grade-result__verdict--correct'
                      : 'cpb-grade-result__verdict--wrong'
                  }`}
                >
                  {solvedCorrect ? '정답!' : '오답'}
                </p>

                <CreatorGradeReveal
                  problem={problem}
                  creatorSolution={creatorSolution}
                  creatorSolutionLoading={creatorSolutionLoading}
                />

                {!isMultipleChoice && solvedCorrect ? (
                  <>
                    <div className="cpb-grade-result__actions cpb-grade-result__actions--confirm">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={recording}
                        onClick={() => setPhase('eval')}
                      >
                        확인
                      </button>
                    </div>
                    <div className="cpb-grade-result__hint">
                      <p>채점이 틀렸나요?</p>
                      <p>친구가 적은 정답을 보고 정답과 다르다면</p>
                      <p>다시 풀어보세요</p>
                    </div>
                    <div className="cpb-grade-result__actions">
                      <button
                        type="button"
                        className="btn btn-outline cpb-grade-result__override"
                        disabled={recording}
                        onClick={handleRetryAsWrong}
                      >
                        다시 풀어보기
                      </button>
                    </div>
                  </>
                ) : !isMultipleChoice && !solvedCorrect ? (
                  <>
                    <div className="cpb-grade-result__actions cpb-grade-result__actions--confirm">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={recording}
                        onClick={() => setPhase('eval')}
                      >
                        확인
                      </button>
                    </div>
                    <div className="cpb-grade-result__hint">
                      <p>채점이 틀렸나요?</p>
                      <p>친구가 적은 정답을 보고 맞게 풀었다면</p>
                      <p>정답으로 바꿀 수 있어요</p>
                    </div>
                    <div className="cpb-grade-result__actions">
                      <button
                        type="button"
                        className="btn btn-outline cpb-grade-result__override"
                        disabled={recording}
                        onClick={handleOverrideToCorrect}
                      >
                        정답으로 바꾸기
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="cpb-grade-result__actions cpb-grade-result__actions--confirm">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={recording}
                      onClick={() => setPhase('eval')}
                    >
                      확인
                    </button>
                  </div>
                )}
              </div>
            )}

            {phase === 'eval' && (

              <>
                {resumedEval && (
                  <p className="cpb-resume-banner">
                    이전에 풀이만 끝냈어요. 동료 평가를 이어서 해 주세요.
                  </p>
                )}

                <VariantPeerEvaluation
                problem={problem}
                solvedCorrect={solvedCorrect}
                creatorSolution={creatorSolution}
                creatorSolutionLoading={creatorSolutionLoading}
                onComplete={handleEvalComplete}
                onBack={goToProblemList}
                reportedBadProblemEarly={reportedBadProblemEarly}
                initialProblemThought={earlyUnsolvableThought}
              />
              </>

            )}



            {phase === 'done' && (

              <VariantEvalResult

                result={evalResult}

                solvedCorrect={solvedCorrect}

                onBack={() => navigate('/class-problems')}

              />

            )}

          </>

        )}

      </main>

      <LeaveConfirmModal
        open={leaveModalOpen}
        onStay={cancelLeave}
        onLeave={confirmLeave}
      />

      <TeacherConfirmedBadProblemModal
        open={confirmBadProblemOpen}
        onNo={() => setConfirmBadProblemOpen(false)}
        onYes={handleConfirmBadProblemYes}
      />

    </div>

  );

}


