/**
 * MathSpeedQuiz.js — 즉석 연산 스피드 퀴즈 (60초)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import HudFrame from './HudFrame';
import { generateChoices, generateMathProblem } from '../utils/mathMiniGame';
import { MINI_GAME_ID } from '../constants/miniGameDaily';
import { useMiniGameEndRank } from '../hooks/useMiniGameEndRank';
import MiniGameEndRank from './MiniGameEndRank';
import MiniGameRankToggle from './MiniGameRankToggle';
import './MathMiniGames.css';

const ROUND_SEC = 60;
const FEEDBACK_MS = 450;

export default function MathSpeedQuiz() {
  const navigate = useNavigate();
  const { studentSession, studentLogout } = useAuth();
  const { realName } = studentSession || {};

  const [phase, setPhase] = useState('idle'); // idle | play | done
  const [timeLeft, setTimeLeft] = useState(ROUND_SEC);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [problem, setProblem] = useState(null);
  const [choices, setChoices] = useState([]);
  const [feedback, setFeedback] = useState('');
  const [locked, setLocked] = useState(false);
  const [picked, setPicked] = useState(null);
  const [showRank, setShowRank] = useState(false);

  const timerRef = useRef(null);
  const feedbackRef = useRef(null);
  const { loading: rankLoading, ranking } = useMiniGameEndRank({
    phase,
    gameId: MINI_GAME_ID.SPEED_QUIZ,
    sessionScore: score,
  });

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (feedbackRef.current) {
      clearTimeout(feedbackRef.current);
      feedbackRef.current = null;
    }
  }, []);

  const nextProblem = useCallback(() => {
    const p = generateMathProblem();
    setProblem(p);
    setChoices(generateChoices(p.answer));
    setFeedback('');
    setLocked(false);
    setPicked(null);
  }, []);

  const startGame = useCallback(() => {
    clearTimers();
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setTimeLeft(ROUND_SEC);
    setPhase('play');
    setShowRank(false);
    nextProblem();
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearTimers();
          setPhase('done');
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  }, [clearTimers, nextProblem]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  function handleChoice(picked) {
    if (locked || phase !== 'play' || !problem) return;
    setLocked(true);
    setPicked(picked);
    const correct = picked === problem.answer;
    if (correct) {
      setScore((s) => s + 10);
      setStreak((s) => {
        const next = s + 1;
        setBestStreak((b) => Math.max(b, next));
        return next;
      });
      setFeedback('🎉 정답!');
    } else {
      setStreak(0);
      setFeedback(`😢 정답은 ${problem.answer}`);
    }
    feedbackRef.current = setTimeout(() => {
      if (phase === 'play') nextProblem();
    }, FEEDBACK_MS);
  }

  return (
    <div className="dashboard-container dashboard-container--brand-bg">
      <header className="dashboard-header">
        <div className="header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/student')}>
            ← 메인 메뉴
          </button>
          <span style={{ fontSize: 26 }}>⚡</span>
          <div>
            <h1 className="header-title">스피드 퀴즈</h1>
            <p className="header-subtitle">60초 안에 연산 문제를 많이 맞혀 보세요!</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge student-badge">학생</span>
          <span className="user-name">{realName}</span>
          <button type="button" onClick={studentLogout} className="btn btn-outline btn-sm">로그아웃</button>
        </div>
      </header>

      <main className="dashboard-main mmg-main">
        <HudFrame>
          {phase === 'idle' && (
            <div className="mmg-card">
              <MiniGameRankToggle
                title="⚡ 스피드 퀴즈"
                showRank={showRank}
                onToggleRank={() => setShowRank((v) => !v)}
                variant="single"
                gameId={MINI_GAME_ID.SPEED_QUIZ}
              />
              <p className="mmg-desc">
                덧셈·뺄셈·곱셈 문제가 즉석에서 나와요.<br />
                60초 동안 최대한 많이 맞혀 보세요!
              </p>
              <button type="button" className="btn btn-primary btn-large" onClick={startGame}>
                시작하기
              </button>
            </div>
          )}

          {phase === 'play' && problem && (
            <div className="mmg-card">
              <div className="mmg-stats">
                <div>
                  <div className="mmg-stat-val">{timeLeft}</div>
                  <div>초 남음</div>
                </div>
                <div>
                  <div className="mmg-stat-val">{score}</div>
                  <div>점수</div>
                </div>
                <div>
                  <div className="mmg-stat-val">{streak}</div>
                  <div>연속</div>
                </div>
              </div>
              <p className="mmg-problem">{problem.text} = ?</p>
              <div className="mmg-choices">
                {choices.map((c) => {
                  let cls = 'mmg-choice-btn';
                  if (locked) {
                    if (c === problem.answer) cls += ' mmg-choice-btn--correct';
                    else if (c === picked) cls += ' mmg-choice-btn--wrong';
                  }
                  return (
                    <button
                      key={c}
                      type="button"
                      className={cls}
                      disabled={locked}
                      onClick={() => handleChoice(c)}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
              <p className="mmg-feedback">{feedback}</p>
            </div>
          )}

          {phase === 'done' && (
            <div className="mmg-card">
              <MiniGameRankToggle
                title="시간 종료!"
                showRank={showRank}
                onToggleRank={() => setShowRank((v) => !v)}
                variant="single"
                gameId={MINI_GAME_ID.SPEED_QUIZ}
              />
              <div className="mmg-result-emoji">{score >= 100 ? '🏆' : '💪'}</div>
              <div className="mmg-stats">
                <div>
                  <div className="mmg-stat-val">{score}</div>
                  <div>점수</div>
                </div>
                <div>
                  <div className="mmg-stat-val">{bestStreak}</div>
                  <div>최고 연속</div>
                </div>
              </div>
              <MiniGameEndRank
                loading={rankLoading}
                ranking={ranking}
                gameId={MINI_GAME_ID.SPEED_QUIZ}
              />
              <div className="mmg-actions">
                <button type="button" className="btn btn-primary btn-large" onClick={startGame}>
                  다시 하기
                </button>
                <button type="button" className="btn btn-outline" onClick={() => navigate('/student')}>
                  메인 메뉴
                </button>
              </div>
            </div>
          )}
        </HudFrame>
      </main>
    </div>
  );
}
