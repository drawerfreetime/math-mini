/**

 * VariantPeerEvaluation.js — 원본|변형 비교 + 전략 퀴즈 + 요소별 O/X 평가

 */

import React, { useState, useMemo, useEffect, useRef } from 'react';

import { QuestionBodyRenderer } from './QuestionBodyRenderer';

import { renderMathText, mathTextToPlainString } from './ExamOCR';

import { getStrategyEvalOptions } from '../constants/variantEvaluation';

import {

  PEER_EVAL_CHECK_KEYS,

  PEER_EVAL_CHECK_LABELS,

  PEER_EVAL_CHECK_QUESTIONS,

  emptyPeerChecks,

  CREATOR_SOLUTION_STORAGE_EMPTY_MSG,

  getRequiredPeerEvalCheckKeys,

} from '../constants/peerEvalChecks';

import {
  PEER_EVAL_STRATEGY_POINTS,
  computePeerEvalCheckRewardPoints,
  formatExplorationPoints,
} from '../constants/explorationRewards';

import { getExamQuestionStemForStudent } from '../utils/examSolutionArea';
import { isTeacherReviewConfirmed } from '../utils/studentAiFeedback';

import './ClassProblemBank.css';
import {
  SUBMISSION_STATUS_APPROVED_PARTIAL,
} from '../constants/aiSubmissionPolicy';



const CHOICE_LABELS = ['①', '②', '③', '④', '⑤', '⑥'];



function choiceNeedsBlockLayout(text) {

  const s = String(text || '');

  if (!s) return false;

  if (s.includes('\n')) return true;

  if (/\$\$[\s\S]+\$\$/.test(s)) return true;

  return /\\begin\{(array|aligned|cases)\}/.test(s);

}



function ChoiceText({ text }) {

  const s = String(text || '');

  if (!s.includes('\n')) return renderMathText(s);

  return (

    <>

      {s.split('\n').map((line, i) => (

        <span key={i} className="vpe-panel-choice-line">

          {line ? renderMathText(line) : '\u00A0'}

        </span>

      ))}

    </>

  );

}



function parseChoiceNums(answerStr) {

  return String(answerStr || '')

    .split(/[,，\s]+/)

    .map((s) => parseInt(s.trim(), 10))

    .filter((n) => Number.isFinite(n) && n > 0);

}



function formatCreatorAnswerDisplay(problem) {

  const answerStr = String(problem?.variantAnswer || '').trim();

  if (!answerStr) return '—';

  const isMc = Array.isArray(problem?.variantChoices) && problem.variantChoices.length > 0;

  if (!isMc) return answerStr;



  const choices = problem.variantChoices;

  const nums = parseChoiceNums(answerStr);

  if (nums.length === 0) return answerStr;



  return nums.map((n) => {

    const label = CHOICE_LABELS[n - 1] || `${n}`;

    const text = choices[n - 1];

    return text ? `${label} ${mathTextToPlainString(text)}` : label;

  }).join(' · ');

}



/** 출제자 정답·풀이 (채점 결과·동료 평가 2단계) */

export function CreatorGradeReveal({ problem, creatorSolution, creatorSolutionLoading }) {

  const answerDisplay = formatCreatorAnswerDisplay(problem);

  const solutionText = String(creatorSolution || '').trim();



  return (

    <div className="cpb-grade-result__creator-reveal">

      <p className="cpb-grade-result__creator-answer">

        <span className="cpb-grade-result__creator-label">친구가 적은 정답</span>

        <span className="cpb-grade-result__creator-value">

          {renderMathText(answerDisplay)}

        </span>

      </p>

      <div className="cpb-grade-result__creator-solution">

        <span className="cpb-grade-result__creator-label">친구가 적은 풀이</span>

        {creatorSolutionLoading ? (

          <span className="cpb-grade-result__creator-solution-loading">불러오는 중…</span>

        ) : solutionText ? (

          <div className="cpb-grade-result__creator-solution-body">

            {renderMathText(solutionText)}

          </div>

        ) : (

          <span className="cpb-grade-result__creator-solution-empty">
            {CREATOR_SOLUTION_STORAGE_EMPTY_MSG}
          </span>

        )}

      </div>

    </div>

  );

}



/** 평가 비교용 — 선지를 줄글 형태로 표시 */

function CompactChoicesList({ choices }) {

  if (!Array.isArray(choices) || choices.length === 0) return null;

  return (

    <div className="vpe-panel-choices" role="list" aria-label="선지">

      {choices.map((c, ci) => {

        const block = choiceNeedsBlockLayout(c);

        return (

          <div key={ci} className="vpe-panel-choice" role="listitem">

            <span className="vpe-panel-choice-label">{CHOICE_LABELS[ci] || `${ci + 1}`}</span>

            <span className={`vpe-panel-choice-text${block ? ' vpe-panel-choice-text--block' : ''}`}>

              <ChoiceText text={c} />

            </span>

          </div>

        );

      })}

    </div>

  );

}



function ComparePanels({

  originalQuestion,

  originalBogi,

  originalChoices,

  variantQuestion,

  variantBogi,

  variantChoices,

  tableData,

}) {

  return (

    <div className="vpe-compare">

      <div className="vpe-panel">

        <div className="vpe-panel-title">원본 문제</div>

        <QuestionBodyRenderer text={originalQuestion || ''} className="vpe-panel-body" />

        {originalBogi && (

          <QuestionBodyRenderer text={originalBogi} className="vpe-panel-body vpe-panel-bogi" />

        )}

        <CompactChoicesList choices={originalChoices} />

      </div>

      <div className="vpe-panel vpe-panel--variant">

        <div className="vpe-panel-title">학생이 만든 문제</div>

        <QuestionBodyRenderer text={getExamQuestionStemForStudent(variantQuestion)} tableData={tableData} className="vpe-panel-body" />

        {variantBogi && (

          <QuestionBodyRenderer text={variantBogi} className="vpe-panel-body vpe-panel-bogi" />

        )}

        <CompactChoicesList choices={variantChoices} />

      </div>

    </div>

  );

}



/** AI 검수·선생님 확인 완료 배너 */

export function AiVerifiedBanner({ problem, className = '' }) {

  const verified = isTeacherReviewConfirmed(problem);

  if (!verified) return null;

  const colorClass = problem?.teacherReviewStatus === SUBMISSION_STATUS_APPROVED_PARTIAL
    || problem?.status === SUBMISSION_STATUS_APPROVED_PARTIAL
    ? 'vpe-ai-verified--orange' : 'vpe-ai-verified--green';



  return (

    <div className={`vpe-ai-verified ${colorClass}${className ? ` ${className}` : ''}`} role="status">

      <strong>선생님 확인 완료</strong>

    </div>

  );

}



/** X 선택 시 코멘트 입력 */

export function ProblemThoughtPanel({

  value,

  onChange,

  onConfirm,

  onCancel,

  cancelLabel = '취소',

  confirming = false,

  disabled = false,

  className = '',

  title = '이 문제에 대한 생각을 남겨주세요.',

  confirmLabel = '제출',

}) {

  function handleConfirmClick() {

    if (!value.trim()) {

      alert('이 문제에 대한 생각을 남겨주세요.');

      return;

    }

    onConfirm();

  }



  return (

    <div className={`vpe-step vpe-step--thought cpb-problem-thought-panel ${className}`.trim()}>

      <div className="vpe-question">{title}</div>

      <textarea

        className="vpe-thought-input"

        value={value}

        onChange={(e) => onChange(e.target.value)}

        placeholder="예시: 정답이 틀린 것 같아요. 원본과 거의 같아요. 풀이가 빠졌어요."

        rows={4}

        disabled={disabled || confirming}

      />

      <button

        type="button"

        className="btn btn-primary vpe-thought-confirm"

        disabled={disabled || confirming}

        onClick={handleConfirmClick}

      >

        {confirming ? '저장 중…' : confirmLabel}

      </button>

      {onCancel && (

        <button

          type="button"

          className="btn btn-outline vpe-back-btn"

          disabled={disabled || confirming}

          onClick={onCancel}

        >

          {cancelLabel}

        </button>

      )}

    </div>

  );

}



function PeerCheckRow({ checkKey, value, disabled, unavailable, unavailableHint, onPick }) {

  const label = PEER_EVAL_CHECK_LABELS[checkKey] || checkKey;

  const question = PEER_EVAL_CHECK_QUESTIONS[checkKey] || label;

  const rowDisabled = disabled || unavailable;



  return (

    <div
      className={`vpe-check-row${unavailable ? ' vpe-check-row--unavailable' : ''}`}
      role="group"
      aria-label={label}
      aria-disabled={unavailable || undefined}
    >

      <div className="vpe-check-row__text">

        <span className="vpe-check-row__label">{label}</span>

        <span className="vpe-check-row__question">{question}</span>

        {unavailable && unavailableHint && (
          <span className="vpe-check-row__unavailable-hint">{unavailableHint}</span>
        )}

      </div>

      <div className="vpe-check-row__btns">

        <button

          type="button"

          className={`vpe-ox-btn vpe-ox-btn--o${value === true ? ' vpe-ox-btn--active' : ''}`}

          disabled={rowDisabled}

          aria-pressed={value === true}

          onClick={() => onPick(true)}

        >

          O

        </button>

        <button

          type="button"

          className={`vpe-ox-btn vpe-ox-btn--x${value === false ? ' vpe-ox-btn--active' : ''}`}

          disabled={rowDisabled}

          aria-pressed={value === false}

          onClick={() => onPick(false)}

        >

          X

        </button>

      </div>

    </div>

  );

}



/**

 * @param {object} props

 * @param {object} props.problem

 * @param {boolean} props.solvedCorrect

 * @param {string} [props.creatorSolution]

 * @param {boolean} [props.creatorSolutionLoading]

 * @param {(result: object) => void|Promise<void>} props.onComplete

 * @param {() => void} [props.onBack]

 * @param {boolean} [props.reportedBadProblemEarly]

 * @param {string} [props.initialProblemThought]

 */

export default function VariantPeerEvaluation({

  problem,

  solvedCorrect,

  creatorSolution = '',

  creatorSolutionLoading = false,

  onComplete,

  onBack,

  reportedBadProblemEarly = false,

  initialProblemThought = '',

}) {

  const [step, setStep] = useState(1);

  const [pickedStrategy, setPickedStrategy] = useState('');

  const [peerChecks, setPeerChecks] = useState(emptyPeerChecks);

  const [problemThought, setProblemThought] = useState('');

  const [submitting, setSubmitting] = useState(false);

  const thoughtPanelRef = useRef(null);

  const strategyOptions = getStrategyEvalOptions();

  const aiPending = problem.aiReviewStatus !== 'done';

  const creatorSolutionText = String(creatorSolution || '').trim();
  const solutionCheckPending = creatorSolutionLoading;
  const solutionCheckUnavailable = !creatorSolutionLoading && !creatorSolutionText;
  const solutionCheckSkipped = solutionCheckUnavailable || solutionCheckPending;

  const requiredCheckKeys = useMemo(
    () => getRequiredPeerEvalCheckKeys(peerChecks, { skipSolutionCheck: solutionCheckSkipped }),
    [peerChecks, solutionCheckSkipped],
  );



  const allChecksPicked = useMemo(

    () => requiredCheckKeys.every((k) => typeof peerChecks[k] === 'boolean'),

    [peerChecks, requiredCheckKeys],

  );



  const allChecksOk = useMemo(

    () => requiredCheckKeys.every((k) => peerChecks[k] === true),

    [peerChecks, requiredCheckKeys],

  );



  const needsComment = allChecksPicked && !allChecksOk;



  async function submitEvaluation(strategyId, checks, thought) {
    if (submitting) return;
    if (!strategyId) {
      alert('전략을 먼저 골라 주세요.');
      setStep(1);
      return;
    }

    setSubmitting(true);

    try {
      await onComplete({
        guessedStrategyId: strategyId,
        creatorStrategyId: problem.variantStrategyId,
        peerChecks: { ...checks },
        problemThought: thought || '',
      });
    } catch (e) {
      console.warn('[peer eval submit]', e);
    } finally {
      setSubmitting(false);
    }
  }



  function handlePickStrategy(strategyId) {

    if (submitting) return;

    setPickedStrategy(strategyId);

    setPeerChecks(emptyPeerChecks());

    setProblemThought('');

    setStep(2);

  }



  function handlePickCheck(key, ok) {

    if (submitting) return;
    if (key === 'solution_ok' && (solutionCheckUnavailable || solutionCheckPending)) return;

    setPeerChecks((prev) => ({ ...prev, [key]: ok }));

  }



  function handleSubmitChecks() {
    if (!allChecksPicked || !pickedStrategy) return;

    if (solutionCheckPending) {
      alert('친구 풀이를 확인하는 중이에요. 잠시만 기다린 뒤 다시 눌러 주세요.');
      return;
    }
    if (!solutionCheckUnavailable && typeof peerChecks.solution_ok !== 'boolean') {
      alert('풀이 과정 평가도 선택해 주세요.');
      return;
    }

    if (needsComment) {
      const prefilled = initialProblemThought.trim();
      if (prefilled && !problemThought.trim()) {
        setProblemThought(prefilled);
      }
      setStep(3);
      return;
    }

    submitEvaluation(pickedStrategy, peerChecks, '');
  }

  function handleConfirmThought() {
    const thought = problemThought.trim();
    if (!thought) {
      alert('이 문제에 대한 생각을 남겨주세요.');
      return;
    }
    submitEvaluation(pickedStrategy, peerChecks, thought);
  }

  useEffect(() => {
    if (step !== 3) return;
    thoughtPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [step]);



  return (

    <div className="vpe-wrap vpe-wrap--eval-full">

      <ComparePanels

        originalQuestion={problem.originalQuestion}

        originalBogi={problem.originalBogi}

        originalChoices={problem.originalChoices}

        variantQuestion={problem.variantQuestion}

        variantBogi={problem.variantBogi}

        variantChoices={problem.variantChoices}

        tableData={problem.tableData}

      />



      <AiVerifiedBanner problem={problem} solvedCorrect={solvedCorrect} />



      {!solvedCorrect && !reportedBadProblemEarly && step === 1 && (

        <p className="vpe-wrong-hint">

          정답은 아니지만, 문제를 어떻게 만들었는지 평가해 볼 수 있어요.

        </p>

      )}



      {reportedBadProblemEarly && step === 1 && (

        <p className="vpe-wrong-hint">

          문제에 오류가 있다고 생각해요. 어떤 전략으로 만들었는지 골라 주세요.

        </p>

      )}



      {step === 1 && (

        <div className="vpe-step vpe-step--strategy">

          <div className="vpe-question">이 문제는 어떤 전략을 사용했나요?</div>

          <div className="vpe-choice-grid vpe-choice-grid--strategy">

            {strategyOptions.map((s) => (

              <button

                key={s.id}

                type="button"

                className={`vpe-choice-btn vpe-choice-btn--large ${pickedStrategy === s.id ? 'vpe-choice-btn--active' : ''}`}

                disabled={submitting}

                onClick={() => handlePickStrategy(s.id)}

              >

                <span className="vpe-choice-title">{s.title}</span>

                <span className="vpe-choice-blurb">({s.evalBlurb})</span>

              </button>

            ))}

          </div>

        </div>

      )}



      {step === 2 && (

        <div className="vpe-step vpe-step--checks">

          <div className="vpe-question">만든 문제를 평가해 주세요</div>



          <CreatorGradeReveal

            problem={problem}

            creatorSolution={creatorSolution}

            creatorSolutionLoading={creatorSolutionLoading}

          />



          {aiPending && (

            <p className="vpe-ai-pending">

              AI 검수가 아직 끝나지 않았어요. AI와의 일치 점수는 검수 후에 반영돼요.

            </p>

          )}



          <div className="vpe-check-list">

            {PEER_EVAL_CHECK_KEYS.map((key) => (
              <PeerCheckRow
                key={key}
                checkKey={key}
                value={peerChecks[key]}
                disabled={submitting}
                unavailable={key === 'solution_ok' && (solutionCheckUnavailable || solutionCheckPending)}
                unavailableHint={
                  key === 'solution_ok' && solutionCheckPending
                    ? '풀이를 불러오는 중이에요.'
                    : key === 'solution_ok' && solutionCheckUnavailable
                      ? '저장소에 풀이가 없어 평가할 수 없어요.'
                      : ''
                }
                onPick={(ok) => handlePickCheck(key, ok)}
              />
            ))}

          </div>



          <div className="vpe-check-actions">

            <button

              type="button"

              className="btn btn-primary"

              disabled={submitting || !allChecksPicked}

              onClick={handleSubmitChecks}

            >

              {solutionCheckPending
                ? '풀이 확인 중…'
                : needsComment
                  ? '다음'
                  : submitting
                    ? '제출 중…'
                    : '제출'}

            </button>

            <button

              type="button"

              className="btn btn-outline vpe-back-btn"

              disabled={submitting}

              onClick={() => setStep(1)}

            >

              전략 다시 고르기

            </button>

          </div>

        </div>

      )}



      {step === 3 && (

        <div ref={thoughtPanelRef}>

          <ProblemThoughtPanel

            value={problemThought}

            onChange={setProblemThought}

            onConfirm={handleConfirmThought}

            onCancel={() => setStep(2)}

            cancelLabel="항목 다시 고르기"

            confirming={submitting}

            disabled={submitting}

            title="어떤 점이 아쉬운지 적어 주세요."

            confirmLabel="제출"

          />

        </div>

      )}



      {onBack && (

        <button

          type="button"

          className="btn btn-outline btn-sm vpe-leave-list-btn"

          disabled={submitting}

          onClick={onBack}

        >

          ← 목록

        </button>

      )}

    </div>

  );

}



function formatCheckMatchLine(row, hasChecksAxis) {

  if (row.skipped) return '— (저장소에 풀이 없음)';

  if (!hasChecksAxis) return '⏳ AI 검수 대기 중';

  if (typeof row.peerOk !== 'boolean') return '—';

  return row.match ? '⭕ AI와 일치' : '❌ AI와 다름';

}



/**

 * 평가 결과 요약

 */

export function VariantEvalResult({ result, solvedCorrect, onBack }) {

  const {

    strategyMatch,

    checkRows = [],

    hasChecksAxis,

    checksMatch,

    checkHitCount = 0,

    peerCheckRewardPoints = 0,

  } = result || {};

  const strategyPoints = strategyMatch ? PEER_EVAL_STRATEGY_POINTS : 0;
  const checkPoints = Number(peerCheckRewardPoints) > 0
    ? Number(peerCheckRewardPoints)
    : computePeerEvalCheckRewardPoints(checkHitCount);
  const totalPeerPoints = strategyPoints + checkPoints;
  const evaluableCheckRows = checkRows.filter((r) => !r.skipped);



  return (

    <div className="vpe-result">

      <div style={{ fontSize: 56 }}>📝</div>

      <h2>기록이 저장됐어요</h2>

      <ul className="vpe-result-list">

        <li>내 풀이: {solvedCorrect ? '⭕ 맞았어요' : '❌ 틀렸어요'}</li>

        <li>전략 맞히기 (AI 대비): {strategyMatch ? '⭕ 일치' : '❌ 불일치'}</li>

        {checkRows.map((row) => (

          <li key={row.key}>

            {PEER_EVAL_CHECK_LABELS[row.key] || row.key} (AI 대비):{' '}

            {formatCheckMatchLine(row, hasChecksAxis)}

          </li>

        ))}

        {hasChecksAxis && evaluableCheckRows.length > 0 && (

          <li className="vpe-result-list__summary">

            항목 일치: {checkHitCount}/{evaluableCheckRows.length}

            {checksMatch ? ' · 모두 일치!' : ''}

          </li>

        )}

      </ul>

      {totalPeerPoints > 0 && (
        <p className="vpe-result-points">
          이번 동료평가 {formatExplorationPoints(totalPeerPoints, { signed: true })}
          {strategyPoints > 0 && checkPoints > 0
            ? ` (전략 ${strategyPoints} + O/X ${checkPoints})`
            : ''}
        </p>
      )}

      <button type="button" className="btn btn-primary" onClick={onBack}>목록으로</button>

    </div>

  );

}


