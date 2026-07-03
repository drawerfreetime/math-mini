import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { isEducationEmail, getEmailDomain } from '../config/educationDomains';
import TermsConsentCheckbox from './TermsConsentCheckbox';

export default function TeacherSignup() {
  const navigate = useNavigate();
  const { registerTeacher } = useAuth();

  const [form, setForm] = useState({
    name: '',
    schoolName: '',
    grade: '',
    classNum: '',
    email: '',
    password: '',
    passwordConfirm: '',
  });
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const [termsAgreed, setTermsAgreed] = useState(false);

  const emailOk    = form.email ? isEducationEmail(form.email) : null; // null=미입력, true=ok, false=no
  const emailDomain = getEmailDomain(form.email);

  function handleChange(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setError('');
  }

  function validate() {
    if (!form.name.trim())       return '이름을 입력해주세요.';
    if (!form.schoolName.trim()) return '학교명을 입력해주세요.';
    if (!form.grade)             return '학년을 선택해주세요.';
    if (!form.classNum)          return '반을 선택해주세요.';
    if (!form.email)             return '이메일을 입력해주세요.';
    if (!isEducationEmail(form.email))
      return '교육청 이메일(@sen.go.kr 등)만 가입할 수 있습니다.';
    if (form.password.length < 6)
      return '비밀번호는 6자리 이상이어야 합니다.';
    if (form.password !== form.passwordConfirm)
      return '비밀번호가 일치하지 않습니다.';
    if (!termsAgreed)
      return '이용약관에 동의해 주세요.';
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) { setError(validationError); return; }

    setLoading(true);
    setError('');

    try {
      await registerTeacher(form.email, form.password);

      // 인증 대기 화면으로 이동 (프로필 데이터 전달)
      navigate('/verify-email', {
        state: {
          teacherProfile: {
            name: form.name.trim(),
            schoolName: form.schoolName.trim(),
            grade: form.grade,
            classNum: form.classNum,
          },
        },
      });
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/email-already-in-use') {
        setError('이미 사용 중인 이메일입니다. 로그인을 시도해보세요.');
      } else if (err.code === 'auth/weak-password') {
        setError('비밀번호는 6자리 이상이어야 합니다.');
      } else {
        setError('가입 오류: ' + err.message);
      }
    }

    setLoading(false);
  }

  return (
    <div className="login-container">
      <div className="login-card" style={{ maxWidth: 520 }}>
        <div className="login-logo">
          <span className="logo-icon">✏️</span>
          <h1 className="login-title">교사 가입</h1>
          <p className="login-subtitle">교육청 이메일로 바로 가입할 수 있어요</p>
        </div>

        {error && (
          <div className="alert alert-error">
            <span>⚠️</span> {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          {/* 이름 */}
          <div className="form-group">
            <label className="form-label">이름</label>
            <input
              type="text"
              className="form-input"
              placeholder="예: 김민준"
              value={form.name}
              onChange={(e) => handleChange('name', e.target.value)}
              required
            />
          </div>

          {/* 학교명 */}
          <div className="form-group">
            <label className="form-label">학교명</label>
            <input
              type="text"
              className="form-input"
              placeholder="예: 서울초등학교"
              value={form.schoolName}
              onChange={(e) => handleChange('schoolName', e.target.value)}
              required
            />
          </div>

          {/* 학년 / 반 */}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">담당 학년</label>
              <select
                className="form-input"
                value={form.grade}
                onChange={(e) => handleChange('grade', e.target.value)}
                required
              >
                <option value="">선택</option>
                {[1, 2, 3, 4, 5, 6].map((g) => (
                  <option key={g} value={String(g)}>{g}학년</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">담당 반</label>
              <select
                className="form-input"
                value={form.classNum}
                onChange={(e) => handleChange('classNum', e.target.value)}
                required
              >
                <option value="">선택</option>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => (
                  <option key={c} value={String(c)}>{c}반</option>
                ))}
              </select>
            </div>
          </div>

          {/* 교육청 이메일 */}
          <div className="form-group">
            <label className="form-label">
              교육청 이메일
              {form.email && (
                <span className={`form-hint ${emailOk ? 'hint-ok' : 'hint-err'}`}>
                  {emailOk ? ` ✅ ${emailDomain} 인증 가능` : ' ❌ 교육청 이메일만 가입 가능합니다'}
                </span>
              )}
            </label>
            <input
              type="email"
              className={`form-input ${form.email ? (emailOk ? 'input-correct' : 'input-wrong') : ''}`}
              placeholder="예: teacher@sen.go.kr"
              value={form.email}
              onChange={(e) => handleChange('email', e.target.value)}
              required
            />
            {!form.email && (
              <p className="field-hint">sen.go.kr, goe.go.kr 등 교육청 이메일만 가입할 수 있습니다.</p>
            )}
          </div>

          {/* 비밀번호 */}
          <div className="form-group">
            <label className="form-label">
              비밀번호 <span className="form-hint">(6자리 이상)</span>
            </label>
            <input
              type="password"
              className="form-input"
              placeholder="비밀번호 입력"
              value={form.password}
              onChange={(e) => handleChange('password', e.target.value)}
              required
              minLength={6}
            />
          </div>

          <div className="form-group">
            <label className="form-label">비밀번호 확인</label>
            <input
              type="password"
              className={`form-input ${form.passwordConfirm && form.password !== form.passwordConfirm ? 'input-wrong' : form.passwordConfirm ? 'input-correct' : ''}`}
              placeholder="비밀번호 재입력"
              value={form.passwordConfirm}
              onChange={(e) => handleChange('passwordConfirm', e.target.value)}
              required
            />
          </div>

          <TermsConsentCheckbox
            checked={termsAgreed}
            onChange={(next) => {
              setTermsAgreed(next);
              if (next) setError('');
            }}
          />

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={loading || emailOk === false || !termsAgreed}
          >
            {loading ? (
              <><span className="spinner"></span> 가입 처리 중...</>
            ) : (
              '가입 후 인증 이메일 받기'
            )}
          </button>
        </form>

        <div className="login-divider"><span>이미 계정이 있으신가요?</span></div>
        <Link to="/login" className="btn btn-outline btn-full">로그인으로 돌아가기</Link>
      </div>
    </div>
  );
}
