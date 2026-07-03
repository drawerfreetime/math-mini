/**
 * AI 변형 문제 제출 · 교사 승인 — 만 13세 미만 생성형 AI 노출 정책 대비
 *
 * [상태값 흐름]
 *   pending_review : 교사 최종 승인 대기 (AI 승인·미승인 모두 포함, aiApproved 로 구분)
 *   peer_review    : AI 전체 실패 → 동료 학생 2명 승인 대기
 *                    └ variantReviews.peerApprovals 배열로 진행 추적
 *                    └ 2명 완료 시 → problemBank 자동 등록 (TODO)
 *   approved       : 교사 또는 동료 2명 승인 완료 → 학생에게 노출 허용
 *   approved_partial : 풀이 과정만 미통과 — 학급 문제은행 유지, 탐구점수 15점(추가 15점 가능)
 *   rejected       : 교사가 반려 → 학급 문제은행에서만 숨김 (내 문제 저장소에는 유지)
 *
 * [peerApprovals 필드 구조 — variantReviews 문서]
 *   peerApprovals: Array<{
 *     studentUUID: string,   // 승인한 학생 UUID
 *     approvedAt: Timestamp,
 *   }>
 *   peerApprovalRequired: number  // 필요 승인 수 (현재 2 고정)
 *
 * [학생 화면 노출 정책]
 *   AI 피드백(체크리스트·한마디)은 제출 직후·교사 승인/반려 후 모두 표시.
 *   교사 코멘트는 승인·반려 후 AI 피드백 아래에 덧붙임.
 *   REACT_APP_HIDE_AI_NOTE_UNTIL_TEACHER_APPROVAL=true 이면 교사 승인/반려 전까지 AI 한마디 숨김
 */

import { hasStudentVisibleAiFeedback } from '../utils/studentAiFeedback';

export const SUBMISSION_STATUS_PENDING = 'pending';
/** 제출 즉시 학급 문제은행 등록 (교사 승인 없음) */
export const SUBMISSION_STATUS_REGISTERED = 'registered';
export const SUBMISSION_STATUS_PENDING_REVIEW = 'pending_review';
export const SUBMISSION_STATUS_PEER_REVIEW = 'peer_review';

/** 교사 대시보드 변형 문제 검수 탭 — 미처리(승인·반려 전) 제출 */
export const VARIANT_REVIEW_OPEN_STATUSES = [
  // legacy(이전 배포본) — 일부 문서가 pending 으로 남아 있어 누락 방지
  SUBMISSION_STATUS_PENDING,
  SUBMISSION_STATUS_REGISTERED,
  SUBMISSION_STATUS_PENDING_REVIEW,
  SUBMISSION_STATUS_PEER_REVIEW,
];
export const SUBMISSION_STATUS_APPROVED = 'approved';
/** 풀이 과정만 미통과 — 학급 문제은행 유지, 부분 탐구점수(15점) */
export const SUBMISSION_STATUS_APPROVED_PARTIAL = 'approved_partial';
export const SUBMISSION_STATUS_REJECTED = 'rejected';

/** 교사가 피드백 보내기로 처리 완료한 상태 */
export const TEACHER_RESOLVED_SUBMISSION_STATUSES = [
  SUBMISSION_STATUS_APPROVED,
  SUBMISSION_STATUS_APPROVED_PARTIAL,
  SUBMISSION_STATUS_REJECTED,
];

/**
 * 교사 검수함에 표시할 미처리 변형 문제인지 판별합니다.
 * 반려·승인 후에는 학생이 다시 제출하기 전까지 검수함에 나오지 않아야 합니다.
 * @param {object|null|undefined} item
 */
export function isOpenVariantReviewForTeacherInbox(item) {
  if (!item) return false;
  const reviewStatus = item.teacherReviewStatus || item.status;
  if (TEACHER_RESOLVED_SUBMISSION_STATUSES.includes(reviewStatus)) return false;
  if (!VARIANT_REVIEW_OPEN_STATUSES.includes(reviewStatus)) return false;
  // AI 동기화 버그로 status만 registered로 되돌아간 경우 (resolvedAt은 남음)
  if (item.resolvedAt && reviewStatus === SUBMISSION_STATUS_REGISTERED) return false;
  return true;
}

/** 동료 학생 승인에 필요한 최소 인원 */
export const PEER_APPROVAL_REQUIRED = 2;

/** AI 모드 레이블 (교사 대시보드 표시용) */
export const AI_MODE_LABELS = {
  gemini_teacher: '교사 Gemini',
  gemini_default: '기본 Gemini',
  claude: 'Claude Haiku',
  peer_review: '동료 학생 검토',
  validation: '자동 검증',
  deterministic: '자동 검산 통과',
  new_problem: '새 문제',
};

/**
 * peer_review 항목의 동료 승인 진행 상태를 반환
 * @param {{ peerApprovals?: Array<object>, peerApprovalRequired?: number }} item
 * @returns {{ count: number, required: number, done: boolean }}
 */
export function getPeerApprovalProgress(item) {
  const count = Array.isArray(item?.peerApprovals) ? item.peerApprovals.length : 0;
  const required = item?.peerApprovalRequired ?? PEER_APPROVAL_REQUIRED;
  return { count, required, done: count >= required };
}

/**
 * 학생 화면에 AI 피드백(aiNote)을 표시할지 결정
 * @param {{ status?: string, aiNote?: string, aiApproved?: boolean|null }} item
 */
export function shouldShowStoredAiNoteToStudent(item) {
  return hasStudentVisibleAiFeedback(item);
}

/**
 * 학생에게 표시할 상태 텍스트
 * @param {string} status
 * @param {{ peerApprovals?: Array<object>, peerApprovalRequired?: number }} [item]
 */
export function getStatusLabel(status, item) {
  switch (status) {
    case SUBMISSION_STATUS_REGISTERED: return '학급 문제은행 등록됨';
    case SUBMISSION_STATUS_PENDING_REVIEW: return '교사 검토 대기 중';
    case SUBMISSION_STATUS_PEER_REVIEW: {
      if (item) {
        const { count, required } = getPeerApprovalProgress(item);
        return `동료 검토 중 (${count}/${required})`;
      }
      return '동료 학생 검토 대기';
    }
    case SUBMISSION_STATUS_APPROVED: return '승인 완료';
    case SUBMISSION_STATUS_APPROVED_PARTIAL: return '풀이 과정 보완 필요';
    case SUBMISSION_STATUS_REJECTED: return '반려됨';
    default: return '검토 중';
  }
}
