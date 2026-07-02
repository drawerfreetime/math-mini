/**
 * 학급 코드 정규화 — 대시보드 IndexedDB 매핑·Firestore 조회에서 동일 문자열 매칭
 */
export function normalizeClassCode(classCode) {
  const norm = String(classCode || '').trim().toUpperCase();
  if (!norm) return '';
  // 학급코드에 'U'가 들어가면(포함/시작/끝 모두) 무효 처리
  if (norm.includes('U')) return '';
  return norm;
}
