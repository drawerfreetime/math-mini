/**
 * 단원별 진행 — Firestore 트랜잭션
 */
import { doc, getDoc, runTransaction } from 'firebase/firestore';
import { db } from './config';
import {
  buildUnitKey,
  normalizeUnitProgress,
  pickActiveUnitKey,
  resolveUnitKeyFromSource,
  isPeerJudge,
  PEER_JUDGE_APPROVAL_THRESHOLD,
} from '../constants/unitProgress';
import {
  applyUnitPoints,
  applyUnitSolveDone,
  applyUnitStrategyApproval,
  applyUnitPeerEvalSuccess,
  buildCreativeOtterCollectionEntry,
} from '../utils/unitProgressEngine';

function patchUnitProgressMap(prevMap, unitKey, nextEntry) {
  return { ...(prevMap || {}), [unitKey]: nextEntry };
}

/**
 * @param {object} studentData
 * @param {string} unitKey
 * @param {import('../constants/unitProgress').UnitProgressEntry} nextEntry
 */
function buildStudentUnitPatch(studentData, unitKey, nextEntry) {
  const unitProgress = patchUnitProgressMap(studentData.unitProgress, unitKey, nextEntry);
  const patch = {
    unitProgress,
    activeUnitKey: unitKey,
    lastActive: new Date().toISOString(),
  };
  const collEntry = buildCreativeOtterCollectionEntry(unitKey, nextEntry);
  if (collEntry) {
    patch.creativeOtterCollection = {
      ...(studentData.creativeOtterCollection || {}),
      [unitKey]: collEntry,
    };
  }
  return patch;
}

/**
 * @param {string} studentUUID
 * @param {string} unitKey
 * @param {number} points
 */
export async function addUnitExplorationPoints(studentUUID, unitKey, points) {
  const uuid = String(studentUUID || '').trim();
  const key = String(unitKey || '').trim();
  const pts = Math.max(0, Math.floor(Number(points) || 0));
  if (!uuid || !key || !/^\d+-\d+-\d+$/.test(key) || pts <= 0) {
    return { ok: false, reason: 'invalid_args' };
  }

  const ref = doc(db, 'students', uuid);
  try {
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists()) return;
      const data = snap.data();
      const prev = normalizeUnitProgress(data.unitProgress?.[key]);
      const next = applyUnitPoints(prev, pts);
      transaction.update(ref, buildStudentUnitPatch(data, key, next));
    });
    return { ok: true, unitKey: key, points: pts };
  } catch (e) {
    console.warn('[addUnitExplorationPoints]', e?.code, e?.message);
    return { ok: false, reason: e?.code || 'transaction_error' };
  }
}

/**
 * @param {string} studentUUID
 * @param {string} unitKey
 */
export async function recordUnitSolveDone(studentUUID, unitKey) {
  const uuid = String(studentUUID || '').trim();
  const key = String(unitKey || '').trim();
  if (!uuid || !key || !/^\d+-\d+-\d+$/.test(key)) {
    return { ok: false, reason: 'invalid_args' };
  }

  const ref = doc(db, 'students', uuid);
  try {
    const out = await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists()) return { ok: false, reason: 'no_student' };
      const data = snap.data();
      const prev = normalizeUnitProgress(data.unitProgress?.[key]);
      const next = applyUnitSolveDone(prev);
      transaction.update(ref, buildStudentUnitPatch(data, key, next));
      return { ok: true, solveDone: next.solveDone, otterStage: next.otterStage };
    });
    return out;
  } catch (e) {
    console.warn('[recordUnitSolveDone]', e?.code, e?.message);
    return { ok: false, reason: e?.code || 'transaction_error' };
  }
}

/**
 * @param {string} studentUUID
 * @param {string} unitKey
 * @param {string} strategyId
 */
export async function recordUnitStrategyApproval(studentUUID, unitKey, strategyId) {
  const uuid = String(studentUUID || '').trim();
  const key = String(unitKey || '').trim();
  const sid = String(strategyId || '').trim();
  if (!uuid || !key || !sid || !/^\d+-\d+-\d+$/.test(key)) {
    return { ok: false, reason: 'invalid_args' };
  }

  const ref = doc(db, 'students', uuid);
  const unlockedAtIso = new Date().toISOString();
  try {
    const out = await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists()) return { ok: false, reason: 'no_student' };
      const data = snap.data();
      const prev = normalizeUnitProgress(data.unitProgress?.[key]);
      const applied = applyUnitStrategyApproval(prev, sid, unlockedAtIso);
      if (!applied) return { ok: false, reason: 'invalid_strategy' };
      transaction.update(ref, buildStudentUnitPatch(data, key, applied.progress));
      return {
        ok: true,
        strategyId: sid,
        newCount: applied.newCount,
        newlyUnlocked: applied.newlyUnlocked,
        otterStage: applied.progress.otterStage,
      };
    });
    return out;
  } catch (e) {
    console.warn('[recordUnitStrategyApproval]', e?.code, e?.message);
    return { ok: false, reason: e?.code || 'transaction_error' };
  }
}

export async function recordUnitPeerEvalSuccess(studentUUID, unitKey, strategyId) {
  const uuid = String(studentUUID || '').trim();
  const key = String(unitKey || '').trim();
  const sid = String(strategyId || '').trim();
  if (!uuid || !key || !sid || !/^\d+-\d+-\d+$/.test(key)) {
    return { ok: false, reason: 'invalid_args' };
  }

  const ref = doc(db, 'students', uuid);
  try {
    const out = await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(ref);
      if (!snap.exists()) return { ok: false, reason: 'no_student' };
      const data = snap.data();
      const prev = normalizeUnitProgress(data.unitProgress?.[key]);
      const applied = applyUnitPeerEvalSuccess(prev, sid);
      if (!applied) return { ok: false, reason: 'invalid_strategy' };
      transaction.update(ref, buildStudentUnitPatch(data, key, applied.progress));
      return {
        ok: true,
        strategyId: sid,
        newCount: applied.newCount,
        otterStage: applied.progress.otterStage,
      };
    });
    return out;
  } catch (e) {
    console.warn('[recordUnitPeerEvalSuccess]', e?.code, e?.message);
    return { ok: false, reason: e?.code || 'transaction_error' };
  }
}

/**
 * @param {string} approverUUID
 * @param {string} strategyId
 * @param {string} [unitKey] — 없으면 승인자 active unit
 */
export async function canStudentPeerApproveStrategy(approverUUID, strategyId, unitKey = '') {
  const ctx = await resolveEvaluatorJudgeContext(approverUUID, strategyId, unitKey);
  return ctx.isPeerJudge;
}

/**
 * 동료 평가 제출 시점의 심사위원 자격·승인 횟수 스냅샷
 * @param {string} evaluatorUUID
 * @param {string} strategyId 평가 대상 문항의 creatorStrategyId
 * @param {string} [unitKey]
 */
export async function resolveEvaluatorJudgeContext(evaluatorUUID, strategyId, unitKey = '') {
  const uuid = String(evaluatorUUID || '').trim();
  const sid = String(strategyId || '').trim();
  const empty = {
    isPeerJudge: false,
    strategyApprovalCount: 0,
    unitKey: String(unitKey || '').trim(),
    judgeThreshold: PEER_JUDGE_APPROVAL_THRESHOLD,
  };
  if (!uuid || !sid) return empty;

  const snap = await getDoc(doc(db, 'students', uuid));
  if (!snap.exists()) return empty;

  const data = snap.data();
  const key = String(unitKey || '').trim() || pickActiveUnitKey(data);
  if (!key) return empty;

  const progress = normalizeUnitProgress(data.unitProgress?.[key]);
  return {
    isPeerJudge: isPeerJudge(progress, sid),
    strategyApprovalCount: progress.approvedByStrategy[sid] || 0,
    unitKey: key,
    judgeThreshold: PEER_JUDGE_APPROVAL_THRESHOLD,
  };
}

/**
 * @param {object|null|undefined} source problem | review | exam
 */
export function resolveUnitKeyForActivity(source) {
  return resolveUnitKeyFromSource(source);
}

export { buildUnitKey, resolveUnitKeyFromSource };
