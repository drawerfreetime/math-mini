import { getKstDateKey } from './explorationRolling30';
import {
  finitePositiveStudentNumber,
  studentFirestoreId,
} from './mergeTeacherStudents';
import { resolveRankingDisplayNameForStudent } from './classRanking';

function rankingSortKey(studentNumber) {
  const sn = finitePositiveStudentNumber(studentNumber);
  return sn ?? 9999;
}

/** @param {object} student @param {string} gameId @param {string} [dateKey] */
export function getStudentMiniGameTodayScore(student, gameId, dateKey = getKstDateKey()) {
  const day = student?.miniGameDaily?.[dateKey];
  if (!day || typeof day !== 'object') return 0;
  return Math.max(0, Math.floor(Number(day[gameId]) || 0));
}

/**
 * @param {Array} students
 * @param {string} gameId
 * @param {{
 *   highlightUuid?: string;
 *   selfRealName?: string;
 *   selfTodayBest?: number;
 *   sessionScore?: number;
 *   isNewBest?: boolean;
 *   anchorDate?: Date;
 * }} [options]
 */
export function buildMiniGameDailyRanking(students, gameId, options = {}) {
  const {
    highlightUuid,
    selfRealName,
    selfTodayBest,
    sessionScore = 0,
    isNewBest = false,
    anchorDate = new Date(),
  } = options;
  const dateKey = getKstDateKey(anchorDate);

  const rows = (students || [])
    .map((s) => {
      const uuid = studentFirestoreId(s);
      const isSelf = Boolean(highlightUuid && uuid === highlightUuid);
      let score = getStudentMiniGameTodayScore(s, gameId, dateKey);
      if (isSelf && selfTodayBest != null) {
        score = Math.max(0, Math.floor(Number(selfTodayBest) || 0));
      }
      return {
        uuid,
        score,
        isSelf,
        studentNumber: s?.studentNumber,
        displayName: resolveRankingDisplayNameForStudent(s, { isSelf, selfRealName }),
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return rankingSortKey(a.studentNumber) - rankingSortKey(b.studentNumber);
    })
    .map((r, idx) => ({ ...r, rank: idx + 1 }));

  const selfRow = rows.find((r) => r.isSelf);

  return {
    dateKey,
    gameId,
    rows,
    top3: rows.slice(0, 3),
    selfRank: selfRow?.rank ?? null,
    selfTodayBest: selfRow?.score ?? Math.max(0, Math.floor(Number(selfTodayBest) || 0)),
    sessionScore: Math.max(0, Math.floor(Number(sessionScore) || 0)),
    playerCount: rows.length,
    isNewBest: Boolean(isNewBest),
  };
}
