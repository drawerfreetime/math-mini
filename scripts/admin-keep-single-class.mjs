#!/usr/bin/env node
/**
 * 학급(Firestore `classes`)을 하나만 남기고 나머지 학급·해당 학생 데이터를 삭제합니다.
 *
 * 필요:
 * - 서비스 계정 JSON (아래 중 하나)
 *   - GOOGLE_APPLICATION_CREDENTIALS=경로
 *   - node … --credentials "경로"
 *   - math-mini/.firebase-admin-sa.json (로컬 전용, 커밋 금지)
 * - .env에 REACT_APP_FIREBASE_PROJECT_ID
 *
 * 검토만: node scripts/admin-keep-single-class.mjs --dry-run
 */

import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const KEEP_CODE = 'SVT2S9';
const TEACHER_EMAIL = 'now5zero@sen.go.kr';
const CLASS_NAME = '4학년 6반';

const DRY_RUN = process.argv.includes('--dry-run');

const credIdx = process.argv.indexOf('--credentials');
if (credIdx !== -1 && process.argv[credIdx + 1]) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.argv[credIdx + 1];
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

async function main() {
  loadEnvFile();
  const saDefault = join(__dirname, '..', '.firebase-admin-sa.json');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(saDefault)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saDefault;
    console.warn('credentials: 프로젝트 루트의 .firebase-admin-sa.json 사용');
  }

  const projectId = process.env.REACT_APP_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  if (!projectId) {
    console.error('REACT_APP_FIREBASE_PROJECT_ID가 없습니다 (.env 또는 환경 변수).');
    process.exit(1);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      '다음 중 하나로 서비스 계정을 지정하세요:\n' +
        '  - 환경 변수 GOOGLE_APPLICATION_CREDENTIALS=키.json\n' +
        '  - npm run admin:keep-class -- --credentials "C:\\path\\to\\key.json"\n' +
        '  - math-mini/.firebase-admin-sa.json 파일 배치 (git에 올리지 마세요)'
    );
    process.exit(1);
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
    });
  }

  const auth = admin.auth();
  const db = admin.firestore();

  let teacherUID;
  try {
    const rec = await auth.getUserByEmail(TEACHER_EMAIL);
    teacherUID = rec.uid;
  } catch (e) {
    console.error(`Auth에서 이메일을 찾을 수 없습니다: ${TEACHER_EMAIL}`, e.message);
    process.exit(1);
  }

  const classesSnap = await db.collection('classes').get();
  const codes = classesSnap.docs.map((d) => d.id);
  console.log(`classes 컬렉션: ${codes.length}개`, codes);

  for (const docSnap of classesSnap.docs) {
    const code = docSnap.id;
    if (code === KEEP_CODE) continue;

    const studentsQ = await db.collection('students').where('classCode', '==', code).get();
    console.log(`삭제 예정: 학급 ${code} (학생 ${studentsQ.size}명)`);

    if (DRY_RUN) continue;

    for (const s of studentsQ.docs) {
      await db.recursiveDelete(s.ref);
    }
    await db.recursiveDelete(docSnap.ref);
    console.log(`삭제 완료: ${code}`);
  }

  const keepStudents = await db.collection('students').where('classCode', '==', KEEP_CODE).get();
  const existing = await db.collection('classes').doc(KEEP_CODE).get();
  const createdAt = existing.exists && existing.data().createdAt
    ? existing.data().createdAt
    : new Date().toISOString();

  const payload = {
    classCode: KEEP_CODE,
    teacherUID,
    className: CLASS_NAME,
    teacherEmails: [TEACHER_EMAIL.trim().toLowerCase()],
    createdAt,
    studentCount: keepStudents.size,
  };

  console.log(DRY_RUN ? '[dry-run] 유지/갱신할 문서:' : '유지/갱신:', KEEP_CODE, payload);

  if (!DRY_RUN) {
    await db.collection('classes').doc(KEEP_CODE).set(payload, { merge: false });
    console.log('완료: SVT2S9만 남겼고, 교사·학급명을 반영했습니다.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
