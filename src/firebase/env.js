/**
 * Firebase 환경변수 점검 유틸
 *
 * Vercel(또는 다른 배포 환경)에서 REACT_APP_* 환경변수가 누락되면
 * Firebase Auth/Firestore 초기화가 실패하여 학생/교사 로그인 모두 동작하지 않습니다.
 *
 * 이 파일은 "왜 로그인 자체가 안 되는지"를 사용자 화면에서 즉시 진단할 수 있도록 돕습니다.
 */
const REQUIRED_FIREBASE_ENV_KEYS = [
  'REACT_APP_FIREBASE_API_KEY',
  'REACT_APP_FIREBASE_AUTH_DOMAIN',
  'REACT_APP_FIREBASE_PROJECT_ID',
  'REACT_APP_FIREBASE_STORAGE_BUCKET',
  'REACT_APP_FIREBASE_MESSAGING_SENDER_ID',
  'REACT_APP_FIREBASE_APP_ID',
];

export function getMissingFirebaseEnvKeys() {
  return REQUIRED_FIREBASE_ENV_KEYS.filter((k) => {
    const v = process.env[k];
    return !v || !String(v).trim();
  });
}

export function isFirebaseEnvReady() {
  return getMissingFirebaseEnvKeys().length === 0;
}

