/**
 * PDF 영역 휴리스틱 분석 유틸리티
 */

export async function analyzePage(_page, _viewport) {
  return null;
}

export function detectHasImage(_meta, _rectN) {
  return { hasImage: false, imageBoxes: [], coverage: 0 };
}

export function detectStructure(_meta, _rectN) {
  return '기타';
}

export function imageBoxToRelativeRect(_box, _meta, _parentRectN) {
  return null;
}
