/**
 * 미니게임 — 오늘(KST) 최고 점수 저장 + 반 랭킹 조회
 */
import { doc, runTransaction } from 'firebase/firestore';
import { db } from './config';
import { getStudentsByClass } from './firestoreOps';
import { getKstDateKey } from '../utils/explorationRolling30';
import { buildMiniGameDailyRanking } from '../utils/miniGameDailyRanking';

/** 오늘 날짜 버킷만 유지 */
function buildMiniGameDailyUpdate(prevDaily, dateKey, gameId, score) {
  const prevToday = (prevDaily && prevDaily[dateKey]) || {};
  const prevBest = Math.max(0, Math.floor(Number(prevToday[gameId]) || 0));
  const sessionScore = Math.max(0, Math.floor(Number(score) || 0));
  const todayBest = Math.max(prevBest, sessionScore);
  const isNewBest = sessionScore > prevBest;

  return {
    miniGameDaily: {
      [dateKey]: {
        ...prevToday,
        [gameId]: todayBest,
      },
    },
    todayBest,
    sessionScore,
    isNewBest,
  };
}

/**
 * @param {string} studentUUID
 * @param {{ gameId: string; score: number }} p
 */
export async function submitMiniGameDailyBest(studentUUID, p) {
  const uuid = String(studentUUID || '').trim();
  const gameId = String(p?.gameId || '').trim();
  const score = Math.max(0, Math.floor(Number(p?.score) || 0));
  const todayKey = getKstDateKey();

  if (!uuid || !gameId) {
    return {
      saved: false,
      todayBest: 0,
      sessionScore: score,
      isNewBest: false,
      reason: 'invalid_args',
    };
  }

  const studentRef = doc(db, 'students', uuid);

  try {
    return await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(studentRef);
      if (!snap.exists()) {
        return {
          saved: false,
          todayBest: 0,
          sessionScore: score,
          isNewBest: false,
          reason: 'no_student',
        };
      }

      const prev = snap.data();
      const update = buildMiniGameDailyUpdate(prev.miniGameDaily, todayKey, gameId, score);

      transaction.update(studentRef, {
        miniGameDaily: update.miniGameDaily,
        lastActive: new Date().toISOString(),
      });

      return {
        saved: true,
        todayBest: update.todayBest,
        sessionScore: update.sessionScore,
        isNewBest: update.isNewBest,
      };
    });
  } catch (e) {
    console.warn('[submitMiniGameDailyBest]', gameId, e?.code, e?.message);
    return {
      saved: false,
      todayBest: 0,
      sessionScore: score,
      isNewBest: false,
      reason: e?.code || 'transaction_error',
    };
  }
}

/**
 * @param {{
 *   studentUUID: string;
 *   classCode: string;
 *   gameId: string;
 *   sessionScore: number;
 *   selfRealName?: string;
 * }} p
 */
export async function submitMiniGameDailyBestAndGetRanking(p) {
  const studentUUID = String(p?.studentUUID || '').trim();
  const classCode = String(p?.classCode || '').trim();
  const gameId = String(p?.gameId || '').trim();
  const sessionScore = Math.max(0, Math.floor(Number(p?.sessionScore) || 0));

  const submit = await submitMiniGameDailyBest(studentUUID, { gameId, score: sessionScore });

  if (!classCode) {
    return {
      ...submit,
      ranking: buildMiniGameDailyRanking([], gameId, {
        highlightUuid: studentUUID,
        selfRealName: p?.selfRealName,
        selfTodayBest: submit.todayBest,
        sessionScore: submit.sessionScore,
        isNewBest: submit.isNewBest,
      }),
    };
  }

  let students = [];
  try {
    students = await getStudentsByClass(classCode);
  } catch (e) {
    console.warn('[submitMiniGameDailyBestAndGetRanking] getStudentsByClass', e?.code, e?.message);
  }

  const ranking = buildMiniGameDailyRanking(students, gameId, {
    highlightUuid: studentUUID,
    selfRealName: p?.selfRealName,
    selfTodayBest: submit.todayBest,
    sessionScore: submit.sessionScore,
    isNewBest: submit.isNewBest,
  });

  return { ...submit, ranking };
}

/**
 * @param {string} classCode
 * @param {string} gameId
 * @param {{ highlightUuid?: string; selfRealName?: string }} [options]
 */
export async function fetchMiniGameDailyRanking(classCode, gameId, options = {}) {
  const code = String(classCode || '').trim();
  const gid = String(gameId || '').trim();
  if (!code || !gid) {
    return buildMiniGameDailyRanking([], gid, options);
  }

  let students = [];
  try {
    students = await getStudentsByClass(code);
  } catch (e) {
    console.warn('[fetchMiniGameDailyRanking]', e?.code, e?.message);
  }

  return buildMiniGameDailyRanking(students, gid, options);
}
