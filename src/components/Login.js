import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getDoc, doc } from 'firebase/firestore';
import { db } from '../firebase/config';

export default function Login() {
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);

  const { login, enterGuestMode } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await login(email, password, rememberMe);
      const user = result.user;

      // Firestore에서 사용자 역할 확인
      const snap = await getDoc(doc(db, 'users', user.uid));

      // Firestore 문서가 없는 경우 → 인증 미완료 교사
      if (!snap.exists()) {
        if (!user.emailVerified) {
          // 이메일 인증 대기 화면으로 이동 (teacherProfile 없이)
          navigate('/verify-email', { state: { emailOnly: true } });
        } else {
          setError('계정 정보를 찾을 수 없습니다. 다시 가입하거나 관리자에게 문의하세요.');
        }
        setLoading(false);
        return;
      }

      const profile = snap.data();

      // 교사인데 이메일 미인증 → 인증 대기 화면
      if (profile.role === 'teacher' && !user.emailVerified) {
        setError('');
        navigate('/verify-email', {
          state: {
            emailOnly: true,
            teacherProfile: {
              name: profile.name,
              schoolName: profile.schoolName,
              grade: profile.grade,
              classNum: profile.classNum,
            },
          },
        });
        setLoading(false);
        return;
      }

      // 역할별 라우팅
      if (profile.role === 'superadmin') navigate('/superadmin');
      else if (profile.role === 'teacher') navigate('/teacher');
      else if (profile.role === 'student') navigate('/student');
      else setError('알 수 없는 계정 유형입니다.');

    } catch (err) {
      console.error(err);
      if (
        err.code === 'auth/user-not-found' ||
        err.code === 'auth/wrong-password' ||
        err.code === 'auth/invalid-credential'
      ) {
        setError('이메일 또는 비밀번호가 올바르지 않습니다.');
      } else if (err.code === 'auth/too-many-requests') {
        setError('로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
      } else {
        setError('로그인 오류: ' + err.message);
      }
    }

    setLoading(false);
  }

  function handleGuest() {
    enterGuestMode();
    navigate('/guest');
  }

  return (
    <div className="login-container">
      <div className="login-card">
        {/* 로고 */}
        <div className="login-logo">
          <span className="logo-icon">🧮</span>
          <h1 className="login-title">수학 문제 만들기</h1>
          <p className="login-subtitle">초등학교 4학년 AI 수학 학습</p>
        </div>

        {/* 오류 메시지 */}
        {error && (
          <div className="alert alert-error">
            <span>⚠️</span> {error}
          </div>
        )}

        {/* 로그인 폼 */}
        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="email" className="form-label">이메일</label>
            <input
              id="email"
              type="email"
              className="form-input"
              placeholder="이메일을 입력하세요"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div className="form-group">
            <label htmlFor="password" className="form-label">비밀번호</label>
            <input
              id="password"
              type="password"
              className="form-input"
              placeholder="비밀번호를 입력하세요"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>

          <div className="form-checkbox">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="checkbox-input"
              />
              <span className="checkbox-custom"></span>
              <span className="checkbox-text">자동 로그인 (로그인 상태 유지)</span>
            </label>
          </div>

          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? <><span className="spinner"></span> 로그인 중...</> : '로그인'}
          </button>
        </form>

        {/* 구분선 */}
        <div className="login-divider">
          <span>또는</span>
        </div>

        {/* 교사 가입 / 게스트 */}
        <div className="login-actions">
          <Link to="/signup" className="btn btn-outline btn-full">
            ✏️ 교사 가입하기
          </Link>
          <button onClick={handleGuest} className="btn btn-ghost btn-full">
            👀 로그인 없이 체험하기
          </button>
        </div>

        <p className="login-help">
          학생 계정은 담임선생님께 문의하세요.
        </p>
      </div>
    </div>
  );
}
