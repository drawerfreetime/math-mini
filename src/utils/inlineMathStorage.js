/**
 * 인라인 수식 저장 포맷 유틸리티
 */

export const INLINE_MATH_FROZEN_CLASS = 'inline-math-frozen';
export const INLINE_ATOMIC_UNIT_CLASS = 'inline-math-atomic-unit';

export function parseUnitDisplaySegments(_unit) { return []; }

export function unitCanonicalToKatexLatex(_unit) { return ''; }

export function parseInlineMathStorage(_input) { return []; }

export function serializeContentEditable(_el) { return ''; }

export function buildUnitDisplayFragment(_unit) { return document.createDocumentFragment(); }

export function createBarGraphChipElement(_config) { return document.createElement('span'); }

export function updateBarGraphChipElement(_chip, _config) {}

export function createAtomicUnitElement(_unit) { return document.createElement('span'); }

export function parseMultVertLatex(_latex) { return null; }

export function getElementaryMathInlineHtml(_latex) { return ''; }

export function createFrozenMathElement(_latex) { return document.createElement('span'); }

export function updateFrozenMathElement(_span, _latex) {}

export function hydrateContentEditable(_el, _storage) {}
