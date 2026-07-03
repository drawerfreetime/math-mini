/**
 * Firestore exams/{id}/questions 스냅샷 → UnitTestReview 내부 problems[] 형태
 */
import { circledDigitsToMcNumber, stripLeadingCircledFromChoiceText } from './circledAnswer';
import { normalizeMatchingPayload } from './matchingItems';

export function firebaseExamQuestionsToReviewProblems(rows) {
  const sorted = [...rows].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));

  const flat = sorted.map((row) => {
    const data = { ...row };
    delete data.id;

    const num = Number(data.number);
    const numberVal = Number.isFinite(num) ? num : 1;

    let choices = data.choices;
    if ((!choices || !choices.length) && data.options?.length) {
      const opts = [...data.options];
      if (typeof opts[0] === 'string') {
        choices = opts.map((s) => stripLeadingCircledFromChoiceText(s));
      } else {
        choices = opts
          .sort((a, b) => (Number(a.num) || 0) - (Number(b.num) || 0))
          .map((o) => stripLeadingCircledFromChoiceText(String(o.text ?? '')));
      }
      choices = choices.map((s) => String(s).trim()).filter(Boolean);
      if (!choices.length) choices = null;
    } else if (choices?.length) {
      choices = choices.map((c) => stripLeadingCircledFromChoiceText(c));
    } else {
      choices = null;
    }

    const question = data.question ?? data.text ?? '';

    let answer = data.answer ?? null;
    if (choices?.length && answer != null && answer !== '') {
      answer = circledDigitsToMcNumber(answer);
    }

    if (data.problemType === '선잇기') {
      const normalized = normalizeMatchingPayload({
        question: data.question,
        leftItems: data.leftItems,
        rightItems: data.rightItems,
        leftLabels: data.leftLabels,
        rightLabels: data.rightLabels,
      });
      return {
        number: numberVal,
        question: normalized.question,
        problemType: '선잇기',
        leftItems: normalized.leftItems,
        rightItems: normalized.rightItems,
        leftLabels: normalized.leftLabels,
        rightLabels: normalized.rightLabels,
        answer: data.answer ?? null,
        explanation: data.explanation ?? null,
        requiresSolution: !!data.requiresSolution,
        hasImage: !!(data.hasImage || data.image_b64),
        _cropDataUrl: data.image_b64 || null,
        image_b64: data.image_b64 || null,
      };
    }

    return {
      number: numberVal,
      question,
      choices,
      bogi: data.bogi ?? null,
      passage: data.passage ?? null,
      groupLabel: data.groupLabel ?? null,
      passageImage_b64: data.passageImage_b64 ?? null,
      groupStackImage_b64: data.groupStackImage_b64 ?? null,
      hasImage: !!(data.hasImage || data.image_b64),
      answer,
      requiresSolution:
        data.requiresSolution !== undefined && data.requiresSolution !== null
          ? !!data.requiresSolution
          : undefined,
      solutionArea: data.solutionArea ?? null,
      explanation: data.explanation ?? null,
      image_b64: data.image_b64 || null,
      _cropDataUrl: data.image_b64 || null,
    };
  });

  // groupLabel이 있으면 UnitTestReview가 이해하는 type:'group' 형태로 재구성
  const groups = new Map(); // key -> { label, passage, passageImage_b64, questions[], minNo }
  const out = [];

  for (const p of flat) {
    const gl = p.groupLabel;
    const ps = p.passage;
    if (gl && String(gl).trim()) {
      const key = `${String(gl).trim()}::${String(ps ?? '')}`;
      if (!groups.has(key)) {
        groups.set(key, {
          label: String(gl).trim(),
          passage: ps ?? '',
          passageImage_b64: p.passageImage_b64 || null,
          groupStackImage_b64: p.groupStackImage_b64 || null,
          questions: [],
          minNo: Number(p.number) || Infinity,
        });
      }
      const g = groups.get(key);
      g.questions.push({ ...p, groupLabel: null, passage: null, passageImage_b64: null });
      g.minNo = Math.min(g.minNo, Number(p.number) || Infinity);
      if (!g.passageImage_b64 && p.passageImage_b64) g.passageImage_b64 = p.passageImage_b64;
      if (!g.groupStackImage_b64 && p.groupStackImage_b64) g.groupStackImage_b64 = p.groupStackImage_b64;
    } else {
      out.push(p);
    }
  }

  for (const g of groups.values()) {
    g.questions.sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
    out.push({
      type: 'group',
      label: g.label,
      passage: g.passage || '',
      passageImage_b64: g.passageImage_b64 || null,
      groupStackImage_b64: g.groupStackImage_b64 || null,
      questions: g.questions,
    });
  }

  // 전체 순서: 단일은 number, 그룹은 소문항 최소 번호 기준
  out.sort((a, b) => {
    const ka = a.type === 'group'
      ? Math.min(...(a.questions || []).map((q) => Number(q.number) || Infinity))
      : (Number(a.number) || Infinity);
    const kb = b.type === 'group'
      ? Math.min(...(b.questions || []).map((q) => Number(q.number) || Infinity))
      : (Number(b.number) || Infinity);
    return ka - kb;
  });

  return out;
}
