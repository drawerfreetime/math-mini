/**
 * Firebase 설정 — 교사 인증 및 UUID 기반 학습 데이터 저장에만 사용
 *
 * ★ 저장 원칙 ★
 * - Firebase Auth: 교사 이메일/비밀번호 인증 + 학생 익명 인증
 * - Firestore: UUID 기반 학습 통계 (실명 없음, nameHash만 저장)
 * - 학생 실명은 교사 기기 IndexedDB에만 저장됩니다
 */
import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey:            process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain:        process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.REACT_APP_FIREBASE_APP_ID,
};

const app = getApps().length === 0
  ? initializeApp(firebaseConfig)
  : getApps()[0];

export const auth = getAuth(app);
export const db   = getFirestore(app);
export default app;
