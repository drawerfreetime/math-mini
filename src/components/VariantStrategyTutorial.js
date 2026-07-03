import React, { useMemo, useState } from 'react';
import {
  VARIANT_STRATEGY_TUTORIAL_STEPS,
  buildTutorialStrategyOptions,
  getTutorialStrategyMeta,
} from '../constants/variantStrategyTutorialData';
import {
  PEER_EVAL_CHECK_KEYS,
  PEER_EVAL_CHECK_QUESTIONS,
} from '../constants/peerEvalChecks';
import './VariantStrategyTutorial.css';

const PHASE = {
  INTRO: 'intro',
  COMPARE: 'compare',
  QUIZ: 'quiz',
  PEER: 'peer',
  DONE_STEP: 'done_step',
};

/**
 * @param {{
 *   open: boolean;
 *   onComplete: () => void;
 *   onSkip: () => void;
 * }} props
 */
export default function VariantStrategyTutorial({ open, onComplete, onSkip }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState(PHASE.INTRO);
  const [quizOptions, setQuizOptions] = useState([]);
  const [pickedStrategy, setPickedStrategy] = useState('');
  const [quizFeedback, setQuizFeedback] = useState('');
  const [peerChecks, setPeerChecks] = useState({});

  const step = VARIANT_STRATEGY_TUTORIAL_STEPS[stepIndex];
  const meta = step ? getTutorialStrategyMeta(step.id) : null;
  const totalSteps = VARIANT_STRATEGY_TUTORIAL_STEPS.length;

  const progressLabel = useMemo(
    () => `${stepIndex + 1} / ${totalSteps}`,
    [stepIndex, totalSteps],
  );

  if (!open || !step || !meta) return null;

  function resetStepState() {
    setPhase(PHASE.INTRO);
    setQuizOptions([]);
    setPickedStrategy('');
    setQuizFeedback('');
    setPeerChecks({});
  }

  function goCompare() {
    setPhase(PHASE.COMPARE);
  }

  function goQuiz() {
    setQuizOptions(buildTutorialStrategyOptions(step.id));
    setPhase(PHASE.QUIZ);
  }

  function handleQuizPick(strategyId) {
    if (quizFeedback && pickedStrategy === step.id) return;
    setPickedStrategy(strategyId);
    if (strategyId === step.id) {
      setQuizFeedback('맞혔어요! 이 변형에는 「' + meta.title + '」 전략이 쓰였어요.');
      setTimeout(() => setPhase(PHASE.PEER), 600);
    } else {
      setQuizFeedback('다시 골라 보세요. 원본과 변형을 비교해 보세요.');
    }
  }

  function finishPeer() {
    setPhase(PHASE.DONE_STEP);
  }

  function goNextStep() {
    if (stepIndex + 1 >= totalSteps) {
      onComplete();
      return;
    }
    setStepIndex((i) => i + 1);
    resetStepState();
  }

  return (
    <div className="vst-root" role="dialog" aria-modal="true" aria-labelledby="vst-title">
      <div className="vst-panel">
        <header className="vst-header">
          <div>
            <p className="vst-kicker">문제 만들기 전략 연습</p>
            <h2 id="vst-title" className="vst-title">{meta.title}</h2>
          </div>
          <div className="vst-progress">{progressLabel}</div>
        </header>

        {phase === PHASE.INTRO && (
          <section className="vst-section">
            <p className="vst-desc">{meta.blurb}</p>
            <p className="vst-hint">
              연구원님, 아래에서 원본과 바뀐 문제를 비교하고, 어떤 전략인지 맞혀 볼 거예요.
              마지막에는 동료평가 방법도 연습해요.
            </p>
            <div className="vst-actions">
              <button type="button" className="btn btn-primary" onClick={goCompare}>
                시작하기
              </button>
              <button type="button" className="btn btn-ghost" onClick={onSkip}>
                건너뛰기
              </button>
            </div>
          </section>
        )}

        {phase === PHASE.COMPARE && (
          <section className="vst-section">
            <div className="vst-compare-grid">
              <div className="vst-compare-col">
                <div className="vst-compare-label">원본</div>
                <div className="vst-compare-body">{step.original}</div>
              </div>
              <div className="vst-compare-col vst-compare-col--variant">
                <div className="vst-compare-label">변형</div>
                <div className="vst-compare-body">{step.variant}</div>
              </div>
            </div>
            <div className="vst-actions">
              <button type="button" className="btn btn-primary" onClick={goQuiz}>
                어떤 전략일까요?
              </button>
            </div>
          </section>
        )}

        {phase === PHASE.QUIZ && (
          <section className="vst-section">
            <div className="vst-compare-grid vst-compare-grid--compact">
              <div className="vst-compare-col">
                <div className="vst-compare-label">원본</div>
                <div className="vst-compare-body">{step.original}</div>
              </div>
              <div className="vst-compare-col vst-compare-col--variant">
                <div className="vst-compare-label">변형</div>
                <div className="vst-compare-body">{step.variant}</div>
              </div>
            </div>
            <p className="vst-question">이 변형에는 어떤 전략이 쓰였나요?</p>
            <div className="vst-quiz-grid">
              {quizOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`vst-quiz-btn ${pickedStrategy === opt.id ? 'vst-quiz-btn--picked' : ''}`}
                  onClick={() => handleQuizPick(opt.id)}
                >
                  <span className="vst-quiz-title">{opt.title}</span>
                  <span className="vst-quiz-blurb">({opt.evalBlurb})</span>
                </button>
              ))}
            </div>
            {quizFeedback && (
              <p className={`vst-feedback ${pickedStrategy === step.id ? 'vst-feedback--ok' : ''}`}>
                {quizFeedback}
              </p>
            )}
          </section>
        )}

        {phase === PHASE.PEER && (
          <section className="vst-section">
            <p className="vst-question">동료평가 연습 — 만든 문제를 평가해 볼까요?</p>
            <p className="vst-hint">학급 문제 풀기에서 친구 변형을 평가할 때와 같아요.</p>
            <ul className="vst-peer-list">
              {PEER_EVAL_CHECK_KEYS.map((key) => (
                <li key={key} className="vst-peer-row">
                  <span>{PEER_EVAL_CHECK_QUESTIONS[key]}</span>
                  <div className="vst-peer-btns">
                    <button
                      type="button"
                      className={`vst-peer-btn ${peerChecks[key] === true ? 'vst-peer-btn--yes' : ''}`}
                      onClick={() => setPeerChecks((p) => ({ ...p, [key]: true }))}
                    >
                      O
                    </button>
                    <button
                      type="button"
                      className={`vst-peer-btn ${peerChecks[key] === false ? 'vst-peer-btn--no' : ''}`}
                      onClick={() => setPeerChecks((p) => ({ ...p, [key]: false }))}
                    >
                      X
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="vst-hint vst-hint--muted">
              정답 예시: {PEER_EVAL_CHECK_KEYS.map((k) => (step.peerChecks[k] ? 'O' : 'X')).join(' · ')}
              (연습용 — 맞혀야 넘어가는 건 아니에요)
            </p>
            <div className="vst-actions">
              <button type="button" className="btn btn-primary" onClick={finishPeer}>
                다음
              </button>
            </div>
          </section>
        )}

        {phase === PHASE.DONE_STEP && (
          <section className="vst-section vst-section--center">
            <div className="vst-done-icon" aria-hidden>✓</div>
            <p className="vst-done-msg">「{meta.title}」 연습을 마쳤어요!</p>
            <div className="vst-actions">
              <button type="button" className="btn btn-primary" onClick={goNextStep}>
                {stepIndex + 1 >= totalSteps ? '튜토리얼 완료' : '다음 전략'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
