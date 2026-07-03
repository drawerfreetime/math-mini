/**
 * StudentExamWrongNotes.js — 단원평가 채점 결과 확인 · 문항 O/X 수정 · 오답노트 (학생)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import HudFrame from './HudFrame';
import {
  getStudentByUUID,
  getExamWrongNote,
  findExamWrongNoteByMeta,
  saveExamWrongNote,
  saveWrongNoteReview,
  wrongNoteReviewId,
  getExamList,
  getExamQuestions,
  getClassHiddenExamResultKeys,
  getTeacherGeminiKeyForClass,
} from '../firebase/firestoreOps';
import { SUBMISSION_STATUS_PENDING_REVIEW, SUBMISSION_STATUS_APPROVED, SUBMISSION_STATUS_REJECTED } from '../constants/aiSubmissionPolicy';
import {
  examResultDocId,
  examResultLabel,
  formatScoredAt,
  filterVisibleExamResults,
  getWrongProblemNumbers,
  isPerfectExamResult,
  sortedResultRows,
  parseStudentProblemCorrect,
  getEffectiveResultRows,
  countCorrectFromRows,
  formatManualScoreLine,
  formatAiScoreDisplay,
  formatAiScoreMeta,
  formatAiScoreDetail,
  parseManualScore,
} from '../utils/examResults';
import {
  findExamForResult,
  buildProblemImageMap,
} from '../utils/examResultProblemImages';
import { resolveExamCurriculumForReview } from '../utils/examCurriculum';
import { anonymizeText } from '../utils/anonymizeText';
import { reviewWrongNoteRetry } from '../utils/reviewWrongNoteRetry';
import { useAsyncLock } from '../hooks/useAsyncLock.js';
import { elementaryScriptToLatex } from '../utils/elementaryMathScript';
import { mathTextToPlainString } from './ExamOCR';
import InlineMathEditor from './InlineMathEditor';
import ReviewMathToolsSidebar from './ReviewMathToolsSidebar';
import StudentAiFeedbackBox from './StudentAiFeedbackBox';
import { hasStudentVisibleAiFeedback } from '../utils/studentAiFeedback';
import './StudentExamWrongNotes.css';

const CHOICE_LABELS = ['①', '②', '③', '④', '⑤'];

const EMPTY_NOTE = {
  reason: '',
  prevention: '',
  solution: '',
  answer: '',
  aiReview: null,
  submittedAt: null,
  teacherStatus: null,
  teacherComment: '',
};

function buildNoteDraftFromSaved(saved, wrongNums) {
  const draft = {};
  wrongNums.forEach((n) => {
    const key = String(n);
    const detail = saved?.noteDetails?.[key];
    const legacyReason = saved?.notes?.[key];
    draft[key] = {
      reason: detail?.reason ?? (typeof legacyReason === 'string' ? legacyReason : '') ?? '',
      prevention: detail?.prevention ?? '',
      solution: detail?.solution ?? '',
      answer: detail?.answer ?? '',
      aiReview: detail?.aiReview ?? null,
      submittedAt: detail?.submittedAt ?? null,
      teacherStatus: detail?.teacherStatus ?? null,
      teacherComment: detail?.teacherComment ?? '',
    };
  });
  return draft;
}

function getQuestionByNumber(questions, num) {
  if (!Array.isArray(questions)) return null;
  return questions.find((q) => Number(q.number) === Number(num)) || null;
}

function questionPlainText(q) {
  if (!q) return '';
  const stem = mathTextToPlainString(q.question || q.text || '').trim();
  const bogi = mathTextToPlainString(q.bogi || '').trim();
  if (bogi) return `${stem}\n${bogi}`.trim();
  return stem;
}

function isWrongNoteRewriteable(draft) {
  if (!draft || typeof draft !== 'object') return false;
  if (draft.teacherStatus === SUBMISSION_STATUS_REJECTED) return true;
  if (draft.aiReview && !draft.aiReview.approved) return true;
  return false;
}

function buildNoteDetailsForSave(noteDraft) {
  const noteDetails = {};
  const notes = {};
  Object.entries(noteDraft).forEach(([k, v]) => {
    if (!v || typeof v !== 'object') return;
    const reason = String(v.reason ?? '').trim();
    const prevention = String(v.prevention ?? '').trim();
    const solution = String(v.solution ?? '').trim();
    const answer = String(v.answer ?? '').trim();
    if (reason || prevention || solution || answer || v.aiReview || v.submittedAt || v.teacherStatus) {
      noteDetails[k] = {
        reason,
        prevention,
        solution,
        answer,
        aiReview: v.aiReview ?? null,
        submittedAt: v.submittedAt ?? null,
        teacherStatus: v.teacherStatus ?? null,
        teacherComment: String(v.teacherComment ?? ''),
      };
    }
    if (reason) notes[k] = reason;
  });
  return { noteDetails, notes };
}

function ProblemThumb({ src, problemNumber, className = '' }) {
  if (!src) return null;
  return (
    <img
      className={`sewn-problem-thumb ${className}`.trim()}
      src={src}
      alt={`${problemNumber}번 문항`}
      loading="lazy"
    />
  );
}

function getWrongNoteProgress(draft) {
  if (!draft || typeof draft !== 'object') return 'empty';
  if (draft.teacherStatus === SUBMISSION_STATUS_APPROVED) return 'approved';
  if (draft.teacherStatus === SUBMISSION_STATUS_PENDING_REVIEW) return 'pending';
  if (draft.teacherStatus === SUBMISSION_STATUS_REJECTED) return 'rejected';
  if (draft.aiReview && !draft.aiReview.approved) return 'ai-fail';
  if (draft.submittedAt) return 'submitted';
  const hasContent = [draft.reason, draft.prevention, draft.solution, draft.answer].some(
    (v) => String(v ?? '').trim(),
  );
  return hasContent ? 'draft' : 'empty';
}

const WRONG_NOTE_PROGRESS_LABELS = {
  empty: '',
  draft: '작성 중',
  submitted: '제출됨',
  'ai-fail': '다시 확인',
  pending: '선생님 검토',
  rejected: '반려',
  approved: '완료',
};

function buildProblemCorrectMap(entry, savedNote) {
  const saved = parseStudentProblemCorrect(savedNote);
  const rows = sortedResultRows(entry);
  const map = {};
  rows.forEach((r) => {
    const n = Number(r.problemNumber);
    if (!Number.isFinite(n) || n < 1) return;
    map[n] = saved && Object.prototype.hasOwnProperty.call(saved, n) ? !!saved[n] : !!r.correct;
  });
  return map;
}

export default function StudentExamWrongNotes() {
  const navigate = useNavigate();
  const { studentSession, studentLogout } = useAuth();
  const { uuid, realName, classCode } = studentSession || {};

  const [loading, setLoading] = useState(true);
  const [examList, setExamList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [activeNoteDocId, setActiveNoteDocId] = useState('');
  const [noteDraft, setNoteDraft] = useState({});
  const [problemCorrect, setProblemCorrect] = useState({});
  const [saveMsg, setSaveMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadErr, setLoadErr] = useState('');

  const [problemImages, setProblemImages] = useState({});
  const [examQuestions, setExamQuestions] = useState([]);
  const [matchedExam, setMatchedExam] = useState(null);
  const [problemImagesLoading, setProblemImagesLoading] = useState(false);
  const [problemImagesHint, setProblemImagesHint] = useState('');
  const [imageFocus, setImageFocus] = useState(null);
  const { locked: noteSubmitLocked, acquire: acquireNoteSubmit, release: releaseNoteSubmit } = useAsyncLock();
  const [submittingNote, setSubmittingNote] = useState(null);
  const [noteErrors, setNoteErrors] = useState({});
  const [reviewMathOpen, setReviewMathOpen] = useState(false);
  const [activeWrongNoteNum, setActiveWrongNoteNum] = useState(null);
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

  const loadExams = useCallback(async () => {
    if (!uuid) return;
    setLoading(true);
    setLoadErr('');
    try {
      const [doc, hiddenKeys] = await Promise.all([
        getStudentByUUID(uuid),
        classCode ? getClassHiddenExamResultKeys(classCode) : Promise.resolve([]),
      ]);
      const latest = filterVisibleExamResults(doc?.examResults || [], hiddenKeys);
      setExamList(latest);
    } catch (e) {
      setLoadErr(e.message || '채점 결과를 불러오지 못했습니다.');
      setExamList([]);
    }
    setLoading(false);
  }, [uuid, classCode]);

  useEffect(() => { loadExams(); }, [loadExams]);

  useEffect(() => {
    if (!selected) {
      setProblemImages({});
      setExamQuestions([]);
      setMatchedExam(null);
      setProblemImagesHint('');
      return undefined;
    }

    let cancelled = false;
    (async () => {
      setProblemImagesLoading(true);
      setProblemImages({});
      setExamQuestions([]);
      setMatchedExam(null);
      setProblemImagesHint('');
      try {
        const exams = await getExamList({ forStudent: true });
        const matched = findExamForResult(selected, exams);
        if (!matched) {
          if (!cancelled) {
            setProblemImagesHint(
              '선생님 문제 보관함에서 같은 시험을 찾지 못했어요. 시험 제목·학년이 채점 시험과 같아야 해요.',
            );
          }
          return;
        }
        const questions = await getExamQuestions(matched.id, { forDisplay: true });
        const map = buildProblemImageMap(questions);
        if (!cancelled) {
          setMatchedExam(matched);
          setExamQuestions(questions);
          setProblemImages(map);
          if (!Object.keys(map).length) {
            setProblemImagesHint(
              '문제 보관함에 문항 이미지가 없어요. 선생님이 시험지 OCR 후 저장했는지 확인해 주세요.',
            );
          }
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) setProblemImagesHint('문항 이미지를 불러오지 못했어요.');
      } finally {
        if (!cancelled) setProblemImagesLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selected]);

  const effectiveRows = useMemo(() => {
    if (!selected) return [];
    return getEffectiveResultRows(selected, problemCorrect);
  }, [selected, problemCorrect]);

  const studentCounts = useMemo(
    () => countCorrectFromRows(effectiveRows),
    [effectiveRows],
  );

  const wrongNums = useMemo(
    () => getWrongProblemNumbers(selected, problemCorrect),
    [selected, problemCorrect],
  );

  useEffect(() => {
    if (!wrongNums.length) {
      setActiveWrongNoteNum(null);
      return;
    }
    setActiveWrongNoteNum((prev) => {
      if (prev != null && wrongNums.includes(Number(prev))) return prev;
      return wrongNums[0];
    });
  }, [wrongNums]);

  const wrongNoteDoneCount = useMemo(
    () => wrongNums.filter((n) => getWrongNoteProgress(noteDraft[String(n)]) === 'approved').length,
    [wrongNums, noteDraft],
  );

  const perfect = selected ? isPerfectExamResult(selected, problemCorrect) : false;
  const manualScoreLine = selected ? formatManualScoreLine(selected) : '';
  const aiCorrect = selected?.totalCorrect ?? 0;
  const aiTotal = selected?.totalCount ?? 0;

  const openExam = async (entry) => {
    setSelected(entry);
    setSaveMsg('');
    setActiveNoteDocId('');
    let saved = null;
    const defaultId = examResultDocId(entry);
    try {
      saved = await getExamWrongNote(uuid, defaultId);
      if (!saved) {
        // 선생님이 같은 시험을 다시 채점/저장해서 scoredAt이 바뀌면 문서 ID가 달라질 수 있음
        saved = await findExamWrongNoteByMeta(uuid, entry);
      }
    } catch (e) {
      console.error(e);
    }
    setActiveNoteDocId(saved?.id || defaultId);
    const pcMap = buildProblemCorrectMap(entry, saved);
    setProblemCorrect(pcMap);

    const wrong = getWrongProblemNumbers(entry, pcMap);
    setNoteDraft(buildNoteDraftFromSaved(saved, wrong));
    setNoteErrors({});
    setActiveWrongNoteNum(wrong.length > 0 ? wrong[0] : null);
  };

  const updateNoteField = (num, field, value) => {
    const key = String(num);
    setNoteDraft((prev) => {
      const current = prev[key] || EMPTY_NOTE;
      const next = { ...current, [field]: value };
      if (isWrongNoteRewriteable(current)) {
        next.aiReview = null;
        next.submittedAt = null;
        next.teacherStatus = null;
      }
      return { ...prev, [key]: next };
    });
  };

  const applyProblemCorrect = (problemNumber, willBeCorrect) => {
    const n = Number(problemNumber);
    setProblemCorrect((prev) => {
      if (!!prev[n] === willBeCorrect) return prev;
      setNoteDraft((nd) => {
        const next = { ...nd };
        const key = String(n);
        if (willBeCorrect) {
          delete next[key];
        } else {
          next[key] = next[key] || { ...EMPTY_NOTE };
        }
        return next;
      });
      setNoteErrors((errs) => {
        const next = { ...errs };
        delete next[String(n)];
        return next;
      });
      return { ...prev, [n]: willBeCorrect };
    });
  };

  const openProblemImage = (problemNumber) => {
    if (problemImg(problemNumber)) setImageFocus(Number(problemNumber));
  };

  const persistWrongNotes = async (draftOverride) => {
    const id = activeNoteDocId || examResultDocId(selected);
    const studentProblemCorrect = {};
    Object.entries(problemCorrect).forEach(([k, v]) => {
      studentProblemCorrect[String(k)] = !!v;
    });
    const draft = draftOverride || noteDraft;
    const { noteDetails, notes } = buildNoteDetailsForSave(draft);
    await saveExamWrongNote(uuid, id, {
      examName: selected.examName,
      grade: selected.grade,
      semester: selected.semester,
      unit: selected.unit,
      scoredAt: selected.scoredAt,
      notes,
      noteDetails,
      studentProblemCorrect,
      studentReviewedAt: new Date().toISOString(),
    });
  };

  const handleSaveReview = async () => {
    if (!uuid || !selected) return;
    setSaving(true);
    setSaveMsg('');
    try {
      await persistWrongNotes();
      setSaveMsg('내 확인 결과와 오답노트를 저장했어요.');
    } catch (e) {
      setSaveMsg('저장에 실패했어요. 잠시 후 다시 시도해 주세요.');
      console.error(e);
    }
    setSaving(false);
  };

  const handleSubmitNoteReview = async (num) => {
    if (noteSubmitLocked) return;
    if (!uuid || !selected) return;
    const key = String(num);
    const draft = noteDraft[key] || EMPTY_NOTE;
    const q = getQuestionByNumber(examQuestions, num);
    const reason = String(draft.reason ?? '').trim();
    const prevention = String(draft.prevention ?? '').trim();
    const solution = String(draft.solution ?? '').trim();
    const answer = String(draft.answer ?? '').trim();

    if (!reason) {
      setNoteErrors((prev) => ({ ...prev, [key]: '틀린 이유를 적어 주세요.' }));
      return;
    }
    if (!prevention) {
      setNoteErrors((prev) => ({
        ...prev,
        [key]: '같은 이유로 다시 틀리지 않으려면 어떻게 할지 적어 주세요.',
      }));
      return;
    }
    if (!mathTextToPlainString(solution).trim()) {
      setNoteErrors((prev) => ({ ...prev, [key]: '옳은 풀이 과정을 적어 주세요.' }));
      return;
    }
    const hasChoices = Array.isArray(q?.choices) && q.choices.length > 0;
    if (!hasChoices && !mathTextToPlainString(answer).trim()) {
      setNoteErrors((prev) => ({ ...prev, [key]: '정답을 입력하거나 선택해 주세요.' }));
      return;
    }
    if (hasChoices && !answer) {
      setNoteErrors((prev) => ({ ...prev, [key]: '정답을 선택해 주세요.' }));
      return;
    }

    if (!acquireNoteSubmit()) return;
    setSubmittingNote(num);
    setNoteErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    try {
      const questionText = questionPlainText(q);
      const bogiPlain = mathTextToPlainString(q?.bogi || '').trim();
      const choicesPlain = Array.isArray(q?.choices)
        ? q.choices.map((c) => mathTextToPlainString(String(c)))
        : null;
      const solutionPlain = mathTextToPlainString(solution).trim();
      const answerForReview = hasChoices ? String(answer).trim() : mathTextToPlainString(answer).trim();
      const teacherAnswerPlain = q?.answer != null ? mathTextToPlainString(String(q.answer)).trim() : '';

      const { anonymized: anonQuestion } = anonymizeText(questionText);
      const { anonymized: anonBogi } = bogiPlain ? anonymizeText(bogiPlain) : { anonymized: '' };
      const { anonymized: anonSolution } = solutionPlain ? anonymizeText(solutionPlain) : { anonymized: '' };
      const { anonymized: anonReason } = anonymizeText(reason);
      const { anonymized: anonPrevention } = anonymizeText(prevention);

      const curriculum = resolveExamCurriculumForReview(
        matchedExam || {
          grade: selected.grade,
          semester: selected.semester,
          unit: selected.unit,
        },
      );

      const teacherGeminiKey = classCode
        ? await getTeacherGeminiKeyForClass(classCode).catch(() => '')
        : '';

      const review = await reviewWrongNoteRetry({
        question: anonQuestion,
        bogi: anonBogi || null,
        choices: choicesPlain,
        teacherAnswer: teacherAnswerPlain,
        wrongReason: anonReason,
        preventionPlan: anonPrevention,
        solutionProcess: anonSolution,
        studentAnswer: answerForReview,
        requiresSolution: true,
        grade: curriculum.grade,
        semester: curriculum.semester,
        unit: curriculum.unit,
        teacherGeminiKey,
      });

      const aiReview = {
        approved: review.approved,
        feedback: review.feedback,
        hints: review.hints,
        aiMode: review.aiMode,
        checks: review.checks || null,
        reviewedAt: new Date().toISOString(),
        peerReview: review.peerReview,
      };

      const needsTeacherReview = review.approved || review.peerReview;
      const nextDraft = {
        ...noteDraft,
        [key]: {
          reason,
          prevention,
          solution,
          answer,
          aiReview,
          submittedAt: new Date().toISOString(),
          teacherStatus: needsTeacherReview ? SUBMISSION_STATUS_PENDING_REVIEW : null,
          teacherComment: '',
        },
      };
      setNoteDraft(nextDraft);
      await persistWrongNotes(nextDraft);

      if (needsTeacherReview && classCode) {
        const examId = activeNoteDocId || examResultDocId(selected);
        const reviewId = wrongNoteReviewId(examId, uuid, num);
        const gradeLabel = [selected.grade, selected.semester, selected.unit]
          .filter(Boolean)
          .join(' ');
        await saveWrongNoteReview({
          reviewId,
          examResultId: examId,
          examName: selected.examName || examResultLabel(selected),
          examGrade: gradeLabel,
          grade: selected.grade || '',
          semester: selected.semester || '',
          unit: selected.unit || '',
          scoredAt: selected.scoredAt || '',
          studentUUID: uuid,
          classCode,
          questionNumber: num,
          wrongReason: reason,
          preventionPlan: prevention,
          solutionProcess: solution,
          answer,
          questionText: questionText,
          bogi: bogiPlain || null,
          choices: choicesPlain,
          teacherAnswer: q?.answer != null ? String(q.answer) : '',
          status: SUBMISSION_STATUS_PENDING_REVIEW,
          aiNote: review.feedback || '',
          aiMode: review.aiMode || '',
          aiApproved: !!review.approved,
          aiChecks: review.checks || null,
          aiReviewStatus: 'done',
        });
      }

      setSaveMsg(
        needsTeacherReview
          ? `${num}번 오답노트 — AI 검토 완료! 선생님 승인을 기다려요.`
          : `${num}번 오답노트 — AI 검토 결과를 확인해 주세요.`,
      );
    } catch (e) {
      setNoteErrors((prev) => ({
        ...prev,
        [key]: e.message || 'AI 검토에 실패했어요.',
      }));
      console.error(e);
    } finally {
      setSubmittingNote(null);
      releaseNoteSubmit();
    }
  };

  const problemImg = (n) => problemImages[String(n)] || null;

  return (
    <div className="dashboard-container dashboard-container--brand-bg">
      <header className="dashboard-header">
        <div className="header-left">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              if (selected) {
                setSelected(null);
                setProblemCorrect({});
                setSaveMsg('');
                setImageFocus(null);
                setActiveWrongNoteNum(null);
              } else {
                navigate('/student');
              }
            }}
          >
            {selected ? '← 목록으로' : '← 메인 메뉴'}
          </button>
          <span style={{ fontSize: 26 }}>📝</span>
          <div>
            <h1 className="header-title">단원평가 오답노트</h1>
            <p className="header-subtitle">
              {selected
                ? '시험지를 보며 맞고 틀림을 확인하고, 틀린 문제만 정리해요'
                : '선생님이 채점한 결과를 확인해요'}
            </p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge student-badge">학생</span>
          <span className="user-name">{realName}</span>
          <button type="button" onClick={studentLogout} className="btn btn-outline btn-sm">로그아웃</button>
        </div>
      </header>

      <main className="dashboard-main sewn-page">
        {loadErr && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>⚠️ {loadErr}</div>
        )}

        {!selected && (
          <HudFrame>
            <div className="section-header">
              <h2 className="section-title">📋 채점 결과 목록</h2>
            </div>
            {loading ? (
              <p className="section-desc" style={{ textAlign: 'center', padding: '24px 0' }}>
                <span className="spinner" /> 불러오는 중…
              </p>
            ) : examList.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '28px 12px' }}>
                <div style={{ fontSize: 40, marginBottom: 8 }}>📭</div>
                <p className="section-desc" style={{ margin: 0 }}>
                  아직 단원평가 채점 결과가 없어요.
                  <br />
                  선생님이 스캔 채점을 저장하면 여기에 보여요.
                </p>
              </div>
            ) : (
              <div className="sewn-list">
                {examList.map((entry) => {
                  const total = entry.totalCount ?? entry.results?.length ?? 0;
                  const correct = entry.totalCorrect ?? 0;
                  const manual = formatManualScoreLine(entry);
                  return (
                    <button
                      key={examResultDocId(entry)}
                      type="button"
                      className="sewn-exam-card"
                      onClick={() => openExam(entry)}
                    >
                      <div>
                        <div className="sewn-exam-card-title">{examResultLabel(entry)}</div>
                        <div className="sewn-exam-card-meta">
                          {formatScoredAt(entry.scoredAt)}
                          {formatScoredAt(entry.scoredAt) ? ' · ' : ''}
                          {formatAiScoreMeta(correct, total)}
                          {manual ? ` · 선생님 점수 ${manual}` : ''}
                        </div>
                      </div>
                      <span className="sewn-exam-card-score">
                        {manual || formatAiScoreDisplay(correct, total)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </HudFrame>
        )}

        {selected && (
          <HudFrame>
            <div className="section-header">
              <h2 className="section-title">{examResultLabel(selected)}</h2>
            </div>
            {formatScoredAt(selected.scoredAt) && (
              <p className="section-desc" style={{ marginTop: -8 }}>
                채점일: {formatScoredAt(selected.scoredAt)}
              </p>
            )}

            <div className="sewn-score-summary">
              <span className="sewn-score-big">
                {formatAiScoreDisplay(studentCounts.correct, studentCounts.total)}
              </span>
            </div>
            <p className="section-desc" style={{ marginTop: -8, marginBottom: 12 }}>
              AI 자동 채점: {formatAiScoreDetail(aiCorrect, aiTotal)}
              {manualScoreLine ? (
                <>
                  {' '}
                  · 선생님이 기록한 점수: <strong>{manualScoreLine}</strong>
                </>
              ) : null}
              {parseManualScore(selected) != null &&
              studentCounts.correct !== aiCorrect ? (
                <span style={{ display: 'block', marginTop: 6, color: '#92400e' }}>
                  점수와 AI 문항 수가 다를 수 있어요. 아래에서 O·X를 눌러 맞고 틀림을 고쳐 주세요.
                </span>
              ) : null}
            </p>

            <p className="subsection-title" style={{ marginBottom: 8 }}>문제 사진 보기 · O/X 고르기</p>
            <p className="section-desc" style={{ marginTop: -4, marginBottom: 12 }}>
              문제 번호나 사진을 눌러 크게 보세요. AI채점이 잘못됐을 경우 내가 채점 결과를 바꿀 수 있습니다.
            </p>
            {problemImagesLoading && (
              <p className="section-desc" style={{ marginBottom: 12 }}>
                <span className="spinner" /> 문항 이미지 불러오는 중…
              </p>
            )}
            {!problemImagesLoading && problemImagesHint && (
              <p className="section-desc" style={{ marginBottom: 12, color: '#92400e' }}>
                {problemImagesHint}
              </p>
            )}
            <div className="sewn-grid">
              {effectiveRows.map((r) => {
                const n = r.problemNumber;
                const ok = !!r.correct;
                const src = problemImg(n);
                const aiRow = sortedResultRows(selected).find((x) => Number(x.problemNumber) === n);
                const aiOk = aiRow ? !!aiRow.correct : null;
                const changed = aiOk !== null && aiOk !== ok;
                return (
                  <div
                    key={n}
                    className={`sewn-grid-cell ${ok ? 'sewn-grid-cell--ok' : 'sewn-grid-cell--wrong'}${src ? ' sewn-grid-cell--with-thumb' : ''}${changed ? ' sewn-grid-cell--changed' : ''}`}
                  >
                    <div className="sewn-grid-cell-head">
                      <button
                        type="button"
                        className="sewn-grid-view-btn"
                        onClick={() => openProblemImage(n)}
                        disabled={!src}
                        title={src ? `${n}번 문제 크게 보기` : '문항 이미지 없음'}
                      >
                        <span className="sewn-grid-num">{n}번</span>
                      </button>
                      <div className="sewn-grid-ox-btns" role="group" aria-label={`${n}번 맞음 틀림`}>
                        <button
                          type="button"
                          className={`sewn-ox-btn sewn-ox-btn--o${ok ? ' sewn-ox-btn--active' : ''}`}
                          onClick={() => applyProblemCorrect(n, true)}
                          aria-pressed={ok}
                          title="맞음으로 표시"
                        >
                          O
                        </button>
                        <button
                          type="button"
                          className={`sewn-ox-btn sewn-ox-btn--x${!ok ? ' sewn-ox-btn--active' : ''}`}
                          onClick={() => applyProblemCorrect(n, false)}
                          aria-pressed={!ok}
                          title="틀림으로 표시"
                        >
                          X
                        </button>
                      </div>
                    </div>
                    {changed && (
                      <span className="sewn-grid-ai-hint">AI {aiOk ? 'O' : 'X'}</span>
                    )}
                    {src ? (
                      <button
                        type="button"
                        className="sewn-grid-thumb-btn"
                        onClick={() => openProblemImage(n)}
                        title={`${n}번 문제 크게 보기`}
                      >
                        <ProblemThumb src={src} problemNumber={n} />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {perfect && (
              <div className="sewn-perfect">
                <div className="sewn-perfect-emoji">🎉</div>
                <p className="sewn-perfect-text">
                  확인한 결과 모두 맞았어요!
                  <br />
                  대신 <strong>문제 만들기</strong>로 연습해 볼까요?
                </p>
                <button
                  type="button"
                  className="btn btn-primary btn-large"
                  onClick={() => navigate('/problem-maker')}
                >
                  ✏️ 문제 만들기로 가기
                </button>
              </div>
            )}

            <div className="sewn-actions" style={{ marginTop: perfect ? 16 : 0 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSaveReview}
                disabled={saving}
              >
                {saving ? '저장 중…' : '💾 내 확인 · 오답노트 저장'}
              </button>
            </div>

            {!perfect && wrongNums.length > 0 && (
              <>
                <p className="subsection-title" style={{ marginBottom: 8, marginTop: 20 }}>
                  틀린 문제 오답노트 ({wrongNums.length}문항)
                </p>
                <p className="section-desc" style={{ marginTop: -4, marginBottom: 12 }}>
                  한 문제씩 오답노트를 작성하고 제출해요. AI가 오답노트를 맞게 작성했는지 검토해요.
                  {' '}
                  곱셈·나눗셈 기호, 분수 기호, 단위 등은 오른쪽 수식/단위 입력기로 넣을 수 있어요.
                </p>
                <div className="sewn-note-picker-wrap">
                  <div className="sewn-note-picker" role="tablist" aria-label="틀린 문제 번호 선택">
                    {wrongNums.map((num) => {
                      const key = String(num);
                      const draft = noteDraft[key] || EMPTY_NOTE;
                      const progress = getWrongNoteProgress(draft);
                      const progressLabel = WRONG_NOTE_PROGRESS_LABELS[progress];
                      const isActive = activeWrongNoteNum === num;
                      return (
                        <button
                          key={num}
                          type="button"
                          role="tab"
                          aria-selected={isActive}
                          className={`sewn-note-picker-btn sewn-note-picker-btn--${progress}${isActive ? ' sewn-note-picker-btn--active' : ''}`}
                          onClick={() => setActiveWrongNoteNum(num)}
                        >
                          <span className="sewn-note-picker-num">{num}번</span>
                          {progressLabel ? (
                            <span className="sewn-note-picker-status">{progressLabel}</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  <p className="section-desc sewn-note-picker-summary">
                    완료 {wrongNoteDoneCount} / {wrongNums.length}문항
                  </p>
                </div>
                <div className="review-body sewn-note-math-layout">
                <div className="sewn-note-math-main">
                {activeWrongNoteNum != null && (() => {
                  const num = activeWrongNoteNum;
                  const key = String(num);
                  const draft = noteDraft[key] || EMPTY_NOTE;
                  const q = getQuestionByNumber(examQuestions, num);
                  const hasChoices = Array.isArray(q?.choices) && q.choices.length > 0;
                  const selectedChoice = Number(draft.answer);
                  const aiReview = draft.aiReview;
                  const isRejected = draft.teacherStatus === SUBMISSION_STATUS_REJECTED;
                  const isRewriteable = isWrongNoteRewriteable(draft);
                  const isSubmitting = submittingNote === num;
                  const feedbackItem = aiReview ? {
                    aiNote: aiReview.feedback,
                    aiApproved: aiReview.approved,
                    aiChecks: aiReview.checks,
                    aiReviewStatus: 'done',
                    teacherStatus: draft.teacherStatus,
                    teacherComment: draft.teacherComment,
                    wrongReason: draft.reason ?? '',
                  } : {
                    teacherStatus: draft.teacherStatus,
                    teacherComment: draft.teacherComment,
                    wrongReason: draft.reason ?? '',
                  };

                  return (
                    <div key={num} className="sewn-note-block">
                      <div className="sewn-note-block-top">
                        <div className="sewn-note-label">{num}번 — 오답노트</div>
                        <ProblemThumb src={problemImg(num)} problemNumber={num} className="sewn-problem-thumb--note" />
                      </div>

                      <div className="sewn-note-field">
                        <label className="sewn-note-field-label sewn-note-field-label--required" htmlFor={`sewn-reason-${num}`}>
                          1. 틀린 이유
                        </label>
                        <textarea
                          id={`sewn-reason-${num}`}
                          className="sewn-note-textarea"
                          placeholder="예) 계산 실수, 문제를 잘못 이해했어요…"
                          value={draft.reason ?? ''}
                          onChange={(e) => updateNoteField(num, 'reason', e.target.value)}
                        />
                      </div>

                      <div className="sewn-note-field">
                        <label
                          className="sewn-note-field-label sewn-note-field-label--required"
                          htmlFor={`sewn-prevention-${num}`}
                        >
                          2. 같은 이유로 다시 틀리지 않으려면 어떻게 해야 할까?
                        </label>
                        <textarea
                          id={`sewn-prevention-${num}`}
                          className="sewn-note-textarea"
                          placeholder="예) 곱하기 전에 자릿수를 먼저 확인할 거예요."
                          value={draft.prevention ?? ''}
                          onChange={(e) => updateNoteField(num, 'prevention', e.target.value)}
                        />
                      </div>

                      <div className="sewn-note-field">
                        <label
                          className="sewn-note-field-label sewn-note-field-label--required"
                          htmlFor={`sewn-solution-${num}`}
                        >
                          3. 옳은 풀이
                        </label>
                        <InlineMathEditor
                          className="sewn-note-math-editor"
                          value={draft.solution ?? ''}
                          onChange={(val) => updateNoteField(num, 'solution', val)}
                          multiline
                          compact
                          toolbar="none"
                          registerInsertBridge={registerInsertBridge}
                          placeholder="다시 풀 때의 풀이 과정을 단계별로 적어 보세요."
                        />
                      </div>

                      <div className="sewn-note-field">
                        <label className="sewn-note-field-label sewn-note-field-label--required">
                          4. 정답
                        </label>
                        {hasChoices ? (
                          <div className="sewn-note-choices" role="group" aria-label={`${num}번 정답 선택`}>
                            {q.choices.map((_, ci) => {
                              const choiceNum = ci + 1;
                              const isSelected = selectedChoice === choiceNum;
                              return (
                                <button
                                  key={ci}
                                  type="button"
                                  className={`sewn-note-choice-btn${isSelected ? ' sewn-note-choice-btn--selected' : ''}`}
                                  onClick={() => updateNoteField(num, 'answer', String(choiceNum))}
                                  aria-pressed={isSelected}
                                >
                                  {CHOICE_LABELS[ci]}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <InlineMathEditor
                            className="sewn-note-math-editor sewn-note-math-editor--answer"
                            value={draft.answer ?? ''}
                            onChange={(val) => updateNoteField(num, 'answer', val)}
                            multiline={false}
                            compact
                            toolbar="none"
                            registerInsertBridge={registerInsertBridge}
                            placeholder="정답을 입력하세요"
                          />
                        )}
                      </div>

                      {noteErrors[key] && (
                        <p className="section-desc" style={{ color: '#b91c1c', marginBottom: 8 }}>
                          ⚠️ {noteErrors[key]}
                        </p>
                      )}

                      <div className="sewn-note-submit-row">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => handleSubmitNoteReview(num)}
                          disabled={noteSubmitLocked || saving || draft.teacherStatus === SUBMISSION_STATUS_PENDING_REVIEW}
                        >
                          {isSubmitting
                            ? 'AI 검토 중…'
                            : isRejected || isRewriteable
                              ? '✏️ 다시 제출하기 · AI 검토'
                              : '✅ 제출하기 · AI 검토'}
                        </button>
                        {draft.submittedAt && (
                          <span className="section-desc" style={{ margin: 0 }}>
                            마지막 제출: {formatScoredAt(draft.submittedAt) || '—'}
                          </span>
                        )}
                      </div>

                      {hasStudentVisibleAiFeedback(feedbackItem) && (
                        <div style={{ marginTop: 8 }}>
                          <StudentAiFeedbackBox
                            item={feedbackItem}
                            hints={aiReview?.hints}
                            className="sewn-note-ai-feedback"
                          />
                        </div>
                      )}

                      {draft.teacherStatus === SUBMISSION_STATUS_PENDING_REVIEW && (
                        <div className="sewn-note-ai-result" style={{ marginTop: 8, background: '#fef9c3', borderColor: '#fde68a' }}>
                          <strong>⏳ 선생님 검토 대기 중</strong>
                          <p style={{ margin: '6px 0 0', fontSize: 13 }}>승인되면 오답노트가 완료됩니다.</p>
                        </div>
                      )}
                      {draft.teacherStatus === SUBMISSION_STATUS_APPROVED && (
                        <div className="sewn-note-ai-result sewn-note-ai-result--ok" style={{ marginTop: 8 }}>
                          <strong>✅ 선생님 승인 완료</strong>
                        </div>
                      )}
                      {isRejected && (
                        <p style={{ margin: '8px 0 0', fontSize: 13, color: '#6b7280' }}>
                          위 내용을 고친 다음 「다시 제출하기」를 누르면 AI가 다시 검토해요.
                        </p>
                      )}
                    </div>
                  );
                })()}
                </div>
                <ReviewMathToolsSidebar
                  mathOpen={reviewMathOpen}
                  onToggleMath={toggleReviewMathPanel}
                  onInsertMathScript={insertReviewMathFromScript}
                  onPickSymbol={insertReviewSymbol}
                />
                </div>
              </>
            )}

            {saveMsg && (
              <p
                className="section-desc"
                style={{
                  color: saveMsg.includes('실패') ? '#b91c1c' : '#15803d',
                  marginTop: 12,
                }}
              >
                {saveMsg}
              </p>
            )}
          </HudFrame>
        )}

        {imageFocus != null && problemImg(imageFocus) && (
          <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sewn-image-modal-title"
            onClick={() => setImageFocus(null)}
          >
            <div
              className="modal sewn-image-modal"
              style={{ maxWidth: 'min(96vw, 560px)' }}
              onClick={(ev) => ev.stopPropagation()}
            >
              <div className="modal-header">
                <h3 id="sewn-image-modal-title">{imageFocus}번</h3>
                <button
                  type="button"
                  className="modal-close"
                  onClick={() => setImageFocus(null)}
                  aria-label="닫기"
                >
                  ×
                </button>
              </div>
              <div className="modal-body" style={{ paddingTop: 12 }}>
                <img
                  className="sewn-image-modal-img"
                  src={problemImg(imageFocus)}
                  alt={`${imageFocus}번 문항`}
                />
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
