/**
 * MathMakeTen.js — 10만들기 (사각형 드래그로 합이 10인 숫자 제거)
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import HudFrame from './HudFrame';
import {
  MAKE_TEN_DIFFICULTIES,
  cellsInRect,
  cellFromGridPoint,
  countFilledCells,
  hasAnyMakeTenMove,
  marqueePixelsFromBounds,
  rectBounds,
  rectFilledCount,
  rectSum,
  removeCells,
} from '../utils/makeTenGame';
import { makeTenGameId } from '../constants/miniGameDaily';
import { useMiniGameEndRank } from '../hooks/useMiniGameEndRank';
import MiniGameEndRank from './MiniGameEndRank';
import MiniGameRankToggle from './MiniGameRankToggle';
import './MathMiniGames.css';

const CELL_PALETTE = ['#38bdf8', '#818cf8', '#a78bfa', '#f472b6', '#fb7185', '#fb923c'];
const DIFFICULTY_LIST = [
  MAKE_TEN_DIFFICULTIES.easy,
  MAKE_TEN_DIFFICULTIES.normal,
  MAKE_TEN_DIFFICULTIES.hard,
];

function createPlayableGrid(diff) {
  for (let i = 0; i < 24; i += 1) {
    const grid = diff.createGrid(diff.rows, diff.cols);
    if (hasAnyMakeTenMove(grid)) return grid;
  }
  return diff.createGrid(diff.rows, diff.cols);
}

export default function MathMakeTen() {
  const navigate = useNavigate();
  const { studentSession, studentLogout } = useAuth();
  const { realName } = studentSession || {};

  const [difficultyId, setDifficultyId] = useState('easy');
  const difficulty = MAKE_TEN_DIFFICULTIES[difficultyId] || MAKE_TEN_DIFFICULTIES.easy;

  const [phase, setPhase] = useState('idle');
  const [timeLeft, setTimeLeft] = useState(difficulty.roundSec);
  const [score, setScore] = useState(0);
  const [cleared, setCleared] = useState(0);
  const [endReason, setEndReason] = useState('time');
  const [timeBonus, setTimeBonus] = useState(0);
  const [blockPenalty, setBlockPenalty] = useState(0);
  const [remainingBlocks, setRemainingBlocks] = useState(0);
  const [grid, setGrid] = useState(() => createPlayableGrid(difficulty));
  const [anchor, setAnchor] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [flash, setFlash] = useState(null);
  const [showRank, setShowRank] = useState(false);

  const draggingRef = useRef(false);
  const anchorRef = useRef(null);
  const cursorRef = useRef(null);
  const timerRef = useRef(null);
  const flashRef = useRef(null);
  const gridRef = useRef(null);
  const wrapRef = useRef(null);
  const timeLeftRef = useRef(timeLeft);
  const [marqueePx, setMarqueePx] = useState(null);

  useEffect(() => {
    timeLeftRef.current = timeLeft;
  }, [timeLeft]);

  const makeTenGameKey = makeTenGameId(difficultyId);
  const { loading: rankLoading, ranking } = useMiniGameEndRank({
    phase,
    gameId: makeTenGameKey,
    sessionScore: score,
  });

  const selection = React.useMemo(() => cellsInRect(anchor, cursor), [anchor, cursor]);
  const bounds = React.useMemo(() => rectBounds(anchor, cursor), [anchor, cursor]);

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

  const clearSelection = useCallback(() => {
    anchorRef.current = null;
    cursorRef.current = null;
    setAnchor(null);
    setCursor(null);
    draggingRef.current = false;
  }, []);

  const resetRound = useCallback((diff = difficulty) => {
    setGrid(createPlayableGrid(diff));
    clearSelection();
    setFlash(null);
  }, [difficulty, clearSelection]);

  const finishGame = useCallback((reason, {
    bonusSeconds = 0,
    bonusRate = 10,
    remainingGrid = null,
    penaltyPerCell = 0,
  } = {}) => {
    clearTimers();
    draggingRef.current = false;
    const bonus = reason === 'stuck' ? bonusSeconds * bonusRate : 0;
    const remaining = remainingGrid ? countFilledCells(remainingGrid) : 0;
    const penalty = reason === 'stuck' ? remaining * penaltyPerCell : 0;
    const netAdjust = bonus - penalty;

    setEndReason(reason);
    setTimeBonus(bonus);
    setBlockPenalty(penalty);
    setRemainingBlocks(remaining);
    if (netAdjust !== 0) {
      setScore((s) => Math.max(0, s + netAdjust));
    }
    setPhase('done');
  }, [clearTimers]);

  const startGame = useCallback((diffId = difficultyId) => {
    const diff = MAKE_TEN_DIFFICULTIES[diffId] || MAKE_TEN_DIFFICULTIES.easy;
    clearTimers();
    setDifficultyId(diffId);
    setScore(0);
    setCleared(0);
    setTimeBonus(0);
    setBlockPenalty(0);
    setRemainingBlocks(0);
    setEndReason('time');
    setTimeLeft(diff.roundSec);
    setPhase('play');
    setShowRank(false);
    resetRound(diff);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          finishGame('time');
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  }, [clearTimers, difficultyId, resetRound, finishGame]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const commitSelection = useCallback(() => {
    const a = anchorRef.current;
    const b = cursorRef.current;
    if (!a || !b) {
      clearSelection();
      return;
    }

    const cells = cellsInRect(a, b);
    const sum = rectSum(grid, cells);
    const filled = rectFilledCount(grid, cells);

    if (sum === 10 && filled >= 2) {
      const nextGrid = removeCells(grid, cells);
      setScore((s) => s + filled * difficulty.pointsPerCell);
      setCleared((n) => n + filled);
      setGrid(nextGrid);
      setFlash('success');
      flashRef.current = setTimeout(() => setFlash(null), 280);

      if (!hasAnyMakeTenMove(nextGrid)) {
        finishGame('stuck', {
          bonusSeconds: timeLeftRef.current,
          bonusRate: difficulty.timeBonusPerSec,
          remainingGrid: nextGrid,
          penaltyPerCell: difficulty.remainingPenaltyPerCell,
        });
      }
    } else if (filled > 0) {
      setFlash('fail');
      flashRef.current = setTimeout(() => setFlash(null), 220);
    }
    clearSelection();
  }, [grid, clearSelection, difficulty.pointsPerCell, difficulty.timeBonusPerSec, difficulty.remainingPenaltyPerCell, finishGame]);

  useEffect(() => {
    const onPointerUp = () => {
      if (!draggingRef.current) return;
      commitSelection();
    };
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [commitSelection]);

  function updateDragPoint(clientX, clientY) {
    const cell = cellFromGridPoint(
      gridRef.current,
      clientX,
      clientY,
      difficulty.cols,
      difficulty.rows,
    );
    if (!cell) return;
    if (
      cursorRef.current
      && cursorRef.current.r === cell.r
      && cursorRef.current.c === cell.c
    ) {
      return;
    }
    cursorRef.current = cell;
    setCursor(cell);
  }

  function handleBoardPointerDown(e) {
    if (phase !== 'play') return;
    const cell = cellFromGridPoint(
      gridRef.current,
      e.clientX,
      e.clientY,
      difficulty.cols,
      difficulty.rows,
    );
    if (!cell) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    anchorRef.current = cell;
    cursorRef.current = cell;
    setAnchor(cell);
    setCursor(cell);
    setFlash(null);
  }

  function handleBoardPointerMove(e) {
    if (!draggingRef.current || phase !== 'play') return;
    e.preventDefault();
    updateDragPoint(e.clientX, e.clientY);
  }

  const currentSum = selection.length ? rectSum(grid, selection) : 0;
  const filledCount = selection.length ? rectFilledCount(grid, selection) : 0;
  const sumTone = currentSum === 10 && filledCount >= 2
    ? 'mmg-make-ten-sum--ready'
    : currentSum > 10
      ? 'mmg-make-ten-sum--over'
      : '';

  const selectedSet = new Set(selection.map(({ r, c }) => `${r},${c}`));

  useLayoutEffect(() => {
    if (!bounds || !gridRef.current || !wrapRef.current) {
      setMarqueePx((prev) => (prev == null ? prev : null));
      return;
    }
    const next = marqueePixelsFromBounds(gridRef.current, wrapRef.current, bounds);
    setMarqueePx((prev) => {
      if (!next) return null;
      if (
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height
      ) {
        return prev;
      }
      return next;
    });
  }, [bounds]);

  function handleBackToIdle() {
    clearTimers();
    setPhase('idle');
    clearSelection();
    setFlash(null);
  }

  const cellSizePx = difficulty.cellSize ?? 70;

  return (
    <div className="dashboard-container dashboard-container--brand-bg">
      <header className="dashboard-header">
        <div className="header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/student')}>
            ← 메인 메뉴
          </button>
          <span style={{ fontSize: 26 }}>🔟</span>
          <div>
            <h1 className="header-title">10만들기</h1>
            <p className="header-subtitle">사각형으로 드래그해 합이 10이 되면 지워요!</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge student-badge">학생</span>
          <span className="user-name">{realName}</span>
          <button type="button" onClick={studentLogout} className="btn btn-outline btn-sm">로그아웃</button>
        </div>
      </header>

      <main className={`dashboard-main mmg-main mmg-main--landscape${phase === 'play' ? ' mmg-make-ten-main--play' : ''}`}>
        <HudFrame className={phase === 'play' ? 'mmg-make-ten-hud--play' : ''}>
          {phase === 'idle' && (
            <div className="mmg-card">
              <MiniGameRankToggle
                title="🔟 10만들기"
                showRank={showRank}
                onToggleRank={() => setShowRank((v) => !v)}
                variant="make_ten"
              />
              <p className="mmg-desc">
                마우스로 사각형을 그려 숫자를 가두세요.<br />
                선택한 숫자(2개 이상)의 합이 10이면 사라져요.
              </p>
              <p className="mmg-make-ten-diff-label">난이도를 골라주세요</p>
              <div className="mmg-make-ten-diff-grid">
                {DIFFICULTY_LIST.map((diff) => (
                  <button
                    key={diff.id}
                    type="button"
                    className={[
                      'mmg-make-ten-diff-btn',
                      difficultyId === diff.id ? 'mmg-make-ten-diff-btn--active' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => setDifficultyId(diff.id)}
                  >
                    <span className="mmg-make-ten-diff-name">{diff.label}</span>
                    <span className="mmg-make-ten-diff-meta">
                      {diff.cols}×{diff.rows} · {diff.roundSec}초
                    </span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-primary btn-large"
                onClick={() => startGame(difficultyId)}
              >
                시작하기
              </button>
            </div>
          )}

          {phase === 'play' && (
            <div className="mmg-card mmg-card--landscape">
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
                  <div className="mmg-stat-val">{cleared}</div>
                  <div>제거</div>
                </div>
                <div>
                  <div className="mmg-stat-val mmg-make-ten-diff-badge">
                    {difficulty.label}
                  </div>
                  <div>난이도</div>
                </div>
              </div>

              <p className={`mmg-make-ten-sum ${sumTone}`}>
                {selection.length
                  ? `선택 합: ${currentSum}${filledCount > 0 ? ` (${filledCount}개)` : ''}`
                  : '사각형으로 드래그하세요'}
              </p>

              <div
                ref={wrapRef}
                className={`mmg-make-ten-board-wrap ${flash === 'success' ? 'mmg-make-ten-board-wrap--flash-ok' : ''} ${flash === 'fail' ? 'mmg-make-ten-board-wrap--flash-no' : ''}`}
                style={{
                  '--mmt-cols': difficulty.cols,
                  '--mmt-rows': difficulty.rows,
                  '--mmt-cell-size': `${cellSizePx}px`,
                  touchAction: 'none',
                }}
                onPointerDown={handleBoardPointerDown}
                onPointerMove={handleBoardPointerMove}
              >
                <div ref={gridRef} className="mmg-make-ten-board">
                  {grid.map((row, r) =>
                    row.map((value, c) => {
                      const key = `${r},${c}`;
                      const isSelected = selectedSet.has(key);
                      const color = CELL_PALETTE[(r + c) % CELL_PALETTE.length];
                      const isEmpty = value == null;
                      return (
                        <div
                          key={key}
                          data-mmt-cell
                          data-mmt-r={r}
                          data-mmt-c={c}
                          className={[
                            'mmg-make-ten-cell',
                            isSelected ? 'mmg-make-ten-cell--selected' : '',
                            isEmpty ? 'mmg-make-ten-cell--empty' : '',
                          ].filter(Boolean).join(' ')}
                          style={!isEmpty ? { '--cell-color': color } : undefined}
                        >
                          {!isEmpty && <span className="mmg-make-ten-cell-num">{value}</span>}
                        </div>
                      );
                    })
                  )}
                </div>
                {marqueePx && (
                  <div
                    className={`mmg-make-ten-marquee ${sumTone === 'mmg-make-ten-sum--ready' ? 'mmg-make-ten-marquee--ready' : ''}`}
                    style={{
                      left: marqueePx.left,
                      top: marqueePx.top,
                      width: marqueePx.width,
                      height: marqueePx.height,
                    }}
                  />
                )}
              </div>

              <p className="mmg-make-ten-hint">{difficulty.hint}</p>
            </div>
          )}

          {phase === 'done' && (
            <div className="mmg-card">
              <MiniGameRankToggle
                title={endReason === 'stuck' ? '판을 다 풀었어요!' : '시간 종료!'}
                showRank={showRank}
                onToggleRank={() => setShowRank((v) => !v)}
                variant="make_ten"
              />
              <div className="mmg-result-emoji">
                {score >= difficulty.trophyScore ? '🏆' : '💪'}
              </div>
              <p className="mmg-make-ten-done-diff">
                {difficulty.label} 모드
                {endReason === 'stuck' && (timeBonus > 0 || blockPenalty > 0) && (
                  <>
                    {timeBonus > 0 && <> · 시간 +{timeBonus}</>}
                    {blockPenalty > 0 && <> · 남은 블록 {remainingBlocks}개 −{blockPenalty}</>}
                  </>
                )}
              </p>
              <div className="mmg-stats">
                <div>
                  <div className="mmg-stat-val">{score}</div>
                  <div>점수</div>
                </div>
                <div>
                  <div className="mmg-stat-val">{cleared}</div>
                  <div>제거한 숫자</div>
                </div>
                {endReason === 'stuck' && timeBonus > 0 && (
                  <div>
                    <div className="mmg-stat-val mmg-stat-val--plus">+{timeBonus}</div>
                    <div>시간 보너스</div>
                  </div>
                )}
                {endReason === 'stuck' && blockPenalty > 0 && (
                  <div>
                    <div className="mmg-stat-val mmg-stat-val--minus">−{blockPenalty}</div>
                    <div>남은 블록</div>
                  </div>
                )}
              </div>
              <MiniGameEndRank
                loading={rankLoading}
                ranking={ranking}
                gameId={makeTenGameKey}
              />
              <div className="mmg-actions">
                <button type="button" className="btn btn-primary btn-large" onClick={() => startGame(difficultyId)}>
                  다시 하기
                </button>
                <button type="button" className="btn btn-outline" onClick={handleBackToIdle}>
                  난이도 바꾸기
                </button>
                <button type="button" className="btn btn-outline" onClick={() => navigate('/student/games')}>
                  게임 목록
                </button>
              </div>
            </div>
          )}
        </HudFrame>
      </main>
    </div>
  );
}
