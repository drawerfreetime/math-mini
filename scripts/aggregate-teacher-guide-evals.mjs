#!/usr/bin/env node
/**
 * 1단계 집계: teacherAiGuides JSON보내기 → 패턴 카운트
 *
 * 사용법:
 *   node scripts/aggregate-teacher-guide-evals.mjs path/to/export.json
 *
 * export.json 형식 (Firebase 콘솔·스크립트 등에서 수집):
 *   [
 *     { "id": "1", "data": { "examId": "...", "draftGuideEvalByStrategyId": { ... }, "aggregationCurriculum": { "grade":"4", "semester":"1", "unit":"..." } } }
 *   ]
 *
 * 프로젝트 루트에서 실행할 때 guideEvalAggregate는 src/utils 에 있음 — 아래는 동일 로직 인라인 요약이 아니라 dynamic import.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

async function loadAggregateUtils() {
  const modPath = join(root, 'src', 'utils', 'guideEvalAggregate.js');
  return import(pathToFileURL(modPath).href);
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/aggregate-teacher-guide-evals.mjs <export.json> [--min=2] [--top=30]');
    process.exit(1);
  }

  let minCount = 2;
  let topN = 30;
  for (const arg of process.argv.slice(3)) {
    if (arg.startsWith('--min=')) minCount = Number(arg.split('=')[1]) || 2;
    if (arg.startsWith('--top=')) topN = Number(arg.split('=')[1]) || 30;
  }

  const raw = readFileSync(file, 'utf8');
  const docs = JSON.parse(raw);
  if (!Array.isArray(docs)) {
    console.error('JSON must be an array of { id, data }');
    process.exit(1);
  }

  const {
    flattenTeacherAiGuideDocs,
    rollupGuideEvalCounts,
    formatRollupReport,
  } = await loadAggregateUtils();

  const records = flattenTeacherAiGuideDocs(docs);
  const counts = rollupGuideEvalCounts(records);

  console.log(`records: ${records.length}`);
  console.log(`unique buckets: ${Object.keys(counts).length}`);
  console.log('');
  console.log('count\tstrategy|verdict|failureCode|flags:...|unit:...');
  console.log(formatRollupReport(counts, { minCount, topN }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
