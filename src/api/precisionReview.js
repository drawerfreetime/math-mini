/**
 * 정밀 재검토 — 문항 크롭 + 교사 지시 → Gemini OCR 재실행
 */
import { normalizeExamQuestionText } from '../utils/examBlankBrackets';
import { stripLeadingCircledFromChoiceText } from '../utils/circledAnswer';
import { backendUrl } from '../utils/backendUrl';

/** data URL → { mediaType, base64 } */
export function parseCropDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

function normalizeCoreSlice(core) {
  if (!core || typeof core !== 'object') return core;
  const normBlank = (s) => normalizeExamQuestionText(s);
  const q = normBlank(core.question);
  const ch = Array.isArray(core.choices)
    ? core.choices.map((c) => stripLeadingCircledFromChoiceText(normBlank(c)))
    : core.choices;
  const bg =
    core.bogi != null && core.bogi !== ''
      ? normBlank(core.bogi)
      : core.bogi;
  return { ...core, question: q, choices: ch, bogi: bg };
}

function writableCoreFromProblem(p) {
  return {
    number: p.number,
    question: p.question ?? '',
    choices: p.choices ?? null,
    hasImage: !!p.hasImage,
    imageDescription: p.imageDescription ?? null,
    bogi: p.bogi ?? null,
    tableData: p.tableData ?? null,
    answer: p.answer ?? null,
    bbox: p.bbox ?? null,
  };
}

/** API 응답을 문항 객체에 반영 (이전/재검토 결과 비교용 스냅샷 유지) */
export function mergePrecisionReviewIntoProblem(prev, apiResult) {
  const reviewSnap = normalizeCoreSlice(apiResult.core || apiResult.claude_result || {});
  const geminiSnap = prev.ocrPrecisionUsed && prev.gemini_result
    ? { ...prev.gemini_result }
    : normalizeCoreSlice(
        prev.gemini_result || writableCoreFromProblem(prev),
      );

  const patch = {
    question: reviewSnap.question ?? prev.question ?? '',
    choices: reviewSnap.choices !== undefined ? reviewSnap.choices : prev.choices,
    hasImage: reviewSnap.hasImage !== undefined ? !!reviewSnap.hasImage : prev.hasImage,
    imageDescription:
      reviewSnap.imageDescription !== undefined
        ? reviewSnap.imageDescription
        : prev.imageDescription,
    bogi: reviewSnap.bogi !== undefined ? reviewSnap.bogi : prev.bogi,
    tableData: reviewSnap.tableData !== undefined ? reviewSnap.tableData : prev.tableData,
    gemini_result: geminiSnap,
    claude_result: reviewSnap,
    display_result: { ...reviewSnap },
    ocrPrecisionUsed: true,
    ocrCompareShowsGemini: false,
  };

  return { ...prev, ...patch };
}

/** POST /api/exam-ocr/precise-review */
export async function requestPreciseReview({
  base64,
  mediaType = 'image/jpeg',
  problemNumber,
  currentCore,
  instruction,
  messages,
  signal,
}) {
  const res = await fetch(backendUrl('/api/exam-ocr/precise-review'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      base64,
      mediaType,
      problemNumber,
      currentCore,
      instruction: instruction || undefined,
      messages: messages?.length ? messages : undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || `OCR 재검토 실패 (${res.status})`);
  }
  return data;
}
