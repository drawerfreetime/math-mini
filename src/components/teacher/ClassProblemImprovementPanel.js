import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildClassProblemBankDevReport } from '../../utils/buildClassProblemBankDevReport';
import {
  appendImprovementMessage,
  clearImprovementThread,
  getImprovementThread,
} from '../../utils/classProblemImprovementThreads';
import TeacherAiFeedbackBox from './TeacherAiFeedbackBox';
import { hasVisibleAiFeedback } from '../../utils/teacherAiFeedback';

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('ko-KR', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function ClassProblemImprovementPanel({
  classCode,
  problem,
  aiItem,
  evaluations,
  mergedStudents,
  evaluationsByProblem,
}) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [copyMsg, setCopyMsg] = useState('');
  const scrollRef = useRef(null);

  const problemId = problem?.id || null;

  useEffect(() => {
    if (!problemId) {
      setMessages([]);
      return;
    }
    setMessages(getImprovementThread(classCode, problemId));
  }, [classCode, problemId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, problemId]);

  const problemEvalRows = useMemo(() => {
    if (!problemId) return [];
    return evaluationsByProblem?.get(problemId) || [];
  }, [problemId, evaluationsByProblem]);

  const buildCursorPayload = useCallback((taskNote) => {
    return buildClassProblemBankDevReport({
      classCode,
      problems: problem ? [problem] : [],
      aiItemsByProblemId: problemId && aiItem ? new Map([[problemId, aiItem]]) : null,
      evaluations: problemEvalRows.length ? problemEvalRows : evaluations,
      mergedStudents,
      selectedProblemId: problemId,
      taskNote,
      scope: 'selected',
    });
  }, [classCode, problem, problemId, aiItem, problemEvalRows, evaluations, mergedStudents]);

  const addNote = useCallback(() => {
    const text = draft.trim();
    if (!text || !problemId) return;
    const next = appendImprovementMessage(classCode, problemId, text, 'user');
    setMessages(next);
    setDraft('');
  }, [classCode, problemId, draft]);

  const copyForCursor = useCallback(async () => {
    if (!problemId) return;
    const pending = draft.trim();
    let thread = messages;
    if (pending) {
      thread = appendImprovementMessage(classCode, problemId, pending, 'user');
      setMessages(thread);
      setDraft('');
    }

    const recentNotes = thread
      .filter((m) => m.role === 'user')
      .slice(-5)
      .map((m) => m.content)
      .join('\n\n');

    const report = buildCursorPayload(recentNotes);
    const historyBlock = thread.length > 0
      ? [
          '',
          '## 이 문제의 작업 기록',
          ...thread.map((m) => {
            const who = m.role === 'user' ? '교사' : '시스템';
            return `- **${who}** (${formatTime(m.createdAt)}): ${m.content}`;
          }),
        ].join('\n')
      : '';

    const payload = `${report}${historyBlock}`;

    try {
      await navigator.clipboard.writeText(payload);
      const next = appendImprovementMessage(
        classCode,
        problemId,
        '통계·기록을 클립보드에 복사했습니다. Cursor 채팅에 붙여넣으세요.',
        'system',
      );
      setMessages(next);
      setCopyMsg('Cursor용 내용을 복사했습니다.');
    } catch {
      setCopyMsg('클립보드 복사에 실패했습니다.');
    }
    setTimeout(() => setCopyMsg(''), 3000);
  }, [buildCursorPayload, classCode, draft, messages, problemId]);

  const handleClear = useCallback(() => {
    if (!problemId) return;
    if (!window.confirm('이 문제의 코드 개선 기록을 모두 지울까요?')) return;
    clearImprovementThread(classCode, problemId);
    setMessages([]);
    setDraft('');
  }, [classCode, problemId]);

  return (
    <aside className="tcpb-improve-panel" aria-label="AI 피드백 · 개선 기록">
      <div className="tcpb-improve-panel__head">
        <div>
          <h3 className="tcpb-improve-panel__title">AI 피드백 · 개선 기록</h3>
          <p className="tcpb-improve-panel__desc">
            검수함과 같은 AI 피드백을 보며 메모를 남기고, Cursor 채팅에 붙여넣을 내용을 복사합니다.
          </p>
        </div>
      </div>

      {!problem ? (
        <p className="tcpb-empty-hint tcpb-improve-panel__empty">
          왼쪽에서 문제를 선택하면 이 문제의 작업 기록을 남길 수 있습니다.
        </p>
      ) : (
        <>
          <div className="tcpb-improve-panel__context">
            <span className="tcpb-improve-panel__context-label">선택 문제</span>
            <strong>{problem.label}</strong>
            {problem.unitGoal && (
              <span className="tcpb-improve-panel__context-unit">{problem.unitGoal}</span>
            )}
          </div>

          {hasVisibleAiFeedback(aiItem) && (
            <div className="tcpb-improve-panel__ai">
              <TeacherAiFeedbackBox item={aiItem} />
            </div>
          )}

          <div ref={scrollRef} className="tcpb-improve-panel__thread">
            {messages.length === 0 ? (
              <p className="tcpb-improve-panel__hint">
                예: 「정답률 0%인데 풀이 5건 — compareStudentAnswers 확인」
              </p>
            ) : (
              messages.map((m) => {
                const isUser = m.role === 'user';
                return (
                  <div
                    key={m.id}
                    className={`tcpb-improve-msg${isUser ? ' tcpb-improve-msg--user' : ' tcpb-improve-msg--system'}`}
                  >
                    <div className="tcpb-improve-msg__bubble">{m.content}</div>
                    <time className="tcpb-improve-msg__time">{formatTime(m.createdAt)}</time>
                  </div>
                );
              })
            )}
          </div>

          <div className="tcpb-improve-panel__composer">
            <textarea
              className="tcpb-improve-panel__input"
              rows={3}
              placeholder="AI 피드백을 참고해 수정·관찰 내용을 적어 주세요"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  addNote();
                }
              }}
            />
            <div className="tcpb-improve-panel__actions">
              <button type="button" className="btn btn-outline btn-sm" onClick={addNote} disabled={!draft.trim()}>
                메모 추가
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={copyForCursor}>
                Cursor용 복사
              </button>
              {messages.length > 0 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={handleClear}>
                  기록 지우기
                </button>
              )}
            </div>
            {copyMsg && <p className="tcpb-improve-panel__copy-msg">{copyMsg}</p>}
          </div>
        </>
      )}
    </aside>
  );
}
