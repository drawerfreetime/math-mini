/**
 * 시험지 업로드(IndexedDB 라이브러리) 표시 이름 ↔ Firestore exams.title 동기화
 */
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import { getExamsCreatedByTeacher, getStudentsByClass } from '../firebase/firestoreOps';

function normalizeKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()（）[\]{}._·]/g, '');
}

function firstDigit(value) {
  const m = String(value ?? '').match(/\d+/);
  return m ? m[0] : '';
}

function gradeDigits(value) {
  return firstDigit(value);
}

function semesterDigit(value) {
  return firstDigit(value);
}

function unitDigit(value) {
  return firstDigit(value);
}

function titleMatchesPrevious(ex, prevNorm) {
  if (!prevNorm) return false;
  const exNorm = normalizeKey(ex.title);
  if (!exNorm) return false;
  if (exNorm === prevNorm) return true;
  return exNorm.includes(prevNorm) || prevNorm.includes(exNorm);
}

function titleMatchesExamName(resultEntry, prevNorm) {
  if (!prevNorm) return false;
  const exNorm = normalizeKey(resultEntry?.examName);
  if (!exNorm) return false;
  if (exNorm === prevNorm) return true;
  return exNorm.includes(prevNorm) || prevNorm.includes(exNorm);
}

function examResultMatchesLibraryEntry(resultEntry, libraryEntry, previousLabel) {
  const prevNorm = normalizeKey(previousLabel);
  if (!prevNorm) return false;
  const pseudoExam = {
    grade: resultEntry?.grade,
    semester: resultEntry?.semester,
    unit: resultEntry?.unit,
    examGrade: resultEntry?.grade,
  };
  if (!curriculumMatches(libraryEntry, pseudoExam)) return false;
  return titleMatchesExamName(resultEntry, prevNorm);
}

function curriculumMatches(entry, ex) {
  const wantGrade = gradeDigits(entry.grade);
  const exGrade = gradeDigits(ex.grade ?? ex.examGrade);
  const gradeOk = !wantGrade || !exGrade || exGrade === wantGrade;

  const wantSem = semesterDigit(entry.semester);
  const exSem = semesterDigit(ex.semester);
  const semOk = !wantSem || !exSem || exSem === wantSem;

  const wantUnit = unitDigit(entry.unit);
  const exUnit = unitDigit(ex.unit);
  const unitOk = !wantUnit || !exUnit || exUnit === wantUnit;

  return gradeOk && semOk && unitOk;
}

function pickSyncTargets(exams, entry, previousLabel) {
  const prevNorm = normalizeKey(previousLabel);
  const byId = new Map();

  const link = (ex) => {
    if (ex?.id) byId.set(ex.id, ex);
  };

  for (const ex of exams) {
    if (entry.id && ex.examPaperLibraryId === entry.id) link(ex);
    if (entry.sha256 && ex.examPaperSha256 === entry.sha256) link(ex);
  }

  if (prevNorm) {
    for (const ex of exams) {
      if (titleMatchesPrevious(ex, prevNorm)) link(ex);
    }
  }

  const curriculumHits = exams.filter((ex) => curriculumMatches(entry, ex));
  if (prevNorm) {
    for (const ex of curriculumHits) {
      if (titleMatchesPrevious(ex, prevNorm)) link(ex);
    }
  }

  if (byId.size === 0 && curriculumHits.length === 1) {
    link(curriculumHits[0]);
  }

  return [...byId.values()];
}

/**
 * @param {string} teacherUid
 * @param {{ id?: string, label: string, grade?: string, semester?: string, unit?: string, sha256?: string }} entry
 * @param {string} [previousLabel] 이름 변경 전 표시 이름
 * @returns {Promise<{ updated: number }>}
 */
export async function syncExamPaperLabelToExams(teacherUid, entry, previousLabel) {
  if (!teacherUid || !entry?.label) return { updated: 0 };

  const label = String(entry.label).trim();
  if (!label) return { updated: 0 };

  const exams = await getExamsCreatedByTeacher(teacherUid);
  const targets = pickSyncTargets(exams, entry, previousLabel);

  const patchBase = {
    title: label,
    updatedAt: new Date().toISOString(),
  };

  await Promise.all(
    targets.map((ex) =>
      updateDoc(doc(db, 'exams', ex.id), {
        ...patchBase,
        ...(entry.id ? { examPaperLibraryId: entry.id } : {}),
        ...(entry.sha256 ? { examPaperSha256: entry.sha256 } : {}),
      }),
    ),
  );

  return { updated: targets.length };
}

/**
 * 우리 반 학생 examResults[].examName — 시험지 업로드 표시 이름과 통일
 * @param {string} classCode
 * @param {{ label: string, grade?: string, semester?: string, unit?: string }} entry
 * @param {string} [previousLabel]
 * @returns {Promise<{ students: number, entries: number }>}
 */
export async function syncExamPaperLabelToClassExamResults(classCode, entry, previousLabel) {
  if (!classCode || !entry?.label) return { students: 0, entries: 0 };

  const label = String(entry.label).trim();
  if (!label) return { students: 0, entries: 0 };

  const students = await getStudentsByClass(classCode);
  let studentsUpdated = 0;
  let entriesUpdated = 0;

  for (const st of students) {
    const uuid = String(st.uuid ?? st.id ?? '').trim();
    if (!uuid) continue;
    const rows = Array.isArray(st.examResults) ? st.examResults : [];
    if (!rows.length) continue;

    let entryCount = 0;
    const next = rows.map((row) => {
      if (!examResultMatchesLibraryEntry(row, entry, previousLabel)) return row;
      entryCount += 1;
      return { ...row, examName: label };
    });

    if (entryCount > 0) {
      entriesUpdated += entryCount;
      await updateDoc(doc(db, 'students', uuid), { examResults: next });
      studentsUpdated += 1;
    }
  }

  return { students: studentsUpdated, entries: entriesUpdated };
}
