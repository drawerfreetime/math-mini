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

let _cached = {
  app: null,
  auth: null,
  db: null,
  initError: null,
};

export function getFirebaseInitError() {
  return _cached.initError;
}

export function ensureFirebase() {
  if (_cached.app || _cached.initError) return _cached;

  try {
    const app = getApps().length === 0
      ? initializeApp(firebaseConfig)
      : getApps()[0];

    const auth = getAuth(app);
    const db = getFirestore(app);

    _cached = { app, auth, db, initError: null };
    return _cached;
  } catch (err) {
    // invalid-api-key 등 초기화 오류가 발생해도 앱 전체가 렌더 전에 크래시 나지 않도록 막는다.
    _cached = { app: null, auth: null, db: null, initError: err };
    console.error('Firebase 초기화 오류:', err);
    return _cached;
  }
}

export function getFirebaseApp() {
  return ensureFirebase().app;
}

export function getFirebaseAuth() {
  return ensureFirebase().auth;
}

export function getFirebaseDb() {
  return ensureFirebase().db;
}

// 기존 코드 호환용(named export) — import 시점에 크래시 방지
export const auth = null;
export const db = null;

const firebaseDefault = null;
export default firebaseDefault;
