/**
 * StudentLogin.js — 통합 시작 화면
 *
 * 학생 로그인 / 교사 로그인 / 교사 회원가입 세 가지 화면을 하나에서 관리합니다.
 */
import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import HomeBrandScreen from './HomeBrandScreen';
import TermsConsentCheckbox from './TermsConsentCheckbox';
import { normalizeClassCode } from '../utils/classCode';

// ─────────────────────────────────────────────
// 학생 로그인 폼 (학급코드 + 이름 + PIN)
// ─────────────────────────────────────────────
function StudentForm({ onBack }) {
  const { studentLogin } = useAuth();

  const [classCode] = useState(process.env.REACT_APP_REVIEW_STUDENT_CLASS_CODE || 'ABC123');
  const [realName]  = useState(process.env.REACT_APP_REVIEW_STUDENT_NAME || '홍길동');
  const [pin]       = useState(process.env.REACT_APP_REVIEW_STUDENT_PIN || '0000');
  const [error,     setError]     = useState('');
  const [loading,   setLoading]   = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    const codeNorm = normalizeClassCode(classCode);
    if (!codeNorm || !realName.trim() || pin.length !== 4) {
      if (classCode && !codeNorm) setError('학급 코드에 U는 사용할 수 없습니다.');
      return;
    }
    setLoading(true); setError('');
    try {
      await studentLogin(codeNorm, realName.trim(), pin);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={onBack}
        style={{ alignSelf: 'flex-start', marginBottom: 8 }}>
        ← 뒤로
      </button>
      <div className="login-logo">🧮</div>
      <h1 className="login-title">학생 로그인</h1>
      <p className="login-subtitle">선생님에게 받은 학급 코드와 이름, PIN을 입력해 주세요</p>

      <form onSubmit={handleSubmit} className="login-form">
        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>⚠️ {error}</div>}

        <p style={{ textAlign: 'center', marginBottom: 20, color: '#4b5563' }}>
          아래 버튼을 눌러 바로 시작하세요!
        </p>

        <button type="submit" className="btn btn-primary btn-large" style={{ width: '100%' }}
          disabled={loading}>
          {loading ? <><span className="spinner" /> 로그인 중...</> : '🚀 시작하기'}
        </button>
      </form>
    </>
  );
}

// ─────────────────────────────────────────────
// 교사 로그인 폼
// ─────────────────────────────────────────────
function TeacherForm({ onBack, initialMode = 'login' }) {
  const { teacherLogin, teacherSignup, isAllowedTeacherDomain } = useAuth();
  const navigate = useNavigate();

  const [mode,       setMode]       = useState(initialMode);
  const [email,      setEmail]      = useState(process.env.REACT_APP_REVIEW_TEACHER_EMAIL || 'teacher@korea.kr');
  const [password,   setPassword]   = useState(process.env.REACT_APP_REVIEW_TEACHER_PASSWORD || 'password123');
  const [error,      setError]      = useState('');
  const [loading,    setLoading]    = useState(false);
  const [signupDone, setSignupDone] = useState(false);
  const [termsAgreed, setTermsAgreed] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (mode === 'signup' && !termsAgreed) {
      setError('이용약관에 동의해 주세요.');
      return;
    }
    setLoading(true); setError('');
    try {
      if (mode === 'login') {
        await teacherLogin(email, password);
        navigate('/teacher');
      } else {
        await teacherSignup(email, password);
        setSignupDone(true);
      }
    } catch (err) {
      const msg = err.code === 'auth/email-already-in-use' ? '이미 등록된 이메일입니다.'
        : err.code === 'auth/weak-password' ? '비밀번호는 6자리 이상이어야 합니다.'
        : err.message;
      setError(msg);
    }
    setLoading(false);
  }

  if (signupDone) {
    return (
      <>
        <div className="login-logo">📧</div>
        <h2 className="login-title">이메일 인증 필요</h2>
        <p style={{ color: '#6b7280', marginBottom: 24, textAlign: 'center' }}>
          <strong>{email}</strong>으로 인증 메일을 보냈습니다.<br />
          메일함을 확인하고 인증 링크를 클릭해 주세요.
        </p>
        <button className="btn btn-primary" style={{ width: '100%' }}
          onClick={() => { setSignupDone(false); setMode('login'); }}>
          로그인 화면으로
        </button>
      </>
    );
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={onBack}
        style={{ alignSelf: 'flex-start', marginBottom: 8 }}>
        ← 뒤로
      </button>
      <div className="login-logo">🏫</div>
      <h1 className="login-title">{mode === 'login' ? '교사 로그인' : '교사 회원가입'}</h1>
      <p className="login-subtitle">교직원 이메일(@korea.kr, @sen.go.kr 등)만 가능합니다</p>

      <form onSubmit={handleSubmit} className="login-form">
        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>⚠️ {error}</div>}

        <div className="form-group">
          <label className="form-label">교직원 이메일</label>
          <input
            type="email" className="form-input"
            placeholder="teacher@korea.kr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {email && !isAllowedTeacherDomain(email) && (
            <p style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }}>
              ⚠️ 교직원 이메일만 사용 가능합니다.
            </p>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">비밀번호 <span className="form-hint">(6자리 이상)</span></label>
          <input
            type="password" className="form-input"
            placeholder="비밀번호 입력"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required minLength={6}
          />
        </div>

        {mode === 'signup' && (
          <TermsConsentCheckbox
            checked={termsAgreed}
            onChange={(next) => {
              setTermsAgreed(next);
              if (next) setError('');
            }}
          />
        )}

        <button type="submit" className="btn btn-primary btn-large" style={{ width: '100%' }}
          disabled={loading || (mode === 'signup' && !termsAgreed)}>
          {loading
            ? <><span className="spinner" /> 처리 중...</>
            : mode === 'login' ? '로그인' : '가입하기'}
        </button>
      </form>

      <div style={{ marginTop: 16, textAlign: 'center' }}>
        {mode === 'login' ? (
          <button className="btn btn-ghost btn-sm"
            onClick={() => { setMode('signup'); setError(''); setTermsAgreed(false); }}>
            계정이 없으신가요? 회원가입 →
          </button>
        ) : (
          <button className="btn btn-ghost btn-sm"
            onClick={() => { setMode('login'); setError(''); setTermsAgreed(false); }}>
            ← 로그인으로 돌아가기
          </button>
        )}
      </div>

      <div style={{
        marginTop: 20, padding: '10px 14px', background: '#f8fafc',
        borderRadius: 10, fontSize: 11, color: '#64748b', textAlign: 'center'
      }}>
        허용 도메인: @korea.kr · @sen.go.kr · @gen.go.kr<br />
        @gne.go.kr · @jbe.go.kr · @dge.go.kr · @busanedu.net
      </div>
    </>
  );
}


// ─────────────────────────────────────────────
// 통합 진입점
// ─────────────────────────────────────────────
export default function StudentLogin() {
  const [view, setView] = useState('home'); // 'home' | 'student' | 'teacher' | 'signup'
  const isHome = view === 'home';

  return (
    <div className={`login-container login-container--brand-bg${isHome ? ' login-container--home' : ''}`}>
      {isHome ? (
        <HomeBrandScreen onSelect={setView} />
      ) : (
        <div className="login-card" style={{
          maxWidth: 400,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
        }}>
          {view === 'student' && (
            <StudentForm onBack={() => setView('home')} />
          )}
          {(view === 'teacher' || view === 'signup') && (
            <TeacherForm onBack={() => setView('home')} initialMode={view === 'signup' ? 'signup' : 'login'} />
          )}
        </div>
      )}
    </div>
  );
}
