import React, { useEffect, useRef, useState } from 'react';
import { parseCropDataUrl, requestPreciseReview } from '../api/precisionReview';

/**
 * OCR 개선 지시 — 문항 크롭 + 교사 지시 → 백엔드 Gemini 재OCR
 */
export default function PrecisionReviewChat({
  open,
  onClose,
  cropPreviewUrl,
  problemNumber,
  currentCore,
  onApply,
}) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setMessages([]);
    setDraft('');
    setError('');
    setBusy(false);
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open, problemNumber]);

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [open, messages, busy]);

  if (!open) return null;

  const send = async () => {
    const instruction = draft.trim();
    if (!instruction && messages.length === 0) {
      setError('수정 지시를 입력해 주세요.');
      return;
    }
    const parsed = parseCropDataUrl(cropPreviewUrl);
    if (!parsed?.base64) {
      setError('문항 이미지를 불러올 수 없습니다.');
      return;
    }

    setBusy(true);
    setError('');
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const data = await requestPreciseReview({
        base64: parsed.base64,
        mediaType: parsed.mediaType,
        problemNumber,
        currentCore,
        instruction: instruction || undefined,
        messages,
        signal: ac.signal,
      });

      const reply = String(data.reply || '재검토했습니다.').trim();
      const nextMessages = Array.isArray(data.messages)
        ? data.messages
        : [
            ...(instruction ? [{ role: 'user', content: instruction }] : []),
            { role: 'model', content: reply },
          ];
      setMessages(nextMessages);
      setDraft('');

      if (onApply) {
        onApply(data);
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      setError(String(e.message || e));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const handleClose = () => {
    abortRef.current?.abort();
    onClose();
  };

  const quickHints = [
    '세로셈을 표로 분류하지 말 것',
    '(답: ) 안에는 [] 없이 공백 10칸만',
    '가로식 176×76=[          ] 는 세로 MULTVERT 중복 금지',
    '서술형 지문만 있으면 기타, 표 아님',
    '이미지와 초안을 비교해 틀린 부분만 고쳐줘',
  ];

  return (
    <div
      className="exam-ocr-precision-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="precision-review-title"
    >
      <div
        className="ocr-processing-card"
        style={{
          maxWidth: 720,
          width: '100%',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
          }}
        >
          <div style={{ flex: 1 }}>
            <h2 id="precision-review-title" style={{ fontSize: '1.05rem', margin: 0 }}>
              OCR 개선 지시
              {problemNumber != null ? ` · ${problemNumber}번` : ''}
            </h2>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: '#64748b', lineHeight: 1.5 }}>
              문항 이미지와 현재 OCR 결과를 보고 지시를 내면 AI가 다시 인식합니다.
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleClose}>
            닫기
          </button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {cropPreviewUrl ? (
            <div
              style={{
                width: 180,
                flexShrink: 0,
                padding: 10,
                borderRight: '1px solid #e2e8f0',
                background: '#f8fafc',
              }}
            >
              <img
                src={cropPreviewUrl}
                alt="문항"
                style={{ width: '100%', borderRadius: 6, border: '1px solid #e2e8f0' }}
              />
            </div>
          ) : null}

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div
              ref={scrollRef}
              style={{
                flex: 1,
                overflow: 'auto',
                padding: '12px 14px',
                background: '#fafafa',
              }}
            >
              {messages.length === 0 && !busy ? (
                <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>
                  예: 「세로셈인데 표로 나왔어요」, 「(답: ) 칸 형식이 틀렸어요」
                </p>
              ) : null}
              {messages.map((m, i) => {
                const isUser = m.role === 'user';
                return (
                  <div
                    key={`${m.role}-${i}`}
                    style={{
                      marginBottom: 10,
                      display: 'flex',
                      justifyContent: isUser ? 'flex-end' : 'flex-start',
                    }}
                  >
                    <div
                      style={{
                        maxWidth: '88%',
                        padding: '8px 12px',
                        borderRadius: 10,
                        fontSize: 13,
                        lineHeight: 1.5,
                        whiteSpace: 'pre-wrap',
                        background: isUser ? '#4f46e5' : '#fff',
                        color: isUser ? '#fff' : '#334155',
                        border: isUser ? 'none' : '1px solid #e2e8f0',
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                );
              })}
              {busy ? (
                <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>OCR 재실행 중…</p>
              ) : null}
            </div>

            <div style={{ padding: '10px 14px', borderTop: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {quickHints.map((h) => (
                  <button
                    key={h}
                    type="button"
                    className="btn btn-ghost btn-xs"
                    disabled={busy}
                    onClick={() => setDraft(h)}
                  >
                    {h}
                  </button>
                ))}
              </div>
              <textarea
                ref={inputRef}
                className="form-input"
                rows={3}
                placeholder="무엇을 고칠지 적어 주세요"
                value={draft}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                style={{ width: '100%', fontSize: 14, lineHeight: 1.5 }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || (!draft.trim() && messages.length === 0)}
                  onClick={send}
                >
                  {busy ? '처리 중…' : 'OCR 다시 실행'}
                </button>
                {error ? (
                  <span style={{ fontSize: 12, color: '#b45309' }}>{error}</span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
