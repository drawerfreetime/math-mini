/**
 * 오답노트 역량 — examWrongNotes 집계 (Firestore)
 */
import { collection, getDocs } from 'firebase/firestore';
import { db } from './config';
import { computeWrongNoteCompetency } from '../utils/computeWrongNoteCompetency';

/** @param {string} uuid */
export async function getExamWrongNotesForStudent(uuid) {
  if (!uuid) return [];
  const snap = await getDocs(collection(db, 'students', uuid, 'examWrongNotes'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * @param {string} classCode
 * @param {string[]} studentUuids
 */
export async function getClassWrongNoteCompetency(classCode, studentUuids) {
  const rows = await Promise.all(
    (studentUuids || []).map(async (uuid) => {
      const examNotes = await getExamWrongNotesForStudent(uuid);
      const competency = computeWrongNoteCompetency(examNotes);
      return { uuid, classCode, examNotes, competency };
    }),
  );
  return rows;
}
