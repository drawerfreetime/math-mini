/**
 * AuthContext.js — 교사 인증 컨텍스트(간소화)
 *
 * 이번 정리에서 "시험지 업로드 → PDF 영역 선택 → 학생별 인쇄 → 스캔본 자동정리" 흐름만 남기기 위해
 * 학생 로그인/익명 인증/PIN 세션 로직을 제거했습니다.
 */
import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  sendEmailVerification,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

let _firebaseConfigPromise = null;
function loadFirebaseConfig() {
  // Firebase 초기화는 env 누락 시 렌더 전에 터질 수 있으므로 lazy-load로 지연한다.
  if (!_firebaseConfigPromise) _firebaseConfigPromise = import('../firebase/config');
  return _firebaseConfigPromise;
}

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
const REVIEW_TEACHER_EMAIL = process.env.REACT_APP_REVIEW_TEACHER_EMAIL;
const REVIEW_TEACHER_PASSWORD = process.env.REACT_APP_REVIEW_TEACHER_PASSWORD;
// 학생 심사용 환경변수는 더 이상 사용하지 않음.

const AuthContext = createContext();

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  // 교사 세션
  const [teacherUser,    setTeacherUser]    = useState(null);
  const [teacherProfile, setTeacherProfile] = useState(null);

  const [loading, setLoading] = useState(true);
  const [userType, setUserType] = useState(null); // 'teacher' | 'student' | null

  const authRef = useRef(null);
  const dbRef = useRef(null);

  // ─── Firebase Auth 상태 복원 ───
  useEffect(() => {
    let unsubscribe = null;
    let cancelled = false;

    loadFirebaseConfig()
      .then(({ ensureFirebase, getFirebaseInitError }) => {
        if (cancelled) return;

        const { auth, db } = ensureFirebase();
        const initErr = getFirebaseInitError?.();
        if (initErr || !auth || !db) {
          console.error('Firebase 초기화 실패:', initErr);
          setLoading(false);
          return;
        }

        authRef.current = auth;
        dbRef.current = db;

        unsubscribe = onAuthStateChanged(auth, async (user) => {
          if (user && !user.isAnonymous) {
            // 교사 로그인 상태
            setTeacherUser(user);
            await loadTeacherProfile(user.uid);
            setUserType('teacher');
          } else {
            setTeacherUser(null);
            setTeacherProfile(null);
            setUserType(null);
          }
          setLoading(false);
        });
      })
      .catch((err) => {
        // env 누락/설정 오류 등으로 Firebase 초기화가 실패하면,
        // App의 FirebaseEnvGuard가 안내 화면을 렌더링할 수 있게 loading만 해제한다.
        console.error('Firebase 초기화 실패:', err);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  // ─────────────────────────────────────────────
  // 교사 로그인
  // ─────────────────────────────────────────────

  /**
   * 교직원 도메인 검증
   */
  function isAllowedTeacherDomain(email) {
    if (email === SUPERADMIN_EMAIL) return true;
    if (REVIEW_TEACHER_EMAIL && email === REVIEW_TEACHER_EMAIL) return true;
    const domain = email.split('@')[1]?.toLowerCase();
    return ALLOWED_TEACHER_DOMAINS.includes(domain);
  }

  async function teacherLogin(email, password) {
    if (!isAllowedTeacherDomain(email)) {
      throw new Error('교직원 이메일(@korea.kr 등) 주소만 로그인할 수 있습니다.');
    }
    const { ensureFirebase } = await loadFirebaseConfig();
    const { auth } = ensureFirebase();
    if (!auth) throw new Error('Firebase 설정이 올바르지 않습니다. (auth 초기화 실패)');
    const result = await signInWithEmailAndPassword(auth, email, password);
    setUserType('teacher');
    return result;
  }

  async function reviewTeacherLogin() {
    if (!REVIEW_TEACHER_EMAIL || !REVIEW_TEACHER_PASSWORD) {
      throw new Error('심사용 교사 계정 환경변수(REACT_APP_REVIEW_TEACHER_EMAIL/REACT_APP_REVIEW_TEACHER_PASSWORD)가 설정되지 않았습니다.');
    }
    const { ensureFirebase } = await loadFirebaseConfig();
    const { auth } = ensureFirebase();
    if (!auth) throw new Error('Firebase 설정이 올바르지 않습니다. (auth 초기화 실패)');
    const result = await signInWithEmailAndPassword(auth, REVIEW_TEACHER_EMAIL, REVIEW_TEACHER_PASSWORD);
    setUserType('teacher');
    return result;
  }

  async function teacherSignup(email, password) {
    if (!isAllowedTeacherDomain(email)) {
      throw new Error('교직원 이메일(@korea.kr 등) 주소만 가입할 수 있습니다.');
    }
    const { ensureFirebase } = await loadFirebaseConfig();
    const { auth } = ensureFirebase();
    if (!auth) throw new Error('Firebase 설정이 올바르지 않습니다. (auth 초기화 실패)');
    const result = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(result.user);
    return result.user;
  }

  async function teacherLogout() {
    const { ensureFirebase } = await loadFirebaseConfig();
    const { auth } = ensureFirebase();
    if (!auth) return;
    await signOut(auth);
    setTeacherUser(null);
    setTeacherProfile(null);
    setUserType(null);
  }

  async function loadTeacherProfile(uid) {
    try {
      const db = dbRef.current || (await loadFirebaseConfig()).ensureFirebase().db;
      if (!db) return;
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
    const { saveTeacherGeminiKey, upsertTeacherProfile } = await import('../firebase/firestoreOps');
    // teachers/{uid} 문서가 없으면 생성 후 저장
    await upsertTeacherProfile(teacherUser.uid, { geminiApiKey: trimmed });
    await saveTeacherGeminiKey(teacherUser.uid, trimmed);
    // 로컬 상태 갱신
    setTeacherProfile((prev) => ({ ...(prev || {}), geminiApiKey: trimmed }));
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
    reviewTeacherLogin,
    isAllowedTeacherDomain,
    loadTeacherProfile,
    updateTeacherGeminiKey,
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
}
