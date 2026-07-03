import { aggregateProblemEvaluationRows } from '../firebase/classProblemBankOps';
import { COMPLETION_LEVELS, getStrategyEvalOption } from '../constants/variantEvaluation';
import { getExamQuestionStemForStudent } from './examSolutionArea';
import { resolveVariantStrategyLabel } from './teacherDashboardUtils';
import { sortRowsByStudentAttendance, studentFirestoreId } from './mergeTeacherStudents';
import { formatAiFeedbackForReport, mergeProblemWithVariantReviewAi } from './teacherAiFeedback';

function pct(n, d) {
  if (!d) return '—';
  return `${Math.round((n / d) * 100)}%`;
}

function completionLabel(levelId) {
  return COMPLETION_LEVELS[levelId]?.label || levelId || '—';
}

function strategyLabel(strategyId) {
  return getStrategyEvalOption(strategyId)?.title || strategyId || '—';
}

/** Cursor 전송용 — 실명 대신 번호·짧은 uuid만 사용 */
export function anonymizedStudentLabel(mergedStudents, uuid) {
  const sid = String(uuid || '').trim();
  if (!sid) return '미확인';
  const st = (mergedStudents || []).find((s) => studentFirestoreId(s) === sid);
  if (st?.studentNumber != null) return `${st.studentNumber}번`;
  return `uuid:${sid.slice(0, 8)}`;
}

function groupEvaluationsByProblem(evaluations) {
  const map = new Map();
  for (const row of evaluations || []) {
    const pid = row.problemId;
    if (!pid) continue;
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push(row);
  }
  return map;
}

function detectAnomalies(problem, aggregate, mergedStudents) {
  const items = [];
  const { stats, studentRows } = aggregate;

  if (stats.solveCount >= 3 && stats.evalCount === 0) {
    items.push('풀이는 있는데 동료 평가가 0건입니다.');
  }
  if (stats.unsolvableCount > 0) {
    items.push(`「잘못 만든 문제」평가 ${stats.unsolvableCount}건`);
  }
  if (stats.solveCount > 0 && stats.correctCount / stats.solveCount < 0.3) {
    items.push(`정답률이 낮습니다 (${pct(stats.correctCount, stats.solveCount)}).`);
  }

  for (const row of studentRows) {
    const solve = row.solve;
    const peer = row.peer;
    if (solve && typeof solve.aiGradedCorrect === 'boolean' && solve.aiGradedCorrect !== solve.solvedCorrect) {
      items.push(
        `${anonymizedStudentLabel(mergedStudents, row.uuid)}: 자동 채점 ${solve.aiGradedCorrect ? '정답' : '오답'} → 학생이 ${solve.solvedCorrect ? '정답' : '오답'}으로 변경`,
      );
    }
    if (solve && !solve.solvedCorrect && peer?.guessedCompletionLevel === 'creative') {
      items.push(
        `${anonymizedStudentLabel(mergedStudents, row.uuid)}: 오답인데 완성도「창의적」평가`,
      );
    }
    if (solve?.solvedCorrect && peer?.guessedCompletionLevel === 'unsolvable') {
      items.push(
        `${anonymizedStudentLabel(mergedStudents, row.uuid)}: 정답인데「잘못 만든 문제」평가`,
      );
    }
  }

  if (problem.aiReviewStatus && problem.aiReviewStatus !== 'approved') {
    items.push(`AI 검수 상태: ${problem.aiReviewStatus}`);
  }

  return items;
}

function formatProblemSummary(problem, stats) {
  const strategy = problem.variantStrategyName || resolveVariantStrategyLabel(problem);
  return [
    `- **${problem.label || problem.id}** (id: \`${problem.id}\`)`,
    `  단원: ${problem.unitGoal || '—'} | 전략: ${strategy || '—'}`,
    `  풀이 ${stats.solveCount} · 정답률 ${pct(stats.correctCount, stats.solveCount)} · 평가 ${stats.evalCount} · 잘못만든문제 ${stats.unsolvableCount} · 코멘트 ${stats.commentCount}`,
  ].join('\n');
}

function formatProblemDetail(problem, aggregate, mergedStudents, aiItem) {
  const { stats, studentRows, comments } = aggregate;
  const stem = getExamQuestionStemForStudent(problem.variantQuestion);
  const strategy = problem.variantStrategyName || resolveVariantStrategyLabel(problem);
  const sortedRows = sortRowsByStudentAttendance(studentRows, mergedStudents, 'uuid');
  const anomalies = detectAnomalies(problem, aggregate, mergedStudents);
  const aiLines = formatAiFeedbackForReport(aiItem || problem);

  const lines = [
    `### ${problem.label || problem.id}`,
    '',
    `- problemId: \`${problem.id}\``,
    `- 단원: ${problem.unitGoal || '—'}`,
    `- 변형 전략: ${strategy || '—'} (id: ${problem.variantStrategyId || '—'})`,
    `- 시험: ${problem.examTitle || '—'}`,
  ];

  if (aiLines.length > 0) {
    lines.push('', '**AI 검수 (검수함과 동일)**', ...aiLines);
  } else {
    lines.push(`- AI 검수: ${problem.aiReviewStatus || '—'}`);
  }

  lines.push(
    '',
    '**통계**',
    `- 풀이 ${stats.solveCount} · 정답 ${stats.correctCount} (${pct(stats.correctCount, stats.solveCount)})`,
    `- 동료 평가 ${stats.evalCount} · 잘못 만든 문제 ${stats.unsolvableCount} · 코멘트 ${stats.commentCount}`,
    '',
    '**변형 문제 지문**',
    '```',
    stem || '(없음)',
    '```',
    '',
    '**정답**',
    '```',
    String(problem.variantAnswer || '').trim() || '(없음)',
    '```',
  );

  if (anomalies.length > 0) {
    lines.push('', '**이상 징후**', ...anomalies.map((a) => `- ${a}`));
  }

  if (comments.length > 0) {
    lines.push('', '**학생 코멘트**');
    for (const c of comments) {
      lines.push(
        `- ${anonymizedStudentLabel(mergedStudents, c.uuid)} (${completionLabel(c.completionLevel)}): ${c.thought}`,
      );
    }
  }

  lines.push('', '**학생별 기록** (실명 미포함)');
  if (sortedRows.length === 0) {
    lines.push('- (기록 없음)');
  } else {
    lines.push('| 학생 | AI답 | 정답 | 제출 답 | 완성도 | 전략 | 코멘트 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of sortedRows) {
      const name = anonymizedStudentLabel(mergedStudents, row.uuid);
      const solve = row.solve;
      const peer = row.peer;
      const aiCorrect = solve && typeof solve.aiGradedCorrect === 'boolean'
        ? solve.aiGradedCorrect
        : solve?.solvedCorrect;
      const aiMark = solve ? (aiCorrect ? 'O' : 'X') : '—';
      const finalMark = !solve ? '—' : solve.solvedCorrect ? 'O' : 'X';
      const changed = solve
        && typeof solve.aiGradedCorrect === 'boolean'
        && solve.aiGradedCorrect !== solve.solvedCorrect;
      lines.push(
        `| ${name} | ${aiMark}${changed ? ' (변경됨)' : ''} | ${finalMark} | ${String(solve?.submittedAnswer || '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${peer ? completionLabel(peer.guessedCompletionLevel) : '—'} | ${peer ? strategyLabel(peer.guessedStrategyId) : '—'} | ${String(peer?.problemThought || '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Cursor 채팅에 붙여넣을 학급 문제은행 통계 리포트 (마크다운)
 */
export function buildClassProblemBankDevReport({
  classCode = '',
  problems = [],
  evaluations = [],
  mergedStudents = [],
  selectedProblemId = null,
  taskNote = '',
  scope = 'all', // 'all' | 'selected'
  variantReviewLookup = null,
  variantReviewById = null,
  aiItemsByProblemId = null,
}) {
  const lookup = variantReviewLookup
    || (variantReviewById ? { byReviewId: variantReviewById, byClassProblemId: null } : null);
  const evalByProblem = groupEvaluationsByProblem(evaluations);
  const generatedAt = new Date().toISOString();

  let totalSolve = 0;
  let totalCorrect = 0;
  let totalEval = 0;
  let totalUnsolvable = 0;

  const summaries = (problems || []).map((problem) => {
    const agg = aggregateProblemEvaluationRows(evalByProblem.get(problem.id) || []);
    const { stats } = agg;
    totalSolve += stats.solveCount;
    totalCorrect += stats.correctCount;
    totalEval += stats.evalCount;
    totalUnsolvable += stats.unsolvableCount;
    return { problem, agg, stats };
  });

  const lines = [
    '# 학급 문제은행 통계 (개발용)',
    '',
    `> 개인정보 보호: 학생 실명은 포함하지 않았습니다. 번호·짧은 uuid만 표시합니다.`,
    '',
    `- classCode: \`${classCode || '(없음)'}\``,
    `- 생성 시각: ${generatedAt}`,
    `- 문제 수: ${problems.length}`,
    `- 평가 기록 수: ${(evaluations || []).length}`,
    '',
    '## 전체 요약',
    `- 총 풀이 ${totalSolve} · 정답 ${totalCorrect} (${pct(totalCorrect, totalSolve)})`,
    `- 동료 평가 ${totalEval} · 잘못 만든 문제 평가 ${totalUnsolvable}`,
    '',
  ];

  if (String(taskNote || '').trim()) {
    lines.push('## Cursor 작업 요청', '', String(taskNote).trim(), '');
  }

  lines.push(
    '## 관련 코드 위치 (참고)',
    '- `src/components/teacher/TeacherClassProblemBankPanel.js` — 교사 UI',
    '- `src/components/ClassProblemBank.js` / `ClassProblemSolve.js` — 학생 UI',
    '- `src/firebase/classProblemBankOps.js` — Firestore 집계·저장',
    '- `src/constants/variantEvaluation.js` — 완성도·전략 라벨',
    '',
  );

  if (scope === 'selected' && selectedProblemId) {
    const hit = summaries.find((s) => s.problem.id === selectedProblemId);
    if (hit) {
      const aiItem = aiItemsByProblemId?.get(hit.problem.id)
        || mergeProblemWithVariantReviewAi(hit.problem, lookup);
      lines.push('## 선택 문제 상세', '', formatProblemDetail(hit.problem, hit.agg, mergedStudents, aiItem));
    } else {
      lines.push('## 선택 문제 상세', '', '(선택한 문제를 찾을 수 없습니다)');
    }
    return lines.join('\n');
  }

  lines.push('## 문제별 요약');
  if (summaries.length === 0) {
    lines.push('- (등록된 문제 없음)');
  } else {
    for (const { problem, stats } of summaries) {
      lines.push(formatProblemSummary(problem, stats));
    }
  }

  const flagged = summaries.filter((s) => detectAnomalies(s.problem, s.agg, mergedStudents).length > 0);
  if (flagged.length > 0) {
    lines.push('', '## 주목할 문제');
    for (const { problem, agg } of flagged) {
      const anomalies = detectAnomalies(problem, agg, mergedStudents);
      lines.push(`- **${problem.label || problem.id}**: ${anomalies.join(' / ')}`);
    }
  }

  if (selectedProblemId) {
    const hit = summaries.find((s) => s.problem.id === selectedProblemId);
    if (hit) {
      const aiItem = aiItemsByProblemId?.get(hit.problem.id)
        || mergeProblemWithVariantReviewAi(hit.problem, lookup);
      lines.push('', '---', '', formatProblemDetail(hit.problem, hit.agg, mergedStudents, aiItem));
    }
  }

  lines.push(
    '',
    '---',
    '',
    '위 통계를 바탕으로 학급 문제은행 관련 코드를 수정해 주세요.',
  );

  return lines.join('\n');
}
