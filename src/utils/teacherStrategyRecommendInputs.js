import { mathTextToPlainString } from '../components/ExamOCR';
import { resolveExamCurriculumForReview } from './examCurriculum';

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
  const questionPlain = mathTextToPlainString(target.question ?? target.text ?? '').trim();
  const bogi = p?.type === 'group'
    ? String(p.passage || '').trim()
    : (target.bogi != null ? mathTextToPlainString(target.bogi).trim() : '');
  const choices = Array.isArray(target.choices)
    ? target.choices.map((c) => mathTextToPlainString(String(c)))
    : null;
  const curriculum = resolveExamCurriculumForReview(exam);
  return {
    questionPlain,
    bogi,
    choices,
    examContext: {
      examGrade: exam?.examGrade || '',
      grade: curriculum.grade,
      semester: curriculum.semester,
      unit: curriculum.unit,
    },
  };
}
