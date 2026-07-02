import { renderMathText } from '../components/ExamOCR';
import { VARIANT_STRATEGIES } from '../constants/variantStrategies';
import { normalizeClassCode } from './classCode';
import {
  finitePositiveStudentNumber,
  mappingDisplayNameRaw,
  studentFirestoreId,
} from './mergeTeacherStudents';

/** @param {string} id */
function normalizeUuidCompact(id) {
  return String(id || '').trim().toLowerCase().replace(/-/g, '');
}

/** 8자리·전체 UUID·하이픈 유무 혼용 매칭 */
function uuidCompactMatches(a, b) {
  const left = normalizeUuidCompact(a);
  const right = normalizeUuidCompact(b);
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

/** 학급 문제은행 problemId 끝 8자리(출제자 UUID 접두) */
function extractCreatorPrefixFromClassProblemId(problemId) {
  const parts = String(problemId || '').trim().split('_');
  const tail = parts[parts.length - 1] || '';
  return /^[0-9a-f]{8}$/i.test(tail) ? tail.toLowerCase() : '';
}

/** 검수 문서에서 학생 UUID 추출 (필드 누락·reviewId 접두 보정) */
export function extractReviewStudentUuid(item) {
  if (!item || typeof item !== 'object') return '';
  const direct = String(item.studentUUID || item.createdBy || '').trim();
  if (direct.length > 8) return direct;

  const fromProblemId = extractCreatorPrefixFromClassProblemId(item.classProblemId);
  if (fromProblemId) return fromProblemId;

  const rid = String(item.id || item.reviewId || '').trim();
  const legacyExam = rid.match(/_s([^_]+)_q\d+/);
  if (legacyExam?.[1] && legacyExam[1].length > 8) return legacyExam[1];

  if (direct) return direct;

  const vrPrefix = rid.match(/^vr_([0-9a-f]{8})_/i);
  if (vrPrefix?.[1]) return vrPrefix[1];

  return '';
}

function resolveFullStudentId(sid, mergedStudents, serverStudents) {
  const raw = String(sid || '').trim();
  if (!raw) return '';
  const needle = normalizeUuidCompact(raw);
  const seen = new Set();
  for (const row of [...(mergedStudents || []), ...(serverStudents || [])]) {
    const full = studentFirestoreId(row);
    if (!full || seen.has(full)) continue;
    seen.add(full);
    if (uuidCompactMatches(full, needle)) return full;
  }
  return raw;
}

function findMergedStudent(mergedStudents, sid) {
  const needle = normalizeUuidCompact(sid);
  if (!needle) return null;
  return (mergedStudents || []).find((m) => {
    const id = normalizeUuidCompact(studentFirestoreId(m));
    if (!id) return false;
    return uuidCompactMatches(id, needle);
  }) || null;
}

function findLocalMapping(localMappings, { uuid, classCode, studentNumber }) {
  const uid = String(uuid || '').trim();
  if (uid) {
    const byUuid = (localMappings || []).find((m) => {
      const mid = String(m?.uuid || '').trim();
      if (!mid) return false;
      return uuidCompactMatches(mid, uid);
    });
    if (byUuid) return byUuid;
  }

  const sn = finitePositiveStudentNumber(studentNumber);
  const cc = normalizeClassCode(classCode);
  if (sn !== null && cc) {
    return (localMappings || []).find((m) => (
      normalizeClassCode(m?.classCode) === cc
      && finitePositiveStudentNumber(m?.studentNumber) === sn
    )) || null;
  }
  return null;
}

function formatStudentLabel(name, studentNumber) {
  const nm = String(name || '').trim();
  if (!nm || nm === '[이름 없음]') return null;
  const sn = finitePositiveStudentNumber(studentNumber);
  return sn !== null ? `${nm} (${sn}번)` : nm;
}

/**
 * @param {Array} mergedStudents
 * @param {string} studentUUID
 * @param {Array} localMappings
 * @param {{ serverStudents?: Array, classCode?: string, reviewItem?: object }} [opts]
 */
export function resolveStudentLabel(mergedStudents, studentUUID, localMappings, opts = {}) {
  const { serverStudents = [], classCode = '', reviewItem = null } = opts;
  let sid = String(studentUUID || '').trim();
  if (!sid && reviewItem) sid = extractReviewStudentUuid(reviewItem);
  if (!sid) return '미확인';

  sid = resolveFullStudentId(sid, mergedStudents, serverStudents);

  const st = findMergedStudent(mergedStudents, sid);
  const mergedLabel = formatStudentLabel(st?.displayName || st?.realName, st?.studentNumber);
  if (mergedLabel) return mergedLabel;

  const local = findLocalMapping(localMappings, {
    uuid: sid,
    classCode: classCode || st?.classCode,
    studentNumber: st?.studentNumber,
  });
  const localLabel = formatStudentLabel(mappingDisplayNameRaw(local), local?.studentNumber ?? st?.studentNumber);
  if (localLabel) return localLabel;

  const sn = finitePositiveStudentNumber(st?.studentNumber ?? local?.studentNumber);
  if (sn !== null) return `출석 ${sn}번 (이름 미등록)`;

  return '이름 미등록 (학생 탭에서 실명 연결)';
}

/** 검수 카드용 — reviewItem 에서 UUID·이름을 함께 해석 */
export function resolveReviewStudentLabel(reviewItem, mergedStudents, localMappings, opts = {}) {
  return resolveStudentLabel(
    mergedStudents,
    extractReviewStudentUuid(reviewItem),
    localMappings,
    { ...opts, reviewItem },
  );
}

export function resolveVariantStrategyLabel(item) {
  const saved = String(item?.variantStrategyName || '').trim();
  if (saved) return saved;
  const id = String(item?.variantStrategyId || '').trim();
  if (!id) return '전략 미지정';
  return VARIANT_STRATEGIES.find((s) => s.id === id)?.title || id;
}

/** 검수 카드 — 줄바꿈·여러 줄 $수식$ 혼합 텍스트를 렌더 */
export function renderReviewMathLines(text) {
  if (!text) return null;
  return (
    <span style={{ whiteSpace: 'pre-wrap' }}>
      {renderMathText(text) ?? text}
    </span>
  );
}

export function studentDisplayLabel(student) {
  if (!student) return '';
  return student.displayName || student.realName || `학생 ${String(student.uuid || '').slice(0, 8)}`;
}

export function formatPct(value) {
  return value != null ? `${Math.round(value * 100)}%` : '—';
}

/** 검수함·제출 대기열 — createdAt 기준 (일찍 제출한 항목이 위) */
export function reviewSubmissionMillis(row) {
  const ts = row?.createdAt;
  if (ts?.toMillis) return ts.toMillis();
  if (ts) {
    const ms = new Date(ts).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

export function sortRowsBySubmissionTime(rows) {
  return [...(rows || [])].sort(
    (a, b) => reviewSubmissionMillis(a) - reviewSubmissionMillis(b),
  );
}
