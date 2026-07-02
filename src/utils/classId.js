/**
 * Firestore 문서 ID로 사용할 classId 생성
 * 형식: {schoolName}_{grade}_{classNum}
 * 예: 서울초등학교_4_3
 *
 * @param {string} schoolName
 * @param {string|number} grade
 * @param {string|number} classNum
 * @returns {string}
 */
export function getClassId(schoolName, grade, classNum) {
  return `${schoolName}_${grade}_${classNum}`;
}

/**
 * userProfile 객체에서 classId 생성
 * @param {object} profile - { schoolName, grade, classNum }
 * @returns {string}
 */
export function getClassIdFromProfile(profile) {
  if (!profile) return '';
  return getClassId(profile.schoolName, profile.grade, profile.classNum);
}
