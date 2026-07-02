/**
 * AI 검수 결과 → 완성도 단계 (동료 평가 정답 기준)
 *
 * @param {{ approved?: boolean, completionLevel?: string, checks?: Record<string, boolean> }} aiReview
 * @returns {'unsolvable'|'strategy_faithful'|'creative'}
 */
export function deriveCompletionLevelFromAiReview(aiReview) {
  const raw = String(aiReview?.completionLevel || aiReview?.completion_level || '').trim();
  if (raw === 'unsolvable' || raw === 'strategy_faithful' || raw === 'creative') {
    return raw;
  }

  const chk = aiReview?.checks || {};
  const approved = !!aiReview?.approved;

  if (
    !approved
    || chk.problem_solvable_ok === false
    || chk.answer_ok === false
    || chk.strategy_match_ok === false
  ) {
    return 'unsolvable';
  }

  return 'strategy_faithful';
}
