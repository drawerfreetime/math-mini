/**
 * 변형 문제 — 내 문제 저장소·검수 대기열 문서 ID
 * 같은 시험·같은 원문 번호라도 변형마다 고유 ID (전략·내용이 다르면 별도 등록)
 */

/** @param {string} examId @param {number|string} sourceNumber */
export function buildVariantBankDocId(examId, sourceNumber) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `v_${String(examId).trim()}_q${Number(sourceNumber)}_${suffix}`;
}

/** @param {string} studentUUID @param {string} bankDocId */
export function buildVariantReviewId(studentUUID, bankDocId) {
  return `vr_${String(studentUUID).slice(0, 8)}_${String(bankDocId).trim()}`;
}

/**
 * 구 reviewId(exam_{examId}_s{uuid}_q{n}) → bankDocId — 하위 호환
 * @param {string} reviewId
 * @param {string} studentUUID
 */
export function legacyBankDocIdFromReviewId(reviewId, studentUUID) {
  const marker = `_s${studentUUID}_`;
  const parts = String(reviewId || '').split(marker);
  if (parts.length !== 2) return null;
  return `${parts[0]}_${parts[1]}`;
}

/**
 * 학급 problemBank 행 → variantReviews 문서 ID 후보 (저장 reviewId 없을 때 추론)
 * @param {{ reviewId?: string, createdBy?: string, examId?: string, sourceNumber?: number|null }} problem
 * @returns {string[]}
 */
export function inferClassProblemReviewIds(problem) {
  const ids = [];
  const rid = String(problem?.reviewId || '').trim();
  if (rid) ids.push(rid);
  const uuid = String(problem?.createdBy || '').trim();
  const examId = String(problem?.examId || '').trim();
  if (uuid && examId && problem?.sourceNumber != null && problem?.sourceNumber !== '') {
    ids.push(`exam_${examId}_s${uuid}_q${Number(problem.sourceNumber)}`);
  }
  return [...new Set(ids)];
}

/**
 * 학생 problemBank 행 → variantReviews 문서 ID
 * @param {{ id?: string, reviewId?: string, bankDocId?: string, examId?: string, sourceNumber?: number|null }} item
 * @param {string} studentUUID
 */
export function resolveReviewIdForBankItem(item, studentUUID) {
  const rid = String(item?.reviewId || '').trim();
  if (rid) return rid;
  const bankDocId = String(item?.bankDocId || item?.id || '').trim();
  const uuid = String(studentUUID || '').trim();
  if (uuid && bankDocId) return buildVariantReviewId(uuid, bankDocId);
  const examId = String(item?.examId || '').trim();
  if (uuid && examId && item?.sourceNumber != null && item?.sourceNumber !== '') {
    return `exam_${examId}_s${uuid}_q${Number(item.sourceNumber)}`;
  }
  return null;
}
