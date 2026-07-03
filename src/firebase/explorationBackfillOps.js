/**
 * 탐구 포인트 백필 — 기존 활동 기록을 explorationRewards + 롤링30에 반영
 * (교사 세션, 학급 단위 1회)
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from './config';
import {
  EXPLORATION_REWARD_KIND,
  EXPLORATION_REWARD_POINTS,
  EXPLORATION_REWARD_LABELS,
  computePeerEvalCheckRewardPoints,
} from '../constants/explorationRewards';
import { getKstDateKey, applyDailyPoints } from '../utils/explorationRolling30';
import { buildVariantProblemKey, buildNewProblemKey } from '../utils/computeProblemMakingCompetency';
import { normalizeClassCode } from '../utils/classCode';

function addAward(bucket, studentUUID, award) {
  const uuid = String(studentUUID || '').trim();
  const eventId = String(award?.eventId || '').trim();
  if (!uuid || !eventId || !award?.points) return;
  if (!bucket.has(uuid)) bucket.set(uuid, new Map());
  const perStudent = bucket.get(uuid);
  if (!perStudent.has(eventId)) {
    perStudent.set(eventId, { ...award, studentUUID: uuid, eventId });
  }
}

function addMakingAward(bucket, studentUUID, problemKey, extra = {}) {
  const key = String(problemKey || '').trim();
  if (!studentUUID || !key) return;
  addAward(bucket, studentUUID, {
    eventId: `making_${key}`,
    kind: EXPLORATION_REWARD_KIND.MAKING_APPROVED,
    points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.MAKING_APPROVED],
    labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.MAKING_APPROVED],
    problemKey: key,
    ...extra,
  });
}

async function collectVariantReviews(dbRef, classCode, bucket) {
  const norm = normalizeClassCode(classCode);
  const codes = Array.from(new Set([norm, String(classCode || '').trim(), String(classCode || '').trim().toLowerCase()]));
  let count = 0;
  for (const cc of codes) {
    const snap = await getDocs(query(
      collection(dbRef, 'variantReviews'),
      where('classCode', '==', cc),
      where('status', '==', 'approved'),
    ));
    for (const d of snap.docs) {
      count += 1;
      const row = d.data();
      const uuid = row.studentUUID;
      if (!uuid || row.examId == null || row.questionNumber == null) continue;
      addMakingAward(bucket, uuid, buildVariantProblemKey(row.examId, row.questionNumber), {
        reviewId: d.id,
        classCode: row.classCode || cc,
      });
    }
  }
  return count;
}

async function collectWrongNotes(dbRef, classCode, bucket) {
  const norm = normalizeClassCode(classCode);
  const codes = Array.from(new Set([norm, String(classCode || '').trim(), String(classCode || '').trim().toLowerCase()]));
  let count = 0;
  for (const cc of codes) {
    const snap = await getDocs(query(
      collection(dbRef, 'wrongNoteReviews'),
      where('classCode', '==', cc),
      where('status', '==', 'approved'),
    ));
    for (const d of snap.docs) {
      count += 1;
      const row = d.data();
      const uuid = row.studentUUID;
      if (!uuid) continue;
      addAward(bucket, uuid, {
        eventId: `wrong_note_${d.id}`,
        kind: EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED,
        points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED],
        labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED],
        reviewId: d.id,
        classCode: row.classCode || cc,
      });
    }
  }
  return count;
}

async function collectMakingProblems(dbRef, classCode, bucket) {
  const norm = normalizeClassCode(classCode);
  const codes = Array.from(new Set([norm, String(classCode || '').trim(), String(classCode || '').trim().toLowerCase()]));
  let count = 0;
  for (const cc of codes) {
    const studentsSnap = await getDocs(query(collection(dbRef, 'students'), where('classCode', '==', cc)));
    for (const st of studentsSnap.docs) {
      const uuid = st.id;
      const mpSnap = await getDocs(query(
        collection(dbRef, 'students', uuid, 'makingProblems'),
        where('succeeded', '==', true),
      ));
      for (const d of mpSnap.docs) {
        count += 1;
        addMakingAward(bucket, uuid, d.id, { classCode: st.data()?.classCode || cc });
      }
    }
  }
  return count;
}

async function collectProblemBankApproved(dbRef, classCode, bucket) {
  const norm = normalizeClassCode(classCode);
  const codes = Array.from(new Set([norm, String(classCode || '').trim(), String(classCode || '').trim().toLowerCase()]));
  let count = 0;
  for (const cc of codes) {
    const studentsSnap = await getDocs(query(collection(dbRef, 'students'), where('classCode', '==', cc)));
    for (const st of studentsSnap.docs) {
      const uuid = st.id;
      const pbSnap = await getDocs(query(
        collection(dbRef, 'students', uuid, 'problemBank'),
        where('status', '==', 'approved'),
      ));
      for (const d of pbSnap.docs) {
        count += 1;
        const row = d.data();
        if (row.examId != null && row.sourceNumber != null) {
          addMakingAward(bucket, uuid, buildVariantProblemKey(row.examId, row.sourceNumber), {
            classCode: st.data()?.classCode || cc,
          });
        } else {
          addMakingAward(bucket, uuid, buildNewProblemKey(d.id), {
            classCode: st.data()?.classCode || cc,
          });
        }
      }
    }
  }
  return count;
}

async function collectVariantEvaluations(dbRef, classCode, bucket) {
  const norm = normalizeClassCode(classCode);
  const codes = Array.from(new Set([norm, String(classCode || '').trim(), String(classCode || '').trim().toLowerCase()]));
  const solveSeen = new Set();
  let count = 0;

  for (const cc of codes) {
    const snap = await getDocs(query(collection(dbRef, 'variantEvaluations'), where('classCode', '==', cc)));
    count += snap.size;
    for (const d of snap.docs) {
      const row = d.data();
      const evaluator = row.evaluatorUUID;
      const problemId = row.problemId;
      if (!evaluator || !problemId) continue;

      if (row.recordType === 'solve_attempt' && row.solvedCorrect) {
        const key = `${evaluator}:${problemId}`;
        if (solveSeen.has(key)) continue;
        solveSeen.add(key);
        addAward(bucket, evaluator, {
          eventId: `solve_${problemId}`,
          kind: EXPLORATION_REWARD_KIND.SOLVE_CORRECT,
          points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.SOLVE_CORRECT],
          labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.SOLVE_CORRECT],
          problemId,
          classCode: row.classCode || cc,
        });
      }

      if (row.recordType === 'peer_evaluation') {
        if (row.strategyMatch) {
          addAward(bucket, evaluator, {
            eventId: `peer_strategy_${problemId}`,
            kind: EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY,
            points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY],
            labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY],
            problemId,
            classCode: row.classCode || cc,
          });
        }
        const points = row.hasChecksAxis
          ? computePeerEvalCheckRewardPoints(
            Number.isFinite(row.checkHitCount)
              ? row.checkHitCount
              : (row.checksMatch ? 3 : 0),
          )
          : (Number(row.peerCheckRewardPoints) > 0
            ? Number(row.peerCheckRewardPoints)
            : (row.aiCompletionLevel && row.completionMatch
              ? computePeerEvalCheckRewardPoints(3)
              : 0));
        if (points > 0) {
          addAward(bucket, evaluator, {
            eventId: `peer_completion_${problemId}`,
            kind: EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION,
            points,
            labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION],
            problemId,
            classCode: row.classCode || cc,
          });
        }
      }
    }
  }
  return count;
}

async function applyStudentBackfill(uuid, awards, awardDayKst, now) {
  const studentRef = doc(db, 'students', uuid);
  let applied = 0;
  let skipped = 0;
  let addedPoints = 0;

  await runTransaction(db, async (transaction) => {
    const studentSnap = await transaction.get(studentRef);
    if (!studentSnap.exists()) {
      skipped = awards.length;
      return;
    }

    const prev = studentSnap.data();
    let daily = { ...(prev.explorationDaily || {}) };
    let total = Number(prev.explorationPoints) || 0;
    const ledgerSnaps = await Promise.all(
      awards.map((award) => transaction.get(
        doc(db, 'students', uuid, 'explorationRewards', award.eventId),
      )),
    );

    awards.forEach((award, idx) => {
      if (ledgerSnaps[idx].exists()) {
        skipped += 1;
        return;
      }

      const rollup = applyDailyPoints(daily, awardDayKst, award.points, now);
      daily = rollup.explorationDaily;
      total += award.points;
      addedPoints += award.points;
      applied += 1;

      transaction.set(doc(db, 'students', uuid, 'explorationRewards', award.eventId), {
        studentUUID: uuid,
        kind: award.kind,
        points: award.points,
        awardDayKst,
        labelKo: award.labelKo || '',
        notified: true,
        backfilled: true,
        awardedAt: serverTimestamp(),
        ...(award.classCode ? { classCode: award.classCode } : {}),
        ...(award.reviewId ? { reviewId: award.reviewId } : {}),
        ...(award.problemKey ? { problemKey: award.problemKey } : {}),
        ...(award.problemId ? { problemId: award.problemId } : {}),
      });
    });

    if (applied > 0) {
      const rolling = applyDailyPoints(daily, awardDayKst, 0, now).explorationRolling30;
      transaction.update(studentRef, {
        explorationPoints: total,
        explorationDaily: daily,
        explorationRolling30: rolling,
      });
    }
  });

  return { applied, skipped, points: addedPoints };
}

/**
 * @param {string} classCode
 * @returns {Promise<{ applied: number; skipped: number; points: number; students: number }>}
 */
export async function backfillExplorationPointsForClass(classCode) {
  const norm = normalizeClassCode(classCode);
  if (!norm) return { applied: 0, skipped: 0, points: 0, students: 0 };

  const bucket = new Map();
  const now = new Date();
  const awardDayKst = getKstDateKey(now);

  await collectVariantReviews(db, classCode, bucket);
  await collectWrongNotes(db, classCode, bucket);
  await collectMakingProblems(db, classCode, bucket);
  await collectProblemBankApproved(db, classCode, bucket);
  await collectVariantEvaluations(db, classCode, bucket);

  let sumApplied = 0;
  let sumSkipped = 0;
  let sumPoints = 0;

  for (const [uuid, awardMap] of bucket) {
    const awards = Array.from(awardMap.values());
    const result = await applyStudentBackfill(uuid, awards, awardDayKst, now);
    sumApplied += result.applied;
    sumSkipped += result.skipped;
    sumPoints += result.points;
  }

  return {
    applied: sumApplied,
    skipped: sumSkipped,
    points: sumPoints,
    students: bucket.size,
  };
}

/**
 * 동료평가는 저장됐는데 탐구점수(ledger)만 빠진 경우 보정 — 학급 문제은행 새로고침마다 idempotent
 * @param {string} classCode
 * @returns {Promise<{ applied: number; skipped: number; points: number; students: number }>}
 */
export async function reconcilePeerEvalExplorationRewardsForClass(classCode) {
  const norm = normalizeClassCode(classCode);
  if (!norm) return { applied: 0, skipped: 0, points: 0, students: 0 };

  const bucket = new Map();
  const now = new Date();
  const awardDayKst = getKstDateKey(now);

  await collectVariantEvaluations(db, classCode, bucket);

  const peerKinds = new Set([
    EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY,
    EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION,
  ]);

  let sumApplied = 0;
  let sumSkipped = 0;
  let sumPoints = 0;
  let studentCount = 0;

  for (const [uuid, awardMap] of bucket) {
    const awards = Array.from(awardMap.values()).filter((a) => peerKinds.has(a.kind));
    if (awards.length === 0) continue;
    studentCount += 1;
    const result = await applyStudentBackfill(uuid, awards, awardDayKst, now);
    sumApplied += result.applied;
    sumSkipped += result.skipped;
    sumPoints += result.points;
  }

  return {
    applied: sumApplied,
    skipped: sumSkipped,
    points: sumPoints,
    students: studentCount,
  };
}

/** 학급 백필 완료 여부 */
export async function isExplorationBackfillDone(classCode) {
  const norm = normalizeClassCode(classCode);
  if (!norm) return true;
  const codes = Array.from(new Set([norm, String(classCode || '').trim(), String(classCode || '').trim().toLowerCase()]));
  for (const cc of codes) {
    const snap = await getDoc(doc(db, 'classes', cc));
    if (snap.exists() && snap.data()?.explorationBackfillV1Done) return true;
  }
  return false;
}

export async function markExplorationBackfillDone(classCode) {
  const norm = normalizeClassCode(classCode);
  if (!norm) return;
  const classRef = doc(db, 'classes', norm);
  const snap = await getDoc(classRef);
  if (!snap.exists()) return;
  await updateDoc(classRef, {
    explorationBackfillV1Done: true,
    explorationBackfillV1At: serverTimestamp(),
  });
}
