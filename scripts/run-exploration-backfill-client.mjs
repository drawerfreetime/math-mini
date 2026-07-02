#!/usr/bin/env node
/**
 * 교사 계정으로 탐구 포인트 백필 실행 (Firebase Client SDK)
 *
 * 사용:
 *   node scripts/run-exploration-backfill-client.mjs
 *   node scripts/run-exploration-backfill-client.mjs --class SVT2S9
 *   TEACHER_BACKFILL_PASSWORD=비밀번호 node scripts/run-exploration-backfill-client.mjs
 *
 * 필요: .env 의 Firebase 설정 + REACT_APP_SUPERADMIN_EMAIL (또는 --email)
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readNamedArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

const CLASS_FILTER = readNamedArg('--class');
const EMAIL_ARG = readNamedArg('--email');

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

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  loadEnvFile();

  const email = EMAIL_ARG || process.env.TEACHER_BACKFILL_EMAIL || process.env.REACT_APP_SUPERADMIN_EMAIL;
  let password = process.env.TEACHER_BACKFILL_PASSWORD || '';

  if (!email) {
    console.error('교사 이메일이 없습니다 (--email 또는 REACT_APP_SUPERADMIN_EMAIL).');
    process.exit(1);
  }

  const firebaseConfig = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.REACT_APP_FIREBASE_APP_ID,
  };

  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    console.error('.env 에 Firebase 설정이 없습니다.');
    process.exit(1);
  }

  if (!password && process.stdin.isTTY) {
    password = await promptHidden(`교사 비밀번호 (${email}): `);
  }
  if (!password) {
    console.error('비밀번호가 필요합니다 (TEACHER_BACKFILL_PASSWORD 환경 변수 또는 대화형 입력).');
    process.exit(1);
  }

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);

  console.log(`[로그인] ${email}`);
  await signInWithEmailAndPassword(auth, email, password);
  console.log('[로그인] 성공');

  const { backfillExplorationPointsForClass, isExplorationBackfillDone, markExplorationBackfillDone } =
    await import('../src/firebase/explorationBackfillOps.js');

  let classCodes = [];
  if (CLASS_FILTER) {
    classCodes = [CLASS_FILTER];
  } else {
    const snap = await getDocs(collection(db, 'classes'));
    classCodes = snap.docs.map((d) => d.id).filter(Boolean);
    console.log(`[학급] ${classCodes.length}개 발견`);
  }

  let totalApplied = 0;
  let totalPoints = 0;

  for (const cc of classCodes) {
    if (await isExplorationBackfillDone(cc)) {
      console.log(`  ${cc}: 이미 백필 완료 — 건너뜀`);
      continue;
    }
    console.log(`  ${cc}: 백필 실행 중…`);
    const result = await backfillExplorationPointsForClass(cc);
    await markExplorationBackfillDone(cc);
    totalApplied += result.applied;
    totalPoints += result.points;
    console.log(`  ${cc}: +${result.points} 탐구점수 (${result.applied}건 신규, ${result.skipped}건 기존, 학생 ${result.students}명)`);
  }

  console.log('');
  console.log(`[완료] 신규 ${totalApplied}건 · ${totalPoints} 탐구점수`);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
