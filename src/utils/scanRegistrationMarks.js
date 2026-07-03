/**
 * 스캔 보정용 네 모서리 L자 마크 — ExamPdfStudentLabels 인쇄 · scan-organize 검출 공통 규격
 */
import { rgb } from 'pdf-lib';

export const SCAN_REGISTRATION_MARK = {
  version: 3,
  markerType: 'both', // 'l' | 'aruco' | 'both'
  insetMm: 4,
  armMm: 7,
  thicknessPt: 1.0,
  gray: 0.22,
  // ArUco: 스캔 보정용(검출). L자는 그대로, 패턴만 작게(정확도 유지·눈에 덜 띔).
  aruco: {
    dictionary: 'DICT_4X4_50',
    ids: { tl: 10, tr: 11, br: 12, bl: 13 },
    sizeMm: 7,
    borderMm: 0.0, // extra white padding around marker (in addition to PNG quiet zone)
  },
};

const MM_TO_PT = 72 / 25.4;

export function mmToPt(mm) {
  return (Number(mm) || 0) * MM_TO_PT;
}

/** L자 안쪽 꼭짓점 (정규화, 좌상단 원점·y 아래로 증가) */
export function registrationCornerPointsNorm(pageWidthPt, pageHeightPt, spec = SCAN_REGISTRATION_MARK) {
  const W = Math.max(Number(pageWidthPt) || 595, 1);
  const H = Math.max(Number(pageHeightPt) || 841, 1);
  const ix = mmToPt(spec.insetMm) / W;
  const iy = mmToPt(spec.insetMm) / H;
  return {
    tl: { x: ix, y: iy },
    tr: { x: 1 - ix, y: iy },
    bl: { x: ix, y: 1 - iy },
    br: { x: 1 - ix, y: 1 - iy },
  };
}

/**
 * pdf-lib 페이지에 네 모서리 L자(진한 회색) — 매 페이지 동일 위치
 * @param {import('pdf-lib').PDFPage} page
 */
export function drawRegistrationMarksOnPdfPage(page, pageWidthPt, pageHeightPt, spec = SCAN_REGISTRATION_MARK) {
  if (spec?.markerType === 'aruco') return;
  const W = Number(pageWidthPt) || page.getWidth();
  const H = Number(pageHeightPt) || page.getHeight();
  const inset = mmToPt(spec.insetMm);
  const arm = mmToPt(spec.armMm);
  const t = spec.thicknessPt;
  const color = rgb(spec.gray, spec.gray, spec.gray);

  const line = (x1, y1, x2, y2) => {
    page.drawLine({
      start: { x: x1, y: y1 },
      end: { x: x2, y: y2 },
      thickness: t,
      color,
    });
  };

  // 좌상 (PDF y: 위쪽이 큼)
  line(inset, H - inset, inset + arm, H - inset);
  line(inset, H - inset, inset, H - inset - arm);

  // 우상
  line(W - inset, H - inset, W - inset - arm, H - inset);
  line(W - inset, H - inset, W - inset, H - inset - arm);

  // 좌하
  line(inset, inset, inset + arm, inset);
  line(inset, inset, inset, inset + arm);

  // 우하
  line(W - inset, inset, W - inset - arm, inset);
  line(W - inset, inset, W - inset, inset + arm);
}

export function getDefaultRegistrationMarkSpec() {
  return { ...SCAN_REGISTRATION_MARK };
}

/** 저장된 구버전(옅은 선) 규격을 스캔 우선 기본값으로 올림 */
export function normalizeRegistrationMarkSpec(spec) {
  const base = getDefaultRegistrationMarkSpec();
  if (!spec || typeof spec !== 'object') return base;
  const v = Number(spec.version) || 1;
  if (v < base.version) {
    return {
      ...base,
      insetMm: Number(spec.insetMm) > 0 ? spec.insetMm : base.insetMm,
      armMm: Number(spec.armMm) > 0 ? spec.armMm : base.armMm,
    };
  }
  // merge nested aruco config safely
  const mergedAruco = { ...(base.aruco || {}), ...(spec.aruco || {}) };
  return { ...base, ...spec, aruco: mergedAruco };
}

/**
 * pdf-lib 페이지에 네 모서리 ArUco 마커(PNG) — 매 페이지 동일 위치.
 * - 좌표계: pdf-lib은 좌하단 원점 (y 위로 증가)
 * - 이미지는 `PDFDocument.embedPng()`로 미리 임베드된 객체를 넘긴다.
 *
 * @param {import('pdf-lib').PDFPage} page
 * @param {number} pageWidthPt
 * @param {number} pageHeightPt
 * @param {object} spec
 * @param {{tl:any,tr:any,br:any,bl:any}} embedded
 */
export function drawArucoMarkersOnPdfPage(page, pageWidthPt, pageHeightPt, spec, embedded) {
  if (!embedded) return;
  if (spec?.markerType === 'l') return;
  const W = Number(pageWidthPt) || page.getWidth();
  const H = Number(pageHeightPt) || page.getHeight();
  const inset = mmToPt(spec?.insetMm ?? SCAN_REGISTRATION_MARK.insetMm);
  const size = mmToPt(spec?.aruco?.sizeMm ?? SCAN_REGISTRATION_MARK.aruco.sizeMm);
  const border = mmToPt(spec?.aruco?.borderMm ?? 0);
  const s = Math.max(1, size + border * 2);

  const draw = (img, x, y) => {
    if (!img) return;
    page.drawImage(img, { x, y, width: s, height: s });
  };

  // TL / TR / BL / BR
  draw(embedded.tl, inset - border, H - inset - s + border);
  draw(embedded.tr, W - inset - s + border, H - inset - s + border);
  draw(embedded.bl, inset - border, inset - border);
  draw(embedded.br, W - inset - s + border, inset - border);
}
