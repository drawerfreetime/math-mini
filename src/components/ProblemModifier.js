/**
 * ProblemModifier.js — 기존 문제 변형하기 (학생 전용)
 *
 * 흐름:
 *  Step 1 — 시험지 선택: Firestore exams 컬렉션에서 목록 불러오기
 *  Step 2 — 문항 선택:  선택한 시험지의 questions 서브컬렉션 표시
 *  Step 3 — 편집:      선택한 문항을 텍스트/선지/보기 등 자유 편집
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  getExamList, getExamQuestions, getTeacherGeminiKeyForClass, saveVariantReview,
} from '../firebase/firestoreOps';
import { renderMathText, mathTextToPlainString } from './ExamOCR';
import InlineMathEditor from './InlineMathEditor';
import TableAwareQuestionEditor from './TableAwareQuestionEditor';
import { QuestionBodyRenderer } from './QuestionBodyRenderer';
import ReviewMathToolsSidebar from './ReviewMathToolsSidebar';
import { elementaryScriptToLatex } from '../utils/elementaryMathScript';
import { resolveExamCurriculumForReview, resolveUnitGoalLabelForReview } from '../utils/examCurriculum';
import { buildUnitKey } from '../constants/unitProgress';
import {
  SUBMISSION_STATUS_REGISTERED,
} from '../constants/aiSubmissionPolicy';
import { anonymizeText, nameMapToObject } from '../utils/anonymizeText';
import { VARIANT_STRATEGIES } from '../constants/variantStrategies';
import { getStaticStrategyName } from '../constants/investigationStrategyData';
import { useInvestigation } from '../hooks/useInvestigation';
import { doc, getDoc, setDoc, serverTimestamp, deleteField } from 'firebase/firestore';
import { db } from '../firebase/config';
import BadgeCelebrationModal from './BadgeCelebrationModal';
import {
  buildVariantProblemKey,
  ensureMakingProblemSession,
  logMakingSubmit,
  updateMakingProblemStrategy,
} from '../firebase/makingEventsOps';
import { MAKING_OUTCOME } from '../constants/problemMakingCompetency';
import { normalizeVariantHiddenQuestionNumbers } from '../utils/variantHiddenQuestions';
import { registerClassProblem, updateClassProblem } from '../firebase/classProblemBankOps';
import { runBackgroundVariantAiReview } from '../utils/backgroundVariantAiReview';
import StudentAiFeedbackBox from './StudentAiFeedbackBox';
import { hasStudentVisibleAiFeedback } from '../utils/studentAiFeedback';
import { buildVariantBankDocId, buildVariantReviewId } from '../utils/variantBankIds';

const CHOICE_LABELS = ['①', '②', '③', '④', '⑤'];

// ─────────────────────────────────────────────
// 단계 표시 배너
// ─────────────────────────────────────────────
function StepBanner({ step }) {
  const steps = [
    { n: 1, label: '시험지 고르기' },
    { n: 2, label: '문항 고르기' },
    { n: 3, label: '문제 편집하기' },
  ];
  return (
    <div className="pmod-steps">
      {steps.map((s, i) => (
        <React.Fragment key={s.n}>
          <div className={`pmod-step ${step === s.n ? 'pmod-step--active' : step > s.n ? 'pmod-step--done' : ''}`}>
            <span className="pmod-step-num">{step > s.n ? '✓' : s.n}</span>
            <span className="pmod-step-label">{s.label}</span>
          </div>
          {i < steps.length - 1 && <div className={`pmod-step-line ${step > s.n ? 'pmod-step-line--done' : ''}`} />}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// Step 1: 시험지 목록
// ─────────────────────────────────────────────
function ExamList({ onSelect }) {
  const [exams,   setExams]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    (async () => {
      try {
        const list = await getExamList({ forStudent: true });
        setExams(list);
      } catch (e) {
        setError('시험지를 불러오지 못했습니다: ' + e.message);
      }
      setLoading(false);
    })();
  }, []);

  if (loading) return (
    <div className="pmod-loading">
      <span className="spinner" /> 시험지를 불러오는 중...
    </div>
  );
  if (error) return <div className="alert alert-error">{error}</div>;
  if (exams.length === 0) return (
    <div className="pmod-empty">
      <div style={{ fontSize: 48 }}>📭</div>
      <p>저장된 시험지가 없습니다.</p>
      <p style={{ fontSize: 13, color: '#9ca3af' }}>선생님이 시험지를 저장한 후 이용할 수 있어요.</p>
    </div>
  );

  return (
    <div className="pmod-exam-list">
      <p className="pmod-section-desc">
        변형할 문제가 있는 시험지를 골라요!
      </p>
      {exams.map(exam => (
        <button
          key={exam.id}
          className="pmod-exam-item"
          onClick={() => onSelect(exam)}
        >
          <div className="pmod-exam-icon">📄</div>
          <div className="pmod-exam-info">
            <strong className="pmod-exam-title">{exam.title || '제목 없음'}</strong>
            <span className="pmod-exam-meta">
              {exam.examGrade && <span className="pmod-grade-badge">{exam.examGrade}</span>}
              {exam.questionCount && `${exam.questionCount}문항`}
              {exam.createdAt && ` · ${exam.createdAt.slice(0, 10)}`}
            </span>
          </div>
          <span className="pmod-arrow">›</span>
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// Step 2: 문항 목록
// ─────────────────────────────────────────────
function QuestionList({ exam, onSelect, onBack }) {
  const [questions, setQuestions] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');

  useEffect(() => {
    (async () => {
      try {
        const list = await getExamQuestions(exam.id, { forDisplay: true });
        setQuestions(list);
      } catch (e) {
        setError('문항을 불러오지 못했습니다: ' + e.message);
      }
      setLoading(false);
    })();
  }, [exam.id]);

  if (loading) return (
    <div className="pmod-loading">
      <span className="spinner" /> 문항을 불러오는 중...
    </div>
  );
  if (error) return <div className="alert alert-error">{error}</div>;

  const hiddenNums = new Set(normalizeVariantHiddenQuestionNumbers(exam?.variantHiddenQuestionNumbers));
  const visibleQuestions = questions.filter((q) => !hiddenNums.has(Number(q.number)));

  return (
    <div>
      <div className="pmod-back-row">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← 시험지 다시 고르기</button>
        <div className="pmod-selected-exam">
          <span style={{ fontSize: 15 }}>📄</span>
          <strong>{exam.title}</strong>
          {exam.examGrade && <span className="pmod-grade-badge">{exam.examGrade}</span>}
        </div>
      </div>

      <p className="pmod-section-desc">변형할 문항 번호를 눌러요!</p>
      {hiddenNums.size > 0 && (
        <p style={{ fontSize: 12, color: '#94a3b8', marginTop: -4, marginBottom: 10 }}>
          선생님이 변형하기 어려운 문항 {hiddenNums.size}개는 목록에서 숨겨져 있어요.
        </p>
      )}

      {visibleQuestions.length === 0 ? (
        <div className="pmod-empty">
          <p>변형할 수 있는 문항이 없습니다.</p>
          <p style={{ fontSize: 13, color: '#9ca3af' }}>선생님이 모든 문항을 변형 목록에서 숨긴 경우일 수 있어요.</p>
        </div>
      ) : (
      <div className="pmod-question-grid">
        {visibleQuestions.map(q => (
          <button
            key={q.id}
            className="pmod-question-card"
            onClick={() => onSelect(q)}
          >
            <div className="pmod-q-num">{q.number}번</div>
            <div className="pmod-q-preview">
              {q.question || q.text
                ? renderMathText(q.question || q.text)
                : '(문제 텍스트 없음)'}
            </div>
            {q.choices && q.choices.length > 0 && (
              <div className="pmod-q-has-choices">선지 {q.choices.length}개</div>
            )}
          </button>
        ))}
      </div>
      )}
    </div>
  );
}

/** 시험지 OCR 등에서 저장한 캡처(data URL) 또는 OCR SVG */
function OriginalCapturedVisual({ original }) {
  const imgSrc = original.image_b64 || original.croppedImg || null;
  if (imgSrc) {
    return (
      <div className="pmod-original-image-wrap">
        <img
          src={imgSrc}
          alt={`${original.number}번 원본 문항 영역`}
          className="pmod-original-image"
        />
      </div>
    );
  }
  if (original.svgCode) {
    return (
      <div className="pmod-original-svg-wrap">
        <p className="pmod-original-visual-sub">도형·그림 영역 (스캔 OCR)</p>
        <div className="ocr-svg-container" dangerouslySetInnerHTML={{ __html: original.svgCode }} />
      </div>
    );
  }
  return (
    <p className="pmod-original-no-image">
      저장된 원본 캡처 이미지가 없어요. 시험지 OCR로 저장한 시험에는 문항 영역 캡처가 함께 들어 있는 경우가 많아요.
    </p>
  );
}

function OriginalTextReference({ original }) {
  const qText = original.question || original.text || '';
  const hasAnyText =
    (qText && String(qText).trim()) ||
    (original.bogi && String(original.bogi).trim()) ||
    (original.choices && original.choices.length > 0) ||
    original.answer != null;

  if (!hasAnyText) {
    return <p className="pmod-original-text-empty">참고용 텍스트가 없습니다.</p>;
  }

  return (
    <>
      {qText ? (
        <QuestionBodyRenderer text={qText} tableData={original.tableData} className="pmod-original-q" />
      ) : (
        <p className="pmod-original-q">(문제 본문 없음)</p>
      )}
      {original.bogi && (
        <div className="pmod-original-bogi">
          <strong>[보기]</strong>
          {String(original.bogi)
            .split('\n')
            .map((line, i) => (
              <p key={i} className="pmod-original-bogi-line">{renderMathText(line)}</p>
            ))}
        </div>
      )}
      {original.choices && original.choices.map((c, i) => (
        <div key={i} className="pmod-original-choice">
          {CHOICE_LABELS[i]} {renderMathText(String(c))}
        </div>
      ))}
      {original.answer != null && (
        <div className="pmod-original-answer">정답: {original.answer}</div>
      )}
    </>
  );
}

/** 전략 카드에 표시할 안내 — 생략 여부 + 기본 blurb */
function resolveStrategyGuideDisplay(s, teacherGuideSkippedByStrategyId) {
  const skipped = !!teacherGuideSkippedByStrategyId?.[s.id];
  if (skipped) {
    return { text: '이 문항에는 맞지 않아요', skipped: true };
  }
  return { text: s.blurb, skipped: false };
}

// ─────────────────────────────────────────────
// Step 3: 편집창
// ─────────────────────────────────────────────
function QuestionEditor({ exam, original, onBack, editBankDocId = null }) {
  const navigate = useNavigate();
  const { studentSession } = useAuth();
  const uuid = studentSession?.uuid;

  const {
    strategyId,
    setStrategyId,
    toggleStrategy,
    resetInvestigation,
    validateBeforeAiCall,
    submitLocked,
    beginSubmit,
    endSubmit,
  } = useInvestigation({ original });

  const classCode = studentSession?.classCode || '';
  const variantProblemKey =
    exam?.id && original?.number != null
      ? buildVariantProblemKey(exam.id, original.number)
      : null;

  useEffect(() => {
    if (!uuid || !variantProblemKey || !exam?.id) return;
    ensureMakingProblemSession(uuid, variantProblemKey, {
      kind: 'variant',
      examId: exam.id,
      questionNumber: original.number,
      bankDocId: `exam_${exam.id}_q${original.number}`,
      reviewId: `exam_${exam.id}_s${uuid}_q${original.number}`,
      classCode,
    }).catch((e) => console.warn('[makingProblems session]', e));
  }, [uuid, variantProblemKey, exam?.id, original?.number, classCode]);

  useEffect(() => {
    if (!uuid || !variantProblemKey || !strategyId) return;
    updateMakingProblemStrategy(uuid, variantProblemKey, strategyId).catch(() => {});
  }, [uuid, variantProblemKey, strategyId]);

  const [teacherGuideSkippedByStrategyId, setTeacherGuideSkippedByStrategyId] = useState({});
  const [teacherGuideLoading, setTeacherGuideLoading] = useState(false);

  const [question, setQuestion] = useState(
    String(original.question || original.text || '')
  );
  const [tableData, setTableData] = useState(
    Array.isArray(original.tableData) ? original.tableData.map((r) => [...r]) : null
  );
  const [choices, setChoices] = useState(
    original.choices && original.choices.length > 0
      ? original.choices.map((c) => String(c))
      : []
  );
  const [bogi, setBogi] = useState(String(original.bogi || ''));
  const [studentSolution, setStudentSolution] = useState('');
  const [studentAnswer, setStudentAnswer] = useState('');
  const [selectedAnswerNums, setSelectedAnswerNums] = useState(/** @type {number[]} */ ([]));
  const [isConverted, setIsConverted] = useState(false);
  const [convertedObjChoices, setConvertedObjChoices] = useState(['', '', '', '', '']);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [registeredLabel, setRegisteredLabel] = useState('');
  const [existingClassProblemId, setExistingClassProblemId] = useState('');
  const [activeBankDocId, setActiveBankDocId] = useState(editBankDocId || '');
  const [activeReviewId, setActiveReviewId] = useState('');
  /** 새 변형 작성 중 제출 ID — 전략 선택 시 한 번만 부여해 재시도·중복 제출 방지 */
  const [draftBankDocId, setDraftBankDocId] = useState('');
  const [draftReviewId, setDraftReviewId] = useState('');
  const isEditMode = Boolean(editBankDocId || activeBankDocId);
  const [badgeCelebration, setBadgeCelebration] = useState(null);
  const [aiFb, setAiFb] = useState(null);
  const [aiErr, setAiErr] = useState('');
  const [storedBankFeedback, setStoredBankFeedback] = useState(null);

  const hasBogi =
    mathTextToPlainString(bogi).trim().length > 0 ||
    (original.bogi && String(original.bogi).trim().length > 0);

  const baseQuestion = String(original.question || original.text || '');
  const baseBogi = String(original.bogi || '');
  const baseChoices = (original.choices || []).map((c) => String(c));
  const originalQuestionPlain = mathTextToPlainString(baseQuestion);
  const originalBogiPlain = mathTextToPlainString(baseBogi);
  const originalChoicesPlain = baseChoices.map((c) => mathTextToPlainString(String(c)));

  const insertBridgeRef = useRef(/** @type {null | { insertElementaryFromLatex: (latex: string) => void; insertReviewChunk: (chunk: string) => void }} */ (null));
  const originalDetailsRef = useRef(/** @type {HTMLDetailsElement | null} */ (null));
  const [reviewMathOpen, setReviewMathOpen] = useState(false);

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

  // 원래 객관식 여부
  const isOriginallyObjective = baseChoices.length > 0;
  // 현재 보여줄 모드: 객관식이면 true
  const showAsObjective = isOriginallyObjective ? !isConverted : isConverted;
  // 현재 모드에서 표시할 선지 목록
  const activeChoices = isOriginallyObjective ? choices : convertedObjChoices;

  useEffect(() => {
    if (!exam?.id || original?.number == null) {
      setTeacherGuideSkippedByStrategyId({});
      return;
    }

    let cancelled = false;
    setTeacherGuideLoading(true);
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'exams', exam.id, 'teacherAiGuides', String(original.number)));
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data();
          if (data.published) {
            setTeacherGuideSkippedByStrategyId(
              data.publishedGuideSkippedByStrategyId || data.draftGuideSkippedByStrategyId || {},
            );
          } else {
            setTeacherGuideSkippedByStrategyId({});
          }
        } else {
          setTeacherGuideSkippedByStrategyId({});
        }
      } catch (e) {
        console.warn('teacher strategy skip load failed:', e);
        if (!cancelled) setTeacherGuideSkippedByStrategyId({});
      } finally {
        if (!cancelled) setTeacherGuideLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [exam?.id, original?.number]);

  useEffect(() => {
    if (!strategyId || !teacherGuideSkippedByStrategyId?.[strategyId]) return;
    resetInvestigation();
  }, [teacherGuideSkippedByStrategyId, strategyId, resetInvestigation]);

  useEffect(() => {
    if (!strategyId || !uuid || editBankDocId || activeBankDocId) return;
    setDraftBankDocId((cur) => {
      if (cur) return cur;
      const id = buildVariantBankDocId(exam.id, original.number);
      setDraftReviewId(buildVariantReviewId(uuid, id));
      return id;
    });
  }, [strategyId, uuid, editBankDocId, activeBankDocId, exam.id, original.number]);

  useEffect(() => {
    if (!uuid || !editBankDocId) return;
    let cancelled = false;

    (async () => {
      try {
        const snap = await getDoc(doc(db, 'students', uuid, 'problemBank', editBankDocId));
        if (cancelled || !snap.exists()) return;

        const data = snap.data();
        setActiveBankDocId(editBankDocId);
        if (data.reviewId) setActiveReviewId(String(data.reviewId));
        if (data.question) setQuestion(String(data.question));
        if (data.tableData) {
          setTableData(Array.isArray(data.tableData) ? data.tableData.map((r) => [...r]) : null);
        }
        if (data.bogi) setBogi(String(data.bogi));
        if (Array.isArray(data.choices) && data.choices.length > 0) {
          setChoices(data.choices.map((c) => String(c)));
        }
        if (data.solutionProcess) setStudentSolution(String(data.solutionProcess));
        if (data.answer) {
          if (Array.isArray(data.choices) && data.choices.length > 0) {
            const nums = String(data.answer)
              .split(/[,\s]+/)
              .map((s) => parseInt(s.trim(), 10))
              .filter((n) => !Number.isNaN(n));
            setSelectedAnswerNums(nums);
          } else {
            setStudentAnswer(String(data.answer));
          }
        }
        if (data.variantStrategyId) setStrategyId(data.variantStrategyId);
        if (data.classProblemId) {
          setExistingClassProblemId(data.classProblemId);
          if (data.classProblemLabel) {
            setRegisteredLabel(data.classProblemLabel);
          }
        }
        setStoredBankFeedback({
          aiNote: data.aiNote ?? '',
          aiApproved: data.aiApproved ?? null,
          aiChecks: data.aiChecks ?? null,
          aiReviewStatus: data.aiReviewStatus ?? (data.aiNote ? 'done' : null),
          teacherReviewStatus: data.teacherReviewStatus ?? null,
          status: data.status ?? null,
          teacherComment: data.teacherComment ?? '',
        });
      } catch (e) {
        console.warn('[ProblemModifier] saved variant load failed:', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uuid, editBankDocId, setStrategyId]);

  const selectedStrategyMeta = VARIANT_STRATEGIES.find((x) => x.id === strategyId);
  const displayGuideText = selectedStrategyMeta?.blurb || '';

  const isChanged =
    question !== baseQuestion ||
    bogi !== baseBogi ||
    JSON.stringify(choices) !== JSON.stringify(baseChoices) ||
    studentSolution.trim() !== '' ||
    mathTextToPlainString(studentAnswer).trim() !== '' ||
    isConverted;

  function updateChoice(idx, val) {
    setChoices((prev) => prev.map((c, i) => (i === idx ? val : c)));
  }

  function addChoice() {
    if (choices.length >= 5) return;
    setChoices((prev) => [...prev, '']);
  }

  function removeChoice(idx) {
    setChoices((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateConvertedChoice(idx, val) {
    setConvertedObjChoices((prev) => prev.map((c, i) => (i === idx ? val : c)));
  }

  function handleConversionToggle() {
    setIsConverted((prev) => !prev);
    setStudentAnswer('');
    setStudentSolution('');
    setSelectedAnswerNums([]);
  }

  function toggleAnswerNum(num) {
    setSelectedAnswerNums((prev) => {
      if (prev.includes(num)) return prev.filter((n) => n !== num);
      if (prev.length >= 3) return prev;
      return [...prev, num].sort((a, b) => a - b);
    });
  }

  function handleReset() {
    setQuestion(baseQuestion);
    setTableData(
      Array.isArray(original.tableData) ? original.tableData.map((r) => [...r]) : null,
    );
    setChoices(baseChoices.length > 0 ? [...baseChoices] : []);
    setBogi(baseBogi);
    setStudentSolution('');
    setStudentAnswer('');
    setSelectedAnswerNums([]);
    setIsConverted(false);
    setConvertedObjChoices(['', '', '', '', '']);
    setAiFb(null);
    setAiErr('');
    setStoredBankFeedback(null);
    setSavedOk(false);
    setRegisteredLabel('');
    setExistingClassProblemId('');
    setActiveBankDocId(editBankDocId || '');
    setActiveReviewId('');
    setDraftBankDocId('');
    setDraftReviewId('');
    setBadgeCelebration(null);
    resetInvestigation();
  }

  async function handleSave() {
    if (saving || submitLocked || savedOk) return;
    if (!uuid) {
      alert('학생 로그인 후 이용할 수 있습니다.');
      return;
    }
    if (!question.trim()) {
      alert('문제 내용을 입력해 주세요.');
      return;
    }
    if (!mathTextToPlainString(studentSolution).trim()) {
      alert('풀이 과정을 입력해 주세요.');
      return;
    }
    const answerFilled = showAsObjective
      ? selectedAnswerNums.length > 0
      : mathTextToPlainString(studentAnswer).trim();
    if (!answerFilled) {
      alert('정답을 선택하거나 입력해 주세요.');
      return;
    }
    if (!strategyId) {
      alert('문제 만들기 전략을 하나 골라 주세요.');
      return;
    }

    if (!beginSubmit()) return;

    setSaving(true);
    setAiErr('');
    setAiFb(null);

    try {
      const curriculum = resolveExamCurriculumForReview(exam);
      const unitGoalLabel = resolveUnitGoalLabelForReview(exam, curriculum);
      const unitKey = buildUnitKey(curriculum.grade, curriculum.semester, curriculum.unit);

      const effectiveChoices = showAsObjective ? activeChoices : null;

      const pre = validateBeforeAiCall({
        question: question.trim(),
        bogi,
        choices: effectiveChoices || [],
        hasChoices: showAsObjective,
      });
      if (!pre.ok) {
        setAiErr(pre.message);
        return;
      }

      // ── 학생 실명 익명화 (API 전송 전) ──
      const { anonymized: anonQuestion, nameMap } = anonymizeText(question.trim());
      const { anonymized: anonBogi } = bogi
        ? anonymizeText(bogi)
        : { anonymized: bogi };
      const { anonymized: anonSolution } = studentSolution
        ? anonymizeText(studentSolution)
        : { anonymized: studentSolution };
      const nameMapObj = nameMapToObject(nameMap);

      // 교사 Gemini 키 조회 (1st fallback용)
      const classCode = studentSession?.classCode || '';
      const teacherGeminiKey = classCode
        ? await getTeacherGeminiKeyForClass(classCode).catch(() => '')
        : '';

      const stratName =
        getStaticStrategyName(strategyId) ||
        VARIANT_STRATEGIES.find((x) => x.id === strategyId)?.title ||
        '';

      const bankDocId = activeBankDocId || draftBankDocId
        || buildVariantBankDocId(exam.id, original.number);
      const reviewId = activeReviewId || draftReviewId
        || buildVariantReviewId(uuid, bankDocId);
      const isResubmit = Boolean(editBankDocId || activeBankDocId || draftBankDocId);
      const answerStr = showAsObjective ? selectedAnswerNums.join(', ') : studentAnswer.trim();

      let classProblemId = '';
      let classProblemLabel = '';

      if (classCode) {
        if (existingClassProblemId) {
          const updated = await updateClassProblem({
            classCode,
            problemId: existingClassProblemId,
            createdBy: uuid,
            reviewId,
            unitGoal: unitGoalLabel,
            curriculumGrade: curriculum.grade,
            curriculumSemester: curriculum.semester,
            curriculumUnit: curriculum.unit,
            variantQuestion: question.trim(),
            variantBogi: bogi || null,
            variantChoices: effectiveChoices,
            variantAnswer: answerStr,
            variantSolutionProcess: anonSolution || studentSolution.trim() || null,
            variantStrategyId: strategyId || '',
            variantStrategyName: stratName,
            tableData: tableData || null,
            requiresSolution: true,
          });
          classProblemId = updated.problemId;
          classProblemLabel = updated.label;
          setRegisteredLabel(updated.label);
        } else {
          const reg = await registerClassProblem({
            classCode,
            createdBy: uuid,
            reviewId,
            examId: exam.id,
            examTitle: exam.title || '',
            examGrade: exam.examGrade || '',
            unitGoal: unitGoalLabel,
            curriculumGrade: curriculum.grade,
            curriculumSemester: curriculum.semester,
            curriculumUnit: curriculum.unit,
            sourceNumber: original.number,
            originalQuestion: originalQuestionPlain,
            originalBogi: originalBogiPlain || null,
            originalChoices: originalChoicesPlain.length ? originalChoicesPlain : null,
            variantQuestion: question.trim(),
            variantBogi: bogi || null,
            variantChoices: effectiveChoices,
            variantAnswer: answerStr,
            variantSolutionProcess: anonSolution || studentSolution.trim() || null,
            variantStrategyId: strategyId || '',
            variantStrategyName: stratName,
            tableData: tableData || null,
            requiresSolution: true,
          });
          classProblemId = reg.problemId;
          classProblemLabel = reg.label;
          setExistingClassProblemId(reg.problemId);
          setRegisteredLabel(reg.label);
        }
      }

      if (variantProblemKey) {
        logMakingSubmit(uuid, variantProblemKey, MAKING_OUTCOME.AI_PASS_PENDING_TEACHER, {
          strategyId,
          reviewId,
          examId: exam.id,
          questionNumber: original.number,
          classCode,
          classProblemId,
          classProblemLabel,
        }).catch((e) => console.warn('[makingEvents submit]', e));
      }

      const submissionStatus = SUBMISSION_STATUS_REGISTERED;

      await saveVariantReview({
        reviewId,
        bankDocId,
        examId: exam.id,
        examTitle: exam.title || '',
        examGrade: exam.examGrade || '',
        studentUUID: uuid,
        classCode,
        questionNumber: original.number,
        question: anonQuestion,
        bogi: anonBogi || null,
        choices: effectiveChoices,
        solutionProcess: anonSolution || studentSolution.trim() || null,
        answer: answerStr,
        nameMap: nameMapObj,
        status: submissionStatus,
        aiNote: '',
        aiMode: '',
        aiApproved: null,
        aiChecks: null,
        aiReviewStatus: 'pending',
        variantStrategyId: strategyId || '',
        variantStrategyName: stratName,
        classProblemId,
        classProblemLabel,
        unitKey,
        curriculumGrade: curriculum.grade,
        curriculumSemester: curriculum.semester,
        curriculumUnit: curriculum.unit,
      }, { isUpdate: isResubmit });

      await setDoc(
        doc(db, 'exams', exam.id, 'variants', uuid, 'questions', bankDocId),
        {
          number: original.number,
          bankDocId,
          reviewId,
          question: question.trim(),
          anonymizedQuestion: anonQuestion,
          bogi: bogi || null,
          choices: effectiveChoices,
          solutionProcess: studentSolution.trim() || null,
          studentAnswer: answerStr,
          tableData: tableData || null,
          svgCode: original.svgCode || null,
          hasImage: original.hasImage || false,
          requiresSolution: true,
          createdBy: uuid,
          savedAt: serverTimestamp(),
          status: submissionStatus,
          variantStrategyId: strategyId || '',
          classProblemId,
          classProblemLabel,
          nameMap: nameMapObj,
        }
      );

      const problemBankBody = {
        examId: exam.id,
        examTitle: exam.title || '',
        examGrade: exam.examGrade || '',
        sourceNumber: original.number,
        bankDocId,
        reviewId,
        question: question.trim(),
        bogi: bogi || null,
        choices: effectiveChoices,
        solutionProcess: studentSolution.trim() || null,
        answer: answerStr,
        tableData: tableData || null,
        requiresSolution: true,
        savedAt: new Date().toISOString(),
        status: submissionStatus,
        variantStrategyId: strategyId || '',
        variantStrategyName: stratName,
        classProblemId,
        classProblemLabel,
        aiReviewStatus: 'pending',
        aiNote: '',
        aiMode: '',
        aiCompletionLevel: null,
      };
      if (editBankDocId || activeBankDocId) {
        problemBankBody.teacherReviewStatus = deleteField();
      }
      await setDoc(
        doc(db, 'students', uuid, 'problemBank', bankDocId),
        problemBankBody,
        { merge: true },
      );

      if (!activeBankDocId) {
        setActiveBankDocId(bankDocId);
        setActiveReviewId(reviewId);
        setDraftBankDocId('');
        setDraftReviewId('');
      }

      setSavedOk(true);

      runBackgroundVariantAiReview({
        classCode,
        problemId: classProblemId,
        reviewId,
        studentUUID: uuid,
        bankDocId,
        strategyId,
        teacherGeminiKey,
        anonPayload: {
          question: anonQuestion,
          solutionProcess: anonSolution,
          answer: answerStr,
          requiresSolution: true,
          bogi: anonBogi || null,
          choices: effectiveChoices,
          grade: curriculum.grade,
          semester: curriculum.semester,
          unit: curriculum.unit,
          originalQuestion: originalQuestionPlain,
          originalBogi: originalBogiPlain,
          originalChoices: originalChoicesPlain.length ? originalChoicesPlain : null,
          variantStrategyId: strategyId || '',
          variantStrategyName: stratName,
          unitGoal: unitGoalLabel,
        },
      }).catch((e) => console.warn('[backgroundAi]', e));
    } catch (e) {
      console.error(e);
      const permDenied = e?.code === 'permission-denied'
        || /insufficient permissions/i.test(String(e?.message || ''));
      setAiErr(
        permDenied
          ? '교사 검수 목록 저장에서 권한 오류가 났어요. 내 문제 저장소에 일부만 저장됐을 수 있어요. 「수정」으로 다시 시도해 주세요.'
          : (e.message || '저장 중 오류'),
      );
    } finally {
      endSubmit();
      setSaving(false);
    }
  }

  const composePhase = Boolean(strategyId);

  useEffect(() => {
    const el = originalDetailsRef.current;
    if (!el) return;
    el.open = !composePhase;
  }, [composePhase]);

  function handleChangeStrategy() {
    setDraftBankDocId('');
    setDraftReviewId('');
    resetInvestigation();
  }

  if (savedOk) {
    return (
      <div className="pmod-save-done">
        <div style={{ fontSize: 56 }}>🎉</div>
        <h2>학급 문제은행에 등록됐어요!</h2>
        {registeredLabel && (
          <p style={{ fontSize: 20, fontWeight: 800, color: '#4c1d95', margin: '8px 0' }}>
            {registeredLabel}
          </p>
        )}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 24, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-outline" onClick={() => setSavedOk(false)}>
            {isEditMode ? '다시 편집하기' : '방금 등록한 문제 수정하기'}
          </button>
          <button type="button" className="btn btn-primary" onClick={onBack}>다른 문항 변형하기</button>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/class-problems')}>🏫 학급 문제 풀기</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pmod-editor">
      <div className="pmod-back-row">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>← 문항 다시 고르기</button>
        <div className="pmod-selected-exam">
          <span>📄 {exam.title}</span>
          <span className="pmod-q-badge">
            {original.number}번 문항{isEditMode ? ' · 수정 중' : ' · 새 변형 작성'}
          </span>
        </div>
      </div>

      {!isEditMode && (
        <p className="pmod-new-variant-hint" style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px' }}>
          같은 원문 번호라도 전략·내용이 다르면 <strong>새 변형 문제</strong>로 등록돼요.
          이미 등록한 문제를 고치려면 <strong>문제 저장소 → 수정</strong>을 이용해 주세요.
        </p>
      )}

      <div className="pmod-editor-phases">
        {composePhase ? (
          <button
            type="button"
            className="pmod-editor-phase pmod-editor-phase--done pmod-editor-phase--clickable"
            onClick={handleChangeStrategy}
            aria-label="1단계 문제 만들기 전략 선택으로 돌아가기"
          >
            <span className="pmod-editor-phase-num">✓</span>
            <span className="pmod-editor-phase-label">문제 만들기 전략 선택</span>
          </button>
        ) : (
          <div className="pmod-editor-phase pmod-editor-phase--active" aria-current="step">
            <span className="pmod-editor-phase-num">1</span>
            <span className="pmod-editor-phase-label">문제 만들기 전략 선택</span>
          </div>
        )}
        <div className={`pmod-editor-phase-line ${composePhase ? 'pmod-editor-phase-line--done' : ''}`} />
        <div className={`pmod-editor-phase ${composePhase ? 'pmod-editor-phase--active' : ''}`}>
          <span className="pmod-editor-phase-num">2</span>
          <span className="pmod-editor-phase-label">문제 · 풀이 · 정답 작성</span>
        </div>
      </div>

      {/* 1단계: 원본(왼쪽) + 전략 그리드(오른쪽) */}
      {!composePhase && (
      <>
      <div className="pmod-editor-split">
        <div className="pmod-editor-split-left">
            <div className="pmod-original-panel">
              <div className="pmod-original-panel-label">원본 문항 이미지</div>
              <div className="pmod-original-panel-body">
                <p className="pmod-original-visual-hint">
                  {original.image_b64 || original.croppedImg
                    ? '아래는 시험지에서 잘라 낸 원본 화면이에요. 위에서 고치는 글(OCR·인식 문구)과 다를 수 있어요.'
                    : original.svgCode
                      ? '아래는 스캔에서 추출한 도형·그림 영역이에요. 텍스트와 다를 수 있어요.'
                      : '원본 캡처가 없으면 인식·편집된 텍스트만 확인할 수 있어요.'}
                </p>
                <OriginalCapturedVisual original={original} />
                <details className="pmod-original-text-fallback">
                  <summary>인식·편집된 텍스트 보기 (참고)</summary>
                  <div className="pmod-original-text-fallback-body">
                    <OriginalTextReference original={original} />
                  </div>
                </details>
              </div>
            </div>
        </div>

        <div className="pmod-editor-split-right">
            <h2 className="pmod-strategy-pick-heading">문제 만들기 전략을 하나 골라주세요.</h2>
            <div className="pmod-strategy-section pmod-strategy-section--split">
              {teacherGuideLoading && (
                <div className="pmod-strategy-loading">
                  <span className="spinner" /> 선생님 전략 설정을 불러오는 중…
                </div>
              )}
              <div className="pmod-strategy-grid">
                {VARIANT_STRATEGIES.map((s, strategyIdx) => {
                  const { text: guideText, skipped: skippedForQuestion } =
                    resolveStrategyGuideDisplay(s, teacherGuideSkippedByStrategyId);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`pmod-strategy-card ${strategyId === s.id ? 'pmod-strategy-card--active' : ''}${skippedForQuestion ? ' pmod-strategy-card--skipped' : ''}`}
                      onClick={() => {
                        if (skippedForQuestion) return;
                        toggleStrategy(s.id);
                      }}
                      disabled={skippedForQuestion}
                      title={skippedForQuestion ? '선생님이 이 문항에서는 이 전략을 생략했어요' : undefined}
                    >
                      <div className="pmod-strategy-card-head">
                        <span className="pmod-strategy-card-title">{strategyIdx + 1}. {s.title}</span>
                        {skippedForQuestion && (
                          <span className="pmod-strategy-card-skip-tag">생략</span>
                        )}
                      </div>
                      <div className="pmod-strategy-card-guide">{guideText}</div>
                    </button>
                  );
                })}
              </div>
            </div>
        </div>
      </div>
      </>
      )}

      {/* 2단계: 왼쪽 20% (원본 토글 + 선택 전략) · 오른쪽 80% 편집 */}
      {composePhase && (
      <div className="pmod-compose-workspace">
        <div className="pmod-compose-left-col">
          <details ref={originalDetailsRef} className="pmod-original-panel pmod-original-panel--collapsible" defaultOpen>
            <summary className="pmod-original-panel-label">원본 문항 이미지</summary>
            <div className="pmod-original-panel-body">
              <p className="pmod-original-visual-hint">
                {original.image_b64 || original.croppedImg
                  ? '시험지에서 잘라 낸 원본이에요. 편집하는 글(OCR·인식 문구)과 다를 수 있어요.'
                  : original.svgCode
                    ? '스캔에서 추출한 도형·그림 영역이에요. 텍스트와 다를 수 있어요.'
                    : '원본 캡처가 없으면 인식·편집된 텍스트만 확인할 수 있어요.'}
              </p>
              <OriginalCapturedVisual original={original} />
              <details className="pmod-original-text-fallback">
                <summary>인식·편집된 텍스트 보기 (참고)</summary>
                <div className="pmod-original-text-fallback-body">
                  <OriginalTextReference original={original} />
                </div>
              </details>
            </div>
          </details>

          <aside className="pmod-compose-strategy-rail" aria-label="선택한 문제 만들기 전략">
            <div className="pmod-compose-strategy-rail-inner">
              <span className="pmod-compose-strategy-label">선택한 전략</span>
              <strong className="pmod-compose-strategy-title">
                {selectedStrategyMeta
                  ? `${VARIANT_STRATEGIES.findIndex((x) => x.id === selectedStrategyMeta.id) + 1}. ${selectedStrategyMeta.title}`
                  : ''}
              </strong>
              {teacherGuideLoading ? (
                <div className="pmod-strategy-loading pmod-compose-strategy-loading">
                  <span className="spinner" />
                </div>
              ) : (
                <p className="pmod-compose-strategy-guide">{displayGuideText}</p>
              )}
              <button type="button" className="btn btn-ghost btn-sm pmod-compose-strategy-back" onClick={handleChangeStrategy}>
                ← 전략 다시 고르기
              </button>
            </div>
          </aside>
        </div>

      <div className="review-body pmod-review-body pmod-review-body--compose">
        <div className="pmod-editor-main">
          {/* ── 문제 텍스트 편집 ── */}
          <div className="pmod-field-section">
            <label className="pmod-field-label">
              문제 <span className="pmod-field-hint">숫자, 조건, 단어를 바꿔보세요</span>
            </label>
            <TableAwareQuestionEditor
              value={question}
              onChange={setQuestion}
              tableData={tableData}
              onTableDataChange={setTableData}
              multiline
              toolbar="none"
              hybridPlainMath
              registerInsertBridge={registerInsertBridge}
              placeholder="문제 내용을 입력하세요"
            />
          </div>

          {/* ── 보기 편집 (있는 경우) ── */}
          {(hasBogi || bogi) && (
            <div className="pmod-field-section">
              <label className="pmod-field-label">
                보기 <span className="pmod-field-hint">보기 조건을 바꿔보세요</span>
              </label>
              <InlineMathEditor
                value={bogi}
                onChange={setBogi}
                multiline
                toolbar="none"
                hybridPlainMath
                registerInsertBridge={registerInsertBridge}
                placeholder="보기 내용"
              />
            </div>
          )}

          {/* ── 문제 유형 변환 ── */}
          <div className="pmod-convert-bar">
            <span className="pmod-convert-status">
              현재: <strong>{showAsObjective ? '객관식' : '주관식'}</strong>
            </span>
            <button
              type="button"
              className={`pmod-convert-btn${isConverted ? ' is-active' : ''}`}
              onClick={handleConversionToggle}
            >
              {isConverted
                ? `↩ ${isOriginallyObjective ? '객관식' : '주관식'}으로 되돌리기`
                : `⇄ ${isOriginallyObjective ? '주관식' : '객관식'}으로 바꾸기`}
            </button>
          </div>

          {/* ── 선지 편집 (객관식 모드일 때만 표시) ── */}
          {showAsObjective && (
            <div className="pmod-field-section">
              <label className="pmod-field-label">
                선지{' '}
                {isConverted && !isOriginallyObjective
                  ? <span className="pmod-field-hint">새 선지를 입력하세요 (5개)</span>
                  : <span className="pmod-field-hint">선지 내용을 바꿔보세요</span>}
              </label>
              <div className="pmod-choices">
                {activeChoices.map((c, i) => (
                  <div key={i} className="pmod-choice-row">
                    <span className="pmod-choice-label">{CHOICE_LABELS[i]}</span>
                    <InlineMathEditor
                      className="pmod-choice-math"
                      value={c}
                      onChange={(val) =>
                        isOriginallyObjective
                          ? updateChoice(i, val)
                          : updateConvertedChoice(i, val)
                      }
                      multiline={false}
                      compact
                      toolbar="none"
                      hybridPlainMath
                      registerInsertBridge={registerInsertBridge}
                      placeholder={`${i + 1}번 선지`}
                    />
                    {isOriginallyObjective && !isConverted && (
                      <button
                        className="pmod-choice-del"
                        onClick={() => removeChoice(i)}
                        title="선지 삭제"
                      >×</button>
                    )}
                  </div>
                ))}
                {isOriginallyObjective && !isConverted && choices.length < 5 && (
                  <button className="btn btn-ghost btn-sm pmod-add-choice" onClick={addChoice}>
                    + 선지 추가
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── 풀이 과정 ── */}
          <div className="pmod-field-section">
            <label className="pmod-field-label">풀이 과정</label>
            <InlineMathEditor
              value={studentSolution}
              onChange={setStudentSolution}
              multiline
              compact
              toolbar="none"
              registerInsertBridge={registerInsertBridge}
              placeholder="풀이 과정을 단계별로 적어 보세요."
            />
          </div>

          {/* ── 정답 (학생) ── */}
          <div className="pmod-field-section">
            <label className="pmod-field-label">
              정답{' '}
              {showAsObjective
                ? <span className="pmod-field-hint">최대 3개 선택 · 다시 누르면 해제</span>
                : <span className="pmod-field-hint">답이 여러 개일 경우 쉼표로 구분해주세요. (예시: 5상자, 3개)</span>}
            </label>
            {showAsObjective ? (
              <div>
                <div className="utr-answer-choices" style={{ flexWrap: 'wrap' }}>
                  {activeChoices.map((_, ci) => {
                    const num = ci + 1;
                    const isSelected = selectedAnswerNums.includes(num);
                    const isMaxed = !isSelected && selectedAnswerNums.length >= 3;
                    return (
                      <button
                        type="button"
                        key={ci}
                        className={`utr-answer-btn ${isSelected ? 'selected' : ''} ${isMaxed ? 'pmod-answer-btn--maxed' : ''}`}
                        onClick={() => !isMaxed && toggleAnswerNum(num)}
                        disabled={isMaxed}
                      >
                        {CHOICE_LABELS[ci]}
                      </button>
                    );
                  })}
                </div>
                {selectedAnswerNums.length > 0 && (
                  <p className="pmod-answer-selected">
                    선택된 정답: {selectedAnswerNums.map((n) => CHOICE_LABELS[n - 1]).join(' ')}
                    {selectedAnswerNums.length >= 3 && (
                      <span style={{ color: '#b45309', marginLeft: 6, fontSize: 12 }}>(최대 3개)</span>
                    )}
                  </p>
                )}
              </div>
            ) : (
              <InlineMathEditor
                className="pmod-answer-plain"
                value={studentAnswer}
                onChange={setStudentAnswer}
                multiline={false}
                compact
                toolbar="none"
                registerInsertBridge={registerInsertBridge}
                placeholder="정답"
              />
            )}
          </div>

          {aiErr && (
            <div className="alert alert-error" style={{ marginTop: 8 }}>
              ⚠️ {aiErr}
            </div>
          )}

          {aiFb && (
            <StudentAiFeedbackBox
              item={{
                aiNote: aiFb.feedback,
                aiApproved: aiFb.ok,
                aiChecks: aiFb.checks,
                aiReviewStatus: 'done',
              }}
              hints={aiFb.hints}
              className="pmod-ai-feedback"
            />
          )}

          {!aiFb && storedBankFeedback && hasStudentVisibleAiFeedback(storedBankFeedback) && (
            <StudentAiFeedbackBox
              item={storedBankFeedback}
              className="pmod-ai-feedback"
            />
          )}

          <div className="pmod-editor-footer">
            {isChanged && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleReset}>
                🔄 원본으로 되돌리기
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || submitLocked || !mathTextToPlainString(question).trim()}
            >
              {saving || submitLocked ? (
                <>
                  <span className="spinner" /> 연구원님, AI 정밀 검증 중이에요…
                </>
              ) : (
                '🔬 연구 승인 · 문제 저장소에 저장'
              )}
            </button>
          </div>
        </div>

        <ReviewMathToolsSidebar
          mathOpen={reviewMathOpen}
          onToggleMath={toggleReviewMathPanel}
          onInsertMathScript={insertReviewMathFromScript}
          onPickSymbol={insertReviewSymbol}
        />
      </div>
      </div>
      )}

      <BadgeCelebrationModal
        open={Boolean(badgeCelebration)}
        strategyTitle={badgeCelebration?.strategyTitle ?? ''}
        unlockedTiers={badgeCelebration?.tiers ?? []}
        onConfirm={() => {
          setBadgeCelebration(null);
          setSavedOk(false);
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// 메인 컴포넌트
// ─────────────────────────────────────────────
export default function ProblemModifier() {
  const navigate = useNavigate();
  const location = useLocation();
  const { studentSession, studentLogout } = useAuth();
  const { realName } = studentSession || {};

  const [step,         setStep]         = useState(1);
  const [selectedExam, setSelectedExam] = useState(null);
  const [selectedQ,    setSelectedQ]    = useState(null);
  const [editLoading,  setEditLoading]  = useState(false);

  const editFromBank = location.state?.editFromBank;

  useEffect(() => {
    if (!editFromBank?.examId || editFromBank?.sourceNumber == null) return;
    let cancelled = false;
    setEditLoading(true);

    (async () => {
      try {
        const exams = await getExamList({ forStudent: true });
        const exam = exams.find((e) => e.id === editFromBank.examId);
        if (!exam) return;
        const questions = await getExamQuestions(exam.id, { forDisplay: true });
        const q = questions.find((item) => Number(item.number) === Number(editFromBank.sourceNumber));
        if (!q) return;
        if (cancelled) return;
        setSelectedExam(exam);
        setSelectedQ(q);
        setStep(3);
      } catch (e) {
        console.error('[ProblemModifier] edit load failed:', e);
      } finally {
        if (!cancelled) setEditLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [editFromBank]);

  const handleSelectExam = useCallback((exam) => {
    setSelectedExam(exam);
    setSelectedQ(null);
    setStep(2);
  }, []);

  const handleSelectQuestion = useCallback((q) => {
    setSelectedQ(q);
    setStep(3);
  }, []);

  const handleBackToExams = useCallback(() => {
    setSelectedExam(null);
    setSelectedQ(null);
    setStep(1);
  }, []);

  const handleBackToQuestions = useCallback(() => {
    setSelectedQ(null);
    setStep(2);
  }, []);

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/problem-maker')}>
            ← 문제 만들기
          </button>
          <span style={{ fontSize: 26 }}>🔄</span>
          <div>
            <h1 className="header-title">기존 문제 변형하기</h1>
            <p className="header-subtitle">시험 문제를 골라 나만의 문제로 바꿔봐요!</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge student-badge">학생</span>
          <span className="user-name">{realName}</span>
          <button onClick={studentLogout} className="btn btn-outline btn-sm">로그아웃</button>
        </div>
      </header>

      <main className={`dashboard-main${step === 3 ? ' pmod-main-wide' : ''}`}>
        <StepBanner step={step} />

        {editLoading ? (
          <div className="pmod-loading"><span className="spinner" /> 수정할 문제를 불러오는 중...</div>
        ) : (
        <>
        {step === 1 && (
          <ExamList onSelect={handleSelectExam} />
        )}
        {step === 2 && selectedExam && (
          <QuestionList
            exam={selectedExam}
            onSelect={handleSelectQuestion}
            onBack={handleBackToExams}
          />
        )}
        {step === 3 && selectedExam && selectedQ && (
          <QuestionEditor
            key={`${selectedExam.id}-${selectedQ.number}-${editFromBank?.bankDocId || 'new'}`}
            exam={selectedExam}
            original={selectedQ}
            onBack={handleBackToQuestions}
            editBankDocId={editFromBank?.bankDocId || null}
          />
        )}
        </>
        )}
      </main>
    </div>
  );
}
