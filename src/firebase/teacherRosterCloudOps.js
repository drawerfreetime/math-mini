/**
 * 교사 실명 명단 — Firestore 암호화 백업 (교사 계정 전용)
 *
 * 평문 실명은 저장하지 않습니다. AES-256-GCM 암호문만 보관합니다.
 * 경로: teacherRosters/{teacherUid}/classes/{classCode}
 */
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './config';
import { normalizeClassCode } from '../utils/classCode';

function rosterDocRef(teacherUid, classCode) {
  const uid = String(teacherUid || '').trim();
  const cc = normalizeClassCode(classCode);
  if (!uid || !cc) return null;
  return doc(db, 'teacherRosters', uid, 'classes', cc);
}

/** @returns {Promise<object|null>} */
export async function fetchClassRosterCloud(teacherUid, classCode) {
  const ref = rosterDocRef(teacherUid, classCode);
  if (!ref) return null;
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

/**
 * @param {string} teacherUid
 * @param {string} classCode
 * @param {{ encryptedPayload: string, mappingCount: number }} payload
 */
export async function uploadClassRosterCloud(teacherUid, classCode, payload) {
  const ref = rosterDocRef(teacherUid, classCode);
  if (!ref) throw new Error('교사·학급 정보가 없습니다.');
  await setDoc(ref, {
    encryptedPayload: payload.encryptedPayload,
    mappingCount: payload.mappingCount,
    classCode: normalizeClassCode(classCode),
    updatedAt: serverTimestamp(),
  }, { merge: true });
}
