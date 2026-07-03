/**
 * 탐구 포인트 — students/{uuid}/explorationRewards/{eventId} 원장 + 롤링30·누적 집계
 *
 * - 누적(explorationPoints): 즉시 반영
 * - 랭킹(explorationRolling30): 한국 시각 기준 오늘 포함 최근 30일 일별 합
 * - eventId당 1회만 적립
 */
import {
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  collection,
  query,
  where,
  getDocs,
  writeBatch,
  updateDoc,
} from 'firebase/firestore';
import { db } from './config';
import {
  EXPLORATION_REWARD_KIND,
  EXPLORATION_REWARD_POINTS,
  explorationRewardLabel,
  EXPLORATION_REWARD_LABELS,
} from '../constants/explorationRewards';
import {
  getKstDateKey,
  applyDailyPoints,
  sumRolling30Daily,
  pruneDailyToRollingWindow,
  isDateKeyInRollingWindow,
} from '../utils/explorationRolling30';
import { buildVariantProblemKey, buildNewProblemKey } from '../utils/computeProblemMakingCompetency';
import { addUnitExplorationPoints, resolveUnitKeyFromSource } from './unitProgressOps';

/**
 * @param {string} studentUUID
 * @param {{
 *   eventId: string;
 *   kind: string;
 *   points: number;
 *   awardDate?: Date | string;
 *   classCode?: string;
 *   reviewId?: string;
 *   problemKey?: string;
 *   problemId?: string;
 *   labelKo?: string;
 *   unitKey?: string;
 * }} p
 */
export async function awardExplorationPoints(studentUUID, p) {
  const uuid = String(studentUUID || '').trim();
  const eventId = String(p?.eventId || '').trim();
  const kind = String(p?.kind || '').trim();
  const points = Math.max(0, Math.floor(Number(p?.points) || 0));
  const awardDate = p?.awardDate ? new Date(p.awardDate) : new Date();
  const awardDayKst = getKstDateKey(awardDate);
  const labelKo = (p?.labelKo || explorationRewardLabel(kind)).trim();
  const now = new Date();

  if (!uuid || !eventId || !kind || points <= 0) {
    return { awarded: false, points: 0, reason: 'invalid_args' };
  }

  const ledgerRef = doc(db, 'students', uuid, 'explorationRewards', eventId);
  const studentRef = doc(db, 'students', uuid);

  try {
    const result = await runTransaction(db, async (transaction) => {
      const [ledgerSnap, studentSnap] = await Promise.all([
        transaction.get(ledgerRef),
        transaction.get(studentRef),
      ]);

      if (ledgerSnap.exists()) {
        return { awarded: false, points: 0, reason: 'duplicate' };
      }
      if (!studentSnap.exists()) {
        return { awarded: false, points: 0, reason: 'no_student' };
      }

      const prev = studentSnap.data();
      const prevTotal = Number(prev.explorationPoints) || 0;
      const rollup = applyDailyPoints(prev.explorationDaily, awardDayKst, points, now);

      transaction.set(ledgerRef, {
        studentUUID: uuid,
        kind,
        points,
        awardDayKst,
        labelKo,
        notified: false,
        awardedAt: serverTimestamp(),
        ...(p.classCode ? { classCode: p.classCode } : {}),
        ...(p.reviewId ? { reviewId: p.reviewId } : {}),
        ...(p.problemKey ? { problemKey: p.problemKey } : {}),
        ...(p.problemId ? { problemId: p.problemId } : {}),
      });

      transaction.update(studentRef, {
        explorationPoints: prevTotal + points,
        explorationDaily: rollup.explorationDaily,
        explorationRolling30: rollup.explorationRolling30,
        lastActive: new Date().toISOString(),
      });

      return { awarded: true, points, awardDayKst };
    });

    const unitKey = String(p?.unitKey || '').trim();
    if (unitKey && /^\d+-\d+-\d+$/.test(unitKey)) {
      if (result.awarded) {
        const unitResult = await addUnitExplorationPoints(uuid, unitKey, points).catch((e) => {
          console.warn('[awardExplorationPoints] unit points', e?.code, e?.message);
          return { ok: false };
        });
        if (unitResult?.ok) {
          await updateDoc(ledgerRef, { unitPointsApplied: true, unitKey }).catch((e) => {
            console.warn('[awardExplorationPoints] unitPointsApplied flag', e?.code, e?.message);
          });
        }
      }
    }

    return result;
  } catch (e) {
    console.warn('[awardExplorationPoints]', kind, eventId, e?.code, e?.message);
    return { awarded: false, points: 0, reason: e?.code || 'transaction_error' };
  }
}

/** 변형·새 문제 만들기 승인 — 문항당 1회 */
export async function awardMakingExplorationPoints(studentUUID, problemKey, extra = {}) {
  const key = String(problemKey || '').trim();
  if (!studentUUID || !key) return { awarded: false, points: 0, reason: 'invalid_args' };
  return awardExplorationPoints(studentUUID, {
    eventId: `making_${key}`,
    kind: EXPLORATION_REWARD_KIND.MAKING_APPROVED,
    points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.MAKING_APPROVED],
    problemKey: key,
    awardDate: extra.awardDate,
    reviewId: extra.reviewId,
    classCode: extra.classCode,
    unitKey: extra.unitKey,
  });
}

/** variantReviews 승인 시 */
export async function awardMakingExplorationFromVariantReview(review, awardDate, options = {}) {
  const studentUUID = review?.studentUUID;
  const examId = review?.examId;
  const questionNumber = review?.questionNumber;
  if (!studentUUID || examId == null || questionNumber == null) return { awarded: false, points: 0 };
  const problemKey = buildVariantProblemKey(examId, questionNumber);
  const extra = {
    awardDate,
    reviewId: review?.id || review?.reviewId || '',
    classCode: review?.classCode || '',
    unitKey: review?.unitKey || '',
  };

  if (options.partial) {
    return awardExplorationPoints(studentUUID, {
      eventId: `making_${problemKey}`,
      kind: EXPLORATION_REWARD_KIND.MAKING_APPROVED_PARTIAL,
      points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.MAKING_APPROVED_PARTIAL],
      problemKey,
      labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.MAKING_APPROVED_PARTIAL],
      ...extra,
    });
  }

  const fullResult = await awardExplorationPoints(studentUUID, {
    eventId: `making_${problemKey}`,
    kind: EXPLORATION_REWARD_KIND.MAKING_APPROVED,
    points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.MAKING_APPROVED],
    problemKey,
    ...extra,
  });
  if (fullResult.awarded) return fullResult;

  return awardExplorationPoints(studentUUID, {
    eventId: `making_solution_${problemKey}`,
    kind: EXPLORATION_REWARD_KIND.MAKING_SOLUTION_BONUS,
    points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.MAKING_SOLUTION_BONUS],
    problemKey,
    labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.MAKING_SOLUTION_BONUS],
    ...extra,
  });
}

/** 새 문제 bankDocId 승인 시 */
export async function awardMakingExplorationFromNewProblem(uuid, bankDocId, awardDate) {
  if (!uuid || !bankDocId) return { awarded: false, points: 0 };
  return awardMakingExplorationPoints(uuid, buildNewProblemKey(bankDocId), { awardDate });
}

/** @returns {Promise<Array<object>>} */
export async function getUnnotifiedExplorationRewards(studentUUID) {
  const uuid = String(studentUUID || '').trim();
  if (!uuid) return [];
  try {
    const snap = await getDocs(query(
      collection(db, 'students', uuid, 'explorationRewards'),
      where('notified', '==', false),
    ));
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const ta = a.awardedAt?.toMillis?.() || 0;
        const tb = b.awardedAt?.toMillis?.() || 0;
        return ta - tb;
      });
  } catch (e) {
    console.warn('[getUnnotifiedExplorationRewards]', e?.code, e?.message);
    return [];
  }
}

function subtractDailyPoints(dailyMap, dateKey, points, anchorDate = new Date()) {
  const pts = Math.max(0, Math.floor(Number(points) || 0));
  const daily = pruneDailyToRollingWindow({ ...(dailyMap || {}) }, anchorDate);
  if (pts > 0 && isDateKeyInRollingWindow(dateKey, anchorDate) && daily[dateKey]) {
    daily[dateKey] = Math.max(0, (Number(daily[dateKey]) || 0) - pts);
    if (daily[dateKey] === 0) delete daily[dateKey];
  }
  return {
    explorationDaily: daily,
    explorationRolling30: sumRolling30Daily(daily, anchorDate),
  };
}

/**
 * 개발용 풀이 초기화 — eventId 원장 삭제 + 누적·롤링30 차감
 * @param {string} studentUUID
 * @param {string} eventId
 */
export async function revokeExplorationReward(studentUUID, eventId) {
  const uuid = String(studentUUID || '').trim();
  const eid = String(eventId || '').trim();
  if (!uuid || !eid) return { revoked: false, reason: 'invalid_args' };

  const ledgerRef = doc(db, 'students', uuid, 'explorationRewards', eid);
  const studentRef = doc(db, 'students', uuid);
  const now = new Date();

  try {
    return await runTransaction(db, async (transaction) => {
      const [ledgerSnap, studentSnap] = await Promise.all([
        transaction.get(ledgerRef),
        transaction.get(studentRef),
      ]);
      if (!ledgerSnap.exists() || !studentSnap.exists()) {
        return { revoked: false, reason: 'not_found' };
      }

      const ledger = ledgerSnap.data();
      const points = Math.max(0, Number(ledger.points) || 0);
      const awardDayKst = ledger.awardDayKst || getKstDateKey(now);
      const prev = studentSnap.data();
      const prevTotal = Math.max(0, Number(prev.explorationPoints) || 0);
      const rollup = subtractDailyPoints(prev.explorationDaily, awardDayKst, points, now);

      transaction.delete(ledgerRef);
      transaction.update(studentRef, {
        explorationPoints: Math.max(0, prevTotal - points),
        explorationDaily: rollup.explorationDaily,
        explorationRolling30: rollup.explorationRolling30,
        lastActive: now.toISOString(),
      });

      return { revoked: true, points };
    });
  } catch (e) {
    console.warn('[revokeExplorationReward]', eid, e?.code, e?.message);
    return { revoked: false, reason: e?.code || 'transaction_error' };
  }
}

/** 알림 확인 — 랭킹은 적립 시점에 이미 반영됨 */
export async function markExplorationRewardsNotified(studentUUID, eventIds) {
  const uuid = String(studentUUID || '').trim();
  const ids = (eventIds || []).filter(Boolean);
  if (!uuid || !ids.length) return;

  const now = new Date().toISOString();
  const batch = writeBatch(db);
  ids.forEach((eventId) => {
    batch.update(doc(db, 'students', uuid, 'explorationRewards', eventId), {
      notified: true,
      notifiedAt: now,
    });
  });
  await batch.commit();
}

/**
 * 오답노트 승인 후 단원 탐구점수 누락 보정 (기존 승인 건 1회 동기화)
 * @param {string} studentUUID
 */
export async function syncMissingWrongNoteUnitPoints(studentUUID) {
  const uuid = String(studentUUID || '').trim();
  if (!uuid) return { synced: 0 };

  try {
    const snap = await getDocs(query(
      collection(db, 'students', uuid, 'explorationRewards'),
      where('kind', '==', EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED),
    ));

    let synced = 0;
    for (const ledgerDoc of snap.docs) {
      const data = ledgerDoc.data();
      if (data.unitPointsApplied) continue;

      const reviewId = String(data.reviewId || ledgerDoc.id.replace(/^wrong_note_/, '')).trim();
      if (!reviewId) continue;

      const reviewSnap = await getDoc(doc(db, 'wrongNoteReviews', reviewId));
      const unitKey = resolveUnitKeyFromSource(reviewSnap.exists() ? reviewSnap.data() : null);
      if (!unitKey) continue;

      const pts = Math.max(
        0,
        Number(data.points) || EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED],
      );
      if (pts <= 0) continue;

      const unitResult = await addUnitExplorationPoints(uuid, unitKey, pts);
      if (!unitResult?.ok) continue;

      await updateDoc(ledgerDoc.ref, { unitPointsApplied: true, unitKey });
      synced += 1;
    }
    return { synced };
  } catch (e) {
    console.warn('[syncMissingWrongNoteUnitPoints]', e?.code, e?.message);
    return { synced: 0 };
  }
}

/** 오래된 일별 버킷 정리 + explorationRolling30 갱신 (대시보드 로드 시) */
export async function refreshStudentRolling30(studentUUID) {
  const uuid = String(studentUUID || '').trim();
  if (!uuid) return;

  const studentRef = doc(db, 'students', uuid);
  const now = new Date();

  try {
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(studentRef);
      if (!snap.exists()) return;

      const prev = snap.data();
      const daily = pruneDailyToRollingWindow(prev.explorationDaily, now);
      const rolling = sumRolling30Daily(daily, now);
      const prevRolling = Number(prev.explorationRolling30) || 0;

      const dailyChanged = JSON.stringify(daily) !== JSON.stringify(prev.explorationDaily || {});
      if (!dailyChanged && rolling === prevRolling) return;

      transaction.update(studentRef, {
        explorationDaily: daily,
        explorationRolling30: rolling,
      });
    });
  } catch (e) {
    console.warn('[refreshStudentRolling30]', e?.code, e?.message);
  }
}
