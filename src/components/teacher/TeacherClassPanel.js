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
    </div>
  );
}
