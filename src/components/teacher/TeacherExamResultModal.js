import React from 'react';
import TeacherStudentContentPanel from '../TeacherStudentContentPanel';

export default function TeacherExamResultModal({
  classCode,
  serverStudents,
  showToast,
  onStudentsRefresh,
  onClose,
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal td-exam-result-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>👁 채점 결과 공개</h3>
          <button type="button" className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body td-exam-result-modal__body">
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
            학생이 보는 채점 결과·시험지 목록의 노출 여부를 관리합니다.
          </p>
          <TeacherStudentContentPanel
            classCode={classCode}
            serverStudents={serverStudents}
            showToast={showToast}
            onStudentsRefresh={onStudentsRefresh}
          />
        </div>
      </div>
    </div>
  );
}
