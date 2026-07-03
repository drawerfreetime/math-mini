/**
 * 교사 검수함 — 제출 항목 완전 삭제 (개발용)
 * npm start(development) 또는 REACT_APP_DEV_REVIEW_INBOX_PURGE=1
 */
export function isDevReviewInboxPurgeEnabled() {
  return process.env.NODE_ENV !== 'production'
    || process.env.REACT_APP_DEV_REVIEW_INBOX_PURGE === '1';
}
