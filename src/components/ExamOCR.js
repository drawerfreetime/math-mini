/**
 * ExamOCR.js — 시험 사진·PDF 일부 → 문항 추출 UI(기본보내기) + 앱 전역 공용 유틸(renderMathText, ProblemCard 등).
 * 하이브리드 OCR: 백엔드 Gemini Flash + (429·5xx 시) Claude Sonnet. 문항별 「OCR 개선 지시」는 Gemini 정밀 재검토 API.
 * 교사 대시보드에서는 경로를 노출하지 않으며, 다른 화면이 이 파일의 함수·컴포넌트를 import합니다.
 * 시험지 데이터는 Firebase에 저장됩니다 (학생 실명 없음, 교사 UID만 연결)
 */
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, addDoc, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import {
  elementaryScriptToLatex,
  fixOcrBrokenHorizontalTimes,
  fixOcrBrokenTextCommand,
  normalizeElementaryScriptDollars,
  rewriteMessyVerticalMultiplyDollars,
} from '../utils/elementaryMathScript';
import {
  getElementaryMathInlineHtml,
  serializeContentEditable,
} from '../utils/inlineMathStorage';
import { normalizeExamQuestionText, EXAM_INLINE_BLANK_CLASS, splitExamBlankSegments } from '../utils/examBlankBrackets';
import { stripLeadingCircledFromChoiceText } from '../utils/circledAnswer';
import { latexToPlain, isComplexLatexForPlainTransform } from '../utils/latexPlainTransform';
import { backendUrl } from '../utils/backendUrl';
import { loadExamPdf } from '../utils/pdfStorage';
import { getPdfJs } from '../utils/pdfjsSetup';
import ReviewMathToolsSidebar from './ReviewMathToolsSidebar';
import HudFrame from './HudFrame';
import PrecisionReviewChat from './PrecisionReviewChat';
import { decodeBarGraphPayload } from '../utils/barGraphStorage';
import { BarGraphPreview } from './BarGraphWidget';
import { mergePrecisionReviewIntoProblem } from '../api/precisionReview';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export { latexToPlain, isComplexLatexForPlainTransform };

const CLAUDE_MODEL   = 'claude-opus-4-5';
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_FILE_SIZE  = 20 * 1024 * 1024;
const CHOICE_LABELS  = ['①', '②', '③', '④', '⑤', '⑥'];

// ─────────────────────────────────────────────
// SVG 텍스트(숫자/레이블) 인라인 편집기
// ─────────────────────────────────────────────
function parseSVGTextElements(svgCode) {
  if (!svgCode) return [];
  const re = /<text([^>]*)\bid="(t_[^"]+)"([^>]*)>([^<]*)<\/text>/gi;
  const results = [];
  let m;
  while ((m = re.exec(svgCode)) !== null) {
    results.push({ id: m[2], text: m[4] });
  }
  return results;
}

function applySVGTextChange(svgCode, id, val) {
  return svgCode.replace(
    new RegExp(`(<text[^>]*\\bid="${id}"[^>]*>)[^<]*(</text>)`, 'i'),
    `$1${val}$2`
  );
}

function SvgInlineEditor({ svgCode, onSave }) {
  const [open, setOpen]   = useState(false);
  const [draft, setDraft] = useState(svgCode);
  const texts             = parseSVGTextElements(svgCode);

  useEffect(() => { setDraft(svgCode); }, [svgCode]);
  if (!texts.length) return null;

  return open ? (
    <div className="svg-text-editor">
      <div className="svg-text-editor-header">
        <span>🔢 숫자·레이블 편집</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn btn-primary btn-xs" onClick={() => { onSave(draft); setOpen(false); }}>저장</button>
          <button className="btn btn-ghost btn-xs" onClick={() => { setDraft(svgCode); setOpen(false); }}>취소</button>
        </div>
      </div>
      <div className="svg-text-editor-split">
        <div className="svg-text-editor-left">
          <div dangerouslySetInnerHTML={{ __html: draft }} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 8, background: 'white' }} />
        </div>
        <div className="svg-text-editor-right">
          {texts.map((t) => {
            const cur = draft.match(new RegExp(`<text[^>]*\\bid="${t.id}"[^>]*>([^<]*)</text>`, 'i'));
            const val = cur ? cur[1] : t.text;
            return (
              <div key={t.id} className="svg-text-field">
                <label className="svg-text-label">원본: <em>{t.text}</em></label>
                <input className="form-input svg-text-input" defaultValue={val}
                  onChange={(e) => setDraft(applySVGTextChange(draft, t.id, e.target.value))} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  ) : (
    <button className="btn btn-outline btn-xs svg-edit-btn" onClick={() => setOpen(true)}>
      🔢 숫자·레이블 편집
    </button>
  );
}

// ─────────────────────────────────────────────
// 이미지 파일 → base64
// ─────────────────────────────────────────────
function imageFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve({ base64: reader.result.split(',')[1], mediaType: file.type });
    reader.onerror = () => reject(new Error('파일 읽기 오류'));
    reader.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────
// PDF 첫 페이지 → base64 (pdf.js CDN)
// ─────────────────────────────────────────────
async function pdfToBase64(file) {
  const pdfjsLib = getPdfJs();
  if (!pdfjsLib) throw new Error('PDF 변환 모듈을 불러올 수 없습니다. 새로고침 후 다시 시도하세요.');
  const pdf      = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const page     = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas   = document.createElement('canvas');
  canvas.width   = viewport.width;
  canvas.height  = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return { base64: canvas.toDataURL('image/jpeg', 0.92).split(',')[1], mediaType: 'image/jpeg' };
}

// ─────────────────────────────────────────────
// 이미지 영역 크롭 (xFrom~xTo %, yFrom~yTo %)
// ─────────────────────────────────────────────
function cropRegion(base64, mediaType, xFrom, xTo, yFrom, yTo) {
  return new Promise((resolve) => {
    const img  = new Image();
    img.onload = () => {
      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      const x = Math.floor(nw * xFrom / 100);
      const y = Math.floor(nh * yFrom / 100);
      const w = Math.max(Math.floor(nw * (xTo - xFrom) / 100), 10);
      const h = Math.max(Math.floor(nh * (yTo - yFrom) / 100), 10);
      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(null);
    img.src = `data:${mediaType};base64,${base64}`;
  });
}

// 문제 전체 크롭 (표시용 — 여백 넉넉하게)
function cropForDisplay(base64, mediaType, bbox) {
  const xFrom = Math.max(0,   (bbox.xFrom ?? 0)   - 2);
  const xTo   = Math.min(100, (bbox.xTo   ?? 100) + 2);
  const yFrom = Math.max(0,   bbox.yFrom - 8);   // 위로 8% 여백
  const yTo   = Math.min(100, bbox.yTo   + 8);   // 아래로 8% 여백
  return cropRegion(base64, mediaType, xFrom, xTo, yFrom, yTo);
}

const CROP_OVERLAY_MIN_PCT = 2;

/** bbox 퍼센트(0~100) 정규화 — xFrom<xTo, yFrom<yTo, 최소 변 길이 유지 */
function clampBboxPercent(b) {
  let xF = Number(b.xFrom);
  let xT = Number(b.xTo);
  let yF = Number(b.yFrom);
  let yT = Number(b.yTo);
  if (Number.isNaN(xF)) xF = 0;
  if (Number.isNaN(xT)) xT = 100;
  if (Number.isNaN(yF)) yF = 0;
  if (Number.isNaN(yT)) yT = 100;
  xF = Math.max(0, Math.min(100, xF));
  xT = Math.max(0, Math.min(100, xT));
  yF = Math.max(0, Math.min(100, yF));
  yT = Math.max(0, Math.min(100, yT));
  if (xT - xF < CROP_OVERLAY_MIN_PCT) {
    const mid = (xF + xT) / 2;
    xF = Math.max(0, mid - CROP_OVERLAY_MIN_PCT / 2);
    xT = Math.min(100, xF + CROP_OVERLAY_MIN_PCT);
    xF = Math.max(0, xT - CROP_OVERLAY_MIN_PCT);
  }
  if (yT - yF < CROP_OVERLAY_MIN_PCT) {
    const mid = (yF + yT) / 2;
    yF = Math.max(0, mid - CROP_OVERLAY_MIN_PCT / 2);
    yT = Math.min(100, yF + CROP_OVERLAY_MIN_PCT);
    yF = Math.max(0, yT - CROP_OVERLAY_MIN_PCT);
  }
  return {
    xFrom: Math.round(xF),
    xTo: Math.round(xT),
    yFrom: Math.round(yF),
    yTo: Math.round(yT),
  };
}

/** 잘린 이미지에 대한 bbox(%)를 전체 시험지 좌표(%)로 합성 */
function mergeChildBboxIntoFullPage(parentPct, childPct) {
  const p = parentPct;
  const c = childPct || { xFrom: 0, xTo: 100, yFrom: 0, yTo: 100 };
  const pw = (p.xTo - p.xFrom) / 100;
  const ph = (p.yTo - p.yFrom) / 100;
  return clampBboxPercent({
    xFrom: p.xFrom + pw * c.xFrom,
    xTo: p.xFrom + pw * c.xTo,
    yFrom: p.yFrom + ph * c.yFrom,
    yTo: p.yFrom + ph * c.yTo,
  });
}

/** 크롭 박스가 뷰포트의 약 이 비율(가로·세로 각각) 안에 들도록 줌 */
const CROP_VIEW_TARGET = 0.4;

/**
 * bbox(%)·원본 픽셀 크기·뷰포트 크기로 줌·팬.
 * CSS transform 순서: translate(tx,ty) scale(S) → 점 p 는 S*p + (tx,ty).
 */
function computeCropViewTransform(bbox, nw, nh, vw, vh) {
  if (!nw || !nh || vw < 4 || vh < 4) {
    return { S: 1, tx: 0, ty: 0 };
  }
  const cropW = Math.max(((bbox.xTo - bbox.xFrom) / 100) * nw, 1e-6);
  const cropH = Math.max(((bbox.yTo - bbox.yFrom) / 100) * nh, 1e-6);
  const cx = ((bbox.xFrom + bbox.xTo) / 200) * nw;
  const cy = ((bbox.yFrom + bbox.yTo) / 200) * nh;

  const S_fit = Math.min(vw / nw, vh / nh);
  let S = Math.min(
    (CROP_VIEW_TARGET * vw) / cropW,
    (CROP_VIEW_TARGET * vh) / cropH,
  );
  const S_max = Math.max(S_fit * 28, 1e-6);
  S = Math.min(S, S_max);
  S = Math.max(S, 1e-9);

  const tx = vw / 2 - S * cx;
  const ty = vh / 2 - S * cy;
  return { S, tx, ty };
}

function applyCropDrag(startBbox, dragType, dxPct, dyPct) {
  const MIN = CROP_OVERLAY_MIN_PCT;
  const b0 = startBbox;
  switch (dragType) {
    case 'e':
      return clampBboxPercent({ ...b0, xTo: Math.min(100, Math.max(b0.xFrom + MIN, b0.xTo + dxPct)) });
    case 'w':
      return clampBboxPercent({ ...b0, xFrom: Math.max(0, Math.min(b0.xTo - MIN, b0.xFrom + dxPct)) });
    case 's':
      return clampBboxPercent({ ...b0, yTo: Math.min(100, Math.max(b0.yFrom + MIN, b0.yTo + dyPct)) });
    case 'n':
      return clampBboxPercent({ ...b0, yFrom: Math.max(0, Math.min(b0.yTo - MIN, b0.yFrom + dyPct)) });
    case 'ne':
      return clampBboxPercent({
        ...b0,
        xTo: Math.min(100, Math.max(b0.xFrom + MIN, b0.xTo + dxPct)),
        yFrom: Math.max(0, Math.min(b0.yTo - MIN, b0.yFrom + dyPct)),
      });
    case 'nw':
      return clampBboxPercent({
        ...b0,
        xFrom: Math.max(0, Math.min(b0.xTo - MIN, b0.xFrom + dxPct)),
        yFrom: Math.max(0, Math.min(b0.yTo - MIN, b0.yFrom + dyPct)),
      });
    case 'se':
      return clampBboxPercent({
        ...b0,
        xTo: Math.min(100, Math.max(b0.xFrom + MIN, b0.xTo + dxPct)),
        yTo: Math.min(100, Math.max(b0.yFrom + MIN, b0.yTo + dyPct)),
      });
    case 'sw':
      return clampBboxPercent({
        ...b0,
        xFrom: Math.max(0, Math.min(b0.xTo - MIN, b0.xFrom + dxPct)),
        yTo: Math.min(100, Math.max(b0.yFrom + MIN, b0.yTo + dyPct)),
      });
    default:
      return clampBboxPercent(b0);
  }
}

/**
 * 검수 화면 — natural 크기 월드 + 줌/팬으로 크롭 박스를 약 40% 뷰포트에 맞춤,
 * 8방향 핸들 드래그로만 크기·위치 조절, 핸들 드래그 시 bbox에 맞춰 자동 줌 (외부 라이브러리 없음)
 */
function ReviewFullPageCropEditor({
  imageSrc,
  bbox,
  onBboxChange,
  onCancel,
  onComplete,
  busy,
}) {
  const wrapRef = useRef(null);
  const overlayRef = useRef(null);
  const preloadImgRef = useRef(null);
  const [natural, setNatural] = useState({ nw: 0, nh: 0 });
  const [viewport, setViewport] = useState({ vw: 0, vh: 0 });
  const bboxRef = useRef(bbox);
  const dragRef = useRef(null);

  const getRelPos = useCallback((e) => {
    const el = overlayRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  }, []);

  useEffect(() => {
    bboxRef.current = bbox;
  }, [bbox]);

  useEffect(() => {
    setNatural({ nw: 0, nh: 0 });
  }, [imageSrc]);

  const measureViewport = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const vw = Math.max(0, r.width);
    const vh = Math.max(0, r.height);
    if (vw > 0 && vh > 0) setViewport({ vw, vh });
  }, []);

  useLayoutEffect(() => {
    measureViewport();
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measureViewport) : null;
    if (ro) ro.observe(wrap);
    window.addEventListener('resize', measureViewport);
    return () => {
      window.removeEventListener('resize', measureViewport);
      if (ro) ro.disconnect();
    };
  }, [measureViewport, imageSrc]);

  const onImgLoad = useCallback(() => {
    const img = preloadImgRef.current;
    if (!img?.naturalWidth) return;
    setNatural({ nw: img.naturalWidth, nh: img.naturalHeight });
    measureViewport();
  }, [measureViewport]);

  useLayoutEffect(() => {
    const img = preloadImgRef.current;
    if (img?.complete && img.naturalWidth && natural.nw === 0) {
      setNatural({ nw: img.naturalWidth, nh: img.naturalHeight });
      measureViewport();
    }
  }, [imageSrc, measureViewport, natural.nw]);

  const { S, tx, ty } = useMemo(
    () => computeCropViewTransform(bbox, natural.nw, natural.nh, viewport.vw, viewport.vh),
    [bbox, natural.nw, natural.nh, viewport.vw, viewport.vh],
  );

  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d || !overlayRef.current) return;
      const pos = getRelPos(e);
      const dxPct = (pos.x - d.startPos.x) * 100;
      const dyPct = (pos.y - d.startPos.y) * 100;
      onBboxChange(applyCropDrag(d.startBbox, d.type, dxPct, dyPct));
    };
    const onUp = (e) => {
      const d = dragRef.current;
      if (d && overlayRef.current && e.clientX != null) {
        const pos = getRelPos(e);
        const dxPct = (pos.x - d.startPos.x) * 100;
        const dyPct = (pos.y - d.startPos.y) * 100;
        onBboxChange(applyCropDrag(d.startBbox, d.type, dxPct, dyPct));
      }
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onBboxChange, getRelPos]);

  const startDrag = useCallback((type, e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!overlayRef.current) return;
    dragRef.current = {
      type,
      startPos: getRelPos(e),
      startBbox: clampBboxPercent({ ...bboxRef.current }),
    };
  }, [getRelPos]);

  const midX = (bbox.xFrom + bbox.xTo) / 2;
  const midY = (bbox.yFrom + bbox.yTo) / 2;
  const handleDefs = [
    { id: 'nw', left: bbox.xFrom, top: bbox.yFrom, cur: 'nwse-resize' },
    { id: 'n', left: midX, top: bbox.yFrom, cur: 'ns-resize' },
    { id: 'ne', left: bbox.xTo, top: bbox.yFrom, cur: 'nesw-resize' },
    { id: 'e', left: bbox.xTo, top: midY, cur: 'ew-resize' },
    { id: 'se', left: bbox.xTo, top: bbox.yTo, cur: 'nwse-resize' },
    { id: 's', left: midX, top: bbox.yTo, cur: 'ns-resize' },
    { id: 'sw', left: bbox.xFrom, top: bbox.yTo, cur: 'nesw-resize' },
    { id: 'w', left: bbox.xFrom, top: midY, cur: 'ew-resize' },
  ];

  const ready = natural.nw > 0 && natural.nh > 0 && viewport.vw > 0 && viewport.vh > 0;

  return (
    <div className="review-full-crop-editor">
      <div ref={wrapRef} className="review-full-crop-stage">
        {ready && (
          <div
            className="review-full-crop-world"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: natural.nw,
              height: natural.nh,
              transform: `translate(${tx}px, ${ty}px) scale(${S})`,
              transformOrigin: '0 0',
              willChange: 'transform',
            }}
          >
            <img
              src={imageSrc}
              alt="전체 시험지"
              className="review-full-crop-img-native"
              width={natural.nw}
              height={natural.nh}
              draggable={false}
            />
            <div
              ref={overlayRef}
              className="review-full-crop-image-overlay"
              aria-hidden
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                boxSizing: 'border-box',
              }}
            />
            <div className="review-full-crop-hud">
              <div
                className="review-full-crop-box"
                style={{
                  position: 'absolute',
                  left: `${bbox.xFrom}%`,
                  top: `${bbox.yFrom}%`,
                  width: `${bbox.xTo - bbox.xFrom}%`,
                  height: `${bbox.yTo - bbox.yFrom}%`,
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                  border: '2px solid rgba(255,255,255,0.95)',
                  pointerEvents: 'none',
                }}
              />
              {handleDefs.map((h) => (
                <span
                  key={h.id}
                  role="presentation"
                  className={`review-full-crop-handle review-full-crop-handle-${h.id}`}
                  style={{
                    position: 'absolute',
                    left: `${h.left}%`,
                    top: `${h.top}%`,
                    width: 12,
                    height: 12,
                    marginLeft: -6,
                    marginTop: -6,
                    background: '#fff',
                    border: '2px solid #2563eb',
                    borderRadius: 2,
                    cursor: h.cur,
                    zIndex: 2,
                    pointerEvents: 'auto',
                  }}
                  onMouseDown={(e) => startDrag(h.id, e)}
                />
              ))}
            </div>
          </div>
        )}
        {!ready && (
          <img
            ref={preloadImgRef}
            src={imageSrc}
            alt=""
            className="review-full-crop-img-preload"
            onLoad={onImgLoad}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          />
        )}
      </div>
      <div className="review-full-crop-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onComplete}>
          {busy ? (
            <>
              <span className="spinner" style={{ borderTopColor: 'var(--primary)' }} />
              재인식 중…
            </>
          ) : (
            '완료 · AI 재인식'
          )}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
          취소
        </button>
      </div>
      <p className="review-full-crop-hint">
        크롭 영역이 화면의 약 40%를 차지하도록 자동 줍니다. 모서리·변의 핸들만 드래그해 조절할 수 있습니다.
      </p>
    </div>
  );
}

// 그림 영역만 크롭 (SVG 생성용 — 더 넉넉한 여백)
function cropForSVG(base64, mediaType, bbox) {
  const xFrom = Math.max(0,   (bbox.xFrom ?? 0)   - 3);
  const xTo   = Math.min(100, (bbox.xTo   ?? 100) + 3);
  const yFrom = Math.max(0,   bbox.yFrom - 5);
  const yTo   = Math.min(100, bbox.yTo   + 5);
  return cropRegion(base64, mediaType, xFrom, xTo, yFrom, yTo);
}

// ─────────────────────────────────────────────
// Claude API 공통 호출
// ─────────────────────────────────────────────
async function callClaude(messages, maxTokens = 4096) {
  const res = await fetch('/api/claude/v1/messages', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`API 오류 (${res.status}): ${err.error?.message || '알 수 없는 오류'}`);
  }
  return (await res.json()).content[0].text;
}

// ─────────────────────────────────────────────
// 하이브리드 OCR — 서버: Gemini Flash + (429·5xx 시) Claude 3.5 Sonnet
// ─────────────────────────────────────────────

/** 문항·선지·보기 안의 OCR용 깨진 세로곱 array → 표준 $…$ LaTeX */
function normalizeOcrProblemCoreSlice(core) {
  if (!core || typeof core !== 'object') return core;
  const normBlank = (s) => normalizeExamQuestionText(s);
  const q = normBlank(core.question);
  const ch = Array.isArray(core.choices)
    ? core.choices.map((c) => stripLeadingCircledFromChoiceText(normBlank(c)))
    : core.choices;
  const bg =
    core.bogi != null && core.bogi !== ''
      ? normBlank(core.bogi)
      : core.bogi;
  return { ...core, question: q, choices: ch, bogi: bg };
}

function hydrateProblemRow(row, usedBackend) {
  const display = row.display_result && typeof row.display_result === 'object'
    ? row.display_result
    : {};
  const rawQ = row.question ?? display.question ?? '';
  const rawChoices = row.choices ?? display.choices ?? null;
  const rawBogi = row.bogi ?? display.bogi ?? null;
  const topCore = normalizeOcrProblemCoreSlice({
    question: rawQ,
    choices: rawChoices,
    bogi: rawBogi,
  });
  const normQ = topCore.question;
  const normChoices = topCore.choices;
  const normBogi = topCore.bogi;
  return {
    ...row,
    number: row.number ?? display.number,
    question: normQ,
    choices: normChoices,
    hasImage: row.hasImage ?? display.hasImage ?? false,
    imageDescription: row.imageDescription ?? display.imageDescription ?? null,
    bogi: normBogi,
    tableData: row.tableData ?? display.tableData ?? null,
    answer: row.answer ?? display.answer ?? null,
    bbox: row.bbox ?? display.bbox ?? null,
    status: row.status || 'pending_review',
    gemini_result: row.gemini_result ? normalizeOcrProblemCoreSlice({ ...row.gemini_result }) : null,
    claude_result: row.claude_result ? normalizeOcrProblemCoreSlice({ ...row.claude_result }) : null,
    display_result:
      row.display_result && typeof row.display_result === 'object'
        ? normalizeOcrProblemCoreSlice({ ...row.display_result })
        : null,
    ocrInitialBackend: usedBackend || 'unknown',
    ocrPrecisionUsed: false,
    /** true면 화면에 Gemini(처음) 결과, false면 재검토 Claude 결과 */
    ocrCompareShowsGemini: false,
    svgCode: null,
    svgLoading: !!(row.hasImage ?? display?.hasImage),
    svgError: false,
    croppedImg: null,
    cropLoading: !!(row.bbox ?? display?.bbox),
  };
}

async function fetchExamOcrExtractProblems(base64, mediaType) {
  const res = await fetch(backendUrl('/api/exam-ocr/extract'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64, mediaType }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error((text || '').slice(0, 260) || `서버 OCR 응답 파싱 실패 (${res.status})`);
  }
  if (!res.ok) {
    const detail = data.detail;
    const msg =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((d) => d.msg || JSON.stringify(d)).join(' ')
          : typeof detail === 'object' && detail !== null
            ? JSON.stringify(detail)
            : `OCR API 오류 (${res.status})`;
    throw new Error(msg);
  }
  const raw = Array.isArray(data.problems) ? data.problems : [];
  if (!raw.length) throw new Error('인식된 문제가 없습니다. 이미지를 확인해 주세요.');
  const usedBackend = data.used_backend || '';
  return { raw, usedBackend };
}

async function extractProblemsHybrid(base64, mediaType) {
  const { raw, usedBackend } = await fetchExamOcrExtractProblems(base64, mediaType);
  return raw.map((row) => hydrateProblemRow(row, usedBackend));
}

function writableCoreSliceFromPartial(partial, number, bbox) {
  return {
    number,
    question: partial.question ?? '',
    choices: partial.choices === undefined ? null : partial.choices,
    hasImage: !!partial.hasImage,
    imageDescription: partial.imageDescription ?? null,
    bogi: partial.bogi ?? null,
    tableData: partial.tableData === undefined ? null : partial.tableData,
    answer: partial.answer ?? null,
    bbox: bbox ?? partial.bbox ?? null,
  };
}

/** 텍스트 편집 시 gemini_result / claude_result / display_result 동기화 */
function mergeProblemWithOcrSync(prev, updates) {
  const next = { ...prev, ...updates };
  const core = writableCoreSliceFromPartial(next, next.number, next.bbox);
  let gr = next.gemini_result;
  let cr = next.claude_result;
  if (!next.ocrPrecisionUsed) {
    gr = { ...core };
  } else if (next.ocrCompareShowsGemini) {
    gr = { ...core };
  } else if (cr) {
    cr = { ...core };
  }
  return { ...next, gemini_result: gr, claude_result: cr, display_result: { ...core } };
}

// ─────────────────────────────────────────────
// 숫자 카드 전용 문항 — SVG 도형 재생성 불필요
// ─────────────────────────────────────────────
const NUMBER_CARD_SHAPE_RE = /삼각|사각|원(?:형)?|각도|직선|도형|그래프|좌표|격자|눈금|평행|수직|cm|mm|°/;

function isNumberCardsOnlyProblem(problem) {
  const q = `${problem?.question || ''}\n${problem?.imageDescription || ''}`;
  if (!/숫자\s*카드/.test(q)) {
    const desc = problem?.imageDescription || '';
    if (!problem?.hasImage || !/카드/.test(desc) || NUMBER_CARD_SHAPE_RE.test(desc)) return false;
    return true;
  }
  const desc = problem?.imageDescription || '';
  return !desc || !NUMBER_CARD_SHAPE_RE.test(desc);
}

// ─────────────────────────────────────────────
// SVG 재생성 — 그림 영역만 잘라서 Vision에게 "따라 그려"
// ─────────────────────────────────────────────
async function generateSVG(problem, base64, mediaType) {
  // 1단계: 이 문제의 bbox 영역을 크롭 → Claude가 그 부분만 집중해서 볼 수 있도록
  let focusBase64  = base64;
  let focusMedia   = mediaType;

  if (problem.bbox) {
    const cropped = await cropForSVG(base64, mediaType, problem.bbox);
    if (cropped) {
      focusBase64 = cropped.split(',')[1];
      focusMedia  = 'image/jpeg';
    }
  }

  // 2단계: 수학 도형 특화 — 정확한 기하학적 SVG 생성
  const prompt = `이 수학 시험지의 도형/그래프를 SVG로 정확히 재현해줘.

[수학 도형 처리 규칙]
1. 삼각형 → <polygon> 또는 <polyline>으로 정확한 각도/비율 계산해서 그려
2. 사각형·직사각형 → <rect> 또는 <polygon>으로 정확하게
3. 각도 표시 → <path d="M...A..." fill="none"/>로 호(arc) 정확히
4. 눈금·격자 → 일정한 간격의 <line> 반복
5. 손글씨·연필 필기는 무시하고 인쇄된 도형만

[편집 가능하게 ID 부여 규칙 — 반드시 따를 것]
- 모든 <text> 요소에 id="t_번호" 부여 (예: id="t_1", id="t_2" ...)
- 레이블 텍스트(A, B, C, 숫자, cm 등) 각각 별도 text 요소로
- 각도값, 변의 길이값은 반드시 별도 <text id="t_각도1">90°</text> 형식

[SVG 형식]
- <svg width="480" height="360" viewBox="0 0 480 360" xmlns="http://www.w3.org/2000/svg">
- 배경: <rect width="480" height="360" fill="white"/>
- 도형 선: stroke="black" stroke-width="2" fill="none"
- 채워진 영역(색): fill 지정
- 점: <circle r="4" fill="black"/>
- 텍스트: font-family="Arial,sans-serif" font-size="14" fill="black"
- 각도호: <path d="M cx,cy m r,0 a r,r 0 0,0 ..." stroke="black" fill="none"/>
- 직각표시: <rect x="..." y="..." width="10" height="10" fill="none" stroke="black"/>
- SVG 코드만 반환`;

  const text = await callClaude([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: focusMedia, data: focusBase64 } },
      { type: 'text', text: prompt },
    ],
  }], 3500);

  const match = text.match(/<svg[\s\S]*?<\/svg>/i);
  return match ? match[0] : null;
}

function looseDisplayEq(a, b) {
  return String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 단원평가 검수 등: 단순 `$...$` / 분수 / 단위는 읽기 쉬운 문자열로, 복잡한 수식은 `$...$` 유지.
 */
export function mathTextToHybridEditDisplay(text) {
  if (!text) return '';
  const s = normalizeMathSource(text);
  const re = /\$\$([^$]+)\$\$|\[분수:([^/\]]+)\/([^\]]+)\]|\$([^$]+)\$|⟦UNIT:([^⟧]+)⟧/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out += s.slice(last, m.index);
    const full = m[0];
    if (full.startsWith('$$')) {
      out += isComplexLatexForPlainTransform(m[1]) ? full : latexToPlain(m[1]);
    } else if (full.startsWith('[분수:')) {
      out += `${m[2]}/${m[3]}`;
    } else if (full.startsWith('⟦UNIT:')) {
      try {
        out += decodeURIComponent(m[5]);
      } catch {
        out += '';
      }
    } else {
      const inner = m[4];
      out += isComplexLatexForPlainTransform(inner) ? full : latexToPlain(inner);
    }
    last = re.lastIndex;
  }
  if (last < s.length) out += s.slice(last);
  return out;
}

/**
 * @param {string} str
 * @param {string[]} orderedDelims delimiter strings must appear in order
 * @returns {string[] | null} parts.length === delims.length + 1
 */
function splitByOrderedDelimiters(str, orderedDelims) {
  const parts = [];
  let pos = 0;
  for (const d of orderedDelims) {
    const idx = str.indexOf(d, pos);
    if (idx === -1) return null;
    parts.push(str.slice(pos, idx));
    pos = idx + d.length;
  }
  parts.push(str.slice(pos));
  return parts;
}

/**
 * 하이브리드 편집 문자열 → 저장용 canonical. 복잡한 `$...$` 덩어리는 prev 와 동일할 때만 유지.
 * @param {string} display
 * @param {string} prevCanonical
 */
export function hybridEditDisplayToCanonical(display, prevCanonical) {
  const prev = normalizeMathSource(prevCanonical == null ? '' : String(prevCanonical));
  const disp = normalizeMathSource(display == null ? '' : String(display));
  if (!prev) return disp;

  const scanRe = /\$\$([^$]+)\$\$|\[분수:([^/\]]+)\/([^\]]+)\]|\$([^$]+)\$|⟦UNIT:([^⟧]+)⟧/g;
  /** @type {string[]} */
  const complexLiterals = [];
  let sm;
  while ((sm = scanRe.exec(prev)) !== null) {
    const full = sm[0];
    if (full.startsWith('$$')) {
      if (isComplexLatexForPlainTransform(sm[1])) complexLiterals.push(full);
    } else if (full.startsWith('$') && full.length > 1) {
      if (isComplexLatexForPlainTransform(sm[4])) complexLiterals.push(full);
    }
  }

  if (complexLiterals.length === 0) {
    const expected = mathTextToHybridEditDisplay(prev);
    return looseDisplayEq(expected, disp) ? prev : disp;
  }

  const dg = splitByOrderedDelimiters(disp, complexLiterals);
  const cg = splitByOrderedDelimiters(prev, complexLiterals);
  if (!dg || !cg || dg.length !== cg.length) return disp;

  let merged = '';
  for (let i = 0; i < dg.length; i++) {
    const gapCanon = cg[i];
    const gapDisp = dg[i];
    if (gapCanon === '') {
      merged += gapDisp;
    } else {
      const exp = mathTextToHybridEditDisplay(gapCanon);
      merged += looseDisplayEq(exp, gapDisp) ? gapCanon : gapDisp;
    }
    if (i < complexLiterals.length) merged += complexLiterals[i];
  }
  return normalizeExamQuestionText(merged);
}

// ─────────────────────────────────────────────
// 원문 정규화 (전각 달러, 줄바꿈)
// ─────────────────────────────────────────────
function normalizeMathSource(text) {
  return fixOcrBrokenTextCommand(
    fixOcrBrokenHorizontalTimes(
      String(text)
        .replace(/\uFF04/g, '$')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n'),
    ),
  );
}

/**
 * $...$, [분수:…] 를 포함한 문자열 전체를 일반 텍스트로 (미리보기·내보내기)
 */
function complexLatexPlainLabel(inner) {
  const t = String(inner ?? '').trim();
  if (/^MULTVERT\s*\{/i.test(t)) return '[세로곱셈]';
  if (/^LONGDIV\s*\{/i.test(t)) return '[세로나눗셈]';
  if (/^LADDER\s*\{/i.test(t)) return '[약분]';
  if (/\\begin\{array\}/.test(t)) return '[세로셈]';
  return '[수식]';
}

export function mathTextToPlainString(text) {
  if (!text) return '';
  const s = normalizeMathSource(text);
  return s
    .replace(/\$\$([^$]+)\$\$/g, (_, inner) =>
      isComplexLatexForPlainTransform(inner) ? complexLatexPlainLabel(inner) : latexToPlain(inner))
    .replace(/\$([^$]+)\$/g, (_, inner) =>
      isComplexLatexForPlainTransform(inner) ? complexLatexPlainLabel(inner) : latexToPlain(inner))
    .replace(/\[분수:([^/\]]+)\/([^\]]+)\]/g, '$1/$2')
    .replace(/⟦UNIT:([^⟧]+)⟧/g, (_, enc) => {
      try {
        return decodeURIComponent(enc);
      } catch {
        return '';
      }
    })
    .replace(/⟦BARGRAPH:[^⟧]+⟧/g, '[막대그래프]');
}

/**
 * contenteditable 복사: KaTeX 글자 단위 DOM 대신 읽기 쉬운 평문(210 cm 등)을 클립보드에 넣는다.
 * @param {React.ClipboardEvent<HTMLElement>} event
 */
export function copyPlainFromContentEditableSelection(event) {
  const root = event.currentTarget;
  if (!(root instanceof HTMLElement)) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return;

  const wrap = document.createElement('div');
  wrap.appendChild(range.cloneContents());
  const plain = mathTextToPlainString(serializeContentEditable(wrap));
  event.preventDefault();
  event.clipboardData?.setData('text/plain', plain);
}

// ─────────────────────────────────────────────
// 수식 포함 텍스트 렌더링
// $...$, $$...$$, [분수:a/b] → 일반 텍스트로 출력
// ─────────────────────────────────────────────
function katexNode(key, latex, displayMode) {
  try {
    const html = katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
    });
    return (
      <span
        key={key}
        className={displayMode ? 'math-katex-wrap math-katex-wrap--display' : 'math-katex-wrap'}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  } catch {
    return (
      <span key={key} className="math-katex-fallback">
        {latexToPlain(latex)}
      </span>
    );
  }
}

/** LONGDIV·MULTVERT·LADDER — 편집 칩과 동일한 인라인 HTML */
function elementaryMathNode(key, latex, displayMode) {
  const inner = String(latex ?? '').trim();
  const html = getElementaryMathInlineHtml(inner);
  if (html) {
    return (
      <span
        key={key}
        className={displayMode ? 'math-katex-wrap math-katex-wrap--display' : 'math-katex-wrap'}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return katexNode(key, inner, displayMode);
}

function renderInlineUnitSpan(key, encoded) {
  let label = encoded;
  try {
    label = decodeURIComponent(encoded);
  } catch {
    /* keep raw */
  }
  const s = String(label);
  const parts = [];
  let i = 0;
  let pk = 0;
  while (i < s.length) {
    if (s[i] === '²') {
      parts.push(
        <sup key={`${key}-u${pk++}`} className="math-unit-sup">
          2
        </sup>
      );
      i++;
    } else if (s[i] === '³') {
      parts.push(
        <sup key={`${key}-u${pk++}`} className="math-unit-sup">
          3
        </sup>
      );
      i++;
    } else {
      let j = i;
      while (j < s.length && s[j] !== '²' && s[j] !== '³') j++;
      if (j > i) parts.push(s.slice(i, j));
      i = j;
    }
  }
  return (
    <span key={key} className="math-inline-unit">
      {parts}
    </span>
  );
}

/**
 * 일반 문자열 조각 — `[          ]`·`(          )` 빈칸 너비 보존
 */
function renderPlainWithExamBlanks(text, keyBase) {
  return splitExamBlankSegments(text).map((seg, i) => {
    if (seg.type === 'text') {
      return seg.value ? <span key={`${keyBase}-t${i}`}>{seg.value}</span> : null;
    }
    return (
      <span
        key={`${keyBase}-b${i}`}
        className={EXAM_INLINE_BLANK_CLASS}
        data-exam-blank={seg.canonical}
      >
        {seg.display}
      </span>
    );
  });
}

/**
 * $...$, $$...$$, [분수:a/b] → KaTeX(수식) + 일반 글자. 학생 화면에 LaTeX 원문·$는 노출하지 않음.
 */
export function renderMathText(text) {
  if (!text) return null;
  const s = normalizeElementaryScriptDollars(normalizeMathSource(text));
  const re =
    /\$\$([\s\S]+?)\$\$|\[분수:([^/\]]+)\/([^\]]+)\]|\$([\s\S]+?)\$|⟦BARGRAPH:([^⟧]+)⟧|⟦UNIT:([^⟧]+)⟧/g;
  const out = [];
  let lastIndex = 0;
  let m;
  let key = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > lastIndex) {
      out.push(...renderPlainWithExamBlanks(s.slice(lastIndex, m.index), `m${key++}`));
    }
    const full = m[0];
    if (full.startsWith('$$')) {
      out.push(elementaryMathNode(`m${key++}`, m[1], true));
    } else if (full.startsWith('[분수:')) {
      out.push(
        <span key={`m${key++}`} className="math-frac">
          <span className="math-frac-num">{m[2]}</span>
          <span className="math-frac-bar" />
          <span className="math-frac-den">{m[3]}</span>
        </span>
      );
    } else if (full.startsWith('⟦BARGRAPH:')) {
      const cfg = decodeBarGraphPayload(m[5]);
      out.push(
        cfg ? (
          <BarGraphPreview key={`m${key++}`} config={cfg} compact />
        ) : (
          <span key={`m${key++}`}>[막대그래프]</span>
        ),
      );
    } else if (full.startsWith('⟦UNIT:')) {
      out.push(renderInlineUnitSpan(`m${key++}`, m[6]));
    } else {
      out.push(elementaryMathNode(`m${key++}`, m[4], false));
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < s.length) {
    out.push(...renderPlainWithExamBlanks(s.slice(lastIndex), `m${key++}`));
  }
  return out.length ? out : null;
}


// ─────────────────────────────────────────────
// 문제 카드 렌더러 (OCR 결과 & 뷰어 공용)
// ─────────────────────────────────────────────
export function ProblemCard({
  problem,
  idx,
  editingIdx,
  editText,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditText,
  onTableChange,
  onSvgChange,
  onBogiChange,
  readOnly = false,
}) {
  const p = problem;

  // 보기 편집 상태
  const [bogiEditing, setBogiEditing] = useState(false);
  const [bogiDraft,   setBogiDraft]   = useState(p.bogi || '');

  function saveBogiEdit() {
    if (onBogiChange) onBogiChange(idx, bogiDraft);
    setBogiEditing(false);
  }

  React.useEffect(() => { setBogiDraft(p.bogi || ''); }, [p.bogi]);

  return (
    <div className="prob-card">
      {/* 크롭 이미지 */}
      {p.croppedImg && !p.svgCode && (
        <img src={p.croppedImg} alt={`${p.number}번 원본`} className="prob-crop-img" />
      )}
      {p.croppedImg && p.svgCode && (
        <details className="prob-crop-details">
          <summary>📷 원본 이미지 보기</summary>
          <img src={p.croppedImg} alt={`${p.number}번 원본`} className="prob-crop-img" style={{ marginTop: 8 }} />
        </details>
      )}

      {/* 문제 텍스트 */}
      <div className="prob-text-row">
        <span className="prob-num-badge">{p.number}</span>
        <div className="prob-text-body">
          {editingIdx === idx ? (
            <textarea className="form-input ocr-edit-textarea" value={editText}
              onChange={(e) => onEditText(e.target.value)} rows={4} autoFocus />
          ) : (
            <p className="prob-question">{renderMathText(p.question)}</p>
          )}
        </div>
        {!readOnly && (
          <div className="prob-edit-btns">
            {editingIdx === idx ? (
              <>
                <button className="btn btn-primary btn-xs" onClick={() => onSaveEdit(idx)}>✅ 저장</button>
                <button className="btn btn-ghost btn-xs" onClick={onCancelEdit}>취소</button>
              </>
            ) : (
              <button className="btn btn-outline btn-xs" onClick={() => onStartEdit(idx)}>✏️ 수정</button>
            )}
          </div>
        )}
      </div>

      {/* SVG 도형 */}
      {p.svgLoading && (
        <div className="ocr-svg-loading">
          <span className="spinner" style={{ borderTopColor: 'var(--primary)' }} />
          <span>도형 재생성 중...</span>
        </div>
      )}
      {!p.svgLoading && p.svgCode && (
        <div className="ocr-svg-wrapper">
          <div className="ocr-svg-container" dangerouslySetInnerHTML={{ __html: p.svgCode }} />
          {!readOnly && (
            <SvgInlineEditor svgCode={p.svgCode} onSave={(s) => onSvgChange && onSvgChange(idx, s)} />
          )}
        </div>
      )}
      {!p.svgLoading && p.svgError && (
        <div className="ocr-svg-error">⚠️ 도형 자동 생성 실패</div>
      )}

      {/* 보기 박스 */}
      {(p.bogi || bogiDraft) && (
        <div className="bogi-box">
          <div className="bogi-title-row">
            <span className="bogi-title-text">〈 보 기 〉</span>
            {!readOnly && (
              bogiEditing
                ? <>
                    <button className="btn btn-primary btn-xs" onClick={saveBogiEdit}>저장</button>
                    <button className="btn btn-ghost btn-xs" onClick={() => { setBogiEditing(false); setBogiDraft(p.bogi || ''); }}>취소</button>
                  </>
                : <button className="btn btn-outline btn-xs" onClick={() => setBogiEditing(true)}>✏️ 편집</button>
            )}
          </div>
          {bogiEditing ? (
            <textarea className="form-input bogi-edit-textarea"
              value={bogiDraft} onChange={(e) => setBogiDraft(e.target.value)} rows={4} autoFocus />
          ) : (
            <div className="bogi-content">
              {(bogiDraft || p.bogi || '').split('\n').map((line, li) => (
                <p key={li}>{renderMathText(line)}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 선지 (①②③④⑤) */}
      {p.choices && p.choices.length > 0 && (
        <div className="prob-choices">
          {p.choices.map((c, ci) => (
            <div key={ci} className="prob-choice">
              <span className="prob-choice-num">{CHOICE_LABELS[ci]}</span>
              <span className="prob-choice-text">{renderMathText(c)}</span>
            </div>
          ))}
        </div>
      )}

      {/* 표 */}
      {p.tableData && Array.isArray(p.tableData) && p.tableData.length > 0 && (
        <div className="exam-table-wrap">
          <table className="exam-table">
            <tbody>
              {p.tableData.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => {
                    const Tag = ri === 0 ? 'th' : 'td';
                    return (
                      <Tag key={ci} contentEditable={!readOnly} suppressContentEditableWarning
                        onBlur={(e) => !readOnly && onTableChange && onTableChange(idx, ri, ci, e.target.innerText)}>
                        {renderMathText(String(cell))}
                      </Tag>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════
// 메인 컴포넌트
// ═════════════════════════════════════════════
export default function ExamOCR() {
  const { teacherUser } = useAuth();
  const currentUser = teacherUser;
  const navigate = useNavigate();

  const [view, setView]             = useState('upload');
  const [imageFile, setImageFile]   = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const [problems, setProblems]       = useState([]);
  const [examTitle, setExamTitle]     = useState('');
  const [examGrade, setExamGrade]     = useState('');  // 초1~초6
  const [selectedIdx, setSelectedIdx] = useState(0);

  const [editingIdx, setEditingIdx] = useState(null);
  const [editText, setEditText]     = useState('');

  const [processingMsg, setProcessingMsg]         = useState('');
  const [processingProgress, setProcessingProgress] = useState(0);

  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState(null);

  // 원본 이미지 (크롭 재조정용)
  const [origBase64, setOrigBase64]       = useState('');
  const [origMediaType, setOrigMediaType] = useState('');

  // 크롭 편집 상태
  const [cropEditIdx, setCropEditIdx]   = useState(null);
  const [cropEditBbox, setCropEditBbox] = useState(null);

  /** 원본 패널 — 전체 시험지 위 8핸들 크롭 후 /api/exam-ocr/extract 재실행 */
  const [reviewPageCropOpen, setReviewPageCropOpen] = useState(false);
  const [reviewPageCropBbox, setReviewPageCropBbox] = useState(null);
  const [reviewGeminiRecropBusy, setReviewGeminiRecropBusy] = useState(false);

  /** 검수 우측 패널 인라인 수식·단위 삽입 대상 */
  const [reviewMathOpen, setReviewMathOpen] = useState(false);
  /** @type {React.MutableRefObject<{ field: 'question' | 'title' | 'table' | null; start?: number; end?: number; tableRi?: number; tableCi?: number }>} */
  const reviewInsertCaretRef = useRef({ field: null });

  const fileInputRef   = useRef(null);
  const cameraInputRef = useRef(null);
  const problemsRef = useRef(problems);

  /** @type {[{ idx: number, cropDataUrl: string } | null]} */
  const [precisionPanel, setPrecisionPanel] = useState(null);

  // ── 파일 선택 ──
  function handleFileSelect(file) {
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) { setError('JPG, PNG, PDF만 가능합니다.'); return; }
    if (file.size > MAX_FILE_SIZE) { setError('파일 크기는 20MB 이하여야 합니다.'); return; }
    setError('');
    setImageFile(file);
    setPreviewUrl(file.type === 'application/pdf' ? null : URL.createObjectURL(file));
  }

  const handleDrop     = useCallback((e) => { e.preventDefault(); setIsDragging(false); handleFileSelect(e.dataTransfer.files[0]); }, []);
  const handleDragOver = useCallback((e) => { e.preventDefault(); setIsDragging(true); }, []);

  async function handleLoadSavedExamPdf() {
    setError('');
    try {
      const f = await loadExamPdf();
      if (!f) {
        setError('저장된 시험지가 없습니다. 「시험지에 학생의 번호·이름 자동 입력」에서 PDF를 선택하면 여기에 저장됩니다.');
        return;
      }
      handleFileSelect(f);
    } catch (err) {
      setError(err?.message || '저장된 시험지를 불러오지 못했습니다.');
    }
  }

  useEffect(() => {
    problemsRef.current = problems;
  }, [problems]);

  useEffect(() => {
    if (!reviewPageCropOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !reviewGeminiRecropBusy) {
        setReviewPageCropOpen(false);
        setReviewPageCropBbox(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reviewPageCropOpen, reviewGeminiRecropBusy]);

  // ── OCR 실행 ──
  const extractLockRef = useRef(false);
  async function handleExtract() {
    if (!imageFile || extractLockRef.current) return;
    extractLockRef.current = true;
    setView('processing'); setError('');
    try {
      setProcessingMsg('이미지를 준비하는 중...'); setProcessingProgress(10);
      let base64, mediaType;
      if (imageFile.type === 'application/pdf') {
        setProcessingMsg('PDF를 이미지로 변환 중...');
        ({ base64, mediaType } = await pdfToBase64(imageFile));
      } else {
        ({ base64, mediaType } = await imageFileToBase64(imageFile));
      }

      setOrigBase64(base64);
      setOrigMediaType(mediaType);

      setProcessingMsg('Gemini 1.5 Flash가 시험지를 분석하는 중…'); setProcessingProgress(25);
      const extracted = await extractProblemsHybrid(base64, mediaType);

      // 문제 초기화
      let current = extracted.map((p) => ({
        ...p,
        svgCode: null, svgLoading: !!p.hasImage, svgError: false,
        croppedImg: null, cropLoading: !!(p.bbox),
      }));
      setProblems([...current]);
      setSelectedIdx(0);
      setProcessingProgress(40);

      // 문제별 이미지 크롭 (표시용, 여백 넉넉하게)
      const needCrop = current.filter((p) => p.bbox);
      if (needCrop.length > 0) {
        for (let i = 0; i < needCrop.length; i++) {
          setProcessingMsg(`문제별 이미지 크롭 중… (${i + 1}/${needCrop.length})`);
          const prob = needCrop[i];
          const img  = await cropForDisplay(base64, mediaType, prob.bbox);
          current = current.map((p) =>
            p.number === prob.number ? { ...p, croppedImg: img, cropLoading: false } : p
          );
        }
        setProblems([...current]);
      }
      setProcessingProgress(55);

      // SVG 생성 (숫자 카드만 있는 문항은 텍스트로 충분)
      const needSvg = current.filter((p) => p.hasImage && !isNumberCardsOnlyProblem(p));
      current = current.map((p) =>
        p.hasImage && isNumberCardsOnlyProblem(p)
          ? { ...p, hasImage: false, svgLoading: false, svgError: false }
          : p,
      );
      for (let i = 0; i < needSvg.length; i++) {
        const prob = needSvg[i];
        setProcessingMsg(`도형 재생성 중... (${i + 1}/${needSvg.length})`);
        setProcessingProgress(55 + Math.round(((i + 1) / needSvg.length) * 40));
        try {
          const svg = await generateSVG(prob, base64, mediaType);
          current = current.map((p) =>
            p.number === prob.number ? { ...p, svgCode: svg, svgLoading: false } : p
          );
        } catch {
          current = current.map((p) =>
            p.number === prob.number ? { ...p, svgLoading: false, svgError: true } : p
          );
        }
        setProblems([...current]);
      }

      setProcessingProgress(100);
      setProcessingMsg('완료!');
      setExamTitle('수학 시험지');
      await new Promise((r) => setTimeout(r, 400));
      setView('results');
    } catch (err) {
      setError(err.message);
      setView('upload');
    } finally {
      extractLockRef.current = false;
    }
  }

  // ── 문제 텍스트 수정 ──
  function startEdit(idx) { setEditingIdx(idx); setEditText(problems[idx].question); }
  function saveEdit(idx) {
    setProblems((prev) =>
      prev.map((p, i) => {
        if (i !== idx) return p;
        return mergeProblemWithOcrSync(p, {
          question: normalizeElementaryScriptDollars(rewriteMessyVerticalMultiplyDollars(editText)),
        });
      }),
    );
    setEditingIdx(null);
  }

  // ── SVG 수정 ──
  function handleSvgChange(probIdx, newSvg) {
    setProblems((prev) => prev.map((p, i) => (i === probIdx ? { ...p, svgCode: newSvg } : p)));
  }

  // ── 보기 수정 ──
  function handleBogiChange(probIdx, newBogi) {
    setProblems((prev) =>
      prev.map((p, i) => {
        if (i !== probIdx) return p;
        return mergeProblemWithOcrSync(p, { bogi: newBogi });
      }),
    );
  }

  // ── 크롭 영역 재조정 ──
  async function handleRecrop(idx, newBbox) {
    if (!origBase64) return;
    const newImg = await cropForDisplay(origBase64, origMediaType, newBbox);
    setProblems((prev) =>
      prev.map((p, i) => {
        if (i !== idx) return p;
        const next = { ...p, bbox: newBbox, croppedImg: newImg };
        const core = writableCoreSliceFromPartial(next, next.number, newBbox);
        const gr = next.gemini_result ? { ...next.gemini_result, bbox: newBbox } : null;
        const cr = next.claude_result ? { ...next.claude_result, bbox: newBbox } : null;
        return { ...next, gemini_result: gr, claude_result: cr, display_result: { ...core } };
      }),
    );
  }

  /** 원본 패널 크롭 UI — 잘린 영역만 extract API로 재인식 후 현재 문항 갱신 */
  async function handleReviewGeminiRecropComplete() {
    const idx = selectedIdx;
    const regionBbox = clampBboxPercent(reviewPageCropBbox || problems[idx]?.bbox || {});
    const base64 = origBase64;
    const mediaType = origMediaType;
    const prev = problemsRef.current[idx];
    if (!base64 || !prev) {
      setError('원본 이미지가 없습니다. 다시 업로드해 주세요.');
      return;
    }
    setReviewGeminiRecropBusy(true);
    setError('');
    try {
      const tightUrl = await cropRegion(base64, mediaType, regionBbox.xFrom, regionBbox.xTo, regionBbox.yFrom, regionBbox.yTo);
      if (!tightUrl) throw new Error('선택 영역을 잘라내지 못했습니다.');
      const cropB64 = tightUrl.split(',')[1];
      const { raw, usedBackend } = await fetchExamOcrExtractProblems(cropB64, 'image/jpeg');
      const first = hydrateProblemRow(raw[0], usedBackend);
      const fullBbox = mergeChildBboxIntoFullPage(regionBbox, first.bbox);
      const displayImg = await cropForDisplay(base64, mediaType, fullBbox);
      const cn = Number(prev.number);
      const core = writableCoreSliceFromPartial(
        { ...prev, ...first, number: cn, bbox: fullBbox },
        cn,
        fullBbox,
      );
      let merged = {
        ...prev,
        ...first,
        number: cn,
        bbox: fullBbox,
        question: first.question ?? prev.question,
        choices: first.choices !== undefined ? first.choices : prev.choices,
        hasImage: !!first.hasImage,
        imageDescription: first.imageDescription ?? prev.imageDescription,
        bogi: first.bogi !== undefined ? first.bogi : prev.bogi,
        tableData: first.tableData !== undefined ? first.tableData : prev.tableData,
        answer: first.answer !== undefined ? first.answer : prev.answer,
        gemini_result: first.gemini_result
          ? { ...first.gemini_result, ...core, bbox: fullBbox, number: cn }
          : { ...core },
        claude_result: first.claude_result
          ? { ...first.claude_result, ...core, bbox: fullBbox, number: cn }
          : null,
        display_result: { ...core },
        status: first.status || 'pending_review',
        ocrInitialBackend: usedBackend || first.ocrInitialBackend || 'unknown',
        ocrPrecisionUsed: false,
        ocrCompareShowsGemini: false,
        croppedImg: displayImg,
        cropLoading: false,
        svgCode: null,
        svgLoading: !!first.hasImage,
        svgError: false,
      };
      if (isNumberCardsOnlyProblem(merged)) {
        merged = { ...merged, hasImage: false, svgLoading: false, svgError: false };
      }
      if (!merged.hasImage) merged = { ...merged, svgLoading: false };

      setProblems((p0) => p0.map((row, i) => (i === idx ? merged : row)));
      setReviewPageCropOpen(false);
      setReviewPageCropBbox(null);
      setEditingIdx(null);

      if (merged.hasImage) {
        try {
          const svg = await generateSVG(merged, base64, mediaType);
          setProblems((p0) =>
            p0.map((row, i) =>
              i === idx ? { ...row, svgCode: svg, svgLoading: false, svgError: false } : row,
            ),
          );
        } catch {
          setProblems((p0) =>
            p0.map((row, i) => (i === idx ? { ...row, svgLoading: false, svgError: true } : row)),
          );
        }
      }
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setReviewGeminiRecropBusy(false);
    }
  }

  // ── 표 셀 수정 ──
  function handleTableChange(probIdx, ri, ci, value) {
    setProblems((prev) =>
      prev.map((p, i) => {
        if (i !== probIdx || !p.tableData) return p;
        const td = p.tableData.map((row) => [...row]);
        td[ri][ci] = value;
        return mergeProblemWithOcrSync(p, { tableData: td });
      }),
    );
  }

  const captureReviewInsertCaret = useCallback((e) => {
    const t = e.target;
    if (t instanceof HTMLTextAreaElement && t.classList.contains('review-edit-textarea')) {
      reviewInsertCaretRef.current = {
        field: 'question',
        start: t.selectionStart,
        end: t.selectionEnd,
      };
      return;
    }
    if (t instanceof HTMLInputElement && t.classList.contains('review-title-input')) {
      reviewInsertCaretRef.current = {
        field: 'title',
        start: t.selectionStart,
        end: t.selectionEnd,
      };
    }
  }, []);

  const insertReviewChunk = useCallback(
    (chunk) => {
      if (!chunk) return;
      const r = reviewInsertCaretRef.current;
      if (!r.field) {
        setError('먼저 왼쪽에서 제목·문제·표 칸 등 입력란을 선택한 뒤 다시 눌러 주세요.');
        return;
      }
      setError('');
      if (r.field === 'question') {
        if (editingIdx !== selectedIdx) {
          setError('「문제 수정」을 켠 상태에서 문제 입력란을 선택한 뒤 넣을 수 있어요.');
          return;
        }
        setEditText((prev) => {
          const start = Math.min(r.start ?? prev.length, prev.length);
          const end = Math.min(r.end ?? prev.length, prev.length);
          const next = prev.slice(0, start) + chunk + prev.slice(end);
          const nc = start + chunk.length;
          queueMicrotask(() => {
            reviewInsertCaretRef.current = { field: 'question', start: nc, end: nc };
          });
          return next;
        });
        return;
      }
      if (r.field === 'title') {
        setExamTitle((prev) => {
          const start = Math.min(r.start ?? prev.length, prev.length);
          const end = Math.min(r.end ?? prev.length, prev.length);
          const next = prev.slice(0, start) + chunk + prev.slice(end);
          const nc = start + chunk.length;
          queueMicrotask(() => {
            reviewInsertCaretRef.current = { field: 'title', start: nc, end: nc };
          });
          return next;
        });
        return;
      }
      if (r.field === 'table') {
        const ri = r.tableRi;
        const ci = r.tableCi;
        if (ri == null || ci == null) return;
        setProblems((prev) => {
          const prob = prev[selectedIdx];
          if (!prob?.tableData?.[ri]) return prev;
          const cur = String(prob.tableData[ri][ci] ?? '');
          const nextVal = cur + chunk;
          queueMicrotask(() => {
            reviewInsertCaretRef.current = { field: 'table', tableRi: ri, tableCi: ci };
          });
          return prev.map((p, i) => {
            if (i !== selectedIdx || !p.tableData) return p;
            const td = p.tableData.map((row) => [...row]);
            td[ri][ci] = nextVal;
            return mergeProblemWithOcrSync(p, { tableData: td });
          });
        });
      }
    },
    [editingIdx, selectedIdx]
  );

  const insertReviewMathFromScript = useCallback(
    (script) => {
      const latex = elementaryScriptToLatex(script).trim();
      if (!latex) return;
      insertReviewChunk(`$${latex}$`);
    },
    [insertReviewChunk]
  );

  const insertReviewSymbol = useCallback(
    (kind, sym) => {
      const chunk =
        kind === 'op' ? sym : `⟦UNIT:${encodeURIComponent(sym)}⟧`;
      insertReviewChunk(chunk);
    },
    [insertReviewChunk]
  );

  const toggleReviewMathPanel = useCallback(() => {
    setReviewMathOpen((v) => !v);
  }, []);

  /** 인라인 수식 패널 열기 직전, 왼쪽 검수 입력의 커서를 확정 (포커스 이동 순서 보정) */
  const onReviewMathTogglePointerDown = useCallback(
    (e) => {
      if (e.button !== 0 || reviewMathOpen) return;
      const ae = document.activeElement;
      if (ae instanceof HTMLTextAreaElement && ae.classList.contains('review-edit-textarea')) {
        reviewInsertCaretRef.current = {
          field: 'question',
          start: ae.selectionStart,
          end: ae.selectionEnd,
        };
        return;
      }
      if (ae instanceof HTMLInputElement && ae.classList.contains('review-title-input')) {
        reviewInsertCaretRef.current = {
          field: 'title',
          start: ae.selectionStart ?? 0,
          end: ae.selectionEnd ?? 0,
        };
      }
    },
    [reviewMathOpen],
  );

  function handlePrecisionReviewApply(idx, apiResult) {
    setProblems((prev) =>
      prev.map((p, i) => (i === idx ? mergePrecisionReviewIntoProblem(p, apiResult) : p)),
    );
  }

  async function openPrecisionPanel(idx) {
    const base64 = origBase64;
    const mediaType = origMediaType;
    if (!base64) {
      setError('원본 이미지가 없습니다. 다시 업로드해 주세요.');
      return;
    }
    const p = problemsRef.current[idx];
    if (!p?.bbox) return;
    setError('');
    try {
      const dataUrl = await cropForDisplay(base64, mediaType, p.bbox);
      if (!dataUrl) throw new Error('문항 이미지를 만들 수 없습니다.');
      setPrecisionPanel({ idx, cropDataUrl: dataUrl });
    } catch (err) {
      setError(String(err?.message || err));
    }
  }

  function handleToggleOcrCompare(idx) {
    setProblems((prev) =>
      prev.map((p, i) => {
        if (i !== idx || !p.ocrPrecisionUsed || !p.gemini_result || !p.claude_result) return p;
        const nextGem = !p.ocrCompareShowsGemini;
        const snap = nextGem ? p.gemini_result : p.claude_result;
        return mergeProblemWithOcrSync(p, {
          question: snap.question ?? '',
          choices: snap.choices ?? null,
          hasImage: !!snap.hasImage,
          imageDescription: snap.imageDescription ?? null,
          bogi: snap.bogi ?? null,
          tableData: snap.tableData ?? null,
          bbox: p.bbox,
          ocrCompareShowsGemini: nextGem,
        });
      }),
    );
  }

  // ── Firestore 저장 (교사 UID만 연결, 학생 실명 없음) ──
  async function handleSaveToFirestore() {
    if (saving) return;
    if (!examTitle.trim()) { setError('시험지 제목을 입력해주세요.'); return; }
    setSaving(true); setError('');
    try {
      const digit = examGrade.trim().match(/\d+/)?.[0] || String(examGrade).trim();
      const examRef = await addDoc(collection(db, 'exams'), {
        createdBy:     currentUser?.uid || 'anonymous',
        examGrade:     examGrade,
        grade:         digit || examGrade.trim(),
        semester:      '1학기',
        unit:          '3',
        title:         examTitle.trim(),
        questionCount: problems.length,
        createdAt:     new Date().toISOString(),
      });
      for (const p of problems) {
        await setDoc(doc(db, 'exams', examRef.id, 'questions', String(p.number)), {
          number:           p.number,
          question:         p.question,
          choices:          p.choices || null,
          hasImage:         p.hasImage || false,
          imageDescription: p.imageDescription || null,
          svgCode:          p.svgCode || null,
          bogi:             p.bogi || null,
          tableData:        p.tableData || null,
          answer:           null,
          gemini_result:    p.gemini_result || null,
          claude_result:    p.claude_result || null,
          display_result:
            p.display_result || writableCoreSliceFromPartial(p, p.number, p.bbox),
          status:           p.status || 'pending_review',
        });
      }
      setSavedId(examRef.id);
      setView('done');
    } catch (err) {
      setError('저장 오류: ' + err.message);
    }
    setSaving(false);
  }

  // ════════════════════════════════════════════
  // 렌더: 업로드 화면
  // ════════════════════════════════════════════
  if (view === 'upload') {
    return (
      <div className="dashboard-container">
        <header className="dashboard-header">
          <div className="header-left">
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/teacher')}>← 대시보드로</button>
            <span style={{ fontSize: 26 }}>📷</span>
            <div>
              <h1 className="header-title">시험 사진 · 문항 추출</h1>
              <p className="header-subtitle">사진·스캔으로 문제를 자동 추출해요</p>
            </div>
          </div>
          <div className="header-right" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <button type="button" className="btn btn-outline btn-sm" onClick={handleLoadSavedExamPdf}>
              저장된 시험지 불러오기
            </button>
            <span className="user-badge teacher-badge">교사</span>
            <span className="user-name">{teacherUser?.displayName || teacherUser?.email}</span>
          </div>
        </header>

        <main className="dashboard-main" style={{ maxWidth: 700 }}>
          {error && <div className="alert alert-error">⚠️ {error}<button className="alert-close" onClick={() => setError('')}>×</button></div>}

          <div
            className={`ocr-dropzone ${isDragging ? 'ocr-dropzone-active' : ''} ${imageFile ? 'ocr-dropzone-filled' : ''}`}
            onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={() => setIsDragging(false)}
            onClick={() => !imageFile && fileInputRef.current?.click()}
          >
            {imageFile ? (
              <>
                {previewUrl
                  ? <img src={previewUrl} alt="미리보기" className="ocr-preview-img" />
                  : <div className="ocr-pdf-icon"><span>📄</span><p>{imageFile.name}</p><span className="badge badge-gray">PDF</span></div>
                }
                <div className="ocr-file-info">
                  <span className="ocr-file-name">{imageFile.name}</span>
                  <span className="ocr-file-size">({(imageFile.size / 1024 / 1024).toFixed(1)} MB)</span>
                  <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); setImageFile(null); setPreviewUrl(null); }}>✕ 다시 선택</button>
                </div>
              </>
            ) : (
              <>
                <div className="ocr-dropzone-icon">🖼️</div>
                <p className="ocr-dropzone-title">여기에 파일을 드래그하거나 클릭해서 선택하세요</p>
                <p className="ocr-dropzone-sub">지원 형식: JPG, PNG, PDF · 최대 20MB</p>
              </>
            )}
          </div>

          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,application/pdf" style={{ display: 'none' }} onChange={(e) => handleFileSelect(e.target.files[0])} />
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => handleFileSelect(e.target.files[0])} />

          <div className="ocr-btn-row">
            <button className="btn btn-outline" onClick={() => fileInputRef.current?.click()}>📁 파일 선택</button>
            <button className="btn btn-outline" onClick={() => cameraInputRef.current?.click()}>📸 카메라 촬영</button>
            <button className="btn btn-primary btn-large" onClick={handleExtract} disabled={!imageFile || view === 'processing'} style={{ marginLeft: 'auto' }}>🔍 문제 추출 시작</button>
          </div>

          <div className="ocr-guide">
            <h3 className="ocr-guide-title">📌 촬영 팁</h3>
            <ul className="ocr-guide-list">
              <li>시험지 전체가 화면에 들어오도록 촬영해주세요</li>
              <li>그림자·빛 반사 없이 밝은 곳에서 촬영하세요</li>
              <li>PDF는 첫 페이지만 인식됩니다</li>
              <li>문제 수가 많으면 처리에 30초~1분 정도 걸릴 수 있어요</li>
            </ul>
          </div>
        </main>
      </div>
    );
  }

  // ════════════════════════════════════════════
  // 렌더: 처리 중
  // ════════════════════════════════════════════
  if (view === 'processing') {
    return (
      <div className="ocr-processing-container">
        <div className="ocr-processing-card">
          <div className="ocr-processing-icon">🤖</div>
          <h2 className="ocr-processing-title">AI가 시험지를 분석하는 중이에요</h2>
          <p className="ocr-processing-msg">{processingMsg}</p>
          <div className="ocr-progress-bar"><div className="ocr-progress-fill" style={{ width: `${processingProgress}%` }} /></div>
          <p className="ocr-progress-pct">{processingProgress}%</p>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════
  // 렌더: 검수 화면 (my1ta 스타일)
  // ════════════════════════════════════════════
  if (view === 'results') {
    const cur = problems[selectedIdx];
    const GRADES = ['초1', '초2', '초3', '초4', '초5', '초6'];

    return (
      <div className="review-layout">
        <PrecisionReviewChat
          open={precisionPanel != null}
          cropPreviewUrl={precisionPanel?.cropDataUrl}
          problemNumber={precisionPanel != null ? problems[precisionPanel.idx]?.number : null}
          currentCore={
            precisionPanel != null
              ? {
                  number: problems[precisionPanel.idx]?.number,
                  question: problems[precisionPanel.idx]?.question ?? '',
                  choices: problems[precisionPanel.idx]?.choices ?? null,
                  hasImage: !!problems[precisionPanel.idx]?.hasImage,
                  imageDescription: problems[precisionPanel.idx]?.imageDescription ?? null,
                  bogi: problems[precisionPanel.idx]?.bogi ?? null,
                  tableData: problems[precisionPanel.idx]?.tableData ?? null,
                  answer: problems[precisionPanel.idx]?.answer ?? null,
                  bbox: problems[precisionPanel.idx]?.bbox ?? null,
                }
              : null
          }
          onApply={(apiResult) => {
            if (precisionPanel != null) handlePrecisionReviewApply(precisionPanel.idx, apiResult);
          }}
          onClose={() => setPrecisionPanel(null)}
        />
        {/* 상단 헤더 */}
        <header className="review-header">
          <div className="review-header-left">
            <button className="btn btn-ghost btn-sm" onClick={() => { setView('upload'); setProblems([]); }}>← 다시 업로드</button>
            <span className="review-header-title">영역 검수 <span className="review-header-count">총 {problems.length}문제</span></span>
          </div>
          <div className="review-header-right">
            {/* 학년 선택 */}
            <div className="review-grade-row">
              <span className="review-grade-label">학년</span>
              {GRADES.map((g) => (
                <button
                  key={g}
                  className={`review-grade-btn ${examGrade === g ? 'active' : ''}`}
                  onClick={() => setExamGrade(g)}
                >{g}</button>
              ))}
            </div>
            <button
              className="btn btn-primary"
              onClick={handleSaveToFirestore}
              disabled={saving || problems.some((p) => p.svgLoading) || !examGrade}
              title={!examGrade ? '학년을 선택해주세요' : ''}
            >
              {saving ? <><span className="spinner" /> 저장 중...</>
                : problems.some((p) => p.svgLoading) ? '⏳ 처리 중...'
                : !examGrade ? '학년 선택 후 저장'
                : '저장'}
            </button>
          </div>
        </header>

        <div className="review-body">
          {/* 좌측: 문제 썸네일 목록 */}
          <aside className="review-sidebar">
            <div className="review-sidebar-title">문제 목록</div>
            {/* 시험지 제목 */}
            <input
              className="review-title-input"
              value={examTitle}
              onChange={(e) => setExamTitle(e.target.value)}
              placeholder="시험지 제목 입력"
              onBlur={captureReviewInsertCaret}
              onSelect={captureReviewInsertCaret}
              onKeyUp={captureReviewInsertCaret}
            />
            <div className="review-thumb-list">
              <div className="review-thumb-grid">
                {problems.map((p, i) => (
                  <div
                    key={p.number}
                    className={`review-thumb-item ${selectedIdx === i ? 'active' : ''} ${p.svgLoading ? 'loading' : ''}`}
                    onClick={() => {
                      setSelectedIdx(i);
                      setEditingIdx(null);
                      setCropEditIdx(null);
                      setReviewPageCropOpen(false);
                      setReviewPageCropBbox(null);
                    }}
                  >
                    <span className="review-thumb-num">{p.number}번</span>
                    {p.croppedImg
                      ? <img src={p.croppedImg} alt={`${p.number}번`} className="review-thumb-img" />
                      : <div className="review-thumb-placeholder">{p.svgLoading ? '⏳' : '📝'}</div>
                    }
                    {selectedIdx === i && p.bbox && (
                      <button className="crop-adjust-btn" onClick={(e) => {
                        e.stopPropagation();
                        setCropEditIdx(i);
                        setCropEditBbox({ ...p.bbox });
                      }}>영역 조정</button>
                    )}
                  </div>
                ))}
              </div>
              {cropEditIdx !== null && cropEditBbox && problems[cropEditIdx] && (
                <div className="crop-adjust-panel crop-adjust-panel-below-thumbs" onClick={(e) => e.stopPropagation()}>
                  {['yFrom', 'yTo'].map((key) => (
                    <div key={key} className="crop-slider-row">
                      <label className="crop-slider-label">
                        {key === 'yFrom' ? '위쪽' : '아래쪽'} {cropEditBbox[key]}%
                      </label>
                      <input
                        type="range" min="0" max="100"
                        value={cropEditBbox[key]}
                        onChange={(e) => setCropEditBbox((b) => ({ ...b, [key]: Number(e.target.value) }))}
                        className="crop-slider"
                      />
                    </div>
                  ))}
                  <div className="crop-adjust-btns">
                    <button className="btn btn-primary btn-xs" onClick={async () => {
                      await handleRecrop(cropEditIdx, cropEditBbox);
                      setCropEditIdx(null);
                    }}>재크롭 적용</button>
                    <button className="btn btn-ghost btn-xs" onClick={() => setCropEditIdx(null)}>취소</button>
                  </div>
                </div>
              )}
            </div>
          </aside>

          {/* 우측: 선택된 문제 상세 (원본 | 추출 텍스트) */}
          <main className="review-main">
            {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>⚠️ {error}<button className="alert-close" onClick={() => setError('')}>×</button></div>}

            {cur && (
              <>
                <div className="review-split-header">
                  <span className="review-split-num">{cur.number}번 문제</span>
                  <span className="review-split-hint">좌: 원본 이미지 / 우: 추출·편집 영역</span>
                  {/* 이전/다음 */}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-ghost btn-xs"
                      disabled={selectedIdx === 0}
                      onClick={() => {
                        setSelectedIdx(selectedIdx - 1);
                        setEditingIdx(null);
                        setReviewPageCropOpen(false);
                        setReviewPageCropBbox(null);
                      }}
                    >◀ 이전</button>
                    <button
                      className="btn btn-ghost btn-xs"
                      disabled={selectedIdx === problems.length - 1}
                      onClick={() => {
                        setSelectedIdx(selectedIdx + 1);
                        setEditingIdx(null);
                        setReviewPageCropOpen(false);
                        setReviewPageCropBbox(null);
                      }}
                    >다음 ▶</button>
                  </div>
                </div>

                <div className="review-split-body">
                  {/* 왼쪽: 원본 이미지 */}
                  <div className="review-split-left">
                    <div className="review-split-label review-split-label-with-action">
                      <span>원본</span>
                      <div className="review-split-label-actions">
                        {!reviewPageCropOpen && (
                          <button
                            type="button"
                            className="review-orig-pencil-btn"
                            title="영역 조정 후 AI 재인식"
                            aria-label="영역 조정 후 AI 재인식"
                            disabled={!origBase64 || !cur?.bbox || reviewGeminiRecropBusy}
                            onClick={() => {
                              if (!cur?.bbox || !origBase64) return;
                              setCropEditIdx(null);
                              setReviewPageCropBbox(clampBboxPercent({ ...cur.bbox }));
                              setReviewPageCropOpen(true);
                            }}
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                              <path
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.75"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                    {reviewPageCropOpen && reviewPageCropBbox && origBase64 ? (
                      <ReviewFullPageCropEditor
                        imageSrc={`data:${origMediaType};base64,${origBase64}`}
                        bbox={reviewPageCropBbox}
                        onBboxChange={setReviewPageCropBbox}
                        onCancel={() => {
                          if (reviewGeminiRecropBusy) return;
                          setReviewPageCropOpen(false);
                          setReviewPageCropBbox(null);
                        }}
                        onComplete={handleReviewGeminiRecropComplete}
                        busy={reviewGeminiRecropBusy}
                      />
                    ) : cur.croppedImg ? (
                      <img src={cur.croppedImg} alt="원본 문제" className="review-orig-img" />
                    ) : (
                      <div className="review-orig-placeholder">이미지 없음</div>
                    )}
                  </div>

                  {/* 오른쪽: 추출 텍스트 + ProblemCard 편집 */}
                  <div className="review-split-right">
                    <div className="review-split-label">
                      AI 추출 결과
                      {editingIdx !== selectedIdx
                        ? <button className="btn btn-outline btn-xs" style={{ marginLeft: 8 }} onClick={() => startEdit(selectedIdx)}>✏️ 문제 수정</button>
                        : <>
                            <button className="btn btn-primary btn-xs" style={{ marginLeft: 8 }} onClick={() => saveEdit(selectedIdx)}>✅ 저장</button>
                            <button className="btn btn-ghost btn-xs" style={{ marginLeft: 4 }} onClick={() => setEditingIdx(null)}>취소</button>
                          </>
                      }
                    </div>

                    <div style={{ marginBottom: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        disabled={!cur.bbox}
                        title="지시를 입력하면 AI가 문항 OCR을 다시 실행합니다"
                        onClick={() => openPrecisionPanel(selectedIdx)}
                      >
                        🔬 OCR 개선 지시
                      </button>
                      {cur.ocrPrecisionUsed && cur.gemini_result && cur.claude_result && (
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={() => handleToggleOcrCompare(selectedIdx)}
                        >
                          {cur.ocrCompareShowsGemini ? '재검토 결과 보기' : '이전 결과 보기'}
                        </button>
                      )}
                    </div>

                    {editingIdx === selectedIdx ? (
                      <textarea
                        className="form-input review-edit-textarea"
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={6}
                        autoFocus
                        onBlur={captureReviewInsertCaret}
                        onSelect={captureReviewInsertCaret}
                        onKeyUp={captureReviewInsertCaret}
                      />
                    ) : (
                      <p className="review-extracted-text">{renderMathText(cur.question)}</p>
                    )}

                    {/* 선지 */}
                    {cur.choices && cur.choices.length > 0 && (
                      <div className="prob-choices" style={{ marginTop: 10 }}>
                        {cur.choices.map((c, ci) => (
                          <div key={ci} className="prob-choice">
                            <span className="prob-choice-num">{CHOICE_LABELS[ci]}</span>
                            <span className="prob-choice-text">{renderMathText(c)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 보기 박스 (편집 가능) */}
                    {cur.bogi != null && (
                      <div className="bogi-box" style={{ marginTop: 12 }}>
                        <div className="bogi-title-row">
                          <span className="bogi-title-text">〈 보 기 〉</span>
                          <button className="btn btn-outline btn-xs"
                            onClick={() => handleBogiChange(selectedIdx, prompt('보기 내용 수정:', cur.bogi) ?? cur.bogi)}>
                            ✏️ 편집
                          </button>
                        </div>
                        <div className="bogi-content">
                          {(cur.bogi || '').split('\n').map((line, li) => <p key={li}>{renderMathText(line)}</p>)}
                        </div>
                      </div>
                    )}

                    {/* 표 */}
                    {cur.tableData && (
                      <div className="exam-table-wrap" style={{ marginTop: 12 }}>
                        <table className="exam-table">
                          <tbody>
                            {cur.tableData.map((row, ri) => (
                              <tr key={ri}>
                                {row.map((cell, ci) => {
                                  const Tag = ri === 0 ? 'th' : 'td';
                                  return (
                                    <Tag
                                      key={ci}
                                      data-review-table-cell=""
                                      data-row={ri}
                                      data-col={ci}
                                      contentEditable
                                      suppressContentEditableWarning
                                      onFocus={(e) => {
                                        const el = e.currentTarget;
                                        reviewInsertCaretRef.current = {
                                          field: 'table',
                                          tableRi: Number(el.dataset.row),
                                          tableCi: Number(el.dataset.col),
                                        };
                                      }}
                                      onBlur={(e) => handleTableChange(selectedIdx, ri, ci, e.target.innerText)}
                                    >
                                      {renderMathText(String(cell))}
                                    </Tag>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* SVG 도형 */}
                    {cur.svgLoading && (
                      <div className="ocr-svg-loading" style={{ marginTop: 12 }}>
                        <span className="spinner" style={{ borderTopColor: 'var(--primary)' }} />
                        <span>도형 재생성 중...</span>
                      </div>
                    )}
                    {!cur.svgLoading && cur.svgCode && (
                      <div className="ocr-svg-wrapper" style={{ marginTop: 12 }}>
                        <div className="ocr-svg-container" dangerouslySetInnerHTML={{ __html: cur.svgCode }} />
                        <SvgInlineEditor svgCode={cur.svgCode}
                          onSave={(s) => handleSvgChange(selectedIdx, s)} />
                      </div>
                    )}
                    {!cur.svgLoading && cur.svgError && (
                      <div className="ocr-svg-error" style={{ marginTop: 12 }}>⚠️ 도형 자동 생성 실패</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </main>

          <ReviewMathToolsSidebar
            mathOpen={reviewMathOpen}
            onToggleMath={toggleReviewMathPanel}
            onMathTogglePointerDown={onReviewMathTogglePointerDown}
            onInsertMathScript={insertReviewMathFromScript}
            onPickSymbol={insertReviewSymbol}
          />
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════
  // 렌더: 저장 완료
  // ════════════════════════════════════════════
  if (view === 'done') {
    return (
      <div className="ocr-processing-container">
        <HudFrame className="ocr-processing-hud">
          <div className="ocr-processing-icon">🎉</div>
          <h2 className="ocr-processing-title">저장 완료!</h2>
          <p className="ocr-processing-msg"><strong>{examTitle}</strong>이(가) 저장되었습니다.</p>
          <p className="ocr-processing-sub">총 <strong>{problems.length}</strong>문제</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 28 }}>
            <button className="btn btn-outline" onClick={() => { setView('upload'); setImageFile(null); setPreviewUrl(null); setProblems([]); setExamTitle(''); setSavedId(null); }}>
              🔄 새 시험지 업로드
            </button>
            <button className="btn btn-primary" onClick={() => navigate(`/exam/${savedId}`)}>
              📋 문제 보기
            </button>
            <button className="btn btn-ghost" onClick={() => navigate('/teacher')}>
              대시보드로
            </button>
          </div>
        </HudFrame>
      </div>
    );
  }

  return null;
}
