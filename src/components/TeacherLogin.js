/**
 * TeacherLogin.js — 교사 로그인 화면
 * 교직원 이메일 도메인(@korea.kr, 각 교육청 등) 인증
 */
import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import TermsConsentCheckbox from './TermsConsentCheckbox';

export default function TeacherLogin() {
  const { teacherLogin, teacherSignup, isAllowedTeacherDomain } = useAuth();
  const navigate = useNavigate();

  const [mode,     setMode]     = useState('login'); // 'login' | 'signup'
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const [signupDone, setSignupDone] = useState(false);
  const [termsAgreed, setTermsAgreed] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await teacherLogin(email, password);
      navigate('/teacher');
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleSignup(e) {
    e.preventDefault();
    if (!termsAgreed) {
      setError('이용약관에 동의해 주세요.');
      return;
    }
    setLoading(true); setError('');
    try {
      await teacherSignup(email, password);
      setSignupDone(true);
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') {
        setError('이미 등록된 이메일입니다. 로그인을 시도해 주세요.');
      } else if (err.code === 'auth/weak-password') {
        setError('비밀번호는 6자리 이상이어야 합니다.');
      } else {
        setError(err.message);
      }
    }
    setLoading(false);
  }

  if (signupDone) {
    return (
      <div className="login-container">
        <div className="login-card" style={{ maxWidth: 400, textAlign: 'center' }}>
          <div className="login-logo">📧</div>
          <h2 className="login-title">이메일 인증 필요</h2>
          <p style={{ color: '#6b7280', marginBottom: 20 }}>
            <strong>{email}</strong> 으로 인증 메일을 보냈습니다.
            메일함을 확인하고 인증 링크를 클릭해 주세요.
          </p>
          <button className="btn btn-primary" onClick={() => setMode('login')}>
            로그인 화면으로
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card" style={{ maxWidth: 400 }}>
        <div className="login-logo">🏫</div>
        <h1 className="login-title">
          {mode === 'login' ? '교사 로그인' : '교사 회원가입'}
        </h1>
        <p className="login-subtitle">
          교직원 이메일(@korea.kr, @sen.go.kr 등)만 가능합니다
        </p>

        <form onSubmit={mode === 'login' ? handleLogin : handleSignup} className="login-form">
          {error && (
            <div className="alert alert-error" style={{ marginBottom: 16 }}>⚠️ {error}</div>
          )}

          <div className="form-group">
            <label className="form-label">교직원 이메일</label>
            <input
              type="email"
              className="form-input"
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
            <label className="form-label">비밀번호</label>
            <input
              type="password"
              className="form-input"
              placeholder="6자리 이상"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
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

          <button
            type="submit"
            className="btn btn-primary btn-large"
            style={{ width: '100%' }}
            disabled={loading || (mode === 'signup' && !termsAgreed)}
          >
            {loading
              ? <><span className="spinner" /> 처리 중...</>
              : mode === 'login' ? '로그인' : '가입하기'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          {mode === 'login' ? (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setMode('signup'); setError(''); setTermsAgreed(false); }}
            >
              계정이 없으신가요? 회원가입 →
            </button>
          ) : (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setMode('login'); setError(''); setTermsAgreed(false); }}
            >
              ← 로그인으로 돌아가기
            </button>
          )}
        </div>

        <div style={{ marginTop: 20, textAlign: 'center' }}>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 12, color: '#9ca3af' }}
            onClick={() => navigate('/')}
          >
            ← 학생 로그인으로
          </button>
        </div>

        {/* 허용 도메인 안내 */}
        <div style={{
          marginTop: 20, padding: '10px 14px', background: '#f8fafc',
          borderRadius: 10, fontSize: 11, color: '#64748b'
        }}>
          허용 도메인: @korea.kr · @sen.go.kr · @gen.go.kr · @gne.go.kr<br />
          @jbe.go.kr · @cbe.go.kr · @dge.go.kr · @busanedu.net
        </div>
      </div>
    </div>
  );
}
