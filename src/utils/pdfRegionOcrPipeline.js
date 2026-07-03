/**
 * PDF OCR 파이프라인 유틸리티
 */

export const RENDER_SCALE = 3.0;

export const OCR_CONCURRENCY = 1;

export function ocrResultNeedsRetry(_entry) { return false; }

export async function runWithConcurrency(_items, _limit, _asyncFn) { return []; }

export function problemDisplayLabel(_v) { return ''; }

export function problemBaseInt(_v) { return 0; }

export function buildApiUnits(_ordered) { return []; }

export async function verticalMergeRegionsToPng(_regions, _pageCache, _gapPx) { return null; }

export async function stackDataUrlsToSingle(_passageDataUrl, _questionDataUrls) { return null; }

export function getOcrUnitKey(_unit) { return ''; }

export function listQuestionOcrUnits(_regions) { return []; }

export function getRegionNumberStatus(_region, _allRegions) { return null; }

export function canOpenProblemConfirm(_regions) { return false; }

export async function preparePageCache(_pdfDoc, _pageNums, _scale) { return {}; }

export async function buildCropPipelineData(_regions, _pageCache) { return { crops: [] }; }

export function cropEntryIndexByUnitKey(_cropData, _unitKey) { return -1; }

export async function runOcrOnCropEntry() { return null; }

export async function assembleFinalProblems() { return []; }
