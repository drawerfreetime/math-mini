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

  const [classCode, setClassCode] = useState('');
  const [realName,  setRealName]  = useState('');
  const [pin,       setPin]       = useState('');
  const [error,     setError]     = useState('');
  const [loading,   setLoading]   = useState(false);

  function handlePinChange(e) {
    setPin(e.target.value.replace(/\D/g, '').slice(0, 4));
  }

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

        <div className="form-group">
          <label className="form-label">학급 코드</label>
          <input
            type="text" className="form-input"
            placeholder="예: ABC123"
            value={classCode}
            onChange={(e) => setClassCode(e.target.value.toUpperCase().slice(0, 8))}
            required autoComplete="off"
            style={{ textTransform: 'uppercase', letterSpacing: 4, fontWeight: 700, textAlign: 'center' }}
          />
        </div>

        <div className="form-group">
          <label className="form-label">이름</label>
          <input
            type="text" className="form-input"
            placeholder="예: 홍길동"
            value={realName}
            onChange={(e) => setRealName(e.target.value)}
            required maxLength={20}
          />
        </div>

        <div className="form-group">
          <label className="form-label">PIN 번호 <span className="form-hint">(4자리 숫자)</span></label>
          <input
            type="password" inputMode="numeric" className="form-input"
            placeholder="••••"
            value={pin}
            onChange={handlePinChange}
            required minLength={4} maxLength={4}
            style={{ letterSpacing: 8, fontSize: 24, textAlign: 'center' }}
          />
        </div>

        <button type="submit" className="btn btn-primary btn-large" style={{ width: '100%' }}
          disabled={loading || !classCode.trim() || !realName.trim() || pin.length !== 4}>
          {loading ? <><span className="spinner" /> 로그인 중...</> : '🚀 시작하기'}
        </button>
      </form>

      <p style={{ marginTop: 16, fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
        🔒 이름은 이 기기에만 저장됩니다. 서버에는 암호화된 값만 전달됩니다.
      </p>
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
  const [email,      setEmail]      = useState('');
  const [password,   setPassword]   = useState('');
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
