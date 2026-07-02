/**
 * teacherDB.js — 교사 기기 전용 IndexedDB 래퍼
 *
 * ★ 개인정보 보호 핵심 ★
 * 학생의 실명(realName)은 오직 이 파일을 통해 교사 기기의 IndexedDB에만 저장됩니다.
 * 실명은 서버(Firebase)로 절대 전송되지 않습니다.
 *
 * DB 구조 (v2):
 * - DB 이름: MathAppTeacherDB
 * - 스토어: studentNamesByAttendance — keyPath [classCode, studentNumber] (정규화된 학급코드 + 출석번호)
 *   { classCode, studentNumber, realName, uuid, pinHash?, addedAt }
 * - 스토어: studentMappings (레거시) — keyPath uuid · 전환기간 2순위(번호 없거나 백업 복구 직후 등)
 *   { uuid, classCode, realName, studentNumber?, pinHash?, addedAt }
 * - 스토어: classInfo — { classCode (PK), className, teacherName?, … }
 */
import { normalizeClassCode } from './classCode';

const DB_NAME    = 'MathAppTeacherDB';
const DB_VERSION = 2;
const STORE_NAMES_BY_ATTENDANCE = 'studentNamesByAttendance';
/** UUID PK — 레거시·번호 미부여 레코드 전용 (전환기간) */
const STORE_LEGACY_MAPPINGS   = 'studentMappings';
const STORE_CLASSES  = 'classInfo';

/** 출석번호 양수만 유효 (Firestore createStudent 규칙과 동일) */
function finitePositiveStudentNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function mappingDisplayLike(name) {
  if (typeof name !== 'string') return '';
  return name.trim();
}

// ─────────────────────────────────────────────
// IndexedDB 열기 (없으면 생성)
// ─────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const ov = Number(e.oldVersion || 0);
      const tx = e.target.transaction;

      if (!db.objectStoreNames.contains(STORE_LEGACY_MAPPINGS)) {
        const store = db.createObjectStore(STORE_LEGACY_MAPPINGS, { keyPath: 'uuid' });
        store.createIndex('byClassCode', 'classCode', { unique: false });
        store.createIndex('byNameAndClass', ['classCode', 'realName'], { unique: true });
      }

      if (!db.objectStoreNames.contains(STORE_NAMES_BY_ATTENDANCE)) {
        const store = db.createObjectStore(STORE_NAMES_BY_ATTENDANCE, {
          keyPath: ['classCode', 'studentNumber'],
        });
        store.createIndex('byClassCode', 'classCode', { unique: false });
        store.createIndex('byUuid', 'uuid', { unique: false });
      }

      // v1 → v2: UUID 스토어에 있던 레코드를 출석번호 키 스토어로 옮김 (번호 불가 시 레거시에 유지)
      if (ov >= 1 && ov < 2) {
        const leg = tx.objectStore(STORE_LEGACY_MAPPINGS);
        const nm = tx.objectStore(STORE_NAMES_BY_ATTENDANCE);
        const cur = leg.openCursor();
        cur.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          const m = cursor.value;
          const sn = finitePositiveStudentNumber(m.studentNumber);
          const cc = normalizeClassCode(m.classCode);
          const uuid = String(m?.uuid ?? '').trim();
          if (sn !== null && cc && uuid) {
            try {
              nm.put({
                classCode: cc,
                studentNumber: sn,
                realName: mappingDisplayLike(m.realName),
                uuid,
                pinHash: m.pinHash,
                addedAt: m.addedAt || new Date().toISOString(),
              });
              cursor.delete();
            } catch {
              /* 남김 → 다음 행 처리 */
            }
          }
          cursor.continue();
        };
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function withStore(storeName, mode, callback) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const reqCb = callback(store);
      if (reqCb && typeof reqCb.onsuccess === 'undefined') {
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      } else if (reqCb) {
        reqCb.onsuccess = () => resolve(reqCb.result);
        reqCb.onerror   = () => reject(reqCb.error);
      } else {
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      }
    });
  });
}

// ─────────────────────────────────────────────
// 학생 매핑 CRUD
// ─────────────────────────────────────────────

/**
 * 출석번호 키 + 레거시 UUID 스토어를 합친 목록 (병렬 export·merge용)
 */
export function getAllMappings() {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      let named = [];
      let legacy = [];

      const tx = db.transaction([STORE_NAMES_BY_ATTENDANCE, STORE_LEGACY_MAPPINGS], 'readonly');

      const r1 = tx.objectStore(STORE_NAMES_BY_ATTENDANCE).getAll();
      r1.onsuccess = () => {
        named = r1.result || [];
      };

      const r2 = tx.objectStore(STORE_LEGACY_MAPPINGS).getAll();
      r2.onsuccess = () => {
        legacy = r2.result || [];
      };

      tx.oncomplete = () =>
        resolve(mergeDedupeMappingsPreferAttendance(named, legacy));
      tx.onerror = () => reject(tx.error);
    });
  });
}

function mappingUuid(m) {
  return String(m?.uuid ?? '').trim();
}

/** 출석번호 스토어가 동일 UUID에 우선 */
function mergeDedupeMappingsPreferAttendance(namedRows, legacyRows) {
  const byUuid = new Map();
  for (const r of legacyRows) {
    const id = mappingUuid(r);
    if (id) byUuid.set(id, r);
  }
  for (const r of namedRows) {
    const id = mappingUuid(r);
    if (id) byUuid.set(id, r);
  }
  return Array.from(byUuid.values());
}

/**
 * 학생 매핑 저장 (교사 기기에만 실명 저장)
 * @param {{ uuid, classCode, realName, studentNumber, pinHash }} mapping
 *
 * 출석번호가 유효하면 primary 스토어에만 보관하고 레거시 uuid 행은 제거합니다.
 * 번호가 없으면 레거시 UUID 스토어에만 저장합니다.
 */
export function saveStudentMapping(mapping) {
  const uuid = String(mapping?.uuid ?? '').trim();
  if (!uuid) return Promise.reject(new Error('학생 UUID가 필요합니다.'));

  const cc = normalizeClassCode(mapping.classCode);
  const sn = finitePositiveStudentNumber(mapping.studentNumber);
  const realName = mappingDisplayLike(mapping.realName);
  const pinHash = mapping.pinHash;
  const preserveAddedAt =
    mapping.addedAt && typeof mapping.addedAt === 'string'
      ? mapping.addedAt
      : undefined;

  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAMES_BY_ATTENDANCE, STORE_LEGACY_MAPPINGS], 'readwrite');
        const nm = tx.objectStore(STORE_NAMES_BY_ATTENDANCE);
        const lm = tx.objectStore(STORE_LEGACY_MAPPINGS);

        function deleteAttendanceByUuidThen(callback) {
          const ix = nm.index('byUuid');
          const rqScan = ix.openCursor(IDBKeyRange.only(uuid));

          rqScan.onsuccess = (ev) => {
            const c = ev.target.result;
            if (c) {
              c.delete();
              c.continue();
              return;
            }
            callback();
          };
          rqScan.onerror = () => reject(rqScan.error);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);

        deleteAttendanceByUuidThen(() => {
          const lmDel = lm.delete(uuid);
          lmDel.onsuccess = () => {
            const addedAt = preserveAddedAt || new Date().toISOString();

            if (sn !== null && cc) {
              const putNm = nm.put({
                classCode: cc,
                studentNumber: sn,
                uuid,
                realName,
                pinHash,
                addedAt,
              });
              putNm.onerror = () => reject(putNm.error);
              return;
            }

            const putLm = lm.put({
              uuid,
              classCode: cc || normalizeClassCode(mapping.classCode || ''),
              realName,
              studentNumber: mapping.studentNumber ?? null,
              pinHash,
              addedAt,
            });
            putLm.onerror = () => reject(putLm.error);
          };
          lmDel.onerror = () => reject(lmDel.error);
        });
      })
  );
}

/**
 * 특정 학급의 모든 학생 매핑 조회 (대소문자·양끝 공백 무시)
 */
export async function getMappingsByClass(classCode) {
  const want = normalizeClassCode(classCode);
  if (!want) return [];

  const db = await openDB();
  const [byNum, legacyForClass] = await new Promise((resolve, reject) => {
    const outNum = [];
    const outLegacy = [];
    const tx = db.transaction([STORE_NAMES_BY_ATTENDANCE, STORE_LEGACY_MAPPINGS], 'readonly');
    tx.oncomplete = () => resolve([outNum, outLegacy]);
    tx.onerror = () => reject(tx.error);

    const rq = tx.objectStore(STORE_NAMES_BY_ATTENDANCE).index('byClassCode').getAll(want);
    rq.onsuccess = () => {
      (rq.result || []).forEach((r) => outNum.push(r));
    };
    rq.onerror = () => reject(rq.error);

    const crs = tx.objectStore(STORE_LEGACY_MAPPINGS).openCursor();
    crs.onsuccess = (ev) => {
      const c = ev.target.result;
      if (!c) return;
      const row = c.value;
      if (normalizeClassCode(row?.classCode) === want) outLegacy.push(row);
      c.continue();
    };
    crs.onerror = () => reject(crs.error);
  });

  return mergeDedupeMappingsPreferAttendance(byNum, legacyForClass).sort(
    (a, b) => (a.studentNumber || 0) - (b.studentNumber || 0)
  );
}

/**
 * UUID로 학생 매핑 조회 (출석번호 스토어 1순위 → 레거시 2순위)
 */
export function getMappingByUUID(uuid) {
  const id = String(uuid ?? '').trim();
  if (!id) return Promise.resolve(undefined);

  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAMES_BY_ATTENDANCE, STORE_LEGACY_MAPPINGS], 'readonly');
        const nm = tx.objectStore(STORE_NAMES_BY_ATTENDANCE);
        const g1 = nm.index('byUuid').getAll(id);
        let resolved = false;

        g1.onsuccess = () => {
          const hits = g1.result || [];
          hits.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
          if (hits[0]) {
            resolved = true;
            resolve(hits[0]);
            return;
          }
          const g2 = tx.objectStore(STORE_LEGACY_MAPPINGS).get(id);
          g2.onsuccess = () => {
            if (!resolved) resolve(g2.result);
          };
          g2.onerror = () => reject(g2.error);
        };
        g1.onerror = () => reject(g1.error);

        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * UUID 기준 학생 매핑 삭제 (양쪽 스토어)
 */
export function deleteMappingByUUID(uuid) {
  const id = String(uuid ?? '').trim();
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_NAMES_BY_ATTENDANCE, STORE_LEGACY_MAPPINGS], 'readwrite');
        const nm = tx.objectStore(STORE_NAMES_BY_ATTENDANCE);
        const rqDel = nm.index('byUuid').openCursor(IDBKeyRange.only(id));
        rqDel.onsuccess = (ev) => {
          const c = ev.target.result;
          if (c) {
            c.delete();
            c.continue();
            return;
          }
          const delL = tx.objectStore(STORE_LEGACY_MAPPINGS).delete(id);
          delL.onerror = () => reject(delL.error);
        };
        rqDel.onerror = () => reject(rqDel.error);

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

export async function deleteMappingsByClass(classCode) {
  const want = normalizeClassCode(classCode);
  const db = await openDB();

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAMES_BY_ATTENDANCE, STORE_LEGACY_MAPPINGS], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);

    const nm = tx.objectStore(STORE_NAMES_BY_ATTENDANCE);
    const ix = nm.index('byClassCode');
    let c1 = ix.openCursor(IDBKeyRange.only(want));
    c1.onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };

    const lm = tx.objectStore(STORE_LEGACY_MAPPINGS);
    let c2 = lm.openCursor();
    c2.onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (!cursor) return;
      if (normalizeClassCode(cursor.value?.classCode) === want) {
        cursor.delete();
      }
      cursor.continue();
    };
    c1.onerror = () => reject(c1.error);
    c2.onerror = () => reject(c2.error);
  });
}

/**
 * 학생 PIN 업데이트 (양 스토어 모두 처리)
 */
export async function updateMappingPIN(uuid, newPinHash) {
  const existing = await getMappingByUUID(uuid);
  if (!existing) throw new Error('학생 정보를 찾을 수 없습니다.');
  return saveStudentMapping({
    uuid,
    classCode: existing.classCode,
    realName: existing.realName ?? '',
    studentNumber: finitePositiveStudentNumber(existing.studentNumber) ?? existing.studentNumber,
    pinHash: newPinHash,
    addedAt: existing.addedAt,
  });
}

// ─────────────────────────────────────────────
// 학급 정보 CRUD
// ─────────────────────────────────────────────

export function saveClassInfo(classInfo) {
  const normalized = {
    ...classInfo,
    classCode: normalizeClassCode(classInfo.classCode),
    updatedAt: new Date().toISOString(),
  };
  return withStore(STORE_CLASSES, 'readwrite', (store) => store.put(normalized));
}

export function getClassInfo(classCode) {
  return withStore(STORE_CLASSES, 'readonly', (store) =>
    store.get(normalizeClassCode(classCode))
  );
}

export function deleteClassInfo(classCode) {
  return withStore(STORE_CLASSES, 'readwrite', (store) =>
    store.delete(normalizeClassCode(classCode))
  );
}

/**
 * 로컬(교사 기기) IndexedDB 상의 학급코드 이관:
 * - classInfo: old → new
 * - studentMappings: old → new (UUID 기준으로 재저장하여 키/인덱스 일괄 갱신)
 */
export async function migrateLocalClassCode(oldClassCode, newClassCode) {
  const oldCc = normalizeClassCode(oldClassCode);
  const newCc = normalizeClassCode(newClassCode);
  if (!oldCc || !newCc) throw new Error('학급 코드가 올바르지 않습니다.');
  if (oldCc === newCc) return { migratedMappings: 0, migratedClassInfo: false };

  const cls = await getClassInfo(oldCc).catch(() => null);
  if (cls) {
    await saveClassInfo({ ...cls, classCode: newCc });
    await deleteClassInfo(oldCc).catch(() => {});
  }

  const rows = await getAllMappings();
  const targets = (rows || []).filter((m) => normalizeClassCode(m?.classCode) === oldCc);
  for (const m of targets) {
    await saveStudentMapping({
      uuid: m.uuid,
      classCode: newCc,
      realName: m.realName,
      studentNumber: m.studentNumber,
      pinHash: m.pinHash,
      addedAt: m.addedAt,
    });
  }

  return { migratedMappings: targets.length, migratedClassInfo: !!cls };
}

// ─────────────────────────────────────────────
// 전체 내보내기 / 가져오기 (AES-256 암호화 연동)
// ─────────────────────────────────────────────

export async function exportAllData() {
  const db = await openDB();

  const getNamed = () =>
    new Promise((res, rej) => {
      const tx = db.transaction(STORE_NAMES_BY_ATTENDANCE, 'readonly');
      const rq = tx.objectStore(STORE_NAMES_BY_ATTENDANCE).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });

  const getLegacy = () =>
    new Promise((res, rej) => {
      const tx = db.transaction(STORE_LEGACY_MAPPINGS, 'readonly');
      const rq = tx.objectStore(STORE_LEGACY_MAPPINGS).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });

  const getClasses = () =>
    new Promise((res, rej) => {
      const tx = db.transaction(STORE_CLASSES, 'readonly');
      const rq = tx.objectStore(STORE_CLASSES).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });

  const [named, legacyRows, classes] = await Promise.all([
    getNamed(),
    getLegacy(),
    getClasses(),
  ]);

  const studentMappings = mergeDedupeMappingsPreferAttendance(named, legacyRows);

  return {
    exportedAt:  new Date().toISOString(),
    appVersion:  '0503',
    schemaVersion: 2,
    description: '★ 이 파일에는 학생 실명이 포함되어 있습니다. AES-256으로 암호화되어 있습니다.',
    classes,
    studentMappings,
  };
}

/**
 * 복호화 후 복구 — 레코드를 save 경로로 넣어 v2 규칙·마이그레이션 반영
 */
export async function importAllData(data) {
  const rows =
    Array.isArray(data.studentMappings) && data.studentMappings.length
      ? data.studentMappings
      : [];

  if (!rows.length) {
    throw new Error('올바른 백업 파일 형식이 아닙니다.');
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await saveStudentMapping({
      uuid: r.uuid,
      classCode: r.classCode,
      realName: r.realName,
      studentNumber: r.studentNumber,
      pinHash: r.pinHash,
      addedAt: r.addedAt,
    });
  }

  const db = await openDB();

  if (data.classes && Array.isArray(data.classes)) {
    const putAll = (records) =>
      new Promise((res, rej) => {
        const tx = db.transaction(STORE_CLASSES, 'readwrite');
        const store = tx.objectStore(STORE_CLASSES);
        records.forEach((r) => store.put({ ...r, classCode: normalizeClassCode(r.classCode) }));
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    await putAll(data.classes);
  }

  return { imported: rows.length };
}
