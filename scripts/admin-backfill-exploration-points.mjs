#!/usr/bin/env node
/**
 * 탐구 포인트 백필 — 기존 활동 기록을 explorationRewards 원장 + 롤링30에 반영
 *
 * 승인·정답 등 모든 백필 점수의 awardDayKst 는 실행일(한국 시각)로 통일합니다.
 * 이미 원장(eventId)이 있으면 건너뜁니다(중복 없음).
 * 백필 항목은 notified=true 로 저장해 로그인 알림 모달은 띄우지 않습니다.
 *
 * 데이터 소스:
 *   - variantReviews status=approved        → 문제 만들기 30
 *   - wrongNoteReviews status=approved      → 오답노트 20
 *   - students/.../makingProblems succeeded → 문제 만들기 30 (위와 eventId 중복 제외)
 *   - students/.../problemBank approved      → 새 문제 만들기 30
 *   - variantEvaluations solve_attempt 정답  → 학급 정답 10 (문항당 1회)
 *   - variantEvaluations peer_evaluation      → 전략 3 / OX 항목 2점×일치 수(최대 6)
 *
 * 사용:
 *   node scripts/admin-backfill-exploration-points.mjs --dry-run
 *   node scripts/admin-backfill-exploration-points.mjs
 *   node scripts/admin-backfill-exploration-points.mjs --class SVT2S9
 *
 *   node scripts/admin-backfill-exploration-points.mjs --use-cli-auth
 *
 * 필요: 서비스 계정 JSON 또는 --use-cli-auth (firebase login 세션)
 */

import admin from 'firebase-admin';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { createRequire } from 'module';
import { FieldValue, Firestore } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXPLORATION_REWARD_KIND = {
  SOLVE_CORRECT: 'solve_correct',
  PEER_EVAL_STRATEGY: 'peer_eval_strategy',
  PEER_EVAL_COMPLETION: 'peer_eval_completion',
  WRONG_NOTE_APPROVED: 'wrong_note_approved',
  MAKING_APPROVED: 'making_approved',
};

const PEER_EVAL_STRATEGY_POINTS = 3;
const PEER_EVAL_CHECK_MATCH_POINTS = 2;

const EXPLORATION_REWARD_POINTS = {
  [EXPLORATION_REWARD_KIND.SOLVE_CORRECT]: 10,
  [EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY]: PEER_EVAL_STRATEGY_POINTS,
  [EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION]: PEER_EVAL_CHECK_MATCH_POINTS,
  [EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED]: 20,
  [EXPLORATION_REWARD_KIND.MAKING_APPROVED]: 30,
};

const EXPLORATION_REWARD_LABELS = {
  [EXPLORATION_REWARD_KIND.SOLVE_CORRECT]: '학급 문제 정답',
  [EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY]: '동료평가 전략 맞히기',
  [EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION]: '동료평가 O/X 항목 (AI 일치·항목당)',
  [EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED]: '오답노트 승인',
  [EXPLORATION_REWARD_KIND.MAKING_APPROVED]: '문제 만들기 승인',
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ROLLING_RANKING_DAYS = 30;

function computePeerEvalCheckRewardPoints(checkHitCount) {
  const hits = Math.max(0, Number(checkHitCount) || 0);
  return hits * PEER_EVAL_CHECK_MATCH_POINTS;
}

function resolvePeerEvalCompletionBackfillPoints(row) {
  if (row.hasChecksAxis) {
    const hits = Number.isFinite(row.checkHitCount)
      ? row.checkHitCount
      : (row.checksMatch ? 3 : 0);
    return computePeerEvalCheckRewardPoints(hits);
  }
  if (Number(row.peerCheckRewardPoints) > 0) return Number(row.peerCheckRewardPoints);
  if (row.aiCompletionLevel && row.completionMatch) return computePeerEvalCheckRewardPoints(3);
  return 0;
}

function getKstDateKey(date = new Date()) {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getRollingWindowStartKey(anchorDate = new Date()) {
  const endKey = getKstDateKey(anchorDate);
  const [y, mo, d] = endKey.split('-').map(Number);
  const endUtcMs = Date.UTC(y, mo - 1, d);
  const startUtcMs = endUtcMs - (ROLLING_RANKING_DAYS - 1) * 86400000;
  const startKst = new Date(startUtcMs + KST_OFFSET_MS);
  const sy = startKst.getUTCFullYear();
  const sm = String(startKst.getUTCMonth() + 1).padStart(2, '0');
  const sd = String(startKst.getUTCDate()).padStart(2, '0');
  return `${sy}-${sm}-${sd}`;
}

function isDateKeyInRollingWindow(dateKey, anchorDate = new Date()) {
  const key = String(dateKey || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const startKey = getRollingWindowStartKey(anchorDate);
  const endKey = getKstDateKey(anchorDate);
  return key >= startKey && key <= endKey;
}

function sumRolling30Daily(dailyMap, anchorDate = new Date()) {
  if (!dailyMap || typeof dailyMap !== 'object') return 0;
  const startKey = getRollingWindowStartKey(anchorDate);
  const endKey = getKstDateKey(anchorDate);
  let sum = 0;
  for (const [key, val] of Object.entries(dailyMap)) {
    if (key >= startKey && key <= endKey) {
      sum += Math.max(0, Number(val) || 0);
    }
  }
  return sum;
}

function pruneDailyToRollingWindow(dailyMap, anchorDate = new Date()) {
  const startKey = getRollingWindowStartKey(anchorDate);
  const out = {};
  if (!dailyMap || typeof dailyMap !== 'object') return out;
  for (const [key, val] of Object.entries(dailyMap)) {
    if (key >= startKey) {
      const n = Math.max(0, Number(val) || 0);
      if (n > 0) out[key] = n;
    }
  }
  return out;
}

function applyDailyPoints(dailyMap, dateKey, points, anchorDate = new Date()) {
  const pts = Math.max(0, Math.floor(Number(points) || 0));
  const daily = pruneDailyToRollingWindow({ ...(dailyMap || {}) }, anchorDate);
  if (pts > 0 && isDateKeyInRollingWindow(dateKey, anchorDate)) {
    daily[dateKey] = (Number(daily[dateKey]) || 0) + pts;
  }
  return {
    explorationDaily: daily,
    explorationRolling30: sumRolling30Daily(daily, anchorDate),
  };
}

function buildVariantProblemKey(examId, questionNumber) {
  return `v_${String(examId).trim()}_q${Number(questionNumber)}`;
}

function buildNewProblemKey(bankDocId) {
  return `n_${String(bankDocId).trim()}`;
}

const DRY_RUN = process.argv.includes('--dry-run');
const USE_CLI_AUTH = process.argv.includes('--use-cli-auth');

function readNamedArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

const CLASS_FILTER = readNamedArg('--class');

const credCli = readNamedArg('--credentials');
if (credCli) process.env.GOOGLE_APPLICATION_CREDENTIALS = credCli;

function findFirebaseToolsAuthModule() {
  const candidates = [];
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const npxRoot = join(local, 'npm-cache', '_npx');
  if (existsSync(npxRoot)) {
    for (const dir of readdirSync(npxRoot)) {
      const authPath = join(npxRoot, dir, 'node_modules', 'firebase-tools', 'lib', 'auth.js');
      if (existsSync(authPath)) {
        try {
          candidates.push({ authPath, mtime: statSync(authPath).mtimeMs });
        } catch { /* ignore */ }
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.authPath || null;
}

async function getCliAccessToken() {
  const authPath = findFirebaseToolsAuthModule();
  if (!authPath) {
    throw new Error('firebase-tools 를 찾을 수 없습니다. firebase login 을 먼저 실행하세요.');
  }
  const ftLib = join(authPath, '..');
  const require = createRequire(join(ftLib, 'configstore.js'));
  const { getAccessToken } = require(authPath);
  const { configstore } = require(join(ftLib, 'configstore.js'));
  const authScopes = [
    'email', 'openid',
    'https://www.googleapis.com/auth/cloudplatformprojects.readonly',
    'https://www.googleapis.com/auth/firebase',
    'https://www.googleapis.com/auth/cloud-platform',
  ];
  const stored = configstore.get('tokens');
  const token = await getAccessToken(stored?.refresh_token, authScopes);
  const accessToken = typeof token === 'string' ? token : token?.access_token;
  if (!accessToken) throw new Error('Firebase CLI 액세스 토큰을 가져오지 못했습니다.');
  return accessToken;
}

async function createFirestoreDb(projectId) {
  if (USE_CLI_AUTH) {
    const accessToken = await getCliAccessToken();
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: accessToken });
    return new Firestore({ projectId, authClient });
  }
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
    });
  }
  return admin.firestore();
}

function serverTimestamp() {
  return USE_CLI_AUTH ? FieldValue.serverTimestamp() : admin.firestore.FieldValue.serverTimestamp();
}

function loadEnvFile() {
  const envPath = join(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** @type {Map<string, Map<string, object>>} uuid -> eventId -> award */
const awardsByStudent = new Map();

function addAward(studentUUID, award) {
  const uuid = String(studentUUID || '').trim();
  const eventId = String(award?.eventId || '').trim();
  if (!uuid || !eventId || !award?.points) return;
  if (!awardsByStudent.has(uuid)) awardsByStudent.set(uuid, new Map());
  const bucket = awardsByStudent.get(uuid);
  if (!bucket.has(eventId)) bucket.set(eventId, { ...award, studentUUID: uuid, eventId });
}

function addMakingAward(studentUUID, problemKey, extra = {}) {
  const key = String(problemKey || '').trim();
  if (!studentUUID || !key) return;
  addAward(studentUUID, {
    eventId: `making_${key}`,
    kind: EXPLORATION_REWARD_KIND.MAKING_APPROVED,
    points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.MAKING_APPROVED],
    labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.MAKING_APPROVED],
    problemKey: key,
    ...extra,
  });
}

async function collectVariantReviews(db) {
  const snap = await db.collection('variantReviews').where('status', '==', 'approved').get();
  for (const d of snap.docs) {
    const row = d.data();
    if (CLASS_FILTER && row.classCode !== CLASS_FILTER) continue;
    const uuid = row.studentUUID;
    if (!uuid || row.examId == null || row.questionNumber == null) continue;
    const problemKey = buildVariantProblemKey(row.examId, row.questionNumber);
    addMakingAward(uuid, problemKey, { reviewId: d.id, classCode: row.classCode || '' });
  }
  return snap.size;
}

async function collectWrongNotes(db) {
  const snap = await db.collection('wrongNoteReviews').where('status', '==', 'approved').get();
  for (const d of snap.docs) {
    const row = d.data();
    if (CLASS_FILTER && row.classCode !== CLASS_FILTER) continue;
    const uuid = row.studentUUID;
    if (!uuid) continue;
    addAward(uuid, {
      eventId: `wrong_note_${d.id}`,
      kind: EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED,
      points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED],
      labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.WRONG_NOTE_APPROVED],
      reviewId: d.id,
      classCode: row.classCode || '',
    });
  }
  return snap.size;
}

async function collectMakingProblems(db) {
  let studentsSnap;
  if (CLASS_FILTER) {
    studentsSnap = await db.collection('students').where('classCode', '==', CLASS_FILTER).get();
  } else {
    studentsSnap = await db.collection('students').get();
  }

  let count = 0;
  for (const st of studentsSnap.docs) {
    const uuid = st.id;
    const mpSnap = await db.collection('students').doc(uuid).collection('makingProblems')
      .where('succeeded', '==', true)
      .get();
    for (const d of mpSnap.docs) {
      count += 1;
      addMakingAward(uuid, d.id, { classCode: st.data()?.classCode || '' });
    }
  }
  return count;
}

async function collectProblemBankApproved(db) {
  let studentsSnap;
  if (CLASS_FILTER) {
    studentsSnap = await db.collection('students').where('classCode', '==', CLASS_FILTER).get();
  } else {
    studentsSnap = await db.collection('students').get();
  }

  let count = 0;
  for (const st of studentsSnap.docs) {
    const uuid = st.id;
    const pbSnap = await db.collection('students').doc(uuid).collection('problemBank')
      .where('status', '==', 'approved')
      .get();
    for (const d of pbSnap.docs) {
      count += 1;
      const row = d.data();
      if (row.examId != null && row.sourceNumber != null) {
        addMakingAward(uuid, buildVariantProblemKey(row.examId, row.sourceNumber), {
          classCode: st.data()?.classCode || '',
        });
      } else {
        addMakingAward(uuid, buildNewProblemKey(d.id), {
          classCode: st.data()?.classCode || '',
        });
      }
    }
  }
  return count;
}

async function collectVariantEvaluations(db) {
  let q = db.collection('variantEvaluations');
  if (CLASS_FILTER) q = q.where('classCode', '==', CLASS_FILTER);
  const snap = await q.get();

  const solveSeen = new Set();

  for (const d of snap.docs) {
    const row = d.data();
    const evaluator = row.evaluatorUUID;
    const problemId = row.problemId;
    if (!evaluator || !problemId) continue;

    if (row.recordType === 'solve_attempt' && row.solvedCorrect) {
      const key = `${evaluator}:${problemId}`;
      if (solveSeen.has(key)) continue;
      solveSeen.add(key);
      addAward(evaluator, {
        eventId: `solve_${problemId}`,
        kind: EXPLORATION_REWARD_KIND.SOLVE_CORRECT,
        points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.SOLVE_CORRECT],
        labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.SOLVE_CORRECT],
        problemId,
        classCode: row.classCode || '',
      });
    }

    if (row.recordType === 'peer_evaluation') {
      if (row.strategyMatch) {
        addAward(evaluator, {
          eventId: `peer_strategy_${problemId}`,
          kind: EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY,
          points: EXPLORATION_REWARD_POINTS[EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY],
          labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.PEER_EVAL_STRATEGY],
          problemId,
          classCode: row.classCode || '',
        });
      }
      const completionPoints = resolvePeerEvalCompletionBackfillPoints(row);
      if (completionPoints > 0) {
        addAward(evaluator, {
          eventId: `peer_completion_${problemId}`,
          kind: EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION,
          points: completionPoints,
          labelKo: EXPLORATION_REWARD_LABELS[EXPLORATION_REWARD_KIND.PEER_EVAL_COMPLETION],
          problemId,
          classCode: row.classCode || '',
        });
      }
    }
  }
  return snap.size;
}

async function applyStudentBackfill(db, uuid, awards, awardDayKst, now) {
  const studentRef = db.collection('students').doc(uuid);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists) return { skipped: awards.length, applied: 0, points: 0 };

  const prev = studentSnap.data();
  let daily = { ...(prev.explorationDaily || {}) };
  let total = Number(prev.explorationPoints) || 0;
  let applied = 0;
  let skipped = 0;
  let addedPoints = 0;

  let batch = db.batch();
  let ops = 0;

  for (const award of awards) {
    const ledgerRef = studentRef.collection('explorationRewards').doc(award.eventId);
    const ledgerSnap = await ledgerRef.get();
    if (ledgerSnap.exists) {
      skipped += 1;
      continue;
    }

    const rollup = applyDailyPoints(daily, awardDayKst, award.points, now);
    daily = rollup.explorationDaily;
    total += award.points;
    addedPoints += award.points;
    applied += 1;

    batch.set(ledgerRef, {
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
    ops += 1;
  }

  if (applied > 0) {
    const rolling = applyDailyPoints(daily, awardDayKst, 0, now).explorationRolling30;
    batch.update(studentRef, {
      explorationPoints: total,
      explorationDaily: daily,
      explorationRolling30: rolling,
    });
    ops += 1;
  }

  if (ops > 0 && !DRY_RUN) await batch.commit();

  return { skipped, applied, points: addedPoints };
}

async function main() {
  loadEnvFile();

  const saDefault = join(__dirname, '..', '.firebase-admin-sa.json');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(saDefault)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saDefault;
    console.warn('credentials: .firebase-admin-sa.json 사용');
  }

  const projectId = process.env.REACT_APP_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    console.error('REACT_APP_FIREBASE_PROJECT_ID 가 없습니다.');
    process.exit(1);
  }
  if (!USE_CLI_AUTH && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Firebase Admin 서비스 계정이 필요합니다 (--credentials, .firebase-admin-sa.json, 또는 --use-cli-auth).');
    process.exit(1);
  }

  const db = await createFirestoreDb(projectId);
  const now = new Date();
  const awardDayKst = getKstDateKey(now);

  console.log(`[옵션] dry-run=${DRY_RUN}  cli-auth=${USE_CLI_AUTH}  awardDayKst=${awardDayKst}` +
    (CLASS_FILTER ? `  class=${CLASS_FILTER}` : '  class=ALL'));
  console.log('[수집] 활동 기록 스캔 중…');

  const vrN = await collectVariantReviews(db);
  const wnN = await collectWrongNotes(db);
  const mpN = await collectMakingProblems(db);
  const pbN = await collectProblemBankApproved(db);
  const evN = await collectVariantEvaluations(db);

  console.log(`  variantReviews(approved): ${vrN}건 스캔`);
  console.log(`  wrongNoteReviews(approved): ${wnN}건 스캔`);
  console.log(`  makingProblems(succeeded): ${mpN}건 스캔`);
  console.log(`  problemBank(approved): ${pbN}건 스캔`);
  console.log(`  variantEvaluations: ${evN}건 스캔`);

  let totalAwards = 0;
  for (const m of awardsByStudent.values()) totalAwards += m.size;
  console.log(`[집계] 학생 ${awardsByStudent.size}명 · 적립 후보 ${totalAwards}건 (eventId 기준 중복 제거됨)`);

  let sumApplied = 0;
  let sumSkipped = 0;
  let sumPoints = 0;

  for (const [uuid, awardMap] of awardsByStudent) {
    const awards = Array.from(awardMap.values());
    const result = await applyStudentBackfill(db, uuid, awards, awardDayKst, now);
    sumApplied += result.applied;
    sumSkipped += result.skipped;
    sumPoints += result.points;
    if (result.applied > 0) {
      console.log(`  ${uuid}: +${result.points} 탐구점수 (${result.applied}건 신규, ${result.skipped}건 기존)`);
    }
  }

  console.log('');
  console.log('── 결과 ──');
  console.log(`신규 적립: ${sumApplied}건 · ${sumPoints} 탐구점수`);
  console.log(`기존 원장(건너뜀): ${sumSkipped}건`);
  console.log(DRY_RUN ? '[dry-run] 실제 쓰기 없음' : '[완료] 백필 반영됨');

  if (!DRY_RUN && sumApplied > 0) {
    const classSnap = await db.collection('classes').get();
    const batch = db.batch();
    let n = 0;
    for (const d of classSnap.docs) {
      batch.update(d.ref, {
        explorationBackfillV1Done: true,
        explorationBackfillV1At: serverTimestamp(),
      });
      n += 1;
    }
    if (n > 0) await batch.commit();
    console.log(`[학급] explorationBackfillV1Done 표시 ${n}개`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
