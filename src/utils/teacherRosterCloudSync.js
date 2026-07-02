/**
 * 교사 실명 명단 — 로컬 IndexedDB ↔ Firestore 암호화 동기화
 *
 * localhost와 vercel.app은 브라우저 저장소(IndexedDB)가 분리됩니다.
 * 배포 자체가 아니라 주소가 바뀌면 로컬 명단이 비어 보이므로,
 * 교사 로그인 계정에 묶인 암호화 백업을 자동으로 맞춥니다.
 */
import { aesDecrypt, aesEncrypt, teacherRosterSyncPassphrase } from './crypto';
import { normalizeClassCode } from './classCode';
import { mappingDisplayNameRaw } from './mergeTeacherStudents';
import { getAllMappings, saveStudentMapping } from './teacherDB';
import {
  fetchClassRosterCloud,
  uploadClassRosterCloud,
} from '../firebase/teacherRosterCloudOps';

const pushTimers = new Map();

function pickNewerMapping(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = String(a.addedAt || '');
  const tb = String(b.addedAt || '');
  if (ta && tb && ta !== tb) return ta >= tb ? a : b;
  const an = mappingDisplayNameRaw(a);
  const bn = mappingDisplayNameRaw(b);
  if (an && !bn) return a;
  if (!an && bn) return b;
  return a;
}

/** @param {string} classCode */
export async function getMappingsForClass(classCode) {
  const want = normalizeClassCode(classCode);
  if (!want) return [];
  const all = await getAllMappings().catch(() => []);
  return (all || []).filter((m) => normalizeClassCode(m?.classCode) === want);
}

/**
 * @param {Array} remoteRows
 * @param {string} classCode
 */
export async function mergeRemoteMappingsIntoLocal(remoteRows, classCode) {
  const want = normalizeClassCode(classCode);
  if (!want || !Array.isArray(remoteRows) || !remoteRows.length) return 0;

  const localRows = await getMappingsForClass(want);
  const byUuid = new Map();
  localRows.forEach((r) => {
    const id = String(r?.uuid || '').trim();
    if (id) byUuid.set(id, r);
  });

  let changed = 0;
  for (const remote of remoteRows) {
    const id = String(remote?.uuid || '').trim();
    if (!id) continue;
    const merged = pickNewerMapping(byUuid.get(id), {
      ...remote,
      classCode: want,
    });
    const prev = byUuid.get(id);
    const prevName = mappingDisplayNameRaw(prev);
    const nextName = mappingDisplayNameRaw(merged);
    if (!prev || prevName !== nextName || prev.studentNumber !== merged.studentNumber) {
      // eslint-disable-next-line no-await-in-loop
      await saveStudentMapping(merged);
      changed += 1;
    }
    byUuid.set(id, merged);
  }
  return changed;
}

/** @returns {Promise<{ pulled: boolean, merged: number }>} */
export async function pullClassRosterFromCloud(teacherUid, classCode) {
  const uid = String(teacherUid || '').trim();
  const cc = normalizeClassCode(classCode);
  if (!uid || !cc) return { pulled: false, merged: 0 };

  const cloud = await fetchClassRosterCloud(uid, cc);
  if (!cloud?.encryptedPayload) return { pulled: false, merged: 0 };

  try {
    const plain = await aesDecrypt(
      cloud.encryptedPayload,
      teacherRosterSyncPassphrase(uid, cc),
    );
    const data = JSON.parse(plain);
    const rows = Array.isArray(data?.studentMappings) ? data.studentMappings : [];
    const merged = await mergeRemoteMappingsIntoLocal(rows, cc);
    return { pulled: true, merged };
  } catch (e) {
    console.warn('[roster cloud pull]', e);
    return { pulled: false, merged: 0 };
  }
}

export async function pushClassRosterToCloud(teacherUid, classCode) {
  const uid = String(teacherUid || '').trim();
  const cc = normalizeClassCode(classCode);
  if (!uid || !cc) return;

  const rows = await getMappingsForClass(cc);
  if (!rows.length) return;

  const payload = JSON.stringify({
    v: 1,
    classCode: cc,
    studentMappings: rows,
  });
  const encryptedPayload = await aesEncrypt(
    payload,
    teacherRosterSyncPassphrase(uid, cc),
  );
  await uploadClassRosterCloud(uid, cc, {
    encryptedPayload,
    mappingCount: rows.length,
  });
}

/** 클라우드에서 받아온 뒤 로컬이 더 많으면 다시 올림 */
export async function syncClassRosterWithCloud(teacherUid, classCode) {
  const pull = await pullClassRosterFromCloud(teacherUid, classCode);
  const localRows = await getMappingsForClass(classCode);
  if (localRows.length > 0) {
    await pushClassRosterToCloud(teacherUid, classCode);
  }
  return { ...pull, localCount: localRows.length };
}

export function scheduleClassRosterCloudPush(teacherUid, classCode, delayMs = 1500) {
  const uid = String(teacherUid || '').trim();
  const cc = normalizeClassCode(classCode);
  if (!uid || !cc) return;

  const key = `${uid}:${cc}`;
  const prev = pushTimers.get(key);
  if (prev) clearTimeout(prev);

  pushTimers.set(key, setTimeout(() => {
    pushTimers.delete(key);
    pushClassRosterToCloud(uid, cc).catch((e) => {
      console.warn('[roster cloud push]', e);
    });
  }, delayMs));
}

export async function saveStudentMappingWithCloud(teacherUid, mapping) {
  await saveStudentMapping(mapping);
  scheduleClassRosterCloudPush(teacherUid, mapping?.classCode);
}
