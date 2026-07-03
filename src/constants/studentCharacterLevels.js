/**
 * 학생 대시보드 캐릭터(탐구달~창의달) 레벨 정의
 * 표시·진화는 단원별 unitProgress.otterStage 기준 (getStudentDisplayOtterStage)
 * calcStudentLevel(totalSolved)는 레거시 폴백
 */

export const CHARACTER_IMAGE_BASE = `${process.env.PUBLIC_URL}/brand/student/character`;



export const STUDENT_CHARACTER_LEVELS = [

  {

    level: 1,

    name: '탐구달',

    minSolved: 0,

    hint: '이번 단원: 동료평가 2번, 풀기 3번, 탐구점수 200 → 분석달',

  },

  {

    level: 2,

    name: '분석달',

    minSolved: 10,

    hint: '이번 단원: 6가지 동료평가 1번씩, 풀기 6번, 탐구점수 250 → 추론달',

  },

  {

    level: 3,

    name: '추론달',

    minSolved: 30,

    hint: '이번 단원: 6가지 동료평가 2번씩, 풀기 10번, 탐구점수 300 → 창의달',

  },

  {

    level: 4,

    name: '창의달',

    minSolved: 60,

    hint: '이번 단원 창의달! 다른 단원도 도전하며 창의달을 모아 보세요.',

  },

];



export const STUDENT_LEVEL_NAMES = Object.fromEntries(

  STUDENT_CHARACTER_LEVELS.map((c) => [c.level, c.name]),

);



export const MAX_STUDENT_CHARACTER_LEVEL = 4;



export function getStudentCharacterByLevel(level) {

  return STUDENT_CHARACTER_LEVELS.find((c) => c.level === level)

    ?? STUDENT_CHARACTER_LEVELS[0];

}



export function calcStudentLevel(totalSolved) {

  if (totalSolved >= 60) return 4;

  if (totalSolved >= 30) return 3;

  if (totalSolved >= 10) return 2;

  return 1;

}



/** @param {number} viewLevel 1~4 @param {boolean} locked */

export function getOtterImageSrc(viewLevel, locked) {

  const suffix = (locked || viewLevel >= 2) ? '-hide' : '';

  return `${CHARACTER_IMAGE_BASE}/otter-${viewLevel}${suffix}.png`;

}


