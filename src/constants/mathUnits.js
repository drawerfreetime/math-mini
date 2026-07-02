/**
 * 인라인 확장 툴바 — 연산·단위(표시·저장 canonical: 면적·부피는 유니코드 ² ³)
 */
export const mathUnits = {
  연산기호: ['+', '-', '×', '÷', '=', '>', '<', '≒', '≠', '≤', '≥'],
  '길이/들이': ['mm', 'cm', 'm', 'km', 'mL', 'L', 'g', 'kg', 't'],
  '넓이/부피': ['mm\u00B2', 'cm\u00B2', 'm\u00B2', 'km\u00B2', 'mm\u00B3', 'cm\u00B3', 'm\u00B3', 'km\u00B3'],
  '각도/도형': ['°', '∠', '△', '□', '○', '⊥', '∥'],
};

/** @type {(keyof typeof mathUnits)[]} */
export const mathUnitCategoryOrder = ['연산기호', '길이/들이', '넓이/부피', '각도/도형'];
