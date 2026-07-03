import React from 'react';
import HudFrame from '../HudFrame';

export default function TeacherClassPanel({
  onShowExportModal,
  onShowImportModal,
  onShowPurgeModal,
  geminiKeyInput,
  geminiKeyRevealed,
  geminiKeySaving,
  teacherProfile,
  onGeminiKeyInputChange,
  onToggleGeminiKeyReveal,
  onSaveGeminiKey,
  onClearGeminiKey,
}) {
  return (
    <div>
      <HudFrame>
        <div className="section-header">
          <h2 className="section-title">🔐 데이터 관리</h2>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-outline" onClick={onShowExportModal}>
            ⬇️ 보내기 (AES-256)
          </button>
          <button type="button" className="btn btn-outline" onClick={onShowImportModal}>
            ⬆️ 가져오기 (복구)
          </button>
          <button type="button" className="btn btn-outline" style={{ color: '#dc2626', borderColor: '#dc2626' }} onClick={onShowPurgeModal}>
            🗑️ 학급 전체 삭제
          </button>
        </div>
      </HudFrame>

      <HudFrame style={{ marginTop: 16 }}>
        <div className="section-header">
          <h2 className="section-title">🔑 Gemini API 키</h2>
        </div>
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
          padding: '12px 16px', fontSize: 13, color: '#1d4ed8', marginBottom: 16 }}>
          AI 검수 시 내 Gemini 키를 우선 사용합니다. 키는 학급 학생 문제 검수에만 사용됩니다.
        </div>
        <form onSubmit={onSaveGeminiKey} style={{ maxWidth: 480 }}>
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label className="form-label">Gemini API 키 (AIza...)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type={geminiKeyRevealed ? 'text' : 'password'}
                className="form-input"
                value={geminiKeyInput}
                onChange={(e) => onGeminiKeyInputChange(e.target.value)}
                placeholder="AIzaSy..."
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 13 }}
              />
              <button type="button" className="btn btn-ghost btn-sm" onClick={onToggleGeminiKeyReveal}>
                {geminiKeyRevealed ? '🙈 숨기기' : '👁 보기'}
              </button>
            </div>
            {teacherProfile?.geminiApiKey && (
              <p style={{ fontSize: 12, color: '#16a34a', marginTop: 4 }}>
                ✅ 현재 저장된 키: {teacherProfile.geminiApiKey.slice(0, 8)}...
              </p>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={geminiKeySaving}>
              {geminiKeySaving ? <><span className="spinner" /> 저장 중...</> : '💾 저장'}
            </button>
            {teacherProfile?.geminiApiKey && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ color: '#dc2626' }} onClick={onClearGeminiKey}>
                삭제
              </button>
            )}
          </div>
        </form>
      </HudFrame>
    </div>
  );
}
