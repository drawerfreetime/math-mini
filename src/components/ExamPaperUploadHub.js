/**
 * 교사용 시험지 로컬 라이브러리 — PDF만 이 브라우저 IndexedDB에 저장(서버 미전송).
 * 시험 전 원안 / 시험 후 스캔본 등 구분은 표시 이름으로 관리합니다.
 */
import React, { useCallback, useEffect, Fragment, useMemo, useRef, useState } from 'react';
import HudFrame from './HudFrame';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  listExamPaperLibrary,
  addExamPaperToLibrary,
  deleteExamPaperFromLibrary,
  updateExamPaperLibraryLabel,
  updateExamPaperLibraryEntry,
} from '../utils/pdfStorage';
import {
  syncExamPaperLabelToExams,
  syncExamPaperLabelToClassExamResults,
} from '../utils/examPaperLabelSync';
import { normalizeClassCode } from '../utils/classCode';
import CurriculumPickers, { curriculumSelectionComplete } from './CurriculumPickers';

export default function ExamPaperUploadHub() {
  const navigate = useNavigate();
  const { teacherUser } = useAuth();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploadBusy, setUploadBusy] = useState(false);
  /** @type {[{ phase: 'saving' | 'success' | 'error', message: string } | null]} */
  const [uploadStatus, setUploadStatus] = useState(null);
  const [highlightIds, setHighlightIds] = useState(() => new Set());
  const [toast, setToast] = useState('');
  const [errorBanner, setErrorBanner] = useState('');
  const listSectionRef = useRef(null);
  const [regGrade, setRegGrade] = useState('');
  const [regSemester, setRegSemester] = useState('');
  const [regUnit, setRegUnit] = useState('');
  const [editMeta, setEditMeta] = useState(null);
  /** 표시 이름 편집 중(저장 전) — id → 문자열 */
  const [labelDrafts, setLabelDrafts] = useState({});
  const [savingLabels, setSavingLabels] = useState(false);

  const regCurriculumOk = curriculumSelectionComplete(regGrade, regSemester, regUnit);

  const getDraftLabel = useCallback(
    (entry) => {
      if (labelDrafts[entry.id] !== undefined) return labelDrafts[entry.id];
      return entry.label;
    },
    [labelDrafts],
  );

  const isLabelDirty = useCallback(
    (entry) => String(getDraftLabel(entry) || '').trim() !== String(entry.label || '').trim(),
    [getDraftLabel],
  );

  const dirtyLabelCount = useMemo(
    () => entries.filter((e) => isLabelDirty(e)).length,
    [entries, isLabelDirty],
  );

  const hasDirtyLabels = dirtyLabelCount > 0;

  useEffect(() => {
    if (!hasDirtyLabels) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasDirtyLabels]);

  /** silent: 목록만 갱신(표·입력 유지). 최초 로드는 silent 아님 → 로딩 문구 표시 */
  const refresh = useCallback(async (opts = {}) => {
    const silent = opts.silent === true;
    if (!silent) setLoading(true);
    try {
      const list = await listExamPaperLibrary();
      setEntries(list);
    } catch (e) {
      console.error(e);
      setToast('목록을 불러오지 못했습니다.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh({ silent: false });
  }, [refresh]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = window.setTimeout(() => setToast(''), 5200);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (uploadStatus?.phase !== 'success') return undefined;
    const t = window.setTimeout(() => setUploadStatus(null), 8000);
    return () => window.clearTimeout(t);
  }, [uploadStatus]);

  useEffect(() => {
    if (!highlightIds.size) return undefined;
    const t = window.setTimeout(() => setHighlightIds(new Set()), 5000);
    return () => window.clearTimeout(t);
  }, [highlightIds]);

  async function onPickFiles(ev) {
    const input = ev.target;
    const picked = input.files;
    if (!picked?.length) return;
    // value 초기화를 먼저 하면 일부 브라우저에서 FileList가 비는 경우가 있어, 배열로 복사한 뒤 비움
    const files = Array.from(picked);
    input.value = '';
    setErrorBanner('');
    setUploadStatus(null);
    setUploadBusy(true);
    let added = 0;
    let dupNote = 0;
    let anyNonPdf = false;
    const addedIds = [];
    const pdfFiles = [];
    if (!regCurriculumOk) {
      setErrorBanner('학년·학기·단원을 모두 선택한 뒤 PDF를 추가해 주세요.');
      setUploadBusy(false);
      return;
    }
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const isPdf =
        String(f.type || '').toLowerCase().includes('pdf') ||
        String(f.name || '')
          .toLowerCase()
          .endsWith('.pdf');
      if (isPdf) pdfFiles.push(f);
      else anyNonPdf = true;
    }
    if (!pdfFiles.length) {
      setUploadBusy(false);
      if (anyNonPdf) setErrorBanner('PDF만 추가할 수 있습니다.');
      return;
    }
    const namePreview =
      pdfFiles.length === 1
        ? `「${pdfFiles[0].name}」`
        : `${pdfFiles.length}개 PDF`;
    setUploadStatus({
      phase: 'saving',
      message: `${namePreview} 업로드 중… 이 브라우저에 저장하고 있습니다.`,
    });
    try {
      for (let i = 0; i < pdfFiles.length; i += 1) {
        const f = pdfFiles[i];
        setUploadStatus({
          phase: 'saving',
          message:
            pdfFiles.length > 1
              ? `${i + 1}/${pdfFiles.length} — 「${f.name}」 저장 중…`
              : `「${f.name}」 업로드 중…`,
        });
        const r = await addExamPaperToLibrary(f, {
          grade: regGrade,
          semester: regSemester,
          unit: regUnit,
        });
        added += 1;
        addedIds.push(r.id);
        if (r.duplicateOf) dupNote += 1;
      }
      await refresh({ silent: true });
      if (added) {
        setHighlightIds(new Set(addedIds));
        const successMsg =
          added === 1
            ? `「${pdfFiles[0].name}」 시험지가 업로드되었습니다. 아래 목록에서 확인할 수 있습니다.`
            : `${added}개의 시험지가 업로드되었습니다. 아래 목록에서 확인할 수 있습니다.`;
        setUploadStatus({ phase: 'success', message: successMsg });
        setToast(
          dupNote
            ? `✅ ${successMsg} (동일 내용 PDF ${dupNote}건 포함)`
            : `✅ ${successMsg}`
        );
        window.requestAnimationFrame(() => {
          listSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      } else if (anyNonPdf) {
        setErrorBanner('PDF만 추가할 수 있습니다.');
        setUploadStatus({ phase: 'error', message: 'PDF만 추가할 수 있습니다.' });
      } else if (files.length > 0) {
        const failMsg = '시험지를 업로드하지 못했습니다. 잠시 후 다시 시도해 주세요.';
        setErrorBanner(failMsg);
        setUploadStatus({ phase: 'error', message: failMsg });
      }
    } catch (e) {
      console.error(e);
      const name = e && e.name;
      let msg = e?.message || String(e);
      if (name === 'QuotaExceededError') {
        msg = '브라우저 저장 공간이 부족합니다. 목록에서 안 쓰는 시험지를 삭제한 뒤 다시 시도해 주세요.';
      }
      setErrorBanner(msg);
      setUploadStatus({ phase: 'error', message: msg });
    } finally {
      setUploadBusy(false);
    }
  }

  async function onDelete(id, label) {
    if (!window.confirm(`「${label}」을(를) 이 기기에서 삭제할까요?`)) return;
    try {
      await deleteExamPaperFromLibrary(id);
      await refresh({ silent: true });
      setToast('삭제했습니다.');
    } catch (e) {
      console.error(e);
      setToast(e.message || '삭제에 실패했습니다.');
    }
  }

  async function saveAllDirtyLabels() {
    const dirty = entries.filter((e) => isLabelDirty(e));
    if (!dirty.length) {
      setToast('변경된 표시 이름이 없습니다.');
      return;
    }
    for (const entry of dirty) {
      if (!String(getDraftLabel(entry) || '').trim()) {
        setToast('비어 있는 표시 이름이 있습니다. 모두 입력해 주세요.');
        return;
      }
    }

    setSavingLabels(true);
    let examsUpdated = 0;
    let resultStudents = 0;
    const classCode = normalizeClassCode(localStorage.getItem('teacher_class_code'));
    try {
      for (const entry of dirty) {
        const v = String(getDraftLabel(entry) || '').trim();
        const previousLabel = entry.label;
        await updateExamPaperLibraryLabel(entry.id, v);
        if (teacherUser?.uid) {
          const { updated } = await syncExamPaperLabelToExams(
            teacherUser.uid,
            { ...entry, label: v },
            previousLabel,
          );
          examsUpdated += updated;
        }
        if (classCode) {
          const { students } = await syncExamPaperLabelToClassExamResults(
            classCode,
            { ...entry, label: v },
            previousLabel,
          );
          resultStudents += students;
        }
      }
      setLabelDrafts({});
      await refresh({ silent: true });
      const n = dirty.length;
      let msg = `✅ 표시 이름 ${n}건을 저장했습니다.`;
      if (examsUpdated > 0) {
        msg += ` 변형하기·문제 보관함 ${examsUpdated}건`;
      }
      if (resultStudents > 0) {
        msg += `${examsUpdated > 0 ? ',' : ''} 채점 결과 ${resultStudents}명 반영`;
      }
      setToast(msg);
    } catch (e) {
      console.error(e);
      setToast(e?.message || '저장에 실패했습니다.');
    }
    setSavingLabels(false);
  }

  function tryNavigateAway(path) {
    if (hasDirtyLabels) {
      const ok = window.confirm(
        '저장하지 않은 표시 이름 변경이 있습니다. 나가면 변경 내용이 사라집니다. 나가시겠습니까?',
      );
      if (!ok) return;
      setLabelDrafts({});
    }
    navigate(path);
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => tryNavigateAway('/teacher')}>
            ← 교사 대시보드
          </button>
          <span className="header-icon">📤</span>
          <div>
            <h1 className="header-title">시험지 업로드</h1>
            <p className="header-subtitle">
              PDF는 이 브라우저(IndexedDB)에만 보관되며 서버로 전송되지 않습니다.
            </p>
          </div>
        </div>
      </header>

      <main className="dashboard-main" style={{ maxWidth: 880 }}>
        {errorBanner ? (
          <div
            className="alert alert-error"
            style={{ marginBottom: 16 }}
            role="alert"
          >
            {errorBanner}
          </div>
        ) : null}
        {toast ? (
          <div
            className="alert"
            style={{
              marginBottom: 16,
              background: '#f0fdf4',
              border: '1px solid #bbf7d0',
              color: '#166534',
            }}
          >
            {toast}
          </div>
        ) : null}

        <HudFrame>
          <div className="section-header">
            <h2 className="section-title">시험지 추가</h2>
          </div>
          <p style={{ fontSize: 14, color: '#64748b', marginBottom: 12 }}>
            <strong>학년·학기·단원</strong>을 먼저 고른 뒤 PDF를 추가하면, 같은 분류가 시험지 파일에 함께 저장됩니다.
            시험지 OCR 등 다른 교사 도구에서 &quot;등록된 시험지&quot;로 불러올 때 이 정보가 연동됩니다.
          </p>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12, lineHeight: 1.55 }}>
            <strong>PDF 추가</strong>는 파일을 고르면 <strong>즉시 이 기기에 저장</strong>됩니다(별도 저장 버튼 없음).
            <strong> 표시 이름</strong>을 고친 뒤 아래 목록 오른쪽 위 <strong>저장</strong>을 눌러야
            반영됩니다. 같은 이름이 <strong>채점 결과·변형하기·문제 보관함</strong>에도 쓰입니다.
          </p>
          <div
            style={{
              background: '#faf5ff',
              border: '1px solid #e9d5ff',
              borderRadius: 12,
              padding: '16px 18px',
              marginBottom: 16,
            }}
          >
            <CurriculumPickers
              grade={regGrade}
              semester={regSemester}
              unit={regUnit}
              disabled={uploadBusy}
              onChange={({ grade, semester, unit }) => {
                setRegGrade(grade);
                setRegSemester(semester);
                setRegUnit(unit);
              }}
            />
            {!regCurriculumOk ? (
              <p style={{ fontSize: 13, color: '#7c3aed', marginTop: 8 }}>위 세 항목을 모두 선택하면 PDF를 추가할 수 있습니다.</p>
            ) : null}
          </div>
          <p style={{ fontSize: 14, color: '#64748b', marginBottom: 12 }}>
            시험지 OCR로 만든 원안·학생별 시험지 인쇄(이름·번호) PDF는 보통 <strong>시험 전</strong>에, 스캔본 정리에는{' '}
            <strong>시험 후</strong> 스캔 PDF를 올리게 됩니다. 같은 양식이라도 단계별로 각각 등록하고 표시 이름으로 구분해 주세요.
          </p>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={uploadBusy || !regCurriculumOk}
              tabIndex={-1}
              style={{
                cursor: uploadBusy || !regCurriculumOk ? 'not-allowed' : 'pointer',
                pointerEvents: 'none',
                opacity: !regCurriculumOk ? 0.65 : 1,
              }}
            >
              {uploadBusy ? (
                <>
                  <span className="spinner" /> 업로드 중…
                </>
              ) : (
                'PDF 선택(여러 개 가능)…'
              )}
            </button>
            <input
              type="file"
              accept="application/pdf,.pdf"
              multiple
              disabled={uploadBusy || !regCurriculumOk}
              tabIndex={-1}
              onChange={onPickFiles}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '100%',
                height: '100%',
                margin: 0,
                padding: 0,
                opacity: 0,
                cursor: uploadBusy || !regCurriculumOk ? 'not-allowed' : 'pointer',
                zIndex: 2,
                fontSize: 0,
                pointerEvents: uploadBusy || !regCurriculumOk ? 'none' : 'auto',
              }}
            />
          </div>
          {uploadStatus ? (
            <div
              role="status"
              aria-live="polite"
              className="alert"
              style={{
                marginTop: 14,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                background:
                  uploadStatus.phase === 'success'
                    ? '#f0fdf4'
                    : uploadStatus.phase === 'error'
                      ? '#fef2f2'
                      : '#eff6ff',
                border:
                  uploadStatus.phase === 'success'
                    ? '1px solid #bbf7d0'
                    : uploadStatus.phase === 'error'
                      ? '1px solid #fecaca'
                      : '1px solid #bfdbfe',
                color:
                  uploadStatus.phase === 'success'
                    ? '#166534'
                    : uploadStatus.phase === 'error'
                      ? '#991b1b'
                      : '#1e40af',
              }}
            >
              {uploadStatus.phase === 'saving' ? (
                <span
                  className="spinner"
                  style={{ borderColor: 'rgba(30,64,175,0.25)', borderTopColor: '#1e40af', marginTop: 2 }}
                />
              ) : (
                <span aria-hidden="true" style={{ fontSize: 18, lineHeight: 1.2 }}>
                  {uploadStatus.phase === 'success' ? '✅' : '⚠️'}
                </span>
              )}
              <span style={{ fontSize: 14, lineHeight: 1.5 }}>{uploadStatus.message}</span>
            </div>
          ) : null}
        </HudFrame>

        <div ref={listSectionRef}>
        <HudFrame>
          <div className="section-header">
            <h2 className="section-title">업로드한 시험지</h2>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={loading || savingLabels || !hasDirtyLabels}
              onClick={saveAllDirtyLabels}
            >
              {savingLabels
                ? '저장 중…'
                : dirtyLabelCount > 0
                  ? `저장 (${dirtyLabelCount})`
                  : '저장'}
            </button>
          </div>
          {hasDirtyLabels ? (
            <div
              style={{
                fontSize: 13,
                color: '#92400e',
                background: '#fffbeb',
                border: '1px solid #fde68a',
                borderRadius: 8,
                padding: '10px 14px',
                marginBottom: 12,
              }}
            >
              ⚠️ 표시 이름을 바꿨다면 오른쪽 위 <strong>저장</strong>을 눌러 주세요. (PDF 추가는 선택 즉시 저장됩니다.)
            </div>
          ) : null}

          {loading ? (
            <p style={{ color: '#64748b' }}>불러오는 중…</p>
          ) : entries.length === 0 ? (
            <p style={{ color: '#64748b' }}>아직 저장된 시험지가 없습니다. 위에서 PDF를 추가해 주세요.</p>
          ) : (
            <div
              style={{
                width: '100%',
                maxWidth: '100%',
                boxSizing: 'border-box',
                border: '1px solid var(--gray-200)',
                borderRadius: 8,
                overflow: 'hidden',
                background: '#fff',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 4fr) minmax(0, 2fr) minmax(0, 3fr) minmax(0, 1fr)',
                  width: '100%',
                  maxWidth: '100%',
                  boxSizing: 'border-box',
                  columnGap: 12,
                  alignItems: 'start',
                }}
              >
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    color: 'var(--gray-600)',
                    padding: '12px 10px',
                    background: 'var(--gray-50)',
                    borderBottom: '1px solid var(--gray-200)',
                  }}
                >
                  표시 이름
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    color: 'var(--gray-600)',
                    padding: '12px 10px',
                    background: 'var(--gray-50)',
                    borderBottom: '1px solid var(--gray-200)',
                  }}
                >
                  학년·학기·단원
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    color: 'var(--gray-600)',
                    padding: '12px 10px',
                    background: 'var(--gray-50)',
                    borderBottom: '1px solid var(--gray-200)',
                    minWidth: 0,
                  }}
                >
                  원본 파일명
                </div>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    color: 'var(--gray-600)',
                    padding: '12px 10px',
                    background: 'var(--gray-50)',
                    borderBottom: '1px solid var(--gray-200)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  삭제
                </div>

                {entries.map((e) => {
                  const justUploaded = highlightIds.has(e.id);
                  const rowHighlight = justUploaded
                    ? { background: '#f0fdf4', boxShadow: 'inset 3px 0 0 #22c55e' }
                    : {};
                  return (
                  <Fragment key={e.id}>
                    <div
                      style={{
                        padding: '12px 10px',
                        borderBottom: '1px solid var(--gray-100)',
                        minWidth: 0,
                        ...rowHighlight,
                      }}
                    >
                      <input
                        type="text"
                        className="form-input"
                        style={{
                          minWidth: 0,
                          width: '100%',
                          maxWidth: '100%',
                          boxSizing: 'border-box',
                          fontSize: 13,
                          pointerEvents: 'auto',
                          ...(isLabelDirty(e)
                            ? { borderColor: '#f59e0b', boxShadow: '0 0 0 1px #fde68a' }
                            : {}),
                        }}
                        value={getDraftLabel(e)}
                        onChange={(ev) => setLabelDrafts((prev) => ({
                          ...prev,
                          [e.id]: ev.target.value,
                        }))}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: '#475569',
                        padding: '12px 10px',
                        borderBottom: '1px solid var(--gray-100)',
                        minWidth: 0,
                        ...rowHighlight,
                      }}
                    >
                      {e.grade && e.semester && e.unit ? (
                        <>
                          <strong>{e.grade}</strong> · {e.semester}
                          <br />
                          <span style={{ color: '#64748b' }}>{e.unit}</span>
                        </>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>미지정</span>
                      )}
                      <div style={{ marginTop: 6 }}>
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          onClick={() =>
                            setEditMeta({
                              id: e.id,
                              grade: e.grade || '초4',
                              semester: e.semester || '1학기',
                              unit: e.unit || '',
                            })
                          }
                        >
                          분류 수정
                        </button>
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: '#475569',
                        padding: '12px 10px',
                        borderBottom: '1px solid var(--gray-100)',
                        minWidth: 0,
                        wordBreak: 'break-word',
                        overflowWrap: 'anywhere',
                        lineHeight: 1.4,
                        ...rowHighlight,
                      }}
                    >
                      {e.originalFileName}
                      {justUploaded ? (
                        <div style={{ marginTop: 4, color: '#15803d', fontWeight: 600 }}>방금 업로드됨</div>
                      ) : null}
                    </div>
                    <div
                      style={{
                        padding: '12px 10px',
                        borderBottom: '1px solid var(--gray-100)',
                        whiteSpace: 'nowrap',
                        ...rowHighlight,
                      }}
                    >
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        style={{ color: '#dc2626', borderColor: '#fecaca' }}
                        onClick={() => onDelete(e.id, e.label)}
                      >
                        삭제
                      </button>
                    </div>
                  </Fragment>
                  );
                })}
              </div>
            </div>
          )}
        </HudFrame>
        </div>

        <HudFrame>
          <div className="section-header">
            <h2 className="section-title">다음 단계(예정)</h2>
          </div>
          <p style={{ fontSize: 14, color: '#64748b' }}>
            시험지 OCR·학생별 시험지 인쇄·스캔본 정리에서 <strong>여기에 올린 목록만</strong> 고르게 연결하는 작업은 이어서
            붙이면 됩니다. <strong>시험지 OCR</strong>에서는 등록된 시험지를 고르면 파일과 학년·학기·단원이 함께
            채워집니다.
          </p>
        </HudFrame>

        {editMeta ? (
          <div
            className="modal-overlay"
            style={{ zIndex: 50000 }}
            onClick={() => setEditMeta(null)}
            onKeyDown={(ev) => ev.key === 'Escape' && setEditMeta(null)}
            role="presentation"
          >
            <div
              className="modal"
              style={{ maxWidth: 480, zIndex: 50001 }}
              onClick={(ev) => ev.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="exam-meta-edit-title"
            >
              <div className="modal-header">
                <h3 id="exam-meta-edit-title">시험 분류 수정</h3>
                <button type="button" className="modal-close" onClick={() => setEditMeta(null)}>
                  ×
                </button>
              </div>
              <div className="modal-body">
                <CurriculumPickers
                  grade={editMeta.grade}
                  semester={editMeta.semester}
                  unit={editMeta.unit}
                  onChange={(next) => setEditMeta((prev) => ({ ...prev, ...next }))}
                />
              </div>
              <div className="modal-footer" style={{ borderTop: '1px solid #e2e8f0' }}>
                <button type="button" className="btn btn-ghost" onClick={() => setEditMeta(null)}>
                  취소
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!curriculumSelectionComplete(editMeta.grade, editMeta.semester, editMeta.unit)}
                  onClick={async () => {
                    if (!curriculumSelectionComplete(editMeta.grade, editMeta.semester, editMeta.unit)) return;
                    try {
                      await updateExamPaperLibraryEntry(editMeta.id, {
                        grade: editMeta.grade,
                        semester: editMeta.semester,
                        unit: editMeta.unit,
                      });
                      setEditMeta(null);
                      await refresh({ silent: true });
                      setToast('분류를 저장했습니다.');
                    } catch (err) {
                      console.error(err);
                      setToast(err?.message || '저장에 실패했습니다.');
                    }
                  }}
                >
                  저장
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
