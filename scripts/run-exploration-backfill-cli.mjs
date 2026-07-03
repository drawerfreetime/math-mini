#!/usr/bin/env node
/**
 * Firebase CLI 로그인 세션으로 탐구 포인트 백필 실행 (비밀번호 불필요)
 *
 * 전제: `firebase login` 으로 교사 계정이 로그인되어 있어야 합니다.
 *
 * 사용:
 *   node scripts/run-exploration-backfill-cli.mjs
 *   node scripts/run-exploration-backfill-cli.mjs --class SVT2S9
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { createRequire } from 'module';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithCredential } from 'firebase/auth';
import { getFirestore, collection, getDocs } from 'firebase/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
          const mtime = statSync(authPath).mtimeMs;
          candidates.push({ authPath, mtime });
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
    throw new Error('firebase-tools 를 찾을 수 없습니다. npx firebase-tools login:list 를 먼저 실행하세요.');
  }
  const ftLib = join(authPath, '..');
  const require = createRequire(join(ftLib, 'configstore.js'));
  const { getAccessToken } = require(authPath);
  const { configstore } = require(join(ftLib, 'configstore.js'));
  const authScopes = [
    'email',
    'openid',
    'https://www.googleapis.com/auth/cloudplatformprojects.readonly',
    'https://www.googleapis.com/auth/firebase',
    'https://www.googleapis.com/auth/cloud-platform',
  ];
  const stored = configstore.get('tokens');
  const token = await getAccessToken(stored?.refresh_token, authScopes);
  const accessToken = typeof token === 'string' ? token : token?.access_token;
  if (!accessToken) throw new Error('Firebase CLI 액세스 토큰을 가져오지 못했습니다. firebase login 을 다시 하세요.');
  return accessToken;
}

/** Google OAuth → Firebase ID 토큰 (Firestore 규칙용) */
async function exchangeForFirebaseIdToken(googleAccessToken, apiKey) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: `access_token=${googleAccessToken}&providerId=google.com`,
        requestUri: 'http://localhost',
        returnIdpCredential: true,
        returnSecureToken: true,
      }),
    },
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || 'Firebase ID 토큰 교환 실패');
  }
  return data;
}

async function main() {
  loadEnvFile();

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

  console.log('[인증] Firebase CLI 세션 사용');
  const accessToken = await getCliAccessToken();
  const idp = await exchangeForFirebaseIdToken(accessToken, firebaseConfig.apiKey);

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const credential = GoogleAuthProvider.credential(idp.oauthIdToken, idp.oauthAccessToken);
  const userCred = await signInWithCredential(auth, credential);
  console.log(`[로그인] ${userCred.user.email}`);

  const db = getFirestore(app);

  const { backfillExplorationPointsForClass, isExplorationBackfillDone, markExplorationBackfillDone } =
    await import('../src/firebase/explorationBackfillOps.js');

  let classCodes = [];
  if (CLASS_FILTER) {
    classCodes = [CLASS_FILTER];
  } else {
    const snap = await getDocs(collection(db, 'classes'));
    classCodes = snap.docs.map((d) => d.id).filter(Boolean);
    console.log(`[학급] ${classCodes.length}개`);
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
    console.log(`  ${cc}: +${result.points} 탐구점수 (${result.applied}건 신규, ${result.skipped}건 기존)`);
  }

  console.log('');
  console.log(`[완료] 신규 ${totalApplied}건 · ${totalPoints} 탐구점수`);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
