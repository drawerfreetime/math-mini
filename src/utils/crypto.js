/**
 * crypto.js — Web Crypto API 기반 암호화 유틸리티
 *
 * ★ 개인정보 보호 중심 설계(Privacy by Design) ★
 * - SHA-256: 학생 실명 및 PIN의 단방향 해싱 (복호화 불가)
 * - AES-256-GCM: 교사 매핑 테이블의 대칭 암호화 (내보내기/가져오기)
 * - 모든 암호화는 브라우저 내장 Web Crypto API만 사용 (외부 라이브러리 없음)
 * - 어떠한 암호화 키도 서버로 전송되지 않습니다
 */

// ─────────────────────────────────────────────
// SHA-256 단방향 해싱
// 학생 실명, PIN 등 민감 데이터는 항상 해시값으로만 서버에 저장
// ─────────────────────────────────────────────

/**
 * 텍스트를 SHA-256으로 해싱합니다 (단방향 — 복호화 불가)
 * @param {string} text
 * @returns {Promise<string>} hex string
 */
export async function sha256(text) {
  const encoder = new TextEncoder();
  const data    = encoder.encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 학생 실명 해시 생성
 * 서버에서 학생을 식별하는 용도로 사용 (실명 자체는 저장 안 함)
 * @param {string} realName - 학생 실명
 * @param {string} classCode - 학급 코드
 * @returns {Promise<string>}
 */
export async function hashStudentName(realName, classCode) {
  // Salt로 classCode를 추가해 다른 반의 같은 이름과 구분
  return sha256(`student:${classCode}:${realName.trim()}`);
}

/**
 * PIN 해싱 (4자리 숫자)
 * 서버에 저장되는 값 — 평문 PIN은 절대 서버로 전송 안 됨
 * @param {string} pin
 * @param {string} classCode
 * @returns {Promise<string>}
 */
export async function hashPIN(pin, classCode) {
  return sha256(`pin:${classCode}:${pin}`);
}

// ─────────────────────────────────────────────
// AES-256-GCM 대칭 암호화
// 교사 매핑 테이블 내보내기/가져오기 전용
// ─────────────────────────────────────────────

const AES_ALGO    = 'AES-GCM';
const KEY_LENGTH  = 256;
const PBKDF2_ITER = 200000;  // NIST 권고 최솟값 이상
const SALT_LEN    = 16;
const IV_LEN      = 12;

/**
 * 비밀번호로부터 AES-256 키 파생 (PBKDF2)
 * @param {string} password
 * @param {Uint8Array} salt
 */
async function deriveKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    keyMaterial,
    { name: AES_ALGO, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 텍스트를 AES-256-GCM으로 암호화합니다
 * @param {string} plaintext - 암호화할 JSON 문자열
 * @param {string} password  - 교사가 입력한 비밀번호
 * @returns {Promise<string>} Base64 인코딩된 암호문 (salt|iv|ciphertext)
 */
export async function aesEncrypt(plaintext, password) {
  const salt       = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv         = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key        = await deriveKey(password, salt);
  const cipherBuf  = await crypto.subtle.encrypt(
    { name: AES_ALGO, iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  // salt(16) + iv(12) + ciphertext 를 하나의 Uint8Array로 합치기
  const combined = new Uint8Array(salt.length + iv.length + cipherBuf.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(cipherBuf), salt.length + iv.length);

  // Base64로 인코딩해 JSON 파일에 저장하기 쉽게
  return btoa(String.fromCharCode(...combined));
}

/**
 * AES-256-GCM으로 암호화된 데이터를 복호화합니다
 * @param {string} encrypted - Base64 인코딩된 암호문
 * @param {string} password  - 복호화 비밀번호
 * @returns {Promise<string>} 평문 JSON 문자열
 */
export async function aesDecrypt(encrypted, password) {
  const combined = new Uint8Array(
    atob(encrypted).split('').map((c) => c.charCodeAt(0))
  );
  const salt      = combined.slice(0, SALT_LEN);
  const iv        = combined.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const cipherBuf = combined.slice(SALT_LEN + IV_LEN);

  const key = await deriveKey(password, salt);
  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: AES_ALGO, iv },
      key,
      cipherBuf
    );
    return new TextDecoder().decode(plainBuf);
  } catch {
    throw new Error('복호화 실패 — 비밀번호를 확인하세요.');
  }
}

/**
 * 암호학적으로 안전한 UUID v4 생성
 * 학생의 서버 식별자로 사용 (실명 대체)
 */
export function generateUUID() {
  return crypto.randomUUID();
}

/**
 * 교사 실명 명단 클라우드 동기화용 암호화 패스프레이즈
 * (교사 UID + 학급코드 — Firestore 규칙으로 해당 교사만 읽기 가능)
 */
export function teacherRosterSyncPassphrase(teacherUid, classCode) {
  const uid = String(teacherUid || '').trim();
  const cc = String(classCode || '').trim().toLowerCase();
  return `math-roster-sync-v1:${uid}:${cc}`;
}
