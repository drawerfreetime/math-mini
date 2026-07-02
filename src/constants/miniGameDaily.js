/** 미니게임 — 오늘(KST) 최고 점수 랭킹용 게임 ID */

export const MINI_GAME_ID = {
  SPEED_QUIZ: 'speed_quiz',
  WHACK: 'whack',
  MAKE_TEN_EASY: 'make_ten_easy',
  MAKE_TEN_NORMAL: 'make_ten_normal',
  MAKE_TEN_HARD: 'make_ten_hard',
};

export const MINI_GAME_TITLES = {
  [MINI_GAME_ID.SPEED_QUIZ]: '스피드 퀴즈',
  [MINI_GAME_ID.WHACK]: '답 맞히기',
  [MINI_GAME_ID.MAKE_TEN_EASY]: '10만들기 (쉬움)',
  [MINI_GAME_ID.MAKE_TEN_NORMAL]: '10만들기 (보통)',
  [MINI_GAME_ID.MAKE_TEN_HARD]: '10만들기 (어려움)',
};

/** @param {string} difficultyId easy | normal | hard */
export function makeTenGameId(difficultyId) {
  const id = String(difficultyId || 'easy').trim();
  if (id === 'normal') return MINI_GAME_ID.MAKE_TEN_NORMAL;
  if (id === 'hard') return MINI_GAME_ID.MAKE_TEN_HARD;
  return MINI_GAME_ID.MAKE_TEN_EASY;
}

export function miniGameTitle(gameId) {
  return MINI_GAME_TITLES[gameId] || '미니게임';
}

export const MAKE_TEN_RANK_TABS = [
  { difficultyId: 'easy', gameId: MINI_GAME_ID.MAKE_TEN_EASY, label: '쉬움' },
  { difficultyId: 'normal', gameId: MINI_GAME_ID.MAKE_TEN_NORMAL, label: '보통' },
  { difficultyId: 'hard', gameId: MINI_GAME_ID.MAKE_TEN_HARD, label: '어려움' },
];
