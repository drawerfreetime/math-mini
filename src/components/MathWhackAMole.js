/**
 * MathWhackAMole.js — 수학 답 맞히기 (두더지 스타일, 60초)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import HudFrame from './HudFrame';
import {
  generateHoleOptions,
  generateMathProblem,
  pickRandomIndices,
} from '../utils/mathMiniGame';
import { MINI_GAME_ID } from '../constants/miniGameDaily';
import { useMiniGameEndRank } from '../hooks/useMiniGameEndRank';
import MiniGameEndRank from './MiniGameEndRank';
import MiniGameRankToggle from './MiniGameRankToggle';
import './MathMiniGames.css';

const ROUND_SEC = 60;
const HOLE_COUNT = 9;
const ACTIVE_HOLES = 3;
const FLASH_MS = 400;

export default function MathWhackAMole() {
  const navigate = useNavigate();
  const { studentSession, studentLogout } = useAuth();
  const { realName } = studentSession || {};

  const [phase, setPhase] = useState('idle');
  const [timeLeft, setTimeLeft] = useState(ROUND_SEC);
  const [score, setScore] = useState(0);
  const [problem, setProblem] = useState(null);
  const [holes, setHoles] = useState(() => Array(HOLE_COUNT).fill(null));
  const [flash, setFlash] = useState(null); // { index, type: 'correct'|'wrong' }
  const [locked, setLocked] = useState(false);
  const [showRank, setShowRank] = useState(false);

  const timerRef = useRef(null);
  const flashRef = useRef(null);
  const { loading: rankLoading, ranking } = useMiniGameEndRank({
    phase,
    gameId: MINI_GAME_ID.WHACK,
    sessionScore: score,
  });

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (flashRef.current) {
      clearTimeout(flashRef.current);
      flashRef.current = null;
    }
  }, []);

  const setupRound = useCallback(() => {
    const p = generateMathProblem();
    const options = generateHoleOptions(p.answer);
    const indices = pickRandomIndices(HOLE_COUNT, ACTIVE_HOLES);
    const nextHoles = Array(HOLE_COUNT).fill(null);
    indices.forEach((idx, i) => {
      nextHoles[idx] = {
        value: options[i],
        isCorrect: options[i] === p.answer,
      };
    });
    setProblem(p);
    setHoles(nextHoles);
    setFlash(null);
    setLocked(false);
  }, []);

  const startGame = useCallback(() => {
    clearTimers();
    setScore(0);
    setTimeLeft(ROUND_SEC);
    setPhase('play');
    setShowRank(false);
    setupRound();
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
  }, [clearTimers, setupRound]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  function handleHoleClick(index) {
    if (locked || phase !== 'play') return;
    const hole = holes[index];
    if (!hole) return;

    setLocked(true);
    if (hole.isCorrect) {
      setScore((s) => s + 10);
      setFlash({ index, type: 'correct' });
      flashRef.current = setTimeout(() => setupRound(), FLASH_MS);
    } else {
      setFlash({ index, type: 'wrong' });
      flashRef.current = setTimeout(() => {
        setFlash(null);
        setLocked(false);
      }, FLASH_MS);
    }
  }

  return (
    <div className="dashboard-container dashboard-container--brand-bg">
      <header className="dashboard-header">
        <div className="header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/student')}>
            ← 메인 메뉴
          </button>
          <span style={{ fontSize: 26 }}>🎯</span>
          <div>
            <h1 className="header-title">답 맞히기</h1>
            <p className="header-subtitle">문제에 맞는 답이 나온 구멍을 빠르게 눌러요!</p>
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
                title="🎯 답 맞히기"
                showRank={showRank}
                onToggleRank={() => setShowRank((v) => !v)}
                variant="single"
                gameId={MINI_GAME_ID.WHACK}
              />
              <p className="mmg-desc">
                위에 문제가 나오면, 구멍 속 답 중 정답을 눌러요.<br />
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
              </div>
              <p className="mmg-problem">{problem.text} = ?</p>
              <div className="mmg-whack-grid">
                {holes.map((hole, i) => {
                  const isFlash = flash?.index === i;
                  let moleCls = 'mmg-mole';
                  if (isFlash && flash.type === 'correct') moleCls += ' mmg-mole--flash-correct';
                  if (isFlash && flash.type === 'wrong') moleCls += ' mmg-mole--flash-wrong';

                  return (
                    <button
                      key={i}
                      type="button"
                      className={`mmg-hole${hole ? ' mmg-hole--active' : ''}`}
                      disabled={!hole || locked}
                      onClick={() => handleHoleClick(i)}
                      aria-label={hole ? `답 ${hole.value}` : '빈 구멍'}
                    >
                      {hole && (
                        <span className={moleCls}>{hole.value}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="mmg-card">
              <MiniGameRankToggle
                title="시간 종료!"
                showRank={showRank}
                onToggleRank={() => setShowRank((v) => !v)}
                variant="single"
                gameId={MINI_GAME_ID.WHACK}
              />
              <div className="mmg-result-emoji">{score >= 100 ? '🏆' : '💪'}</div>
              <div className="mmg-stats">
                <div>
                  <div className="mmg-stat-val">{score}</div>
                  <div>점수</div>
                </div>
              </div>
              <MiniGameEndRank
                loading={rankLoading}
                ranking={ranking}
                gameId={MINI_GAME_ID.WHACK}
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
