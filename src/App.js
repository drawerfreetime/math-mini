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
import StudentLogin      from './components/StudentLogin';
import TeacherDashboard  from './components/TeacherDashboard';
import StudentDashboard  from './components/StudentDashboard';
import StudentExamWrongNotes from './components/StudentExamWrongNotes';
import ExamViewerRoute   from './components/ExamViewerRoute';
import PDFExtractor      from './components/PDFExtractor';
import UnitTestReview      from './components/UnitTestReview';
import PDFRegionSelector   from './components/PDFRegionSelector';
import ProblemMaker        from './components/ProblemMaker';
import ProblemModifier     from './components/ProblemModifier';
import ProblemCreator      from './components/ProblemCreator';
import StudentProblemBank  from './components/StudentProblemBank';
import ClassProblemBank    from './components/ClassProblemBank';
import ClassProblemSolve   from './components/ClassProblemSolve';
import MathMiniGamesHub    from './components/MathMiniGamesHub';
import MathSpeedQuiz       from './components/MathSpeedQuiz';
import MathWhackAMole      from './components/MathWhackAMole';
import MathMakeTen         from './components/MathMakeTen';
import TeacherExamBank      from './components/TeacherExamBank';
import ExamPdfStudentLabels from './components/ExamPdfStudentLabels';
import ExamPaperUploadHub from './components/ExamPaperUploadHub';
import ScanOrganize from './components/ScanOrganize';
import ScanOrganizeLayout from './components/ScanOrganizeLayout';
import Footer from './components/Footer';
import PrivacyPolicyPage from './components/PrivacyPolicyPage';
import TermsOfServicePage from './components/TermsOfServicePage';
import { getMissingFirebaseEnvKeys } from './firebase/env';

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
// 학생 보호 라우트 (PIN 로그인 필요)
// ─────────────────────────────────────────────
function StudentRoute({ children }) {
  const { userType } = useAuth();
  if (userType !== 'student') return <Navigate to="/" replace />;
  return children;
}

// ─────────────────────────────────────────────
// 교사 보호 라우트 (Firebase Auth 필요)
// ─────────────────────────────────────────────
function TeacherRoute({ children }) {
  const { userType } = useAuth();
  if (userType !== 'teacher') return <Navigate to="/teacher-login" replace />;
  return children;
}

// ─────────────────────────────────────────────
// 이미 로그인된 경우 리다이렉트
// ─────────────────────────────────────────────
function RedirectIfLoggedIn({ children, redirectTo }) {
  const { userType } = useAuth();
  if (userType === 'student') return <Navigate to="/student" replace />;
  if (userType === 'teacher') return <Navigate to="/teacher" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      {/* 학생 로그인 (기본 진입점) */}
      <Route
        path="/"
        element={
          <RedirectIfLoggedIn>
            <StudentLogin />
          </RedirectIfLoggedIn>
        }
      />

      {/* 학생 대시보드 */}
      <Route
        path="/student"
        element={
          <StudentRoute>
            <StudentDashboard />
          </StudentRoute>
        }
      />

      {/* 단원평가 오답노트 · 채점 결과 (학생) */}
      <Route
        path="/student/exam-wrong-notes"
        element={
          <StudentRoute>
            <StudentExamWrongNotes />
          </StudentRoute>
        }
      />

      {/* 수학 미니게임 (학생) */}
      <Route
        path="/student/games"
        element={
          <StudentRoute>
            <MathMiniGamesHub />
          </StudentRoute>
        }
      />
      <Route
        path="/student/games/speed-quiz"
        element={
          <StudentRoute>
            <MathSpeedQuiz />
          </StudentRoute>
        }
      />
      <Route
        path="/student/games/whack"
        element={
          <StudentRoute>
            <MathWhackAMole />
          </StudentRoute>
        }
      />
      <Route
        path="/student/games/make-ten"
        element={
          <StudentRoute>
            <MathMakeTen />
          </StudentRoute>
        }
      />

      {/* 교사 대시보드 */}
      <Route
        path="/teacher"
        element={
          <TeacherRoute>
            <TeacherDashboard />
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

      {/* 시험지 OCR 도구 (교사 전용) */}
      <Route
        path="/pdf-extractor"
        element={
          <TeacherRoute>
            <PDFExtractor />
          </TeacherRoute>
        }
      />

      {/* 교사 문제 보관함 (Firebase exams — 본인이 생성한 것만) */}
      <Route
        path="/exam-bank"
        element={
          <TeacherRoute>
            <TeacherExamBank />
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

      {/* 단원평가 검수 (교사 전용) */}
      <Route
        path="/unit-test-review"
        element={
          <TeacherRoute>
            <UnitTestReview />
          </TeacherRoute>
        }
      />

      {/* 문제 만들기 허브 (학생 전용) */}
      <Route
        path="/problem-maker"
        element={
          <StudentRoute>
            <ProblemMaker />
          </StudentRoute>
        }
      />

      {/* 기존 문제 변형하기 (학생 전용) */}
      <Route
        path="/problem-modify"
        element={
          <StudentRoute>
            <ProblemModifier />
          </StudentRoute>
        }
      />

      <Route
        path="/problem-create"
        element={
          <StudentRoute>
            <ProblemCreator />
          </StudentRoute>
        }
      />

      {/* 학생 문제 저장소 */}
      <Route
        path="/problem-bank"
        element={
          <StudentRoute>
            <StudentProblemBank />
          </StudentRoute>
        }
      />

      {/* 학급 문제은행 — 풀이·동료 평가 */}
      <Route
        path="/class-problems"
        element={
          <StudentRoute>
            <ClassProblemBank />
          </StudentRoute>
        }
      />
      <Route
        path="/class-problems/:problemId"
        element={
          <StudentRoute>
            <ClassProblemSolve />
          </StudentRoute>
        }
      />

      {/* 시험지 뷰어 */}
      <Route
        path="/exam/:examId"
        element={<ExamViewerRoute />}
      />

      <Route path="/privacy" element={<PrivacyPolicyPage />} />
      <Route path="/terms" element={<TermsOfServicePage />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <FirebaseEnvGuard>
      <Router basename={process.env.PUBLIC_URL}>
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
