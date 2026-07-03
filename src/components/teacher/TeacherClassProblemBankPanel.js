import React, { useMemo, useState } from 'react';
import HudFrame from '../HudFrame';
import { renderMathText } from '../ExamOCR';
import { getExamQuestionStemForStudent } from '../../utils/examSolutionArea';
import { aggregateProblemEvaluationRows, rerunSingleClassProblemAiReview } from '../../firebase/classProblemBankOps';
import { COMPLETION_LEVELS, getStrategyEvalOption } from '../../constants/variantEvaluation';
import {
  formatPct,
  renderReviewMathLines,
  resolveStudentLabel,
  resolveVariantStrategyLabel,
} from '../../utils/teacherDashboardUtils';
import { restoreNames } from '../../utils/anonymizeText';
import { sortRowsByStudentAttendance } from '../../utils/mergeTeacherStudents';
import ClassProblemImprovementPanel from './ClassProblemImprovementPanel';
import TeacherAiFeedbackBox from './TeacherAiFeedbackBox';
import {
  buildClassProblemReviewsPool,
  hasVisibleAiFeedback,
  isAiReviewFallbackNote,
  diagnoseClassProblemAiLink,
  findBestVariantReviewForClassProblem,
  resolveClassProblemAiDisplay,
} from '../../utils/teacherAiFeedback';

const CHOICE_LABELS = ['①', '②', '③', '④', '⑤', '⑥'];

function parseChoiceNums(answerStr) {
  return String(answerStr || '')
    .split(/[,，\s]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function getChoiceLabel(index) {
  return CHOICE_LABELS[index] || `${index + 1}`;
}

/** 객관식 번호 문자열 → 선지 라벨·내용 표시용 React 노드 */
function renderMcAnswer(answerStr, choices) {
  if (!Array.isArray(choices) || choices.length === 0) {
    return answerStr ? renderMathText(answerStr) : '—';
  }
  const nums = parseChoiceNums(answerStr);
  if (!nums.length) {
    return answerStr ? renderMathText(answerStr) : '—';
  }
  return (
    <span className="tcpb-mc-answer">
      {nums.map((n, i) => {
        const idx = n - 1;
        const choiceText = choices[idx];
        return (
          <span key={`${n}-${i}`} className="tcpb-mc-answer__item">
            {i > 0 && ', '}
            <span className="tcpb-mc-answer__label">{getChoiceLabel(idx)}</span>
            {choiceText != null && choiceText !== '' && (
              <span className="tcpb-mc-answer__text">{renderMathText(choiceText)}</span>
            )}
          </span>
        );
      })}
    </span>
  );
}

function McChoicesPreview({ choices, correctAnswer }) {
  const correctNums = new Set(parseChoiceNums(correctAnswer));
  return (
    <ul className="tcpb-mc-choices">
      {choices.map((c, ci) => {
        const num = ci + 1;
        const isCorrect = correctNums.has(num);
        return (
          <li
            key={ci}
            className={`tcpb-mc-choice${isCorrect ? ' tcpb-mc-choice--correct' : ''}`}
          >
            <span className="tcpb-mc-choice__label">{getChoiceLabel(ci)}</span>
            <span className="tcpb-mc-choice__text">{renderMathText(c)}</span>
            {isCorrect && <span className="tcpb-mc-choice__mark">정답</span>}
          </li>
        );
      })}
    </ul>
  );
}

function completionLabel(levelId) {
  return COMPLETION_LEVELS[levelId]?.label || levelId || '—';
}

function strategyLabel(strategyId) {
  return getStrategyEvalOption(strategyId)?.title || strategyId || '—';
}

function resolveAiGradedCorrect(solve) {
  if (!solve) return null;
  if (typeof solve.aiGradedCorrect === 'boolean') return solve.aiGradedCorrect;
  return solve.solvedCorrect;
}

function wasSolveGradeOverridden(solve) {
  if (!solve || typeof solve.aiGradedCorrect !== 'boolean') return false;
  return solve.aiGradedCorrect !== solve.solvedCorrect;
}

function CorrectnessMark({ correct }) {
  if (correct == null) return '—';
  return correct ? '⭕' : '❌';
}

function ProblemListItem({ problem, summary, creatorLabel, selected, onSelect, aiItem }) {
  const { solveCount, correctCount, evalCount, pendingEvalCount, commentCount } = summary;
  const rate = solveCount > 0 ? Math.round((correctCount / solveCount) * 100) : null;
  const showAiBadge = hasVisibleAiFeedback(aiItem);
  const aiRejected = aiItem?.aiApproved === false;

  return (
    <button
      type="button"
      className={`tcpb-problem-item${selected ? ' tcpb-problem-item--selected' : ''}`}
      onClick={() => onSelect(problem.id)}
    >
      <div className="tcpb-problem-item__head">
        <span className="tcpb-problem-item__label">{problem.label}</span>
        <div className="tcpb-problem-item__head-right">
          {showAiBadge && (
            <span
              className={`tcpb-problem-item__ai-badge${aiRejected ? ' tcpb-problem-item__ai-badge--fail' : ''}`}
              title="AI 검수 피드백 있음"
            >
              AI
            </span>
          )}
          <span className="tcpb-problem-item__creator">{creatorLabel}</span>
        </div>
      </div>
      {problem.unitGoal && (
        <p className="tcpb-problem-item__unit">{problem.unitGoal}</p>
      )}
      <div className="tcpb-problem-item__badges">
        <span>풀이 {solveCount}</span>
        {rate != null && <span>정답률 {rate}%</span>}
        <span>평가 {evalCount}</span>
        {pendingEvalCount > 0 && (
          <span className="tcpb-problem-item__badge--pending-eval">미완 {pendingEvalCount}</span>
        )}
        {commentCount > 0 && <span className="tcpb-problem-item__badge--comment">코멘트 {commentCount}</span>}
      </div>
    </button>
  );
}

function ProblemDetail({
  problem,
  aiItem,
  linkedReview,
  aiDiag,
  aggregate,
  mergedStudents,
  localMappings,
  classCode,
  onRefresh,
}) {
  const { stats, studentRows, comments } = aggregate;
  const [aiRerunLoading, setAiRerunLoading] = useState(false);
  const creatorLabel = resolveStudentLabel(mergedStudents, problem.createdBy, localMappings);
  const strategyName = problem.variantStrategyName || resolveVariantStrategyLabel(problem);
  const sortedRows = useMemo(
    () => sortRowsByStudentAttendance(studentRows, mergedStudents, 'uuid'),
    [studentRows, mergedStudents],
  );

  const stem = getExamQuestionStemForStudent(problem.variantQuestion);
  const isSubjective = !(
    Array.isArray(problem.variantChoices) && problem.variantChoices.length > 0
  );
  const mcChoices = isSubjective ? null : problem.variantChoices;

  const solutionRaw = String(
    linkedReview?.solutionProcess
    || aiItem?.solutionProcess
    || problem.variantSolutionProcess
    || problem.solutionProcess
    || '',
  ).trim();
  const solutionNameMap = linkedReview?.nameMap || aiItem?.nameMap || problem.nameMap || {};
  const restoredSolution = solutionRaw
    ? restoreNames(solutionRaw, solutionNameMap)
    : '';

  return (
    <div className="tcpb-detail">
      <div className="tcpb-detail__header">
        <h3 className="tcpb-detail__title">{problem.label}</h3>
        <p className="tcpb-detail__meta">
          출제 {creatorLabel}
          {problem.examTitle ? ` · ${problem.examTitle}` : ''}
          {strategyName ? ` · ${strategyName}` : ''}
          {aiItem?.aiReviewStatus === 'done' && (
            <span> · AI 검수 {aiItem.aiApproved ? '승인' : '미승인'}</span>
          )}
        </p>
        <TeacherAiFeedbackBox item={aiItem} className="tcpb-detail__ai-feedback" />
        {isAiReviewFallbackNote(aiItem?.aiNote) && aiDiag && (
          <div className="tcpb-ai-diag" style={{ marginTop: 8, fontSize: 13 }}>
            <p style={{ margin: '0 0 6px', color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '8px 10px' }}>
              <strong>{aiDiag.conclusion || 'AI 폴백 문구 감지'}</strong>
              {aiDiag.inboxHint && (
                <span style={{ display: 'block', marginTop: 4, fontWeight: 400, color: '#78350f' }}>
                  {aiDiag.inboxHint}
                </span>
              )}
              {aiDiag.linkingOk && aiDiag.pickedIsFallback && !aiDiag.sameExamHasNonFallback && (
                <span style={{ display: 'block', marginTop: 4, fontWeight: 400, color: '#78350f' }}>
                  검수함 25건 중 이 문제에 해당하는 정상 AI 피드백이 없습니다. 아래 「이 문제 AI 재검수」를 눌러 주세요.
                </span>
              )}
            </p>
            <details style={{ fontSize: 12, color: '#64748b' }}>
              <summary style={{ cursor: 'pointer' }}>상세 진단 JSON</summary>
              <pre style={{ whiteSpace: 'pre-wrap', marginTop: 6, padding: 8, background: '#f8fafc', borderRadius: 6 }}>
                {JSON.stringify(aiDiag, null, 2)}
              </pre>
            </details>
          </div>
        )}
        {classCode && (isAiReviewFallbackNote(aiItem?.aiNote) ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            style={{ marginTop: 8 }}
            disabled={aiRerunLoading}
            onClick={async () => {
              setAiRerunLoading(true);
              try {
                await rerunSingleClassProblemAiReview(classCode, problem.id);
                onRefresh?.();
              } catch (e) {
                alert(e?.message || 'AI 재검수에 실패했습니다.');
              }
              setAiRerunLoading(false);
            }}
          >
            {aiRerunLoading ? 'AI 재검수 중…' : '이 문제 AI 재검수 (폴백 → Gemini 재시도)'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            style={{ marginTop: 8 }}
            disabled={aiRerunLoading}
            onClick={async () => {
              setAiRerunLoading(true);
              try {
                await rerunSingleClassProblemAiReview(classCode, problem.id);
                onRefresh?.();
              } catch (e) {
                alert(e?.message || 'AI 재검수에 실패했습니다.');
              }
              setAiRerunLoading(false);
            }}
          >
            {aiRerunLoading ? 'AI 재검수 중…' : '이 문제 AI 재검수'}
          </button>
        ))}
      </div>

      <div className="tcpb-detail__preview">
        <div className="tcpb-detail__preview-label">변형 문제</div>
        <div className="tcpb-detail__preview-body">{renderMathText(stem)}</div>
        {mcChoices && (
          <>
            <div className="tcpb-detail__preview-label tcpb-detail__preview-label--choices">선지</div>
            <McChoicesPreview choices={mcChoices} correctAnswer={problem.variantAnswer} />
          </>
        )}
        {problem.variantAnswer && (
          <p className="tcpb-detail__answer">
            <span>정답</span>{' '}
            {mcChoices
              ? renderMcAnswer(problem.variantAnswer, mcChoices)
              : renderMathText(problem.variantAnswer)}
          </p>
        )}
        <div className="tcpb-detail__solution">
          <div className="tcpb-detail__preview-label tcpb-detail__preview-label--solution">
            출제자 풀이과정
            {problem.requiresSolution && (
              <span className="tcpb-detail__solution-flag">필수</span>
            )}
          </div>
          {restoredSolution ? (
            <div className="tcpb-detail__solution-body">
              {renderReviewMathLines(restoredSolution)}
            </div>
          ) : (
            <p className="tcpb-detail__solution-empty">
              {problem.requiresSolution
                ? '(풀이과정 없음 — 출제 시 필수였으나 저장된 내용이 없습니다)'
                : '(풀이과정 없음)'}
            </p>
          )}
        </div>
      </div>

      <div className="tcpb-detail__stats">
        <div className="tcpb-stat-card">
          <span className="tcpb-stat-card__value">{stats.solveCount}</span>
          <span className="tcpb-stat-card__label">풀이</span>
        </div>
        <div className="tcpb-stat-card">
          <span className="tcpb-stat-card__value">
            {stats.solveCount > 0 ? formatPct(stats.correctCount / stats.solveCount) : '—'}
          </span>
          <span className="tcpb-stat-card__label">정답률</span>
        </div>
        <div className="tcpb-stat-card">
          <span className="tcpb-stat-card__value">{stats.evalCount}</span>
          <span className="tcpb-stat-card__label">동료 평가</span>
        </div>
        {stats.pendingEvalCount > 0 && (
          <div className="tcpb-stat-card tcpb-stat-card--warn">
            <span className="tcpb-stat-card__value">{stats.pendingEvalCount}</span>
            <span className="tcpb-stat-card__label">평가 미완료</span>
          </div>
        )}
        <div className="tcpb-stat-card">
          <span className="tcpb-stat-card__value">{stats.unsolvableCount}</span>
          <span className="tcpb-stat-card__label">잘못 만든 문제</span>
        </div>
      </div>

      {comments.length > 0 && (
        <section className="tcpb-comments">
          <h4 className="tcpb-section-title">학생 코멘트</h4>
          <ul className="tcpb-comments__list">
            {comments.map((c) => (
              <li key={`${c.uuid}-${c.thought.slice(0, 24)}`} className="tcpb-comment">
                <div className="tcpb-comment__head">
                  <strong>{resolveStudentLabel(mergedStudents, c.uuid, localMappings)}</strong>
                  <span>{completionLabel(c.completionLevel)}</span>
                </div>
                <p className="tcpb-comment__body">{c.thought}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tcpb-students">
        <h4 className="tcpb-section-title">학생별 기록</h4>
        {sortedRows.length === 0 ? (
          <p className="tcpb-empty-hint">아직 풀이·평가 기록이 없습니다.</p>
        ) : (
          <div className="tcpb-table-wrap tcpb-table-wrap--students">
            <table
              className={`tcpb-table tcpb-table--students${
                isSubjective ? ' tcpb-table--subjective' : ' tcpb-table--objective'
              }`}
            >
              <colgroup>
                <col className="tcpb-col-name" />
                {isSubjective && <col className="tcpb-col-ai" />}
                <col className="tcpb-col-grade" />
                <col className="tcpb-col-answer" />
                <col className="tcpb-col-completion" />
                <col className="tcpb-col-strategy" />
                <col className="tcpb-col-comment" />
              </colgroup>
              <thead>
                <tr>
                  <th>학생</th>
                  {isSubjective && (
                    <th className="tcpb-table__ai-grade" title="자동 채점 결과 (학생이 바꾸기 전)">
                      AI답
                    </th>
                  )}
                  <th>정답</th>
                  <th>제출 답</th>
                  <th>완성도 평가</th>
                  <th>전략 평가</th>
                  <th>코멘트</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const name = resolveStudentLabel(mergedStudents, row.uuid, localMappings);
                  const solve = row.solve;
                  const peer = row.peer;
                  const evalPending = Boolean(solve && !peer);
                  const aiCorrect = resolveAiGradedCorrect(solve);
                  const overridden = wasSolveGradeOverridden(solve);
                  return (
                    <tr
                      key={row.uuid}
                      className={evalPending ? 'tcpb-table__row--eval-pending' : undefined}
                    >
                      <td>{name}</td>
                      {isSubjective && (
                        <td className="tcpb-table__ai-grade">
                          <CorrectnessMark correct={aiCorrect} />
                        </td>
                      )}
                      <td className={overridden ? 'tcpb-table__grade--overridden' : undefined}>
                        <CorrectnessMark correct={solve?.solvedCorrect} />
                        {overridden && (
                          <span className="tcpb-table__override-tag" title="학생이 채점 결과를 바꿨습니다">
                            변경
                          </span>
                        )}
                      </td>
                      <td className="tcpb-table__math">
                        {solve?.submittedAnswer
                          ? (mcChoices
                            ? renderMcAnswer(solve.submittedAnswer, mcChoices)
                            : renderMathText(solve.submittedAnswer))
                          : '—'}
                      </td>
                      <td>
                        {peer
                          ? completionLabel(peer.guessedCompletionLevel)
                          : evalPending
                            ? <span className="tcpb-table__pending-eval">평가 미완료</span>
                            : '—'}
                      </td>
                      <td>
                        {peer
                          ? strategyLabel(peer.guessedStrategyId)
                          : evalPending
                            ? <span className="tcpb-table__pending-eval">평가 미완료</span>
                            : '—'}
                      </td>
                      <td className="tcpb-table__comment">
                        {peer?.problemThought?.trim() || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default function TeacherClassProblemBankPanel({
  problems,
  evaluations,
  loading,
  mergedStudents,
  localMappings,
  selectedProblemId,
  onSelectProblem,
  onRefresh,
  classCode = '',
  inboxVariantReviews = null,
  variantReviewsForBank = null,
}) {
  const evaluationsByProblem = useMemo(() => {
    const map = new Map();
    for (const row of evaluations || []) {
      const pid = row.problemId;
      if (!pid) continue;
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid).push(row);
    }
    return map;
  }, [evaluations]);

  const summariesByProblem = useMemo(() => {
    const map = new Map();
    for (const [pid, rows] of evaluationsByProblem.entries()) {
      map.set(pid, aggregateProblemEvaluationRows(rows).stats);
    }
    return map;
  }, [evaluationsByProblem]);

  const selectedProblem = problems.find((p) => p.id === selectedProblemId) || null;
  const selectedAiItem = selectedProblem
    ? resolveClassProblemAiDisplay(selectedProblem, inboxVariantReviews, variantReviewsForBank)
    : null;
  const selectedAiDiag = selectedProblem
    ? diagnoseClassProblemAiLink(selectedProblem, inboxVariantReviews, variantReviewsForBank)
    : null;
  const selectedAggregate = selectedProblem
    ? aggregateProblemEvaluationRows(evaluationsByProblem.get(selectedProblem.id) || [])
    : null;
  const selectedLinkedReview = useMemo(() => {
    if (!selectedProblem) return null;
    const pool = buildClassProblemReviewsPool(inboxVariantReviews, variantReviewsForBank);
    return findBestVariantReviewForClassProblem(selectedProblem, pool);
  }, [selectedProblem, inboxVariantReviews, variantReviewsForBank]);

  return (
    <div className="tcpb-page-layout">
      <div className="tcpb-page-main">
        <HudFrame className="tcpb-hud-frame">
          <div className="section-header">
            <h2 className="section-title">📚 학급 문제은행</h2>
            <button type="button" className="btn btn-outline btn-sm" onClick={onRefresh} disabled={loading}>
              🔄 새로고침
            </button>
          </div>
          <p className="section-desc" style={{ marginTop: 0 }}>
            학생이 만든 변형 문제와 풀이·동료 평가 기록을 확인할 수 있습니다. 검수함의 AI 피드백도 함께 보며 개선할 수 있습니다.
          </p>

          {loading ? (
            <div className="pmod-loading"><span className="spinner" /> 불러오는 중...</div>
          ) : problems.length === 0 ? (
            <div className="pmod-empty" style={{ padding: '32px 0' }}>
              <div style={{ fontSize: 40 }}>📭</div>
              <p>등록된 학급 문제가 없습니다.</p>
            </div>
          ) : (
            <div className="tcpb-layout">
              <div className="tcpb-list" role="list">
                {problems.map((problem) => {
                  const aiItem = resolveClassProblemAiDisplay(
                    problem,
                    inboxVariantReviews,
                    variantReviewsForBank,
                  );
                  return (
                    <ProblemListItem
                      key={problem.id}
                      problem={problem}
                      aiItem={aiItem}
                      summary={summariesByProblem.get(problem.id) || {
                        solveCount: 0,
                        correctCount: 0,
                        evalCount: 0,
                        pendingEvalCount: 0,
                        commentCount: 0,
                      }}
                      creatorLabel={resolveStudentLabel(mergedStudents, problem.createdBy, localMappings)}
                      selected={selectedProblemId === problem.id}
                      onSelect={onSelectProblem}
                    />
                  );
                })}
              </div>

              <div className="tcpb-detail-pane">
                {!selectedProblem ? (
                  <p className="tcpb-empty-hint tcpb-empty-hint--pane">왼쪽에서 문제를 선택하세요.</p>
                ) : (
                  <ProblemDetail
                    problem={selectedProblem}
                    aiItem={selectedAiItem}
                    linkedReview={selectedLinkedReview}
                    aiDiag={selectedAiDiag}
                    aggregate={selectedAggregate}
                    mergedStudents={mergedStudents}
                    localMappings={localMappings}
                    classCode={classCode}
                    onRefresh={onRefresh}
                  />
                )}
              </div>
            </div>
          )}
        </HudFrame>
      </div>

      <ClassProblemImprovementPanel
        classCode={classCode}
        problem={selectedProblem}
        aiItem={selectedAiItem}
        evaluations={evaluations}
        mergedStudents={mergedStudents}
        evaluationsByProblem={evaluationsByProblem}
      />
    </div>
  );
}
