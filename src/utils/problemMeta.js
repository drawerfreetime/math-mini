/**
 * 문항 메타 — 지문에서 풀이과정 요구 여부 추정
 */

/**
 * 문제 지문에 풀이·과정 서술 등을 요구하는 표현이 있는지 (교사 검수·저장 시 보조)
 */
export function inferRequiresSolution(questionText) {
  if (!questionText || typeof questionText !== 'string') return false;
  const q = questionText;
  const low = q.toLowerCase();
  const patterns = [
    /풀이\s*과정/, /풀이과정/, /풀이를\s*쓰/, /과정을\s*쓰/, /과정을\s*나타내/, /과정을\s*서술/,
    /서술하/, /구하는\s*과정/, /답과?\s*함께\s*(?:과정|풀이)/, /과정\s*을\s*바르게/,
    /풀이\s*하시오/, /풀이하세요/, /보이시오/, /설명하시오/,
    /show\s+your\s+work/i, /explain\s+(your|the)\s+reasoning/i, /explain\s+how/i,
  ];
  return patterns.some((re) => re.test(q) || re.test(low));
}

/**
 * 원본 문항 문서에서「풀이과정 필요」여부 (Firestore 플래그 우선).
 */
export function problemNeedsSolutionFromDoc(p) {
  if (!p) return false;
  if (p.requiresSolution === true) return true;
  if (p.requiresSolution === false) return false;
  return inferRequiresSolution(String(p.question || ''));
}
