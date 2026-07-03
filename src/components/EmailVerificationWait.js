import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function EmailVerificationWait() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { confirmEmailVerification, resendVerificationEmail, logout, currentUser } = useAuth();

  // TeacherSignup 또는 Login에서 넘어온 상태
  const teacherProfile = location.state?.teacherProfile || null;

  const [checking, setChecking]   = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError]         = useState('');
  const [resendDone, setResendDone] = useState(false);

  // "인증 완료 확인" 버튼
  async function handleConfirm() {
    setChecking(true);
    setError('');

    try {
      if (teacherProfile) {
        // 신규 가입 흐름: Firestore 저장 후 교사 대시보드로
        await confirmEmailVerification(teacherProfile);
        navigate('/teacher');
      } else {
        // 기존 계정 로그인 흐름: 단순 새로고침 후 재라우팅
        if (!currentUser) throw new Error('로그인 상태가 아닙니다.');
        await currentUser.reload();
        if (currentUser.emailVerified) {
          navigate('/teacher');
        } else {
          throw new Error('이메일 인증이 완료되지 않았습니다.');
        }
      }
    } catch (err) {
      setError(err.message);
    }

    setChecking(false);
  }

  // 인증 이메일 재발송
  async function handleResend() {
    setResending(true);
    setError('');
    try {
      await resendVerificationEmail();
      setResendDone(true);
      setTimeout(() => setResendDone(false), 5000);
    } catch (err) {
      setError('재발송 오류: ' + err.message);
    }
    setResending(false);
  }

  async function handleCancel() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="login-container">
      <div className="login-card" style={{ textAlign: 'center' }}>
        {/* 아이콘 */}
        <div className="verify-icon">📧</div>
        <h2 className="login-title">이메일 인증이 필요합니다</h2>

        <p className="verify-desc">
          가입하신 이메일 주소로 인증 링크를 보냈어요.
          <br />
          이메일함을 열어 <strong>인증 링크를 클릭</strong>한 후
          <br />
          아래 버튼을 눌러주세요.
        </p>

        {currentUser && (
          <div className="verify-email-box">
            ✉️ <strong>{currentUser.email}</strong>
          </div>
        )}

        {error && (
          <div className="alert alert-error" style={{ textAlign: 'left' }}>
            ⚠️ {error}
          </div>
        )}

        {resendDone && (
          <div className="alert alert-success" style={{ textAlign: 'left' }}>
            ✅ 인증 이메일을 재발송했습니다. 이메일함을 확인해주세요.
          </div>
        )}

        <div className="verify-actions">
          <button
            className="btn btn-primary btn-full"
            onClick={handleConfirm}
            disabled={checking}
          >
            {checking
              ? <><span className="spinner"></span> 인증 확인 중...</>
              : '✅ 인증 완료 확인'}
          </button>

          <button
            className="btn btn-outline btn-full"
            onClick={handleResend}
            disabled={resending}
          >
            {resending
              ? <><span className="spinner" style={{ borderTopColor: 'var(--gray-500)' }}></span> 발송 중...</>
              : '📨 인증 이메일 다시 받기'}
          </button>

          <button className="btn btn-ghost btn-full" onClick={handleCancel}>
            로그인 화면으로 돌아가기
          </button>
        </div>

        <p className="login-help">
          이메일이 오지 않으면 스팸함도 확인해주세요.
        </p>
      </div>
    </div>
  );
}
