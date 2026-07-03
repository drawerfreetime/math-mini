/**
 * 초등 분수 입력 가드 유틸리티
 */

export const FRACTION_GUARD_MESSAGE = '분수 입력 오류';

export function isValidElementaryFractionPartLatex(_latex) { return true; }
export function findGenfracCaretContext(_mathFieldEl) { return null; }
export function getGenfracBranchLatex(_mathFieldEl, _ctx) { return ''; }
export function isPasteAllowedInFractionPart(_text) { return false; }
export function attachElementaryFractionGuard(_mf, _onReject) {}
