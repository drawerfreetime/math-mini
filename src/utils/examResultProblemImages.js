/**
 * 채점 결과(examResults) ↔ 문제 보관함(Firestore exams) 문항 크롭 이미지 연결
 */

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
  const d = firstDigit(value);
  return d || '';
}

function semesterDigit(value) {
  return firstDigit(value);
}

function unitDigit(value) {
  return firstDigit(value);
}

/** data URL 또는 raw base64 → img src */
export function questionImageSrc(question) {
  const raw = question?.image_b64 || question?._cropDataUrl;
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('data:')) return t;
  return `data:image/png;base64,${t}`;
}

/**
 * exams 목록에서 채점 결과와 같은 시험(제목·교과) 찾기
 * @param {object} entry examResults 항목
 * @param {Array<object>} exams getExamList() 결과
 */
export function findExamForResult(entry, exams) {
  if (!entry || !Array.isArray(exams) || !exams.length) return null;

  const wantName = normalizeKey(entry.examName);
  const wantGrade = gradeDigits(entry.grade);
  const wantSem = semesterDigit(entry.semester);
  const wantUnit = unitDigit(entry.unit);

  const scored = (exams || [])
    .map((ex) => {
      const titleKey = normalizeKey(ex.title);
      let titleScore = 0;
      if (wantName && titleKey) {
        if (titleKey === wantName) titleScore = 100;
        else if (titleKey.includes(wantName) || wantName.includes(titleKey)) titleScore = 60;
      } else if (!wantName) {
        titleScore = 10;
      }

      const exGrade = gradeDigits(ex.grade ?? ex.examGrade);
      const gradeOk = !wantGrade || !exGrade || exGrade === wantGrade;

      const exSem = semesterDigit(ex.semester);
      const semOk = !wantSem || !exSem || exSem === wantSem;

      const exUnit = unitDigit(ex.unit);
      const unitOk = !wantUnit || !exUnit || exUnit === wantUnit;

      const curriculumScore =
        (gradeOk ? 15 : 0) + (semOk ? 10 : 0) + (unitOk ? 10 : 0);

      return {
        ex,
        score: titleScore + curriculumScore,
        at: Date.parse(ex.updatedAt || ex.createdAt || 0) || 0,
      };
    })
    .filter((row) => row.score >= 50)
    .sort((a, b) => b.score - a.score || b.at - a.at);

  return scored[0]?.ex ?? null;
}

/**
 * @param {Array<object>} questions getExamQuestions() 결과
 * @returns {Record<string, string>} 문항 번호 → img src
 */
export function buildProblemImageMap(questions) {
  const map = {};
  if (!Array.isArray(questions)) return map;
  for (const q of questions) {
    const num = Number(q?.number);
    if (!Number.isFinite(num) || num < 1) continue;
    const src = questionImageSrc(q);
    if (src) map[String(num)] = src;
  }
  return map;
}
