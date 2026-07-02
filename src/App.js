/**
 * App.js — 라우팅 및 인증 가드
 *
 * ★ Privacy by Design 아키텍처 ★
 * - 교사: Firebase Email Auth (교직원 도메인 검증)
 * - 학생: PIN 기반 로그인 (실명은 로컬에만, 서버에는 UUID + 해시만)
 * - 어떠한 학생 실명도 서버로 전송되지 않습니다
 */
import React from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import TeacherLogin from './components/TeacherLogin';
import TeacherHomeLite from './components/TeacherHomeLite';
import PDFRegionSelector   from './components/PDFRegionSelector';
import ExamPdfStudentLabels from './components/ExamPdfStudentLabels';
import ExamPaperUploadHub from './components/ExamPaperUploadHub';
import ScanOrganize from './components/ScanOrganize';
import ScanOrganizeLayout from './components/ScanOrganizeLayout';
import Footer from './components/Footer';
import PrivacyPolicyPage from './components/PrivacyPolicyPage';
import TermsOfServicePage from './components/TermsOfServicePage';
import { getMissingFirebaseEnvKeys } from './firebase/env';
import { getFirebaseInitError, ensureFirebase } from './firebase/config';

function FirebaseEnvGuard({ children }) {
  const missing = getMissingFirebaseEnvKeys();
  if (!missing.length) return children;

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      background: 'linear-gradient(135deg, #0f172a, #111827)',
      color: '#e5e7eb',
    }}>
      <div style={{
        width: 'min(720px, 100%)',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 16,
        padding: 24,
        backdropFilter: 'blur(10px)',
      }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.2 }}>
          로그인 설정이 누락되어 있어요
        </h1>
        <p style={{ marginTop: 10, marginBottom: 16, color: 'rgba(229,231,235,0.85)', lineHeight: 1.5 }}>
          배포(Vercel) 환경에서 Firebase 환경변수가 비어 있으면 학생 로그인(익명 인증)과 교사 로그인 모두 동작하지 않습니다.
          아래 키들을 Vercel 프로젝트의 Environment Variables에 추가한 뒤 재배포해 주세요.
        </p>

        <div style={{
          background: 'rgba(0,0,0,0.35)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 12,
          padding: 14,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: 13,
          whiteSpace: 'pre-wrap',
        }}>
          {missing.map((k) => `- ${k}`).join('\n')}
        </div>

        <p style={{ marginTop: 14, color: 'rgba(229,231,235,0.75)', fontSize: 12, lineHeight: 1.5 }}>
          참고: CRA(react-scripts)는 클라이언트 빌드 시점에 <strong>REACT_APP_</strong> 접두사의 환경변수만 주입됩니다.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 교사 보호 라우트 (Firebase Auth 필요)
// ─────────────────────────────────────────────
function TeacherRoute({ children }) {
  const { userType } = useAuth();
  if (userType !== 'teacher') return <Navigate to="/teacher-login" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      {/* 기본 진입점: 교사 로그인 */}
      <Route
        path="/"
        element={
          <Navigate to="/teacher-login" replace />
        }
      />

      <Route path="/teacher-login" element={<TeacherLogin />} />

      {/* 교사 홈(최소) */}
      <Route
        path="/teacher"
        element={
          <TeacherRoute>
            <TeacherHomeLite />
          </TeacherRoute>
        }
      />

      {/* 시험지 로컬 업로드 라이브러리 (교사 전용, 서버 미저장) */}
      <Route
        path="/exam-papers"
        element={
          <TeacherRoute>
            <ExamPaperUploadHub />
          </TeacherRoute>
        }
      />

      {/* 시험지 PDF 학생 이름·번호 일괄 표기 (교사 전용) */}
      <Route
        path="/exam-pdf-labels"
        element={
          <TeacherRoute>
            <ExamPdfStudentLabels />
          </TeacherRoute>
        }
      />

      {/* 스캔본 자동 정리 (교사 전용) */}
      <Route
        path="/scan-organize"
        element={
          <TeacherRoute>
            <ScanOrganize />
          </TeacherRoute>
        }
      />
      <Route
        path="/scan-organize/layout"
        element={
          <TeacherRoute>
            <ScanOrganizeLayout />
          </TeacherRoute>
        }
      />

      {/* PDF 영역 수동 선택 (교사 전용) */}
      <Route
        path="/pdf-region"
        element={
          <TeacherRoute>
            <PDFRegionSelector />
          </TeacherRoute>
        }
      />

      <Route path="/privacy" element={<PrivacyPolicyPage />} />
      <Route path="/terms" element={<TermsOfServicePage />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  // Firebase 초기화 오류(예: invalid-api-key)가 있으면 렌더 전에 터지지 않도록
  // 여기서 한번 잡아 UI로 보여준다.
  ensureFirebase();
  const initErr = getFirebaseInitError();
  if (initErr) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'linear-gradient(135deg, #0f172a, #111827)',
        color: '#e5e7eb',
      }}>
        <div style={{
          width: 'min(720px, 100%)',
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 16,
          padding: 24,
          backdropFilter: 'blur(10px)',
        }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.2 }}>
            Firebase 설정이 올바르지 않아요
          </h1>
          <p style={{ marginTop: 10, marginBottom: 16, color: 'rgba(229,231,235,0.85)', lineHeight: 1.5 }}>
            현재 환경변수의 Firebase API Key가 잘못되어 인증 초기화가 실패했습니다.
            로컬에서는 <strong>.env</strong>에 실제 Firebase Web App 설정값을 넣어야 합니다.
          </p>
          <div style={{
            background: 'rgba(0,0,0,0.35)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 12,
            padding: 14,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
          }}>
            {String(initErr?.code || initErr?.message || initErr)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <FirebaseEnvGuard>
      <Router>
        <AuthProvider>
          <div className="app-shell">
            <main className="app-main" id="main-content">
              <AppRoutes />
            </main>
            <Footer />
          </div>
        </AuthProvider>
      </Router>
    </FirebaseEnvGuard>
  );
}
