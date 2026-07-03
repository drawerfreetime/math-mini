/**
 * 풀이 과정 칸 — 문제 지문과 분리해 저장·편집
 */
import { isExamLongBlankBracket, normalizeExamQuestionText } from './examBlankBrackets';
import { inferRequiresSolution } from './problemMeta';

const SOLUTION_LINE_RE = /<\s*풀이\s*과정\s*>|풀이\s*과정\s*>/i;
const ANSWER_TAG_LINE_RE = /<\s*답\s*>/i;
const BLANK_ONLY_LINE_RE = /^\s*(\[[\s]*\]|□+)\s*$/;

function isBlankOnlySolutionLine(line) {
  const t = String(line ?? '').trim();
  if (!t) return true;
  return BLANK_ONLY_LINE_RE.test(t) || isExamLongBlankBracket(t);
}

/** 빈칸 괄호만 있으면 비움 — 풀이과정 칸은 기본 빈 상태 */
export function normalizeSolutionAreaForEdit(text) {
  const kept = String(text ?? '')
    .split('\n')
    .filter((ln) => !isBlankOnlySolutionLine(ln));
  return kept.join('\n').trim();
}

/**
 * 지문 끝에 붙은 `<풀이 과정>`·`<답>` 블록을 stem / solutionArea / answerTail 로 분리.
 */
export function splitExamQuestionSolutionBlock(question, solutionArea = '') {
  const q = String(question ?? '');
  const existing = String(solutionArea ?? '').trim();
  if (existing) {
    return {
      question: stripTrailingSolutionBlock(q).question,
      solutionArea: normalizeSolutionAreaForEdit(existing),
      answerTail: null,
    };
  }

  const lines = q.split('\n');
  let solStart = -1;
  let ansStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (solStart < 0 && SOLUTION_LINE_RE.test(line)) solStart = i;
    if (ansStart < 0 && ANSWER_TAG_LINE_RE.test(line)) ansStart = i;
  }

  if (solStart < 0) {
    const trailing = findTrailingBlankRun(lines);
    if (trailing && trailing.count >= 2) {
      solStart = trailing.start;
      ansStart = trailing.answerLine >= 0 ? trailing.answerLine : -1;
    } else {
      return { question: q, solutionArea: '', answerTail: null };
    }
  }

  const stem = lines.slice(0, solStart).join('\n').trimEnd();
  const solEnd = ansStart >= 0 ? ansStart : lines.length;
  let solutionLines = lines.slice(solStart, solEnd);
  solutionLines = solutionLines.map((ln) =>
    ln.replace(/^<\s*풀이\s*과정\s*>\s*/i, '').trimEnd(),
  );
  const solutionBlock = solutionLines.join('\n').trim();

  let answerTail = null;
  if (ansStart >= 0) {
    const ansLine = lines[ansStart].replace(/^<\s*답\s*>\s*/i, '').trim();
    answerTail = ansLine;
  }

  return {
    question: stem,
    solutionArea: normalizeSolutionAreaForEdit(solutionBlock),
    answerTail,
  };
}

function findTrailingBlankRun(lines) {
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i -= 1;
  if (i < 0) return null;

  let answerLine = -1;
  if (ANSWER_TAG_LINE_RE.test(lines[i]) || /^\s*<\s*답/.test(lines[i])) {
    answerLine = i;
    i -= 1;
    while (i >= 0 && !lines[i].trim()) i -= 1;
  }

  let blankCount = 0;
  while (i >= 0 && (BLANK_ONLY_LINE_RE.test(lines[i]) || SOLUTION_LINE_RE.test(lines[i]))) {
    if (BLANK_ONLY_LINE_RE.test(lines[i]) || SOLUTION_LINE_RE.test(lines[i])) blankCount += 1;
    i -= 1;
  }
  if (blankCount < 2) return null;
  return { start: i + 1, count: blankCount, answerLine };
}

function stripTrailingSolutionBlock(question) {
  const lines = String(question ?? '').split('\n');
  let solStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SOLUTION_LINE_RE.test(lines[i])) {
      solStart = i;
      break;
    }
  }
  if (solStart < 0) return { question: String(question ?? '') };
  return { question: lines.slice(0, solStart).join('\n').trimEnd() };
}

/** 학생·인쇄용 — stem + 풀이 칸 */
export function composeExamQuestionWithSolutionArea(question, solutionArea) {
  const stem = String(question ?? '').trimEnd();
  const sol = String(solutionArea ?? '').trim();
  if (!sol) return normalizeExamQuestionText(stem);
  const body = normalizeSolutionAreaForEdit(sol);
  if (!body) return normalizeExamQuestionText(stem);
  return normalizeExamQuestionText(stem ? `${stem}\n\n${body}` : body);
}

export function prepareProblemForSolutionEdit(problem) {
  const requires =
    problem.requiresSolution !== undefined && problem.requiresSolution !== null
      ? !!problem.requiresSolution
      : inferRequiresSolution(problem.question || '');

  let question = normalizeExamQuestionText(problem.question || '');
  let solutionArea = problem.solutionArea ?? '';
  let answer = problem.answer ?? null;

  if (requires) {
    const split = splitExamQuestionSolutionBlock(question, solutionArea);
    question = split.question;
    solutionArea = normalizeSolutionAreaForEdit(split.solutionArea);
    if (!answer && split.answerTail) {
      const m = split.answerTail.match(/^\s*(\[[\s]*\]|□+)\s*(.*)$/);
      answer = m ? (m[2] || '').trim() || null : split.answerTail;
    }
  }

  return {
    ...problem,
    question,
    solutionArea: requires ? solutionArea : (solutionArea || null),
    answer,
    requiresSolution: requires,
  };
}

export function mergeSolutionAreaIntoQuestion(question, solutionArea) {
  const stem = String(question ?? '').trimEnd();
  const sol = String(solutionArea ?? '').trim();
  if (!sol) return stem;
  return composeExamQuestionWithSolutionArea(stem, sol);
}

const SOLUTION_OR_ANSWER_MARKER_RE = /<\s*풀이\s*과정\s*>|<\s*답\s*>|풀이\s*과정\s*>/i;

/** 학생 풀이·목록 — 지문만 (풀이 칸·답 칸 템플릿 제거) */
export function getExamQuestionStemForStudent(question) {
  const full = String(question ?? '').trim();
  if (!full) return '';
  const split = splitExamQuestionSolutionBlock(full);
  let stem = String(split.question ?? '').trim();
  if (!stem) {
    const cutIdx = full.search(SOLUTION_OR_ANSWER_MARKER_RE);
    stem = cutIdx >= 0 ? full.slice(0, cutIdx).trim() : full;
  }
  return stem;
}

/** 학생·시험 보기 — Firestore stem + solutionArea → 통합 지문 */
export function expandExamQuestionDoc(row) {
  if (!row || !row.requiresSolution) return row;
  const sol = String(row.solutionArea ?? '').trim();
  if (!sol) return row;
  if (SOLUTION_LINE_RE.test(row.question || '')) return row;
  return {
    ...row,
    question: composeExamQuestionWithSolutionArea(row.question, sol),
  };
}
