#!/usr/bin/env node
/**
 * students/{uuid}.lastActive 백필 — 교사의 「스캔본 자동 정리 → 학생DB 저장」으로
 * 잘못 갱신된 lastActive 만 정리합니다.
 *
 * 배경:
 *   - 과거 코드의 appendStudentExamResult() 는 examResults 추가와 동시에 lastActive 도
 *     서버 시각으로 갱신했습니다. 이는 교사 작업이지만 학생의 "마지막 접속"으로 표시되어
 *     학생 대시보드의 의미를 흐립니다. 현재 코드에서는 lastActive 갱신을 제거했지만,
 *     이미 박혀 있는 잘못된 값은 본 스크립트로 정리합니다.
 *
 * 판단 규칙:
 *   1) examResults 배열의 모든 scoredAt 중 최댓값 = maxScoredAt 을 구한다.
 *   2) |lastActive − maxScoredAt| ≤ TOLERANCE_MS  →  이 lastActive 는 스캔 저장으로
 *      덮여 쓰여진 값이라고 판정한다. (entry.scoredAt 과 lastActive 는 같은 호출 안에서
 *      수~수십 ms 차이로 만들어지므로 정확히 같지 않다.)
 *   3) 위에 해당하는 학생은 다음과 같이 복원한다:
 *        - quizResults 서브컬렉션의 최신 completedAt 이 존재하면  →  그 값으로 설정
 *          (스캔 이전에 있던 실제 마지막 접속 시각을 보존)
 *        - 없으면  →  lastActive = null
 *
 * 사용:
 *   node scripts/admin-reset-scan-lastactive.mjs --dry-run
 *   node scripts/admin-reset-scan-lastactive.mjs                  # 실제 적용
 *   node scripts/admin-reset-scan-lastactive.mjs --class SVT2S9   # 특정 학급만
 *   node scripts/admin-reset-scan-lastactive.mjs --tolerance-ms 30000
 *
 * 필요:
 *   - 서비스 계정 JSON (아래 중 하나)
 *       - GOOGLE_APPLICATION_CREDENTIALS=경로
 *       - node … --credentials "경로"
 *       - math-app0512/.firebase-admin-sa.json (로컬 전용, 커밋 금지)
 *   - .env 의 REACT_APP_FIREBASE_PROJECT_ID
 */

import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DRY_RUN = process.argv.includes('--dry-run');

function readNamedArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

const CLASS_FILTER = readNamedArg('--class');
const TOLERANCE_MS = (() => {
  const raw = readNamedArg('--tolerance-ms');
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

const credCli = readNamedArg('--credentials');
if (credCli) process.env.GOOGLE_APPLICATION_CREDENTIALS = credCli;

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

function parseIsoMs(v) {
  if (!v || typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function maxScoredAtMs(examResults) {
  if (!Array.isArray(examResults) || !examResults.length) return null;
  let best = null;
  for (const e of examResults) {
    const t = parseIsoMs(e?.scoredAt);
    if (t == null) continue;
    if (best == null || t > best) best = t;
  }
  return best;
}

async function latestQuizCompletedAt(db, uuid) {
  const snap = await db
    .collection('students').doc(uuid)
    .collection('quizResults')
    .orderBy('completedAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  const v = snap.docs[0].data()?.completedAt;
  return typeof v === 'string' ? v : null;
}

async function main() {
  loadEnvFile();

  const saDefault = join(__dirname, '..', '.firebase-admin-sa.json');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(saDefault)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saDefault;
    console.warn('credentials: 프로젝트 루트의 .firebase-admin-sa.json 사용');
  }

  const projectId = process.env.REACT_APP_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    console.error('REACT_APP_FIREBASE_PROJECT_ID 가 없습니다 (.env 또는 환경 변수).');
    process.exit(1);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      '서비스 계정을 지정하세요:\n' +
        '  - 환경 변수 GOOGLE_APPLICATION_CREDENTIALS=키.json\n' +
        '  - node scripts/admin-reset-scan-lastactive.mjs --credentials "C:\\path\\to\\key.json"\n' +
        '  - math-app0512/.firebase-admin-sa.json 파일 배치 (git에 올리지 마세요)'
    );
    process.exit(1);
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
    });
  }

  const db = admin.firestore();

  let studentsRef = db.collection('students');
  if (CLASS_FILTER) {
    studentsRef = studentsRef.where('classCode', '==', CLASS_FILTER);
  }
  const snap = await studentsRef.get();

  console.log(
    `[옵션] dry-run=${DRY_RUN}  tolerance=${TOLERANCE_MS}ms` +
      (CLASS_FILTER ? `  class=${CLASS_FILTER}` : '  class=ALL')
  );
  console.log(`[대상] students 문서: ${snap.size}건`);

  let scanned = 0;
  let skippedNoLastActive = 0;
  let skippedNoExam = 0;
  let skippedUnrelated = 0;
  let resetToNull = 0;
  let restoredToQuiz = 0;

  const samples = { reset: [], restored: [] };

  const BATCH_MAX = 400;
  let batch = db.batch();
  let inBatch = 0;

  async function flush() {
    if (inBatch === 0) return;
    if (!DRY_RUN) await batch.commit();
    batch = db.batch();
    inBatch = 0;
  }

  for (const d of snap.docs) {
    scanned += 1;
    const data = d.data() || {};
    const uuid = d.id;

    const laRaw = data.lastActive;
    const laMs = parseIsoMs(laRaw);
    if (!laRaw || laMs == null) {
      skippedNoLastActive += 1;
      continue;
    }

    const maxMs = maxScoredAtMs(data.examResults);
    if (maxMs == null) {
      skippedNoExam += 1;
      continue;
    }

    const diff = Math.abs(laMs - maxMs);
    if (diff > TOLERANCE_MS) {
      skippedUnrelated += 1;
      continue;
    }

    const newer = await latestQuizCompletedAt(db, uuid);
    const newerMs = parseIsoMs(newer);

    let nextValue;
    if (newer && newerMs != null && newerMs < laMs) {
      nextValue = newer;
      restoredToQuiz += 1;
      if (samples.restored.length < 5) {
        samples.restored.push({ uuid, classCode: data.classCode, before: laRaw, after: nextValue });
      }
    } else if (newer && newerMs != null && newerMs >= laMs) {
      skippedUnrelated += 1;
      continue;
    } else {
      nextValue = null;
      resetToNull += 1;
      if (samples.reset.length < 5) {
        samples.reset.push({ uuid, classCode: data.classCode, before: laRaw, after: null });
      }
    }

    batch.update(d.ref, { lastActive: nextValue });
    inBatch += 1;
    if (inBatch >= BATCH_MAX) await flush();
  }

  await flush();

  console.log('');
  console.log('── 결과 요약 ──');
  console.log(`스캔: ${scanned}건`);
  console.log(`  - lastActive 없음 (건너뜀): ${skippedNoLastActive}`);
  console.log(`  - examResults 없음 (건너뜀): ${skippedNoExam}`);
  console.log(`  - 시간 차이가 윈도우 밖이거나 더 최신 퀴즈 존재 (건너뜀): ${skippedUnrelated}`);
  console.log(`  - null 로 리셋: ${resetToNull}`);
  console.log(`  - 최신 퀴즈 시각으로 복원: ${restoredToQuiz}`);
  console.log(DRY_RUN ? '[dry-run] 실제 쓰기는 하지 않았습니다.' : '[적용 완료]');

  if (samples.reset.length) {
    console.log('');
    console.log('샘플 (null 리셋, 최대 5건):');
    for (const s of samples.reset) console.log(' ', s);
  }
  if (samples.restored.length) {
    console.log('');
    console.log('샘플 (퀴즈 시각 복원, 최대 5건):');
    for (const s of samples.restored) console.log(' ', s);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
