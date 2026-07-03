import { normalizeClassCode } from './classCode';
import { finitePositiveStudentNumber } from './mergeTeacherStudents';

export const KIMCHI_NICKNAMES = [
  '홍길동',
  '성춘향',
  '이몽룡',
  '심청',
  '흥부',
  '놀부',
  '토끼',
  '자라',
  '선녀',
  '나무꾼',
  '콩쥐',
  '팥쥐',
  '우렁각시',
  '신데렐라',
  '백설공주',
  '라푼젤',
  '피노키오',
  '피터팬',
  '앨리스',
  '도로시',
  '제우스',
  '헤라',
  '포세이돈',
  '아프로디테',
  '셜록',
  '김영희',
  '이철수',
];

/**
 * KIMCHI 개발 계정용 닉네임(출석번호 1~27 매핑).
 * 출석번호가 없으면 목록 인덱스(0-based)로 fallback.
 */
export function resolveKimchiNickname(student, indexFallback0 = null) {
  const sn = finitePositiveStudentNumber(student?.studentNumber);
  const idx = sn != null ? sn - 1 : (indexFallback0 != null ? indexFallback0 : null);
  if (idx == null) return '';
  return KIMCHI_NICKNAMES[idx] || '';
}

/** 교사 대시보드 학생DB — KIMCHI 학급·계정에서만 이름(닉네임) 표시 */
export function shouldShowKimchiNicknameLabels({ teacherEmail, classCode } = {}) {
  const email = String(teacherEmail || '').trim().toLowerCase();
  const cc = normalizeClassCode(classCode);
  return cc === 'KIMCHI' || email.includes('kimchi');
}

/** 실명(닉네임) — 닉네임 없으면 실명만 */
export function formatStudentNameWithNickname(baseName, student, indexFallback0 = null) {
  const base = String(baseName || '').trim();
  if (!base || base === '[이름 없음]') return base;
  const nickname = resolveKimchiNickname(student, indexFallback0);
  return nickname ? `${base}(${nickname})` : base;
}

