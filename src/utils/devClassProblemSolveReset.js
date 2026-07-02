/**
 * 학급 문제 풀이 — 본인 풀이·동료평가 기록 초기화 (개발용)
 * npm start(development) 또는 REACT_APP_DEV_CLASS_PROBLEM_SOLVE_RESET=1
 */
export function isDevClassProblemSolveResetEnabled() {
  return process.env.NODE_ENV !== 'production'
    || process.env.REACT_APP_DEV_CLASS_PROBLEM_SOLVE_RESET === '1';
}
