/**
 * pdf.js는 public/index.html 에서 로드하고, worker는 같은 출처(public/)에서 제공합니다.
 * CDN worker는 학교망·오프라인 등에서 importScripts 실패가 잦습니다.
 */
const PDFJS_WORKER = `${process.env.PUBLIC_URL || ''}/pdf.worker.min.js`;

let workerConfigured = false;

export function configurePdfJsWorker(lib) {
  if (!lib?.GlobalWorkerOptions || workerConfigured) return;
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  workerConfigured = true;
}

/** @returns {typeof import('pdfjs-dist/build/pdf') | undefined} */
export function getPdfJs() {
  const lib = window['pdfjs-dist/build/pdf'];
  configurePdfJsWorker(lib);
  return lib;
}

/** PDF.js render 작업 안전 취소 — 같은 canvas에 중복 render() 호출 방지 */
export function cancelPdfRenderTask(task) {
  if (!task) return;
  try {
    task.cancel();
  } catch {
    /* noop */
  }
}
