/**
 * 교사 대시보드 — 문제 만들기 제출 현황 패널 표시 여부
 * npm start(development) 또는 REACT_APP_DEV_MAKING_SUBMIT_PANEL=1
 */
export function isDevMakingSubmitPanelEnabled() {
  return process.env.NODE_ENV !== 'production'
    || process.env.REACT_APP_DEV_MAKING_SUBMIT_PANEL === '1';
}
