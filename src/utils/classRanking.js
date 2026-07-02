import { getStudentRankingPoints } from '../constants/explorationRewards';
import {
  getStudentCharacterByLevel,
  getOtterImageSrc,
} from '../constants/studentCharacterLevels';
import { getStudentDisplayOtterStage } from '../constants/unitProgress';
import {
  finitePositiveStudentNumber,
  studentFirestoreId,
  mappingDisplayNameRaw,
} from './mergeTeacherStudents';

function rankingSortKey(studentNumber) {
  const sn = finitePositiveStudentNumber(studentNumber);
  return sn ?? 9999;
}

export function resolveRankingDisplayNameForStudent(
  student,
  { isSelf = false, selfRealName = '' } = {},
) {
  const fromField = String(student?.displayName || '').trim();
  if (fromField && fromField !== '[이름 없음]') return fromField;
  const fromMapping = mappingDisplayNameRaw(student);
  if (fromMapping) return fromMapping;
  if (isSelf) return selfRealName || '나';
  return '학생';
}

/**
 * @param {Array} students Firestore 또는 mergeStudentsForTeacherView 결과
 * @param {{ highlightUuid?: string, selfRealName?: string }} [options]
 */
export function buildClassRanking(students, options = {}) {
  const { highlightUuid, selfRealName } = options;

  return [...(students || [])]
    .map((s) => ({
      s,
      xp: getStudentRankingPoints(s),
    }))
    .sort((a, b) => {
      if (b.xp !== a.xp) return b.xp - a.xp;
      return rankingSortKey(a.s.studentNumber) - rankingSortKey(b.s.studentNumber);
    })
    .map(({ s, xp }, idx) => {
      const uuid = studentFirestoreId(s);
      const isSelf = Boolean(highlightUuid && uuid === highlightUuid);
      const characterLevel = getStudentDisplayOtterStage(s);
      const character = getStudentCharacterByLevel(characterLevel);
      return {
        rank: idx + 1,
        uuid,
        displayName: resolveRankingDisplayNameForStudent(s, { isSelf, selfRealName }),
        xp,
        isSelf,
        characterLevel,
        characterName: character.name,
        otterImageSrc: getOtterImageSrc(characterLevel, false),
      };
    });
}
