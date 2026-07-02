/**
 * AI 검토(API review-student-variant) 및 교육과정 파일(backend curriculum/N-N-N.md)
 * 규칙과 맞추기 위한 학년·학기·단원 문자열 준비.
 *
 * 시험 문서에 grade/semester/unit이 비어 있으면 examGrade(숫자)로 학년 추정 후
 * 학기·단원은 저장소에 포함된 안전한 기본값(예: 1학기, 단원 3)으로 채운다.
 */

import { CURRICULUM } from '../constants/curriculum';

function firstDigits(s) {
  if (s == null || s === '') return '';
  const m = String(s).match(/\d+/);
  return m ? m[0] : '';
}

/**
 * @param {object|null|undefined} exam — Firestore exams/{id} 스냅샷 또는 동일 형태
 * @returns {{ grade: string, semester: string, unit: string, wasDerived: boolean }}
 */
export function resolveExamCurriculumForReview(exam) {
  const trim = (v) => {
    if (v == null) return '';
    const t = String(v).trim();
    return t;
  };

  let g = trim(exam?.grade ?? exam?.curriculumGrade);
  let semester = trim(exam?.semester);
  let unit = trim(exam?.unit);

  if (g && semester && unit) {
    return { grade: g, semester, unit, wasDerived: false };
  }

  const egDigit = firstDigits(trim(exam?.examGrade ?? exam?.exam_grade));
  let gradeDigit = firstDigits(g) || egDigit || '4';

  return {
    grade: String(gradeDigit),
    semester: semester || '1학기',
    unit: unit || '3',
    wasDerived: true,
  };
}

/**
 * AI 검토 API unitGoal — "3" 대신 "곱셈과 나눗셈" 등 단원 제목
 * @param {object|null|undefined} exam
 * @param {{ grade: string, semester: string, unit: string }} curriculum
 */
export function resolveUnitGoalLabelForReview(exam, curriculum) {
  const custom = String(exam?.unitGoal || '').trim();
  if (custom.length >= 2 && !/^\d+\.?$/.test(custom)) return custom;

  const unitRaw = String(exam?.unit || '').trim();
  const fromUnit = unitRaw.replace(/^\d+\.\s*/, '').trim();
  if (fromUnit.length >= 2 && !/^\d+$/.test(fromUnit)) return fromUnit;

  const g = String(curriculum?.grade || '4').replace(/\D/g, '') || '4';
  const sem = curriculum?.semester || '1학기';
  const unitNum = parseInt(String(curriculum?.unit || '').replace(/\D/g, ''), 10);
  const gradeKey = `초${g}`;
  const units = CURRICULUM[gradeKey]?.[sem];
  if (units && unitNum >= 1 && unitNum <= units.length) {
    return units[unitNum - 1].replace(/^\d+\.\s*/, '').trim();
  }

  return fromUnit || custom || '';
}
