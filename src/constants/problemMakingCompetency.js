/**
 * 문제 만들기 역량 — 이벤트·성공 경로 상수
 *
 * 성공 정의:
 *   - AI 정상: AI 통과 → 교사 승인(approved)
 *   - AI 불가(peer_review): 동료 승인 완료(approved)
 *   - AI 내용 거절: 성공 아님 (동료로 넘어가지 않음)
 */
import { SUBMISSION_STATUS_APPROVED } from './aiSubmissionPolicy';

export { SUBMISSION_STATUS_APPROVED };

/** @typedef {'variant'|'new'} MakingProblemKind */

/** 제출·검토 이벤트 결과 */
export const MAKING_OUTCOME = {
  AI_REJECT: 'ai_reject',
  AI_PASS_PENDING_TEACHER: 'ai_pass_pending_teacher',
  PEER_REVIEW_STARTED: 'peer_review_started',
  SUCCESS_TEACHER: 'success_teacher',
  SUCCESS_PEER: 'success_peer',
  NEW_SUBMITTED: 'new_submitted',
  TEACHER_REJECT: 'teacher_reject',
};

/** makingProblems 문서의 성공 경로 */
export const MAKING_SUCCESS_PATH = {
  TEACHER: 'teacher',
  PEER: 'peer',
};

export const MAKING_EVENT_TYPE = {
  SESSION_START: 'session_start',
  SUBMIT: 'submit',
  SUCCESS: 'success',
  TEACHER_REJECT: 'teacher_reject',
};
