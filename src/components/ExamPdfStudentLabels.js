/**
 * ExamPdfStudentLabels.js — 시험지 PDF에 출석번호·이름 일괄 삽입 (교사 전용)
 *
 * - pdf.js: 첫 페이지 미리보기
 * - pdf-lib + NotoSansCJKkr Regular (OFL, pdf-fontkit): 한글 포함 텍스트 (전부 클라이언트, 서버 미저장)
 * - 스캔 OCR 정확도 우선: 굵은 글꼴 대신 일반체·최소 pt 권장
 * - 학생: IndexedDB 매핑 + Firebase와 TeacherDashboard와 동일 병합
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './ExamPdfStudentLabels.css';
import HudFrame from './HudFrame';
import { useNavigate } from 'react-router-dom';
import fontkit from 'pdf-fontkit';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { useAuth } from '../contexts/AuthContext';
import { getAllMappings } from '../utils/teacherDB';
import {
  mergeStudentsForTeacherView,
} from '../utils/mergeTeacherStudents';
import { normalizeClassCode } from '../utils/classCode';
import {
  getStudentsByClass,
  getClassesByTeacher,
  syncTeacherEmailOnTeacherClasses,
  canTeacherAccessClass,
  backfillStudentNumbersFromMappings,
} from '../firebase/firestoreOps';
import {
  saveExamPdf,
  saveExamSpecs,
  loadExamSpecs,
  listExamPaperLibrary,
  getExamPaperFileFromLibrary,
} from '../utils/pdfStorage';
import { cancelPdfRenderTask, getPdfJs } from '../utils/pdfjsSetup';
import {
  drawRegistrationMarksOnPdfPage,
  drawArucoMarkersOnPdfPage,
  getDefaultRegistrationMarkSpec,
} from '../utils/scanRegistrationMarks';
import { resolveKimchiNickname } from '../utils/kimchiNicknames';
import {
  drawProblemMarkBoxesOnPdfPage,
  fetchRegionsRecordForPdf,
  isGradeableRegion,
} from '../utils/problemMarkBox';
import {
  EXAM_FIELD_CHARS_WIDE,
  saveStudentFieldRegionsToServer,
} from '../utils/examStudentFieldRegions';

const REG_MARK_SPEC = getDefaultRegistrationMarkSpec();

/** NotoSansCJKkr Regular OTF — SIL Open Font License (스캔 OCR: Bold보다 획 분리 유리) */
const NOTO_KR_FONT_URL =
  'https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf';

/** 스캔 OCR: 11~13pt, 기본 12pt (일반체 인쇄) */
const DEFAULT_EXAM_FIELD_FONT_SIZE_PT = 12;
const MIN_EXAM_FIELD_FONT_SIZE_PT = 11;
const MAX_EXAM_FIELD_FONT_SIZE_PT = 13;
const FONT_SIZES = [11, 12, 13];

function normalizeExamFieldFontSizePt(fontSizePt) {
  const n = Number(fontSizePt);
  if (FONT_SIZES.includes(n)) return n;
  if (!Number.isFinite(n) || n < MIN_EXAM_FIELD_FONT_SIZE_PT) {
    return DEFAULT_EXAM_FIELD_FONT_SIZE_PT;
  }
  return Math.min(
    MAX_EXAM_FIELD_FONT_SIZE_PT,
    Math.max(MIN_EXAM_FIELD_FONT_SIZE_PT, Math.round(n))
  );
}

function normalizeExamFieldSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  return {
    ...spec,
    fontSizePt: normalizeExamFieldFontSizePt(spec.fontSizePt),
  };
}

function sanitizeFileName(base) {
  return String(base)
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'student';
}

/** overlayInputBoxPx · scan_organize_api._nx_ny_spec_to_region 과 동일 */
const EXAM_FIELD_BOX_HEIGHT_RATIO = 1.35;
const EXAM_FIELD_BOX_CHROME_PX = 4; /* border 2 + padding 2 (한쪽) */
const EXAM_FIELD_OVERLAY_LINE_HEIGHT = 1.05;

function examFieldPxPerPt(viewportMeta) {
  const ch = Number(viewportMeta?.canvasH);
  const ph = Number(viewportMeta?.pdfHPt);
  if (ch > 0 && ph > 0) return ch / ph;
  return null;
}

function examFieldChromePt(viewportMeta) {
  const pxPerPt = examFieldPxPerPt(viewportMeta);
  if (pxPerPt != null) return EXAM_FIELD_BOX_CHROME_PX / pxPerPt;
  return null;
}

/** pdf-lib PDFFont ascender/descender → pt (없으면 Helvetica/CJK 기본값) */
function fontAscentDescentPt(font, fontSizePt, cjk) {
  const upem = Number(font?.unitsPerEm);
  if (
    upem > 0 &&
    Number.isFinite(font?.ascender) &&
    Number.isFinite(font?.descender)
  ) {
    return {
      ascent: (font.ascender / upem) * fontSizePt,
      descent: (Math.abs(font.descender) / upem) * fontSizePt,
    };
  }
  if (cjk) {
    return { ascent: fontSizePt * 0.88, descent: fontSizePt * 0.12 };
  }
  return { ascent: fontSizePt * 0.718, descent: fontSizePt * 0.207 };
}

/**
 * 입력칸 좌상단(ny) 기준, 미리보기 input 세로 중앙과 동일한 baseline이
 * 박스 상단에서 떨어진 거리(pt).
 */
function examFieldBaselineFromBoxTopPt(fontSizePt, font, viewportMeta, cjk) {
  const chrome =
    examFieldChromePt(viewportMeta) ?? fontSizePt * (EXAM_FIELD_BOX_CHROME_PX / 12);
  const boxH = fontSizePt * EXAM_FIELD_BOX_HEIGHT_RATIO;
  const contentH = Math.max(fontSizePt * 0.5, boxH - 2 * chrome);
  const { ascent } = fontAscentDescentPt(font, fontSizePt, cjk);
  const lineBox = fontSizePt * EXAM_FIELD_OVERLAY_LINE_HEIGHT;
  return chrome + Math.max(0, (contentH - lineBox) / 2) + ascent;
}

/** 입력칸 안쪽에 들어갈 수 있는 텍스트 최대 너비(pt) — overlay·OCR 박스와 동일 */
function examFieldMaxTextWidthPt(fontSizePt, charsWide, viewportMeta) {
  const chrome =
    examFieldChromePt(viewportMeta) ?? fontSizePt * (EXAM_FIELD_BOX_CHROME_PX / 12);
  const boxW = fontSizePt * charsWide * 0.62;
  return Math.max(fontSizePt * 0.35, boxW - 2 * chrome);
}

/**
 * 칸 밖으로 넘치는 이름(외국인 등)은 앞부분만 인쇄 — 스캔·명단은 앞글자·출석번호로 매칭.
 */
function truncateTextToExamFieldWidth(text, font, fontSizePt, charsWide, viewportMeta) {
  const s = String(text ?? '');
  if (!s || typeof font?.widthOfTextAtSize !== 'function') return s;
  const maxW = examFieldMaxTextWidthPt(fontSizePt, charsWide, viewportMeta);
  if (font.widthOfTextAtSize(s, fontSizePt) <= maxW + 0.25) return s;
  let fit = 0;
  for (let i = 1; i <= s.length; i += 1) {
    if (font.widthOfTextAtSize(s.slice(0, i), fontSizePt) <= maxW + 0.25) {
      fit = i;
    } else {
      break;
    }
  }
  return s.slice(0, fit);
}

/** pdf-lib drawText용 baseline(y) · x(좌측 chrome 보정) */
function examFieldPdfDrawCoords(nx, ny, pdfW, pdfH, fontSizePt, font, viewportMeta, cjk) {
  const chrome =
    examFieldChromePt(viewportMeta) ?? fontSizePt * (EXAM_FIELD_BOX_CHROME_PX / 12);
  const boxTop = pdfH * (1 - ny);
  return {
    x: nx * pdfW + chrome,
    y: boxTop - examFieldBaselineFromBoxTopPt(fontSizePt, font, viewportMeta, cjk),
  };
}

/** 이름에 U+007F 초과 문자가 있으면(한글 등) CJK 폰트 사용 */
function nameNeedsCjkFont(nameText) {
  if (!nameText) return false;
  for (let i = 0; i < nameText.length; i += 1) {
    if (nameText.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

let cachedKrFontBytes = null;
async function loadKoreanFontBytes() {
  if (cachedKrFontBytes) return cachedKrFontBytes;
  const res = await fetch(NOTO_KR_FONT_URL);
  if (!res.ok) throw new Error(`폰트 다운로드 실패 (${res.status})`);
  cachedKrFontBytes = await res.arrayBuffer();
  return cachedKrFontBytes;
}

let cachedArucoPngBytes = null;
async function loadArucoPngBytes() {
  if (cachedArucoPngBytes) return cachedArucoPngBytes;
  const ids = [10, 11, 12, 13];
  const entries = await Promise.all(
    ids.map(async (id) => {
      const res = await fetch(`/aruco/DICT_4X4_50_id${id}.png`);
      if (!res.ok) throw new Error(`ArUco 마커 로드 실패 (id=${id}, ${res.status})`);
      const buf = await res.arrayBuffer();
      return [id, new Uint8Array(buf)];
    })
  );
  cachedArucoPngBytes = Object.fromEntries(entries);
  return cachedArucoPngBytes;
}

async function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const PREVIEW_ATTENDANCE_SAMPLE = '00';
const PREVIEW_NAME_SAMPLE = '홍길동';
const PREVIEW_SAMPLE_TEXT_COLOR = '#7D7D7D';

const PLACEMENT_HINT_TEXT =
  '글자 크기를 확인하기 위해 번호에 00, 이름에 홍길동이 입력됩니다. PDF에 학생 번호와 이름이 반영됩니다.';

/** index.css @import·:root와 동일 — 미리보기 입력칸 폰트 */
const APP_MULTI_NOTO_FONT_STACK =
  "'Noto Sans', 'Noto Sans KR', 'Noto Sans SC', 'Noto Sans TC', 'Noto Sans JP', 'Noto Sans Arabic', sans-serif";

/** 입력 박스 바깥 이 폭까지는 테두리·이동(handle) 존재 */
const EXAM_FIELD_DRAG_MARGIN_PX = 8;
/** 방향키 미세 이동(px) — Shift 누르면 5배 */
const EXAM_FIELD_NUDGE_PX = 1;
const EXAM_FIELD_NUDGE_PX_FAST = 5;
/** shell left/top(px, wrap 기준) → 정규화 nx/ny — 드래그·렌더·클릭 배치 동일 식 */
function shellPxToNorm(shellLeft, shellTop, wrapWpx, wrapHpx) {
  const w = Math.max(wrapWpx, 1);
  const h = Math.max(wrapHpx, 1);
  return {
    nx: Math.max(0, Math.min(1, (shellLeft + EXAM_FIELD_DRAG_MARGIN_PX) / w)),
    ny: Math.max(0, Math.min(1, (shellTop + EXAM_FIELD_DRAG_MARGIN_PX) / h)),
  };
}

function nudgeExamFieldSpec(spec, dnx, dny, viewportMeta, charsWide) {
  if (!spec || !viewportMeta) return spec;
  const { pdfWPt, pdfHPt } = viewportMeta;
  const maxNx = 1 - (spec.fontSizePt * charsWide * 0.62) / pdfWPt;
  const maxNy = 1 - (spec.fontSizePt * EXAM_FIELD_BOX_HEIGHT_RATIO) / pdfHPt;
  return {
    ...spec,
    nx: Math.max(0, Math.min(maxNx, spec.nx + dnx)),
    ny: Math.max(0, Math.min(maxNy, spec.ny + dny)),
  };
}

/**
 * OverlayBox와 동일한 기하(픽셀). wrap 높이 = 캔버스 표시 높이 전제.
 */
function overlayInputBoxPx(spec, viewportMeta, wrapWpx, wrapHpx, field) {
  if (!spec || !viewportMeta || !(wrapWpx > 8) || !(wrapHpx > 8)) return null;
  const charsWide = EXAM_FIELD_CHARS_WIDE[field];
  const { nx, ny, fontSizePt } = spec;
  const { pdfWPt, pdfHPt } = viewportMeta;
  const boxW = ((fontSizePt * charsWide * 0.62) / pdfWPt) * wrapWpx;
  const boxH = ((fontSizePt * EXAM_FIELD_BOX_HEIGHT_RATIO) / pdfHPt) * wrapHpx;
  const fontPx = (fontSizePt / pdfHPt) * wrapHpx;
  const isAttendance = field === 'attendance';
  return {
    x: nx * wrapWpx,
    y: ny * wrapHpx,
    width: Math.max(8, boxW),
    height: Math.max(8, boxH),
    fontSize: Math.max(fontPx, 10),
    previewValue: isAttendance ? PREVIEW_ATTENDANCE_SAMPLE : PREVIEW_NAME_SAMPLE,
    borderColor: isAttendance ? '#2563eb' : '#059669',
    fontFamily: isAttendance
      ? 'Helvetica, Arial, sans-serif'
      : APP_MULTI_NOTO_FONT_STACK,
    fontWeight: '400',
    lineHeight: EXAM_FIELD_OVERLAY_LINE_HEIGHT,
  };
}

function stopExamFieldEventBubble(ev) {
  ev.stopPropagation();
}

function examFieldPreventDragStart(ev) {
  ev.preventDefault();
}

/** 칸 이동 안내 — stroke·fill 레이어에 동일 마크업 */
function ExamFieldMoveHintBody() {
  return (
    <div className="exam-pdf-field-move-hint__grid">
      <span>칸 이동 방법:</span>
      <span className="exam-pdf-field-move-hint__num">1.</span>
      <span>칸 클릭 후 마우스로 드래그</span>
      <span aria-hidden="true" />
      <span className="exam-pdf-field-move-hint__num">2.</span>
      <span>칸 클릭 후 방향키</span>
    </div>
  );
}

export default function ExamPdfStudentLabels() {
  const navigate = useNavigate();
  const { teacherUser } = useAuth();

  const [classCode, setClassCode] = useState(null);
  const [localMappings, setLocalMappings] = useState([]);
  const [serverStudents, setServerStudents] = useState([]);
  const [loadErr, setLoadErr] = useState('');

  const [pdfFile, setPdfFile] = useState(null);
  const [pdfBuf, setPdfBuf] = useState(null);
  const [libraryEntries, setLibraryEntries] = useState([]);
  const [libraryPickId, setLibraryPickId] = useState('');
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryLoadError, setLibraryLoadError] = useState('');
  const [libraryFileBusy, setLibraryFileBusy] = useState(false);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const wrapRef = useRef(null);
  /** 스크롤 컨테이너 너비(스크롤바 포함) */
  const viewportOuterRef = useRef(null);
  /** 패딩 안쪽 폭으로 PDF 픽셀 폭 계산 */
  const viewportContentRef = useRef(null);

  /** PDF 첫 페이지 pt 크기 및 실제 렌더 캔버스 px (클릭 좌표 = 캔버스와 동일) */
  const [viewportMeta, setViewportMeta] = useState(null);
  /** 컨테이너 크기 변화 시 PDF 재레이아웃 */
  const [layoutTick, setLayoutTick] = useState(0);

  const [selectionMode, setSelectionMode] = useState('attendance'); // attendance | name
  const [namePrintMode, setNamePrintMode] = useState('name'); // name | nickname
  const [attendanceSpec, setAttendanceSpec] = useState(null); // { nx, ny, fontSizePt }
  const [nameSpec, setNameSpec] = useState(null);

  const [renderingPdf, setRenderingPdf] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [manualCoordSavePending, setManualCoordSavePending] = useState(false);
  const [openingModalSavePending, setOpeningModalSavePending] = useState(false);
  const [coordsSaveHint, setCoordsSaveHint] = useState('');
  /** pdf_regions.json — 문항 채점 네모 */
  const [markRegionsRecord, setMarkRegionsRecord] = useState(null);
  const [markRegionsLoading, setMarkRegionsLoading] = useState(false);

  /** 드래그 직후 wrap pointerUp 한 번 무시 → 새 위치가 클릭으로 덮이지 않게 */
  const skipWrapPlacementAfterDragRef = useRef(false);

  /** DOM ref: 드래그 중 style 직접 조작 대상 */
  const attendanceShellRef = useRef(null);
  const nameShellRef = useRef(null);

  /**
   * 통합 드래그 세션 ref.
   * 드래그 중에는 이 ref + DOM style만 사용 — setState 없음.
   */
  const dragRef = useRef({
    active: false,
    field: null,
    ptrOffsetX: 0,
    ptrOffsetY: 0,
    shellEl: null,
    wrapEl: null,
    shellW: 0,
    shellH: 0,
    wrapW: 0,
    wrapH: 0,
    lastShellLeft: 0,
    lastShellTop: 0,
    unlisten: null,
  });

  /** 칸 클릭 시 글자 크기 select 포커스 해제 → 방향키가 위치 조정으로 동작 */
  const activateExamFieldForKeyboard = useCallback((field) => {
    setSelectionMode(field);
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.closest('input, select, textarea, [contenteditable="true"]')
    ) {
      active.blur();
    }
    const shell =
      field === 'attendance' ? attendanceShellRef.current : nameShellRef.current;
    shell?.focus({ preventScroll: true });
  }, []);

  const onExamFieldOverlayActivate = useCallback(
    (field, ev) => {
      ev.stopPropagation();
      activateExamFieldForKeyboard(field);
    },
    [activateExamFieldForKeyboard]
  );

  /** 지정 중인 입력 칸 — 방향키로 1px(Shift 5px) 미세 이동 */
  useEffect(() => {
    const onKeyDown = (e) => {
      if (
        e.key !== 'ArrowUp' &&
        e.key !== 'ArrowDown' &&
        e.key !== 'ArrowLeft' &&
        e.key !== 'ArrowRight'
      ) {
        return;
      }
      if (dragRef.current.active || !pdfBuf || !viewportMeta) return;

      const focused = document.activeElement;
      if (focused instanceof Element) {
        if (focused.closest('input, select, textarea, [contenteditable="true"]')) return;
      }

      const wrap = wrapRef.current;
      if (!wrap) return;
      const { width: wrapW, height: wrapH } = wrap.getBoundingClientRect();
      if (wrapW < 8 || wrapH < 8) return;

      const field = selectionMode;
      const spec = field === 'attendance' ? attendanceSpec : nameSpec;
      if (!spec) return;

      const stepPx = e.shiftKey ? EXAM_FIELD_NUDGE_PX_FAST : EXAM_FIELD_NUDGE_PX;
      let dnx = 0;
      let dny = 0;
      if (e.key === 'ArrowLeft') dnx = -stepPx / wrapW;
      else if (e.key === 'ArrowRight') dnx = stepPx / wrapW;
      else if (e.key === 'ArrowUp') dny = -stepPx / wrapH;
      else if (e.key === 'ArrowDown') dny = stepPx / wrapH;

      e.preventDefault();
      const charsWide = EXAM_FIELD_CHARS_WIDE[field] ?? 6;
      const next = nudgeExamFieldSpec(spec, dnx, dny, viewportMeta, charsWide);
      if (field === 'attendance') setAttendanceSpec(next);
      else setNameSpec(next);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    pdfBuf,
    viewportMeta,
    selectionMode,
    attendanceSpec,
    nameSpec,
  ]);

  useEffect(() => {
    const drag = dragRef.current;
    return () => {
      drag.unlisten?.();
      drag.active = false;
      document.body.style.cursor = '';
    };
  }, []);

  const mergedStudents = useMemo(
    () =>
      mergeStudentsForTeacherView(localMappings, serverStudents, classCode || ''),
    [localMappings, serverStudents, classCode]
  );

  const gradeMarkRegions = useMemo(() => {
    const raw = markRegionsRecord?.regions || [];
    return raw.filter(isGradeableRegion);
  }, [markRegionsRecord]);

  /** IndexedDB examSpecs + pdf_regions 이름·번호 박스 동기화 (스캔 crop OCR용) */
  const persistStudentFieldRegions = useCallback(
    async (attSpec, nmSpec) => {
      if (!pdfFile?.name || !attSpec || !nmSpec || !viewportMeta) return null;
      const data = await saveStudentFieldRegionsToServer({
        pdfName: pdfFile.name,
        examName: markRegionsRecord?.exam_name || pdfFile.name.replace(/\.pdf$/i, ''),
        grade: markRegionsRecord?.grade,
        semester: markRegionsRecord?.semester,
        unit: markRegionsRecord?.unit,
        totalPages: markRegionsRecord?.total_pages || 1,
        pageWidthPt: viewportMeta.pdfWPt,
        pageHeightPt: viewportMeta.pdfHPt,
        attendanceSpec: attSpec,
        nameSpec: nmSpec,
      });
      const rec = await fetchRegionsRecordForPdf(pdfFile.name);
      if (rec) setMarkRegionsRecord(rec);
      return data;
    },
    [pdfFile?.name, viewportMeta, markRegionsRecord]
  );

  useEffect(() => {
    const name = pdfFile?.name;
    if (!name) {
      setMarkRegionsRecord(null);
      return;
    }
    let cancelled = false;
    setMarkRegionsLoading(true);
    fetchRegionsRecordForPdf(name)
      .then((rec) => {
        if (!cancelled) setMarkRegionsRecord(rec);
      })
      .catch(() => {
        if (!cancelled) setMarkRegionsRecord(null);
      })
      .finally(() => {
        if (!cancelled) setMarkRegionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfFile?.name]);

  // 학급·학생 불러오기 (교사 검증 포함)
  useEffect(() => {
    let cancelled = false;
    const code = localStorage.getItem('teacher_class_code');
    setClassCode(code);
    if (!code || !teacherUser?.uid) {
      setLocalMappings([]);
      setServerStudents([]);
      return () => {};
    }

    (async () => {
      setLoadErr('');
      try {
        if (teacherUser.email) {
          await syncTeacherEmailOnTeacherClasses(teacherUser.uid, teacherUser.email);
        }
        const list = await getClassesByTeacher(teacherUser.uid, teacherUser.email);
        const inList = list.some((c) => (c.classCode || c.id) === code);
        const allowed =
          inList ||
          (await canTeacherAccessClass(code, teacherUser.uid, teacherUser.email));
        if (cancelled) return;
        if (!allowed) {
          setLoadErr('이 학급에 접근할 권한이 없습니다.');
          setLocalMappings([]);
          setServerStudents([]);
          return;
        }
        const [students, mappingsAll] = await Promise.all([
          getStudentsByClass(code).catch(() => []),
          getAllMappings().catch(() => []),
        ]);
        if (cancelled) return;
        const want = normalizeClassCode(code);
        const localRelevant = (mappingsAll || []).filter(
          (m) => normalizeClassCode(m?.classCode) === want
        );
        let studentsNext = students;
        try {
          const bf = await backfillStudentNumbersFromMappings(code, students, localRelevant);
          if (bf.updated > 0) {
            studentsNext = await getStudentsByClass(code).catch(() => students);
          }
        } catch (e) {
          console.warn('출석번호 서버 백필:', e);
        }
        setLocalMappings(localRelevant);
        setServerStudents(studentsNext);
      } catch (e) {
        if (!cancelled) setLoadErr(e.message || '데이터 로드 실패');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [teacherUser?.uid, teacherUser?.email]);

  // 「시험지 업로드」에 등록된 PDF 목록을 한 번 불러온다 — IndexedDB만 사용(서버 미전송)
  const refreshLibrary = useCallback(async () => {
    setLibraryLoading(true);
    setLibraryLoadError('');
    try {
      const list = await listExamPaperLibrary();
      setLibraryEntries(Array.isArray(list) ? list : []);
    } catch (err) {
      console.warn('시험지 라이브러리 로드:', err);
      setLibraryEntries([]);
      setLibraryLoadError(err?.message || '등록된 시험지 목록을 불러오지 못했습니다.');
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshLibrary();
  }, [refreshLibrary]);

  const handlePickFromLibrary = useCallback(
    async (id) => {
      setLibraryPickId(id);
      if (!id) return;
      setLibraryFileBusy(true);
      try {
        const file = await getExamPaperFileFromLibrary(id);
        if (!file) {
          window.alert('선택한 시험지를 이 기기에서 찾을 수 없습니다. 「시험지 업로드」에서 다시 등록해 주세요.');
          setLibraryPickId('');
          return;
        }
        const raw = await file.arrayBuffer();
        setPdfFile(file);
        setPdfBuf(raw);
        try {
          // 다른 도구의 「저장된 시험지 불러오기」 호환성 유지
          await saveExamPdf(file);
        } catch (err) {
          console.warn('시험지 PDF 로컬 저장:', err);
        }
        try {
          const { attendanceSpec: savedAttendanceSpec, nameSpec: savedNameSpec } = await loadExamSpecs(
            file.name
          );
          setAttendanceSpec(
            savedAttendanceSpec ? normalizeExamFieldSpec(savedAttendanceSpec) : null
          );
          setNameSpec(savedNameSpec ? normalizeExamFieldSpec(savedNameSpec) : null);
        } catch {
          setAttendanceSpec(null);
          setNameSpec(null);
        }
        setViewportMeta(null);
      } catch (err) {
        console.error(err);
        window.alert('시험지를 불러오지 못했습니다: ' + (err?.message || String(err)));
      } finally {
        setLibraryFileBusy(false);
      }
    },
    []
  );

  const examSpecsHydrateDoneRef = useRef(false);

  /** 예전 9~10pt·14pt+·Bold 세팅 → 11~13pt 범위로 자동 보정 */
  useEffect(() => {
    if (attendanceSpec) {
      const norm = normalizeExamFieldSpec(attendanceSpec);
      if (norm.fontSizePt !== attendanceSpec.fontSizePt) {
        setAttendanceSpec(norm);
      }
    }
  }, [attendanceSpec]);

  useEffect(() => {
    if (nameSpec) {
      const norm = normalizeExamFieldSpec(nameSpec);
      if (norm.fontSizePt !== nameSpec.fontSizePt) {
        setNameSpec(norm);
      }
    }
  }, [nameSpec]);

  /** 이름·번호 칸 좌표를 IndexedDB에 동기화 (첫 렌더 제외 — 이후 null,null도 새 PDF·초기화 반영) */
  useEffect(() => {
    if (!examSpecsHydrateDoneRef.current) {
      examSpecsHydrateDoneRef.current = true;
      return;
    }
    saveExamSpecs(attendanceSpec, nameSpec, pdfFile?.name, REG_MARK_SPEC).catch((err) =>
      console.warn('시험 칸 좌표 저장:', err)
    );
  }, [attendanceSpec, nameSpec, pdfFile?.name]);

  /** 스크롤 영역 폭 변경 → 가로 폭 맞춤 레이아웃 다시 그리기 */
  useEffect(() => {
    const el = viewportOuterRef.current;
    if (!el || !pdfBuf) return undefined;
    let debounceTimer;
    const schedule = () => {
      if (dragRef.current.active) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => setLayoutTick((t) => t + 1), 120);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    schedule();
    return () => {
      clearTimeout(debounceTimer);
      ro.disconnect();
    };
  }, [pdfBuf]);

  /**
   * pdf.js: 컨테이너 너비에 정확히 맞춤 (비율 유지).
   * 캔버스 디바이스 픽셀 = 표시 크기 → 클릭·드래그로 지정 시 실제 페이지와 같은 위치.
   */
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const contentEl = viewportContentRef.current;
      if (!pdfBuf || !canvasRef.current || !contentEl) return;
      const lib = getPdfJs();
      if (!lib) return;

      const cw = (() => {
        const cs = window.getComputedStyle(contentEl);
        const inner = Math.floor(
          contentEl.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0')
        );
        return Math.max(48, inner);
      })();
      setRenderingPdf(true);
      try {
        const pdf = await lib.getDocument({ data: pdfBuf.slice(0) }).promise;
        const page = await pdf.getPage(1);
        const baseVp = page.getViewport({ scale: 1 });
        const scale = cw / baseVp.width;
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d', { alpha: false });
        const w = Math.max(1, Math.round(viewport.width));
        const h = Math.max(1, Math.round(viewport.height));

        cancelPdfRenderTask(renderTaskRef.current);
        renderTaskRef.current = null;

        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        canvas.style.display = 'block';

        const renderTask = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        if (renderTaskRef.current === renderTask) renderTaskRef.current = null;

        if (!cancelled) {
          setViewportMeta({
            pdfWPt: baseVp.width,
            pdfHPt: baseVp.height,
            canvasW: w,
            canvasH: h,
          });
        }
      } catch (e) {
        if (e?.name === 'RenderingCancelledException') return;
        if (!cancelled) console.warn('PDF 렌더:', e);
      }
      if (!cancelled) setRenderingPdf(false);
    };

    const id = requestAnimationFrame(run);
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
      cancelPdfRenderTask(renderTaskRef.current);
      renderTaskRef.current = null;
    };
  }, [pdfBuf, layoutTick]);

  /** 클릭·포인터 업 후 놓인 지점 기준 영역 저장 — I빔 커서 오른쪽에 박스 세로 중앙 정렬 */
  const applyPlacementAtClient = useCallback(
    (clientX, clientY) => {
      if (!pdfBuf || !wrapRef.current || !viewportMeta) return;
      const rect = wrapRef.current.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;

      const inherited =
        selectionMode === 'attendance'
          ? attendanceSpec?.fontSizePt ?? nameSpec?.fontSizePt ?? DEFAULT_EXAM_FIELD_FONT_SIZE_PT
          : nameSpec?.fontSizePt ?? attendanceSpec?.fontSizePt ?? DEFAULT_EXAM_FIELD_FONT_SIZE_PT;
      const fontSizePt = normalizeExamFieldFontSizePt(inherited);

      // I빔 기준: 오른쪽으로 2px, 세로는 박스 높이의 절반만큼 올려 중앙 정렬
      const boxHpx =
        (fontSizePt * EXAM_FIELD_BOX_HEIGHT_RATIO / viewportMeta.pdfHPt) *
        rect.height;
      const relX = clientX - rect.left + 2;
      const relY = clientY - rect.top - boxHpx / 2;
      const nx = Math.max(0, Math.min(1, relX / rect.width));
      const ny = Math.max(0, Math.min(1, relY / rect.height));

      const nextSpec = { nx, ny, fontSizePt };

      if (selectionMode === 'attendance') {
        setAttendanceSpec(nextSpec);
        setSelectionMode('name');
      } else {
        setNameSpec(nextSpec);
      }
    },
    [
      pdfBuf,
      viewportMeta,
      selectionMode,
      attendanceSpec?.fontSizePt,
      nameSpec,
    ]
  );

  /**
   * 드래그 시작: mousedown 시점에 포인터의 shell 내 오프셋만 기록.
   * mousemove → DOM style 직접 조작 (setState 없음).
   * mouseup → 최종 좌표 읽어 nx/ny 역산 후 setState 1회.
   */
  const beginExamFieldOverlayDrag = useCallback(
    (field, ev) => {
      if (ev.button !== 0) return;
      const shellEl =
        field === 'attendance' ? attendanceShellRef.current : nameShellRef.current;
      const wrapEl = wrapRef.current;
      if (!shellEl || !wrapEl || !viewportMeta) return;

      ev.preventDefault();
      ev.stopPropagation();
      activateExamFieldForKeyboard(field);

      const shellRect = shellEl.getBoundingClientRect();
      const wr = wrapEl.getBoundingClientRect();
      const d = dragRef.current;
      d.active = true;
      d.field = field;
      d.ptrOffsetX = ev.clientX - shellRect.left;
      d.ptrOffsetY = ev.clientY - shellRect.top;
      d.shellEl = shellEl;
      d.wrapEl = wrapEl;
      d.shellW = shellRect.width;
      d.shellH = shellRect.height;
      d.wrapW = wr.width;
      d.wrapH = wr.height;
      d.lastShellLeft = shellRect.left - wr.left;
      d.lastShellTop = shellRect.top - wr.top;

      document.body.style.cursor = 'move';

      const onMove = (moveEv) => {
        if (!d.active) return;
        const wrMove = d.wrapEl.getBoundingClientRect();
        let newLeft = moveEv.clientX - wrMove.left - d.ptrOffsetX;
        let newTop = moveEv.clientY - wrMove.top - d.ptrOffsetY;
        newLeft = Math.max(0, Math.min(d.wrapW - d.shellW, newLeft));
        newTop = Math.max(0, Math.min(d.wrapH - d.shellH, newTop));
        d.lastShellLeft = newLeft;
        d.lastShellTop = newTop;
        // setState 없이 DOM style만 직접 수정 → 리렌더 없음
        d.shellEl.style.left = `${newLeft}px`;
        d.shellEl.style.top = `${newTop}px`;
      };

      const onUp = () => {
        if (!d.active) return;
        d.active = false;
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        d.unlisten = null;

        // mousemove와 동일한 px → nx/ny (mouseup 시 getBoundingClientRect 재측정으로 튕기는 것 방지)
        const { nx, ny } = shellPxToNorm(d.lastShellLeft, d.lastShellTop, d.wrapW, d.wrapH);

        skipWrapPlacementAfterDragRef.current = true;

        if (d.field === 'attendance') {
          setAttendanceSpec((prev) => (prev ? { ...prev, nx, ny } : prev));
        } else {
          setNameSpec((prev) => (prev ? { ...prev, nx, ny } : prev));
        }
      };

      d.unlisten = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [viewportMeta, activateExamFieldForKeyboard]
  );

  const onWrapPointerUp = useCallback(
    (e) => {
      if (dragRef.current.active || skipWrapPlacementAfterDragRef.current) {
        skipWrapPlacementAfterDragRef.current = false;
        return;
      }
      const t = e.target;
      if (t instanceof Element && t.closest('.exam-pdf-field-overlay')) return;
      applyPlacementAtClient(e.clientX, e.clientY);
    },
    [applyPlacementAtClient]
  );

  /** 이름·번호 칸 좌표만 IndexedDB에 저장 (PDF·학생 목록과 무관) */
  async function handleSaveCoordsOnly() {
    if (!attendanceSpec || !nameSpec) {
      window.alert('출석번호 입력과 이름 입력을 모두 찍어 주세요.');
      return;
    }
    setManualCoordSavePending(true);
    setCoordsSaveHint('');
    try {
      await saveExamSpecs(attendanceSpec, nameSpec, pdfFile?.name, REG_MARK_SPEC);
      await persistStudentFieldRegions(attendanceSpec, nameSpec);
      setCoordsSaveHint('이름·번호 칸 좌표를 저장했습니다. (스캔 OCR 박스 포함)');
      window.setTimeout(() => setCoordsSaveHint(''), 2800);
    } catch (err) {
      console.error(err);
      window.alert('좌표 저장 실패: ' + (err.message || String(err)));
    } finally {
      setManualCoordSavePending(false);
    }
  }

  /** 생성 확인 모달 열기 — 좌표를 먼저 저장한 뒤 모달 표시 */
  async function handleOpenConfirmModal() {
    if (!pdfBuf) {
      window.alert('시험지를 먼저 선택해 주세요.');
      return;
    }
    if (!attendanceSpec || !nameSpec) {
      window.alert('출석번호 입력과 이름 입력을 모두 찍어 주세요.');
      return;
    }
    if (!mergedStudents.length) {
      window.alert('등록된 학생이 없습니다. 교사 대시보드에서 학생을 등록해 주세요.');
      return;
    }
    setOpeningModalSavePending(true);
    try {
      await saveExamSpecs(
        attendanceSpec,
        nameSpec,
        pdfFile?.name,
        REG_MARK_SPEC
      );
      await persistStudentFieldRegions(attendanceSpec, nameSpec);
      setShowConfirmModal(true);
    } catch (err) {
      console.error(err);
      window.alert('좌표 저장 실패: ' + (err.message || String(err)));
    } finally {
      setOpeningModalSavePending(false);
    }
  }

  /** 모달 확인 후 실행 */
  async function runGenerateDownloads() {
    setShowConfirmModal(false);
    if (!pdfBuf || !attendanceSpec || !nameSpec) return;

    setGenerating(true);
    setGenProgress(0);

    try {
      await saveExamSpecs(
        attendanceSpec,
        nameSpec,
        pdfFile?.name,
        REG_MARK_SPEC
      );
      await persistStudentFieldRegions(attendanceSpec, nameSpec);
      const krFontBuf = await loadKoreanFontBytes();
      const arucoBytesById = await loadArucoPngBytes().catch((e) => {
        console.warn('ArUco 마커 로드 실패(무시):', e);
        return null;
      });
      const n = mergedStudents.length;

      const baseStem = sanitizeFileName(
        pdfFile?.name.replace(/\.pdf$/i, '') || 'exam'
      );

      // 원본은 1회만 로드. 학생마다 전체 PDF를 저장·재로드하면 Noto CJK(수 MB~16MB)가
      // 인원 수만큼 중복 임베드되어 통합 파일이 비정상적으로 커짐 → 단일 문서에 폰트 1회 + subset.
      const basePdf = await PDFDocument.load(new Uint8Array(pdfBuf.slice(0)), {
        ignoreEncryption: true,
      });
      const basePageIndices = basePdf.getPageIndices();
      if (!basePageIndices.length) throw new Error('PDF에 페이지가 없습니다.');

      const markBorder = rgb(0.35, 0.35, 0.35);
      const hasMarkBoxes = gradeMarkRegions.length > 0;
      const markResolveW = Number(markRegionsRecord?.page_width) || 595;
      const markResolveH = Number(markRegionsRecord?.page_height) || 841;

      const anyAttendance = mergedStudents.some(
        (s) => s.studentNumber != null && String(s.studentNumber) !== ''
      );
      const resolvePrintedName = (student, idx0) => {
        const real = student?.realName ?? student?.displayName ?? '';
        if (namePrintMode === 'nickname') {
          return resolveKimchiNickname(student, idx0) || '';
        }
        return real;
      };

      const anyName = mergedStudents.some((s, idx0) => Boolean(resolvePrintedName(s, idx0)));
      const anyCjkName = mergedStudents.some((s, idx0) => nameNeedsCjkFont(resolvePrintedName(s, idx0)));

      const outPdf = await PDFDocument.create();
      outPdf.registerFontkit(fontkit);

      const arucoEmbedded =
        arucoBytesById && REG_MARK_SPEC?.markerType !== 'l'
          ? {
              tl: await outPdf.embedPng(arucoBytesById[10]),
              tr: await outPdf.embedPng(arucoBytesById[11]),
              br: await outPdf.embedPng(arucoBytesById[12]),
              bl: await outPdf.embedPng(arucoBytesById[13]),
            }
          : null;

      const latinFont =
        anyAttendance || anyName
          ? await outPdf.embedFont(StandardFonts.Helvetica)
          : null;
      const hangulFont = anyCjkName
        ? await outPdf.embedFont(new Uint8Array(krFontBuf), { subset: true })
        : null;

      for (let i = 0; i < n; i++) {
        const s = mergedStudents[i];
        const attendanceText =
          s.studentNumber != null && s.studentNumber !== ''
            ? String(s.studentNumber)
            : '';
        const nameText = resolvePrintedName(s, i);

        const copied = await outPdf.copyPages(basePdf, basePageIndices);
        copied.forEach((p, pageIdx) => {
          const { width: wPt, height: hPt } = p.getSize();
          drawRegistrationMarksOnPdfPage(p, wPt, hPt, REG_MARK_SPEC);
          drawArucoMarkersOnPdfPage(p, wPt, hPt, REG_MARK_SPEC, arucoEmbedded);
          if (hasMarkBoxes) {
            const pageNum = pageIdx + 1;
            const onPage = gradeMarkRegions.filter((r) => Number(r.page) === pageNum);
            drawProblemMarkBoxesOnPdfPage(
              p,
              wPt,
              hPt,
              onPage,
              markBorder,
              markResolveW,
              markResolveH,
            );
          }
        });
        copied.forEach((p) => outPdf.addPage(p));
        const page = copied[0];
        const { width: W, height: H } = page.getSize();

        const aNx = attendanceSpec.nx;
        const aNy = attendanceSpec.ny;
        const nNx = nameSpec.nx;
        const nNy = nameSpec.ny;

        if (latinFont && attendanceText) {
          const attPos = examFieldPdfDrawCoords(
            aNx,
            aNy,
            W,
            H,
            attendanceSpec.fontSizePt,
            latinFont,
            viewportMeta,
            false
          );
          page.drawText(attendanceText, {
            x: attPos.x,
            y: attPos.y,
            size: attendanceSpec.fontSizePt,
            font: latinFont,
            color: rgb(0, 0, 0),
          });
        }

        if (latinFont && nameText) {
          const nameFont =
            nameNeedsCjkFont(nameText) && hangulFont ? hangulFont : latinFont;
          const nameCjk = nameFont === hangulFont;
          const printedName = truncateTextToExamFieldWidth(
            nameText,
            nameFont,
            nameSpec.fontSizePt,
            EXAM_FIELD_CHARS_WIDE.name,
            viewportMeta
          );
          if (printedName) {
            const namePos = examFieldPdfDrawCoords(
              nNx,
              nNy,
              W,
              H,
              nameSpec.fontSizePt,
              nameFont,
              viewportMeta,
              nameCjk
            );
            page.drawText(printedName, {
              x: namePos.x,
              y: namePos.y,
              size: nameSpec.fontSizePt,
              font: nameFont,
              color: rgb(0, 0, 0),
            });
          }
        }

        setGenProgress(Math.round(((i + 1) / n) * 85));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      setGenProgress(98);
      const finalBytes = await outPdf.save();
      const blob = new Blob([finalBytes], { type: 'application/pdf' });
      await triggerDownload(blob, `${baseStem}_전체_${n}명.pdf`);
      setGenProgress(100);
    } catch (err) {
      console.error(err);
      window.alert('PDF 생성 오류: ' + (err.message || String(err)));
    }

    setGenerating(false);
    setGenProgress(0);
  }

  const baseName = pdfFile?.name.replace(/\.pdf$/i, '') || 'exam';

  const fieldLayouts = useMemo(() => {
    void layoutTick;
    void renderingPdf;
    const el = wrapRef.current;
    if (!viewportMeta || !el) return { attendance: null, name: null };
    const r = el.getBoundingClientRect();
    if (!(r.width > 8) || !(r.height > 8)) return { attendance: null, name: null };
    return {
      attendance: attendanceSpec
        ? overlayInputBoxPx(attendanceSpec, viewportMeta, r.width, r.height, 'attendance')
        : null,
      name: nameSpec
        ? overlayInputBoxPx(nameSpec, viewportMeta, r.width, r.height, 'name')
        : null,
    };
  }, [viewportMeta, attendanceSpec, nameSpec, layoutTick, renderingPdf]);

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => navigate('/teacher')}
          >
            ← 대시보드
          </button>
          <span className="header-icon">📄</span>
          <div>
            <h1 className="header-title">시험지에 학생의 번호·이름 자동 입력</h1>
            <p className="header-subtitle">
              학생 목록·PDF는 이 브라우저에서만 처리되며 파일은 서버에 저장되지 않습니다.
            </p>
          </div>
        </div>
      </header>

      <main className="dashboard-main">
        {loadErr && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            ⚠️ {loadErr}
          </div>
        )}

        {!classCode && (
          <div className="alert" style={{ marginBottom: 12 }}>
            교사 대시보드에서 학급을 먼저 선택한 뒤 이 페이지를 열어 주세요.
          </div>
        )}

        <div
          style={{
            background: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: 12,
            padding: '10px 16px',
            fontSize: 13,
            color: '#15803d',
            marginBottom: 16,
          }}
        >
          번호·이름은 <strong>스캔 인식 정확도</strong>를 위해 <strong>일반체(굵지 않음)</strong>로 인쇄합니다
          (번호 Helvetica, 이름 Noto Sans KR Regular). 글자 크기는 <strong>11~13pt</strong>(기본 12pt)입니다.
          미리보기는 파란/녹색 테두리 칸으로 확인하며, 첫 페이지만 해당합니다.
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '0 0 16px' }}>
          <div style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>이름 칸</div>
          <button
            type="button"
            className={`btn btn-sm ${namePrintMode === 'name' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setNamePrintMode('name')}
          >
            이름
          </button>
          <button
            type="button"
            className={`btn btn-sm ${namePrintMode === 'nickname' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setNamePrintMode('nickname')}
          >
            닉네임
          </button>
        </div>

        <HudFrame>
          <div className="section-header">
            <h2 className="section-title">1. 시험지 선택</h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => refreshLibrary()}
                disabled={libraryLoading || libraryFileBusy}
              >
                {libraryLoading ? '불러오는 중…' : '새로고침'}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => navigate('/exam-papers')}
              >
                시험지 업로드로 이동 →
              </button>
            </div>
          </div>
          <p style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
            「시험지 업로드」에 등록해 둔 PDF 중에서 골라 사용합니다. 등록된 시험지가 없으면 위 「시험지 업로드로 이동」 버튼으로 먼저 PDF를 추가해 주세요.
          </p>

          {libraryLoadError ? (
            <div className="alert alert-error" style={{ marginBottom: 12 }}>
              ⚠️ {libraryLoadError}
            </div>
          ) : null}

          {libraryLoading ? (
            <p style={{ color: '#64748b', margin: 0 }}>
              <span className="spinner" /> 등록된 시험지를 불러오는 중…
            </p>
          ) : libraryEntries.length === 0 ? (
            <div
              className="alert"
              style={{
                background: '#fef9c3',
                border: '1px solid #fde047',
                color: '#854d0e',
                margin: 0,
              }}
            >
              아직 등록된 시험지가 없습니다. 먼저 「시험지 업로드」에서 PDF를 추가해 주세요.
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
                alignItems: 'center',
              }}
            >
              <select
                className="form-input"
                style={{ minWidth: 320, maxWidth: '100%' }}
                value={libraryPickId}
                onChange={(e) => handlePickFromLibrary(e.target.value)}
                disabled={libraryFileBusy}
                aria-label="등록된 시험지에서 선택"
              >
                <option value="">— 시험지를 선택해 주세요 —</option>
                {libraryEntries.map((en) => {
                  const meta = [en.grade, en.semester, en.unit].filter(Boolean).join(' · ');
                  return (
                    <option key={en.id} value={en.id}>
                      {en.label}
                      {meta ? ` (${meta})` : ''}
                    </option>
                  );
                })}
              </select>
              {libraryFileBusy ? (
                <span style={{ fontSize: 13, color: '#64748b' }}>
                  <span className="spinner" /> 시험지 불러오는 중…
                </span>
              ) : pdfFile ? (
                <span style={{ fontSize: 14, color: '#64748b' }}>
                  현재 선택: <strong>{pdfFile.name}</strong>
                </span>
              ) : null}
            </div>
          )}
        </HudFrame>

        <HudFrame>
          <div className="section-header">
            <h2 className="section-title">2. 미리보기 · 입력 칸 배치</h2>
          </div>

          <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span style={{ fontWeight: 600, marginRight: 4 }}>지정 중:</span>
            <button
              type="button"
              className={`btn btn-sm ${selectionMode === 'attendance' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setSelectionMode('attendance')}
            >
              출석번호 입력 (파랑)
            </button>
            <button
              type="button"
              className={`btn btn-sm ${selectionMode === 'name' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setSelectionMode('name')}
            >
              이름 입력 (녹색)
            </button>
            <span
              className="exam-pdf-placement-hint"
              style={{ flex: '1 1 220px', minWidth: 200 }}
            >
              <span className="exam-pdf-placement-hint__stroke" aria-hidden="true">
                {PLACEMENT_HINT_TEXT}
              </span>
              <span className="exam-pdf-placement-hint__fill">{PLACEMENT_HINT_TEXT}</span>
            </span>
          </div>

          <div
            style={{
              marginBottom: 16,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 16,
              alignItems: 'flex-end',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 16,
                alignItems: 'flex-end',
              }}
            >
              <div
                className="form-group"
                style={{ marginBottom: 0, flex: '0 0 auto' }}
              >
                <label className="form-label" style={{ whiteSpace: 'nowrap' }}>
                  출석번호 글자 크기 <span style={{ fontWeight: 400, color: '#64748b' }}>(11~13pt·기본 12)</span>
                </label>
                {attendanceSpec ? (
                  <select
                    className="form-input"
                    style={{ width: 120 }}
                    value={attendanceSpec.fontSizePt}
                    onChange={(e) => {
                      const v = normalizeExamFieldFontSizePt(Number(e.target.value));
                      setAttendanceSpec((prev) => (prev ? { ...prev, fontSizePt: v } : prev));
                    }}
                  >
                    {FONT_SIZES.map((s) => (
                      <option key={s} value={s}>{`${s}px(pt)`}</option>
                    ))}
                  </select>
                ) : (
                  <select className="form-input" style={{ width: 120 }} disabled>
                    <option>입력 칸 찍은 뒤 설정</option>
                  </select>
                )}
              </div>
              <div
                className="form-group"
                style={{ marginBottom: 0, flex: '0 0 auto' }}
              >
                <label className="form-label" style={{ whiteSpace: 'nowrap' }}>
                  이름 글자 크기 <span style={{ fontWeight: 400, color: '#64748b' }}>(11~13pt·기본 12)</span>
                </label>
                {nameSpec ? (
                  <select
                    className="form-input"
                    style={{ width: 120 }}
                    value={nameSpec.fontSizePt}
                    onChange={(e) => {
                      const v = normalizeExamFieldFontSizePt(Number(e.target.value));
                      setNameSpec((prev) => (prev ? { ...prev, fontSizePt: v } : prev));
                    }}
                  >
                    {FONT_SIZES.map((s) => (
                      <option key={s} value={s}>{`${s}px(pt)`}</option>
                    ))}
                  </select>
                ) : (
                  <select className="form-input" style={{ width: 120 }} disabled>
                    <option>입력 칸 찍은 뒤 설정</option>
                  </select>
                )}
              </div>
            </div>
            <div className="exam-pdf-field-move-hint">
              <div className="exam-pdf-field-move-hint__stroke" aria-hidden="true">
                <ExamFieldMoveHintBody />
              </div>
              <div className="exam-pdf-field-move-hint__fill">
                <ExamFieldMoveHintBody />
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setAttendanceSpec(null);
                setNameSpec(null);
              }}
            >
              입력 칸 초기화
            </button>
          </div>

          {!pdfBuf ? (
            <div className="empty-box">
              PDF를 업로드하면 미리보기가 표시됩니다.
            </div>
          ) : (
            <div
              ref={viewportOuterRef}
              style={{
                width: '100%',
                maxHeight: '70vh',
                overflowY: 'auto',
                overflowX: 'hidden',
                WebkitOverflowScrolling: 'touch',
                boxSizing: 'border-box',
                border: '1px solid #e2e8f0',
                borderRadius: 12,
              }}
            >
              {renderingPdf && (
                <p style={{ margin: '0 0 8px 0', color: '#64748b' }}>
                  <span className="spinner" /> 렌더링 중...
                </p>
              )}
              <div ref={viewportContentRef} style={{ boxSizing: 'border-box', maxWidth: '100%', padding: 12 }}>
                <div
                  ref={wrapRef}
                  onPointerUp={onWrapPointerUp}
                  onMouseDown={(e) => {
                    const t = e.target;
                    if (!(t instanceof Element)) return;
                    if (t.closest('.exam-pdf-field-overlay')) return;
                    if (t.closest('.exam-pdf-field-drag-shell')) return;
                    e.preventDefault();
                  }}
                  onDragStart={(e) => {
                    const t = e.target;
                    if (!(t instanceof Element)) return;
                    if (t.closest('.exam-pdf-field-overlay')) return;
                    if (t.closest('.exam-pdf-field-drag-shell')) return;
                    e.preventDefault();
                  }}
                  style={{
                    position: 'relative',
                    display: 'inline-block',
                    cursor: pdfBuf && viewportMeta ? 'text' : 'default',
                    maxWidth: '100%',
                    lineHeight: 0,
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    MozUserSelect: 'none',
                  }}
                >
                  <canvas ref={canvasRef} draggable={false} />
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      overflow: 'visible',
                      pointerEvents: 'none',
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      MozUserSelect: 'none',
                    }}
                  >
                    {attendanceSpec && fieldLayouts.attendance && (
                      <div
                        ref={attendanceShellRef}
                        role="presentation"
                        tabIndex={-1}
                        className="exam-pdf-field-drag-shell"
                        title="드래그 또는 방향키(Shift=5px)로 위치 조정"
                        style={{
                          position: 'absolute',
                          left: fieldLayouts.attendance.x - EXAM_FIELD_DRAG_MARGIN_PX,
                          top: fieldLayouts.attendance.y - EXAM_FIELD_DRAG_MARGIN_PX,
                          width: fieldLayouts.attendance.width + EXAM_FIELD_DRAG_MARGIN_PX * 2,
                          height: fieldLayouts.attendance.height + EXAM_FIELD_DRAG_MARGIN_PX * 2,
                          cursor: 'move',
                          pointerEvents: 'auto',
                          zIndex: 9998,
                          boxSizing: 'border-box',
                          outline:
                            selectionMode === 'attendance'
                              ? '2px dashed rgba(37, 99, 235, 0.85)'
                              : undefined,
                          outlineOffset: 2,
                        }}
                        onMouseDown={(ev) => beginExamFieldOverlayDrag('attendance', ev)}
                        onDragStart={examFieldPreventDragStart}
                      >
                        <div
                          key={`attendance-${attendanceSpec.nx}-${attendanceSpec.ny}-${attendanceSpec.fontSizePt}`}
                          className="exam-pdf-field-overlay"
                          role="img"
                          aria-label="출석번호 미리보기"
                          onPointerDown={(ev) => onExamFieldOverlayActivate('attendance', ev)}
                          onPointerUp={stopExamFieldEventBubble}
                          onMouseDown={(ev) => onExamFieldOverlayActivate('attendance', ev)}
                          onDragStart={examFieldPreventDragStart}
                          style={{
                            position: 'absolute',
                            left: EXAM_FIELD_DRAG_MARGIN_PX,
                            top: EXAM_FIELD_DRAG_MARGIN_PX,
                            width: fieldLayouts.attendance.width,
                            height: fieldLayouts.attendance.height,
                            border: `2px solid ${fieldLayouts.attendance.borderColor}`,
                            borderRadius: 4,
                            background: 'transparent',
                            cursor: 'text',
                            pointerEvents: 'auto',
                            zIndex: 9999,
                            boxSizing: 'border-box',
                            padding: '2px 4px',
                            margin: 0,
                            outline: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            fontSize: fieldLayouts.attendance.fontSize,
                            fontFamily: fieldLayouts.attendance.fontFamily,
                            fontWeight: fieldLayouts.attendance.fontWeight,
                            color: PREVIEW_SAMPLE_TEXT_COLOR,
                            lineHeight: fieldLayouts.attendance.lineHeight,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                          }}
                        >
                          {fieldLayouts.attendance.previewValue}
                        </div>
                      </div>
                    )}
                    {nameSpec && fieldLayouts.name && (
                      <div
                        ref={nameShellRef}
                        role="presentation"
                        tabIndex={-1}
                        className="exam-pdf-field-drag-shell"
                        title="드래그 또는 방향키(Shift=5px)로 위치 조정"
                        style={{
                          position: 'absolute',
                          left: fieldLayouts.name.x - EXAM_FIELD_DRAG_MARGIN_PX,
                          top: fieldLayouts.name.y - EXAM_FIELD_DRAG_MARGIN_PX,
                          width: fieldLayouts.name.width + EXAM_FIELD_DRAG_MARGIN_PX * 2,
                          height: fieldLayouts.name.height + EXAM_FIELD_DRAG_MARGIN_PX * 2,
                          cursor: 'move',
                          pointerEvents: 'auto',
                          zIndex: 10000,
                          boxSizing: 'border-box',
                          outline:
                            selectionMode === 'name'
                              ? '2px dashed rgba(5, 150, 105, 0.85)'
                              : undefined,
                          outlineOffset: 2,
                        }}
                        onMouseDown={(ev) => beginExamFieldOverlayDrag('name', ev)}
                        onDragStart={examFieldPreventDragStart}
                      >
                        <div
                          key={`name-${nameSpec.nx}-${nameSpec.ny}-${nameSpec.fontSizePt}`}
                          className="exam-pdf-field-overlay"
                          role="img"
                          aria-label="이름 미리보기"
                          onPointerDown={(ev) => onExamFieldOverlayActivate('name', ev)}
                          onPointerUp={stopExamFieldEventBubble}
                          onMouseDown={(ev) => onExamFieldOverlayActivate('name', ev)}
                          onDragStart={examFieldPreventDragStart}
                          style={{
                            position: 'absolute',
                            left: EXAM_FIELD_DRAG_MARGIN_PX,
                            top: EXAM_FIELD_DRAG_MARGIN_PX,
                            width: fieldLayouts.name.width,
                            height: fieldLayouts.name.height,
                            border: `2px solid ${fieldLayouts.name.borderColor}`,
                            borderRadius: 4,
                            background: 'transparent',
                            cursor: 'text',
                            pointerEvents: 'auto',
                            zIndex: 10001,
                            boxSizing: 'border-box',
                            padding: '2px 4px',
                            margin: 0,
                            outline: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            fontSize: fieldLayouts.name.fontSize,
                            fontFamily: fieldLayouts.name.fontFamily,
                            fontWeight: fieldLayouts.name.fontWeight,
                            color: PREVIEW_SAMPLE_TEXT_COLOR,
                            lineHeight: fieldLayouts.name.lineHeight,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                          }}
                        >
                          {fieldLayouts.name.previewValue}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </HudFrame>

        <HudFrame>
          <div className="section-header">
            <h2 className="section-title">
              3. 생성 대상 학생{' '}
              <span style={{ marginLeft: 8, fontSize: 14, fontWeight: 400, color: '#94a3b8' }}>
                {mergedStudents.length}명 · {pdfFile ? `원본 "${baseName}"` : ''}
              </span>
            </h2>
          </div>
          <p style={{ fontSize: 13, color: '#64748b', marginBottom: 8 }}>
            로컬(IndexedDB)에 실명이 없는 학생은 표시 이름이 UUID 안내 문자열로 채워질 수 있습니다.
          </p>
          {pdfFile && !markRegionsLoading && (
            <p
              style={{
                fontSize: 13,
                color: gradeMarkRegions.length > 0 ? '#15803d' : '#b45309',
                marginBottom: 12,
              }}
            >
              {gradeMarkRegions.length > 0
                ? `문항 번호 채점 네모 ${gradeMarkRegions.length}개 — 생성 PDF 모든 페이지에 인쇄됩니다.`
                : '문항 채점 네모 없음 — 「영역 수동 선택」에서 같은 PDF로 좌표 저장 후 다시 생성하세요.'}
            </p>
          )}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              alignItems: 'center',
              marginBottom: coordsSaveHint ? 6 : 0,
            }}
          >
            <button
              type="button"
              className="btn btn-outline"
              disabled={
                manualCoordSavePending ||
                openingModalSavePending ||
                generating ||
                !attendanceSpec ||
                !nameSpec
              }
              onClick={() => handleSaveCoordsOnly()}
            >
              {manualCoordSavePending ? (
                <>
                  <span className="spinner" /> 저장 중…
                </>
              ) : (
                '좌표 저장'
              )}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                manualCoordSavePending ||
                openingModalSavePending ||
                generating ||
                !pdfBuf ||
                !attendanceSpec ||
                !nameSpec ||
                mergedStudents.length === 0 ||
                !viewportMeta
              }
              onClick={() => handleOpenConfirmModal()}
            >
              {generating ? (
                <>
                  <span className="spinner" /> 생성 및 다운로드 중 ({genProgress}%)
                </>
              ) : openingModalSavePending ? (
                <>
                  <span className="spinner" /> 좌표 저장 중…
                </>
              ) : (
                `생성 및 다운로드 (통합 PDF ${mergedStudents.length}명분)`
              )}
            </button>
          </div>
          {coordsSaveHint ? (
            <p style={{ margin: 0, fontSize: 13, color: '#15803d' }}>{coordsSaveHint}</p>
          ) : null}
        </HudFrame>
      </main>

      {/* 생성 확인: 학생 목록 */}
      {showConfirmModal && (
        <div
          className="modal-overlay"
          style={{ zIndex: 50000 }}
          onClick={() => setShowConfirmModal(false)}
        >
          <div
            className="modal"
            style={{
              maxWidth: 520,
              maxHeight: 'min(82vh, 640px)',
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
              zIndex: 50001,
            }}
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="modal-header">
              <h3>PDF 생성 확인</h3>
              <button type="button" className="modal-close" onClick={() => setShowConfirmModal(false)}>
                ×
              </button>
            </div>
            <div className="modal-body" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: 1 }}>
              <p style={{ marginTop: 0, fontSize: 14, color: '#475569' }}>
                아래 학생 순서대로 한 파일에 이어 붙인 통합 PDF가 생성되어 한 번만 내려받습니다. 학생마다 번호·이름은
                해당 구간의 첫 페이지에만 표기됩니다. 서버에는 저장되지 않습니다.
              </p>
              <p style={{ marginTop: 0, fontSize: 13, color: '#64748b' }}>
                원본: <strong>{baseName}</strong>
                {' · '}
                <strong>{mergedStudents.length}</strong>명 · 번호·이름은 각 학생 구간의{' '}
                <strong>모든 페이지</strong>에 표기합니다.
              </p>
              <p style={{ marginTop: 8, fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>
                스캔 자동정리용으로 매 페이지 네 모서리에 <strong>진한 회색 L자</strong>(약 4mm
                여백)가 자동 인쇄됩니다. 스캔 인식을 위해 선명하게 넣으며, 페이지 위치 보정에
                씁니다.
              </p>
              <div className="table-wrapper" style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 12 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>번호</th>
                      <th>이름(미리보기)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mergedStudents.map((s) => (
                      <tr key={s.uuid} style={!s.hasLocalData ? { opacity: 0.72 } : {}}>
                        <td className="text-center">{s.studentNumber ?? '—'}</td>
                        <td>
                          <strong>{s.realName ?? s.displayName}</strong>
                          {!s.hasLocalData && (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 10,
                                color: '#64748b',
                              }}
                            >
                              로컬 실명 없음
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="modal-footer" style={{ borderTop: '1px solid #e2e8f0', marginTop: 8 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setShowConfirmModal(false)}>
                취소
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={generating}
                onClick={() => runGenerateDownloads()}
              >
                확인 후 생성
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
