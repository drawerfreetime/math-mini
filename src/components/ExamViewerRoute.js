import React from 'react';
import { useParams, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import ExamViewer from './ExamViewer';
import TeacherStrategyRecommend from './TeacherStrategyRecommend';

/** 시험지 뷰어 — 교사 전략 AI추천 모드는 별도 화면 */
export default function ExamViewerRoute() {
  const { examId } = useParams();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { userType } = useAuth();

  const backPath = location.state?.backTo ?? (userType === 'teacher' ? '/teacher' : '/student');
  const teacherStrategyMode = userType === 'teacher' && searchParams.get('teacherAiGuide') === '1';

  if (teacherStrategyMode) {
    return <TeacherStrategyRecommend examId={examId} backPath={backPath} />;
  }

  return <ExamViewer />;
}
