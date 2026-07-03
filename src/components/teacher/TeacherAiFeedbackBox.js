import React, { useState } from 'react';
import {
  aiFeedbackBoxClass,
  deriveAiApprovedFromChecks,
  formatAiCompletionLabel,
  formatAiModeLabel,
  hasVisibleAiFeedback,
  isAiReviewPending,
  listVisibleAiCheckRows,
  listTeacherReviewCheckRows,
  resolveTeacherManualCheckKeys,
} from '../../utils/teacherAiFeedback';

export default function TeacherAiFeedbackBox({
  item,
  className = '',
  interactive = false,
  manualCheckKeys,
  checks: checksOverride,
  onToggleCheck,
  note: noteOverride,
  onNoteChange,
}) {
  const [editingNote, setEditingNote] = useState(false);

  if (!interactive && !hasVisibleAiFeedback(item)) return null;

  const isPending = isAiReviewPending(item?.aiReviewStatus, item);
  const checksSource = interactive ? checksOverride : item.aiChecks;
  const reviewManualKeys = manualCheckKeys || (interactive ? resolveTeacherManualCheckKeys(item) : null);
  const checkRowOpts = interactive && isPending ? { pending: true } : {};
  const checks = interactive
    ? listTeacherReviewCheckRows(checksSource, reviewManualKeys, checkRowOpts)
    : listVisibleAiCheckRows(checksSource, item);
  const note = interactive
    ? String(noteOverride ?? '').trim()
    : String(item.aiNote || '').trim();
  const modeLabel = formatAiModeLabel(item.aiMode);
  const completionLabel = formatAiCompletionLabel(item.aiCompletionLevel);
  const displayApproved = interactive
    ? deriveAiApprovedFromChecks(checksSource, item)
    : item.aiApproved;
  const feedbackBoxClass = aiFeedbackBoxClass(displayApproved, checksSource);

  const renderCheck = (row) => {
    const isRowPending = row.pending === true || row.ok == null;
    const checkClassName = `td-ai-feedback__check${
      isRowPending
        ? ' td-ai-feedback__check--pending'
        : row.ok
          ? ' td-ai-feedback__check--ok'
          : ' td-ai-feedback__check--fail'
    }`;
    const mark = isRowPending ? '…' : (row.ok ? '○' : '✗');
    if (!interactive) {
      return (
        <li key={row.key} className={checkClassName}>
          <span className="td-ai-feedback__check-label">{row.label}</span>
          <span className="td-ai-feedback__mark" aria-hidden="true">{mark}</span>
        </li>
      );
    }
    if (isRowPending) {
      return (
        <li key={row.key} className={checkClassName}>
          <span className="td-ai-feedback__check-label">{row.label}</span>
          <span className="td-ai-feedback__mark" aria-hidden="true">{mark}</span>
        </li>
      );
    }
    return (
      <li key={row.key}>
        <button
          type="button"
          className={`td-ai-feedback__check-btn${row.ok ? ' td-ai-feedback__check--ok' : ' td-ai-feedback__check--fail'}`}
          onClick={() => onToggleCheck?.(row.key)}
          title={`${row.label}: ${row.ok ? '통과' : '미통과'} — 클릭하여 ${row.ok ? '미통과' : '통과'}로 변경`}
          aria-pressed={row.ok}
        >
          <span className="td-ai-feedback__check-label">{row.label}</span>
          <span className="td-ai-feedback__mark" aria-hidden="true">{mark}</span>
        </button>
      </li>
    );
  };

  const renderNote = () => {
    if (!note && !isPending && !interactive) return null;

    if (interactive) {
      return (
        <div className="td-ai-feedback__note-box">
          <button
            type="button"
            className="td-ai-feedback__edit-btn"
            onClick={() => setEditingNote((v) => !v)}
            aria-label={editingNote ? '피드백 수정 완료' : '피드백 수정'}
            title={editingNote ? '수정 완료' : '피드백 수정'}
          >
            ✏️
          </button>
          {editingNote ? (
            <textarea
              className="td-ai-feedback__note-edit"
              value={noteOverride ?? ''}
              onChange={(e) => onNoteChange?.(e.target.value)}
              rows={4}
              placeholder="학생에게 전달할 피드백을 입력하세요."
            />
          ) : (
            <p className="td-ai-feedback__note-text">
              {note || (isPending ? 'AI 검수 결과를 기다리는 중입니다.' : '피드백을 입력하세요.')}
            </p>
          )}
        </div>
      );
    }

    if (note) {
      return <p className="td-ai-feedback__text">{note}</p>;
    }
    if (isPending) {
      return <p className="td-ai-feedback__text td-ai-feedback__text--muted">AI 검수 결과를 기다리는 중입니다.</p>;
    }
    return null;
  };

  return (
    <div className={`${feedbackBoxClass}${className ? ` ${className}` : ''}`}>
      <span className="td-ai-feedback__label">🤖 AI 피드백</span>
      {(isPending || modeLabel || completionLabel) && (
        <div className="td-ai-feedback__meta">
          {isPending && (
            <span className="td-ai-feedback__badge td-ai-feedback__badge--pending">AI 검수 중</span>
          )}
          {modeLabel && (
            <span className="td-ai-feedback__badge">{modeLabel}</span>
          )}
          {completionLabel && (
            <span className="td-ai-feedback__badge">완성도 {completionLabel}</span>
          )}
        </div>
      )}
      {(interactive || checks.length > 0) && (
        <ul className="td-ai-feedback__checks">
          {checks.map(renderCheck)}
        </ul>
      )}
      {renderNote()}
    </div>
  );
}
