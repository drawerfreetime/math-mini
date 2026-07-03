/**
 * StudentDashboard.js — 학생 메인 화면
 *
 * ★ 개인정보 보호 중심 설계 ★
 * - 퀴즈 결과는 UUID로만 Firebase에 저장됩니다 (실명 없음)
 * - 화면에 표시되는 실명은 localStorage에서만 불러옵니다
 * - 서버에는 실명이 절대 전송되지 않습니다
 */
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  saveQuizResult, getQuizResults, getStudentByUUID, getStudentsByClass,
  getStudentExamWrongNotes,
} from '../firebase/firestoreOps';
import BrandHomeButton from './BrandHomeButton';
import InvestigatorBadgeShelf from './InvestigatorBadgeShelf';
import UnitStrategyCards from './UnitStrategyCards';
import CreativeOtterCollection from './CreativeOtterCollection';
import HudFrame from './HudFrame';
import CharacterLevelInfo from './CharacterLevelInfo';
import './StudentMenuSidebar.css';
import './MathMiniGames.css';
import { MINI_GAME_ID } from '../constants/miniGameDaily';
import MiniGameRankPanel from './MiniGameRankPanel';
import { STUDENT_LEVEL_NAMES, getStudentCharacterByLevel } from '../constants/studentCharacterLevels';
import {
  computeOtterStage,
  normalizeUnitProgress,
  pickActiveUnitKey,
  getUnitLabel,
  countCreativeOtters,
  hasAdeptBadge,
  hasLegendaryBadge,
  getGlobalProgressLevel,
} from '../constants/unitProgress';
import OtterEvolutionProgress from './OtterEvolutionProgress';
import { INVESTIGATION_BADGE_TIERS } from '../constants/investigationBadges';
import { filterVisibleExamResults, studentNeedsWrongNoteAction } from '../utils/examResults';
import { getClassHiddenExamResultKeys } from '../firebase/firestoreOps';
import { getStudentClassSolveAttempts } from '../firebase/classProblemBankOps';
import {
  getUnnotifiedExplorationRewards,
  markExplorationRewardsNotified,
  refreshStudentRolling30,
  syncMissingWrongNoteUnitPoints,
} from '../firebase/explorationRewardsOps';
import ExplorationRewardModal from './ExplorationRewardModal';
import ClassRankingList from './ClassRankingList';
import { buildClassRanking } from '../utils/classRanking';
import { getStudentRankingPoints } from '../constants/explorationRewards';
import {
  Notebook,
  CheckSquareOffset,
  PencilLine,
  Folder,
  ChalkboardTeacher,
  Users,
  Trophy,
  MagnifyingGlass,
  GameController,
  Lightning,
  Target,
  PlusCircle,
  Robot,
  Warning,
  RocketLaunch,
  Lock,
  Books,
  Barbell,
  Hash,
  CompassTool,
  MathOperations,
  Shapes,
  Divide,
  NumberCircleOne,
  Calculator,
  ChartBar,
  Star,
  Lightbulb,
  Confetti,
  SmileySad,
  BookOpen,
  FlagCheckered,
  Smiley,
  FloppyDisk,
  House,
  ArrowsClockwise,
} from '@phosphor-icons/react';

/** 당분간 AI 퀴즈 UI 비표시 (코드는 유지, 재활성화 시 true) */
const SHOW_AI_QUIZ = false;

// ─────────────────────────────────────────────
// 캐릭터 / 레벨 헬퍼
// ─────────────────────────────────────────────
const CHARACTER_BASE = `${process.env.PUBLIC_URL}/brand/student/character`;
const LEVEL_NAMES_MAP = STUDENT_LEVEL_NAMES;

function countEarnedUnitBadges(unitProgress) {
  const p = normalizeUnitProgress(unitProgress);
  let n = 0;
  for (const sid of Object.keys(p.approvedByStrategy || {})) {
    if (hasAdeptBadge(p, sid)) n += 1;
    if (hasLegendaryBadge(p, sid)) n += 1;
  }
  return n;
}

const TOTAL_POSSIBLE_BADGES = 6 * INVESTIGATION_BADGE_TIERS.length;

// ─────────────────────────────────────────────
// Claude API — 문제 내용만 전달, 학생 정보 없음
// ─────────────────────────────────────────────
async function generateMathProblems(topic, difficulty, count = 5) {
  const prompt = `초등학교 4학년 학생을 위한 수학 문제를 ${count}개 만들어주세요.
단원: ${topic}
난이도: ${difficulty}

다음 JSON 형식으로만 응답해주세요 (다른 설명 없이 JSON만):
[
  {
    "question": "문제 내용",
    "answer": "정답",
    "hint": "힌트",
    "explanation": "단계별 풀이 설명"
  }
]

규칙:
- 친근하고 이해하기 쉬운 문장 사용
- 정답은 하나만 존재하도록 명확하게 작성
- 힌트는 풀이 방향만 살짝 알려주기
- 풀이는 단계별로 간단히`;

  const response = await fetch('/api/claude/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`API 오류: ${response.status}`);
  const data = await response.json();
  const text = data.content[0].text;
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('문제 파싱 오류');
  return JSON.parse(jsonMatch[0]);
}

const TOPICS = [
  { id: 'place-value',    label: '큰 수',         Icon: Hash,           color: '#4f46e5' },
  { id: 'angles',         label: '각도',           Icon: CompassTool,    color: '#0891b2' },
  { id: 'multiplication', label: '곱셈과 나눗셈', Icon: MathOperations, color: '#059669' },
  { id: 'plane-figures',  label: '평면도형',       Icon: Shapes,         color: '#d97706' },
  { id: 'fractions',      label: '분수',           Icon: Divide,         color: '#dc2626' },
  { id: 'decimals',       label: '소수',           Icon: NumberCircleOne, color: '#7c3aed' },
  { id: 'mixed',          label: '혼합 계산',      Icon: Calculator,     color: '#be185d' },
  { id: 'measurement',    label: '막대그래프',     Icon: ChartBar,       color: '#065f46' },
];

const DIFFICULTIES = [
  { id: 'easy',   label: '쉬움',   stars: 1, color: '#22c55e' },
  { id: 'medium', label: '보통',   stars: 2, color: '#f59e0b' },
  { id: 'hard',   label: '어려움', stars: 3, color: '#ef4444' },
];

export default function StudentDashboard() {
  const navigate = useNavigate();
  const { studentSession, studentLogout } = useAuth();
  const { uuid, realName, classCode } = studentSession || {};

  const [view, setView]                   = useState('menu');

  const goStudentHome = useCallback(() => {
    setView('menu');
  }, []);
  const [selectedTopic, setSelectedTopic] = useState(null);
  const [selectedDiff,  setSelectedDiff]  = useState(null);
  const [problems, setProblems]           = useState([]);
  const [currentIndex, setCurrentIndex]   = useState(0);
  const [answers,   setAnswers]           = useState({});
  const [submitted, setSubmitted]         = useState({});
  const [showHint,  setShowHint]          = useState({});
  const [showExpl,  setShowExpl]          = useState({});
  const [score,     setScore]             = useState({ correct: 0, total: 0 });
  const [generating, setGenerating]       = useState(false);
  const [genError,   setGenError]         = useState('');

  // Firebase에서 불러온 통계 + 이력
  const [stats,       setStats]     = useState({ totalSolved: 0, totalCorrect: 0 });
  const [, setHistory] = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [unitProgressMap, setUnitProgressMap] = useState({});
  const [activeUnitKey, setActiveUnitKey] = useState('');
  const [creativeOtterCollection, setCreativeOtterCollection] = useState({});

  // 풀이 시간 측정
  const problemStartTime = useRef(null);
  const sdCharPanelRef = useRef(null);
  const sdRightColRef = useRef(null);
  const [solveTimes, setSolveTimes] = useState({});

  // 우리 반 랭킹
  const [classRanking, setClassRanking] = useState([]);
  const [classSolveAttempts, setClassSolveAttempts] = useState([]);
  const [rankLoading,  setRankLoading]  = useState(false);
  const [miniGameRankView, setMiniGameRankView] = useState(null);
  const [examResultCount, setExamResultCount] = useState(0);
  const [wrongNoteActionNeeded, setWrongNoteActionNeeded] = useState(false);
  const [pendingRewards, setPendingRewards] = useState([]);
  const [rewardModalOpen, setRewardModalOpen] = useState(false);
  const [rankingPoints, setRankingPoints] = useState(0);

  // UUID 기반으로 Firebase에서 통계 + 이력 로드
  const loadStudentData = useCallback(async () => {
    if (!uuid) return;
    setLoadingData(true);
    try {
      await syncMissingWrongNoteUnitPoints(uuid);
      const [studentDoc, results, hiddenKeys, solveAttempts, examWrongNotes] = await Promise.all([
        getStudentByUUID(uuid),
        getQuizResults(uuid, 20),
        classCode ? getClassHiddenExamResultKeys(classCode) : Promise.resolve([]),
        classCode ? getStudentClassSolveAttempts(uuid, classCode) : Promise.resolve([]),
        getStudentExamWrongNotes(uuid),
      ]);
      if (studentDoc) {
        const visibleExams = filterVisibleExamResults(studentDoc.examResults || [], hiddenKeys);
        setStats({
          totalSolved:  studentDoc.totalSolved  || 0,
          totalCorrect: studentDoc.totalCorrect || 0,
        });
        setUnitProgressMap(studentDoc.unitProgress || {});
        setActiveUnitKey(pickActiveUnitKey(studentDoc));
        setCreativeOtterCollection(studentDoc.creativeOtterCollection || {});
        setRankingPoints(getStudentRankingPoints(studentDoc));
        setExamResultCount(visibleExams.length);
        setWrongNoteActionNeeded(studentNeedsWrongNoteAction(visibleExams, examWrongNotes));
      } else {
        setUnitProgressMap({});
        setActiveUnitKey('');
        setCreativeOtterCollection({});
        setRankingPoints(0);
        setExamResultCount(0);
        setWrongNoteActionNeeded(false);
      }
      setHistory(results);
      setClassSolveAttempts(solveAttempts);

      const unnotified = await getUnnotifiedExplorationRewards(uuid);
      await refreshStudentRolling30(uuid);
      if (unnotified.length > 0) {
        setPendingRewards(unnotified);
        setRewardModalOpen(true);
      }
    } catch (err) {
      console.error('데이터 로드 오류:', err);
    }
    setLoadingData(false);
  }, [uuid, classCode]);

  useEffect(() => { loadStudentData(); }, [loadStudentData]);

  useEffect(() => {
    if (view === 'mypage' && uuid) loadStudentData();
  }, [view, uuid, loadStudentData]);

  const loadClassRanking = useCallback(async () => {
    const classCode = studentSession?.classCode;
    if (!classCode || !uuid) return;
    setRankLoading(true);
    try {
      const students = await getStudentsByClass(classCode);
      setClassRanking(buildClassRanking(students, { highlightUuid: uuid, selfRealName: realName }));
    } catch (err) {
      console.error('랭킹 로드 오류:', err);
    }
    setRankLoading(false);
  }, [studentSession?.classCode, uuid, realName]);

  useEffect(() => { loadClassRanking(); }, [loadClassRanking]);

  const syncHomeRightColHeight = useCallback(() => {
    const panel = sdCharPanelRef.current;
    const col = sdRightColRef.current;
    if (!panel || !col) return;
    if (window.matchMedia('(max-width: 860px)').matches) {
      col.style.height = '';
      return;
    }
    col.style.height = '';
    const leftH = panel.offsetHeight;
    const naturalH = col.offsetHeight;
    if (leftH > naturalH) {
      col.style.height = `${leftH}px`;
    }
  }, []);

  useLayoutEffect(() => {
    if (view !== 'menu') return undefined;
    syncHomeRightColHeight();
    const panel = sdCharPanelRef.current;
    if (!panel) return undefined;
    const ro = new ResizeObserver(syncHomeRightColHeight);
    ro.observe(panel);
    window.addEventListener('resize', syncHomeRightColHeight);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', syncHomeRightColHeight);
    };
  }, [view, syncHomeRightColHeight, loadingData]);

  const handleRewardModalConfirm = useCallback(async () => {
    if (!uuid || !pendingRewards.length) {
      setRewardModalOpen(false);
      return;
    }
    const ids = pendingRewards.map((r) => r.id);
    try {
      await markExplorationRewardsNotified(uuid, ids);
    } catch (e) {
      console.warn('[reward notify]', e);
    }
    setPendingRewards([]);
    setRewardModalOpen(false);
    loadClassRanking();
    loadStudentData();
  }, [uuid, pendingRewards, loadClassRanking, loadStudentData]);

  useEffect(() => {
    if (SHOW_AI_QUIZ && view === 'quiz') problemStartTime.current = Date.now();
  }, [view, currentIndex]);

  useEffect(() => {
    if (!SHOW_AI_QUIZ && (view === 'quiz' || view === 'result')) setView('menu');
  }, [view]);

  // ─── 퀴즈 시작 ───
  async function handleStartQuiz() {
    if (!selectedTopic || !selectedDiff) return;
    setGenerating(true); setGenError('');
    try {
      const topicLabel = TOPICS.find((t) => t.id === selectedTopic)?.label;
      const diffLabel  = DIFFICULTIES.find((d) => d.id === selectedDiff)?.label;
      const newProblems = await generateMathProblems(topicLabel, diffLabel, 5);
      setProblems(newProblems);
      setCurrentIndex(0);
      setAnswers({}); setSubmitted({}); setShowHint({}); setShowExpl({});
      setSolveTimes({}); setScore({ correct: 0, total: 0 });
      setView('quiz');
    } catch (err) {
      setGenError('문제 생성 실패: ' + err.message);
    }
    setGenerating(false);
  }

  // ─── 답 제출 (풀이 시간 기록) ───
  function handleSubmitAnswer() {
    const elapsed = problemStartTime.current
      ? Math.round((Date.now() - problemStartTime.current) / 1000)
      : 0;
    const correct = answers[currentIndex]?.trim() === problems[currentIndex]?.answer?.trim();
    setSubmitted({ ...submitted, [currentIndex]: { submitted: true, correct } });
    setSolveTimes((prev) => ({ ...prev, [currentIndex]: elapsed }));
    setScore((prev) => ({ correct: prev.correct + (correct ? 1 : 0), total: prev.total + 1 }));
  }

  // ─── 퀴즈 완료 → UUID로만 Firebase 저장 (실명 없음) ───
  async function handleFinishQuiz() {
    const finalCorrect = Object.values(submitted).filter((s) => s.correct).length;
    const finalTotal   = problems.length;
    const topicLabel   = TOPICS.find((t) => t.id === selectedTopic)?.label || selectedTopic;
    const diffLabel    = DIFFICULTIES.find((d) => d.id === selectedDiff)?.label || selectedDiff;

    const problemDetails = problems.map((p, i) => ({
      questionNumber: i + 1,
      isCorrect:  submitted[i]?.correct ?? false,
      solveTime:  solveTimes[i] ?? 0,
    }));

    try {
      // UUID로만 저장 — 실명은 서버로 전송하지 않습니다
      await saveQuizResult(uuid, {
        topic:          selectedTopic,
        topicLabel,
        difficulty:     selectedDiff,
        difficultyLabel: diffLabel,
        problems:       problemDetails,
        totalProblems:  finalTotal,
        correctCount:   finalCorrect,
        score:          Math.round((finalCorrect / finalTotal) * 100),
      });
      await loadStudentData();
    } catch (err) {
      console.error('결과 저장 오류:', err);
    }

    setScore({ correct: finalCorrect, total: finalTotal });
    setView('result');
  }

  const currentProblem = problems[currentIndex];
  const isAnswered     = submitted[currentIndex]?.submitted;

  // ═══════════════ 마이페이지 (수사관 뱃지 진열대) ═══════════════
  if (view === 'mypage') {
    const classSolveCorrect = classSolveAttempts.filter((a) => a.solvedCorrect).length;
    const classSolveTotal = classSolveAttempts.length;
    const activeProgress = normalizeUnitProgress(unitProgressMap[activeUnitKey]);
    const unitLabel = activeUnitKey ? getUnitLabel(activeUnitKey) : '아직 활동한 단원이 없어요';

    return (
      <div className="dashboard-container dashboard-container--brand-bg">
        <header className="dashboard-header">
          <div className="header-left">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setView('menu')}>
              ← 메인 메뉴
            </button>
            <MagnifyingGlass size={26} weight="duotone" aria-hidden />
            <div>
              <h1 className="header-title">마이페이지</h1>
              <p className="header-subtitle">
                <strong>{realName}</strong>님의 활동 기록을 모아 두었어요.
              </p>
            </div>
          </div>
          <div className="header-right">
            <span className="user-badge student-badge">학생</span>
            <span className="user-name">{realName}</span>
            <button onClick={studentLogout} className="btn btn-outline btn-sm">로그아웃</button>
          </div>
        </header>

        <main className="dashboard-main">
          <div style={{
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: 10,
            padding: '10px 16px',
            fontSize: 13,
            color: '#15803d',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 20,
          }}
          >
            <Lock size={16} weight="duotone" aria-hidden />
            학습·뱃지 데이터는 UUID로만 저장됩니다.
          </div>

          <InvestigatorBadgeShelf
            unitProgress={activeProgress}
            loading={loadingData}
          />

          <div style={{ marginTop: 20 }}>
            <UnitStrategyCards unitProgress={activeProgress} loading={loadingData} />
          </div>

          <div style={{ marginTop: 20 }}>
            <CreativeOtterCollection
              creativeOtterCollection={creativeOtterCollection}
              loading={loadingData}
            />
          </div>

          <HudFrame style={{ marginTop: 20 }}>
            <div className="section-header">
              <h2 className="section-title">
                <Books size={20} weight="duotone" className="inline-block mr-2" aria-hidden />
                이번 단원
              </h2>
            </div>
            <p className="section-desc">
              {activeUnitKey ? (
                <>
                  <strong>{unitLabel}</strong>
                  {' '}(탐구점수 {activeProgress.points} · 풀기 {activeProgress.solveDone}회)
                </>
              ) : (
                '학급 문제를 풀거나 만들면 단원별 진행이 쌓여요.'
              )}
            </p>
          </HudFrame>

          <HudFrame>
            <div className="section-header">
              <h2 className="section-title">
                <ChalkboardTeacher size={20} weight="duotone" className="inline-block mr-2" aria-hidden />
                학급 문제은행 풀이 기록
              </h2>
            </div>
            <p className="section-desc">
              친구가 만든 문제를 푼 결과예요.
              {classSolveTotal > 0 && (
                <span style={{ marginLeft: 6, fontWeight: 600, color: '#4f46e5' }}>
                  {classSolveTotal}문제 중 {classSolveCorrect}문제 맞혔어요
                </span>
              )}
            </p>
            {loadingData ? (
              <p className="section-desc" style={{ textAlign: 'center' }}>불러오는 중…</p>
            ) : classSolveAttempts.length === 0 ? (
              <p className="section-desc" style={{ color: '#6b7280' }}>
                아직 푼 학급 문제가 없어요.
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{ marginLeft: 8 }}
                  onClick={() => navigate('/class-problems')}
                >
                  학급 문제 풀기
                </button>
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {classSolveAttempts.map((row) => (
                  <li
                    key={row.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '10px 12px',
                      border: '1px solid #e5e7eb',
                      borderRadius: 8,
                      background: row.solvedCorrect ? '#f0fdf4' : '#fef2f2',
                    }}
                  >
                    <div>
                      <strong style={{ color: '#4c1d95' }}>{row.problemLabel || row.problemId}</strong>
                      {row.examTitle && (
                        <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>{row.examTitle}</span>
                      )}
                    </div>
                    <span style={{ fontWeight: 700, color: row.solvedCorrect ? '#15803d' : '#b91c1c', whiteSpace: 'nowrap' }}>
                      {row.solvedCorrect ? '⭕ 정답' : '❌ 오답'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </HudFrame>
        </main>
      </div>
    );
  }

  // ═══════════════ 메인 메뉴 ═══════════════
  if (view === 'menu') {
    const activeProgress = normalizeUnitProgress(unitProgressMap[activeUnitKey]);
    const level = computeOtterStage(activeProgress);
    const globalLevel = getGlobalProgressLevel(level, activeProgress.stagePoints);
    const imgSrc = `${CHARACTER_BASE}/otter-${level}.png`;
    const characterName = LEVEL_NAMES_MAP[level] || getStudentCharacterByLevel(level).name;
    const unitLabel = activeUnitKey ? getUnitLabel(activeUnitKey) : null;
    const creativeCount = countCreativeOtters({ creativeOtterCollection });
    const accPct = stats.totalSolved > 0
      ? Math.round((stats.totalCorrect / stats.totalSolved) * 100)
      : 0;

    const earnedBadgeCount = countEarnedUnitBadges(activeProgress);

    const myRankEntry = classRanking.find((r) => r.isSelf);
    const myRank = myRankEntry ? myRankEntry.rank : null;

    return (
      <>
      <div className="dashboard-container dashboard-container--brand-bg">
        <header className="dashboard-header">
          <div className="header-left">
            <BrandHomeButton onClick={goStudentHome} />
            <div>
              <h1 className="header-title">수학 학습 홈</h1>
              <p className="header-subtitle sd-header-greeting">
                안녕하세요, <strong>{realName}</strong>님! 오늘도 열심히 해봐요
                <Barbell size={16} weight="duotone" aria-hidden />
              </p>
            </div>
          </div>
          <div className="header-right">
            <span className="user-badge student-badge">학생</span>
            <span className="user-name">{realName}</span>
            <button onClick={studentLogout} className="btn btn-outline btn-sm">로그아웃</button>
          </div>
        </header>

        <main className="sd-page">
          {/* ── 상단 그리드: 캐릭터 카드 | 오른쪽 컬럼 ── */}
          <div className="sd-top-grid">

            {/* 왼쪽: 캐릭터 카드 */}
            <div className="sd-char-panel big-frame-glow" ref={sdCharPanelRef}>
              <section className="big-frame sd-char-inner">
                <div className="sd-char-img-wrap">
                  {level < 4 && (
                    <span className="sd-char-lv-badge">레벨 {globalLevel}</span>
                  )}
                  <img src={imgSrc} alt={characterName} className="sd-char-img" />
                </div>

                <p className="sd-char-name">{realName || '학생'}</p>
                {unitLabel && (
                  <p className="sd-char-unit-label" style={{ fontSize: 12, color: '#6b7280', margin: '0 0 4px' }}>
                    {unitLabel}
                  </p>
                )}
                <CharacterLevelInfo level={level} />

                <OtterEvolutionProgress unitProgress={activeProgress} rankingPoints={rankingPoints} />

                {creativeCount > 0 && (
                  <p className="sd-char-xp-text" style={{ marginTop: 4 }}>
                    창의달 수집 {creativeCount}개
                  </p>
                )}

                <div className="sd-char-stats-row">
                  <div className="sd-char-stat">
                    <div className="sd-char-stat-val">{loadingData ? '…' : stats.totalSolved}</div>
                    <div className="sd-char-stat-lbl">풀이</div>
                  </div>
                  <div className="sd-char-stat">
                    <div className="sd-char-stat-val">{loadingData ? '…' : `${accPct}%`}</div>
                    <div className="sd-char-stat-lbl">정답률</div>
                  </div>
                  <div className="sd-char-stat sd-char-stat--rank">
                    <div className="sd-char-stat-val">
                      {loadingData || rankLoading ? '…' : myRank ? `#${myRank}` : '-'}
                    </div>
                    <div className="sd-char-stat-lbl">순위</div>
                  </div>
                </div>

                <hr className="sidebar-divider" />

                <div className="sd-badge-section">
                  <div className="sd-badge-title-row">
                    <span>이번 단원 뱃지</span>
                    <span className="sd-badge-count">{earnedBadgeCount}/{TOTAL_POSSIBLE_BADGES}</span>
                  </div>
                  <div className="sd-badge-icons">
                    {earnedBadgeCount > 0 && (
                      <span className="sd-badge-icon" title="획득한 뱃지">
                        {earnedBadgeCount}개 획득
                      </span>
                    )}
                  </div>
                </div>

                <button type="button" className="sidebar-mypage-btn" onClick={() => setView('mypage')}>
                  <MagnifyingGlass size={14} weight="duotone" className="mr-1" aria-hidden />
                  인벤토리 전체 보기
                </button>
              </section>
            </div>

            {/* 오른쪽 컬럼 */}
            <div className="sd-right-col" ref={sdRightColRef}>

              {/* 맨 위: 단원평가 오답노트 */}
              <HudFrame className={wrongNoteActionNeeded ? 'sd-home-frame--alert' : ''}>
                <div className="sd-home-wrong-note-layout">
                  <div className="sd-home-wrong-note-layout__left">
                    <h2 className="section-title sd-home-wrong-note-layout__title">
                      <Notebook size={20} weight="duotone" className="inline-block mr-2" aria-hidden />
                      단원평가 오답노트
                    </h2>
                    <p
                      className={
                        wrongNoteActionNeeded
                          ? 'sd-home-wrong-note-layout__foot sd-home-wrong-note-alert-msg'
                          : 'sd-home-wrong-note-layout__foot'
                      }
                    >
                      {loadingData
                        ? '불러오는 중…'
                        : wrongNoteActionNeeded
                          ? '틀린 문제 오답노트를 작성해 주세요!'
                          : examResultCount > 0
                            ? `확인할 채점 결과 ${examResultCount}건`
                            : '아직 채점 결과가 없어요. 선생님이 저장하면 보여요.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`btn sd-home-secondary-btn sd-home-wrong-note-btn${wrongNoteActionNeeded ? ' btn-danger' : ' btn-primary'}`}
                    onClick={() => navigate('/student/exam-wrong-notes')}
                  >
                    <CheckSquareOffset size={15} weight="duotone" className="mr-1.5" aria-hidden />
                    채점 결과 · 오답노트
                  </button>
                </div>
              </HudFrame>

              {/* 가운데: 새 문제 만들기 (1순위) */}
              <HudFrame className="sd-home-make-frame">
                <div className="sd-home-card-head">
                  <h2 className="section-title sd-home-card-head__title">
                    <PencilLine size={20} weight="duotone" className="inline-block mr-2" aria-hidden />
                    새 문제 만들기
                  </h2>
                  <p className="sd-home-card-head__desc">
                    시험 문제를 변형하거나
                    <br />
                    새로운 문제를 직접 만들어 봐요!
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary sd-home-primary-btn"
                  onClick={() => navigate('/problem-maker')}
                >
                  <PencilLine size={20} weight="duotone" className="mr-1.5" aria-hidden />
                  문제 만들기 시작하기
                </button>
                <button
                  type="button"
                  className="sd-home-text-link"
                  onClick={() => navigate('/problem-bank')}
                >
                  <Folder size={15} weight="duotone" aria-hidden />
                  내 문제 저장소
                </button>
              </HudFrame>

              {/* 학급 문제 은행 (2순위) */}
              <HudFrame>
                <div className="sd-home-card-head">
                  <h2 className="section-title sd-home-card-head__title">
                    <Users size={20} weight="duotone" className="inline-block mr-2" aria-hidden />
                    학급 문제 은행
                  </h2>
                </div>
                <button
                  type="button"
                  className="btn btn-outline sd-home-secondary-btn sd-class-solve-btn"
                  onClick={() => navigate('/class-problems')}
                >
                  <ChalkboardTeacher size={15} weight="duotone" className="mr-1.5" aria-hidden />
                  학급 문제 풀기
                </button>
              </HudFrame>

            </div>
          </div>

          {/* ── 하단(넓게): 우리 반 랭킹 ── */}
          <HudFrame>
            <div className="section-header">
              <h2 className="section-title">
                <Trophy size={20} weight="duotone" className="inline-block mr-2" aria-hidden />
                우리 반 랭킹 (최근 30일)
              </h2>
            </div>
            <ClassRankingList rows={classRanking} loading={rankLoading} />
          </HudFrame>

          {/* ── 미니게임 ── */}
          <HudFrame className="sd-minigame-frame">
            <div className="section-header">
              <h2 className="section-title">
                <GameController size={20} weight="duotone" className="inline-block mr-2" aria-hidden />
                미니게임
              </h2>
            </div>
            <div className="sd-game-shortcuts sd-game-shortcuts--panel">
              <div className="sd-game-shortcut-pair">
                <button
                  type="button"
                  className="sd-game-shortcut-btn"
                  onClick={() => navigate('/student/games/speed-quiz')}
                >
                  <Lightning size={18} weight="duotone" className="mr-1" aria-hidden />
                  스피드 퀴즈
                </button>
                <button
                  type="button"
                  className={`sd-game-rank-btn${miniGameRankView === 'speed_quiz' ? ' sd-game-rank-btn--active' : ''}`}
                  onClick={() => setMiniGameRankView((v) => (v === 'speed_quiz' ? null : 'speed_quiz'))}
                >
                  랭킹 보기
                </button>
              </div>
              <div className="sd-game-shortcut-pair">
                <button
                  type="button"
                  className="sd-game-shortcut-btn"
                  onClick={() => navigate('/student/games/whack')}
                >
                  <Target size={18} weight="duotone" className="mr-1" aria-hidden />
                  답 맞히기
                </button>
                <button
                  type="button"
                  className={`sd-game-rank-btn${miniGameRankView === 'whack' ? ' sd-game-rank-btn--active' : ''}`}
                  onClick={() => setMiniGameRankView((v) => (v === 'whack' ? null : 'whack'))}
                >
                  랭킹 보기
                </button>
              </div>
              <div className="sd-game-shortcut-pair">
                <button
                  type="button"
                  className="sd-game-shortcut-btn"
                  onClick={() => navigate('/student/games/make-ten')}
                >
                  <PlusCircle size={18} weight="duotone" className="mr-1" aria-hidden />
                  10만들기
                </button>
                <button
                  type="button"
                  className={`sd-game-rank-btn${miniGameRankView === 'make_ten' ? ' sd-game-rank-btn--active' : ''}`}
                  onClick={() => setMiniGameRankView((v) => (v === 'make_ten' ? null : 'make_ten'))}
                >
                  랭킹 보기
                </button>
              </div>
            </div>
            {miniGameRankView === 'speed_quiz' && (
              <MiniGameRankPanel
                open
                variant="single"
                gameId={MINI_GAME_ID.SPEED_QUIZ}
              />
            )}
            {miniGameRankView === 'whack' && (
              <MiniGameRankPanel
                open
                variant="single"
                gameId={MINI_GAME_ID.WHACK}
              />
            )}
            {miniGameRankView === 'make_ten' && (
              <MiniGameRankPanel open variant="make_ten" />
            )}
          </HudFrame>

          {SHOW_AI_QUIZ && (
          <HudFrame>
            <div className="section-header">
              <h2 className="section-title">
                <Robot size={20} weight="duotone" className="inline-block mr-2" aria-hidden />
                AI 수학 문제 풀기
              </h2>
            </div>
            <p className="section-desc">단원과 난이도를 선택하면 AI가 나만을 위한 문제를 만들어 줘요!</p>

            <div className="sd-ai-selectors">
              <div className="subsection">
                <h3 className="subsection-title">1. 단원 선택</h3>
                <div className="topic-grid">
                  {TOPICS.map((t) => (
                    <button key={t.id}
                      className={`topic-card ${selectedTopic === t.id ? 'topic-card-selected' : ''}`}
                      style={{
                        borderColor:     selectedTopic === t.id ? t.color : undefined,
                        backgroundColor: selectedTopic === t.id ? t.color + '15' : undefined,
                      }}
                      onClick={() => setSelectedTopic(t.id)}
                    >
                      <span className="topic-icon">
                        <t.Icon size={26} weight="duotone" aria-hidden />
                      </span>
                      <span className="topic-label">{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="subsection">
                <h3 className="subsection-title">2. 난이도 선택</h3>
                <div className="difficulty-grid">
                  {DIFFICULTIES.map((d) => (
                    <button key={d.id}
                      className={`difficulty-card ${selectedDiff === d.id ? 'difficulty-card-selected' : ''}`}
                      style={{
                        borderColor:     selectedDiff === d.id ? d.color : undefined,
                        backgroundColor: selectedDiff === d.id ? d.color + '15' : undefined,
                      }}
                      onClick={() => setSelectedDiff(d.id)}
                    >
                      <span className="difficulty-icon">
                        {Array.from({ length: d.stars }).map((_, i) => (
                          <Star key={i} size={20} weight="duotone" aria-hidden />
                        ))}
                      </span>
                      <span className="difficulty-label">{d.label}</span>
                    </button>
                  ))}
                </div>

                {genError && (
                  <div className="alert alert-error" style={{ marginTop: 12 }}>
                    <Warning size={16} weight="duotone" aria-hidden />
                    {genError}
                  </div>
                )}

                <button
                  className="btn btn-primary btn-large"
                  style={{ width: '100%', marginTop: 16 }}
                  onClick={handleStartQuiz}
                  disabled={!selectedTopic || !selectedDiff || generating}
                >
                  {generating
                    ? <><span className="spinner" /> AI가 문제를 만드는 중...</>
                    : (
                      <>
                        <RocketLaunch size={16} weight="duotone" className="mr-1.5" aria-hidden />
                        문제 시작하기!
                      </>
                    )}
                </button>
              </div>
            </div>
          </HudFrame>
          )}
        </main>
      </div>
      <ExplorationRewardModal
        open={rewardModalOpen}
        items={pendingRewards}
        onConfirm={handleRewardModalConfirm}
      />
      </>
    );
  }

  // ═══════════════ 퀴즈 화면 (SHOW_AI_QUIZ 일 때만) ═══════════════
  if (SHOW_AI_QUIZ && view === 'quiz') {
    const topicLabel = TOPICS.find((t) => t.id === selectedTopic)?.label;
    const diffLabel  = DIFFICULTIES.find((d) => d.id === selectedDiff)?.label;

    return (
      <div className="quiz-container">
        <div className="quiz-header">
          <div className="quiz-header-top">
            <button className="btn btn-ghost btn-sm" onClick={() => setView('menu')}>← 메뉴로</button>
            <div className="quiz-info">
              <span className="quiz-topic">{topicLabel}</span>
              <span className="quiz-difficulty">{diffLabel}</span>
            </div>
            <span className="quiz-progress-text">{currentIndex + 1} / {problems.length}</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${(currentIndex / problems.length) * 100}%` }} />
          </div>
        </div>

        <div className="quiz-main">
          <div className="problem-card">
            <div className="problem-number">문제 {currentIndex + 1}</div>
            <p className="problem-text">{currentProblem?.question}</p>

            {!isAnswered && (
              <button className="hint-btn"
                onClick={() => setShowHint({ ...showHint, [currentIndex]: true })}>
                <Lightbulb size={16} weight="duotone" className="mr-1" aria-hidden />
                힌트 보기
              </button>
            )}
            {showHint[currentIndex] && currentProblem?.hint && (
              <div className="hint-box">
                <Lightbulb size={16} weight="duotone" className="mr-1" aria-hidden />
                힌트: {currentProblem.hint}
              </div>
            )}

            <div className="answer-section">
              <label className="form-label">내 답:</label>
              <input
                type="text"
                className={`form-input answer-input ${isAnswered
                  ? submitted[currentIndex]?.correct ? 'input-correct' : 'input-wrong'
                  : ''}`}
                placeholder="답을 입력하세요"
                value={answers[currentIndex] || ''}
                onChange={(e) => setAnswers({ ...answers, [currentIndex]: e.target.value })}
                disabled={isAnswered}
                onKeyDown={(e) => { if (e.key === 'Enter' && !isAnswered) handleSubmitAnswer(); }}
              />
            </div>

            {isAnswered && (
              <div className={`result-box ${submitted[currentIndex]?.correct ? 'result-correct' : 'result-wrong'}`}>
                {submitted[currentIndex]?.correct
                  ? (
                    <>
                      <Confetti size={18} weight="duotone" className="mr-1" aria-hidden />
                      정답입니다!
                    </>
                  )
                  : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <SmileySad size={18} weight="duotone" aria-hidden />
                      틀렸어요. 정답: <strong>{currentProblem?.answer}</strong>
                    </span>
                  )}
              </div>
            )}

            {isAnswered && (
              <button className="explanation-btn"
                onClick={() => setShowExpl({ ...showExpl, [currentIndex]: !showExpl[currentIndex] })}>
                {showExpl[currentIndex] ? '풀이 닫기 ▲' : (
                  <>
                    <BookOpen size={16} weight="duotone" className="mr-1" aria-hidden />
                    풀이 보기 ▼
                  </>
                )}
              </button>
            )}
            {showExpl[currentIndex] && (
              <div className="explanation-box">
                <BookOpen size={16} weight="duotone" className="mr-1" aria-hidden />
                풀이: {currentProblem?.explanation}
              </div>
            )}

            <div className="quiz-actions">
              {!isAnswered ? (
                <button className="btn btn-primary btn-large"
                  onClick={handleSubmitAnswer} disabled={!answers[currentIndex]}>
                  답 제출
                </button>
              ) : currentIndex < problems.length - 1 ? (
                <button className="btn btn-primary btn-large"
                  onClick={() => { setCurrentIndex(currentIndex + 1); problemStartTime.current = Date.now(); }}>
                  다음 문제 →
                </button>
              ) : (
                <button className="btn btn-success btn-large" onClick={handleFinishQuiz}>
                  <FlagCheckered size={16} weight="duotone" className="mr-1.5" aria-hidden />
                  결과 보기
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════ 결과 화면 (SHOW_AI_QUIZ 일 때만) ═══════════════
  if (SHOW_AI_QUIZ && view === 'result') {
    const pct        = Math.round((score.correct / score.total) * 100);
    const topicLabel = TOPICS.find((t) => t.id === selectedTopic)?.label;

    return (
      <div className="result-container">
        <div className="result-card">
          <div className="result-emoji">
            {pct >= 80 ? (
              <Trophy size={72} weight="duotone" aria-hidden />
            ) : pct >= 60 ? (
              <Smiley size={72} weight="duotone" aria-hidden />
            ) : (
              <Barbell size={72} weight="duotone" aria-hidden />
            )}
          </div>
          <h2 className="result-title">{pct >= 80 ? '훌륭해요!' : pct >= 60 ? '잘 했어요!' : '계속 노력해요!'}</h2>
          <p className="result-topic">{topicLabel} 단원</p>

          <div className="result-score-ring">
            <span className="result-score-number">{pct}%</span>
            <span className="result-score-label">정답률</span>
          </div>

          <div className="result-stats">
            <div className="result-stat">
              <span className="result-stat-value">{score.total}</span>
              <span className="result-stat-label">전체</span>
            </div>
            <div className="result-stat">
              <span className="result-stat-value correct-color">{score.correct}</span>
              <span className="result-stat-label">정답</span>
            </div>
            <div className="result-stat">
              <span className="result-stat-value wrong-color">{score.total - score.correct}</span>
              <span className="result-stat-label">오답</span>
            </div>
          </div>

          <p className="sd-result-saved-note">
            <FloppyDisk size={14} weight="duotone" className="mr-1" aria-hidden />
            결과가 UUID 기반으로 저장되었습니다.
          </p>

          <div className="result-actions">
            <button className="btn btn-primary" onClick={() => setView('menu')}>
              <House size={16} weight="duotone" className="mr-1.5" aria-hidden />
              메인 메뉴
            </button>
            <button className="btn btn-outline"
              onClick={() => {
                setCurrentIndex(0); setAnswers({}); setSubmitted({});
                setShowHint({}); setShowExpl({}); setSolveTimes({});
                setScore({ correct: 0, total: 0 }); setView('quiz');
              }}>
              <ArrowsClockwise size={16} weight="duotone" className="mr-1.5" aria-hidden />
              다시 풀기
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
