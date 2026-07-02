/**
 * studentSession.js — 학생 기기(크롬북) localStorage 관리
 *
 * ★ 개인정보 보호 안내 ★
 * 이 파일이 관리하는 localStorage 데이터는 이 기기에만 존재합니다.
 * 실명과 UUID의 연결(매핑)은 학생 본인 기기에만 캐시됩니다.
 * localStorage 삭제 시 교사의 매핑 테이블로 복구 가능합니다.
 *
 * localStorage 키:
 *   math_student_session  ← { uuid, realName, classCode, anonUID, consentGiven, firstLoginAt }
 *   math_student_consent  ← 'true' (보호자 동의 완료 여부)
 */

const SESSION_KEY = 'math_student_session';
const CONSENT_KEY = 'math_student_consent';

/**
 * 학생 세션 저장
 * @param {{ uuid, realName, classCode, anonUID }} session
 */
export function saveStudentSession(session) {
  const existing = getStudentSession();
  const payload  = {
    ...existing,
    ...session,
    lastLoginAt: new Date().toISOString(),
    firstLoginAt: existing?.firstLoginAt || new Date().toISOString(),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
}

/**
 * 학생 세션 불러오기
 * @returns {{ uuid, realName, classCode, anonUID, firstLoginAt } | null}
 */
export function getStudentSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 학생 세션 삭제 (로그아웃)
 */
export function clearStudentSession() {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * 보호자 동의 여부 저장
 */
export function setConsentGiven() {
  localStorage.setItem(CONSENT_KEY, 'true');
}

/**
 * 보호자 동의 여부 확인
 */
export function isConsentGiven() {
  return localStorage.getItem(CONSENT_KEY) === 'true';
}

/**
 * Anonymous UID 업데이트 (Firebase 익명 로그인 후)
 */
export function updateAnonUID(anonUID) {
  const session = getStudentSession();
  if (session) saveStudentSession({ ...session, anonUID });
}
