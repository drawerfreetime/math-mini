#!/usr/bin/env node
/**
 * 학급 problemBank 단원·학년 라벨 백필 — 초4 1학기 3. 곱셈과 나눗셈
 *
 * 사용:
 *   node scripts/admin-backfill-class-problem-curriculum.mjs --dry-run
 *   node scripts/admin-backfill-class-problem-curriculum.mjs
 *   node scripts/admin-backfill-class-problem-curriculum.mjs --class SVT2S9
 *   node scripts/admin-backfill-class-problem-curriculum.mjs --use-cli-auth
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

const TARGET = {
  examGrade: '초4',
  unitGoal: '곱셈과 나눗셈',
  curriculumGrade: '4',
  curriculumSemester: '1학기',
  curriculumUnit: '3',
  unitKey: '4-1-3',
};

const DRY_RUN = process.argv.includes('--dry-run');
const USE_CLI_AUTH = process.argv.includes('--use-cli-auth');

function readNamedArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

const CLASS_FILTER = readNamedArg('--class');

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

function isLabeled(row) {
  const unitGoal = String(row.unitGoal || '').trim();
  const examGrade = String(row.examGrade || '').trim();
  const cg = String(row.curriculumGrade || '').trim();
  const cs = String(row.curriculumSemester || '').trim();
  const cu = String(row.curriculumUnit || '').trim();
  if (!unitGoal || !examGrade || !cg || !cs || !cu) return false;
  return (
    examGrade === TARGET.examGrade
    && unitGoal === TARGET.unitGoal
    && cg === TARGET.curriculumGrade
    && cs === TARGET.curriculumSemester
    && cu === TARGET.curriculumUnit
  );
}

async function backfillClass(db, classCode) {
  const snap = await db.collection('classes').doc(classCode).collection('problemBank').get();
  let updated = 0;
  let variantSynced = 0;

  for (const d of snap.docs) {
    const row = d.data();
    if (isLabeled(row)) continue;

    const patch = {
      examGrade: TARGET.examGrade,
      unitGoal: TARGET.unitGoal,
      curriculumGrade: TARGET.curriculumGrade,
      curriculumSemester: TARGET.curriculumSemester,
      curriculumUnit: TARGET.curriculumUnit,
      updatedAt: serverTimestamp(),
    };

    if (DRY_RUN) {
      console.log(`  [dry-run] ${classCode}/${d.id} → ${TARGET.examGrade} · ${TARGET.unitGoal}`);
      updated += 1;
      continue;
    }

    await db.collection('classes').doc(classCode).collection('problemBank').doc(d.id).update(patch);
    updated += 1;

    const reviewId = String(row.reviewId || '').trim();
    if (!reviewId) continue;

    const variantRef = db.collection('variantReviews').doc(reviewId);
    const variantSnap = await variantRef.get();
    if (!variantSnap.exists) continue;

    await variantRef.update({
      examGrade: TARGET.examGrade,
      unitGoal: TARGET.unitGoal,
      curriculumGrade: TARGET.curriculumGrade,
      curriculumSemester: TARGET.curriculumSemester,
      curriculumUnit: TARGET.curriculumUnit,
      unitKey: TARGET.unitKey,
      updatedAt: serverTimestamp(),
    });
    variantSynced += 1;
  }

  return { scanned: snap.size, updated, variantSynced };
}

async function main() {
  loadEnvFile();
  const projectId = process.env.REACT_APP_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    console.error('REACT_APP_FIREBASE_PROJECT_ID 가 필요합니다 (.env).');
    process.exit(1);
  }

  const db = await createFirestoreDb(projectId);

  let classCodes = [];
  if (CLASS_FILTER) {
    classCodes = [CLASS_FILTER];
  } else {
    const snap = await db.collection('classes').get();
    classCodes = snap.docs.map((d) => d.id).filter(Boolean);
  }

  console.log(`[백필] 단원 라벨 — 초4 1학기 3. 곱셈과 나눗셈${DRY_RUN ? ' (dry-run)' : ''}`);
  console.log(`[학급] ${classCodes.length}개`);

  let totalUpdated = 0;
  let totalVariant = 0;

  for (const cc of classCodes) {
    const result = await backfillClass(db, cc);
    if (result.updated > 0) {
      console.log(`  ${cc}: ${result.updated}/${result.scanned}건 갱신 · variantReviews ${result.variantSynced}건`);
    }
    totalUpdated += result.updated;
    totalVariant += result.variantSynced;
  }

  console.log('');
  console.log(`[완료] problemBank ${totalUpdated}건 · variantReviews ${totalVariant}건`);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
