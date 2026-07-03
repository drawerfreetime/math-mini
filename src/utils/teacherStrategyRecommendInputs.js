import { mathTextToStrategyPlainString } from './mathTextToStrategyPlain';
import { matchingItemToPlain } from './matchingItems';
import { resolveExamCurriculumForReview } from './examCurriculum';

function appendMatchingItemsPlain(target) {
  const left = Array.isArray(target?.leftItems) ? target.leftItems : [];
  const right = Array.isArray(target?.rightItems) ? target.rightItems : [];
  if (!left.length && !right.length) return '';
  return [...left, ...right]
    .map((item) => matchingItemToPlain(item))
    .filter(Boolean)
    .join('\n');
}

export function getTeacherGuideDocIdsForProblem(problem) {
  if (!problem) return [];
  if (problem.type === 'group') {
    const nums = (problem.questions || [])
      .map((q) => q?.number)
      .filter((n) => n != null);
    return nums.length ? nums : [problem.label || 'group'];
  }
  return problem.number != null ? [problem.number] : [];
}

export function getStrategyRecommendInputsForIdx(problems, idx, exam) {
  const p = problems[idx];
  if (!p || !exam) return null;
  const target = p?.type === 'group' ? (p.questions?.[0] || p) : p;
  const stem = mathTextToStrategyPlainString(target.question ?? target.text ?? '').trim();
  const matchingPlain = appendMatchingItemsPlain(target);
  const questionPlain = matchingPlain ? `${stem}\n${matchingPlain}` : stem;
  const bogi = p?.type === 'group'
    ? String(p.passage || '').trim()
    : (target.bogi != null ? mathTextToStrategyPlainString(target.bogi).trim() : '');
  const choices = Array.isArray(target.choices)
    ? target.choices.map((c) => mathTextToStrategyPlainString(String(c)))
    : null;
  const curriculum = resolveExamCurriculumForReview(exam);
  return {
    questionPlain,
    bogi,
    choices,
    questionNumber: target.number != null ? Number(target.number) : null,
    unitLabel: curriculum.unit || exam?.unit || '',
    examContext: {
      examGrade: exam?.examGrade || '',
      grade: curriculum.grade,
      semester: curriculum.semester,
      unit: curriculum.unit,
    },
  };
}
