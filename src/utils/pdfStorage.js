/**
 * 시험지 PDF·이름/번호 칸 좌표를 IndexedDB에 보관 (클라이언트 전용).
 * ExamPdfStudentLabels ↔ 문항 도구·ScanOrganize 연동용.
 * 시험지 여러 부 업로드(라이브러리)는 examPaperLibrary* 키 사용.
 */

const DB_NAME = 'exam-pdf-storage';
const DB_VERSION = 2;
const STORE = 'kv';

const KEY_PDF = 'examPdf';
const KEY_SPECS = 'examSpecs';

/** 시험지 파일명 기준 — 다른 PDF에 저장된 좌표가 섞이지 않게 함 */
function examSpecsKeyForPdfFileName(pdfFileName) {
  const n = String(pdfFileName || '').trim().toLowerCase();
  if (!n) return null;
  return `examSpecsPdf:${n}`;
}
const KEY_EXAM_LIBRARY_INDEX = 'examPaperLibraryIndex';
const KEY_EXAM_PAPER_BLOB_PREFIX = 'examPaperBlob:';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put(value, key);
  });
}

function idbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).delete(key);
  });
}

/**
 * 가능하면 SHA-256(보안 맥락). 없으면 앞부분만 읽는 로컬 지문(HTTP·구형 브라우저 대비).
 */
async function sha256HexOfBuffer(buffer) {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
      const hash = await crypto.subtle.digest('SHA-256', buffer);
      const bytes = new Uint8Array(hash);
      let hex = '';
      for (let i = 0; i < bytes.length; i += 1) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      return hex;
    }
  } catch {
    /* 비보안 출처 등에서 subtle 실패 */
  }
  const n = buffer.byteLength;
  const take = Math.min(n, 4 * 1024 * 1024);
  const slice = new Uint8Array(take === n ? buffer : buffer.slice(0, take));
  let h = 2166136261;
  for (let i = 0; i < slice.length; i += 1) {
    h ^= slice[i];
    h = Math.imul(h, 16777619);
  }
  return `local:${n}:${(h >>> 0).toString(16)}`;
}

function newLibraryItemId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ex-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function defaultLabelFromFileName(name) {
  const n = String(name || '시험지').trim() || '시험지';
  return n.replace(/\.pdf$/i, '');
}

/**
 * @param {File} file
 */
export async function saveExamPdf(file) {
  if (!file || typeof file.arrayBuffer !== 'function') return;
  const db = await openDb();
  const buffer = await file.arrayBuffer();
  await idbPut(db, KEY_PDF, {
    buffer,
    name: file.name || 'exam.pdf',
    type: file.type || 'application/pdf',
    lastModified: file.lastModified || Date.now(),
  });
}

/**
 * @returns {Promise<File | null>}
 */
export async function loadExamPdf() {
  const db = await openDb();
  const row = await idbGet(db, KEY_PDF);
  if (!row || !row.buffer) return null;
  const blob = new Blob([row.buffer], { type: row.type || 'application/pdf' });
  return new File([blob], row.name || 'exam.pdf', {
    type: row.type || 'application/pdf',
    lastModified: row.lastModified || Date.now(),
  });
}

/**
 * @param {{ nx: number, ny: number, fontSizePt: number } | null} attendanceSpec
 * @param {{ nx: number, ny: number, fontSizePt: number } | null} nameSpec
 * @param {string | null | undefined} [pdfFileName] — 있으면 해당 파일명으로 별도 저장(스캔 정리·템플릿과 매칭)
 * @param {object | null | undefined} [registrationMark] — 네 모서리 L자 스캔 보정 마크 규격
 */
export async function saveExamSpecs(attendanceSpec, nameSpec, pdfFileName, registrationMark) {
  const db = await openDb();
  const payload = {
    attendanceSpec: attendanceSpec ?? null,
    nameSpec: nameSpec ?? null,
    registrationMark: registrationMark ?? null,
  };
  await idbPut(db, KEY_SPECS, payload);
  const pk = examSpecsKeyForPdfFileName(pdfFileName);
  if (pk) await idbPut(db, pk, payload);
}

/**
 * @param {string | null | undefined} [pdfFileName] — 템플릿 `pdf_name`과 동일하면 그 시험지 전용 좌표를 불러옴. 없으면 전역(레거시)만.
 * @returns {Promise<{ attendanceSpec: object | null, nameSpec: object | null, specsScope?: 'perPdf' | 'legacy' | 'legacyFallback' | 'perPdfMissing' }>}
 */
export async function loadExamSpecs(pdfFileName) {
  const db = await openDb();
  const pk = examSpecsKeyForPdfFileName(pdfFileName);
  if (pk) {
    const scoped = await idbGet(db, pk);
    if (scoped && typeof scoped === 'object') {
      return {
        attendanceSpec: scoped.attendanceSpec ?? null,
        nameSpec: scoped.nameSpec ?? null,
        specsScope: 'perPdf',
      };
    }
    const legacyRow = await idbGet(db, KEY_SPECS);
    if (
      legacyRow &&
      typeof legacyRow === 'object' &&
      (legacyRow.attendanceSpec || legacyRow.nameSpec)
    ) {
      return {
        attendanceSpec: legacyRow.attendanceSpec ?? null,
        nameSpec: legacyRow.nameSpec ?? null,
        specsScope: 'legacyFallback',
      };
    }
    return { attendanceSpec: null, nameSpec: null, specsScope: 'perPdfMissing' };
  }
  const row = await idbGet(db, KEY_SPECS);
  if (!row || typeof row !== 'object') {
    return { attendanceSpec: null, nameSpec: null, specsScope: 'legacy' };
  }
  return {
    attendanceSpec: row.attendanceSpec ?? null,
    nameSpec: row.nameSpec ?? null,
    specsScope: 'legacy',
  };
}

// ─── 로컬 시험지 라이브러리 (서버 미저장, 교사 기기 IndexedDB만) ───

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   originalFileName: string,
 *   byteLength: number,
 *   lastModified: number,
 *   sha256: string,
 *   uploadedAt: string,
 *   grade: string,
 *   semester: string,
 *   unit: string,
 * }} ExamPaperLibraryEntry
 */

async function readLibraryIndex(db) {
  const row = await idbGet(db, KEY_EXAM_LIBRARY_INDEX);
  if (!row || !Array.isArray(row.entries)) return { entries: [] };
  const entries = row.entries.map((e) => ({
    ...e,
    grade: e.grade != null ? String(e.grade) : '',
    semester: e.semester != null ? String(e.semester) : '',
    unit: e.unit != null ? String(e.unit) : '',
  }));
  return { entries };
}

async function writeLibraryIndex(db, entries) {
  await idbPut(db, KEY_EXAM_LIBRARY_INDEX, { entries });
}

/**
 * 업로드해 둔 시험지 목록(메타만). 최신 업로드가 앞.
 * @returns {Promise<ExamPaperLibraryEntry[]>}
 */
export async function listExamPaperLibrary() {
  const db = await openDb();
  const { entries } = await readLibraryIndex(db);
  return [...entries].sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
}

/**
 * @param {string} id
 * @returns {Promise<ExamPaperLibraryEntry | null>}
 */
export async function getExamPaperLibraryEntry(id) {
  if (!id) return null;
  const list = await listExamPaperLibrary();
  return list.find((e) => e.id === id) || null;
}

/**
 * 시험지 OCR·영역 선택 화면에서 PDF 파일명·해시로 라이브러리 항목을 찾을 때 사용.
 * @param {{ id?: string, sha256?: string, originalFileName?: string }} hints
 * @returns {Promise<ExamPaperLibraryEntry | null>}
 */
export async function findExamPaperLibraryEntry(hints = {}) {
  const list = await listExamPaperLibrary();
  if (hints.id) {
    const byId = list.find((e) => e.id === hints.id);
    if (byId) return byId;
  }
  const sha = String(hints.sha256 || '').trim();
  if (sha) {
    const bySha = list.find((e) => e.sha256 === sha);
    if (bySha) return bySha;
  }
  const fileName = String(hints.originalFileName || '').trim();
  if (fileName) {
    return list.find((e) => String(e.originalFileName || '').trim() === fileName) || null;
  }
  return null;
}

/**
 * @param {File} file
 * @param {{ label?: string, grade?: string, semester?: string, unit?: string }} [opts]
 * @returns {Promise<{ id: string, duplicateOf?: ExamPaperLibraryEntry }>}
 */
export async function addExamPaperToLibrary(file, opts = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('PDF 파일이 필요합니다.');
  }
  const buffer = await file.arrayBuffer();
  const sha256 = await sha256HexOfBuffer(buffer);
  const db = await openDb();
  const { entries } = await readLibraryIndex(db);

  const duplicateOf = entries.find((e) => e.sha256 === sha256) || undefined;

  const id = newLibraryItemId();
  const uploadedAt = new Date().toISOString();
  const originalFileName = file.name || 'exam.pdf';
  const label = (opts.label != null && String(opts.label).trim())
    ? String(opts.label).trim()
    : defaultLabelFromFileName(originalFileName);
  const grade = String(opts.grade ?? '').trim();
  const semester = String(opts.semester ?? '').trim();
  const unit = String(opts.unit ?? '').trim();

  const entry = {
    id,
    label,
    originalFileName,
    byteLength: buffer.byteLength,
    lastModified: file.lastModified || Date.now(),
    sha256,
    uploadedAt,
    grade,
    semester,
    unit,
  };

  await idbPut(db, KEY_EXAM_PAPER_BLOB_PREFIX + id, {
    buffer,
    name: originalFileName,
    type: file.type || 'application/pdf',
    lastModified: entry.lastModified,
  });

  entries.unshift(entry);
  await writeLibraryIndex(db, entries);

  return duplicateOf ? { id, duplicateOf } : { id };
}

/**
 * @param {string} id
 * @returns {Promise<File | null>}
 */
export async function getExamPaperFileFromLibrary(id) {
  if (!id) return null;
  const db = await openDb();
  const row = await idbGet(db, KEY_EXAM_PAPER_BLOB_PREFIX + id);
  if (!row || !row.buffer) return null;
  const blob = new Blob([row.buffer], { type: row.type || 'application/pdf' });
  return new File([blob], row.name || 'exam.pdf', {
    type: row.type || 'application/pdf',
    lastModified: row.lastModified || Date.now(),
  });
}

const LIB_PATCH_KEYS = ['label', 'grade', 'semester', 'unit'];

/**
 * @param {string} id
 * @param {Partial<{ label: string, grade: string, semester: string, unit: string }>} patch
 */
export async function updateExamPaperLibraryEntry(id, patch) {
  if (!id || !patch || typeof patch !== 'object') return;
  const db = await openDb();
  const { entries } = await readLibraryIndex(db);
  const next = entries.map((e) => {
    if (e.id !== id) return e;
    const u = { ...e };
    for (const k of LIB_PATCH_KEYS) {
      if (patch[k] !== undefined) {
        u[k] = typeof patch[k] === 'string' ? patch[k].trim() : patch[k];
      }
    }
    if (u.label === '') u.label = e.label;
    return u;
  });
  await writeLibraryIndex(db, next);
}

/**
 * @param {string} id
 * @param {string} label
 */
export async function updateExamPaperLibraryLabel(id, label) {
  await updateExamPaperLibraryEntry(id, { label });
}

/**
 * @param {string} id
 */
export async function deleteExamPaperFromLibrary(id) {
  if (!id) return;
  const db = await openDb();
  const { entries } = await readLibraryIndex(db);
  const next = entries.filter((e) => e.id !== id);
  await writeLibraryIndex(db, next);
  await idbDelete(db, KEY_EXAM_PAPER_BLOB_PREFIX + id);
}
