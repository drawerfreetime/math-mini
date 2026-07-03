/**
 * PDFRegionSelector.js — 시험지 OCR용 문항 영역 수동 선택 도구 (교사 전용)
 *
 * 기능:
 *  1. pdf.js로 PDF 페이지를 캔버스에 렌더링
 *  2. 마우스 드래그로 문항 영역 선택 → PDF 텍스트로 왼쪽 위 문항 번호 자동 인식(실패 시 임시 번호)
 *  3. 박스 × 버튼으로 삭제 / 문항 번호 수정·OCR 인식 시 번호 오름차순 자동 정렬(삭제 시 번호 재부여 없음)
 *  4. 저장 → 백엔드 JSON 파일(backend/data/pdf_regions.json)에 누적
 *  5. (비활성) 저장 기록 기반 추천 영역 — ENABLE_SAVED_REGION_RECOMMENDATIONS 로 켤 수 있음
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { normalizeProblemsCircledMcAnswers } from '../utils/circledAnswer';
import {
  analyzePage,
  detectStructure,
  detectHasImage,
  imageBoxToRelativeRect,
} from '../utils/pdfRegionHeuristics';
import { resolveProblemType } from '../utils/problemTypeFromContent';
import { normalizeMatchingPayload } from '../utils/matchingItems';
import ProblemConfirmStep from './ProblemConfirmStep';
import {
  OCR_CONCURRENCY as PIPELINE_OCR_CONCURRENCY,
  ocrResultNeedsRetry,
  listQuestionOcrUnits,
  canOpenProblemConfirm,
  preparePageCache,
  buildCropPipelineData,
  cropEntryIndexByUnitKey,
  runOcrOnCropEntry,
  assembleFinalProblems,
  getOcrUnitKey,
} from '../utils/pdfRegionOcrPipeline';
import { cancelPdfRenderTask, getPdfJs } from '../utils/pdfjsSetup';
import { registrationCornerPointsNorm, SCAN_REGISTRATION_MARK } from '../utils/scanRegistrationMarks';
import {
  computeMarkBoxFromRegion,
  withMarkBox,
  isGradeableRegion,
} from '../utils/problemMarkBox';
import { curriculumSelectionComplete } from './CurriculumPickers';
import { findExamPaperLibraryEntry } from '../utils/pdfStorage';

/** 구조 유형 토글 순환 순서 (배지 클릭 시) */
const STRUCTURE_TYPE_CYCLE = [null, '표', '선잇기', '세로셈', '빈칸채우기', '기타'];

/** 구조 유형별 배지 표시 정보 */
const STRUCTURE_BADGE = {
  '표':          { icon: '📊', label: '표',       bg: '#dbeafe', fg: '#1e40af' },
  '선잇기':       { icon: '🔗', label: '선잇기',    bg: '#fef3c7', fg: '#92400e' },
  '세로셈':       { icon: '🔢', label: '세로셈',    bg: '#ede9fe', fg: '#5b21b6' },
  '빈칸채우기':   { icon: '🟨', label: '빈칸',      bg: '#fef9c3', fg: '#854d0e' },
  '기타':        { icon: '⚪', label: '기타',      bg: '#f1f5f9', fg: '#334155' },
};

const RENDER_SCALE = 3.0;           // 내부 렌더 해상도 (OCR 정확도 우선 — 작은 수식·첨자 보존)
const MIN_BOX_RATIO = 0.015;        // 최소 박스 크기 (페이지 대비 비율)
// Gemini RPM 한도(특히 무료 키)에 부딪히지 않도록 동시 OCR 호출 수 제한.
// 환경변수로 덮어쓸 수 있게 두되, 안전 기본값은 3 (30문항 시 약 10라운드 → 429 회피 우선).
const OCR_CONCURRENCY = (() => {
  const raw = Number(process.env.REACT_APP_OCR_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 10) return Math.floor(raw);
  return 1;
})();
/** false: 박스 그릴 때 Gemini classify 보강 끔 (휴리스틱·수동 토글만) */
const CLASSIFY_AI_ENABLED = process.env.REACT_APP_CLASSIFY_AI !== '0';
/** 동시 classify API 호출 수 (Gemini RPM 한도 — 429 나면 2로 낮추기) */
const CLASSIFY_CONCURRENCY = (() => {
  const raw = Number(process.env.REACT_APP_CLASSIFY_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 5) return Math.floor(raw);
  return 3;
})();
/** 분류 확인 화면에서 앞으로 미리 classify 할 문항 수 (0이면 prefetch 끔) */
const CLASSIFY_PREFETCH_AHEAD = (() => {
  const raw = Number(process.env.REACT_APP_CLASSIFY_PREFETCH_AHEAD);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 8) return Math.floor(raw);
  return 3;
})();
/** false: 추천 박스·안내 비표시(계산도 하지 않음). 보완 후 true 로 전환 가능 */
const ENABLE_SAVED_REGION_RECOMMENDATIONS = false;
const REC_THRESHOLD = 10;           // 추천 활성화 레코드 수 기준 (위 플래그 true 일 때만 사용)
const REC_PAGE_TOLERANCE = 0.15;    // 페이지 크기 유사도 허용 오차 (15%)

/**
 * 개발용: 스캔본 자동정리·채점 크롭에 쓸 문항 좌표만 저장.
 * NODE_ENV=development 또는 REACT_APP_DEV_REGION_COORD_SAVE=1
 */
const ENABLE_DEV_REGION_COORD_SAVE =
  process.env.NODE_ENV === 'development' || process.env.REACT_APP_DEV_REGION_COORD_SAVE === '1';

const DEV_AI_TOGGLE_KEY = 'prs_dev_ai_enabled';

/** 저장 기록·목록에 표시할 문항 수(보기·이미지 서브영역 제외) */
function countQuestionRegions(regions) {
  return (regions || []).filter(
    (r) => !r.isImageRegion && r.groupRole !== 'passage' && r.problem_number != null,
  ).length;
}

function buildScanOrganizeCoordinatesPayload(regions, meta) {
  /** 보기(passage) 포함 — 채점 크롭 시 보기 아래 문항 번호 줄을 찾기 위함 */
  const saveRegions = regions.filter(
    (r) => !r.isImageRegion && r.problem_number != null,
  );

  const pageW = Number(meta.pageInfo?.width) || 595;
  const pageH = Number(meta.pageInfo?.height) || 841;
  const corners = registrationCornerPointsNorm(pageW, pageH, SCAN_REGISTRATION_MARK);
  const ix = Number(corners?.tl?.x) || 0;
  const iy = Number(corners?.tl?.y) || 0;
  const lW = Math.max(1e-9, 1 - 2 * ix);
  const lH = Math.max(1e-9, 1 - 2 * iy);
  const toLFrame = (box) => {
    const x = Number(box?.x) || 0;
    const y = Number(box?.y) || 0;
    const w = Number(box?.w) || 0;
    const h = Number(box?.h) || 0;
    return {
      l_x: (x - ix) / lW,
      l_y: (y - iy) / lH,
      l_w: w / lW,
      l_h: h / lH,
      coord_frame: 'l_mark_v1',
      reg_spec: { ...SCAN_REGISTRATION_MARK },
    };
  };

  return {
    exam_name: (meta.examTitle || '').trim() || (meta.pdfFile?.name || '').replace(/\.pdf$/i, ''),
    pdf_name: meta.pdfFile?.name || '',
    grade: meta.selGrade || null,
    semester: meta.selSemester || null,
    unit: meta.selUnit || null,
    total_pages: meta.totalPages,
    page_width: meta.pageInfo?.width,
    page_height: meta.pageInfo?.height,
    registrationMark: { ...SCAN_REGISTRATION_MARK },
    regions: saveRegions.map((r) => {
      const markBox = shouldShowMarkBox(r, saveRegions)
        ? (r.markBox || computeMarkBoxFromRegion(r, pageW, pageH))
        : null;
      return {
        problem_number: r.problem_number,
        page: r.page,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        ...toLFrame(r),
        ...(markBox && { markBox }),
        ...(r.groupId != null && { groupId: r.groupId }),
        ...(r.groupRole && { groupRole: r.groupRole }),
      };
    }),
  };
}

/** 0~1 정규화 좌표로 현재 PDF 캔버스 일부를 PNG data URL로 캡처 (무손실 — OCR 정확도 우선) */
function cropNormalizedRectToDataUrl(canvas, nx, ny, nw, nh) {
  if (!canvas || nw <= 0 || nh <= 0) return Promise.resolve(null);
  const cx = Math.round(nx * canvas.width);
  const cy = Math.round(ny * canvas.height);
  const cw = Math.round(nw * canvas.width);
  const ch = Math.round(nh * canvas.height);
  const cropC = document.createElement('canvas');
  cropC.width = Math.max(cw, 1);
  cropC.height = Math.max(ch, 1);
  cropC.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
  return new Promise((resolve) => {
    cropC.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.readAsDataURL(blob);
      },
      'image/png'
    );
  });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

/**
 * Promise.allSettled 와 같은 의미(순서 보존, 개별 실패 무관)지만
 * 동시에 in-flight 가 최대 `limit` 개를 넘지 않도록 제한한다.
 *
 * 사용 이유: 30문항을 한 번에 fetch 하면 Gemini RPM(특히 무료 키)에 걸려
 * 일괄 429 가 나고, 모델 폴백·재시도도 동시에 폭주해서 오히려 더 느려진다.
 * 워커 풀 패턴으로 빈 슬롯이 생길 때 다음 아이템을 즉시 집어넣어
 * 사용성 손해 없이 평균 RPS 만 낮춘다.
 *
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} asyncFn
 * @returns {Promise<Array<{status:'fulfilled', value:R}|{status:'rejected', reason:any}>>}
 */
async function runWithConcurrency(items, limit, asyncFn) {
  const total = items.length;
  const results = new Array(total);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit | 0 || 1, total));
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      try {
        const value = await asyncFn(items[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ─────────────────────────────────────────────
// pdf.js 텍스트 추출로 문항 번호 감지
// 왼쪽 위 굵은 숫자(1~50) 탐색
// ─────────────────────────────────────────────
/** pdf.js 텍스트 아이템 → 뷰포트(캔버스) 좌표 (행렬 곱, 회전·스큐 대응) */
function textItemToViewportXY(item, viewport) {
  const lib = getPdfjsLib();
  const tm = item.transform;
  if (lib?.Util?.transform) {
    const m = lib.Util.transform(viewport.transform, tm);
    return { cx: m[4], cy: m[5] };
  }
  const [va, vb, vc, vd, ve, vf] = viewport.transform;
  const pdfX = tm[4];
  const pdfY = tm[5];
  return {
    cx: va * pdfX + vc * pdfY + ve,
    cy: vb * pdfX + vd * pdfY + vf,
  };
}

function parseLeadingProblemNumber(str) {
  const t = String(str || '').trim();
  if (!t) return null;
  const patterns = [
    /^(\d{1,2})\s*[.)）\]}:：、]/,
    /^(\d{1,2})\s*$/,
    /^(\d{1,2})\b/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num >= 1 && num <= 50) return num;
    }
  }
  return null;
}

/**
 * 묶음 라벨 감지: [1~2], (1-3), 1~2, 1-3 등
 * @returns {{ label: string, start: number, end: number, count: number } | null}
 */
function parseGroupRangeLabel(str) {
  const t = String(str || '').trim();
  if (!t) return null;
  // 괄호/대괄호/전각 포함, 구분자는 ~ 또는 - 계열(하이픈/엔대시/엠대시)
  const m = t.match(/[[(（【]?\s*(\d{1,2})\s*(?:~|－|–|—|-|〜)\s*(\d{1,2})\s*[\])）】]?\s*$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 1 || b < 1 || a > 50 || b > 50) return null;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  const count = end - start + 1;
  if (count < 2 || count > 5) return null;
  return { label: `${start}~${end}`, start, end, count };
}

/** 좌상단 ※·[보기]·〈보기〉 등 공통 보기(지문) 표기 */
function isPassageMarkText(str) {
  const t = String(str || '').trim();
  if (!t) return false;
  if (t === '※' || t.startsWith('※')) return true;
  if (/^\[?\s*보기\s*\]?$/.test(t)) return true;
  if (/^〈\s*보기\s*〉$/.test(t)) return true;
  return false;
}

/** 영역 전체 텍스트에서 (8~10) 등 묶음 범위 라벨 탐색 */
async function detectRangeLabelInRegion(page, viewport, rx, ry, rw, rh) {
  try {
    const textContent = await page.getTextContent();
    const vw = viewport.width;
    const vh = viewport.height;
    const x1 = rx * vw;
    const y1 = ry * vh;
    const x2 = (rx + rw) * vw;
    const y2 = (ry + rh) * vh;

    const items = [];
    for (const item of textContent.items) {
      if (!item.str?.trim()) continue;
      const { cx, cy } = textItemToViewportXY(item, viewport);
      if (cx < x1 || cx > x2 || cy < y1 || cy > y2) continue;
      items.push(item.str.trim());
    }
    for (const str of items) {
      const grp = parseGroupRangeLabel(str);
      if (grp) return grp;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 보기 캡처(dataUrl) + 문항 캡처(dataUrl)들을 세로로 붙여 1장의 dataUrl로 만든다.
 * @param {string|null} passageDataUrl
 * @param {string[]} questionDataUrls
 * @returns {Promise<string|null>}
 */
async function stackDataUrlsToSingle(passageDataUrl, questionDataUrls) {
  const urls = [passageDataUrl, ...(questionDataUrls || [])].filter(Boolean);
  if (!urls.length) return null;
  const imgs = await Promise.all(urls.map((u) => new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = u;
  })));
  const ok = imgs.filter(Boolean);
  if (!ok.length) return null;
  const widths = ok.map((im) => im.naturalWidth || im.width || 1);
  const heights = ok.map((im) => im.naturalHeight || im.height || 1);
  const W = Math.max(...widths);
  const gap = 10;
  const H = heights.reduce((s, h) => s + h, 0) + gap * Math.max(0, ok.length - 1);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  let y = 0;
  for (let i = 0; i < ok.length; i++) {
    const im = ok[i];
    const iw = im.naturalWidth || im.width || 1;
    const ih = im.naturalHeight || im.height || 1;
    // 좌측 정렬
    ctx.drawImage(im, 0, y, iw, ih);
    y += ih + (i < ok.length - 1 ? gap : 0);
  }
  return c.toDataURL('image/jpeg', 0.9);
}

/** 문항 영역이 아닌 보기(passage)는 제외하고, 비어 있지 않은 번호 중 최댓값+1 */
function nextProvisionalProblemNumber(prevList) {
  let m = 0;
  for (const r of prevList) {
    if (r.isImageRegion) continue;
    if (r.groupRole === 'passage') continue;
    const n = problemBaseInt(r.problem_number);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m + 1;
}

function sortRegionsTopToBottom(regs) {
  return [...regs].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 1e-4) return a.y - b.y;
    return a.x - b.x;
  });
}

/** UI·파일명용 문항 표기 (10-1 등) */
function problemDisplayLabel(v) {
  return String(v ?? '').trim() || '?';
}

/** 자동 병합 키용: 10-1 → 10, "10" → 10 */
function problemBaseInt(v) {
  const s = problemDisplayLabel(v);
  const m = s.match(/^(\d{1,2})(?:-\d{1,3})?$/);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(s.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : NaN;
}

/** 번호 순 정렬: 같은 기본 번호면 10-1 → 10-2 (접미 오름차순), 무보조는 0 */
function problemSortTuple(v) {
  const base = problemBaseInt(v);
  const s = problemDisplayLabel(v);
  const m = s.match(/^(\d{1,2})-(\d{1,3})$/);
  const sub = m ? parseInt(m[2], 10) : 0;
  const b = Number.isFinite(base) && base >= 1 ? base : 999;
  return [b, sub];
}

function problemKeysEqual(a, b) {
  return problemDisplayLabel(a) === problemDisplayLabel(b);
}

/** 입력란 blur 값 → problem_number (10-1 또는 정수) */
function parseProblemKeyInput(raw) {
  const t = String(raw || '').trim();
  if (/^\d{1,2}-\d{1,3}$/.test(t)) return t;
  const n = parseInt(t.replace(/\D/g, ''), 10);
  return !Number.isNaN(n) && n >= 1 ? n : null;
}

/** 세로 병합 체인에서 아래쪽 조각 — 채점 네모(markBox)는 위쪽 조각에만 */
function isVmMergeLowerPart(region, allRegions) {
  if (!region || region.isImageRegion || region.groupId != null) return false;
  return allRegions.some((r) => !r.isImageRegion && r.vmMergeAfter === region.id);
}

function shouldShowMarkBox(region, allRegions) {
  return isGradeableRegion(region) && !isVmMergeLowerPart(region, allRegions);
}

function buildFullRegionsSavePayload(regions, meta) {
  if (!meta?.pdfFile || !regions?.length) return null;
  const pageW = Number(meta.pageInfo?.width) || 595;
  const pageH = Number(meta.pageInfo?.height) || 841;
  const corners = registrationCornerPointsNorm(pageW, pageH, SCAN_REGISTRATION_MARK);
  const ix = Number(corners?.tl?.x) || 0;
  const iy = Number(corners?.tl?.y) || 0;
  const lW = Math.max(1e-9, 1 - 2 * ix);
  const lH = Math.max(1e-9, 1 - 2 * iy);
  const toLFrame = (box) => {
    const x = Number(box?.x) || 0;
    const y = Number(box?.y) || 0;
    const w = Number(box?.w) || 0;
    const h = Number(box?.h) || 0;
    return {
      l_x: (x - ix) / lW,
      l_y: (y - iy) / lH,
      l_w: w / lW,
      l_h: h / lH,
      coord_frame: 'l_mark_v1',
      reg_spec: { ...SCAN_REGISTRATION_MARK },
    };
  };

  return {
    exam_name: (meta.examTitle || '').trim() || meta.pdfFile.name.replace(/\.pdf$/i, ''),
    grade: meta.selGrade || null,
    semester: meta.selSemester || null,
    unit: meta.selUnit || null,
    pdf_name: meta.pdfFile.name,
    total_pages: meta.totalPages,
    page_width: pageW,
    page_height: pageH,
    registrationMark: { ...SCAN_REGISTRATION_MARK },
    regions: regions.map((r) => {
      const markBox = shouldShowMarkBox(r, regions)
        ? (r.markBox || computeMarkBoxFromRegion(r, pageW, pageH))
        : null;
      return {
        problem_number: r.problem_number,
        page: r.page,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        ...toLFrame(r),
        ...(markBox && { markBox }),
        ...(r.vmMergeAfter != null && r.vmMergeAfter !== '' && { vmMergeAfter: r.vmMergeAfter }),
        ...(r.groupId != null && { groupId: r.groupId, groupRole: r.groupRole, groupOrder: r.groupOrder }),
        ...(r.isImageRegion && { isImageRegion: true, parentId: r.parentId, imageIdx: r.imageIdx }),
        ...(r.problemType && {
          problemType: r.problemType,
          problemTypeSource: r.problemTypeSource || 'heuristic',
          problemTypeConfidence: r.problemTypeConfidence ?? 0,
        }),
        ...(r.hasImage && {
          hasImage: true,
          hasImageSource: r.hasImageSource || 'heuristic',
        }),
      };
    }),
    saved_at: new Date().toISOString(),
  };
}

async function postRegionsPayload(payload) {
  const res = await fetch('/api/regions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.detail || data.error || `서버 오류 (${res.status})`);
  }
  return data;
}

function regionWithoutMarkBox(region) {
  if (!region?.markBox) return region;
  const { markBox, ...rest } = region;
  return rest;
}

function findStandaloneConflictRegion(regArr, regionId, newKey) {
  return regArr.find(
    (r) =>
      r.id !== regionId &&
      !r.isImageRegion &&
      r.groupRole !== 'passage' &&
      r.groupId == null &&
      problemKeysEqual(r.problem_number, newKey),
  ) || null;
}

function areAlreadyVmMerged(a, b, regArr) {
  if (!a || !b) return false;
  if (a.vmMergeAfter === b.id || b.vmMergeAfter === a.id) return true;
  const standalone = regArr.filter((r) => !r.isImageRegion && r.groupId == null);
  const idxA = standalone.findIndex((r) => r.id === a.id);
  const idxB = standalone.findIndex((r) => r.id === b.id);
  if (idxA < 0 || idxB < 0 || Math.abs(idxA - idxB) !== 1) return false;
  const upper = idxA < idxB ? a : b;
  const lower = idxA < idxB ? b : a;
  return upper.vmMergeAfter === lower.id;
}

/** vmMerge 연결 쌍 수집 (정렬 전 상태) */
function collectVmMergePairs(regArr) {
  const standalone = regArr.filter((r) => !r.isImageRegion && r.groupId == null);
  const pairs = [];
  const seen = new Set();
  for (const p of standalone) {
    if (!p.vmMergeAfter) continue;
    const b = p.vmMergeAfter;
    const key = p.id < b ? `${p.id}:${b}` : `${b}:${p.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([p.id, b]);
  }
  return pairs;
}

/** 정렬 후 목록에서 위→아래로 vmMergeAfter 복구 */
function repairVmMergePairsAfterRenumber(regArr, pairs) {
  const standalone = regArr.filter((r) => !r.isImageRegion && r.groupId == null);
  const orderIds = standalone.map((p) => p.id);
  const io = (id) => orderIds.indexOf(id);
  let next = regArr.map((r) => ({ ...r, vmMergeAfter: null }));
  for (const [a, b] of pairs) {
    const ia = io(a);
    const ib = io(b);
    if (ia < 0 || ib < 0) continue;
    const upper = ia < ib ? a : b;
    const lower = ia < ib ? b : a;
    const ui = next.findIndex((x) => x.id === upper);
    if (ui >= 0) next[ui] = { ...next[ui], vmMergeAfter: lower };
  }
  return sanitizeVmMergeChains(next);
}

/** 입력된 problem_number는 유지하고, 목록만 번호 오름차순으로 재배열 */
function sortRegionsStableByProblemNumber(prev) {
  const mergePairs = collectVmMergePairs(prev);

  const groupIdsOrdered = [];
  const seenGid = new Set();
  for (const r of prev) {
    if (r.groupId != null && !seenGid.has(r.groupId)) {
      seenGid.add(r.groupId);
      groupIdsOrdered.push(r.groupId);
    }
  }

  const blocks = [];

  const standaloneParents = prev.filter((r) => !r.isImageRegion && r.groupId == null);
  for (const p of standaloneParents) {
    const imgs = prev
      .filter((ir) => ir.isImageRegion && ir.parentId === p.id)
      .sort((a, b) => (a.imageIdx || 0) - (b.imageIdx || 0));
    const sortTuple = problemSortTuple(p.problem_number);
    blocks.push({ sortTuple, tie: prev.indexOf(p), items: [p, ...imgs] });
  }

  for (const gid of groupIdsOrdered) {
    const grpRegions = prev.filter((x) => x.groupId === gid);
    const passage = grpRegions.filter((x) => x.groupRole === 'passage');
    const questions = grpRegions
      .filter((x) => x.groupRole === 'question')
      .sort((a, b) => (a.groupOrder || 0) - (b.groupOrder || 0));
    const orderedGrp = [...passage, ...questions];
    const items = [];
    for (const r of orderedGrp) {
      items.push(r);
      const imgs = prev
        .filter((ir) => ir.isImageRegion && ir.parentId === r.id)
        .sort((a, b) => (a.imageIdx || 0) - (b.imageIdx || 0));
      items.push(...imgs);
    }
    let sortTuple = [999, 999];
    for (const q of questions) {
      const t = problemSortTuple(q.problem_number);
      if (t[0] < sortTuple[0] || (t[0] === sortTuple[0] && t[1] < sortTuple[1])) sortTuple = t;
    }
    if (sortTuple[0] === 999) sortTuple = [0, 0];
    blocks.push({ sortTuple, tie: prev.indexOf(grpRegions[0]), items });
  }

  blocks.sort((a, b) => {
    const [ba, sa] = a.sortTuple;
    const [bb, sb] = b.sortTuple;
    if (ba !== bb) return ba - bb;
    if (sa !== sb) return sa - sb;
    return a.tie - b.tie;
  });

  const flat = blocks.flatMap((b) => b.items);
  return repairVmMergePairsAfterRenumber(flat, mergePairs);
}

/** 연속 두 독립 문항이 세로 병합 제안 가능: 동일 표기(10 두 개) 또는 10-1·10-2 형 연속 */
function canSuggestVerticalMerge(upper, lower) {
  const su = problemDisplayLabel(upper.problem_number);
  const sl = problemDisplayLabel(lower.problem_number);
  if (!su || !sl || su === '?' || sl === '?') return false;
  if (su === sl) return true;
  const hu = su.match(/^(\d{1,2})-(\d{1,3})$/);
  const hl = sl.match(/^(\d{1,2})-(\d{1,3})$/);
  return !!(hu && hl && hu[1] === hl[1]);
}

/** 병합 카드 내 좌측 라벨 (동일 번호면 상/하 구분) */
function mergeRowSideLabel(r, slot, peer) {
  const self = problemDisplayLabel(r.problem_number);
  const other = problemDisplayLabel(peer.problem_number);
  if (self !== other) return self;
  return slot === 'upper' ? `${self} · 상` : `${self} · 하`;
}

function getStandaloneBlockInOrder(prev, parentId) {
  const p = prev.find((r) => r.id === parentId);
  if (!p) return [];
  const imgs = prev
    .filter((r) => r.isImageRegion && r.parentId === parentId)
    .sort((a, b) => (a.imageIdx || 0) - (b.imageIdx || 0));
  return [p, ...imgs];
}

/** 목록 순서상 바로 아래와 수동 연결(vmMergeAfter)된 세로 병합 체인 */
function collectManualMergeChains(ordered) {
  const consumed = new Set();
  const chains = [];
  for (let i = 0; i < ordered.length; i++) {
    if (consumed.has(ordered[i].id)) continue;
    // 묶음(groupId) 영역(보기/소문항)은 세로 병합 대상에서 제외
    // (병합이 걸리면 ordered 인덱스와 API 결과 매핑이 어긋나 묶음이 깨질 수 있음)
    if (ordered[i]?.groupId != null) continue;
    if (ordered[i + 1]?.groupId != null) continue;
    if (ordered[i + 1] && ordered[i].vmMergeAfter === ordered[i + 1].id) {
      const chain = [ordered[i]];
      let j = i;
      while (ordered[j + 1] && ordered[j].vmMergeAfter === ordered[j + 1].id) {
        j += 1;
        chain.push(ordered[j]);
      }
      chain.forEach((r) => consumed.add(r.id));
      chains.push(chain);
    }
  }
  return { chains, consumed };
}

/**
 * ordered: 이미지 제외 영역, regions 배열 순서(사용자 드래그 순) 유지.
 * 1) 수동 vmMergeAfter 체인 → 세로 병합
 * 2) 나머지 중 같은 페이지·같은 문항번호(묶음 아님) → 자동 세로 병합
 */
function buildApiUnits(ordered) {
  const { chains, consumed } = collectManualMergeChains(ordered);
  const manualUnits = chains.map((regions) => ({ kind: 'merged', regions }));

  const remaining = ordered.filter((r) => !consumed.has(r.id));

  const mergeKey = (r) => {
    if (r.groupId != null) return null;
    const n = problemBaseInt(r.problem_number);
    if (!Number.isFinite(n) || n < 1) return null;
    return `${r.page}:${n}`;
  };
  const byKey = new Map();
  for (const r of remaining) {
    const k = mergeKey(r);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const mergedKeys = new Set(
    [...byKey.entries()].filter(([, arr]) => arr.length >= 2).map(([k]) => k)
  );
  const autoKeyConsumed = new Set();
  const autoUnits = [];
  for (const r of remaining) {
    const k = mergeKey(r);
    if (!k) {
      autoUnits.push({ kind: 'single', regions: [r] });
      continue;
    }
    if (mergedKeys.has(k)) {
      if (autoKeyConsumed.has(k)) continue;
      autoKeyConsumed.add(k);
      autoUnits.push({ kind: 'merged', regions: sortRegionsTopToBottom(byKey.get(k)) });
    } else {
      autoUnits.push({ kind: 'single', regions: [r] });
    }
  }

  const idToUnit = new Map();
  for (const u of manualUnits) {
    u.regions.forEach((reg) => idToUnit.set(reg.id, u));
  }
  for (const u of autoUnits) {
    for (const reg of u.regions) {
      if (!idToUnit.has(reg.id)) idToUnit.set(reg.id, u);
    }
  }

  const out = [];
  const seenUnit = new Set();
  for (const r of ordered) {
    const u = idToUnit.get(r.id);
    if (!u || seenUnit.has(u)) continue;
    seenUnit.add(u);
    out.push(u);
  }
  return out;
}

/** vmMergeAfter는 '바로 아래 독립 문항'으로만 유효 — 목록 순서가 바뀌면 잘못된 링크 제거 */
function sanitizeVmMergeChains(regArr) {
  const parentsOnly = regArr.filter((r) => !r.isImageRegion && r.groupId == null);
  const nextStandaloneId = (rid) => {
    const i = parentsOnly.findIndex((p) => p.id === rid);
    return i >= 0 ? parentsOnly[i + 1]?.id ?? null : null;
  };
  return regArr.map((r) => {
    if (!r.vmMergeAfter) return r;
    if (r.vmMergeAfter !== nextStandaloneId(r.id)) return { ...r, vmMergeAfter: null };
    return r;
  });
}

/** 동일 문항 세로 이어붙이기 → JPEG Blob / dataUrl / 부모별 세로 오프셋(px). regions 순서 = 위→아래. */
async function verticalMergeRegionsToPng(regions, pageCache, gapPx = 6) {
  if (!regions.length) throw new Error('병합할 영역이 없습니다.');
  const crops = regions.map((r) => {
    const pc = pageCache[r.page];
    if (!pc) throw new Error(`페이지 ${r.page} 캔버스가 없습니다.`);
    const { canvas: pgCanvas, viewport: pgVp } = pc;
    const cx = Math.round(r.x * pgVp.width);
    const cy = Math.round(r.y * pgVp.height);
    const cw = Math.max(Math.round(r.w * pgVp.width), 1);
    const ch = Math.max(Math.round(r.h * pgVp.height), 1);
    return { r, pgCanvas, cx, cy, cw, ch };
  });
  const maxW = Math.max(...crops.map((c) => c.cw));
  const totalH = crops.reduce((s, c) => s + c.ch, 0) + gapPx * Math.max(0, crops.length - 1);
  const out = document.createElement('canvas');
  out.width = maxW;
  out.height = Math.max(totalH, 1);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, maxW, out.height);
  const yOffsetByRegionId = {};
  let yOff = 0;
  for (let i = 0; i < crops.length; i++) {
    const { r, pgCanvas, cx, cy, cw, ch } = crops[i];
    yOffsetByRegionId[r.id] = yOff;
    ctx.drawImage(pgCanvas, cx, cy, cw, ch, 0, yOff, cw, ch);
    yOff += ch + (i < crops.length - 1 ? gapPx : 0);
  }
  const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
  const cropDataUrl = await new Promise((res) => {
    const reader = new FileReader();
    reader.onload = (e) => res(e.target.result);
    reader.readAsDataURL(blob);
  });
  return { blob, cropDataUrl, yOffsetByRegionId, primaryRegion: regions[0] };
}

const DETECT_KIND_PRIORITY = { passage: 0, group: 1, number: 2 };

/**
 * 좌상단 텍스트에서 보기(※·[보기])·묶음 라벨(1~3)·단일 번호 감지
 * @returns {Promise<
 *   { kind: 'passage', label: string, count: number|null }
 *   | { kind: 'group', label: string, count: number }
 *   | { kind: 'number', number: number }
 *   | null
 * >}
 */
async function detectTopLeftKeyFromRegion(page, viewport, rx, ry, rw, rh) {
  try {
    const textContent = await page.getTextContent();
    const vw = viewport.width;
    const vh = viewport.height;

    // 탐색 범위: 맨 왼쪽 위 — 영역의 좌측 28%, 상단 36%
    const x1 = rx * vw;
    const y1 = ry * vh;
    const x2 = (rx + rw * 0.28) * vw;
    const y2 = (ry + rh * 0.36) * vh;

    const candidates = [];
    for (const item of textContent.items) {
      if (!item.str?.trim()) continue;
      const { cx, cy } = textItemToViewportXY(item, viewport);
      if (cx < x1 || cx > x2 || cy < y1 || cy > y2) continue;

      const str = item.str.trim();
      const distToCorner = (cx - x1) + (cy - y1);

      if (isPassageMarkText(str)) {
        candidates.push({ kind: 'passage', dist: distToCorner });
        continue;
      }
      const grp = parseGroupRangeLabel(str);
      if (grp) {
        candidates.push({ kind: 'group', label: grp.label, count: grp.count, dist: distToCorner });
        continue;
      }
      const num = parseLeadingProblemNumber(str);
      if (num != null) {
        candidates.push({ kind: 'number', number: num, dist: distToCorner });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const pd = (DETECT_KIND_PRIORITY[a.kind] ?? 9) - (DETECT_KIND_PRIORITY[b.kind] ?? 9);
      if (pd !== 0) return pd;
      return a.dist - b.dist;
    });
    const c = candidates[0];
    if (c.kind === 'passage') {
      const range = await detectRangeLabelInRegion(page, viewport, rx, ry, rw, rh);
      return {
        kind: 'passage',
        label: range?.label || '보기',
        count: range?.count ?? null,
      };
    }
    if (c.kind === 'group') return { kind: 'group', label: c.label, count: c.count };
    return { kind: 'number', number: c.number };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// 유틸: pdf.js 로드 확인
// ─────────────────────────────────────────────
function getPdfjsLib() {
  return getPdfJs();
}

// ─────────────────────────────────────────────
// PDF 업로드 드롭존
// ─────────────────────────────────────────────
function PdfDropZone({ onFile }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const accept = (file) => {
    if (file?.type === 'application/pdf') onFile(file);
  };

  return (
    <div
      className={`prs-dropzone ${dragging ? 'prs-dropzone-active' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); accept(e.dataTransfer.files[0]); }}
      onClick={() => inputRef.current?.click()}
    >
      <input ref={inputRef} type="file" accept=".pdf" style={{ display: 'none' }}
        onChange={e => accept(e.target.files[0])} />
      <div className="prs-dropzone-icon">📄</div>
      <p className="prs-dropzone-title">
        {dragging ? '여기에 놓으세요!' : 'PDF 파일을 드래그하거나 클릭해서 선택'}
      </p>
      <p className="prs-dropzone-sub">영역을 직접 선택할 PDF를 업로드하세요</p>
    </div>
  );
}

// ─────────────────────────────────────────────
// 메인 컴포넌트
// ─────────────────────────────────────────────
export default function PDFRegionSelector() {
  const navigate = useNavigate();
  const location = useLocation();

  // ── PDF 상태 ──
  // navigation state로 전달된 파일이 있으면 바로 사용 (PDFExtractor에서 등록된 시험지 선택 시)
  const [pdfFile,     setPdfFile]     = useState(() => location.state?.pdfFile ?? null);

  /** 같은 화면에서 AI 검수를 중지한 직후에만 '이전 검수 유지' 모달을 띄우기 위한 플래그 (PDF 교체·나갔다 오면 초기화) */
  const offerResumeChoiceAfterAiStopRef = useRef(false);
  /** 새 runAiReviewExtract가 이전 실행을 abort할 때 AbortError를 '사용자 중지'로 오인하지 않도록 */
  const aiReviewRunGenRef = useRef(0);
  /** AI 검수·검수 시작 버튼 중복 클릭 방지 */
  const reviewActionLockRef = useRef(false);
  useEffect(() => {
    offerResumeChoiceAfterAiStopRef.current = false;
  }, [pdfFile]);
  const [pdfDoc,      setPdfDoc]      = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages,  setTotalPages]  = useState(0);
  const [pageInfo,    setPageInfo]    = useState({ width: 0, height: 0 }); // pdf 포인트 단위

  // ── 영역 상태 (모든 페이지 통합, 각 항목에 page 필드 포함) ──
  const [regions,  setRegions]  = useState([]); // 확정 영역
  const [recs,     setRecs]     = useState([]); // 추천 영역 (현재 페이지)

  // ── 드래그 상태 ──
  const [drawing,  setDrawing]  = useState(false);
  const [startPt,  setStartPt]  = useState({ x: 0, y: 0 });
  const [curPt,    setCurPt]    = useState({ x: 0, y: 0 });

  // ── 히스토리 & UI ──
  const [history,     setHistory]     = useState([]);
  const [saving,      setSaving]      = useState(false);
  const [saveMsg,     setSaveMsg]     = useState('');
  const [coordSaving, setCoordSaving] = useState(false);
  const [coordSaveMsg, setCoordSaveMsg] = useState('');
  const [coordJsonPreview, setCoordJsonPreview] = useState('');
  const [error,       setError]       = useState('');
  const [extracting,  setExtracting]  = useState(false);
  const [extractMsg,  setExtractMsg]  = useState('');
  const [reviewChoiceOpen, setReviewChoiceOpen] = useState(false);
  /** AI 검수가 살아있는 동안 생성된 AbortController (중지 버튼) */
  const reviewAbortRef = useRef(null);
  const [examTitle,   setExamTitle]   = useState('');
  const [selGrade,    setSelGrade]    = useState('');
  const [selSemester, setSelSemester] = useState('');
  const [selUnit,     setSelUnit]     = useState('');
  const [loadMsg,     setLoadMsg]     = useState('');

  // ── 묶음 선택 모드 ──
  const [groupMode,    setGroupMode]    = useState(false);  // 활성 여부
  const [groupQCount,  setGroupQCount]  = useState(2);      // 묶음 내 문항 수
  const [groupStep,    setGroupStep]    = useState(0);       // 현재 몇 번째 선택인지 (0=대기, 1=보기 선택됨, ...)
  const groupIdRef = useRef(0);  // 그룹마다 고유 ID

  // ── 자동 묶음 감지 모달(예/아니오) ──
  const [autoGroupPrompt, setAutoGroupPrompt] = useState(
    /** @type {null | { regionId: number; label: string; count: number|null; kind: 'passage'|'group'; x: number; y: number; w: number; h: number; page: number }} */ (null)
  );

  // ── 번호 중복 입력 시 같은 문항 합치기 확인 ──
  const [duplicateNumberPrompt, setDuplicateNumberPrompt] = useState(
    /** @type {null | { regionId: number; conflictId: number; newNumber: number|string; prevNumber: number|string; x: number; y: number; w: number; h: number; page: number; onRevert?: () => void }} */ (null)
  );

  // ── 이미지(도형) 자동 감지 모달 — [보기] 묶음과 동일하게 문항 박스 위에 표시 ──
  const [autoImagePrompt, setAutoImagePrompt] = useState(
    /** @type {null | { regionId: number; x: number; y: number; w: number; h: number; page: number }} */ (null)
  );
  /** regionId — 이미지 확인 모달에 예/아니오를 한 번 응답함 */
  const imagePromptAnsweredRef = useRef(new Set());

  // ── 영역 삽입 모드: 'text'(기본, AI 변환) | 'image'(전역 이미지 모드, 호환용) ──
  // 새 흐름에서는 보통 'text' 만 사용하고, "이미지 영역 그리기"는
  // imageTargetParentId(특정 부모 한정) 로 동작한다.
  const [insertMode, setInsertMode] = useState('text');

  /**
   * 분류 확인 패널에서 "이미지 영역 그리기" 를 눌렀을 때 설정.
   * 값이 있으면 다음 드래그는 이 부모 문항의 이미지 sub-영역으로 들어간다.
   */
  const [imageTargetParentId, setImageTargetParentId] = useState(null);

  /** 'select' = 영역·번호 | 'confirm' = 문항 확인(스테퍼) */
  const [viewStep, setViewStep] = useState('select');
  const [confirmIndex, setConfirmIndex] = useState(0);
  const [confirmedKeys, setConfirmedKeys] = useState(() => new Set());
  const [ocrStatusByKey, setOcrStatusByKey] = useState({});
  const [previewUrlByKey, setPreviewUrlByKey] = useState({});
  const [finishingReview, setFinishingReview] = useState(false);
  const [pendingReturnToConfirm, setPendingReturnToConfirm] = useState(false);
  const returnToConfirmRef = useRef(/** @type {{ index: number } | null} */ (null));
  const ocrInFlightRef = useRef(new Map());
  /** 문항별 OCR — 연타 시 PIPELINE_OCR_CONCURRENCY 만큼만 in-flight (일괄 검수와 동일) */
  const ocrQueueRef = useRef([]);
  const ocrDrainRef = useRef(false);
  /** regionId → classify 큐에 넣었거나 API 진행 중 (중복 enqueue 방지) */
  const classifyPendingRef = useRef(new Set());
  const classifyQueueRef = useRef([]);
  const classifyDrainRef = useRef(false);
  /** analyzePage 완료 콜백 — 훅 선언 순서상 ref로 호출 */
  const retryHeuristicsForPageRef = useRef(/** @type {(pageNum: number) => void} */ ((_) => {}));
  const hydratePageRegionCropsRef = useRef(/** @type {(pageNum: number) => void} */ ((_) => {}));

  /**
   * 개발 단계: "영역 좌표 저장"만 할 때는 API키 없이 쓰기 위해 AI 분류를 끌 수 있게 한다.
   * (운영 환경에서는 환경변수(REACT_APP_CLASSIFY_AI)로만 제어)
   */
  const [devAiEnabled, setDevAiEnabled] = useState(() => {
    if (!ENABLE_DEV_REGION_COORD_SAVE) return true;
    try {
      const raw = localStorage.getItem(DEV_AI_TOGGLE_KEY);
      if (raw == null) return false; // 개발 기본값: OFF
      return raw === '1' || raw === 'true';
    } catch {
      return false;
    }
  });
  const classifyAiEnabled = CLASSIFY_AI_ENABLED && (!ENABLE_DEV_REGION_COORD_SAVE || devAiEnabled);
  const ocrPipelineStoreRef = useRef({
    pageCache: null,
    cropData: null,
    imgSubCropMap: null,
    ordered: null,
    apiUnits: null,
    apiResults: null,
  });

  const regionsRef = useRef(regions);
  regionsRef.current = regions;

  const canvasRef    = useRef(null);
  const overlayRef   = useRef(null);
  const renderTaskRef = useRef(null);
  const pdfPageRef   = useRef(null);   // 현재 렌더된 pdf.js Page 객체
  const viewportRef  = useRef(null);   // 현재 렌더된 pdf.js Viewport 객체

  /**
   * 페이지별 휴리스틱 메타 캐시: pageNum → PageMeta (analyzePage 결과)
   * 새 PDF 로드 시 비워진다. 같은 페이지에 N번 드래그해도 한 번만 분석한다.
   */
  const pageAnalysisRef = useRef({});

  // ── navigation state의 시험지 메타 정보로 분류·제목 자동 채우기 (1회만) ──
  useEffect(() => {
    const meta = location.state?.entryMeta;
    if (!meta) return;
    if (meta.grade)    setSelGrade(meta.grade);
    if (meta.semester) setSelSemester(meta.semester);
    if (meta.unit)     setSelUnit(meta.unit);
    // 시험지 업로드에 저장한 표시 이름(예: 3단원평가) — 커리큘럼 문자열로 덮어쓰지 않음
    const savedLabel = meta.label != null ? String(meta.label).trim() : '';
    if (savedLabel) setExamTitle(savedLabel);
    if (meta.id) {
      try {
        localStorage.setItem('unitTestExamPaperLibraryId', String(meta.id));
      } catch { /* ignore */ }
    }
    if (meta.sha256) {
      try {
        localStorage.setItem('unitTestExamPaperSha256', String(meta.sha256));
      } catch { /* ignore */ }
    }
    // 사용된 state를 소비해 새로고침 시 중복 적용 방지
    window.history.replaceState({ ...window.history.state, usr: { ...location.state, entryMeta: null } }, '');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 시험지 업로드·검수 draft에 저장된 분류를 화면에 복원 (불러오기로 비워지는 것 방지) ──
  useEffect(() => {
    if (curriculumSelectionComplete(selGrade, selSemester, selUnit)) return;

    let cancelled = false;
    const apply = (grade, semester, unit) => {
      if (cancelled || !curriculumSelectionComplete(grade, semester, unit)) return;
      setSelGrade((prev) => prev || grade);
      setSelSemester((prev) => prev || semester);
      setSelUnit((prev) => prev || unit);
    };

    try {
      const curRaw = localStorage.getItem('unitTestCurriculum');
      if (curRaw) {
        const meta = JSON.parse(curRaw);
        apply(meta.grade, meta.semester, meta.unit);
        if (curriculumSelectionComplete(meta.grade, meta.semester, meta.unit)) return;
      }
    } catch { /* ignore */ }

    (async () => {
      try {
        let libId = '';
        let sha256 = '';
        try {
          libId = localStorage.getItem('unitTestExamPaperLibraryId') || '';
          sha256 = localStorage.getItem('unitTestExamPaperSha256') || '';
        } catch { /* ignore */ }
        const ent = await findExamPaperLibraryEntry({
          id: libId || undefined,
          sha256: sha256 || undefined,
          originalFileName: pdfFile?.name || undefined,
        });
        if (ent) apply(ent.grade, ent.semester, ent.unit);
      } catch { /* ignore */ }
    })();

    return () => { cancelled = true; };
  }, [selGrade, selSemester, selUnit, pdfFile]);

  // ── 커리큘럼 선택 → 제목 자동 제안 (비어 있을 때만, 사용자 입력은 유지) ──
  useEffect(() => {
    if (selGrade && selSemester && selUnit) {
      setExamTitle((prev) => {
        if (String(prev || '').trim()) return prev;
        return `${selGrade} ${selSemester} ${selUnit} 단원평가`;
      });
    }
  }, [selGrade, selSemester, selUnit]);

  const refreshHistoryFromServer = useCallback(async () => {
    try {
      const r = await fetch('/api/regions');
      const d = await r.json();
      setHistory(d.records || []);
    } catch {
      /* ignore */
    }
  }, []);

  // ── 히스토리 로드 ──
  useEffect(() => {
    refreshHistoryFromServer();
  }, [refreshHistoryFromServer]);

  // ── 로컬 임시저장: regions 변경 시 자동 저장 (캡처 포함, 용량 초과 시 좌표만 저장) ──
  useEffect(() => {
    if (regions.length === 0) return;
    const meta = {
      prs_draft_title: examTitle,
      prs_draft_grade: selGrade,
      prs_draft_semester: selSemester,
      prs_draft_unit: selUnit,
    };
    try {
      localStorage.setItem('prs_draft_regions', JSON.stringify(regions));
      Object.entries(meta).forEach(([k, v]) => localStorage.setItem(k, v));
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.code === 22) {
        try {
          const slim = regions.map(({ cropDataUrl, ...rest }) => rest);
          localStorage.setItem('prs_draft_regions', JSON.stringify(slim));
          Object.entries(meta).forEach(([k, v]) => localStorage.setItem(k, v));
        } catch {
          /* ignore */
        }
      }
    }
  }, [regions, examTitle, selGrade, selSemester, selUnit]);

  // ── 임시저장 복원 ──
  const [hasDraft, setHasDraft] = useState(false);
  useEffect(() => {
    const draft = localStorage.getItem('prs_draft_regions');
    if (draft) {
      try {
        const parsed = JSON.parse(draft);
        if (Array.isArray(parsed) && parsed.length > 0) setHasDraft(true);
      } catch {}
    }
  }, []);

  const restoreDraft = () => {
    try {
      const regions  = JSON.parse(localStorage.getItem('prs_draft_regions') || '[]');
      const title    = localStorage.getItem('prs_draft_title')    || '';
      const grade    = localStorage.getItem('prs_draft_grade')    || '';
      const semester = localStorage.getItem('prs_draft_semester') || '';
      const unit     = localStorage.getItem('prs_draft_unit')     || '';
      setRegions(regions);
      setExamTitle(title);
      setSelGrade((prev) => grade || prev);
      setSelSemester((prev) => semester || prev);
      setSelUnit((prev) => unit || prev);
      setHasDraft(false);
    } catch {}
  };

  const clearDraft = () => {
    ['prs_draft_regions','prs_draft_title','prs_draft_grade','prs_draft_semester','prs_draft_unit']
      .forEach(k => localStorage.removeItem(k));
    setHasDraft(false);
  };

  // ── 저장된 기록에서 불러오기 ──
  const loadFromRecord = useCallback((rec) => {
    // 1단계: 각 저장 id → 새 id 매핑 (중복 방지)
    const idMap = {};
    (rec.regions || []).forEach((r, i) => {
      idMap[r.id ?? i] = Date.now() + i;
    });

    const pw = Number(rec.page_width) || 595;
    const ph = Number(rec.page_height) || 841;
    const restoredRegions = (rec.regions || []).map((r, i) => {
      const newId = Date.now() + i;
      // 구버전(userProblemType: '선잇기'|'표') ↔ 신버전(problemType + hasImage) 호환
      const legacyType = r.userProblemType || null;
      const problemType = r.problemType || legacyType || null;
      const base = {
        id:             newId,
        problem_number: r.problem_number,
        page:           r.page ?? 1,
        x: r.x, y: r.y, w: r.w, h: r.h,
        detecting:      false,
        // group 메타 복원
        ...(r.groupId    != null && { groupId: r.groupId, groupRole: r.groupRole, groupOrder: r.groupOrder }),
        // 이미지 하위 영역 복원 (parentId는 원본 id 그대로 — 아래에서 재매핑)
        ...(r.isImageRegion && { isImageRegion: true, parentId: r.parentId, imageIdx: r.imageIdx }),
        // 사용자가 확정한 구조 유형
        ...(problemType && {
          problemType,
          problemTypeSource: r.problemTypeSource || (legacyType ? 'user' : 'heuristic'),
          problemTypeConfidence: r.problemTypeConfidence ?? 1,
        }),
        // 이미지 포함 플래그
        ...(r.hasImage && {
          hasImage: true,
          hasImageSource: r.hasImageSource || 'user',
        }),
      };
      const markBox = r.markBox || computeMarkBoxFromRegion(base, pw, ph);
      return markBox ? { ...base, markBox } : base;
    });

    // 2단계: parentId를 원본id → 새id로 재매핑
    // 원본 id 기준 매핑 테이블
    const origIdToNew = {};
    (rec.regions || []).forEach((r, i) => {
      origIdToNew[r.id ?? i] = restoredRegions[i].id;
    });
    const remapped = restoredRegions.map(r =>
      r.isImageRegion && r.parentId != null
        ? { ...r, parentId: origIdToNew[r.parentId] ?? r.parentId }
        : r
    );

    classifyQueueRef.current = [];
    classifyDrainRef.current = false;
    classifyPendingRef.current = new Set();

    setRegions(remapped);
    setExamTitle((prev) => rec.exam_name || prev);
    setSelGrade((prev) => rec.grade || prev);
    setSelSemester((prev) => rec.semester || prev);
    setSelUnit((prev) => rec.unit || prev);
    setSaveMsg('');
    const name = rec.exam_name || rec.pdf_name || '시험';
    setLoadMsg(`✅ "${name}" — ${remapped.filter(r => !r.isImageRegion).length}개 영역 로드 완료! 아래에서 PDF를 업로드하면 박스가 표시됩니다.`);
  }, []);

  // ── PDF 로드 ──
  useEffect(() => {
    if (!pdfFile) return;
    const lib = getPdfjsLib();
    if (!lib) { setError('pdf.js가 로드되지 않았습니다. 페이지를 새로고침 해주세요.'); return; }

    pdfFile.arrayBuffer()
      .then(buf => lib.getDocument({ data: buf }).promise)
      .then(doc => {
        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setCurrentPage(1);
        // regions는 유지 (불러오기 후 PDF 열 때를 위해)
        setRecs([]);
        setSaveMsg('');
        setError('');
        pageAnalysisRef.current = {};
      })
      .catch(e => setError('PDF 로드 오류: ' + e.message));
  }, [pdfFile]);

  // ── 페이지 렌더 (문항 확인 화면에서는 캔버스가 unmount → 복귀 시 viewStep 으로 재실행) ──
  useEffect(() => {
    if (!pdfDoc || viewStep !== 'select') return;

    let cancelled = false;

    const renderCurrentPage = () => {
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;

      pdfDoc.getPage(currentPage).then((page) => {
        if (cancelled) return;

        cancelPdfRenderTask(renderTaskRef.current);
        renderTaskRef.current = null;

        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const ctx = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        pdfPageRef.current = page;
        viewportRef.current = viewport;

        const vp1 = page.getViewport({ scale: 1 });
        setPageInfo({ width: vp1.width, height: vp1.height });

        const renderTask = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = renderTask;
        renderTask.promise.then(() => {
          if (renderTaskRef.current === renderTask) renderTaskRef.current = null;
          if (!cancelled) checkRecommendations(vp1.width, vp1.height);
          if (!pageAnalysisRef.current[currentPage]) {
            analyzePage(page, viewport)
              .then((meta) => {
                if (cancelled) return;
                pageAnalysisRef.current[currentPage] = meta;
                retryHeuristicsForPageRef.current(currentPage);
                void hydratePageRegionCropsRef.current(currentPage);
              })
              .catch(() => { /* noop */ });
          } else {
            void hydratePageRegionCropsRef.current(currentPage);
          }
        }).catch((e) => {
          if (renderTaskRef.current === renderTask) renderTaskRef.current = null;
          if (!cancelled && e?.name !== 'RenderingCancelledException') {
            setError('페이지 렌더 오류: ' + e.message);
          }
        });
      }).catch((e) => !cancelled && setError('페이지 렌더 오류: ' + e.message));
    };

    // 영역 선택으로 돌아올 때 캔버스가 같은 틱에 아직 없을 수 있음 → 다음 프레임에 그리기
    const rafId = requestAnimationFrame(renderCurrentPage);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      cancelPdfRenderTask(renderTaskRef.current);
      renderTaskRef.current = null;
    };
  }, [pdfDoc, currentPage, viewStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 추천 영역 계산 ──
  function checkRecommendations(pageW, pageH) {
    if (!ENABLE_SAVED_REGION_RECOMMENDATIONS) {
      setRecs([]);
      return;
    }
    if (history.length < REC_THRESHOLD) { setRecs([]); return; }

    const similar = history.filter(r => {
      const wr = Math.abs(r.page_width  - pageW) / pageW;
      const hr = Math.abs(r.page_height - pageH) / pageH;
      return wr < REC_PAGE_TOLERANCE && hr < REC_PAGE_TOLERANCE;
    });

    if (similar.length === 0) { setRecs([]); return; }

    // 가장 최근 유사 레코드의 영역을 추천으로 표시
    const latest = similar[similar.length - 1];
    setRecs(latest.regions.map((r, i) => ({
      id: `rec-${i}-${Date.now()}`,
      problem_number: r.problem_number,
      x: r.x, y: r.y, w: r.w, h: r.h,
    })));
  }

  // ── 상대 좌표 (0~1) 계산 ──
  const getRelPos = useCallback((e) => {
    const rect = overlayRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left)  / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top)   / rect.height)),
    };
  }, []);

  // ── 마우스 이벤트 ──
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pt = getRelPos(e);
    setStartPt(pt);
    setCurPt(pt);
    setDrawing(true);
  }, [getRelPos]);

  const handleMouseMove = useCallback((e) => {
    if (!drawing) return;
    setCurPt(getRelPos(e));
  }, [drawing, getRelPos]);

  /**
   * 영역에 대해 휴리스틱으로 problemType / hasImage 를 즉시 판정해 region에 반영한다.
   * - 휴리스틱이 유형을 잡지 못한 경우에만 백엔드 `mode=classify` (API 1회·순차 큐).
   * - 사용자가 이미 손으로 정한(problemTypeSource === 'user') 값은 절대 덮어쓰지 않는다.
   * - 이미지(도형) 감지 시 문항 위 확인 모달(예 → 이미지 영역 드래그 모드).
   * - 구조 유형은 모달 없이 박스 배지에 반영.
   *
   * @param {number} regionId
   * @param {{x:number,y:number,w:number,h:number}} rectN  0~1 정규화 좌표
   * @param {number} pageNum
   * @param {string|null} cropDataUrlForAi  AI 보강 호출에 쓸 크롭 (없으면 보강 생략)
   */
  const regionHasResolvedType = useCallback((r) => {
    if (!r?.problemType) return false;
    if (r.problemTypeSource === 'user') return true;
    if (r.problemTypeSource === 'heuristic' && r.problemType) return true;
    if (r.problemTypeSource === 'ai' && r.problemType) return true;
    return false;
  }, []);

  const drainClassifyQueue = useCallback(() => {
    if (classifyDrainRef.current) return;
    classifyDrainRef.current = true;
    (async () => {
      try {
        const worker = async () => {
          for (;;) {
            const job = classifyQueueRef.current.shift();
            if (!job) break;
            await job();
          }
        };
        await Promise.all(
          Array.from({ length: CLASSIFY_CONCURRENCY }, () => worker()),
        );
      } finally {
        classifyDrainRef.current = false;
        if (classifyQueueRef.current.length > 0) drainClassifyQueue();
      }
    })();
  }, []);

  const runClassifyAiQueued = useCallback(
    (regionId, cropDataUrlForAi, pageNum) => {
      if (!classifyAiEnabled || !cropDataUrlForAi) return;
      if (classifyPendingRef.current.has(regionId)) return;
      classifyPendingRef.current.add(regionId);

      const job = async () => {
        try {
          let skip = false;
          setRegions((prev) => {
            const r = prev.find((x) => x.id === regionId);
            if (regionHasResolvedType(r)) skip = true;
            return prev;
          });
          if (skip) return;

          const blob = await dataUrlToBlob(cropDataUrlForAi);
          const f = new FormData();
          f.append('file', blob, `classify_p${pageNum}_${regionId}.png`);
          f.append('mode', 'classify');
          if (selGrade)    f.append('grade',    selGrade);
          if (selSemester) f.append('semester', selSemester);
          if (selUnit)     f.append('unit',     selUnit);
          const res = await fetch('/api/parse-problem', { method: 'POST', body: f });
          if (!res.ok) return;
          const data = await res.json().catch(() => ({}));
          const t = String(data?.problem_type || '').trim();
          if (!t) return;
          if (!['선잇기', '표', '세로셈', '빈칸채우기', '기타'].includes(t)) return;
          setRegions((prev) =>
            prev.map((r) => {
              if (r.id !== regionId) return r;
              if (r.problemTypeSource === 'user') return r;
              if (r.problemTypeSource === 'heuristic' && r.problemType) return r;
              return {
                ...r,
                problemType: t,
                problemTypeSource: 'ai',
                problemTypeConfidence: 0.85,
              };
            }),
          );
        } catch {
          /* best-effort */
        } finally {
          classifyPendingRef.current.delete(regionId);
        }
      };

      classifyQueueRef.current.push(job);
      drainClassifyQueue();
    },
    [selGrade, selSemester, selUnit, classifyAiEnabled, drainClassifyQueue, regionHasResolvedType],
  );

  const applyRegionHeuristicsAsync = useCallback(
    async (regionId, rectN, pageNum, cropDataUrlForAi) => {
      const meta = pageAnalysisRef.current[pageNum];
      let heurType = null;
      let heurTypeConf = 0;
      let heurHasImage = false;
      let heurImageBoxes = [];

      // 휴리스틱 결과 디버그 출력 (개발 중 검증용 — 운영에서도 가벼움)
      let heurDebug = null;
      if (meta) {
        try {
          const s = detectStructure(meta, rectN);
          heurDebug = s;
          // 신뢰도 0.65 미만은 적용하지 않음 (잘못 잡힌 배지를 보여주느니 '유형 ?' 가 낫다)
          if (s.type !== 'unknown' && s.confidence >= 0.65) {
            heurType = s.type;
            heurTypeConf = s.confidence;
          }
        } catch { /* noop */ }
        try {
          const im = detectHasImage(meta, rectN);
          heurHasImage = !!im.hasImage;
          heurImageBoxes = (im.imageBoxes || [])
            .map((box) => imageBoxToRelativeRect(box, meta, rectN))
            .filter(Boolean);
        } catch { /* noop */ }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[heuristic] region#${regionId} →`,
        heurType ? `${heurType}(${heurTypeConf.toFixed(2)})` : '(미결정)',
        heurHasImage ? '🖼️' : '',
        heurDebug?.debug || {},
      );

      // ── 1) 휴리스틱 결과를 즉시 region에 반영 ──
      let showImagePrompt = false;
      setRegions((prev) => {
        const cur = prev.find((x) => x.id === regionId);
        const hasImgChildren = prev.some(
          (ir) => ir.isImageRegion && ir.parentId === regionId,
        );
        showImagePrompt = !!(
          heurHasImage &&
          cur &&
          cur.hasImageSource !== 'user' &&
          cur.hasImage == null &&
          !hasImgChildren &&
          !imagePromptAnsweredRef.current.has(regionId)
        );

        return prev.map((r) => {
          if (r.id !== regionId) return r;
          const next = { ...r };
          if (heurType && next.problemTypeSource !== 'user') {
            next.problemType = heurType;
            next.problemTypeSource = 'heuristic';
            next.problemTypeConfidence = heurTypeConf;
          }
          if (next.hasImageSource !== 'user') {
            if (showImagePrompt) {
              if (heurImageBoxes.length > 0) {
                next.imageRegionsSuggested = heurImageBoxes;
              }
            } else {
              next.hasImage = heurHasImage;
              next.hasImageSource = heurHasImage ? 'heuristic' : (next.hasImageSource || null);
              if (heurHasImage && heurImageBoxes.length > 0 && (!next.imageRegions || next.imageRegions.length === 0)) {
                next.imageRegionsSuggested = heurImageBoxes;
              }
            }
          }
          return next;
        });
      });

      if (showImagePrompt) {
        setAutoImagePrompt((prev) =>
          prev ?? {
            regionId,
            x: rectN.x,
            y: rectN.y,
            w: rectN.w,
            h: rectN.h,
            page: pageNum,
          },
        );
      }

      // ── 2) 휴리스틱이 유형을 못 잡았을 때만 AI 보강 ──
      if (!heurType) {
        runClassifyAiQueued(regionId, cropDataUrlForAi, pageNum);
      }
    },
    [runClassifyAiQueued],
  );

  /** analyzePage 완료 후 — meta 없이 그린 박스에 휴리스틱 재시도(AI 호출 감소) */
  const retryHeuristicsForPage = useCallback(
    (pageNum) => {
      setRegions((prev) => {
        prev.forEach((r) => {
          if (r.page !== pageNum || r.isImageRegion || r.groupRole === 'passage') return;
          if (r.problemTypeSource === 'user') return;
          if (regionHasResolvedType(r)) return;
          if (!r.cropDataUrl) return;
          void applyRegionHeuristicsAsync(
            r.id,
            { x: r.x, y: r.y, w: r.w, h: r.h },
            pageNum,
            r.cropDataUrl,
          );
        });
        return prev;
      });
    },
    [applyRegionHeuristicsAsync, regionHasResolvedType],
  );
  retryHeuristicsForPageRef.current = retryHeuristicsForPage;

  /**
   * 저장 불러오기 등 — cropDataUrl 없는 영역에 캔버스 크롭·휴리스틱/AI 분류 적용 (새로 그릴 때와 동일).
   */
  const hydratePageRegionCrops = useCallback(
    async (pageNum) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      let targets = [];
      setRegions((prev) => {
        targets = prev.filter(
          (r) =>
            r.page === pageNum &&
            !r.isImageRegion &&
            r.groupRole !== 'passage' &&
            !r.cropDataUrl,
        );
        return prev;
      });
      if (!targets.length) return;

      const updates = await Promise.all(
        targets.map(async (r) => {
          const cropDataUrl = await cropNormalizedRectToDataUrl(canvas, r.x, r.y, r.w, r.h);
          return { r, cropDataUrl };
        }),
      );

      setRegions((prev) =>
        prev.map((region) => {
          const hit = updates.find((u) => u.r.id === region.id && u.cropDataUrl);
          return hit ? { ...region, cropDataUrl: hit.cropDataUrl } : region;
        }),
      );

      for (const { r, cropDataUrl } of updates) {
        if (!cropDataUrl) continue;
        if (r.problemTypeSource === 'user' && r.problemType) continue;
        void applyRegionHeuristicsAsync(
          r.id,
          { x: r.x, y: r.y, w: r.w, h: r.h },
          pageNum,
          cropDataUrl,
        );
      }
    },
    [applyRegionHeuristicsAsync],
  );
  hydratePageRegionCropsRef.current = hydratePageRegionCrops;

  const handleMouseUp = useCallback((e) => {
    if (!drawing) return;
    setDrawing(false);

    const end = getRelPos(e);
    const x = Math.min(startPt.x, end.x);
    const y = Math.min(startPt.y, end.y);
    const w = Math.abs(end.x - startPt.x);
    const h = Math.abs(end.y - startPt.y);

    if (w <= MIN_BOX_RATIO || h <= MIN_BOX_RATIO) return;

    const id = Date.now();

    // ── 이미지 영역(타깃형): 특정 부모에만 연결 ──
    // 사이드 패널의 "이미지 영역 그리기" 진입 시 imageTargetParentId 가 설정된다.
    // ── 또는 (호환) 전역 이미지 모드: 중심점이 포함된 문항 영역에 연결 ──
    if (imageTargetParentId != null || insertMode === 'image') {
      setRegions(prev => {
        let parentRegion = null;
        if (imageTargetParentId != null) {
          parentRegion = prev.find(r => r.id === imageTargetParentId && !r.isImageRegion);
        }
        if (!parentRegion) {
          const cx = x + w / 2;
          const cy = y + h / 2;
          const containing = prev.filter(r =>
            !r.isImageRegion &&
            r.page === currentPage &&
            cx >= r.x && cx <= r.x + r.w &&
            cy >= r.y && cy <= r.y + r.h
          );
          parentRegion = containing.length > 0
            ? containing[containing.length - 1]
            : [...prev].reverse().find(r => !r.isImageRegion);
        }
        if (!parentRegion) return prev;
        const imageCount = prev.filter(r => r.isImageRegion && r.parentId === parentRegion.id).length;
        return prev.map((r) =>
          // 이 부모의 hasImage 플래그를 사용자 확정으로 갱신 (사용자가 직접 영역을 그렸으므로)
          r.id === parentRegion.id
            ? { ...r, hasImage: true, hasImageSource: 'user' }
            : r
        ).concat([{
          id,
          isImageRegion: true,
          parentId:  parentRegion.id,
          imageIdx:  imageCount + 1,
          detecting: false,
          page: currentPage,
          x, y, w, h,
        }]);
      });
      requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        cropNormalizedRectToDataUrl(canvas, x, y, w, h).then(dataUrl => {
          if (!dataUrl) return;
          setRegions(prev => prev.map(r => r.id === id ? { ...r, cropDataUrl: dataUrl } : r));
        });
      });
      // 타깃형 모드는 한 번 그리면 자동 종료 (사용자가 다음 문항 그리기로 자연스럽게 복귀)
      if (imageTargetParentId != null) setImageTargetParentId(null);
      return;
    }

    // ── 문항 영역: 기존 로직 ──
    const gid        = groupMode ? groupIdRef.current : null;
    const groupRole  = groupMode ? (groupStep === 0 ? 'passage' : 'question') : null;
    const groupOrder = groupMode ? groupStep : null;
    const isPassage = groupMode && groupStep === 0;

    setRegions(prev => {
      const provisionalPn = isPassage
        ? '보기'
        : groupMode
          ? prev.filter(r => !r.isImageRegion && (!r.groupId || r.groupRole === 'question')).length + 1
          : nextProvisionalProblemNumber(prev);
      const pageW = pageInfo?.width || 595;
      const pageH = pageInfo?.height || 841;
      const draft = {
        id,
        problem_number: provisionalPn,
        detecting:      !isPassage,
        page:           currentPage,
        x, y, w, h,
        insertMode: 'text',
        ...(gid !== null && { groupId: gid, groupRole, groupOrder }),
      };
      const withBox = isPassage ? draft : withMarkBox(draft, pageW, pageH);
      return [...prev, withBox];
    });

    if (groupMode) {
      const newStep = groupStep + 1;
      if (newStep >= groupQCount + 1) {
        setGroupMode(false);
        setGroupStep(0);
      } else {
        setGroupStep(newStep);
      }
    }

    const page = pdfPageRef.current;
    const vp   = viewportRef.current;
    const detectAndUpdate = (detected) => {
      // 1) 묶음 모드의 보기: 라벨·문항 수 자동 적용(1~2·※ 등)
      if (isPassage && (detected?.kind === 'group' || detected?.kind === 'passage')) {
        const label = detected.label;
        const cnt = detected.count;
        if (Number.isFinite(cnt) && cnt >= 2) setGroupQCount(cnt);
        setRegions(prev => prev.map(r => (r.id === id ? { ...r, detecting: false, problem_number: label } : r)));
        return;
      }

      // 2) 일반 모드에서 ※·[보기] 등 보기(지문) 감지 → 묶음 모달
      if (!groupMode && detected?.kind === 'passage') {
        setAutoGroupPrompt({
          regionId: id,
          label: detected.label,
          count: detected.count,
          kind: 'passage',
          x, y, w, h,
          page: currentPage,
        });
        setRegions(prev => prev.map(r => (r.id === id ? { ...r, detecting: false } : r)));
        return;
      }

      // 3) 일반 모드에서 [1~3] 감지 → "묶음 문제인가요?" 예/아니오
      if (!groupMode && detected?.kind === 'group') {
        const label = detected.label;
        const cnt = detected.count;
        setAutoGroupPrompt({
          regionId: id,
          label,
          count: cnt,
          kind: 'group',
          x, y, w, h,
          page: currentPage,
        });
        setRegions(prev => prev.map(r => (r.id === id ? { ...r, detecting: false } : r)));
        return;
      }

      // 4) 단일 번호 감지
      const detectedNum = detected?.kind === 'number' ? detected.number : null;
      setRegions((prev) => {
        const updated = prev.map((r) =>
          r.id === id
            ? { ...r, detecting: false, problem_number: detectedNum ?? r.problem_number }
            : r
        );
        return sortRegionsStableByProblemNumber(updated);
      });
    };

    requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      cropNormalizedRectToDataUrl(canvas, x, y, w, h).then((dataUrl) => {
        if (!dataUrl) return;
        setRegions(prev => prev.map(r => (r.id === id ? { ...r, cropDataUrl: dataUrl } : r)));
        // 묶음 '보기(passage)' 는 분류 대상이 아니다. 일반 문항/소문항만 자동 분류.
        if (!isPassage) {
          applyRegionHeuristicsAsync(id, { x, y, w, h }, currentPage, dataUrl);
        }
      });
    });

    if (page && vp) {
      detectTopLeftKeyFromRegion(page, vp, x, y, w, h)
        .then(detectAndUpdate)
        .catch(() => detectAndUpdate(null));
    } else {
      detectAndUpdate(null);
    }
  }, [drawing, getRelPos, startPt, currentPage, insertMode, imageTargetParentId, groupMode, groupStep, groupQCount, applyRegionHeuristicsAsync, pageInfo]);

  const acceptAutoGroupPrompt = useCallback((overrideCount) => {
    const p = autoGroupPrompt;
    if (!p) return;
    const cnt = Number(overrideCount ?? p.count);
    if (!Number.isFinite(cnt) || cnt < 2 || cnt > 5) return;
    groupIdRef.current += 1;
    const newGid = groupIdRef.current;
    setGroupQCount(cnt);
    setGroupMode(true);
    setGroupStep(1);
    setRegions(prev => prev.map(r =>
      r.id === p.regionId
        ? { ...r, detecting: false, problem_number: p.label, groupId: newGid, groupRole: 'passage', groupOrder: 0 }
        : r
    ));
    setAutoGroupPrompt(null);
  }, [autoGroupPrompt]);

  const rejectAutoGroupPrompt = useCallback(() => {
    setAutoGroupPrompt(null);
  }, []);

  const acceptAutoImagePrompt = useCallback(() => {
    const p = autoImagePrompt;
    if (!p) return;
    imagePromptAnsweredRef.current.add(p.regionId);
    setRegions((prev) =>
      prev.map((r) =>
        r.id === p.regionId
          ? { ...r, hasImage: true, hasImageSource: 'user' }
          : r,
      ),
    );
    setAutoImagePrompt(null);
    setInsertMode('text');
    setImageTargetParentId(p.regionId);
  }, [autoImagePrompt]);

  const rejectAutoImagePrompt = useCallback(() => {
    const p = autoImagePrompt;
    if (!p) return;
    imagePromptAnsweredRef.current.add(p.regionId);
    setRegions((prev) =>
      prev.map((r) =>
        r.id === p.regionId
          ? { ...r, hasImage: false, hasImageSource: 'user', imageRegionsSuggested: undefined }
          : r,
      ),
    );
    setAutoImagePrompt(null);
  }, [autoImagePrompt]);

  /**
   * 분류 확인 패널/박스 배지에서 구조 유형을 사용자가 직접 토글.
   * 순환: null → 표 → 선잇기 → 세로셈 → 빈칸채우기 → 기타 → null …
   */
  const cycleRegionProblemType = useCallback((id) => {
    setRegions(prev => prev.map(r => {
      if (r.id !== id) return r;
      const cur = r.problemType || null;
      const idx = STRUCTURE_TYPE_CYCLE.indexOf(cur);
      const next = STRUCTURE_TYPE_CYCLE[(idx + 1) % STRUCTURE_TYPE_CYCLE.length];
      return {
        ...r,
        problemType: next,
        problemTypeSource: next ? 'user' : null,
        problemTypeConfidence: next ? 1 : 0,
      };
    }));
  }, []);

  /** 문항 확인 단계: 구조 유형을 목록에서 직접 선택 */
  const setRegionProblemType = useCallback((id, problemType) => {
    setRegions(prev => prev.map(r => {
      if (r.id !== id) return r;
      if (r.problemType === problemType && r.problemTypeSource === 'user') return r;
      return {
        ...r,
        problemType,
        problemTypeSource: 'user',
        problemTypeConfidence: 1,
      };
    }));
  }, []);

  /** 문항 확인 단계: 이미지(도형) 있음/없음 선택 */
  const setRegionHasImage = useCallback((id, hasImage) => {
    imagePromptAnsweredRef.current.add(id);
    setAutoImagePrompt((prev) => (prev?.regionId === id ? null : prev));
    setRegions(prev => prev.map(r => {
      if (r.id !== id) return r;
      if (r.hasImage === hasImage) return r;
      return { ...r, hasImage, hasImageSource: 'user' };
    }));
  }, []);

  /**
   * 분류 확인 패널의 "이미지 영역 그리기" 버튼: 다음 드래그는 이 부모 문항에만 자식으로 들어간다.
   */
  const beginDrawImageForRegion = useCallback((parentId) => {
    setInsertMode('text');
    setImageTargetParentId(parentId);
  }, []);

  const cancelImageTarget = useCallback(() => {
    setImageTargetParentId(null);
  }, []);

  const confirmUnits = useMemo(() => listQuestionOcrUnits(regions), [regions]);

  const invalidateOcrPipeline = useCallback(() => {
    ocrQueueRef.current = [];
    ocrDrainRef.current = false;
    ocrInFlightRef.current.clear();
    ocrPipelineStoreRef.current = {
      pageCache: null,
      cropData: null,
      imgSubCropMap: null,
      ordered: null,
      apiUnits: null,
      apiResults: null,
    };
    setPreviewUrlByKey({});
    setOcrStatusByKey({});
  }, []);

  const ensureOcrPipeline = useCallback(async () => {
    const store = ocrPipelineStoreRef.current;
    if (store.cropData && store.pageCache && store.apiUnits) return store;
    if (!pdfDoc) throw new Error('PDF가 로드되지 않았습니다.');
    const ordered = regions.filter((r) => !r.isImageRegion);
    const uniquePages = [...new Set(ordered.map((r) => r.page))];
    const pageCache = await preparePageCache(pdfDoc, uniquePages);
    const built = await buildCropPipelineData(regions, pageCache);
    const previews = {};
    for (const cd of built.cropData) {
      if (cd.region.groupRole === 'passage') continue;
      previews[getOcrUnitKey(cd.unit)] = cd.cropDataUrl;
    }
    setPreviewUrlByKey(previews);
    store.pageCache = pageCache;
    store.cropData = built.cropData;
    store.imgSubCropMap = built.imgSubCropMap;
    store.ordered = built.ordered;
    store.apiUnits = built.apiUnits;
    if (!store.apiResults || store.apiResults.length !== built.apiUnits.length) {
      store.apiResults = new Array(built.apiUnits.length).fill(null);
    }
    return store;
  }, [pdfDoc, regions]);

  const executeOcrForUnitKey = useCallback(
    async (unitKey) => {
      try {
        const store = await ensureOcrPipeline();
        const idx = cropEntryIndexByUnitKey(store.cropData, unitKey);
        if (idx < 0) throw new Error('문항을 찾을 수 없습니다.');
        const entry = store.cropData[idx];
        const value = await runOcrOnCropEntry(entry, {
          selGrade,
          selSemester,
          selUnit,
          imgSubCropMap: store.imgSubCropMap,
          signal: reviewAbortRef.current?.signal,
        });
        if (!value.isImageMode && !value.parsed) {
          throw new Error('문항 텍스트를 추출하지 못했습니다.');
        }
        store.apiResults[idx] = { status: 'fulfilled', value };
        setOcrStatusByKey((prev) => ({ ...prev, [unitKey]: 'done' }));
      } catch (e) {
        const store = ocrPipelineStoreRef.current;
        const idx = store.cropData
          ? cropEntryIndexByUnitKey(store.cropData, unitKey)
          : -1;
        if (idx >= 0) {
          store.apiResults[idx] = { status: 'rejected', reason: e };
        }
        setOcrStatusByKey((prev) => ({ ...prev, [unitKey]: 'error' }));
      }
    },
    [ensureOcrPipeline, selGrade, selSemester, selUnit],
  );

  const drainOcrQueue = useCallback(() => {
    if (ocrDrainRef.current) return;
    ocrDrainRef.current = true;
    (async () => {
      try {
        const worker = async () => {
          for (;;) {
            const job = ocrQueueRef.current.shift();
            if (!job) break;
            await job();
          }
        };
        await Promise.all(
          Array.from({ length: PIPELINE_OCR_CONCURRENCY }, () => worker()),
        );
      } finally {
        ocrDrainRef.current = false;
        if (ocrQueueRef.current.length > 0) drainOcrQueue();
      }
    })();
  }, []);

  const runOcrForUnitKey = useCallback(
    (unitKey) => {
      if (ocrInFlightRef.current.has(unitKey)) {
        return ocrInFlightRef.current.get(unitKey);
      }
      setOcrStatusByKey((prev) => ({ ...prev, [unitKey]: 'loading' }));
      const task = new Promise((resolve) => {
        const job = async () => {
          await executeOcrForUnitKey(unitKey);
          resolve();
        };
        ocrQueueRef.current.push(job);
        drainOcrQueue();
      });
      ocrInFlightRef.current.set(unitKey, task);
      task.finally(() => {
        ocrInFlightRef.current.delete(unitKey);
      });
      return task;
    },
    [executeOcrForUnitKey, drainOcrQueue],
  );

  const prefetchClassifyWindow = useCallback(
    (centerIdx) => {
      if (!classifyAiEnabled || CLASSIFY_PREFETCH_AHEAD < 1) return;
      const slice = confirmUnits.slice(centerIdx, centerIdx + CLASSIFY_PREFETCH_AHEAD);
      for (const u of slice) {
        const r = u.primaryRegion;
        if (r.problemTypeSource === 'user' && r.problemType) continue;
        if (classifyPendingRef.current.has(r.id)) continue;
        const rectN = { x: r.x, y: r.y, w: r.w, h: r.h };
        void applyRegionHeuristicsAsync(r.id, rectN, r.page, r.cropDataUrl || null);
      }
    },
    [confirmUnits, applyRegionHeuristicsAsync, classifyAiEnabled],
  );

  useEffect(() => {
    if (viewStep !== 'confirm') return;
    prefetchClassifyWindow(confirmIndex);
  }, [viewStep, confirmIndex, prefetchClassifyWindow]);

  // 저장 불러오기 후: PDF·캔버스 준비되면 현재 페이지 영역 크롭·분류 (새로 그리기와 동일 경로)
  useEffect(() => {
    if (!pdfDoc || viewStep !== 'select') return;
    const needs = regions.some(
      (r) =>
        r.page === currentPage &&
        !r.isImageRegion &&
        r.groupRole !== 'passage' &&
        !r.cropDataUrl,
    );
    if (!needs) return;
    const t = requestAnimationFrame(() => {
      void hydratePageRegionCrops(currentPage);
    });
    return () => cancelAnimationFrame(t);
  }, [pdfDoc, currentPage, viewStep, regions, hydratePageRegionCrops]);

  // 개발 토글: 값 저장
  useEffect(() => {
    if (!ENABLE_DEV_REGION_COORD_SAVE) return;
    try {
      localStorage.setItem(DEV_AI_TOGGLE_KEY, devAiEnabled ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [devAiEnabled]);

  // 개발 토글: OFF로 바꿀 때 이미 쌓인 분류 큐를 즉시 비움 (추가 호출 방지)
  useEffect(() => {
    if (!ENABLE_DEV_REGION_COORD_SAVE) return;
    if (devAiEnabled) return;
    try {
      classifyQueueRef.current = [];
      classifyDrainRef.current = false;
      // 재활성화 시 다시 시도할 수 있게 seen도 초기화
      classifyPendingRef.current = new Set();
    } catch {
      /* ignore */
    }
  }, [devAiEnabled]);

  const persistReviewToStorageAndNavigate = useCallback(
    async (finalProblems) => {
      const payload = buildFullRegionsSavePayload(regions, {
        examTitle,
        pdfFile,
        selGrade,
        selSemester,
        selUnit,
        totalPages,
        pageInfo,
      });
      if (payload) {
        try {
          await postRegionsPayload(payload);
          await refreshHistoryFromServer();
        } catch (err) {
          console.warn('[PDFRegionSelector] 문항 좌표 자동 저장 실패:', err);
        }
      }

      offerResumeChoiceAfterAiStopRef.current = false;
      localStorage.setItem(
        'unitTestCurriculum',
        JSON.stringify({ grade: selGrade, semester: selSemester, unit: selUnit }),
      );
      localStorage.setItem('unitTestGrade', selGrade);
      localStorage.setItem(
        'unitTestProblems',
        JSON.stringify(normalizeProblemsCircledMcAnswers(finalProblems)),
      );
      localStorage.setItem(
        'unitTestTitle',
        examTitle.trim() || pdfFile?.name?.replace(/\.pdf$/i, '') || '',
      );
      navigate('/unit-test-review');
    },
    [
      regions,
      examTitle,
      pdfFile,
      selGrade,
      selSemester,
      selUnit,
      totalPages,
      pageInfo,
      navigate,
      refreshHistoryFromServer,
    ],
  );

  const handleDrawImageFromConfirm = useCallback(
    (parentId) => {
      const idx = confirmUnits.findIndex(
        (u) => u.primaryRegion.id === parentId,
      );
      returnToConfirmRef.current = { index: idx >= 0 ? idx : confirmIndex };
      setPendingReturnToConfirm(true);
      const pr = regions.find((r) => r.id === parentId);
      if (pr?.page) setCurrentPage(pr.page);
      setViewStep('select');
      beginDrawImageForRegion(parentId);
    },
    [confirmUnits, confirmIndex, regions, beginDrawImageForRegion],
  );

  const handleBackToRegionSelect = useCallback(() => {
    setViewStep('select');
    setPendingReturnToConfirm(false);
    returnToConfirmRef.current = null;
    setImageTargetParentId(null);
  }, []);

  const handleBackToConfirm = useCallback(() => {
    const back = returnToConfirmRef.current;
    returnToConfirmRef.current = null;
    setPendingReturnToConfirm(false);
    setImageTargetParentId(null);
    invalidateOcrPipeline();
    setViewStep('confirm');
    if (back && Number.isFinite(back.index)) {
      setConfirmIndex(back.index);
    }
    void ensureOcrPipeline();
  }, [invalidateOcrPipeline, ensureOcrPipeline]);

  function handleOpenProblemConfirm() {
    if (regions.length === 0 || !pdfDoc) return;
    if (!selGrade || !selSemester || !selUnit) {
      setError('문항 확인을 하려면 학년, 학기, 단원을 먼저 선택해야 합니다.');
      document.querySelector('.prs-sel-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!canOpenProblemConfirm(regions)) {
      if (regions.some((r) => r.detecting)) {
        setError('번호 인식이 끝난 뒤 문항 확인으로 이동할 수 있습니다.');
      } else {
        setError('모든 문항에 번호를 입력한 뒤 문항 확인으로 이동하세요.');
      }
      return;
    }
    setError('');
    invalidateOcrPipeline();
    setViewStep('confirm');
    setConfirmIndex(0);
    void ensureOcrPipeline();
  }

  function handleConfirmCurrent(unitKey) {
    const unit = confirmUnits.find((u) => u.key === unitKey);
    const pr = unit?.primaryRegion;
    if (!pr?.problemType) return;
    if (pr.hasImage !== true && pr.hasImage !== false) return;

    setConfirmedKeys((prev) => new Set([...prev, unitKey]));
    void runOcrForUnitKey(unitKey);
  }

  async function handleFinishReviewFromConfirm() {
    if (finishingReview || extracting || reviewActionLockRef.current) return;
    if (!selGrade || !selSemester || !selUnit) return;

    const missing = regions.filter((r) => {
      if (r.isImageRegion || !r.hasImage) return false;
      return !regions.some((ir) => ir.isImageRegion && ir.parentId === r.id);
    });
    if (missing.length > 0) {
      const labels = missing
        .slice(0, 5)
        .map((r) => problemDisplayLabel(r.problem_number) + '번')
        .join(', ');
      const extra = missing.length > 5 ? ` 외 ${missing.length - 5}개` : '';
      // eslint-disable-next-line no-alert
      const ok = window.confirm(
        `${missing.length}개 문항이 「이미지(도형) 있음」인데 이미지 영역이 없습니다.\n(${labels}${extra})\n\n계속 검수를 시작할까요?`,
      );
      if (!ok) return;
    }

    const unconfirmed = confirmUnits.filter((u) => !confirmedKeys.has(u.key)).length;
    if (unconfirmed > 0) {
      // eslint-disable-next-line no-alert
      const ok = window.confirm(
        `${unconfirmed}개 문항이 아직 「확인」되지 않았습니다.\n미확인 문항도 OCR 후 검수 페이지로 이동합니다. 계속할까요?`,
      );
      if (!ok) return;
    }

    if (offerResumeChoiceAfterAiStopRef.current && hasStoredUnitTestProblems()) {
      setReviewChoiceOpen(true);
      return;
    }

    reviewActionLockRef.current = true;
    setFinishingReview(true);
    setExtracting(true);
    setExtractMsg('검수 준비 중...');

    try {
      const store = await ensureOcrPipeline();
      const pending = store.apiUnits
        .map((u, i) => ({ i, u, key: getOcrUnitKey(u) }))
        .filter(({ i }) => ocrResultNeedsRetry(store.apiResults[i]));

      let doneOcr = 0;
      const ocrTotal = pending.length;

      const ocrTasks = pending.map(({ key }) =>
        runOcrForUnitKey(key).then(() => {
          doneOcr += 1;
          setExtractMsg(
            ocrTotal > 0
              ? `OCR ${doneOcr} / ${ocrTotal}`
              : '검수 페이지로 이동 중...',
          );
        }),
      );
      await Promise.all([...ocrInFlightRef.current.values(), ...ocrTasks]);

      const failCount = store.apiResults.filter((r) => ocrResultNeedsRetry(r)).length;
      if (failCount > 0) {
        setExtractMsg(`⚠️ ${failCount}개 인식 실패 — 검수에서 수정하세요`);
        await new Promise((r) => setTimeout(r, 1500));
      }

      const finalProblems = await assembleFinalProblems(
        store.ordered,
        store.apiUnits,
        store.cropData,
        store.apiResults,
        store.imgSubCropMap,
      );
      persistReviewToStorageAndNavigate(finalProblems);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError('검수 준비 중 오류: ' + err.message);
      }
    } finally {
      reviewActionLockRef.current = false;
      setFinishingReview(false);
      setExtracting(false);
      setExtractMsg('');
    }
  }

  // ── 영역 삭제 & 재번호 (이미지 하위 영역도 함께 삭제) ──
  const deleteRegion = useCallback((id) => {
    setRegions(prev => {
      // 삭제 대상이 이미지 영역이면 자신만 삭제
      const target = prev.find(r => r.id === id);
      const filtered = target?.isImageRegion
        ? prev.filter(r => r.id !== id)
        : prev.filter(r => r.id !== id && r.parentId !== id); // 문항 삭제 시 자식 이미지도 삭제
      return filtered.map((r) => {
        if (r.vmMergeAfter === id) return { ...r, vmMergeAfter: null };
        return r;
      });
    });
  }, []);

  // ── 추천 확정 ──
  const confirmRec = useCallback((rec) => {
    setRecs(prev => prev.filter(r => r.id !== rec.id));
    const newId = Date.now();
    const pageW = pageInfo?.width || 595;
    const pageH = pageInfo?.height || 841;
    setRegions(prev => [
      ...prev,
      withMarkBox(
        {
          id: newId,
          problem_number: nextProvisionalProblemNumber(prev),
          detecting: true,
          page: currentPage,
          x: rec.x,
          y: rec.y,
          w: rec.w,
          h: rec.h,
          insertMode: 'text',
        },
        pageW,
        pageH,
      ),
    ]);
    requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      cropNormalizedRectToDataUrl(canvas, rec.x, rec.y, rec.w, rec.h).then((dataUrl) => {
        if (!dataUrl) return;
        setRegions(prev => prev.map(r => (r.id === newId ? { ...r, cropDataUrl: dataUrl } : r)));
        applyRegionHeuristicsAsync(newId, { x: rec.x, y: rec.y, w: rec.w, h: rec.h }, currentPage, dataUrl);
      });
    });
    const page = pdfPageRef.current;
    const vp = viewportRef.current;
    const detectAndUpdate = (detected) => {
      const detectedNum = detected?.kind === 'number' ? detected.number : null;
      setRegions((prev) => {
        const updated = prev.map((r) =>
          r.id === newId
            ? { ...r, detecting: false, problem_number: detectedNum ?? r.problem_number }
            : r
        );
        return sortRegionsStableByProblemNumber(updated);
      });
    };
    if (page && vp) {
      detectTopLeftKeyFromRegion(page, vp, rec.x, rec.y, rec.w, rec.h)
        .then(detectAndUpdate)
        .catch(() => detectAndUpdate(null));
    } else {
      detectAndUpdate(null);
    }
  }, [currentPage, applyRegionHeuristicsAsync, pageInfo]);

  // ── 추천 무시 ──
  const dismissRec = useCallback((id) => {
    setRecs(prev => prev.filter(r => r.id !== id));
  }, []);

  // ── 문항 번호·10-1 형식 직접 수정 ──
  const updateRegionProblemKey = useCallback((id, value) => {
    let v = null;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 99) v = value;
    else if (typeof value === 'string') {
      const t = value.trim();
      if (/^\d{1,2}-\d{1,3}$/.test(t)) v = t;
      else if (/^\d{1,2}$/.test(t)) v = parseInt(t, 10);
    }
    if (v == null) return;
    setRegions((prev) => {
      const updated = sanitizeVmMergeChains(
        prev.map((r) => (r.id === id ? { ...r, problem_number: v } : r))
      );
      return sortRegionsStableByProblemNumber(updated);
    });
  }, []);

  const tryUpdateRegionProblemKey = useCallback((id, value, onRevert) => {
    let v = null;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 99) v = value;
    else if (typeof value === 'string') v = parseProblemKeyInput(value);
    if (v == null) {
      onRevert?.();
      return;
    }

    const prev = regionsRef.current;
    const self = prev.find((r) => r.id === id);
    if (!self || problemKeysEqual(self.problem_number, v)) return;

    const conflict = findStandaloneConflictRegion(prev, id, v);
    if (conflict && !areAlreadyVmMerged(self, conflict, prev)) {
      setDuplicateNumberPrompt({
        regionId: id,
        conflictId: conflict.id,
        newNumber: v,
        prevNumber: self.problem_number,
        x: self.x,
        y: self.y,
        w: self.w,
        h: self.h,
        page: self.page,
        onRevert,
      });
      return;
    }

    updateRegionProblemKey(id, v);
  }, [updateRegionProblemKey]);

  const acceptDuplicateNumberMerge = useCallback(() => {
    const p = duplicateNumberPrompt;
    if (!p) return;
    setDuplicateNumberPrompt(null);

    setRegions((prev) => {
      let next = sanitizeVmMergeChains(
        prev.map((r) => (r.id === p.regionId ? { ...r, problem_number: p.newNumber } : r))
      );
      next = sortRegionsStableByProblemNumber(next);

      const self = next.find((r) => r.id === p.regionId);
      const conflict = next.find((r) => r.id === p.conflictId);
      if (!self || !conflict) return next;

      const standalone = next.filter((r) => !r.isImageRegion && r.groupId == null);
      const iSelf = standalone.findIndex((r) => r.id === p.regionId);
      const iConflict = standalone.findIndex((r) => r.id === p.conflictId);
      if (iSelf < 0 || iConflict < 0) return next;

      const upperId = iSelf < iConflict ? p.regionId : p.conflictId;
      const lowerId = iSelf < iConflict ? p.conflictId : p.regionId;

      next = next.map((r) => {
        if (r.id === upperId) return { ...r, vmMergeAfter: lowerId };
        if (r.id === lowerId) return regionWithoutMarkBox(r);
        return r;
      });
      return sanitizeVmMergeChains(next);
    });
  }, [duplicateNumberPrompt]);

  const rejectDuplicateNumberMerge = useCallback(() => {
    const p = duplicateNumberPrompt;
    if (!p) return;
    p.onRevert?.();
    setDuplicateNumberPrompt(null);
  }, [duplicateNumberPrompt]);

  /** 같은 문항 번호 두 칸 사이: 위쪽이 아래쪽과 세로 병합되도록 연결 (확인 없음) */
  const linkVerticalMerge = useCallback((upperId, lowerId) => {
    setRegions((prev) => sanitizeVmMergeChains(
      prev.map((r) => {
        if (r.id === upperId) return { ...r, vmMergeAfter: lowerId };
        if (r.id === lowerId) return regionWithoutMarkBox(r);
        return r;
      })
    ));
  }, []);

  const clearVerticalMergeFrom = useCallback((upperId) => {
    setRegions((prev) => prev.map((r) => (r.id === upperId ? { ...r, vmMergeAfter: null } : r)));
  }, []);

  /** 병합 카드 안에서 위·아래 블록 순서만 교환 */
  const swapVerticalMergeOrder = useCallback((topParentId, bottomParentId) => {
    setRegions((prev) => {
      const bTop = getStandaloneBlockInOrder(prev, topParentId);
      const bBot = getStandaloneBlockInOrder(prev, bottomParentId);
      if (!bTop.length || !bBot.length) return prev;
      const allIds = new Set([...bTop, ...bBot].map((r) => r.id));
      const iTop = prev.findIndex((r) => r.id === topParentId);
      const iBot = prev.findIndex((r) => r.id === bottomParentId);
      if (iTop < 0 || iBot < 0) return prev;
      const insertAt = Math.min(iTop, iBot);
      const rest = prev.filter((r) => !allIds.has(r.id));
      let insertPos = 0;
      for (let k = 0; k < insertAt; k++) {
        if (!allIds.has(prev[k].id)) insertPos++;
      }
      const reordered = iTop < iBot ? [...bBot, ...bTop] : [...bTop, ...bBot];
      const parents = reordered.filter((r) => !r.isImageRegion);
      const newTop = parents[0];
      const newBot = parents[1];
      if (!newTop || !newBot) return prev;
      const merged = [...rest.slice(0, insertPos), ...reordered, ...rest.slice(insertPos)];
      return sanitizeVmMergeChains(
        merged.map((r) => {
          if (r.id === newTop.id) return { ...r, vmMergeAfter: newBot.id };
          if (r.id === newBot.id) return { ...r, vmMergeAfter: null };
          return r;
        })
      );
    });
  }, []);

  /** 독립 문항(이미지 자식 포함) 블록을 다른 문항 앞으로 이동 */
  const moveStandaloneBlock = useCallback((dragParentId, insertBeforeParentId) => {
    setRegions((prev) => {
      const dragImgs = prev.filter((ir) => ir.isImageRegion && ir.parentId === dragParentId);
      const dragSet = new Set([dragParentId, ...dragImgs.map((x) => x.id)]);
      const orderExtracted = prev.filter((r) => dragSet.has(r.id));
      const rest = prev.filter((r) => !dragSet.has(r.id));
      const insertIdx =
        insertBeforeParentId == null
          ? rest.length
          : rest.findIndex((r) => r.id === insertBeforeParentId);
      const at = insertIdx < 0 ? rest.length : insertIdx;
      const merged = [...rest.slice(0, at), ...orderExtracted, ...rest.slice(at)];
      return sanitizeVmMergeChains(merged);
    });
  }, []);

  /** 세로 병합된 두 문항 블록을 한 덩어리로 이동 */
  const moveVmMergedCard = useCallback((upperId, lowerId, insertBeforeParentId) => {
    setRegions((prev) => {
      const ids = new Set([
        ...getStandaloneBlockInOrder(prev, upperId).map((x) => x.id),
        ...getStandaloneBlockInOrder(prev, lowerId).map((x) => x.id),
      ]);
      const orderExtracted = prev.filter((r) => ids.has(r.id));
      const rest = prev.filter((r) => !ids.has(r.id));
      const insertIdx =
        insertBeforeParentId == null
          ? rest.length
          : rest.findIndex((r) => r.id === insertBeforeParentId);
      const at = insertIdx < 0 ? rest.length : insertIdx;
      return sanitizeVmMergeChains([...rest.slice(0, at), ...orderExtracted, ...rest.slice(at)]);
    });
  }, []);

  const dragStandaloneParentRef = useRef(null);

  // ── 문항 순서 정렬(수동): 번호 수정 시에는 자동 정렬됨 ──
  const renumber = () => setRegions((prev) => sortRegionsStableByProblemNumber(prev));

  // ── 묶음 선택 시작 / 취소 ──
  const startGroupMode = (qCount) => {
    groupIdRef.current += 1;
    setGroupQCount(qCount);
    setGroupStep(0);
    setGroupMode(true);
  };
  const cancelGroupMode = () => {
    // 현재 그룹에 들어간 영역들 제거
    const gid = groupIdRef.current;
    setRegions(prev => prev.filter(r => r.groupId !== gid));
    setGroupMode(false);
    setGroupStep(0);
  };

  // ── 저장 ──
  async function handleSave() {
    const payload = buildFullRegionsSavePayload(regions, {
      examTitle,
      pdfFile,
      selGrade,
      selSemester,
      selUnit,
      totalPages,
      pageInfo,
    });
    if (!payload) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const data = await postRegionsPayload(payload);

      await refreshHistoryFromServer();
      const prevRec = history.find(
        (rec) => (rec.pdf_name || '').trim() === (pdfFile.name || '').trim(),
      );
      const prevCount = countQuestionRegions(prevRec?.regions);
      const newCount = countQuestionRegions(payload.regions);
      const fewer =
        prevCount > 0 && newCount < prevCount
          ? ` (이전 ${prevCount}개 → ${newCount}개로 줄어듦)`
          : '';
      setSaveMsg(
        `✅ 저장 완료${data.replaced ? ` · 이전 ${data.replaced}건 덮어씀` : ''}` +
          ` · 총 ${data.total ?? '?'}개 레코드${fewer}`,
      );
    } catch (err) {
      setSaveMsg('⚠️ 저장 실패: ' + err.message);
    }
    setSaving(false);
  }

  const coordMeta = useMemo(
    () => ({
      examTitle,
      pdfFile,
      selGrade,
      selSemester,
      selUnit,
      totalPages,
      pageInfo,
    }),
    [examTitle, pdfFile, selGrade, selSemester, selUnit, totalPages, pageInfo],
  );

  const buildCurrentCoordinatesPayload = useCallback(() => {
    if (!pdfFile || regions.length === 0) return null;
    return buildScanOrganizeCoordinatesPayload(regions, coordMeta);
  }, [pdfFile, regions, coordMeta]);

  async function handleSaveRegionCoordinates() {
    const payload = buildCurrentCoordinatesPayload();
    if (!payload?.regions?.length) {
      setCoordSaveMsg('⚠️ 저장할 문항 영역이 없습니다.');
      return;
    }
    setCoordSaving(true);
    setCoordSaveMsg('');
    try {
      // 원본 시험지 PDF를 함께 전송 → 서버에서 템플릿 차분(diff) 채점에 활용
      const fd = new FormData();
      fd.append('coordinates_json', JSON.stringify(payload));
      if (pdfFile) {
        fd.append('template_pdf', pdfFile, pdfFile.name || 'template.pdf');
      }
      const res = await fetch('/api/regions/save-coordinates', {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || data.error || `서버 오류 (${res.status})`);
      }
      const jsonText = JSON.stringify(payload, null, 2);
      setCoordJsonPreview(jsonText);
      const prevRec = history.find(
        (rec) => (rec.pdf_name || '').trim() === (payload.pdf_name || '').trim(),
      );
      const prevCount = prevRec?.regions?.length ?? 0;
      const savedCount = data.regionCount ?? payload.regions.length;
      const fewer =
        prevCount > 0 && savedCount < prevCount
          ? ` · ⚠️ 이전 ${prevCount}개 → ${savedCount}개 (보기·번호 미지정 영역은 제외될 수 있음)`
          : '';
      setCoordSaveMsg(
        `✅ 영역 좌표 저장 · 문항 ${savedCount}개` +
          (data.replaced ? ` (이전 ${data.replaced}건 덮어씀)` : '') +
          ` · pdf_regions.json${fewer}`,
      );
      await refreshHistoryFromServer();
    } catch (err) {
      setCoordSaveMsg('⚠️ 좌표 저장 실패: ' + err.message);
    }
    setCoordSaving(false);
  }

  function handleCopyCoordinatesJson() {
    const payload = buildCurrentCoordinatesPayload();
    if (!payload) {
      setCoordSaveMsg('⚠️ 복사할 영역이 없습니다.');
      return;
    }
    const text = JSON.stringify(payload, null, 2);
    setCoordJsonPreview(text);
    navigator.clipboard
      .writeText(text)
      .then(() => setCoordSaveMsg('✅ JSON을 클립보드에 복사했습니다.'))
      .catch(() => setCoordSaveMsg('⚠️ 클립보드 복사에 실패했습니다.'));
  }

  const throwIfAborted = (signal) => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };

  function hasStoredUnitTestProblems() {
    try {
      const raw = localStorage.getItem('unitTestProblems');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) && arr.length > 0;
    } catch {
      return false;
    }
  }

  function handleReviewChoiceNavigateKeep() {
    offerResumeChoiceAfterAiStopRef.current = false;
    setReviewChoiceOpen(false);
    navigate('/unit-test-review');
  }

  function handleReviewChoiceRunFresh() {
    offerResumeChoiceAfterAiStopRef.current = false;
    setReviewChoiceOpen(false);
    if (viewStep === 'confirm') {
      void handleFinishReviewFromConfirm();
    } else {
      void runAiReviewExtract();
    }
  }

  function handleStopAiReview() {
    reviewAbortRef.current?.abort();
    setExtractMsg('중지되는 중입니다...');
  }

  // ── 검수 시작: 전체 병렬 크롭 → parse-problem(Gemini 우선, 실패 시 Claude) → UnitTestReview ──
  async function runAiReviewExtract() {
    if (regions.length === 0 || !pdfDoc) return;
    if (extracting || reviewActionLockRef.current) return;

    if (!selGrade || !selSemester || !selUnit) {
      setError('검수를 시작하려면 학년, 학기, 단원을 먼저 선택해야 합니다.');
      document.querySelector('.prs-sel-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    const myRunGen = ++aiReviewRunGenRef.current;
    reviewAbortRef.current?.abort();
    const abortController = new AbortController();
    reviewAbortRef.current = abortController;
    const signal = abortController.signal;

    reviewActionLockRef.current = true;
    setExtracting(true);
    setExtractMsg('이미지 준비 중...');

    /** 이미지 제외, 좌측 목록(및 드래그) 순서 그대로 — 세로 병합 순서에 사용 */
    const ordered = regions.filter((r) => !r.isImageRegion);
    const imgRegions = regions.filter(r => r.isImageRegion);
    const apiUnits = buildApiUnits(ordered);
    const total = apiUnits.filter(u => u.regions[0].groupRole !== 'passage').length;

    try {
      // ── Step 1: 모든 페이지 렌더 (캐시) ──
      const pageCache = {};
      const uniquePages = [...new Set(ordered.map(r => r.page))];
      for (const pageNum of uniquePages) {
        throwIfAborted(signal);
        const pg    = await pdfDoc.getPage(pageNum);
        const vp    = pg.getViewport({ scale: RENDER_SCALE });
        const tempC = document.createElement('canvas');
        tempC.width  = vp.width;
        tempC.height = vp.height;
        await pg.render({ canvasContext: tempC.getContext('2d'), viewport: vp }).promise;
        pageCache[pageNum] = { canvas: tempC, viewport: vp };
      }

      // ── Step 2: 모든 영역 크롭 + Blob/dataUrl 생성 (API 전에 완전히 확보) ──
      throwIfAborted(signal);
      setExtractMsg(`이미지 크롭 중...`);

      const cropSingleFromCache = async (region) => {
        if (region.cropDataUrl) {
          try {
            const blob = await dataUrlToBlob(region.cropDataUrl);
            return { blob, cropDataUrl: region.cropDataUrl };
          } catch {
            /* fall through: 페이지 캐시에서 다시 자름 */
          }
        }
        const { canvas: pgCanvas, viewport: pgVp } = pageCache[region.page];
        const cx = Math.round(region.x * pgVp.width);
        const cy = Math.round(region.y * pgVp.height);
        const cw = Math.round(region.w * pgVp.width);
        const ch = Math.round(region.h * pgVp.height);
        const cropC = document.createElement('canvas');
        cropC.width = Math.max(cw, 1);
        cropC.height = Math.max(ch, 1);
        cropC.getContext('2d').drawImage(pgCanvas, cx, cy, cw, ch, 0, 0, cw, ch);
        const blob = await new Promise((res) => cropC.toBlob(res, 'image/png'));
        const cropDataUrl = await new Promise((res) => {
          const reader = new FileReader();
          reader.onload = (e) => res(e.target.result);
          reader.readAsDataURL(blob);
        });
        return { blob, cropDataUrl };
      };

      const cropData = await Promise.all(
        apiUnits.map(async (unit) => {
          if (unit.kind === 'merged') {
            const { blob, cropDataUrl, yOffsetByRegionId, primaryRegion } = await verticalMergeRegionsToPng(
              unit.regions,
              pageCache,
              6
            );
            return {
              unit,
              region: primaryRegion,
              mergedRegionIds: unit.regions.map((rr) => rr.id),
              yOffsetByRegionId,
              blob,
              cropDataUrl,
            };
          }
          const r0 = unit.regions[0];
          const { blob, cropDataUrl } = await cropSingleFromCache(r0);
          return {
            unit,
            region: r0,
            mergedRegionIds: [r0.id],
            yOffsetByRegionId: { [r0.id]: 0 },
            blob,
            cropDataUrl,
          };
        })
      );
      throwIfAborted(signal);
      // ── Step 2-b: 이미지 서브 영역도 크롭 (부모 문항 좌표 기준 상대좌표 포함) ──
      // imgSubCropMap: region.id → [{ relX, relY, relW, relH, dataUrl, imageIdx }]
      const imgSubCropMap = {};
      await Promise.all(imgRegions.map(async (ir) => {
        const parent = ordered.find(r => r.id === ir.parentId);
        if (!parent) return;

        const { canvas: pgCanvas, viewport: pgVp } = pageCache[ir.page] || pageCache[parent.page] || {};
        if (!pgCanvas) return;

        // 이미지 서브 영역 크롭
        const ix = Math.round(ir.x * pgVp.width);
        const iy = Math.round(ir.y * pgVp.height);
        const iw = Math.max(Math.round(ir.w * pgVp.width), 1);
        const ih = Math.max(Math.round(ir.h * pgVp.height), 1);
        const cc = document.createElement('canvas');
        cc.width = iw; cc.height = ih;
        cc.getContext('2d').drawImage(pgCanvas, ix, iy, iw, ih, 0, 0, iw, ih);
        const dataUrl = await new Promise(res => {
          const rd = new FileReader();
          rd.onload = ev => res(ev.target.result);
          cc.toBlob(b => rd.readAsDataURL(b), 'image/png');
        });

        // 부모 문항 기준 상대 좌표 (크롭된 이미지 내 픽셀 좌표)
        const px = Math.round(parent.x * pgVp.width);
        const py = Math.round(parent.y * pgVp.height);
        const pw = Math.max(Math.round(parent.w * pgVp.width), 1);
        const ph = Math.max(Math.round(parent.h * pgVp.height), 1);
        const relX = Math.round(ix - px);
        const relY = Math.round(iy - py);

        if (!imgSubCropMap[ir.parentId]) imgSubCropMap[ir.parentId] = [];
        imgSubCropMap[ir.parentId].push({
          imageIdx: ir.imageIdx,
          dataUrl,
          // 부모 크롭 이미지(pw×ph) 내 좌표
          x1: Math.max(0, relX),
          y1: Math.max(0, relY),
          x2: Math.min(pw, relX + iw),
          y2: Math.min(ph, relY + ih),
        });
      }));

      throwIfAborted(signal);

      // ── Step 3: 제한된 동시성으로 API 호출 (cropDataUrl은 이미 확보됨) ──
      // Promise.all 로 N개 동시 폭주 시 Gemini RPM 한도에 걸려 일괄 429.
      // OCR_CONCURRENCY 만큼만 in-flight 유지하면서 빈 슬롯에 즉시 다음 작업 투입.
      let doneCount = 0;

      const apiResults = await runWithConcurrency(
        cropData,
        OCR_CONCURRENCY,
        async (entry) => {
          const { region, blob, cropDataUrl, mergedRegionIds, yOffsetByRegionId } = entry;
          console.log(`[crop-debug] ${region.problem_number}번 크롭 이미지:`, cropDataUrl);
          // 이미지 모드 영역: API 호출 없이 크롭만 사용
          if (region.insertMode === 'image') {
            doneCount++;
            setExtractMsg(`분석 완료 ${Math.min(doneCount, total)} / ${total}`);
            return { parsed: null, cropDataUrl, isImageMode: true };
          }

          const makeForm = (m, problemTypeHint = '') => {
            const f = new FormData();
            f.append('file', blob, `region_p${region.page}_${region.problem_number}.png`);
            f.append('mode', m);
            f.append('problem_number', region.problem_number != null ? String(region.problem_number) : '');
            if (selGrade)    f.append('grade',    selGrade);
            if (selSemester) f.append('semester', selSemester);
            if (selUnit)     f.append('unit',     selUnit);
            if ((m === 'single' || m === 'single_pipeline') && problemTypeHint) {
              f.append('problem_type_hint', problemTypeHint);
            }
            const subParts = [];
            for (const rid of mergedRegionIds) {
              const y0 = yOffsetByRegionId[rid] ?? 0;
              const subImgs = imgSubCropMap[rid] || [];
              for (const s of subImgs) {
                subParts.push({
                  x1: s.x1,
                  y1: s.y1 + y0,
                  x2: s.x2,
                  y2: s.y2 + y0,
                });
              }
            }
            if (subParts.length > 0) {
              f.append('exclude_regions', JSON.stringify(subParts));
            }
            return f;
          };

          // Step 3: 유형 분류 + (선잇기면 항목 추출) + (아니면 본문 파싱) — API 1회 (single_pipeline)
          // 사전 분류(휴리스틱/AI/사용자) 결과를 problem_type_hint 로 강하게 가이드한다.
          // 사용자가 직접 정한 경우는 항상 hint 로 보내고, 휴리스틱/AI 결과는 신뢰도와 무관하게
          // hint 로 보내 backend single_pipeline 이 분류 추론을 덜 흔들리게 한다.
          const userTypeHint = String(region.problemType || '').trim();
          const pipRes = await fetch('/api/parse-problem', {
            method: 'POST',
            body: makeForm('single_pipeline', userTypeHint),
            signal,
          });
          let pip = {};
          try {
            pip = await pipRes.json();
          } catch {
            pip = {};
          }
          if (region.groupRole !== 'passage') {
            doneCount++;
            setExtractMsg(`분석 완료 ${doneCount} / ${total}`);
          }
          if (!pipRes.ok) {
            const detail = typeof pip?.detail === 'string' ? pip.detail : JSON.stringify(pip?.detail || '');
            throw new Error(detail || `파싱 오류 (${pipRes.status})`);
          }

          // 사용자가 영역 그릴 때 확정한 유형이 있으면 그 결정을 최우선으로 사용
          // (AI가 흔들려도 사용자 의도를 따른다. 단, '선잇기'로 강제됐을 때 matching 비어 있으면
          //  기본 question 만 채워서 UnitTestReview 에서 보정 가능하게 둔다.)
          const aiType = (pip.problem_type || '기타').trim();
          const arrPreview = Array.isArray(pip.problems) ? pip.problems : [];
          const problemType = resolveProblemType(
            userTypeHint,
            aiType,
            String((arrPreview[0] || {}).question || ''),
          );
          console.log(
            `[single_pipeline] ${region.problem_number}번 → ${problemType}` +
            (userTypeHint ? ` (사전 분류: ${userTypeHint}, AI: ${aiType})` : ''),
          );

          if (problemType === '선잇기') {
            const normalized = normalizeMatchingPayload(pip.matching || {});
            return {
              parsed: {
                question: normalized.question,
                leftItems: normalized.leftItems,
                rightItems: normalized.rightItems,
                leftLabels: normalized.leftLabels,
                rightLabels: normalized.rightLabels,
                problemType: '선잇기',
                choices: null,
              },
              cropDataUrl,
            };
          }

          const arr = Array.isArray(pip.problems) ? pip.problems : [];
          const parsed = arr[0] ?? null;
          if (parsed && problemType === '표') {
            parsed.problemType = '표';
          }
          return { parsed, cropDataUrl };
        },
      );

      throwIfAborted(signal);

      const regionIdToUnitIndex = new Map();
      apiUnits.forEach((u, ui) => {
        u.regions.forEach((rr) => regionIdToUnitIndex.set(rr.id, ui));
      });
      const mergedPrimaryIdByUi = new Map();
      apiUnits.forEach((u, ui) => {
        if (u.kind === 'merged') {
          mergedPrimaryIdByUi.set(ui, u.regions[0].id);
        }
      });

      // ── Step 4: 결과 취합 (ordered 길이와 맞춤; 동일 번호 병합 시 보조 영역은 레이아웃에서 생략) ──
      const problems = ordered.map((region) => {
        const ui = regionIdToUnitIndex.get(region.id);
        const u = apiUnits[ui];
        if (u.kind === 'merged' && region.id !== mergedPrimaryIdByUi.get(ui)) {
          return { _skipInLayout: true };
        }
        const r = apiResults[ui];
        const cd = cropData[ui];
        const { region: logicalRegion, cropDataUrl, mergedRegionIds } = cd;
        const mergeSourceIds = mergedRegionIds.length > 1 ? mergedRegionIds : undefined;

        if (logicalRegion.insertMode === 'image') {
          return {
            number:       logicalRegion.problem_number,
            question:     '',
            choices:      null,
            bogi:         null,
            hasImage:     true,
            answer:       null,
            _uid:         logicalRegion.id,
            _mergeSourceIds: mergeSourceIds,
            _failed:      false,
            _cropDataUrl: cropDataUrl,
            _isImageOnly: true,
            _apiError:    null,
          };
        }

        if (r.status === 'fulfilled') {
          const { parsed, isImageMode } = r.value;
          const aiNumber = parsed?.questionNumber ?? parsed?.id ?? null;
          const useNumber = (aiNumber != null && Number.isInteger(aiNumber) && aiNumber > 0)
            ? aiNumber
            : logicalRegion.problem_number;
          if (isImageMode) {
            return {
              number: useNumber, question: '', choices: null, bogi: null,
              hasImage: true, answer: null, _uid: logicalRegion.id, _failed: false,
              _mergeSourceIds: mergeSourceIds,
              _cropDataUrl: cropDataUrl, _isImageOnly: true, _apiError: null,
            };
          }
          return {
            number:          useNumber,
            question:        parsed?.question ?? '',
            choices:         parsed?.choices  ?? null,
            bogi:            parsed?.bogi     ?? null,
            hasImage:        parsed?.hasImage ?? false,
            answer:          null,
            concept:         parsed?.concept  ?? '',
            geometry_config: parsed?.geometry_config ?? null,
            _uid:            logicalRegion.id,
            _mergeSourceIds: mergeSourceIds,
            _failed:         !parsed,
            _cropDataUrl:    cropDataUrl,
            _apiError:       null,
            ...(parsed?.problemType === '선잇기' ? {
              problemType: '선잇기',
              leftItems:   Array.isArray(parsed.leftItems)  ? parsed.leftItems  : [],
              rightItems:  Array.isArray(parsed.rightItems) ? parsed.rightItems : [],
              leftLabels:  Array.isArray(parsed.leftLabels)  ? parsed.leftLabels  : [],
              rightLabels: Array.isArray(parsed.rightLabels) ? parsed.rightLabels : [],
            } : {}),
          };
        }
        console.warn(`[parse-problem] ${logicalRegion.problem_number}번 오류:`, r.reason?.message);
        return {
          number:       logicalRegion.problem_number,
          question:     '',
          choices:      null,
          bogi:         null,
          hasImage:     false,
          answer:       null,
          _uid:         logicalRegion.id,
          _mergeSourceIds: mergeSourceIds,
          _failed:      true,
          _cropDataUrl: cropDataUrl,
          _apiError:    r.reason?.message ?? '알 수 없는 오류',
        };
      });

      const failCount = problems.filter(p => p._failed && !p._skipInLayout).length;
      if (failCount > 0 && !signal.aborted) {
        setExtractMsg(`⚠️ ${failCount}개 인식 실패 — 검수 페이지에서 직접 입력하세요`);
        await new Promise(r => setTimeout(r, 2000));
      }

      throwIfAborted(signal);

      // ── 묶음 그룹 처리: groupId가 있는 항목들을 group 객체로 변환 ──
      const groupMap = {}; // groupId → { passageItem, questionItems[] }
      const ungrouped = [];

      // problems[]는 ordered[]와 길이를 맞추지만, 세로 병합(_skipInLayout) 때문에 인덱스 매칭이 어긋날 수 있다.
      // region.id(_uid) 기반으로 다시 매핑해 묶음(보기+소문항)이 깨지지 않게 한다.
      const uidToProblem = new Map();
      const mergeIdToPrimary = new Map();
      for (const p of problems) {
        if (p?._uid == null) continue;
        const uid = String(p._uid);
        uidToProblem.set(uid, p);
        const ids = Array.isArray(p._mergeSourceIds) && p._mergeSourceIds.length ? p._mergeSourceIds : [p._uid];
        for (const mid of ids) mergeIdToPrimary.set(String(mid), p);
      }

      const pushedUngrouped = new Set(); // uid 중복 방지
      for (let i = 0; i < ordered.length; i++) {
        const region = ordered[i];
        const prob =
          uidToProblem.get(String(region.id)) ??
          mergeIdToPrimary.get(String(region.id));
        if (!prob || prob._skipInLayout) continue;

        if (region.groupId != null) {
          if (!groupMap[region.groupId]) {
            groupMap[region.groupId] = { passageItem: null, questionItems: [], firstIdx: i };
          }
          if (region.groupRole === 'passage') {
            groupMap[region.groupId].passageItem = prob;
          } else {
            groupMap[region.groupId].questionItems.push({ ...prob, _groupOrder: region.groupOrder });
          }
        } else if (prob._uid != null) {
          const uid = String(prob._uid);
          if (!pushedUngrouped.has(uid)) {
            pushedUngrouped.add(uid);
            ungrouped.push({ item: prob, origIdx: i });
          }
        }
      }

      // 그룹 객체 생성
      const groupItems = await Promise.all(Object.entries(groupMap).map(async ([gid, { passageItem, questionItems, firstIdx }]) => {
        const questions = questionItems
          .sort((a, b) => a._groupOrder - b._groupOrder)
          .map(({ _groupOrder, ...q }) => q);
        const nums = questions.map(q => q.number).filter(Boolean);
        const label = nums.length >= 2 ? `${Math.min(...nums)}~${Math.max(...nums)}` : String(nums[0] ?? '');
        const passageImage = passageItem?._cropDataUrl || passageItem?.image_b64 || null;
        const qImgs = questions.map((q) => q._cropDataUrl || q.image_b64 || null).filter(Boolean);
        // 묶음 전체 원본(보기+문항들) 한 장으로도 만들어 저장 (AI가이드 화면 등에서 확실히 '보기'가 보이게)
        const stacked = await stackDataUrlsToSingle(passageImage, qImgs).catch(() => null);
        return {
          _origIdx: firstIdx,
          item: {
            type: 'group',
            label,
            passage: passageItem?.question || '',
            // 공통 보기(지문) 영역 캡처 — 보관함/열기/가이드에서 3분할 원본 이미지로 사용
            passageImage_b64: passageImage,
            groupStackImage_b64: stacked,
            questions,
          },
        };
      }));

      // 원래 선택 순서대로 정렬 — sortKey로 통일 (ungrouped: origIdx, group: firstIdx)
      const allItems = [
        ...ungrouped.map(u => ({ item: u.item, sortKey: u.origIdx })),
        ...groupItems.map(g => ({ item: g.item, sortKey: g._origIdx })),
      ].sort((a, b) => a.sortKey - b.sortKey);

      const finalProblems = allItems.map(a => a.item);

      // ── 이미지 서브 영역: imgSubCropMap에서 부모 문항에 _imageRegions 첨부 ──
      for (const prob of finalProblems) {
        const uids = prob._mergeSourceIds?.length ? prob._mergeSourceIds : [prob._uid];
        const mergedSubs = [];
        for (const uid of uids) {
          const subImgs = imgSubCropMap[uid];
          if (subImgs && subImgs.length > 0) {
            mergedSubs.push(...[...subImgs].sort((a, b) => a.imageIdx - b.imageIdx));
          }
        }
        if (mergedSubs.length > 0) {
          prob._imageRegions = mergedSubs.map((s) => s.dataUrl);
        }
      }

      throwIfAborted(signal);

      await persistReviewToStorageAndNavigate(finalProblems);
    } catch (err) {
      if (err.name === 'AbortError') {
        setError('');
        // 이전 실행을 새 검수 시작으로 덮어쓸 때 나는 AbortError는 제외
        if (myRunGen === aiReviewRunGenRef.current) {
          offerResumeChoiceAfterAiStopRef.current = true;
        }
      } else {
        setError('검수 준비 중 오류: ' + err.message);
      }
    } finally {
      reviewAbortRef.current = null;
      reviewActionLockRef.current = false;
      setExtracting(false);
      setExtractMsg('');
    }
  }

  // ── 페이지 이동 (영역은 유지) ──
  function changePage(delta) {
    const next = currentPage + delta;
    if (next < 1 || next > totalPages) return;
    setCurrentPage(next);
    setRecs([]);       // 추천은 페이지마다 새로 계산
    setSaveMsg('');
  }

  const ocrSummaryText = useMemo(() => {
    const done = Object.values(ocrStatusByKey).filter((s) => s === 'done').length;
    const loading = Object.values(ocrStatusByKey).filter((s) => s === 'loading').length;
    if (loading > 0) return `${done}완료 · ${loading} 진행`;
    return `${done}완료`;
  }, [ocrStatusByKey]);

  // ── 그리는 중 박스 ──
  const currentBox = drawing ? {
    x: Math.min(startPt.x, curPt.x),
    y: Math.min(startPt.y, curPt.y),
    w: Math.abs(curPt.x - startPt.x),
    h: Math.abs(curPt.y - startPt.y),
  } : null;

  // ════════════════════════════════════════════
  // 렌더
  // ════════════════════════════════════════════
  return (
    <div
      className={`dashboard-container${viewStep === 'confirm' ? ' dashboard-container--prs-confirm' : ''}`}
    >
      {/* ── 헤더 ── */}
      <header
        className={`dashboard-header${viewStep === 'confirm' ? ' dashboard-header--prs-confirm' : ''}`}
      >
        <div className="header-left">
          {viewStep !== 'confirm' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => navigate('/pdf-extractor')}
            >
              ← 시험지 OCR로
            </button>
          )}
          <span style={{ fontSize: viewStep === 'confirm' ? 22 : 26 }}>
            {viewStep === 'confirm' ? '📋' : '✏️'}
          </span>
          <div>
            <h1 className="header-title">
              {viewStep === 'confirm' ? '문항 검수' : '영역 수동 선택'}
            </h1>
            {viewStep !== 'confirm' && (
              <p className="header-subtitle">
                PDF에서 문항 영역을 드래그(좌상단=번호) · 빨간 네모=채점 칸
              </p>
            )}
          </div>
        </div>
        {viewStep !== 'confirm' && (
          <div className="header-right">
            <span className="prs-history-badge">
              저장 기록 {history.length}개
              {ENABLE_SAVED_REGION_RECOMMENDATIONS && history.length >= REC_THRESHOLD && (
                <span className="prs-rec-active">추천 ON</span>
              )}
            </span>
          </div>
        )}
      </header>

      {/* ── 전체화면 분석 진행 오버레이 ── */}
      {extracting && (
        <div className="prs-extract-overlay">
          <div className="prs-extract-card">
            <span className="spinner prs-extract-spinner" />
            <p className="prs-extract-title">Gemini AI가 문제를 분석하고 있습니다</p>
            <p className={`prs-extract-msg ${extractMsg.startsWith('⚠️') ? 'error' : ''}`}>
              {extractMsg || '준비 중...'}
            </p>
            <p className="prs-extract-sub">
              {extractMsg.startsWith('⚠️')
                ? '곧 검수 페이지로 이동합니다'
                : viewStep === 'confirm'
                  ? '확인·미확인 문항 OCR을 마무리합니다'
                  : '전체 문항을 동시에 분석합니다'}
            </p>
            <button
              type="button"
              className="prs-extract-stop"
              onClick={handleStopAiReview}
            >
              중지
            </button>
          </div>
        </div>
      )}

      {/* ── 검수 시작 시: 기존 검수 데이터가 있으면 유지 vs 새 검수 선택 ── */}
      {reviewChoiceOpen && (
        <div className="prs-review-choice-overlay" role="dialog" aria-modal="true" aria-labelledby="prs-review-choice-title">
          <div className="prs-review-choice-card">
            <p id="prs-review-choice-title" className="prs-review-choice-title">검수를 어떻게 진행할까요?</p>
            <p className="prs-review-choice-desc">
              방금 AI 검수를 중지했습니다. 저장되어 있던 문제 목록을 그대로 이어서 볼지,
              처음부터 다시 분석할지 선택해 주세요.
            </p>
            <div className="prs-review-choice-actions">
              <button type="button" className="btn btn-outline" onClick={() => setReviewChoiceOpen(false)} disabled={extracting || finishingReview}>
                취소
              </button>
              <button type="button" className="btn btn-outline" onClick={handleReviewChoiceNavigateKeep} disabled={extracting || finishingReview}>
                이전 검수 결과 유지
              </button>
              <button type="button" className="btn btn-primary" onClick={handleReviewChoiceRunFresh} disabled={extracting || finishingReview}>
                새로 AI 검수
              </button>
            </div>
          </div>
        </div>
      )}

      <main
        className={`dashboard-main prs-main${viewStep === 'confirm' ? ' prs-main--confirm' : ''}`}
      >
        {error && (
          <div className="alert alert-error">
            ⚠️ {error}
            <button className="alert-close" onClick={() => setError('')}>×</button>
          </div>
        )}

        {/* ── PDF 선택 전 ── */}
        {!pdfFile && (
          <div style={{ maxWidth: 640, margin: '0 auto' }}>

            {/* 불러오기 성공 배너 */}
            {loadMsg && (
              <div className="prs-loaded-banner">
                {loadMsg}
                <button
                  className="btn btn-ghost btn-xs"
                  style={{ marginLeft: 'auto', flexShrink: 0 }}
                  onClick={() => setLoadMsg('')}
                >×</button>
              </div>
            )}

            {/* 로드된 영역 있으면 드롭존에 표시 */}
            {regions.length > 0 && !loadMsg && (
              <div className="prs-loaded-banner" style={{ background: '#f0fdf4', borderColor: '#86efac', color: '#166534' }}>
                📦 <strong>{regions.length}개 영역</strong>이 준비됐습니다. PDF를 업로드하면 박스가 표시됩니다.
              </div>
            )}

            {/* 임시저장 복원 배너 */}
            {hasDraft && (
              <div className="prs-draft-banner">
                <div>
                  <strong>💾 저장되지 않은 작업이 있습니다</strong>
                  <p style={{ fontSize: 12, margin: '2px 0 0', color: '#92400e' }}>
                    마지막으로 선택한 영역을 복원할 수 있습니다
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button className="btn btn-primary btn-sm" onClick={restoreDraft}>
                    복원하기
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={clearDraft}>
                    삭제
                  </button>
                </div>
              </div>
            )}

            <PdfDropZone onFile={setPdfFile} />

            {/* 저장된 시험 목록 */}
            {history.length > 0 && (
              <div className="prs-saved-list-card">
                <h3 className="prs-saved-list-title">
                  📂 저장된 시험 불러오기
                  <span className="prs-panel-count" style={{ marginLeft: 8 }}>{history.length}개</span>
                </h3>
                <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                  PDF를 먼저 업로드한 후 불러오기를 누르면 영역이 자동으로 표시됩니다
                </p>
                <div className="prs-saved-list">
                  {[...history].reverse().map((rec, i) => (
                    <div key={i} className="prs-saved-item">
                      <div className="prs-saved-item-info">
                        <span className="prs-saved-item-name">
                          {rec.exam_name || rec.pdf_name || '(제목 없음)'}
                        </span>
                        <span className="prs-saved-item-meta">
                          {rec.grade && <span className="prs-history-tag">{rec.grade} {rec.semester}</span>}
                          {countQuestionRegions(rec.regions)}문항
                          {rec.saved_at && ` · ${new Date(rec.saved_at).toLocaleDateString('ko-KR')}`}
                        </span>
                      </div>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => {
                          loadFromRecord(rec);
                          setLoadMsg(
                            `✅ "${rec.exam_name || rec.pdf_name}" 영역 로드 — 같은 PDF를 업로드하면 박스가 표시됩니다.`,
                          );
                        }}
                      >
                        불러오기
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="ocr-guide" style={{ marginTop: 16 }}>
              <h3 className="ocr-guide-title">📌 사용 방법</h3>
              <ul className="ocr-guide-list">
                <li>PDF를 업로드하면 캔버스에 표시됩니다</li>
                <li>영역을 그리면 <strong>자동으로 해당 부분이 캡처</strong>되어 목록에 미리보기로 보이고, 임시 저장·Firebase 저장 시 함께 쓰입니다</li>
                <li>영역 왼쪽 위 PDF 텍스트에서 문항 번호를 읽어 반영합니다(텍스트가 없으면 임시 번호·수정 가능)</li>
                <li>박스는 <strong>「16.」 번호 줄부터</strong> (1)(2) <strong>답안 줄까지</strong> 넉넉히 포함해 주세요</li>
                <li>
                  좌표 저장·OCR은 <strong>원본 문제 PDF</strong>(학생 이름·L자 넣기 전 파일) 기준이 가장 안전합니다. L자는
                  인쇄 시 모서리에만 붙고 본문 위치는 바뀌지 않습니다. <strong>스캔본 PDF</strong>로 박스를 그리면 스캔
                  정리에서 L자 보정이 <strong>두 번</strong> 적용되어 어긋날 수 있습니다
                </li>
                <li>
                  스캔 자동정리 미리보기의 <strong>빨간</strong> 영역은 채점용 <strong>번호·체크 띠</strong>이며, 여기서
                  그린 초록 박스와 <strong>같은 범위가 아닙니다</strong>(초록 점선이 저장 박스)
                </li>
                <li>같은 페이지·같은 번호면 자동으로 세로 병합해 분석합니다. 페이지가 다르거나 나뉘어 인식됐을 때는 목록에서 <strong>위·아래 순서</strong>를 맞춘 뒤 <strong>＋ 위아래 병합</strong>으로 한 문항으로 이을 수 있습니다(왼쪽 ⋮⋮으로 순서 변경)</li>
                <li>박스의 × 버튼을 누르면 해당 영역이 삭제됩니다</li>
              </ul>
            </div>
          </div>
        )}

        {/* ── PDF 로드 후 ── */}
        {pdfFile && pdfDoc && viewStep === 'confirm' && (
          <ProblemConfirmStep
            units={confirmUnits}
            confirmIndex={confirmIndex}
            onConfirmIndexChange={setConfirmIndex}
            confirmedKeys={confirmedKeys}
            ocrStatusByKey={ocrStatusByKey}
            regions={regions}
            previewUrlByKey={previewUrlByKey}
            onSetProblemType={setRegionProblemType}
            onSetHasImage={setRegionHasImage}
            onDrawImage={handleDrawImageFromConfirm}
            onBackToSelect={handleBackToRegionSelect}
            onConfirmCurrent={handleConfirmCurrent}
            onStartReview={() => void handleFinishReviewFromConfirm()}
            finishingReview={finishingReview || extracting}
            ocrSummaryText={ocrSummaryText}
          />
        )}

        {pdfFile && pdfDoc && viewStep === 'select' && (
          <div className="prs-workspace">
            {/* ── 사이드바 ── */}
            <aside className="prs-sidebar">

              {/* ── ① 커리큘럼 선택 패널 ── */}
              <div className="prs-panel prs-sel-panel">
                <div className="prs-panel-header">
                  <span>시험 분류 <span style={{ color: '#ef4444', fontSize: 11 }}>*필수</span></span>
                  {selGrade && selSemester && selUnit ? (
                    <span className="prs-panel-count" style={{ background: '#10b981' }}>완료</span>
                  ) : (
                    <span className="prs-panel-count" style={{ background: '#ef4444' }}>미선택</span>
                  )}
                </div>

                {/* 선택된 분류 요약 */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  {selGrade    && <span className="prs-history-tag">{selGrade}</span>}
                  {selSemester && <span className="prs-history-tag">{selSemester}</span>}
                  {selUnit     && <span className="prs-history-tag">{selUnit}</span>}
                  {(!selGrade || !selSemester || !selUnit) && (
                    <span style={{ color: '#ef4444', fontSize: 12 }}>
                      학년·학기·단원이 선택되지 않았습니다
                    </span>
                  )}
                </div>
                <p className="prs-solution-hint">
                  학년, 학기, 단원은 '시험지 업로드'에서 수정할 수 있습니다.
                </p>

                {/* 제목 (자동 입력 + 수동 수정 가능) */}
                <p className="prs-sel-label" style={{ marginTop: 10 }}>
                  시험 제목
                  <span style={{ fontWeight: 400, color: '#7c3aed', marginLeft: 4 }}>(직접 수정 가능)</span>
                </p>
                <input
                  type="text"
                  className="prs-title-input"
                  placeholder="학년·학기·단원 선택 시 자동 입력"
                  value={examTitle}
                  onChange={e => setExamTitle(e.target.value)}
                  maxLength={60}
                />
              </div>

              {ENABLE_DEV_REGION_COORD_SAVE && (
                <div
                  className="prs-panel"
                  style={{
                    borderColor: '#fcd34d',
                    background: '#fffbeb',
                  }}
                >
                  <div className="prs-panel-header">
                    <span>영역 좌표 저장</span>
                    <span className="prs-panel-count" style={{ background: '#d97706' }}>
                      개발
                    </span>
                  </div>
                  <p style={{ fontSize: 12, color: '#92400e', lineHeight: 1.5, margin: '0 0 10px' }}>
                    스캔본 자동정리·채점 크롭용 좌표만 <code>backend/data/pdf_regions.json</code>에
                    저장합니다. 문항마다 <strong>번호 감싼 채점 네모(markBox)</strong> 좌표가 함께 저장됩니다.
                    <strong>보기(passage) 영역도 함께</strong> 저장됩니다. 동일 PDF
                    파일명은 덮어쓰기. {devAiEnabled ? '(AI 분류 ON이면 classify 호출이 발생할 수 있음)' : '(AI 호출 없음)'}
                  </p>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, margin: '0 0 10px' }}>
                    <input
                      type="checkbox"
                      checked={devAiEnabled}
                      onChange={(e) => setDevAiEnabled(e.target.checked)}
                    />
                    <span style={{ color: '#92400e' }}>
                      AI 분류 사용 (개발 토글) — 끄면 박스 그릴 때 <code>/api/parse-problem</code> 호출을 하지 않습니다
                    </span>
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={coordSaving || !regions.length}
                      onClick={handleSaveRegionCoordinates}
                    >
                      {coordSaving ? (
                        <>
                          <span className="spinner" /> 저장 중…
                        </>
                      ) : (
                        '영역 좌표 저장'
                      )}
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      disabled={!regions.length}
                      onClick={handleCopyCoordinatesJson}
                    >
                      JSON 복사
                    </button>
                  </div>
                  {coordSaveMsg ? (
                    <p
                      className={`prs-save-msg ${coordSaveMsg.startsWith('✅') ? 'success' : 'error'}`}
                      style={{ marginBottom: coordJsonPreview ? 8 : 0 }}
                    >
                      {coordSaveMsg}
                    </p>
                  ) : null}
                  {coordJsonPreview ? (
                    <textarea
                      readOnly
                      value={coordJsonPreview}
                      rows={6}
                      style={{
                        width: '100%',
                        fontSize: 10,
                        fontFamily: 'ui-monospace, monospace',
                        border: '1px solid #fde68a',
                        borderRadius: 6,
                        padding: 8,
                        resize: 'vertical',
                      }}
                    />
                  ) : null}
                </div>
              )}

              {/* ── ② 영역 목록 패널 ── */}
              <div className="prs-panel">
                <div className="prs-panel-header">
                  <span>선택된 영역</span>
                  <span className="prs-panel-count">{regions.filter(r => r.groupRole !== 'passage').length}문항 {regions.filter(r => r.groupRole === 'passage').length > 0 ? `+${regions.filter(r => r.groupRole === 'passage').length}보기` : ''}</span>
                </div>

                {/* ── 묶음 선택 모드 상태 배너 ── */}
                {groupMode ? (
                  <div className="prs-group-mode-banner">
                    <div className="prs-group-mode-steps">
                      {/* 보기 */}
                      <span className={`prs-gstep ${groupStep === 0 ? 'active' : groupStep > 0 ? 'done' : ''}`}>
                        {groupStep > 0 ? '✓' : '①'} 보기
                      </span>
                      {/* 각 문항 */}
                      {Array.from({ length: groupQCount }, (_, i) => (
                        <span
                          key={i}
                          className={`prs-gstep ${groupStep === i + 1 ? 'active' : groupStep > i + 1 ? 'done' : ''}`}
                        >
                          {groupStep > i + 1 ? '✓' : `${'①②③④⑤'[i + 1]}`} {i + 1}번 문제
                        </span>
                      ))}
                    </div>
                    <p className="prs-group-mode-hint">
                      {groupStep === 0 ? '공통 보기(지문) 영역을 드래그하세요' : `${groupStep}번 문제 영역을 드래그하세요`}
                    </p>
                    <button className="btn btn-ghost btn-xs prs-group-cancel" onClick={cancelGroupMode}>
                      취소
                    </button>
                  </div>
                ) : (
                  /* 묶음 시작 버튼 영역 */
                  <div className="prs-group-start-row">
                    <span className="prs-group-start-label">묶음 선택</span>
                    {[2, 3, 4, 5].map(n => (
                      <button
                        key={n}
                        className="btn btn-outline btn-xs prs-group-start-btn"
                        onClick={() => startGroupMode(n)}
                        title={`보기 1개 + 문항 ${n}개 묶음`}
                      >
                        +{n}문항
                      </button>
                    ))}
                  </div>
                )}

                {regions.length === 0 ? (
                  <p className="prs-empty-hint">PDF에서 드래그하여<br/>영역을 선택하세요</p>
                ) : (
                  <div className="prs-region-list">
                    {(() => {
                      const chunks = [];
                      const seenGroups = new Set();
                      for (const r of regions) {
                        if (r.groupId != null) {
                          if (!seenGroups.has(r.groupId)) {
                            seenGroups.add(r.groupId);
                            chunks.push({ type: 'group', groupId: r.groupId });
                          }
                        } else if (!r.isImageRegion) {
                          chunks.push({ type: 'standalone', parent: r });
                        }
                      }

                      const listItems = [];
                      for (let ci = 0; ci < chunks.length; ci++) {
                        const ch = chunks[ci];
                        if (ch.type === 'group') {
                          listItems.push({ kind: 'group', groupId: ch.groupId });
                          continue;
                        }
                        const nxt = chunks[ci + 1];
                        if (nxt?.type === 'standalone' && ch.parent.vmMergeAfter === nxt.parent.id) {
                          listItems.push({ kind: 'vmMerged', upper: ch.parent, lower: nxt.parent });
                          ci += 1;
                          continue;
                        }
                        listItems.push({ kind: 'standalone', parent: ch.parent });
                      }

                      const renderImgChildren = (parentR) => {
                        const imgs = regions
                          .filter((ir) => ir.isImageRegion && ir.parentId === parentR.id)
                          .sort((a, b) => (a.imageIdx || 0) - (b.imageIdx || 0));
                        return imgs.map((ir) => (
                          <div
                            key={ir.id}
                            className={`prs-region-item prs-region-item--imgchild ${ir.page === currentPage ? 'current-page' : ''}`}
                          >
                            <span className="prs-imgmode-badge" title="이미지 영역">🖼️</span>
                            <span style={{ fontSize: 11, color: '#6b7280', marginRight: 4 }}>
                              {problemDisplayLabel(parentR.problem_number)}번 이미지{ir.imageIdx}
                            </span>
                            {ir.cropDataUrl && (
                              <img src={ir.cropDataUrl} alt="" className="prs-region-thumb" />
                            )}
                            <button
                              type="button"
                              className="prs-delete-btn"
                              onClick={() => deleteRegion(ir.id)}
                              title="이미지 영역 삭제"
                            >✕</button>
                          </div>
                        ));
                      };

                      const handleDropOnTarget = (insertBeforeParentId, selfId) => (e) => {
                        e.preventDefault();
                        const mergedRaw = e.dataTransfer.getData('application/prs-vm-merged');
                        if (mergedRaw) {
                          try {
                            const { top, bot } = JSON.parse(mergedRaw);
                            if (top && bot && top !== insertBeforeParentId && bot !== insertBeforeParentId) {
                              moveVmMergedCard(top, bot, insertBeforeParentId);
                            }
                          } catch (_) { /* noop */ }
                          dragStandaloneParentRef.current = null;
                          return;
                        }
                        const raw = e.dataTransfer.getData('application/prs-parent-id');
                        const from = raw ? parseInt(raw, 10) : dragStandaloneParentRef.current;
                        if (from && from !== selfId && from !== insertBeforeParentId) {
                          moveStandaloneBlock(from, insertBeforeParentId);
                        }
                        dragStandaloneParentRef.current = null;
                      };

                      const lastMoveIdx = listItems.reduce((acc, it, i) => {
                        if (it.kind === 'standalone' || it.kind === 'vmMerged') return i;
                        return acc;
                      }, -1);

                      return listItems.map((item, ii) => {
                        if (item.kind === 'group') {
                          const grpRegions = regions.filter((x) => x.groupId === item.groupId);
                          const qNums = grpRegions.filter((x) => x.groupRole === 'question').map((x) => x.problem_number);
                          const nums = qNums.map((x) => problemBaseInt(x)).filter((n) => Number.isFinite(n));
                          const label = nums.length >= 2 ? `${Math.min(...nums)}~${Math.max(...nums)}` : String(qNums[0] ?? '?');
                          return (
                            <div key={`grp-${item.groupId}`} className="prs-group-block">
                              <div className="prs-group-block-header">
                                🗂️ 묶음 [{label}]
                                <button
                                  type="button"
                                  className="prs-delete-btn"
                                  onClick={() => {
                                    grpRegions.forEach((gr) => deleteRegion(gr.id));
                                  }}
                                  title="묶음 전체 삭제"
                                >✕</button>
                              </div>
                              {grpRegions.map((gr) => (
                                <React.Fragment key={gr.id}>
                                  <div className={`prs-region-item prs-region-item--grouped ${gr.page === currentPage ? 'current-page' : ''}`}>
                                    <span className="prs-group-role-badge">
                                      {gr.groupRole === 'passage' ? '보기' : `${gr.groupOrder}번`}
                                    </span>
                                    {gr.cropDataUrl && (
                                      <img src={gr.cropDataUrl} alt="" className="prs-region-thumb" />
                                    )}
                                    <button type="button" className="prs-delete-btn" onClick={() => deleteRegion(gr.id)} title="삭제">✕</button>
                                  </div>
                                  {renderImgChildren(gr)}
                                </React.Fragment>
                              ))}
                            </div>
                          );
                        }

                        if (item.kind === 'vmMerged') {
                          const { upper: ru, lower: rl } = item;
                          const titleNum = (() => {
                            const n1 = problemBaseInt(ru.problem_number);
                            if (Number.isFinite(n1) && n1 >= 1) return n1;
                            const n2 = problemBaseInt(rl.problem_number);
                            if (Number.isFinite(n2) && n2 >= 1) return n2;
                            return '?';
                          })();

                          const handleMergeSlotDrop = (slotParentId) => (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const inner = e.dataTransfer.getData('application/prs-merged-inner');
                            if (inner) {
                              try {
                                const { a, b, from } = JSON.parse(inner);
                                if (a === ru.id && b === rl.id && from !== slotParentId) {
                                  swapVerticalMergeOrder(ru.id, rl.id);
                                }
                              } catch (_) { /* noop */ }
                              return;
                            }
                            handleDropOnTarget(slotParentId, slotParentId)(e);
                          };

                          return (
                            <div key={`vm-${ru.id}-${rl.id}`} className="prs-vm-merge-card">
                              <div className="prs-vm-merge-card-head">
                                <span
                                  className="prs-drag-handle"
                                  title="합친 문항 전체 이동"
                                  draggable
                                  onDragStart={(e) => {
                                    e.stopPropagation();
                                    e.dataTransfer.setData('application/prs-vm-merged', JSON.stringify({ top: ru.id, bot: rl.id }));
                                    e.dataTransfer.effectAllowed = 'move';
                                  }}
                                  onDragEnd={() => {
                                    dragStandaloneParentRef.current = null;
                                  }}
                                >⋮⋮</span>
                                <span className="prs-vm-merge-card-title">{titleNum}번 문항</span>
                                <div className="prs-vm-merge-card-head-actions">
                                  <button
                                    type="button"
                                    className="prs-vm-unlink-box"
                                    onClick={() => clearVerticalMergeFrom(ru.id)}
                                  >연결 해제</button>
                                </div>
                              </div>
                              <div
                                className={`prs-standalone-wrap prs-standalone-wrap--inmerge ${ru.page === currentPage ? 'current-page' : ''}`}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  e.dataTransfer.dropEffect = 'move';
                                }}
                                onDrop={handleMergeSlotDrop(ru.id)}
                              >
                                <div className={`prs-region-item ${ru.page === currentPage ? 'current-page' : ''}`}>
                                  <span
                                    className="prs-drag-handle"
                                    title="드래그하여 위·아래 조각 순서 변경"
                                    draggable
                                    onDragStart={(e) => {
                                      e.stopPropagation();
                                      e.dataTransfer.setData(
                                        'application/prs-merged-inner',
                                        JSON.stringify({ a: ru.id, b: rl.id, from: ru.id })
                                      );
                                      e.dataTransfer.effectAllowed = 'move';
                                    }}
                                    onDragEnd={() => {}}
                                  >⋮⋮</span>
                                  <span className="prs-vm-slot-label">{mergeRowSideLabel(ru, 'upper', rl)}</span>
                                  {ru.detecting ? (
                                    <span className="prs-region-detecting">🔍</span>
                                  ) : (
                                    <input
                                      key={`sid-${ru.id}-${ru.problem_number}`}
                                      type="text"
                                      className="prs-region-num-input prs-region-num-input--wide"
                                      defaultValue={ru.problem_number ?? ''}
                                      title="예: 10 또는 10-1"
                                      onBlur={(e) => {
                                        const v = parseProblemKeyInput(e.target.value);
                                        if (v != null) {
                                          tryUpdateRegionProblemKey(ru.id, v, () => {
                                            e.target.value = String(ru.problem_number ?? '');
                                          });
                                        } else {
                                          e.target.value = String(ru.problem_number ?? '');
                                        }
                                      }}
                                      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                                    />
                                  )}
                                  {totalPages > 1 && (
                                    <span className="prs-region-page">{ru.page}p</span>
                                  )}
                                  {ru.cropDataUrl ? (
                                    <img src={ru.cropDataUrl} alt="" className="prs-region-thumb" title="자동 캡처됨" />
                                  ) : (
                                    <span className="prs-region-thumb-spacer" aria-hidden />
                                  )}
                                  <button type="button" className="prs-delete-btn" onClick={() => deleteRegion(ru.id)} title="삭제">✕</button>
                                </div>
                                {renderImgChildren(ru)}
                              </div>
                              <div
                                className={`prs-standalone-wrap prs-standalone-wrap--inmerge ${rl.page === currentPage ? 'current-page' : ''}`}
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  e.dataTransfer.dropEffect = 'move';
                                }}
                                onDrop={handleMergeSlotDrop(rl.id)}
                              >
                                <div className={`prs-region-item ${rl.page === currentPage ? 'current-page' : ''}`}>
                                  <span
                                    className="prs-drag-handle"
                                    title="드래그하여 위·아래 조각 순서 변경"
                                    draggable
                                    onDragStart={(e) => {
                                      e.stopPropagation();
                                      e.dataTransfer.setData(
                                        'application/prs-merged-inner',
                                        JSON.stringify({ a: ru.id, b: rl.id, from: rl.id })
                                      );
                                      e.dataTransfer.effectAllowed = 'move';
                                    }}
                                    onDragEnd={() => {}}
                                  >⋮⋮</span>
                                  <span className="prs-vm-slot-label">{mergeRowSideLabel(rl, 'lower', ru)}</span>
                                  {rl.detecting ? (
                                    <span className="prs-region-detecting">🔍</span>
                                  ) : (
                                    <input
                                      key={`sid-${rl.id}-${rl.problem_number}`}
                                      type="text"
                                      className="prs-region-num-input prs-region-num-input--wide"
                                      defaultValue={rl.problem_number ?? ''}
                                      title="예: 10 또는 10-2"
                                      onBlur={(e) => {
                                        const v = parseProblemKeyInput(e.target.value);
                                        if (v != null) {
                                          tryUpdateRegionProblemKey(rl.id, v, () => {
                                            e.target.value = String(rl.problem_number ?? '');
                                          });
                                        } else {
                                          e.target.value = String(rl.problem_number ?? '');
                                        }
                                      }}
                                      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                                    />
                                  )}
                                  {totalPages > 1 && (
                                    <span className="prs-region-page">{rl.page}p</span>
                                  )}
                                  {rl.cropDataUrl ? (
                                    <img src={rl.cropDataUrl} alt="" className="prs-region-thumb" title="자동 캡처됨" />
                                  ) : (
                                    <span className="prs-region-thumb-spacer" aria-hidden />
                                  )}
                                  <button type="button" className="prs-delete-btn" onClick={() => deleteRegion(rl.id)} title="삭제">✕</button>
                                </div>
                                {renderImgChildren(rl)}
                              </div>
                            </div>
                          );
                        }

                        const r = item.parent;
                        const nextList = listItems[ii + 1];
                        const nextParent = nextList?.kind === 'standalone' ? nextList.parent : null;
                        const showPillMerge =
                          nextParent &&
                          canSuggestVerticalMerge(r, nextParent) &&
                          r.vmMergeAfter !== nextParent.id;

                        return (
                          <React.Fragment key={r.id}>
                            <div
                              className={`prs-standalone-wrap ${r.page === currentPage ? 'current-page' : ''}`}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.dataTransfer.dropEffect = 'move';
                              }}
                              onDrop={handleDropOnTarget(r.id, r.id)}
                            >
                              <div className={`prs-region-item ${r.page === currentPage ? 'current-page' : ''}`}>
                                <span
                                  className="prs-drag-handle"
                                  title="드래그하여 순서 변경"
                                  draggable
                                  onDragStart={(e) => {
                                    dragStandaloneParentRef.current = r.id;
                                    e.dataTransfer.setData('application/prs-parent-id', String(r.id));
                                    e.dataTransfer.effectAllowed = 'move';
                                  }}
                                  onDragEnd={() => {
                                    dragStandaloneParentRef.current = null;
                                  }}
                                >⋮⋮</span>
                                {r.detecting ? (
                                  <span className="prs-region-detecting">🔍</span>
                                ) : (
                                  <input
                                    key={`sid-${r.id}-${r.problem_number}`}
                                    type="text"
                                    className="prs-region-num-input prs-region-num-input--wide"
                                    defaultValue={r.problem_number ?? ''}
                                    title="예: 10 또는 10-1"
                                    onBlur={(e) => {
                                      const v = parseProblemKeyInput(e.target.value);
                                      if (v != null) {
                                        tryUpdateRegionProblemKey(r.id, v, () => {
                                          e.target.value = String(r.problem_number ?? '');
                                        });
                                      } else {
                                        e.target.value = String(r.problem_number ?? '');
                                      }
                                    }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
                                  />
                                )}
                                {totalPages > 1 && (
                                  <span className="prs-region-page">{r.page}p</span>
                                )}
                                {r.cropDataUrl ? (
                                  <img src={r.cropDataUrl} alt="" className="prs-region-thumb" title="자동 캡처됨" />
                                ) : (
                                  <span className="prs-region-thumb-spacer" aria-hidden />
                                )}
                                <button
                                  type="button"
                                  className="prs-delete-btn"
                                  onClick={() => deleteRegion(r.id)}
                                  title="삭제"
                                >✕</button>
                              </div>
                              {renderImgChildren(r)}
                            </div>

                            {showPillMerge && (
                              <div className="prs-vm-pill-row">
                                <button
                                  type="button"
                                  className="prs-vm-pill-btn"
                                  onClick={() => linkVerticalMerge(r.id, nextParent.id)}
                                  title="같은 문제로 세로 병합"
                                >+같은 문항 합치기</button>
                              </div>
                            )}

                            {ii === lastMoveIdx && (
                              <div
                                className="prs-drop-end-zone"
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = 'move';
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const mergedRaw = e.dataTransfer.getData('application/prs-vm-merged');
                                  if (mergedRaw) {
                                    try {
                                      const { top, bot } = JSON.parse(mergedRaw);
                                      if (top && bot) moveVmMergedCard(top, bot, null);
                                    } catch (_) { /* noop */ }
                                    dragStandaloneParentRef.current = null;
                                    return;
                                  }
                                  const raw = e.dataTransfer.getData('application/prs-parent-id');
                                  const from = raw ? parseInt(raw, 10) : dragStandaloneParentRef.current;
                                  if (from) moveStandaloneBlock(from, null);
                                  dragStandaloneParentRef.current = null;
                                }}
                              >
                                여기에 놓으면 맨 아래로 이동
                              </div>
                            )}
                          </React.Fragment>
                        );
                      });
                    })()}
                  </div>
                )}

                {regions.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-outline btn-xs prs-renumber-btn"
                    onClick={renumber}
                    title="번호 순으로 목록만 재배열합니다 (번호 수정 시에는 자동 정렬됨)"
                  >
                    🔢 번호 순 정렬
                  </button>
                )}

                {pendingReturnToConfirm && viewStep === 'select' && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm prs-back-confirm-btn"
                    onClick={handleBackToConfirm}
                  >
                    문항 확인으로 돌아가기
                  </button>
                )}

                {regions.length > 0 && (
                  <>
                    <button
                      className={`btn btn-primary prs-review-btn ${(!selGrade || !selSemester || !selUnit) ? 'prs-review-btn--warn' : ''}`}
                      onClick={handleOpenProblemConfirm}
                      disabled={extracting || regions.some((r) => r.detecting)}
                      title={
                        !selGrade || !selSemester || !selUnit
                          ? '학년/학기/단원을 먼저 선택하세요'
                          : regions.some((r) => r.detecting)
                            ? '번호 인식 완료 후 이동하세요'
                            : ''
                      }
                    >
                      {(() => {
                        const qCount = regions.filter(
                          (r) => !r.isImageRegion && r.groupRole !== 'passage',
                        ).length;
                        return !selGrade || !selSemester || !selUnit
                          ? `⚠️ 분류 선택 후 문항 확인 (${qCount}문항) →`
                          : `문항 확인 (${qCount}문항) →`;
                      })()}
                    </button>

                    {/* 영역 좌표 저장 — 보조 액션 */}
                    <button
                      className="btn btn-outline btn-sm prs-save-btn"
                      onClick={handleSave}
                      disabled={saving || extracting}
                    >
                      {saving ? <><span className="spinner" /> 저장 중...</> : '💾 좌표 저장'}
                    </button>
                    {saveMsg && (
                      <p className={`prs-save-msg ${saveMsg.startsWith('✅') ? 'success' : 'error'}`}>
                        {saveMsg}
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* ── ③ 저장된 시험 목록 ── */}
              {history.length > 0 && (
                <div className="prs-panel">
                  <div className="prs-panel-header">
                    <span>저장된 시험</span>
                    <span className="prs-panel-count">{history.length}</span>
                  </div>
                  <div className="prs-history-list">
                    {[...history].reverse().slice(0, 8).map((rec, i) => (
                      <div key={i} className="prs-history-item">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="prs-history-name">
                            {rec.exam_name || rec.pdf_name || '(제목 없음)'}
                          </div>
                          <div className="prs-history-meta">
                            {rec.grade && rec.semester && (
                              <span className="prs-history-tag">
                                {rec.grade} {rec.semester}
                              </span>
                            )}
                            {countQuestionRegions(rec.regions)}문항
                            {rec.saved_at && (
                              <span> · {new Date(rec.saved_at).toLocaleDateString('ko-KR')}</span>
                            )}
                          </div>
                        </div>
                          <button
                          className="btn btn-outline btn-xs prs-load-btn"
                          onClick={() => {
                            loadFromRecord(rec);
                            setSaveMsg(`✅ "${rec.exam_name || rec.pdf_name}" 로드 완료`);
                          }}
                          title="이 기록의 영역을 불러옵니다"
                        >
                          불러오기
                        </button>
                      </div>
                    ))}
                  </div>
                  {ENABLE_SAVED_REGION_RECOMMENDATIONS && history.length < REC_THRESHOLD && (
                    <p className="prs-help-history">
                      {REC_THRESHOLD - history.length}개 더 저장하면 추천 영역 활성화 ✨
                    </p>
                  )}
                  {ENABLE_SAVED_REGION_RECOMMENDATIONS && history.length >= REC_THRESHOLD && (
                    <p className="prs-help-history">추천 영역 활성화 중 ✅</p>
                  )}
                </div>
              )}
            </aside>

            {/* ── 캔버스 영역 ── */}
            <div className="prs-canvas-area">
              {/* 툴바 */}
              <div className="prs-toolbar">
                <span className="prs-filename">{pdfFile.name}</span>

                {totalPages > 1 && (
                  <div className="prs-page-nav">
                    <button
                      className="btn btn-ghost btn-xs"
                      disabled={currentPage === 1}
                      onClick={() => changePage(-1)}
                    >◀</button>
                    <span>{currentPage} / {totalPages}</span>
                    <button
                      className="btn btn-ghost btn-xs"
                      disabled={currentPage === totalPages}
                      onClick={() => changePage(1)}
                    >▶</button>
                  </div>
                )}

                {/* ── 삽입 모드 토글 ── */}
                <div className="prs-insert-mode-toggle">
                  <button
                    className={`prs-imode-btn ${insertMode === 'text' ? 'active' : ''}`}
                    onClick={() => setInsertMode('text')}
                    title="AI가 텍스트/수식으로 변환"
                  >
                    📝 문항 영역
                  </button>
                  <button
                    className={`prs-imode-btn ${insertMode === 'image' ? 'active' : ''}`}
                    onClick={() => setInsertMode('image')}
                    title="문항 안의 이미지(그림)를 크롭 — 가장 최근 선택된 문항에 첨부"
                  >
                    🖼️ 이미지 영역
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                  <button className="btn btn-outline btn-xs"
                    onClick={() => { setRegions([]); setRecs([]); setSaveMsg(''); }}>
                    🔄 초기화
                  </button>
                  <button className="btn btn-ghost btn-xs"
                    onClick={() => { setPdfFile(null); setPdfDoc(null); setRegions([]); setRecs([]); setSaveMsg(''); }}>
                    다른 PDF
                  </button>
                </div>
              </div>

              {/* 추천 안내 (ENABLE_SAVED_REGION_RECOMMENDATIONS 가 true 일 때만 데이터 생김) */}
              {ENABLE_SAVED_REGION_RECOMMENDATIONS && recs.length > 0 && (
                <div className="prs-rec-notice">
                  💡 <strong>{recs.length}개</strong>의 추천 영역이 있습니다.
                  ✓ 확정을 클릭하면 정식 영역으로 추가됩니다.
                  <button
                    className="btn btn-outline btn-xs"
                    style={{ marginLeft: 12 }}
                    onClick={() => {
                      recs.forEach(r => confirmRec(r));
                    }}
                  >
                    모두 확정
                  </button>
                  <button
                    className="btn btn-ghost btn-xs"
                    style={{ marginLeft: 4 }}
                    onClick={() => setRecs([])}
                  >
                    모두 무시
                  </button>
                </div>
              )}

              {/* PDF 캔버스 + 오버레이 */}
              <div className={`prs-canvas-wrapper ${insertMode === 'image' ? 'prs-canvas-wrapper--imgmode' : ''}`}>
                <canvas ref={canvasRef} className="prs-canvas" />

                {/* 이미지 모드 안내 배너 */}
                {insertMode === 'image' && imageTargetParentId == null && (
                  <div className="prs-imgmode-banner">
                    🖼️ 이미지 영역 — 문항 안의 그림/이미지를 드래그하세요. 바로 위 문항에 자동 첨부됩니다
                  </div>
                )}

                {/* 타깃형 이미지 영역 그리기 진행 안내 */}
                {imageTargetParentId != null && (() => {
                  const target = regions.find((rr) => rr.id === imageTargetParentId);
                  const pn = target ? problemDisplayLabel(target.problem_number) : '?';
                  return (
                    <div
                      className="prs-imgmode-banner"
                      style={{ background: '#fef3c7', borderColor: '#fbbf24', color: '#92400e' }}
                    >
                      ✏️ <strong>{pn}번 문항</strong>의 이미지(도형) 영역을 드래그하세요
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={cancelImageTarget}
                        style={{ marginLeft: 8 }}
                      >취소</button>
                    </div>
                  );
                })()}

                {/* 자동 묶음 감지 모달: overlay 위 레이어로 띄우기 (PDF 오버플로우에 안 잘리도록) */}
                {autoImagePrompt && autoImagePrompt.page === currentPage && !autoGroupPrompt && (
                  <div
                    className="prs-autogroup-modal prs-autoimage-modal"
                    style={(() => {
                      const rect = overlayRef.current?.getBoundingClientRect?.();
                      const xMid = autoImagePrompt.x + autoImagePrompt.w / 2;
                      const boxTop = rect ? rect.top + rect.height * autoImagePrompt.y : 120;
                      const desiredLeft = rect ? rect.left + rect.width * xMid : window.innerWidth / 2;
                      const w = 260;
                      const left = Math.max(10, Math.min(window.innerWidth - w - 10, desiredLeft - w / 2));
                      const anchorY = Math.max(10, boxTop - 10);
                      return {
                        position: 'fixed',
                        left,
                        top: anchorY,
                        transform: 'translateY(-100%)',
                        zIndex: 3000,
                        background: 'rgba(255,255,255,0.98)',
                        border: '1px solid #fcd34d',
                        borderRadius: 12,
                        padding: '10px 12px',
                        boxShadow: '0 12px 28px rgba(15, 23, 42, 0.18)',
                        width: w,
                      };
                    })()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseUp={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                  >
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#b45309', marginBottom: 6 }}>
                      이미지(도형) 감지
                    </div>
                    <div style={{ fontSize: 12, color: '#334155', lineHeight: 1.35 }}>
                      문항에 이미지가 있습니까?
                      <br />
                      <span style={{ fontSize: 11, color: '#64748b' }}>
                        예 → 문항 안 그림·도형 영역을 드래그해 지정합니다.
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                      <button type="button" className="btn btn-ghost btn-xs" onClick={rejectAutoImagePrompt}>
                        아니오
                      </button>
                      <button type="button" className="btn btn-primary btn-xs" onClick={acceptAutoImagePrompt}>
                        예
                      </button>
                    </div>
                  </div>
                )}

                {duplicateNumberPrompt && duplicateNumberPrompt.page === currentPage && !autoGroupPrompt && (
                  <div
                    className="prs-autogroup-modal"
                    style={(() => {
                      const rect = overlayRef.current?.getBoundingClientRect?.();
                      const xMid = duplicateNumberPrompt.x + duplicateNumberPrompt.w / 2;
                      const boxTop = rect ? rect.top + rect.height * duplicateNumberPrompt.y : 120;
                      const desiredLeft = rect ? rect.left + rect.width * xMid : window.innerWidth / 2;
                      const w = 260;
                      const left = Math.max(10, Math.min(window.innerWidth - w - 10, desiredLeft - w / 2));
                      const anchorY = Math.max(10, boxTop - 10);
                      return {
                        position: 'fixed',
                        left,
                        top: anchorY,
                        transform: 'translateY(-100%)',
                        zIndex: 3000,
                        background: 'rgba(255,255,255,0.98)',
                        border: '1px solid #c7d2fe',
                        borderRadius: 12,
                        padding: '10px 12px',
                        boxShadow: '0 12px 28px rgba(15, 23, 42, 0.18)',
                        width: w,
                      };
                    })()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseUp={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                  >
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#4338ca', marginBottom: 6 }}>
                      같은 문항 합치기
                    </div>
                    <div style={{ fontSize: 12, color: '#334155', lineHeight: 1.35 }}>
                      이 영역도 <strong>{problemDisplayLabel(duplicateNumberPrompt.newNumber)}번</strong> 문항입니까?
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                      <button type="button" className="btn btn-ghost btn-xs" onClick={rejectDuplicateNumberMerge}>
                        아니요
                      </button>
                      <button type="button" className="btn btn-primary btn-xs" onClick={acceptDuplicateNumberMerge}>
                        예
                      </button>
                    </div>
                  </div>
                )}

                {autoGroupPrompt && autoGroupPrompt.page === currentPage && (
                  <div
                    className="prs-autogroup-modal"
                    style={(() => {
                      const rect = overlayRef.current?.getBoundingClientRect?.();
                      // region(x,y,w,h)는 0~1 정규화 좌표.
                      // [보기] 박스의 10px 위에 모달 하단이 오도록(북쪽) 배치.
                      const xMid = autoGroupPrompt.x + autoGroupPrompt.w / 2;
                      const boxTop = rect ? rect.top + rect.height * autoGroupPrompt.y : 120;
                      const desiredLeft = rect ? rect.left + rect.width * xMid : window.innerWidth / 2;
                      // 모달 폭을 260으로 가정하고 뷰포트 안으로 클램프
                      const w = 260;
                      const left = Math.max(10, Math.min(window.innerWidth - w - 10, desiredLeft - w / 2));
                      // top은 "박스 top - 10px" 지점에 모달의 bottom이 오게: translateY(-100%)로 처리
                      const anchorY = Math.max(10, boxTop - 10);
                      return {
                        position: 'fixed',
                        left,
                        top: anchorY,
                        transform: 'translateY(-100%)',
                        zIndex: 3000,
                        background: 'rgba(255,255,255,0.98)',
                        border: '1px solid #c7d2fe',
                        borderRadius: 12,
                        padding: '10px 12px',
                        boxShadow: '0 12px 28px rgba(15, 23, 42, 0.18)',
                        width: w,
                      };
                    })()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseUp={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                  >
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#4338ca', marginBottom: 6 }}>
                      {autoGroupPrompt.kind === 'passage' ? '보기(지문) 감지' : '묶음 문제 감지'}
                    </div>
                    {autoGroupPrompt.count != null ? (
                      <>
                        <div style={{ fontSize: 12, color: '#334155', lineHeight: 1.35 }}>
                          {autoGroupPrompt.kind === 'passage' ? (
                            <>
                              왼쪽 위 <strong>※</strong> 보기 표기를 감지했어요.
                              {autoGroupPrompt.label !== '보기' && (
                                <>
                                  <br />
                                  (<strong>{autoGroupPrompt.label}</strong> 범위)
                                </>
                              )}
                            </>
                          ) : (
                            <>
                              왼쪽 위에서 <strong>[{autoGroupPrompt.label}]</strong> 표기를 감지했어요.
                            </>
                          )}
                          <br />
                          공통 보기 + <strong>{autoGroupPrompt.count}문항</strong> 묶음으로 설정할까요?
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                          <button type="button" className="btn btn-ghost btn-xs" onClick={rejectAutoGroupPrompt}>
                            아니오
                          </button>
                          <button type="button" className="btn btn-primary btn-xs" onClick={() => acceptAutoGroupPrompt()}>
                            예
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 12, color: '#334155', lineHeight: 1.35 }}>
                          왼쪽 위 <strong>※</strong> 보기 표기를 감지했어요.
                          <br />
                          <strong>총 몇 문항입니까?</strong>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                          {[2, 3, 4, 5].map((n) => (
                            <button
                              key={n}
                              type="button"
                              className="btn btn-outline btn-xs"
                              style={{ flex: '1 1 40%', minWidth: 52 }}
                              onClick={() => acceptAutoGroupPrompt(n)}
                            >
                              {n}문항
                            </button>
                          ))}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                          <button type="button" className="btn btn-ghost btn-xs" onClick={rejectAutoGroupPrompt}>
                            취소
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* 이벤트 오버레이 */}
                <div
                  ref={overlayRef}
                  className="prs-overlay"
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={() => drawing && setDrawing(false)}
                >
                  {/* ① 추천 박스 */}
                  {ENABLE_SAVED_REGION_RECOMMENDATIONS && recs.map(rec => (
                    <div
                      key={rec.id}
                      className="prs-box prs-box-rec"
                      style={{
                        left:   `${rec.x * 100}%`,
                        top:    `${rec.y * 100}%`,
                        width:  `${rec.w * 100}%`,
                        height: `${rec.h * 100}%`,
                      }}
                    >
                      <div className="prs-rec-actions">
                        <button
                          className="prs-rec-confirm"
                          onClick={() => confirmRec(rec)}
                        >
                          ✓ {rec.problem_number}번
                        </button>
                        <button
                          className="prs-rec-dismiss"
                          onClick={() => dismissRec(rec.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* ② 확정 박스 (현재 페이지 것만 표시) */}
                  {regions.filter(r => r.page === currentPage).map(r => (
                    <React.Fragment key={r.id}>
                    {shouldShowMarkBox(r, regions) && r.markBox && (
                      <div
                        className="prs-mark-box"
                        title="채점 네모 (틀리면 번호 위에 빨간 표시)"
                        style={{
                          left: `${r.markBox.x * 100}%`,
                          top: `${r.markBox.y * 100}%`,
                          width: `${r.markBox.w * 100}%`,
                          height: `${r.markBox.h * 100}%`,
                        }}
                      />
                    )}
                    <div
                      className={`prs-box prs-box-confirmed${r.isImageRegion ? ' prs-box--imgregion' : ''}`}
                      style={{
                        left:   `${r.x * 100}%`,
                        top:    `${r.y * 100}%`,
                        width:  `${r.w * 100}%`,
                        height: `${r.h * 100}%`,
                      }}
                    >
                      <div className="prs-box-label" style={{ pointerEvents: 'auto' }}>
                        {r.detecting ? (
                          <span>🔍</span>
                        ) : r.isImageRegion ? (
                          /* 이미지 서브 영역: 번호 수정 불가, 라벨만 표시 */
                          <span style={{ fontSize: 10 }}>
                            {(() => {
                              const parent = regions.find(p => p.id === r.parentId);
                              return parent
                                ? `${parent.problem_number}번 이미지${r.imageIdx}`
                                : `이미지${r.imageIdx}`;
                            })()}
                          </span>
                        ) : (
                          <input
                            key={`box-${r.id}-${r.problem_number}`}
                            type="text"
                            inputMode="numeric"
                            className="prs-box-num-input"
                            defaultValue={r.problem_number ?? ''}
                            title="번호 수정 후 Enter 또는 포커스 이탈"
                            onClick={e => e.stopPropagation()}
                            onMouseDown={e => e.stopPropagation()}
                            onBlur={(e) => {
                              const v = parseProblemKeyInput(e.target.value);
                              if (v != null) {
                                tryUpdateRegionProblemKey(r.id, v, () => {
                                  e.target.value = String(r.problem_number ?? '');
                                });
                              } else {
                                e.target.value = String(r.problem_number ?? '');
                              }
                            }}
                            onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); e.target.blur(); } }}
                          />
                        )}
                        <span style={{ opacity: 0.85, fontSize: 10 }}>{r.isImageRegion ? '' : '번'}</span>
                        {!r.isImageRegion && r.problemType && STRUCTURE_BADGE[r.problemType] && (
                          <button
                            type="button"
                            className="prs-box-type-badge"
                            title={
                              `유형: ${r.problemType}` +
                              (r.problemTypeSource === 'user' ? ' (확정)' :
                               r.problemTypeSource === 'ai' ? ' (AI 추정)' :
                               ' (자동 감지)') +
                              ' · 클릭하여 변경'
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              cycleRegionProblemType(r.id);
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            style={{
                              fontSize: 10,
                              padding: '1px 5px',
                              marginLeft: 4,
                              background: STRUCTURE_BADGE[r.problemType].bg,
                              color: STRUCTURE_BADGE[r.problemType].fg,
                              border: r.problemTypeSource === 'user' ? '1px solid currentColor' : '1px dashed currentColor',
                              borderRadius: 4,
                              fontWeight: 700,
                              cursor: 'pointer',
                              pointerEvents: 'auto',
                              opacity: r.problemTypeSource === 'user' ? 1 : 0.85,
                            }}
                          >
                            {STRUCTURE_BADGE[r.problemType].icon} {STRUCTURE_BADGE[r.problemType].label}
                          </button>
                        )}
                        {!r.isImageRegion && r.hasImage && (
                          <span
                            className="prs-box-img-badge"
                            title={
                              regions.some(ir => ir.isImageRegion && ir.parentId === r.id)
                                ? '이미지 영역 지정됨'
                                : '⚠️ 이미지 영역이 아직 지정되지 않았습니다 — 사이드 패널의 「이미지 영역 그리기」를 누르세요'
                            }
                            style={{
                              fontSize: 10,
                              padding: '1px 5px',
                              marginLeft: 4,
                              background: regions.some(ir => ir.isImageRegion && ir.parentId === r.id) ? '#dcfce7' : '#fee2e2',
                              color:      regions.some(ir => ir.isImageRegion && ir.parentId === r.id) ? '#166534' : '#991b1b',
                              border: '1px solid currentColor',
                              borderRadius: 4,
                              fontWeight: 700,
                              pointerEvents: 'auto',
                            }}
                          >
                            🖼️
                          </span>
                        )}
                        <button
                          className="prs-box-delete"
                          onClick={e => { e.stopPropagation(); deleteRegion(r.id); }}
                        >✕</button>
                      </div>
                    </div>
                    </React.Fragment>
                  ))}

                  {/* ③ 드래그 중 박스 */}
                  {currentBox && currentBox.w > 0.005 && currentBox.h > 0.005 && (
                    <div
                      className="prs-box prs-box-drawing"
                      style={{
                        left:   `${currentBox.x * 100}%`,
                        top:    `${currentBox.y * 100}%`,
                        width:  `${currentBox.w * 100}%`,
                        height: `${currentBox.h * 100}%`,
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
