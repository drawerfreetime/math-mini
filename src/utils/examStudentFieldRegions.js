/**
 * 학생별 시험지 — 이름·출석번호 입력칸 → 정규화 박스 (scan-organize · pdf_regions 와 동일)
 */

/** 입력칸 가로 글자 수(0.62em/자) — 출석번호는 1~2자리라 기존 6의 60% */
export const EXAM_FIELD_CHARS_WIDE = { attendance: 6 * 0.6, name: 10 };

/** backend scan_organize_api._nx_ny_spec_to_region 과 동일 계수 */
export function specToNormRegion(spec, pageWidthPt, pageHeightPt, charsWide) {
  if (!spec || typeof spec !== 'object') return null;
  const nx = Number(spec.nx);
  const ny = Number(spec.ny);
  const fs = Number(spec.fontSizePt);
  if (![nx, ny, fs].every((v) => Number.isFinite(v))) return null;
  const pw = Math.max(Number(pageWidthPt) || 595, 1);
  const ph = Math.max(Number(pageHeightPt) || 841, 1);
  const w = (fs * Number(charsWide) * 0.62) / pw;
  const h = (fs * 1.35) / ph;
  return { x: nx, y: ny, w, h };
}

/**
 * pdf_regions.json 레코드에 name_region · student_number_region 병합 저장
 * @param {object} opts
 */
export async function saveStudentFieldRegionsToServer(opts) {
  const pdfName = String(opts?.pdfName || '').trim();
  const attendanceSpec = opts?.attendanceSpec;
  const nameSpec = opts?.nameSpec;
  const pageWidthPt = Number(opts?.pageWidthPt) || 595;
  const pageHeightPt = Number(opts?.pageHeightPt) || 841;
  if (!pdfName || !attendanceSpec || !nameSpec) {
    throw new Error('pdfName·출석·이름 spec이 필요합니다.');
  }
  const name_region = specToNormRegion(nameSpec, pageWidthPt, pageHeightPt, 10);
  const student_number_region = specToNormRegion(
    attendanceSpec,
    pageWidthPt,
    pageHeightPt,
    EXAM_FIELD_CHARS_WIDE.attendance
  );
  if (!name_region || !student_number_region) {
    throw new Error('이름·출석번호 박스 좌표 계산 실패');
  }
  const body = {
    pdf_name: pdfName,
    exam_name: String(opts?.examName || '').trim() || pdfName.replace(/\.pdf$/i, ''),
    grade: opts?.grade ?? null,
    semester: opts?.semester ?? null,
    unit: opts?.unit ?? null,
    total_pages: Number(opts?.totalPages) > 0 ? Number(opts.totalPages) : 1,
    page_width: pageWidthPt,
    page_height: pageHeightPt,
    name_region,
    student_number_region,
    nameSpec,
    attendanceSpec,
  };
  const res = await fetch('/api/regions/student-fields', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || data.message || `저장 실패 (${res.status})`);
  }
  return data;
}
