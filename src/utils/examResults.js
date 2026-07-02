/**
 * 스캔 자동정리 → students.examResults 항목 정리·표시용
 */
import {
  SUBMISSION_STATUS_APPROVED,
  SUBMISSION_STATUS_PENDING_REVIEW,
  SUBMISSION_STATUS_REJECTED,
} from '../constants/aiSubmissionPolicy';

/** Firestore·오답노트 문서 ID용 (슬래시 등 제거) */
export function examResultDocId(entry) {
  const name = String(entry?.examName ?? 'exam').trim() || 'exam';
  const at = String(entry?.scoredAt ?? '').trim() || 'unknown';
  return `${name}__${at}`.replace(/[/\\?%*:|"<>#]/g, '_').slice(0, 120);
}

function formatGradeSemesterUnit(entry) {
  const parts = [];
  if (entry?.grade) {
    const g = String(entry.grade).trim();
    parts.push(g.endsWith('학년') ? g : `${g}학년`);
  }
  if (entry?.semester) {
    const s = String(entry.semester).trim();
    parts.push(s.endsWith('학기') ? s : `${s}학기`);
  }
  if (entry?.unit) {
    const u = String(entry.unit).trim();
    parts.push(u.endsWith('단원') ? u : `${u}단원`);
  }
  return parts;
}

export function examResultLabel(entry) {
  const parts = formatGradeSemesterUnit(entry);
  const meta = parts.length ? parts.join(' ') : '';
  const title = String(entry?.examName ?? '').trim() || '단원평가';
  return meta ? `${meta} · ${title}` : title;
}

export function formatScoredAt(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

/** 학생 목록·교사 숨김 토글에 쓰는 시험(이름·교과) 그룹 키 */
export function examResultGroupKey(entry) {
  return [
    String(entry?.examName ?? '').trim(),
    String(entry?.grade ?? '').trim(),
    String(entry?.semester ?? '').trim(),
    String(entry?.unit ?? '').trim(),
  ].join('|');
}

/** 교사가 숨긴 채점 결과는 학생 화면에서 제외 (기본: 모두 표시) */
export function filterVisibleExamResults(examResults, hiddenKeys) {
  const latest = pickLatestExamResults(examResults);
  const hidden = Array.isArray(hiddenKeys) ? hiddenKeys : [];
  if (!hidden.length) return latest;
  const set = new Set(hidden);
  return latest.filter((e) => !set.has(examResultGroupKey(e)));
}

function examResultProblemTotal(entry) {
  const fromField = entry?.totalCount;
  if (Number.isFinite(fromField) && fromField > 0) return fromField;
  const fromRows = Array.isArray(entry?.results) ? entry.results.length : 0;
  return fromRows > 0 ? fromRows : 0;
}

function examResultCorrectCount(entry) {
  const fromField = entry?.totalCorrect;
  if (Number.isFinite(fromField) && fromField >= 0) return fromField;
  if (!Array.isArray(entry?.results)) return 0;
  return entry.results.filter((r) => r?.correct === true).length;
}

/** 학급 집계: 학생별 최신 채점을 모아 반 평균·최저·최고 AI 맞은 문항 수 */
export function summarizeClassExamResultEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const totals = entries.map(examResultProblemTotal);
  const corrects = entries.map(examResultCorrectCount);
  const n = entries.length;
  const totalProblems = totals.reduce((a, b) => a + b, 0) / n;
  const roundedTotal = Math.round(totalProblems) || totals[0] || 0;
  const avgCorrect = corrects.reduce((a, b) => a + b, 0) / n;
  let latestScoredAt = '';
  let latestMs = 0;
  for (const e of entries) {
    const ms = e?.scoredAt ? Date.parse(e.scoredAt) : 0;
    if (ms >= latestMs) {
      latestMs = ms;
      latestScoredAt = e.scoredAt;
    }
  }
  return {
    studentCount: n,
    avgCorrect,
    totalProblems: roundedTotal,
    minCorrect: Math.min(...corrects),
    maxCorrect: Math.max(...corrects),
    latestScoredAt,
  };
}

/** 학급 전체 학생 문서에서 교사 미리보기용 채점 결과 그룹 집계 */
export function aggregateClassExamResultGroups(students, hiddenKeys = []) {
  if (!Array.isArray(students) || !students.length) return [];
  const hidden = new Set(Array.isArray(hiddenKeys) ? hiddenKeys : []);
  const byKey = new Map();

  for (const st of students) {
    const latest = pickLatestExamResults(st.examResults || []);
    for (const entry of latest) {
      const key = examResultGroupKey(entry);
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          entries: [],
          studentUuids: new Set(),
        };
        byKey.set(key, row);
      }
      row.studentUuids.add(st.uuid || st.id);
      row.entries.push(entry);
    }
  }

  return [...byKey.values()]
    .map((row) => {
      const stats = summarizeClassExamResultEntries(row.entries);
      const labelEntry = row.entries.reduce((best, e) => {
        const ms = e?.scoredAt ? Date.parse(e.scoredAt) : 0;
        const bestMs = best?.scoredAt ? Date.parse(best.scoredAt) : 0;
        return ms >= bestMs ? e : best;
      }, row.entries[0]);
      return {
        key: row.key,
        entry: labelEntry,
        stats,
        studentCount: row.studentUuids.size,
        visible: !hidden.has(row.key),
      };
    })
    .sort(
      (a, b) => (
        Date.parse(b.stats?.latestScoredAt || b.entry?.scoredAt || 0)
        - Date.parse(a.stats?.latestScoredAt || a.entry?.scoredAt || 0)
      ),
    );
}

/** 동일 시험(이름·교과)은 scoredAt 최신 1건만 */
export function pickLatestExamResults(examResults) {
  if (!Array.isArray(examResults) || !examResults.length) return [];
  const byKey = new Map();
  for (const entry of examResults) {
    const key = examResultGroupKey(entry);
    const prev = byKey.get(key);
    const prevAt = prev?.scoredAt ? Date.parse(prev.scoredAt) : 0;
    const curAt = entry?.scoredAt ? Date.parse(entry.scoredAt) : 0;
    if (!prev || curAt >= prevAt) byKey.set(key, entry);
  }
  return [...byKey.values()].sort(
    (a, b) => (Date.parse(b.scoredAt || 0) - Date.parse(a.scoredAt || 0)),
  );
}

export function sortedResultRows(entry) {
  const rows = Array.isArray(entry?.results) ? [...entry.results] : [];
  return rows.sort(
    (a, b) => (Number(a?.problemNumber) || 0) - (Number(b?.problemNumber) || 0),
  );
}

/** 학생이 저장한 문항별 맞음 여부 (examWrongNotes.studentProblemCorrect) */
export function parseStudentProblemCorrect(noteDoc) {
  const raw = noteDoc?.studentProblemCorrect;
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  Object.entries(raw).forEach(([k, v]) => {
    const n = parseInt(String(k), 10);
    if (Number.isFinite(n) && n > 0) out[n] = !!v;
  });
  return Object.keys(out).length ? out : null;
}

/**
 * AI results + (있으면) 학생 확인 맵 → 문항별 effective correct
 */
export function getEffectiveResultRows(entry, studentCorrectMap = null) {
  const rows = sortedResultRows(entry);
  if (!studentCorrectMap) {
    return rows.map((r) => ({
      problemNumber: Number(r.problemNumber),
      correct: !!r.correct,
      source: 'ai',
    }));
  }
  return rows.map((r) => {
    const n = Number(r.problemNumber);
    const hasStudent = Object.prototype.hasOwnProperty.call(studentCorrectMap, n);
    const correct = hasStudent ? !!studentCorrectMap[n] : !!r.correct;
    return {
      problemNumber: n,
      correct,
      source: hasStudent ? 'student' : 'ai',
    };
  });
}

export function countCorrectFromRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  const correct = list.filter((r) => r?.correct === true).length;
  return { correct, total };
}

export function getWrongProblemNumbers(entry, studentCorrectMap = null) {
  return getEffectiveResultRows(entry, studentCorrectMap)
    .filter((r) => r.correct === false)
    .map((r) => r.problemNumber)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

export function isPerfectExamResult(entry, studentCorrectMap = null) {
  const { correct, total } = countCorrectFromRows(getEffectiveResultRows(entry, studentCorrectMap));
  if (total > 0 && correct === total) return true;
  return false;
}

/** 교사가 입력한 시험 점수 (예: 85). 없으면 null */
export function parseManualScore(entry) {
  const v = entry?.manualScore;
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function parseMaxScore(entry, fallback = 100) {
  const v = entry?.maxScore;
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** 단원평가 등 문항 수 10·20·25일 때 화면 표기를 100점 만점으로 */
const HUNDRED_POINT_EXAM_TOTALS = new Set([10, 20, 25]);

export function isHundredPointExamTotal(total) {
  const n = Number(total);
  return Number.isFinite(n) && HUNDRED_POINT_EXAM_TOTALS.has(n);
}

export function correctCountToHundredPoints(correct, total) {
  const t = Number(total);
  const c = Number(correct);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(c)) return null;
  return Math.round((c / t) * 100);
}

/** AI 맞은 수·점수 표기 (예: 19/20 → 95/100점) */
export function formatAiScoreDisplay(correct, total) {
  if (isHundredPointExamTotal(total)) {
    const pts = correctCountToHundredPoints(correct, total);
    if (pts !== null) return `${pts}/100점`;
  }
  return `${correct}/${total}`;
}

/** AI 메타 문구 (예: AI 19/20 맞음 → AI 95/100점) */
export function formatAiScoreMeta(correct, total) {
  return `AI ${formatAiScoreDetail(correct, total)}`;
}

/** AI 채점 설명용 (예: 19/20 맞음 → 95/100점) */
export function formatAiScoreDetail(correct, total) {
  if (isHundredPointExamTotal(total)) return formatAiScoreDisplay(correct, total);
  return `${correct}/${total} 맞음`;
}

export function formatManualScoreLine(entry) {
  const score = parseManualScore(entry);
  if (score === null) return '';
  const max = parseMaxScore(entry);
  return `${score}/${max}점`;
}

/** examWrongNotes 서브컬렉션에서 채점 결과에 맞는 오답노트 문서 찾기 */
export function findExamWrongNoteForResult(examWrongNotes, entry) {
  const rows = Array.isArray(examWrongNotes) ? examWrongNotes : [];
  const byId = rows.find((n) => n.id === examResultDocId(entry));
  if (byId) return byId;

  const examName = String(entry?.examName ?? '').trim();
  const grade = String(entry?.grade ?? '').trim();
  const semester = String(entry?.semester ?? '').trim();
  const unit = String(entry?.unit ?? '').trim();
  if (!examName) return null;

  const matched = rows.filter((r) => {
    if (String(r?.examName ?? '').trim() !== examName) return false;
    if (grade && String(r?.grade ?? '').trim() !== grade) return false;
    if (semester && String(r?.semester ?? '').trim() !== semester) return false;
    if (unit && String(r?.unit ?? '').trim() !== unit) return false;
    return true;
  });
  if (!matched.length) return null;

  matched.sort((a, b) => {
    const ua = Date.parse(a?.updatedAt || a?.studentReviewedAt || a?.scoredAt || 0) || 0;
    const ub = Date.parse(b?.updatedAt || b?.studentReviewedAt || b?.scoredAt || 0) || 0;
    return ub - ua;
  });
  return matched[0];
}

function getWrongNoteItemStatus(detail) {
  if (!detail || typeof detail !== 'object') return 'empty';
  if (detail.teacherStatus === SUBMISSION_STATUS_REJECTED) return 'rejected';
  if (detail.teacherStatus === SUBMISSION_STATUS_PENDING_REVIEW) return 'pending';
  if (detail.teacherStatus === SUBMISSION_STATUS_APPROVED) return 'approved';
  if (detail.aiReview && !detail.aiReview.approved) return 'ai-fail';
  if (detail.submittedAt) return 'submitted';
  const hasContent = [detail.reason, detail.prevention, detail.solution, detail.answer].some(
    (v) => String(v ?? '').trim(),
  );
  return hasContent ? 'draft' : 'empty';
}

/**
 * 홈 화면 오답노트 카드 강조(빨간색) 여부
 * — 틀린 문항이 있는데 미제출·반려·AI 재작성 필요 시 true
 */
export function studentNeedsWrongNoteAction(visibleExamResults, examWrongNotes) {
  if (!Array.isArray(visibleExamResults) || !visibleExamResults.length) return false;

  for (const entry of visibleExamResults) {
    const note = findExamWrongNoteForResult(examWrongNotes, entry);
    const studentMap = parseStudentProblemCorrect(note);
    const wrongNums = getWrongProblemNumbers(entry, studentMap);
    if (!wrongNums.length) continue;

    const details = note?.noteDetails || {};
    for (const num of wrongNums) {
      const status = getWrongNoteItemStatus(details[String(num)]);
      if (status === 'empty' || status === 'draft' || status === 'rejected' || status === 'ai-fail') {
        return true;
      }
    }
  }
  return false;
}
