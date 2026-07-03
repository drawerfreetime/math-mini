import React, { useState } from 'react';
import HudFrame from './HudFrame';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// 게스트용 샘플 문제 (Claude API 없이 미리 준비된 문제)
const SAMPLE_PROBLEMS = [
  {
    question: '사과 24개를 4명이 똑같이 나누면 한 명이 받는 사과는 몇 개일까요?',
    answer: '6',
    hint: '24 ÷ 4 = ?',
    explanation: '24를 4로 나누면 6이에요. 24 ÷ 4 = 6',
  },
  {
    question: '어떤 각도기로 잰 각도가 90도보다 크고 180도보다 작아요. 이런 각도를 무엇이라고 할까요?',
    answer: '둔각',
    hint: '90도보다 크고 180도보다 작은 각도의 이름을 생각해보세요.',
    explanation: '90도보다 작으면 예각, 90도보다 크고 180도보다 작으면 둔각이라고 해요.',
  },
  {
    question: '153 × 4 = ?',
    answer: '612',
    hint: '세 자리 수 × 한 자리 수예요. 일의 자리부터 차례대로 곱해보세요.',
    explanation: '3×4=12(올림 1), 5×4=20, 20+1=21(올림 2), 1×4=4, 4+2=6. 따라서 612!',
  },
  {
    question: '피자 한 판을 8조각으로 나눴을 때, 3조각을 먹었다면 얼마를 먹은 걸까요? (분수로 쓰세요)',
    answer: '3/8',
    hint: '전체를 8로 나눈 것 중에서 3개를 먹었어요.',
    explanation: '전체(8조각) 중 3조각을 먹었으니 3/8이에요.',
  },
  {
    question: '0.7은 0.1이 몇 개인 수일까요?',
    answer: '7',
    hint: '0.1이 몇 개 모이면 0.7이 될까요?',
    explanation: '0.1 × 7 = 0.7이에요. 0.7은 0.1이 7개인 수예요.',
  },
];

export default function GuestDashboard() {
  const { exitGuestMode } = useAuth();
  const navigate = useNavigate();

  const [view, setView]               = useState('menu');   // menu | quiz | result
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers]         = useState({});
  const [submitted, setSubmitted]     = useState({});
  const [showHint, setShowHint]       = useState({});
  const [showExpl, setShowExpl]       = useState({});
  const [score, setScore]             = useState({ correct: 0, total: 0 });

  function handleGoLogin() {
    exitGuestMode();
    navigate('/login');
  }

  function handleGoSignup() {
    exitGuestMode();
    navigate('/signup');
  }

  function startQuiz() {
    setCurrentIndex(0);
    setAnswers({});
    setSubmitted({});
    setShowHint({});
    setShowExpl({});
    setScore({ correct: 0, total: 0 });
    setView('quiz');
  }

  function handleSubmitAnswer() {
    const correct =
      answers[currentIndex]?.trim() === SAMPLE_PROBLEMS[currentIndex]?.answer?.trim();
    setSubmitted({ ...submitted, [currentIndex]: { submitted: true, correct } });
    setScore((prev) => ({
      correct: prev.correct + (correct ? 1 : 0),
      total: prev.total + 1,
    }));
  }

  function handleFinish() {
    const finalCorrect = Object.values(submitted).filter((s) => s.correct).length;
    setScore({ correct: finalCorrect, total: SAMPLE_PROBLEMS.length });
    setView('result');
  }

  const prob      = SAMPLE_PROBLEMS[currentIndex];
  const isAnswered = submitted[currentIndex]?.submitted;
  const progress  = ((currentIndex) / SAMPLE_PROBLEMS.length) * 100;

  // ─── 메인 메뉴 ───
  if (view === 'menu') {
    return (
      <div className="dashboard-container dashboard-container--brand-bg">
        {/* 로그인 유도 배너 */}
        <div className="guest-banner">
          <span>🔓 로그인하면 AI 문제 생성, 채점, 학습 기록 저장 등 모든 기능을 사용할 수 있어요!</span>
          <div className="guest-banner-actions">
            <button className="btn btn-sm btn-primary" onClick={handleGoLogin}>로그인</button>
            <button className="btn btn-sm btn-outline" style={{ borderColor: 'white', color: 'white' }} onClick={handleGoSignup}>교사 가입</button>
          </div>
        </div>

        <header className="dashboard-header">
          <div className="header-left">
            <span className="header-icon">🧮</span>
            <div>
              <h1 className="header-title">수학 문제 만들기</h1>
              <p className="header-subtitle">체험 모드</p>
            </div>
          </div>
          <div className="header-right">
            <span className="user-badge" style={{ background: '#f1f5f9', color: '#64748b' }}>게스트</span>
            <button onClick={handleGoLogin} className="btn btn-primary btn-sm">로그인</button>
          </div>
        </header>

        <main className="dashboard-main">
          <HudFrame>
            <div className="section-header">
              <h2 className="section-title">🎯 샘플 문제 체험하기</h2>
            </div>

            <div className="guest-intro">
              <div className="guest-feature-list">
                <div className="guest-feature available">
                  <span className="feature-icon">✅</span>
                  <div>
                    <strong>미리 준비된 샘플 문제 풀기</strong>
                    <p>4학년 수학 핵심 문제 5개를 체험할 수 있어요</p>
                  </div>
                </div>
                <div className="guest-feature available">
                  <span className="feature-icon">✅</span>
                  <div>
                    <strong>힌트 및 풀이 보기</strong>
                    <p>모르는 문제는 힌트와 풀이를 확인할 수 있어요</p>
                  </div>
                </div>
                <div className="guest-feature unavailable">
                  <span className="feature-icon">🔒</span>
                  <div>
                    <strong>AI 맞춤 문제 생성</strong>
                    <p>단원/난이도 선택 후 AI가 문제를 만들어주는 기능 (로그인 필요)</p>
                  </div>
                </div>
                <div className="guest-feature unavailable">
                  <span className="feature-icon">🔒</span>
                  <div>
                    <strong>학습 기록 저장</strong>
                    <p>풀이 결과와 정답률이 저장되는 기능 (로그인 필요)</p>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 24 }}>
              <button className="btn btn-primary btn-large" onClick={startQuiz}>
                🚀 샘플 문제 풀어보기 ({SAMPLE_PROBLEMS.length}문제)
              </button>
              <button className="btn btn-outline btn-large" onClick={handleGoSignup}>
                ✏️ 교사로 가입하기
              </button>
            </div>
          </HudFrame>
        </main>
      </div>
    );
  }

  // ─── 퀴즈 화면 ───
  if (view === 'quiz') {
    return (
      <div className="quiz-container">
        {/* 로그인 유도 배너 (퀴즈 중에도 표시) */}
        <div className="guest-banner-mini">
          🔓 로그인하면 AI가 만든 맞춤 문제를 풀 수 있어요!
          <button className="btn btn-xs btn-primary" onClick={handleGoLogin} style={{ marginLeft: 12 }}>
            로그인
          </button>
        </div>

        <div className="quiz-header">
          <div className="quiz-header-top">
            <button className="btn btn-ghost btn-sm" onClick={() => setView('menu')}>← 메뉴로</button>
            <div className="quiz-info">
              <span className="quiz-topic">샘플 문제</span>
              <span className="quiz-difficulty">4학년 수학</span>
            </div>
            <span className="quiz-progress-text">{currentIndex + 1} / {SAMPLE_PROBLEMS.length}</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }}></div>
          </div>
        </div>

        <div className="quiz-main">
          <div className="problem-card">
            <div className="problem-number">문제 {currentIndex + 1}</div>
            <p className="problem-text">{prob.question}</p>

            {!isAnswered && (
              <button className="hint-btn" onClick={() => setShowHint({ ...showHint, [currentIndex]: true })}>
                💡 힌트 보기
              </button>
            )}
            {showHint[currentIndex] && (
              <div className="hint-box">💡 힌트: {prob.hint}</div>
            )}

            <div className="answer-section">
              <label className="form-label">내 답:</label>
              <input
                type="text"
                className={`form-input answer-input ${isAnswered ? (submitted[currentIndex]?.correct ? 'input-correct' : 'input-wrong') : ''}`}
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
                  ? '🎉 정답입니다!'
                  : <span>😢 틀렸어요. 정답: <strong>{prob.answer}</strong></span>}
              </div>
            )}

            {isAnswered && (
              <button className="explanation-btn" onClick={() => setShowExpl({ ...showExpl, [currentIndex]: !showExpl[currentIndex] })}>
                {showExpl[currentIndex] ? '풀이 닫기 ▲' : '📖 풀이 보기 ▼'}
              </button>
            )}
            {showExpl[currentIndex] && (
              <div className="explanation-box">📖 풀이: {prob.explanation}</div>
            )}

            <div className="quiz-actions">
              {!isAnswered ? (
                <button className="btn btn-primary btn-large" onClick={handleSubmitAnswer} disabled={!answers[currentIndex]}>
                  답 제출
                </button>
              ) : currentIndex < SAMPLE_PROBLEMS.length - 1 ? (
                <button className="btn btn-primary btn-large" onClick={() => setCurrentIndex(currentIndex + 1)}>
                  다음 문제 →
                </button>
              ) : (
                <button className="btn btn-success btn-large" onClick={handleFinish}>
                  🏁 결과 보기
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── 결과 화면 ───
  if (view === 'result') {
    const pct = Math.round((score.correct / score.total) * 100);
    return (
      <div className="result-container">
        <div className="result-card">
          <div className="result-emoji">{pct >= 80 ? '🏆' : pct >= 60 ? '😊' : '💪'}</div>
          <h2 className="result-title">{pct >= 80 ? '훌륭해요!' : pct >= 60 ? '잘 했어요!' : '계속 노력해요!'}</h2>
          <p className="result-topic">샘플 문제 체험</p>

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

          {/* 결과 저장 안내 */}
          <div className="guest-result-notice">
            💾 로그인하면 결과가 저장되고 선생님이 확인할 수 있어요!
          </div>

          <div className="result-actions" style={{ flexDirection: 'column', gap: 10 }}>
            <button className="btn btn-primary btn-full" onClick={handleGoLogin}>
              로그인하고 AI 문제 풀기
            </button>
            <button className="btn btn-outline btn-full" onClick={startQuiz}>
              🔄 다시 풀기
            </button>
            <button className="btn btn-ghost btn-full" onClick={() => setView('menu')}>
              메뉴로
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
