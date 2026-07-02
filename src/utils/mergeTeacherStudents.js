/**
 * TeacherDashboard 표시용: Firebase 학생 문서 + IndexedDB 매핑(실명)
 *
 * uuid 필드가 없는 레거시 문서는 문서 id 를 식별자로 사용합니다.
 */

import { normalizeClassCode } from './classCode';

/** Firestore 학생 행 안정적인 UUID — uuid 필드 누락 시 문서 id */
export function studentFirestoreId(s) {
  if (!s || typeof s !== 'object') return '';
  const v = s.uuid ?? s.id;
  return typeof v === 'string' ? v.trim() : '';
}

/** IndexedDB 또는 백업 JSON 등에서 표시 이름 추출 — 키 변형 허용 */
export function mappingDisplayNameRaw(m) {
  if (!m || typeof m !== 'object') return '';
  const cands = [
    m.realName,
    m.name,
    m.displayName,
    m.studentName,
  ];
  for (const c of cands) {
    if (typeof c === 'string') {
      const t = c.trim();
      if (t) return t;
    }
  }
  return '';
}

function mappingUuid(m) {
  return String(m?.uuid ?? '').trim();
}

/** 출석번호 — 양의 정수만 (서버·teacherDB와 동일 규칙) */
export function finitePositiveStudentNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function studentAttendanceSortKey(row) {
  const uuid = studentFirestoreId(row);
  if (uuid) return `u:${uuid}`;
  if (row?.blockIndex != null && Number.isFinite(row.blockIndex)) {
    return `b:${String(row.blockIndex).padStart(8, '0')}`;
  }
  return '';
}

/** 출석번호 오름차순 — 번호 없으면 맨 뒤, 동률 시 uuid·blockIndex */
export function compareStudentsByAttendance(a, b) {
  const na = finitePositiveStudentNumber(a?.studentNumber);
  const nb = finitePositiveStudentNumber(b?.studentNumber);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  if (na !== null && nb === null) return -1;
  if (na === null && nb !== null) return 1;
  return studentAttendanceSortKey(a).localeCompare(studentAttendanceSortKey(b));
}

/** @param {Array} students */
export function sortStudentsByAttendance(students) {
  return [...(students || [])].sort(compareStudentsByAttendance);
}

/**
 * studentUUID 등을 가진 행을 명단 출석번호 순으로 정렬
 * @param {Array} rows
 * @param {Array} students 출석번호가 있는 학생 목록
 * @param {string} [uuidField='studentUUID']
 */
export function sortRowsByStudentAttendance(rows, students, uuidField = 'studentUUID') {
  const order = new Map(
    sortStudentsByAttendance(students).map((s, i) => [studentFirestoreId(s), i]),
  );
  return [...(rows || [])].sort((a, b) => {
    const ia = order.get(String(a?.[uuidField] ?? '').trim()) ?? 99999;
    const ib = order.get(String(b?.[uuidField] ?? '').trim()) ?? 99999;
    if (ia !== ib) return ia - ib;
    return String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
  });
}

function attendanceKey(classCodeNorm, studentNumber) {
  const sn = finitePositiveStudentNumber(studentNumber);
  if (!classCodeNorm || sn === null) return null;
  return `${classCodeNorm}\u0000${sn}`;
}

/** 같은 키에 여러 로컬 행이 있으면 실명이 있는 쪽·최근 addedAt 우선 */
function pickBetterMapping(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const pn = mappingDisplayNameRaw(prev);
  const nn = mappingDisplayNameRaw(next);
  if (pn && !nn) return prev;
  if (!pn && nn) return next;
  return String(next.addedAt || '').localeCompare(String(prev.addedAt || '')) >= 0
    ? next
    : prev;
}

/**
 * @param {Array} localMappings 해당 학급(또는 관련) IndexedDB 매핑
 * @param {Array} serverStudents Firestore 학생 목록
 * @param {string} [dashboardClassCode] 현재 대시보드 학급 — 있으면 서버 행의 classCode 대신 이 값으로 출석번호 키를 맞춤
 */
export function mergeStudentsForTeacherView(localMappings, serverStudents, dashboardClassCode) {
  const contextClass = dashboardClassCode != null && String(dashboardClassCode).trim()
    ? normalizeClassCode(dashboardClassCode)
    : '';

  const mappingsBySid = new Map();
  const mappingsByAttendance = new Map();

  (localMappings || []).forEach((m) => {
    const id = mappingUuid(m);
    if (id) {
      const prev = mappingsBySid.get(id);
      mappingsBySid.set(id, pickBetterMapping(prev, m));
    }

    const mcc = normalizeClassCode(m.classCode);
    const sn = finitePositiveStudentNumber(m.studentNumber);
    if (mcc && sn !== null) {
      const k = attendanceKey(mcc, sn);
      if (k) {
        const prev = mappingsByAttendance.get(k);
        mappingsByAttendance.set(k, pickBetterMapping(prev, m));
      }
    }
  });

  const result = [];

  (serverStudents || []).forEach((raw) => {
    const sid = studentFirestoreId(raw);
    if (!sid) return;

    const srvCc = contextClass || normalizeClassCode(raw.classCode);
    const srvSn = finitePositiveStudentNumber(raw.studentNumber);

    let m = null;
    const attK = attendanceKey(srvCc, srvSn);
    if (attK) {
      const att = mappingsByAttendance.get(attK);
      if (att) {
        m = att;
      }
    }

    if (!m) {
      m = mappingsBySid.get(sid);
    }

    const nm = mappingDisplayNameRaw(m);

    if (nm) {
      result.push({
        ...m,
        ...raw,
        uuid: sid,
        displayName: nm,
        hasLocalData: true,
      });
    } else {
      result.push({
        ...raw,
        uuid: sid,
        displayName: '[이름 없음]',
        hasLocalData: false,
      });
    }
  });

  return sortStudentsByAttendance(result);
}
