/**
 * PDFExtractor.js — 시험지 OCR 진입점
 *
 * 교사가 미리 업로드한 시험지 목록에서 파일을 골라
 * 영역 수동 선택(PDFRegionSelector) 화면으로 이동합니다.
 *
 * ★ 개인정보 보호 ★
 * PDF 내 수학 수치·도형 정보만 처리하며, 학생 정보는 취급하지 않습니다.
 */
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { listExamPaperLibrary, getExamPaperFileFromLibrary } from '../utils/pdfStorage';

export default function PDFExtractor() {
  const navigate = useNavigate();

  const [libraryEntries, setLibraryEntries] = useState([]);
  const [libraryPickId, setLibraryPickId]   = useState('');
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState('');

  useEffect(() => {
    let cancelled = false;
    listExamPaperLibrary()
      .then((list) => {
        if (!cancelled) setLibraryEntries(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setLibraryEntries([]);
      });
    return () => { cancelled = true; };
  }, []);

  async function handleLibrarySelect(id) {
    setLibraryPickId(id);
    setError('');
    if (!id) return;

    setLoading(true);
    try {
      const file = await getExamPaperFileFromLibrary(id);
      if (!file) {
        setError('시험지 파일을 찾을 수 없습니다. 시험지 업로드에서 다시 등록해 주세요.');
        setLoading(false);
        return;
      }
      const ent = libraryEntries.find((x) => x.id === id);
      navigate('/pdf-region', {
        state: {
          pdfFile: file,
          entryMeta: ent ?? null,
        },
      });
    } catch (err) {
      setError(err.message || '시험지를 불러오지 못했습니다.');
      setLoading(false);
    }
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/teacher')}>
            ← 대시보드로
          </button>
          <span className="header-icon">📑</span>
          <div>
            <h1 className="header-title">시험지 OCR</h1>
            <p className="header-subtitle">등록된 시험지를 선택하면 문항 영역 선택 화면으로 이동합니다</p>
          </div>
        </div>
        <div className="header-right" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-sm" onClick={() => navigate('/exam-papers')}>
            📤 시험지 업로드
          </button>
        </div>
      </header>

      <main className="dashboard-main">
        <div style={{ maxWidth: 560, margin: '0 auto' }}>

          {/* 안내 카드 */}
          <div style={{
            background: '#f5f3ff',
            border: '1px solid #c4b5fd',
            borderRadius: 14,
            padding: '20px 22px',
            marginBottom: 24,
          }}>
            <p style={{ fontWeight: 700, fontSize: 15, color: '#5b21b6', marginBottom: 6 }}>
              ✏️ 영역 수동 선택 도구
            </p>
            <p style={{ fontSize: 13, color: '#6d28d9', lineHeight: 1.6 }}>
              시험지를 선택하면 PDF 캔버스에서 문항 영역을 직접 드래그해 선택할 수 있습니다.
              시험지가 목록에 없다면 먼저 <strong>시험지 업로드</strong>에서 등록해 주세요.
            </p>
          </div>

          {/* 시험지 선택 */}
          <div style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 14,
            padding: '20px 22px',
          }}>
            <label
              htmlFor="library-select"
              className="form-label"
              style={{ display: 'block', marginBottom: 10, fontSize: 15, fontWeight: 600 }}
            >
              📂 등록된 시험지 불러오기
            </label>

            {libraryEntries.length === 0 ? (
              <div style={{
                padding: '18px 16px',
                background: '#fafafa',
                border: '1px dashed #d1d5db',
                borderRadius: 10,
                textAlign: 'center',
                color: '#6b7280',
                fontSize: 14,
              }}>
                <div style={{ fontSize: 36, marginBottom: 8 }}>📭</div>
                <p>등록된 시험지가 없습니다.</p>
                <p style={{ fontSize: 12, marginTop: 4 }}>
                  먼저 <strong>시험지 업로드</strong>에서 PDF를 등록해 주세요.
                </p>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: 14 }}
                  onClick={() => navigate('/exam-papers')}
                >
                  시험지 업로드하러 가기 →
                </button>
              </div>
            ) : (
              <select
                id="library-select"
                className="form-input"
                value={libraryPickId}
                onChange={(e) => handleLibrarySelect(e.target.value)}
                disabled={loading}
                style={{ fontSize: 14 }}
              >
                <option value="">— 시험지를 선택하세요 —</option>
                {libraryEntries.map((en) => (
                  <option key={en.id} value={en.id}>
                    {en.label}
                    {en.grade && en.semester ? ` (${en.grade} ${en.semester}${en.unit ? ' ' + en.unit : ''})` : ''}
                  </option>
                ))}
              </select>
            )}

            {loading && (
              <div style={{ marginTop: 14, textAlign: 'center', color: '#6d28d9', fontSize: 13 }}>
                <span className="spinner" style={{ marginRight: 6 }} />
                시험지를 불러오는 중...
              </div>
            )}

            {error && (
              <div className="alert alert-error" style={{ marginTop: 14 }}>
                ⚠️ {error}
              </div>
            )}
          </div>

        </div>
      </main>
    </div>
  );
}
