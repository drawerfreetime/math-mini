/**
 * 문항 번호 감싼 채점 네모 — 영역 선택(좌상단 앵커) · pdf_regions 저장 · 학생별 PDF 인쇄 공통
 *
 * 좌표: 페이지 기준 0~1 정규화, 원점 좌상단·y 아래로 (PDFRegionSelector · scan-organize 와 동일)
 */

/** 정사각형에 가깝게 — 변 약 8mm (A4 기준) */
export const MARK_BOX_MM = 8;

const MIN_MARK_W_FRAC = 0.018;
const MIN_MARK_H_FRAC = 0.012;

export function mmToPageNorm(mm, pageSizePt, axis = 'w') {
  const pt = (Number(mm) * 72) / 25.4;
  const page = Math.max(Number(pageSizePt) || (axis === 'w' ? 595 : 841), 1);
  return pt / page;
}

/**
 * 문항 region 좌상단에 채점 네모(번호 포함) 배치.
 * @param {object} region — x,y,w,h (정규화)
 * @param {number} [pageWidthPt]
 * @param {number} [pageHeightPt]
 * @returns {{ x: number, y: number, w: number, h: number } | null}
 */
export function computeMarkBoxFromRegion(region, pageWidthPt = 595, pageHeightPt = 841) {
  if (!region || region.isImageRegion || region.groupRole === 'passage') return null;
  const rx = Number(region.x) || 0;
  const ry = Number(region.y) || 0;
  const rw = Number(region.w) || 0;
  const rh = Number(region.h) || 0;
  if (rw <= 0 || rh <= 0) return null;

  let mw = mmToPageNorm(MARK_BOX_MM, pageWidthPt, 'w');
  let mh = mmToPageNorm(MARK_BOX_MM, pageHeightPt, 'h');
  mw = Math.max(mw, MIN_MARK_W_FRAC);
  mh = Math.max(mh, MIN_MARK_H_FRAC);
  mw = Math.min(mw, rw * 0.42, 0.12);
  mh = Math.min(mh, rh * 0.38, 0.09);

  let mx = rx;
  let my = ry;
  mx = Math.max(0, Math.min(mx, 1 - mw));
  my = Math.max(0, Math.min(my, 1 - mh));
  return { x: mx, y: my, w: mw, h: mh };
}

export function withMarkBox(region, pageWidthPt = 595, pageHeightPt = 841) {
  const markBox = computeMarkBoxFromRegion(region, pageWidthPt, pageHeightPt);
  if (!markBox) return region;
  return { ...region, markBox };
}

export function isGradeableRegion(region) {
  if (!region || region.isImageRegion) return false;
  if (region.groupRole === 'passage') return false;
  return region.problem_number != null && region.problem_number !== '';
}

function clampMarkBox(box) {
  if (!box || typeof box !== 'object') return null;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (![x, y, w, h].every((v) => Number.isFinite(v)) || w <= 0 || h <= 0) return null;
  const cw = Math.min(w, 1 - x);
  const ch = Math.min(h, 1 - y);
  if (cw <= 0 || ch <= 0) return null;
  return {
    x: Math.max(0, Math.min(x, 1)),
    y: Math.max(0, Math.min(y, 1)),
    w: cw,
    h: ch,
  };
}

/** 저장 레코드 region → markBox (저장값 우선, 없으면 region에서 계산) */
export function resolveMarkBox(region, pageWidthPt = 595, pageHeightPt = 841) {
  if (!isGradeableRegion(region)) return null;
  const saved = clampMarkBox(region.markBox);
  if (saved) return saved;
  return computeMarkBoxFromRegion(region, pageWidthPt, pageHeightPt);
}

/**
 * pdf-lib 페이지에 채점 네모 테두리 그리기 (모든 학생 동일 위치).
 * @param {import('pdf-lib').PDFPage} page
 * @param {number} pageWidthPt
 * @param {number} pageHeightPt
 * @param {object[]} regions
 * @param {import('pdf-lib').RGB} borderColor
 */
export function drawProblemMarkBoxesOnPdfPage(
  page,
  pageWidthPt,
  pageHeightPt,
  regions,
  borderColor,
  resolveWidthPt = pageWidthPt,
  resolveHeightPt = pageHeightPt,
) {
  if (!page || !regions?.length || !borderColor) return;
  const W = pageWidthPt;
  const H = pageHeightPt;
  for (const reg of regions) {
    const box = resolveMarkBox(reg, resolveWidthPt, resolveHeightPt);
    if (!box) continue;
    const x = box.x * W;
    const w = box.w * W;
    const h = box.h * H;
    const y = H - (box.y + box.h) * H;
    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      borderColor,
      borderWidth: 0.75,
      opacity: 1,
    });
  }
}

/** GET /api/regions 에서 pdf 파일명으로 레코드 찾기 */
export async function fetchRegionsRecordForPdf(pdfFileName) {
  const key = String(pdfFileName || '').trim();
  if (!key) return null;
  const res = await fetch('/api/regions');
  if (!res.ok) return null;
  const data = await res.json();
  const records = data.records || [];
  const byPdf = records.find((r) => String(r.pdf_name || '').trim() === key);
  if (byPdf) return byPdf;
  const stem = key.replace(/\.pdf$/i, '');
  return (
    records.find((r) => String(r.exam_name || '').trim() === stem) ||
    records.find((r) => String(r.exam_name || '').trim() === key) ||
    null
  );
}
