/**
 * 교사 대시보드 — 학급 문제은행 개발용 코드 개선 패널
 * npm start(development) 또는 REACT_APP_DEV_CLASS_PROBLEM_BANK_STATS=1
 */
export function isDevClassProblemBankStatsEnabled() {
  return process.env.NODE_ENV !== 'production'
    || process.env.REACT_APP_DEV_CLASS_PROBLEM_BANK_STATS === '1';
}
