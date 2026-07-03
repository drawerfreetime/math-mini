/**
 * AuthContext.js — 교사 / 학생 이중 인증 컨텍스트
 *
 * ★ 개인정보 보호 설계 ★
 * - 교사: Firebase Email Auth (도메인 검증)
 * - 학생: Firebase Anonymous Auth + PIN 클라이언트 검증
 *         (학생 실명은 Context state에만 존재, Firebase로 전송 안 됨)
 */
import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  signInAnonymously, createUserWithEmailAndPassword, sendEmailVerification,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase/config';
import {
  hashStudentName, hashPIN,
} from '../utils/crypto';
import { normalizeClassCode } from '../utils/classCode';
import {
  getStudentsByNameHashInClassCodes, updateStudentAnonUID, updateStudentDisplayName,
  saveTeacherGeminiKey, upsertTeacherProfile,
  getClass,
} from '../firebase/firestoreOps';
import {
  getStudentSession, saveStudentSession, clearStudentSession,
} from '../utils/studentSession';

// 허용 교직원 이메일 도메인 (추가 가능)
const ALLOWED_TEACHER_DOMAINS = [
  'korea.kr',       // 공무원 이메일
  'sen.go.kr',      // 서울시 교육청
  'gen.go.kr',      // 경기도 교육청
  'gne.go.kr',      // 경남 교육청
  'jbe.go.kr',      // 전북 교육청
  'cbe.go.kr',      // 충북 교육청
  'dge.go.kr',      // 대구 교육청
  'busanedu.net',   // 부산 교육청
  'gmail.com',      // 개발/테스트용 (운영 시 제거)
];

const SUPERADMIN_EMAIL = process.env.REACT_APP_SUPERADMIN_EMAIL;

const AuthContext = createContext();

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  // 교사 세션
  const [teacherUser,    setTeacherUser]    = useState(null);
  const [teacherProfile, setTeacherProfile] = useState(null);

  // 학생 세션 (실명은 state에만 — 서버 전송 안 됨)
  const [studentSession, setStudentSession] = useState(null);

  const [loading, setLoading] = useState(true);
  const [userType, setUserType] = useState(null); // 'teacher' | 'student' | null

  // ─── Firebase Auth 상태 복원 ───
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user && !user.isAnonymous) {
        // 교사 로그인 상태
        setTeacherUser(user);
        await loadTeacherProfile(user.uid);
        setUserType('teacher');
      } else {
        // 학생 세션 복원 (localStorage) — Firestore 쓰기에는 익명 Auth 필수
        const cached = getStudentSession();
        if (cached?.uuid) {
          let session = cached;
          try {
            if (!user) {
              const anonResult = await signInAnonymously(auth);
              const anonUID = anonResult.user.uid;
              if (session.anonUID !== anonUID) {
                await updateStudentAnonUID(session.uuid, anonUID);
                session = { ...session, anonUID };
                saveStudentSession(session);
              }
            } else if (user.isAnonymous && session.anonUID && user.uid !== session.anonUID) {
              await updateStudentAnonUID(session.uuid, user.uid);
              session = { ...session, anonUID: user.uid };
              saveStudentSession(session);
            }
          } catch (err) {
            console.error('학생 익명 인증 복구 실패:', err);
            clearStudentSession();
            setStudentSession(null);
            setUserType(null);
            setLoading(false);
            return;
          }
          setStudentSession(session);
          setUserType('student');
        } else {
          setTeacherUser(null);
          setTeacherProfile(null);
          setStudentSession(null);
          setUserType(null);
        }
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  // ─────────────────────────────────────────────
  // 교사 로그인
  // ─────────────────────────────────────────────

  /**
   * 교직원 도메인 검증
   */
  function isAllowedTeacherDomain(email) {
    if (email === SUPERADMIN_EMAIL) return true;
    const domain = email.split('@')[1]?.toLowerCase();
    return ALLOWED_TEACHER_DOMAINS.includes(domain);
  }

  async function teacherLogin(email, password) {
    if (!isAllowedTeacherDomain(email)) {
      throw new Error('교직원 이메일(@korea.kr 등) 주소만 로그인할 수 있습니다.');
    }
    const result = await signInWithEmailAndPassword(auth, email, password);
    setUserType('teacher');
    return result;
  }

  async function teacherSignup(email, password) {
    if (!isAllowedTeacherDomain(email)) {
      throw new Error('교직원 이메일(@korea.kr 등) 주소만 가입할 수 있습니다.');
    }
    const result = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(result.user);
    return result.user;
  }

  async function teacherLogout() {
    await signOut(auth);
    setTeacherUser(null);
    setTeacherProfile(null);
    setUserType(null);
  }

  async function loadTeacherProfile(uid) {
    try {
      const snap = await getDoc(doc(db, 'teachers', uid));
      if (snap.exists()) setTeacherProfile(snap.data());
    } catch (err) {
      console.error('교사 프로필 로드 오류:', err);
    }
  }

  /**
   * 교사의 Gemini API 키를 저장하고 로컬 프로필도 갱신합니다.
   * @param {string} geminiKey  'AIza...' 형식 (빈 문자열이면 제거)
   */
  async function updateTeacherGeminiKey(geminiKey) {
    if (!teacherUser?.uid) throw new Error('교사 로그인이 필요합니다.');
    const trimmed = (geminiKey || '').trim();
    // teachers/{uid} 문서가 없으면 생성 후 저장
    await upsertTeacherProfile(teacherUser.uid, { geminiApiKey: trimmed });
    await saveTeacherGeminiKey(teacherUser.uid, trimmed);
    // 로컬 상태 갱신
    setTeacherProfile((prev) => ({ ...(prev || {}), geminiApiKey: trimmed }));
  }

  // ─────────────────────────────────────────────
  // 학생 로그인 (익명 인증 → nameHash 조회 → PIN 검증 → anonUID 연결)
  // ─────────────────────────────────────────────

  /**
   * 학생 로그인 전체 흐름:
   * 1. 실명 + 학급코드 → nameHash 계산 (로컬만)
   * 2. Firebase 익명 인증 → anonUID (Firestore 조회 전에 request.auth 설정)
   * 3. Firebase에서 nameHash로 학생 문서 조회 → UUID + pinHash 획득
   * 4. 입력 PIN → pinHash 계산 후 서버 pinHash와 비교 (클라이언트에서 검증)
   * 5. anonUID를 학생 문서에 반영
   * 6. localStorage에 { uuid, realName, classCode, anonUID } 저장
   *
   * ★ 실명은 Firebase로 전송되지 않습니다 ★
   */
  async function studentLogin(classCode, realName, pin) {
    const classCodeNorm = normalizeClassCode(classCode);
    if (!classCodeNorm) {
      throw new Error('학급 코드가 올바르지 않습니다. (U는 사용할 수 없습니다.)');
    }

    // 2. 익명 로그인 먼저 — Firestore 규칙 isSignedIn() 통과용
    const anonResult = await signInAnonymously(auth);
    const anonUID    = anonResult.user.uid;

    async function tryLoginWithClassCode(codeForHashing) {
      // 1) 실명 해시 (실명 자체는 서버로 안 감)
      const nameHash = await hashStudentName(realName, codeForHashing);

      // 2) Firebase에서 nameHash로 조회 (동명이인·중복 등록 대비)
      // 이관 시나리오 대응:
      // - 해시는 codeForHashing(구 코드)로 생성되어 남아 있어도,
      // - 학생 문서의 classCode는 classCodeNorm(신 코드)로 업데이트됐을 수 있음
      // 따라서 (신코드/구코드) 둘 다 허용해 후보를 가져온다.
      const candidates = await getStudentsByNameHashInClassCodes([classCodeNorm, codeForHashing], nameHash);
      if (!candidates.length) return { ok: false, reason: 'no_candidates' };

      // 3) PIN 검증 (클라이언트 측) — PIN이 맞는 문서만 후보
      const pinHash = await hashPIN(pin, codeForHashing);
      const pinMatches = candidates.filter((row) => row.pinHash === pinHash);
      if (!pinMatches.length) return { ok: false, reason: 'pin_mismatch' };

      return { ok: true, pinMatches };
    }

    // 3~4. 학생 조회 + PIN 검증
    // 복구 시도:
    // - 과거 소문자 classCode로 생성된 해시/문서
    // - 학급코드 이관(migrateClassCode)으로 classes/{new}.migratedFrom 가 남아 있지만,
    //   학생 nameHash/pinHash 는 이전 코드로 만들어진 경우(해시 salt 때문에 발생)
    const codeCandidates = [classCodeNorm];
    const lower = classCodeNorm.toLowerCase();
    if (lower && lower !== classCodeNorm) codeCandidates.push(lower);

    try {
      const cls = await getClass(classCodeNorm);
      const migratedFrom = String(cls?.migratedFrom || '').trim();
      if (migratedFrom && migratedFrom !== classCodeNorm) {
        codeCandidates.push(migratedFrom);
        const mfLower = migratedFrom.toLowerCase();
        if (mfLower && mfLower !== migratedFrom) codeCandidates.push(mfLower);
      }
    } catch {
      // class 문서 조회 실패는 로그인 자체를 막지 않음
    }

    let pinMatches = null;
    let anyPinMismatch = false;
    for (const cc of codeCandidates) {
      // eslint-disable-next-line no-await-in-loop
      const out = await tryLoginWithClassCode(cc);
      if (out.ok) {
        pinMatches = out.pinMatches;
        break;
      }
      if (out.reason === 'pin_mismatch') anyPinMismatch = true;
    }

    if (!pinMatches) {
      if (anyPinMismatch) {
        throw new Error('PIN 번호가 틀렸습니다. 다시 확인해 주세요.');
      }
      throw new Error('학생 정보를 찾을 수 없습니다. 선생님께 문의하세요.');
    }

    let studentDoc = null;
    if (pinMatches.length === 1) {
      studentDoc = pinMatches[0];
    } else {
      // 같은 이름·같은 PIN이 여러 명: 아직 연결 안 된 계정 우선
      const reclaimable = pinMatches.filter(
        (row) => !row.anonUID || row.anonUID === anonUID
      );
      if (reclaimable.length === 1) {
        studentDoc = reclaimable[0];
      } else if (reclaimable.length > 1) {
        throw new Error(
          '같은 이름의 학생이 여러 명 등록되어 있어 로그인할 수 없습니다. 선생님께 이름을 구분해 달라고 요청하세요. (예: 김민수2)'
        );
      } else {
        throw new Error(
          '이미 다른 기기에서 로그인된 같은 이름의 학생이 있습니다. 선생님께 문의하세요.'
        );
      }
    }

    const studentUuid = studentDoc.uuid || studentDoc.id;
    if (!studentUuid) {
      throw new Error('학생 계정 정보가 올바르지 않습니다. 선생님께 문의하세요.');
    }

    // 5. anonUID를 Firebase 학생 문서에 업데이트
    try {
      await updateStudentAnonUID(studentUuid, anonUID);
      await updateStudentDisplayName(studentUuid, realName);
    } catch (err) {
      if (err?.code === 'permission-denied') {
        throw new Error(
          '로그인 연결에 실패했습니다. 잠시 후 다시 시도하거나 선생님께 문의하세요.'
        );
      }
      throw err;
    }

    // 6. localStorage에 세션 저장 (실명은 이 기기에만)
    const session = {
      uuid:      studentUuid,
      realName,                   // 실명은 localStorage에만 캐시
      classCode: classCodeNorm,
      anonUID,
    };
    saveStudentSession(session);
    setStudentSession(session);
    setUserType('student');

    return session;
  }

  function studentLogout() {
    clearStudentSession();
    setStudentSession(null);
    setUserType(null);
    // 익명 Auth는 자동 만료
  }

  // ─────────────────────────────────────────────
  // localStorage가 삭제된 경우 데이터 복구
  // (학생이 classCode + 실명 + PIN으로 재로그인하면 기존 기록 연결)
  // ─────────────────────────────────────────────
  async function recoverStudentSession(classCode, realName, pin) {
    // studentLogin과 동일 로직 — PIN 재검증 후 localStorage 복원
    return studentLogin(classCode, realName, pin);
  }

  const value = {
    // 공통
    userType,
    loading,

    // 교사
    teacherUser,
    teacherProfile,
    teacherLogin,
    teacherSignup,
    teacherLogout,
    isAllowedTeacherDomain,
    loadTeacherProfile,
    updateTeacherGeminiKey,

    // 학생
    studentSession,
    studentLogin,
    studentLogout,
    recoverStudentSession,
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
}
