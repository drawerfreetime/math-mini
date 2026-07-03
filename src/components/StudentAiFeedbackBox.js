import React from 'react';
import { listVisibleAiCheckRows } from '../utils/teacherAiFeedback';
import {
  getStudentVisibleAiNote,
  getStudentVisibleTeacherComment,
  hasStudentVisibleAiFeedback,
  isStudentAiReviewPending,
  isTeacherReviewResolved,
  getItemReviewStatus,
  sanitizeAiHintsForStudent,
  studentAiFeedbackBoxClass,
} from '../utils/studentAiFeedback';

export default function StudentAiFeedbackBox({ item, className = '', hints = [] }) {
  if (!hasStudentVisibleAiFeedback(item)) return null;

  const teacherComment = getStudentVisibleTeacherComment(item);
  const note = getStudentVisibleAiNote(item);
  const isPending = isStudentAiReviewPending(item);
  const checks = listVisibleAiCheckRows(item.aiChecks, item);
  const safeHints = sanitizeAiHintsForStudent(hints);
  const teacherResolved = isTeacherReviewResolved(getItemReviewStatus(item));
  const feedbackLabel = teacherResolved && teacherComment
    ? '📋 검토 결과'
    : '🤖 AI 피드백';

  return (
    <div className={`stu-ai-feedback ${studentAiFeedbackBoxClass(item)}${className ? ` ${className}` : ''}`}>
      {(checks.length > 0 || note || isPending || safeHints.length > 0) && (
        <>
          <span className="stu-ai-feedback__label">{feedbackLabel}</span>
          {checks.length > 0 && (
            <ul className="stu-ai-feedback__checks">
              {checks.map((row) => (
                <li
                  key={row.key}
                  className={`stu-ai-feedback__check${row.ok ? ' stu-ai-feedback__check--ok' : ' stu-ai-feedback__check--fail'}`}
                >
                  <span className="stu-ai-feedback__check-label">{row.label}</span>
                  <span className="stu-ai-feedback__mark" aria-hidden="true">{row.ok ? '○' : '✗'}</span>
                </li>
              ))}
            </ul>
          )}
          {note ? (
            <p className="stu-ai-feedback__text">{note}</p>
          ) : isPending ? (
            <p className="stu-ai-feedback__text stu-ai-feedback__text--muted">AI 검수 결과를 기다리는 중이에요.</p>
          ) : null}
          {safeHints.length > 0 && (
            <ul className="stu-ai-feedback__hints">
              {safeHints.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          )}
        </>
      )}
      {teacherComment && (
        <div className="stu-ai-feedback__teacher">
          <span className="stu-ai-feedback__teacher-label">👩‍🏫 선생님 코멘트</span>
          <p className="stu-ai-feedback__teacher-text">{teacherComment}</p>
        </div>
      )}
    </div>
  );
}
