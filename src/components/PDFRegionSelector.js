/**
 * PDFRegionSelector.js — 문항 영역 수동 선택(최소)
 *
 * 남기는 핵심 기능:
 * - PDF 업로드/표시(pdf.js)
 * - 드래그로 문항 영역 추가
 * - 추가 즉시 문항 좌상단에 markBox(고정 크기 네모) 생성/표시
 * - 영역 삭제 / 문항 번호 수정
 * - 서버에 좌표 저장(`/api/regions/save-coordinates`) 및 목록 조회(`/api/regions`)
 *
 * 삭제된 기능:
 * - 검수 시작/AI OCR 파이프라인(자동 OCR 넘어가기 포함)
 * - parse-problem 호출, 분류/정밀검수/UnitTestReview 이동
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import HudFrame from './HudFrame';
import { cancelPdfRenderTask, getPdfJs } from '../utils/pdfjsSetup';
import { computeMarkBoxFromRegion } from '../utils/problemMarkBox';

const RENDER_SCALE = 2.5;
const MIN_BOX_RATIO = 0.012;

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeInt(v, fallback) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function PdfDropZone({ onFile }) {
  return (
    <div
      className="ocr-dropzone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0] || null;
        if (f) onFile(f);
      }}
      style={{ cursor: 'pointer' }}
      onClick={() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/pdf,.pdf';
        input.onchange = () => {
          const f = input.files?.[0] || null;
          if (f) onFile(f);
        };
        input.click();
      }}
    >
      <div className="ocr-dropzone-icon">📄</div>
      <p className="ocr-dropzone-title">PDF를 드래그하거나 클릭해서 선택하세요</p>
      <p className="ocr-dropzone-sub">문항 영역을 드래그하면 좌상단에 채점 네모가 생깁니다</p>
    </div>
  );
}

export default function PDFRegionSelector() {
  const navigate = useNavigate();
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const wrapRef = useRef(null);

  const [pdfFile, setPdfFile] = useState(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageInfo, setPageInfo] = useState(null); // { widthPt, heightPt, canvasW, canvasH }
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [regions, setRegions] = useState([]); // { id, page, x,y,w,h, problem_number, markBox }
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  // drawing state (pixel in wrap)
  const [drawing, setDrawing] = useState(false);
  const startPtRef = useRef({ x: 0, y: 0 });
  const curPtRef = useRef({ x: 0, y: 0 });
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!msg) return undefined;
    const t = window.setTimeout(() => setMsg(''), 2800);
    return () => window.clearTimeout(t);
  }, [msg]);

  // load pdf file
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pdfFile) {
        setPdfDoc(null);
        setPageInfo(null);
        setCurrentPage(1);
        setTotalPages(1);
        return;
      }
      const buf = await pdfFile.arrayBuffer();
      if (cancelled) return;
      const lib = getPdfJs();
      if (!lib) {
        setMsg('PDF 렌더러를 불러오지 못했습니다.');
        return;
      }
      const doc = await lib.getDocument({ data: buf.slice(0) }).promise;
      if (cancelled) return;
      setPdfDoc(doc);
      setTotalPages(doc.numPages || 1);
      setCurrentPage(1);
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfFile]);

  // render current page
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!pdfDoc || !canvasRef.current) return;
      const page = await pdfDoc.getPage(currentPage);
      const baseVp = page.getViewport({ scale: 1 });
      const scale = RENDER_SCALE;
      const vp = page.getViewport({ scale });

      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d', { alpha: false });
      const w = Math.max(1, Math.round(vp.width));
      const h = Math.max(1, Math.round(vp.height));

      cancelPdfRenderTask(renderTaskRef.current);
      renderTaskRef.current = null;

      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const task = page.render({ canvasContext: ctx, viewport: vp });
      renderTaskRef.current = task;
      await task.promise;
      if (renderTaskRef.current === task) renderTaskRef.current = null;
      if (cancelled) return;

      setPageInfo({
        widthPt: baseVp.width,
        heightPt: baseVp.height,
        canvasW: w,
        canvasH: h,
      });
    };
    void run();
    return () => {
      cancelled = true;
      cancelPdfRenderTask(renderTaskRef.current);
      renderTaskRef.current = null;
    };
  }, [pdfDoc, currentPage]);

  const regionsOnPage = useMemo(
    () => regions.filter((r) => r.page === currentPage),
    [regions, currentPage],
  );

  const currentBox = useMemo(() => {
    if (!drawing || !wrapRef.current) return null;
    const s = startPtRef.current;
    const c = curPtRef.current;
    const x = Math.min(s.x, c.x);
    const y = Math.min(s.y, c.y);
    const w = Math.abs(c.x - s.x);
    const h = Math.abs(c.y - s.y);
    return { x, y, w, h };
  }, [drawing]);

  const beginDraw = useCallback((e) => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    startPtRef.current = { x, y };
    curPtRef.current = { x, y };
    setDrawing(true);
    forceTick((t) => t + 1);
  }, []);

  const updateDraw = useCallback(
    (e) => {
      if (!drawing || !wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      curPtRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      forceTick((t) => t + 1);
    },
    [drawing],
  );

  const finishDraw = useCallback(() => {
    if (!drawing || !wrapRef.current || !pageInfo) {
      setDrawing(false);
      return;
    }
    const rect = wrapRef.current.getBoundingClientRect();
    const s = startPtRef.current;
    const c = curPtRef.current;
    const xPx = Math.min(s.x, c.x);
    const yPx = Math.min(s.y, c.y);
    const wPx = Math.abs(c.x - s.x);
    const hPx = Math.abs(c.y - s.y);
    setDrawing(false);

    if (rect.width <= 1 || rect.height <= 1) return;
    const nx = clamp01(xPx / rect.width);
    const ny = clamp01(yPx / rect.height);
    const nw = clamp01(wPx / rect.width);
    const nh = clamp01(hPx / rect.height);

    if (nw < MIN_BOX_RATIO || nh < MIN_BOX_RATIO) {
      setMsg('영역이 너무 작습니다. 조금 더 크게 드래그해 주세요.');
      return;
    }

    setRegions((prev) => {
      const nextNum = prev.length
        ? safeInt(prev[prev.length - 1].problem_number, prev.length) + 1
        : 1;
      const base = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        page: currentPage,
        x: nx,
        y: ny,
        w: nw,
        h: nh,
        problem_number: String(nextNum),
      };
      const markBox = computeMarkBoxFromRegion(base, pageInfo.widthPt, pageInfo.heightPt);
      return [...prev, { ...base, ...(markBox ? { markBox } : {}) }];
    });
  }, [drawing, pageInfo, currentPage]);

  async function refreshHistory() {
    try {
      const res = await fetch('/api/regions');
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      const n = Array.isArray(data?.records) ? data.records.length : 0;
      setMsg(`저장 기록 ${n}개`);
    } catch {
      // ignore
    }
  }

  async function saveCoordinates() {
    if (!pdfFile || !pageInfo) {
      setMsg('PDF를 먼저 선택해 주세요.');
      return;
    }
    if (!regions.length) {
      setMsg('저장할 문항 영역이 없습니다.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        exam_name: pdfFile.name.replace(/\.pdf$/i, ''),
        pdf_name: pdfFile.name,
        total_pages: totalPages,
        page_width: pageInfo.widthPt,
        page_height: pageInfo.heightPt,
        regions: regions.map((r) => ({
          problem_number: r.problem_number,
          page: r.page,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          ...(r.markBox ? { markBox: r.markBox } : {}),
        })),
      };
      const res = await fetch('/api/regions/save-coordinates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      setMsg('✅ 좌표 저장 완료');
      await refreshHistory();
    } catch (e) {
      setMsg(`⚠️ 저장 실패: ${e?.message || String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/teacher')}>
            ← 교사 홈
          </button>
          <span style={{ fontSize: 26 }}>✏️</span>
          <div>
            <h1 className="header-title">시험지OCR · 문항 영역 선택</h1>
            <p className="header-subtitle">
              문항 영역을 드래그하면 좌상단에 채점 네모(markBox)가 함께 저장됩니다
            </p>
          </div>
        </div>
        <div className="header-right" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => setMsg('준비중입니다.')}
            title="검수 시작(자동 OCR)은 삭제되었습니다"
          >
            검수 시작
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={saveCoordinates}>
            {saving ? '저장 중…' : '좌표 저장'}
          </button>
        </div>
      </header>

      <main className="dashboard-main" style={{ maxWidth: 1100 }}>
        {msg ? (
          <div className="alert" style={{ marginBottom: 12, background: '#eff6ff', borderColor: '#bfdbfe', color: '#1e40af' }}>
            {msg}
          </div>
        ) : null}

        {!pdfFile ? (
          <HudFrame>
            <PdfDropZone onFile={setPdfFile} />
          </HudFrame>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 14 }}>
            <aside>
              <HudFrame>
                <div className="section-header">
                  <h2 className="section-title">문항 목록</h2>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPdfFile(null)}>
                    PDF 다시 선택
                  </button>
                </div>
                <div style={{ fontSize: 13, color: '#64748b', marginBottom: 10 }}>
                  {pdfFile.name} · {totalPages}쪽
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <button className="btn btn-outline btn-sm" disabled={currentPage <= 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>
                    ◀ 이전 페이지
                  </button>
                  <button className="btn btn-outline btn-sm" disabled={currentPage >= totalPages} onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}>
                    다음 페이지 ▶
                  </button>
                </div>
                <div style={{ fontSize: 12, color: '#475569', marginBottom: 8 }}>
                  현재 페이지: <strong>{currentPage}</strong>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {regions.length === 0 ? (
                    <div style={{ fontSize: 13, color: '#94a3b8' }}>
                      아직 문항 영역이 없습니다. 오른쪽에서 드래그로 추가하세요.
                    </div>
                  ) : (
                    regions
                      .slice()
                      .sort((a, b) => (a.page - b.page) || (safeInt(a.problem_number, 0) - safeInt(b.problem_number, 0)))
                      .map((r) => (
                        <div key={r.id} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 10px', background: '#fff' }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <strong style={{ minWidth: 54 }}>{r.problem_number}번</strong>
                            <span style={{ fontSize: 12, color: '#64748b' }}>{r.page}쪽</span>
                            <button
                              type="button"
                              className="btn btn-outline btn-xs"
                              style={{ marginLeft: 'auto', color: '#dc2626', borderColor: '#fecaca' }}
                              onClick={() => setRegions((prev) => prev.filter((x) => x.id !== r.id))}
                            >
                              삭제
                            </button>
                          </div>
                          <div style={{ marginTop: 8 }}>
                            <label style={{ display: 'block', fontSize: 11, color: '#64748b', marginBottom: 4 }}>
                              문항 번호
                            </label>
                            <input
                              className="form-input"
                              value={r.problem_number}
                              onChange={(e) => {
                                const v = e.target.value;
                                setRegions((prev) =>
                                  prev.map((x) => (x.id === r.id ? { ...x, problem_number: v } : x)),
                                );
                              }}
                            />
                          </div>
                        </div>
                      ))
                  )}
                </div>
              </HudFrame>
            </aside>

            <HudFrame>
              <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <strong>페이지 캔버스</strong>
                <span style={{ fontSize: 12, color: '#64748b' }}>드래그해서 문항 영역을 추가하세요</span>
              </div>

              <div
                ref={wrapRef}
                style={{ position: 'relative', display: 'inline-block', lineHeight: 0, userSelect: 'none' }}
                onMouseDown={(e) => beginDraw(e)}
                onMouseMove={(e) => updateDraw(e)}
                onMouseUp={() => finishDraw()}
                onMouseLeave={() => finishDraw()}
              >
                <canvas ref={canvasRef} />

                <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  {regionsOnPage.map((r) => (
                    <React.Fragment key={r.id}>
                      <div
                        style={{
                          position: 'absolute',
                          left: `${r.x * 100}%`,
                          top: `${r.y * 100}%`,
                          width: `${r.w * 100}%`,
                          height: `${r.h * 100}%`,
                          border: '2px solid rgba(34,197,94,0.95)',
                          boxSizing: 'border-box',
                          borderRadius: 2,
                        }}
                        title={`${r.problem_number}번`}
                      />
                      {r.markBox ? (
                        <div
                          style={{
                            position: 'absolute',
                            left: `${r.markBox.x * 100}%`,
                            top: `${r.markBox.y * 100}%`,
                            width: `${r.markBox.w * 100}%`,
                            height: `${r.markBox.h * 100}%`,
                            border: '2px solid rgba(239,68,68,0.95)',
                            boxSizing: 'border-box',
                            borderRadius: 2,
                          }}
                          title="채점 네모(markBox)"
                        />
                      ) : null}
                    </React.Fragment>
                  ))}

                  {currentBox ? (
                    <div
                      style={{
                        position: 'absolute',
                        left: currentBox.x,
                        top: currentBox.y,
                        width: currentBox.w,
                        height: currentBox.h,
                        border: '2px dashed rgba(37,99,235,0.9)',
                        background: 'rgba(37,99,235,0.06)',
                        boxSizing: 'border-box',
                      }}
                    />
                  ) : null}
                </div>
              </div>
            </HudFrame>
          </div>
        )}
      </main>
    </div>
  );
}

