/**
 * 채점 결과 휴지통 — classes/{classCode}/trashedExamResults
 * 삭제 후 7일 보관, 이후 영구 삭제 (학생 examResults·오답노트 정리)
 */
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, arrayUnion,
} from 'firebase/firestore';
import { db } from './config';
import { examResultGroupKey, examResultLabel, examResultDocId } from '../utils/examResults';
import { setClassExamResultVisible } from './firestoreOps';

export const EXAM_RESULT_TRASH_RETENTION_DAYS = 7;
const RETENTION_MS = EXAM_RESULT_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function examResultTrashPurgeAfterIso(deletedAtIso) {
  return new Date(Date.parse(deletedAtIso) + RETENTION_MS).toISOString();
}

export function daysUntilExamResultTrashPurge(purgeAfterIso) {
  if (!purgeAfterIso) return 0;
  const ms = Date.parse(purgeAfterIso) - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

async function permanentlyDeleteTrashDoc(classCode, trashId, data) {
  const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
  for (const { studentUuid, entry } of snapshots) {
    if (!studentUuid || !entry) continue;
    const noteId = examResultDocId(entry);
    try {
      await deleteDoc(doc(db, 'students', studentUuid, 'examWrongNotes', noteId));
    } catch {
      /* 오답노트 없을 수 있음 */
    }
  }
  await deleteDoc(doc(db, 'classes', classCode, 'trashedExamResults', trashId));
}

/** 만료된 휴지통 항목 영구 삭제 */
export async function purgeExpiredTrashedExamResults(classCode) {
  if (!classCode) return 0;
  const now = Date.now();
  const snap = await getDocs(collection(db, 'classes', classCode, 'trashedExamResults'));
  const expired = snap.docs.filter((d) => {
    const purgeAfter = d.data().purgeAfter;
    return purgeAfter && Date.parse(purgeAfter) <= now;
  });
  for (const d of expired) {
    await permanentlyDeleteTrashDoc(classCode, d.id, d.data());
  }
  return expired.length;
}

/** 휴지통 목록 (조회 시 만료 항목 자동 정리) */
export async function getTrashedExamResults(classCode) {
  if (!classCode) return [];
  await purgeExpiredTrashedExamResults(classCode);
  const snap = await getDocs(collection(db, 'classes', classCode, 'trashedExamResults'));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
}

/**
 * 채점 결과 그룹을 휴지통으로 이동 (학생 examResults에서 제거 후 스냅샷 보관)
 * @param {string} classCode
 * @param {string} groupKey
 * @param {Array} students getStudentsByClass 결과
 */
export async function trashClassExamResultGroup(classCode, groupKey, students) {
  if (!classCode || !groupKey) throw new Error('학급·시험 키가 필요합니다.');

  const deletedAt = new Date().toISOString();
  const purgeAfter = examResultTrashPurgeAfterIso(deletedAt);
  const snapshots = [];
  let labelEntry = null;

  for (const st of students || []) {
    const uuid = st.uuid || st.id;
    if (!uuid) continue;
    const rows = Array.isArray(st.examResults) ? st.examResults : [];
    const matching = rows.filter((e) => examResultGroupKey(e) === groupKey);
    if (!matching.length) continue;

    for (const entry of matching) {
      snapshots.push({ studentUuid: uuid, entry });
      const curMs = entry?.scoredAt ? Date.parse(entry.scoredAt) : 0;
      const bestMs = labelEntry?.scoredAt ? Date.parse(labelEntry.scoredAt) : 0;
      if (!labelEntry || curMs >= bestMs) labelEntry = entry;
    }

    const next = rows.filter((e) => examResultGroupKey(e) !== groupKey);
    if (next.length !== rows.length) {
      await updateDoc(doc(db, 'students', uuid), { examResults: next });
    }
  }

  if (!snapshots.length) {
    throw new Error('삭제할 채점 결과를 찾지 못했습니다.');
  }

  await setClassExamResultVisible(classCode, groupKey, true);

  const trashRef = doc(collection(db, 'classes', classCode, 'trashedExamResults'));
  await setDoc(trashRef, {
    groupKey,
    deletedAt,
    purgeAfter,
    label: examResultLabel(labelEntry || snapshots[0].entry),
    studentCount: new Set(snapshots.map((s) => s.studentUuid)).size,
    snapshots,
  });

  return trashRef.id;
}

/** 휴지통에서 채점 결과 복구 */
export async function restoreTrashedExamResult(classCode, trashId) {
  if (!classCode || !trashId) throw new Error('복구할 항목이 없습니다.');
  const ref = doc(db, 'classes', classCode, 'trashedExamResults', trashId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('휴지통 항목을 찾을 수 없습니다.');

  const snapshots = Array.isArray(snap.data().snapshots) ? snap.data().snapshots : [];
  for (const { studentUuid, entry } of snapshots) {
    if (!studentUuid || !entry) continue;
    await updateDoc(doc(db, 'students', studentUuid), {
      examResults: arrayUnion(entry),
    });
  }
  await deleteDoc(ref);
}

/** 휴지통에서 즉시 영구 삭제 */
export async function permanentlyDeleteTrashedExamResult(classCode, trashId) {
  if (!classCode || !trashId) throw new Error('삭제할 항목이 없습니다.');
  const ref = doc(db, 'classes', classCode, 'trashedExamResults', trashId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('휴지통 항목을 찾을 수 없습니다.');
  await permanentlyDeleteTrashDoc(classCode, trashId, snap.data());
}
