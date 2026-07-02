/**
 * ScanOrganize — 스캔본 자동 정리 (교사 전용)
 *
 * 4단계(순서·회전)는 /scan-organize/layout 로 분리
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HudFrame from './HudFrame';
import { useNavigate, useLocation } from 'react-router-dom';
import { PDFDocument } from 'pdf-lib';
import { useAuth } from '../contexts/AuthContext';
import { backendUrl } from '../utils/backendUrl';
import { loadExamSpecs, listExamPaperLibrary } from '../utils/pdfStorage';
import { normalizeRegistrationMarkSpec } from '../utils/scanRegistrationMarks';
import { normalizeClassCode } from '../utils/classCode';
import {
  getStudentsByClass,
  getStudentUuidByClassAndStudentNumber,
  appendStudentExamResult,
} from '../firebase/firestoreOps';
import { getAllMappings } from '../utils/teacherDB';
import { mergeStudentsForTeacherView, sortStudentsByAttendance } from '../utils/mergeTeacherStudents';
import { formatAiScoreDisplay } from '../utils/examResults';

async function getPdfPageCount(file) {
  const buf = await file.arrayBuffer();
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  return pdf.getPageCount();
}

function makeSlotItems(pages) {
  const ts = Date.now();
  return Array.from({ length: pages }, (_, i) => ({
    id: `slot-${i}-${ts}`,
    physicalIndex: i,
    rotation: 0,
  }));
}

function stripPdfExt(value) {
  return String(value || '').replace(/\.pdf$/i, '');
}

function normalizeExamChoiceKey(value) {
  return stripPdfExt(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()（）[\]{}._-]/g, '');
}

/** 결과 표·O/X 줄 — 블록 번호 대신 학생 표시 */
function formatStudentRowLabel(s) {
  const sn = parseInt(String(s.studentNumber ?? ''), 10);
  const numOk = Number.isFinite(sn) && sn > 0;
  const name = String(s.studentName || '').trim();
  if (name && numOk) return `${name} (${sn}번)`;
  if (name) return `${name} (출석번호 미확인)`;
  if (numOk) return `${sn}번`;
  return `스캔 ${s.blockIndex + 1}번째 묶음 (이름·번호 미확인)`;
}

function studentFirestoreSkipReason(st) {
  const sn = parseInt(String(st.studentNumber ?? ''), 10);
  if (!Number.isFinite(sn) || sn < 1) return '출석번호 없음';
  return null;
}

/** 구 서버: JSON 안에 processedPdfBase64. 신 서버: 바이너리(4바이트 JSON 길이 + UTF-8 JSON + PDF bytes) */
function parseScanOrganizeProcessBody(arrayBuffer, contentType) {
  const ct = (contentType || '').toLowerCase();
  const buf = arrayBuffer;
  if (ct.includes('application/json')) {
    const data = JSON.parse(new TextDecoder().decode(buf));
    return { data, pdfBytes: null };
  }
  if (buf.byteLength < 8) {
    throw new Error('응답 본문이 너무 짧습니다.');
  }
  const dv = new DataView(buf);
  const jsonLen = dv.getUint32(0, false);
  if (jsonLen < 2 || 4 + jsonLen > buf.byteLength) {
    throw new Error('scan-organize 응답 형식이 올바르지 않습니다. 백엔드를 최신으로 맞춰 주세요.');
  }
  const metaText = new TextDecoder().decode(new Uint8Array(buf, 4, jsonLen));
  const data = JSON.parse(metaText);
  const pdfBytes = new Uint8Array(buf, 4 + jsonLen, buf.byteLength - 4 - jsonLen);
  return { data, pdfBytes };
}

function uint8FromProcessedPdfBase64(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function findTemplateForLibraryEntry(entry, templates) {
  if (!entry || !Array.isArray(templates)) return null;
  const exactPdf = templates.find((t) => String(t.pdf_name || '') === String(entry.originalFileName || ''));
  if (exactPdf) return exactPdf;
  const exactName = templates.find((t) => String(t.exam_name || '') === String(entry.label || ''));
  if (exactName) return exactName;

  const entryKeys = [
    entry.originalFileName,
    stripPdfExt(entry.originalFileName),
    entry.label,
  ]
    .map(normalizeExamChoiceKey)
    .filter(Boolean);

  return templates.find((t) => {
    const templateKeys = [
      t.pdf_name,
      stripPdfExt(t.pdf_name),
      t.exam_name,
    ]
      .map(normalizeExamChoiceKey)
      .filter(Boolean);
    return entryKeys.some((k) => templateKeys.includes(k));
  }) || null;
}

/** 채점 크롭 미리보기 그리드 (process 전·후 공용) */
function GradeCropPreviewPanel({ preview, loading, onSelectBlock }) {
  const crops = preview?.crops || [];
  const studentFieldCrops = preview?.studentFieldCrops || [];
  const overlays = preview?.pageOverlays || [];
  const nBlocks = preview?.nBlocks ?? 1;
  const blockIndex = preview?.blockIndex ?? 0;
  const pageReg = preview?.pageRegistration || null;

  const regRows = useMemo(() => {
    if (!pageReg || typeof pageReg !== 'object') return [];
    return Object.entries(pageReg)
      .map(([k, v]) => {
        const page = Number(k);
        const obj = v && typeof v === 'object' ? v : {};
        const hits = Number(obj.hits) || 0;
        const foundModel = String(obj.foundModel || obj.found_model || obj.found || '').trim();
        const model = String(obj.model || '').trim();
        return {
          page: Number.isFinite(page) ? page : null,
          hits,
          foundModel,
          model,
        };
      })
      .filter((r) => r.page != null)
      .sort((a, b) => a.page - b.page);
  }, [pageReg]);

  if (!preview && !loading) return null;

  return (
    <div
      style={{
        marginTop: 14,
        padding: '12px 14px',
        background: '#f8fafc',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>채점 크롭 미리보기</strong>
        <span style={{ fontSize: 12, color: '#64748b' }}>(Gemini·API 호출 없음)</span>
        {nBlocks > 1 && onSelectBlock ? (
          <label style={{ fontSize: 12, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            학생 블록
            <select
              className="input"
              style={{ width: 'auto', minWidth: 88 }}
              value={blockIndex}
              disabled={loading}
              onChange={(e) => onSelectBlock(Number(e.target.value))}
            >
              {Array.from({ length: nBlocks }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}번
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {preview?.gradeCropMode != null || preview?.markStripLeftPad != null ? (
        <p style={{ fontSize: 12, color: '#475569', margin: '0 0 10px', lineHeight: 1.5 }}>
          빨간 = 채점 네모(markBox). 초록 점선 = 문항 영역.
          <strong style={{ color: '#0369a1' }}> 파란 점선 = 이름 OCR 칸</strong>
          <strong style={{ color: '#7e22ce' }}> · 보라 점선 = 출석번호 OCR 칸</strong>
          (L자 보정·회전 반영).
          {preview?.registrationMarkEnabled && preview?.pageRegistration
            ? ` L자 마크: ${Object.entries(preview.pageRegistration)
                .map(([p, o]) => {
                  if ((o.hits || 0) < 3) return `${p}쪽 미검출(${o.hits})`;
                  return `${p}쪽 affine ${o.hits}점`;
                })
                .join(' · ')}`
            : ''}
          {preview?.gradeAnchorEnabled && preview?.pageAnchorOffsets
            ? ` · 띠 보정(마크 실패 시): ${Object.entries(preview.pageAnchorOffsets)
                .map(([p, o]) => {
                  const mode = o.anchorMode === 'image' ? '이미지' : o.anchorMode === 'text' ? '텍스트' : '없음';
                  if ((o.hits || 0) < 1) return `${p}쪽 ${mode} 없음`;
                  if (o.model === 'linear') {
                    const b = Math.round((o.dy_slope || 0) * 1000) / 10;
                    const a = Math.round((o.dy_intercept || 0) * 1000) / 10;
                    return `${p}쪽 ${mode} dy=${a}%+${b}%×y(${o.hits}문항)`;
                  }
                  return `${p}쪽 ${mode} dx=${Math.round((o.dx || 0) * 1000) / 10}% dy=${Math.round((o.dy || 0) * 1000) / 10}%(${o.hits})`;
                })
                .join(' · ')}`
            : ''}
        </p>
      ) : null}

      {preview?.registrationMarkEnabled && regRows.length > 0 ? (
        <div
          style={{
            margin: '0 0 10px',
            padding: '10px 12px',
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 13, color: '#0f172a' }}>페이지별 등록(정렬) 상태</strong>
            <span style={{ fontSize: 11, color: '#64748b' }}>
              hits는 모서리 코너 검출 수(최대 4). aruco → 실패 시 l_mark fallback.
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#334155' }}>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #e2e8f0' }}>페이지</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #e2e8f0' }}>hits</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #e2e8f0' }}>검출</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #e2e8f0' }}>모델</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #e2e8f0' }}>상태</th>
                </tr>
              </thead>
              <tbody>
                {regRows.map((r) => {
                  const ok = (r.hits || 0) >= 3 && String(r.model || '') !== 'rejected' && String(r.model || '') !== 'none';
                  const status = (r.hits || 0) < 3 ? '미검출' : ok ? '정렬 OK' : '정렬 폐기';
                  const found = r.foundModel || 'unknown';
                  const model = r.model || 'none';
                  return (
                    <tr key={`reg-${r.page}`}>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #f1f5f9' }}>{r.page}쪽</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #f1f5f9' }}>{r.hits}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #f1f5f9' }}>
                        <code>{found}</code>
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #f1f5f9' }}>
                        <code>{model}</code>
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #f1f5f9' }}>
                        <span
                          style={{
                            fontWeight: 700,
                            color: ok ? '#15803d' : '#b91c1c',
                            background: ok ? '#dcfce7' : '#fee2e2',
                            border: `1px solid ${ok ? '#86efac' : '#fecaca'}`,
                            borderRadius: 999,
                            padding: '1px 8px',
                          }}
                        >
                          {status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {loading ? (
        <p style={{ fontSize: 13, color: '#64748b' }}>크롭 이미지 생성 중…</p>
      ) : null}

      {studentFieldCrops.length > 0 || preview?.nameBox ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 6 }}>
            이름·출석번호 OCR 크롭
            {preview?.nameSource ? (
              <span style={{ fontWeight: 400, color: '#64748b', marginLeft: 6 }}>
                (이름: <code>{preview.nameSource}</code>
                {preview?.numberSource ? (
                  <>
                    {' '}
                    · 번호: <code>{preview.numberSource}</code>
                  </>
                ) : null}
                )
              </span>
            ) : null}
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              padding: 8,
              background: '#fff',
              border: '1px solid #e2e8f0',
              borderRadius: 6,
            }}
          >
            {studentFieldCrops.map((item) => (
              <div
                key={`sf-${item.kind}`}
                style={{ textAlign: 'center', fontSize: 10, color: '#64748b' }}
              >
                <div
                  style={{
                    marginBottom: 4,
                    fontWeight: 600,
                    color: item.kind === 'name' ? '#0369a1' : '#7e22ce',
                  }}
                >
                  {item.label || (item.kind === 'name' ? '이름' : '출석번호')}
                </div>
                {item.cropBase64 ? (
                  <img
                    src={`data:image/png;base64,${item.cropBase64}`}
                    alt={`${item.label} OCR 크롭`}
                    style={{
                      maxHeight: 72,
                      maxWidth: 160,
                      border: `2px solid ${item.kind === 'name' ? '#7dd3fc' : '#d8b4fe'}`,
                      background: '#fff',
                      display: 'block',
                    }}
                  />
                ) : (
                  <span style={{ color: '#b45309' }}>크롭 실패</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {overlays.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
          {overlays.map((ov) => (
            <div key={`ov-${ov.page}`} style={{ flex: '1 1 280px', maxWidth: 420 }}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>
                {ov.page}쪽 · 문항·채점·이름/번호 칸
              </div>
              <img
                src={`data:image/png;base64,${ov.overlayBase64}`}
                alt={`${ov.page}쪽 오버레이`}
                style={{ width: '100%', border: '1px solid #cbd5e1', background: '#fff' }}
              />
            </div>
          ))}
        </div>
      ) : null}

      {crops.length > 0 ? (
        <div style={{ fontSize: 12, fontWeight: 600, color: '#334155', marginBottom: 6 }}>문항 채점 크롭</div>
      ) : null}
      {crops.length > 0 ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            maxHeight: 360,
            overflowY: 'auto',
            padding: 4,
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
          }}
        >
          {crops.map((item) => (
            <div
              key={`gc-${item.page}-${item.problemNumber}`}
              style={{ textAlign: 'center', fontSize: 10, color: '#64748b', maxWidth: 130 }}
            >
              <div style={{ marginBottom: 2 }}>
                {item.page > 1 ? `${item.page}쪽 ` : ''}
                {item.problemNumber}번
              </div>
              <img
                src={`data:image/png;base64,${item.cropBase64}`}
                alt={`${item.problemNumber}번 채점 크롭`}
                style={{
                  maxHeight: 80,
                  maxWidth: 120,
                  border: '1px solid #cbd5e1',
                  background: '#fff',
                  display: 'block',
                  margin: '0 auto',
                }}
              />
            </div>
          ))}
        </div>
      ) : !loading ? (
        <p style={{ fontSize: 12, color: '#b45309' }}>문항 영역이 없거나 크롭에 실패했습니다. 시험지 템플릿·문항 좌표를 확인하세요.</p>
      ) : null}
    </div>
  );
}

export default function ScanOrganize() {
  const navigate = useNavigate();
  const location = useLocation();
  const { teacherUser, teacherProfile } = useAuth();
  const lastLayoutTokenRef = useRef(null);

  const [classCode, setClassCode] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [examPaperEntries, setExamPaperEntries] = useState([]);
  const [examPaperLoading, setExamPaperLoading] = useState(true);
  const [selectedExamPaperId, setSelectedExamPaperId] = useState('');
  /** 학생별 시험지 인쇄에서 저장한 이름·번호 칸 좌표(IndexedDB, 시험지 pdf 파일명별) */
  const [savedSpecs, setSavedSpecs] = useState({
    attendanceSpec: null,
    nameSpec: null,
    specsScope: null,
  });
  const [selectedExam, setSelectedExam] = useState(null);
  const [pdfFile, setPdfFile] = useState(null);
  const [pdfPageCount, setPdfPageCount] = useState(null);
  /** 예 / 아니오 */
  const [pageChoice, setPageChoice] = useState(null);
  const [customPagesInput, setCustomPagesInput] = useState('');
  const [pageStepError, setPageStepError] = useState('');
  /** 한 학생당 페이지 수(검증 통과 후·레이아웃에서 사용) */
  const [effectiveN, setEffectiveN] = useState(null);
  const [layoutDone, setLayoutDone] = useState(false);
  const [items, setItems] = useState([]);
  const [processLoading, setProcessLoading] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState([]);
  /** 변환된 PDF(바이너리). base64 문자열을 state에 두지 않아 파싱·렌더 부담을 줄임 */
  const [processedPdfBytes, setProcessedPdfBytes] = useState(null);
  const [students, setStudents] = useState([]);
  const [examMeta, setExamMeta] = useState(null);
  const [classStudents, setClassStudents] = useState([]);
  const [localMappings, setLocalMappings] = useState([]);
  /** OCR이 실제로 사용한 좌표 (process 결과로 백엔드가 돌려줌) */
  const [ocrBoxesUsed, setOcrBoxesUsed] = useState(null);
  /** /preview-grade-crops — AI 없이 채점 띠만 확인 */
  const [gradeCropPreview, setGradeCropPreview] = useState(null);
  const [cropPreviewLoading, setCropPreviewLoading] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [firestoreSaving, setFirestoreSaving] = useState(false);
  /** 시험 만점 (교사 수동 점수 입력 시 분모, 기본 100) */
  const [examMaxScore, setExamMaxScore] = useState(100);

  const templateN = selectedExam?.total_pages || 0;

  useEffect(() => {
    const code = localStorage.getItem('teacher_class_code');
    setClassCode(code ? normalizeClassCode(code) : null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const url = backendUrl('/api/scan-organize/exams');
        const res = await fetch(url);
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          const hint =
            text.includes('<!DOCTYPE') || text.includes('<html')
              ? ' (응답이 HTML입니다. 빌드 배포 시 REACT_APP_API_BASE에 백엔드 URL을 넣거나, 개발 중에는 npm start + backend를 켜 주세요.)'
              : '';
          throw new Error(`JSON이 아닌 응답 (${res.status})${hint}: ${text.slice(0, 160)}`);
        }
        if (!res.ok) {
          throw new Error(data.detail || data.error || `HTTP ${res.status}`);
        }
        setTemplates(Array.isArray(data.templates) ? data.templates : []);
      } catch (e) {
        console.error(e);
        setError(`시험 템플릿 목록을 불러오지 못했습니다: ${e.message || e}`);
      }
    })();
  }, []);

  const refreshExamPapers = useCallback(async () => {
    setExamPaperLoading(true);
    try {
      const list = await listExamPaperLibrary().catch((err) => {
        console.warn('시험지 라이브러리 로드:', err);
        return [];
      });
      setExamPaperEntries(Array.isArray(list) ? list : []);
    } finally {
      setExamPaperLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshExamPapers();
  }, [refreshExamPapers]);

  useEffect(() => {
    let cancelled = false;
    const pdfName = selectedExam?.pdf_name;
    (async () => {
      try {
        const specs = await loadExamSpecs(pdfName).catch(() => ({
          attendanceSpec: null,
          nameSpec: null,
          specsScope: 'legacy',
        }));
        if (cancelled) return;
        setSavedSpecs({
          attendanceSpec: specs?.attendanceSpec || null,
          nameSpec: specs?.nameSpec || null,
          specsScope: specs?.specsScope || null,
        });
      } catch {
        if (!cancelled) {
          setSavedSpecs({ attendanceSpec: null, nameSpec: null, specsScope: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedExam?.pdf_name]);

  useEffect(() => {
    if (!classCode) {
      setClassStudents([]);
      setLocalMappings([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const [students, mappingsAll] = await Promise.all([
          getStudentsByClass(classCode).catch(() => []),
          getAllMappings().catch(() => []),
        ]);
        if (cancelled) return;
        const want = normalizeClassCode(classCode);
        const serverNumbers = new Set(
          (students || [])
            .map((s) => parseInt(String(s.studentNumber ?? ''), 10))
            .filter((n) => Number.isFinite(n) && n > 0)
        );
        const localRelevant = (mappingsAll || []).filter(
          (m) => {
            const mappingClassMatches = normalizeClassCode(m?.classCode) === want;
            const mappingNumber = parseInt(String(m?.studentNumber ?? ''), 10);
            const numberMatchesClassRoster = Number.isFinite(mappingNumber) && serverNumbers.has(mappingNumber);
            return mappingClassMatches || numberMatchesClassRoster;
          }
        );
        setClassStudents(Array.isArray(students) ? students : []);
        setLocalMappings(localRelevant);
      } catch {
        if (!cancelled) {
          setClassStudents([]);
          setLocalMappings([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [classCode]);

  useEffect(() => {
    const s = location.state;
    if (!s?.fromLayout || s.layoutReturnToken == null) return;
    if (lastLayoutTokenRef.current === s.layoutReturnToken) return;
    lastLayoutTokenRef.current = s.layoutReturnToken;
    setPdfFile(s.pdfFile);
    setSelectedExam(s.selectedExam);
    setEffectiveN(s.effectiveN);
    setItems(Array.isArray(s.items) ? s.items : []);
    setLayoutDone(true);
    setPageStepError('');
    setPageChoice(null);
    navigate('/scan-organize', { replace: true, state: {} });
  }, [location.state, navigate]);

  const resetFlow = () => {
    lastLayoutTokenRef.current = null;
    setPdfFile(null);
    setPdfPageCount(null);
    setSelectedExamPaperId('');
    setSelectedExam(null);
    setPageChoice(null);
    setCustomPagesInput('');
    setPageStepError('');
    setEffectiveN(null);
    setLayoutDone(false);
    setItems([]);
    setProcessedPdfBytes(null);
    setStudents([]);
    setExamMeta(null);
    setWarnings([]);
    setSaveMsg('');
    setError('');
    setOcrBoxesUsed(null);
    setGradeCropPreview(null);
    setCropPreviewLoading(false);
  };

  const buildTemplatePayload = useCallback(async () => {
    let templatePayload = { ...selectedExam };
    try {
      const freshSpecs = await loadExamSpecs(selectedExam?.pdf_name);
      const attendanceSpec = freshSpecs?.attendanceSpec || savedSpecs?.attendanceSpec;
      const nameSpec = freshSpecs?.nameSpec || savedSpecs?.nameSpec;
      if (attendanceSpec) templatePayload = { ...templatePayload, attendanceSpec };
      if (nameSpec) templatePayload = { ...templatePayload, nameSpec };
      templatePayload.registrationMark = normalizeRegistrationMarkSpec(
        freshSpecs?.registrationMark ?? savedSpecs?.registrationMark
      );
    } catch {
      if (savedSpecs?.attendanceSpec) {
        templatePayload = { ...templatePayload, attendanceSpec: savedSpecs.attendanceSpec };
      }
      if (savedSpecs?.nameSpec) {
        templatePayload = { ...templatePayload, nameSpec: savedSpecs.nameSpec };
      }
      templatePayload.registrationMark = normalizeRegistrationMarkSpec(savedSpecs?.registrationMark);
    }
    return templatePayload;
  }, [selectedExam, savedSpecs]);

  const runCropPreview = async (blockIndex = 0) => {
    if (!pdfFile || !selectedExam || !effectiveN || !items.length) return;
    setCropPreviewLoading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', pdfFile);
      fd.append('n', String(effectiveN));
      fd.append(
        'slots',
        JSON.stringify(items.map((it) => ({ physicalIndex: it.physicalIndex, rotation: it.rotation })))
      );
      fd.append('template_json', JSON.stringify(await buildTemplatePayload()));
      fd.append('block_index', String(blockIndex));
      const res = await fetch(backendUrl('/api/scan-organize/preview-grade-crops'), { method: 'POST', body: fd });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(text.slice(0, 200) || res.statusText);
      }
      if (!res.ok) {
        throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      }
      setGradeCropPreview(data);
      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        setWarnings(data.warnings);
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setCropPreviewLoading(false);
    }
  };

  const expectedNumbers = useMemo(() => {
    const set = new Set();
    (classStudents || []).forEach((s) => {
      const sn = parseInt(String(s.studentNumber ?? ''), 10);
      if (Number.isFinite(sn) && sn > 0) set.add(sn);
    });
    return set;
  }, [classStudents]);

  /**
   * Gemini OCR이 명단 후보 안에서만 이름을 고르도록 보낼 학급 명단.
   * 실명·출석번호는 교사 기기 IndexedDB(getAllMappings)에서만 가져오며
   * Firebase 학생 목록과 출석번호 키로 머지한다.
   */
  const rosterForOcr = useMemo(() => {
    const merged = mergeStudentsForTeacherView(localMappings, classStudents, classCode || '');
    const out = [];
    const seen = new Set();
    const addCandidate = (studentNumber, candidateNameRaw) => {
      const sn = parseInt(String(studentNumber ?? ''), 10);
      const candidateName = String(candidateNameRaw ?? '').trim();
      if (!Number.isFinite(sn) || sn < 1) return;
      if (!candidateName) return;
      if (candidateName === '[이름 없음]') return;
      if (seen.has(sn)) return;
      seen.add(sn);
      out.push({ name: candidateName, number: sn });
    };

    merged.forEach((s) => {
      addCandidate(s.studentNumber, s.realName ?? s.displayName);
    });

    // Firebase UUID가 바뀌었거나 classCode 표기가 달라져 merge가 실패한 경우에도,
    // 같은 출석번호의 로컬 실명 매핑은 OCR 후보로 사용할 수 있게 보강한다.
    const expected = expectedNumbers;
    (localMappings || []).forEach((m) => {
      const sn = parseInt(String(m?.studentNumber ?? ''), 10);
      if (!expected.has(sn)) return;
      addCandidate(sn, m?.realName ?? m?.name ?? m?.displayName ?? m?.studentName);
    });

    out.sort((a, b) => a.number - b.number);
    return out;
  }, [localMappings, classStudents, classCode, expectedNumbers]);

  const resolveDivisor = () => {
    if (pageChoice === 'yes') return templateN;
    if (pageChoice === 'no') {
      const x = parseInt(String(customPagesInput).trim(), 10);
      if (!Number.isFinite(x) || x < 1) return null;
      return x;
    }
    return null;
  };

  const validateDivisor = (x) => {
    if (!x || x < 1) {
      setPageStepError('한 학생당 페이지 수는 1 이상의 정수여야 합니다.');
      return false;
    }
    if (pdfPageCount == null) {
      setPageStepError('PDF 페이지 수를 확인할 수 없습니다.');
      return false;
    }
    if (pdfPageCount % x !== 0) {
      setPageStepError(`업로드한 스캔본의 페이지 수는 ${x}의 배수여야 합니다.`);
      return false;
    }
    setPageStepError('');
    return true;
  };

  const goToLayoutPage = () => {
    const x = resolveDivisor();
    if (pageChoice == null) {
      setPageStepError('「예」또는「아니오」를 선택해 주세요.');
      return;
    }
    if (!validateDivisor(x)) return;
    if (!pdfFile || !selectedExam) return;
    setEffectiveN(x);
    navigate('/scan-organize/layout', {
      state: {
        pdfFile,
        selectedExam,
        effectiveN: x,
        items: makeSlotItems(x),
      },
    });
  };

  const runProcess = async () => {
    if (!pdfFile || !selectedExam || !effectiveN || !items.length) return;
    setProcessLoading(true);
    setError('');
    setWarnings([]);
    setOcrBoxesUsed(null);
    try {
      const fd = new FormData();
      fd.append('file', pdfFile);
      fd.append('n', String(effectiveN));
      fd.append(
        'slots',
        JSON.stringify(items.map((it) => ({ physicalIndex: it.physicalIndex, rotation: it.rotation })))
      );
      fd.append('template_json', JSON.stringify(await buildTemplatePayload()));
      fd.append('gemini_api_key', (teacherProfile?.geminiApiKey || '').trim());
      // 명단 후보 — 실명·출석번호. 환각 방지용으로 Gemini 프롬프트에 끼워 넣음.
      // (이름 칸 이미지 자체가 어차피 Gemini에 전송되므로 추가 노출 면적은 사실상 동일)
      if (rosterForOcr.length > 0) {
        fd.append('roster_json', JSON.stringify(rosterForOcr));
      }
      const res = await fetch(backendUrl('/api/scan-organize/process'), { method: 'POST', body: fd });
      const buf = await res.arrayBuffer();
      const ct = res.headers.get('content-type') || '';
      if (!res.ok) {
        let msg = res.statusText;
        try {
          const errJson = JSON.parse(new TextDecoder().decode(buf));
          msg = errJson.detail || errJson.error || msg;
        } catch {
          const t = new TextDecoder().decode(buf.slice(0, 400));
          if (t) msg = t;
        }
        throw new Error(msg);
      }
      const { data, pdfBytes } = parseScanOrganizeProcessBody(buf, ct);
      const pdfU8 =
        pdfBytes && pdfBytes.byteLength > 0
          ? pdfBytes
          : uint8FromProcessedPdfBase64(data.processedPdfBase64);
      setProcessedPdfBytes(pdfU8 && pdfU8.byteLength > 0 ? pdfU8 : null);
      setStudents(Array.isArray(data.students) ? data.students : []);
      setExamMeta(data.examMeta || null);
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setOcrBoxesUsed(data.ocrBoxesUsed || null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setProcessLoading(false);
    }
  };

  const updateStudentField = (blockIndex, field, value) => {
    setStudents((prev) =>
      prev.map((s) => (s.blockIndex === blockIndex ? { ...s, [field]: value } : s))
    );
  };

  const recalcTotals = (results) => {
    const rows = Array.isArray(results) ? results : [];
    return {
      totalCount: rows.length,
      totalCorrect: rows.filter((r) => r.correct === true).length,
    };
  };

  const toggleStudentResult = (blockIndex, problemNumber) => {
    setStudents((prev) =>
      prev.map((s) => {
        if (s.blockIndex !== blockIndex) return s;
        const results = (s.results || []).map((r) => {
          if (r.problemNumber !== problemNumber) return r;
          if (r.correct == null) return { ...r, correct: true, gradeUnknown: false };
          return { ...r, correct: !r.correct, gradeUnknown: false };
        });
        return { ...s, results, ...recalcTotals(results) };
      })
    );
  };

  const studentsSortedByAttendance = useMemo(
    () => sortStudentsByAttendance(students),
    [students],
  );

  const sortedBlockOrder = useMemo(
    () => studentsSortedByAttendance.map((s) => s.blockIndex),
    [studentsSortedByAttendance],
  );

  const downloadProcessed = () => {
    if (!processedPdfBytes || !processedPdfBytes.byteLength) return;
    const blob = new Blob([processedPdfBytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scanned_sorted_${Date.now()}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const downloadSortedByNumber = async () => {
    if (!processedPdfBytes || !processedPdfBytes.byteLength || !effectiveN) return;
    const blob = new Blob([processedPdfBytes], { type: 'application/pdf' });
    const fd = new FormData();
    fd.append('file', blob, 'in.pdf');
    fd.append('n', String(effectiveN));
    fd.append('block_order', JSON.stringify(sortedBlockOrder));
    const res = await fetch(backendUrl('/api/scan-organize/build-sorted-pdf'), { method: 'POST', body: fd });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || res.statusText);
    }
    const out = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = `scanned_by_number_${Date.now()}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const studentsNotSavable = useMemo(
    () =>
      students
        .map((s) => ({ s, reason: studentFirestoreSkipReason(s) }))
        .filter((x) => x.reason),
    [students],
  );

  const saveToFirestore = async () => {
    if (firestoreSaving) return;
    if (!classCode || !examMeta) {
      setSaveMsg('학급 코드 또는 시험 정보가 없습니다.');
      return;
    }
    setFirestoreSaving(true);
    setSaveMsg('저장 중…');
    try {
      let ok = 0;
      const skipped = [];
    for (const st of students) {
      const skipReason = studentFirestoreSkipReason(st);
      if (skipReason) {
        skipped.push(`${formatStudentRowLabel(st)}: ${skipReason}`);
        continue;
      }
      const sn = parseInt(String(st.studentNumber ?? ''), 10);
      try {
        const uuid = await getStudentUuidByClassAndStudentNumber(classCode, sn);
        if (!uuid) {
          skipped.push(`${formatStudentRowLabel(st)}: Firebase에 ${sn}번 학생 없음`);
          continue;
        }
        const maxScore = Number(examMaxScore);
        const manualRaw = st.manualScore;
        const manualScore =
          manualRaw === '' || manualRaw === undefined || manualRaw === null
            ? null
            : (() => {
                const m = typeof manualRaw === 'number' ? manualRaw : parseFloat(String(manualRaw));
                return Number.isFinite(m) && m >= 0 ? m : null;
              })();

        const entry = {
          examName: examMeta.examName || selectedExam?.exam_name || '',
          grade: examMeta.grade || '',
          semester: examMeta.semester || '',
          unit: examMeta.unit || '',
          studentNumber: sn,
          results: (st.results || []).map((r) => ({
            problemNumber: r.problemNumber,
            correct: !!r.correct,
          })),
          totalCorrect: st.totalCorrect ?? 0,
          totalCount: st.totalCount ?? 0,
          scoredAt: new Date().toISOString(),
          ...(manualScore !== null ? { manualScore, maxScore: Number.isFinite(maxScore) && maxScore > 0 ? maxScore : 100 } : {}),
        };
        await appendStudentExamResult(uuid, entry);
        ok += 1;
      } catch (e) {
        console.error(e);
        skipped.push(`${formatStudentRowLabel(st)}: 저장 오류`);
      }
    }
    const skip = skipped.length;
    let msg = `저장 완료: ${ok}명 반영${skip ? `, 건너뜀 ${skip}건` : ''}`;
    if (skipped.length) {
      msg += ` — ${skipped.slice(0, 4).join(' · ')}${skipped.length > 4 ? ' …' : ''}`;
    }
    setSaveMsg(msg);
    } finally {
      setFirestoreSaving(false);
    }
  };

  const ocrNumbers = useMemo(() => {
    const nums = students
      .map((s) => parseInt(String(s.studentNumber ?? ''), 10))
      .filter((x) => Number.isFinite(x) && x > 0);
    return new Set(nums);
  }, [students]);

  const missingExpected = useMemo(() => {
    const miss = [];
    expectedNumbers.forEach((num) => {
      if (!ocrNumbers.has(num)) miss.push(num);
    });
    return miss.sort((a, b) => a - b);
  }, [expectedNumbers, ocrNumbers]);

  const examPaperChoices = useMemo(
    () =>
      examPaperEntries.map((entry) => ({
        entry,
        template: findTemplateForLibraryEntry(entry, templates),
      })),
    [examPaperEntries, templates]
  );

  const unlinkedExamPaperCount = examPaperChoices.filter((choice) => !choice.template).length;

  const divisorPreview = pageChoice === 'yes' ? templateN : pageChoice === 'no' ? parseInt(String(customPagesInput).trim(), 10) || null : null;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/teacher')}>
            ← 교사 대시보드
          </button>
          <span style={{ fontSize: 26 }}>📄</span>
          <div>
            <h1 className="header-title">스캔본 자동 정리</h1>
            <p className="header-subtitle">스캔본 업로드 · 시험지 선택 · 순서·회전 · OCR · markBox 채점 · 출석번호순 PDF</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge" style={{ background: '#eef2ff', color: '#4338ca' }}>교사</span>
          <span className="user-name">{teacherUser?.email || ''}</span>
        </div>
      </header>

      <main className="dashboard-main" style={{ maxWidth: 960 }}>
        {!classCode && (
          <div className="alert alert-error" style={{ marginBottom: 16 }}>
            학급이 선택되지 않았습니다. 교사 대시보드에서 학급을 연 뒤 다시 시도하세요.
          </div>
        )}

        {error && (
          <div className="alert alert-error" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}

        {warnings.length > 0 && (
          <div className="alert" style={{ marginBottom: 12, background: '#fffbeb', borderColor: '#fcd34d' }}>
            {warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}

        <ol style={{ color: '#4b5563', marginBottom: 20, lineHeight: 1.7 }}>
          <li>스캔본 업로드</li>
          <li>시험지 업로드에 등록한 시험지 선택</li>
          <li>페이지 수(n) 확인</li>
          <li>
            별도 화면(<strong>/scan-organize/layout</strong>)에서 썸네일 순서·회전 편집
          </li>
          <li>이름·출석번호 OCR 및 markBox(채점 네모) 빨간색연필 diff</li>
          <li>수정 후 출석번호순 PDF 다운로드 및 Firestore 저장</li>
        </ol>

        <HudFrame style={{ marginBottom: 16 }}>
          <h2 className="section-title">1. 스캔본 업로드</h2>
          <p style={{ fontSize: 13, color: '#64748b', marginTop: -4, marginBottom: 10 }}>
            학생들이 시험 보고 교사가 채점한 시험지
          </p>
          <input
            type="file"
            accept="application/pdf"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setPdfFile(f || null);
              setPdfPageCount(null);
              setPageChoice(null);
              setCustomPagesInput('');
              setPageStepError('');
              setLayoutDone(false);
              setEffectiveN(null);
              setItems([]);
              if (f) {
                try {
                  const c = await getPdfPageCount(f);
                  setPdfPageCount(c);
                } catch (err) {
                  setError('스캔본 페이지 수 읽기 실패');
                }
              }
            }}
          />
          {pdfPageCount != null && (
            <p style={{ marginTop: 8 }}>
              업로드 스캔본: <strong>{pdfPageCount}</strong>페이지
            </p>
          )}
          {pdfFile && !selectedExam ? (
            <div
              className="alert"
              style={{
                marginTop: 10,
                background: '#fffbeb',
                borderColor: '#fde68a',
                color: '#92400e',
              }}
            >
              시험지 템플릿을 먼저 선택해 주세요. 템플릿이 있어야 문항 영역·등록(정렬)·채점이 정확히 연결됩니다.
            </div>
          ) : null}
        </HudFrame>

        <HudFrame style={{ marginBottom: 16 }}>
          <div className="section-header">
            <h2 className="section-title">2. 시험지 선택</h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => refreshExamPapers()}
                disabled={examPaperLoading}
              >
                {examPaperLoading ? '불러오는 중…' : '새로고침'}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => navigate('/exam-papers')}
              >
                시험지 업로드로 이동 →
              </button>
            </div>
          </div>
          <p style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
            「시험지 업로드」에 등록해 둔 시험지 중에서 골라 사용합니다. 선택한 시험지와 저장된 문항 영역 정보가 연결되어야 채점이 가능합니다.
          </p>

          {examPaperLoading ? (
            <p style={{ color: '#64748b', margin: 0 }}>
              <span className="spinner" /> 등록된 시험지를 불러오는 중…
            </p>
          ) : examPaperEntries.length === 0 ? (
            <div
              className="alert"
              style={{
                background: '#fef9c3',
                border: '1px solid #fde047',
                color: '#854d0e',
                margin: 0,
              }}
            >
              아직 등록된 시험지가 없습니다. 먼저 「시험지 업로드」에서 시험지 PDF를 추가해 주세요.
            </div>
          ) : (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 12,
                  alignItems: 'center',
                }}
              >
                <select
                  className="form-input"
                  style={{ minWidth: 320, maxWidth: '100%' }}
                  value={selectedExamPaperId}
                  aria-label="등록된 시험지에서 선택"
                  onChange={(e) => {
                    const id = e.target.value;
                    const choice = examPaperChoices.find((x) => x.entry.id === id);
                    setSelectedExamPaperId(id);
                    setSelectedExam(choice?.template || null);
                    setPageChoice(null);
                    setCustomPagesInput('');
                    setPageStepError('');
                    setLayoutDone(false);
                    setEffectiveN(null);
                    setItems([]);
                    if (id && !choice?.template) {
                      const fn = choice.entry.originalFileName || '(파일명 없음)';
                      const savedPdfNames = [
                        ...new Set(
                          templates.map((t) => String(t.pdf_name || '').trim()).filter(Boolean),
                        ),
                      ].slice(0, 4);
                      const nameHint =
                        savedPdfNames.length > 0
                          ? ` 현재 저장된 PDF 파일명: ${savedPdfNames.join(' · ')}`
                          : templates.length === 0
                            ? ' (서버에서 좌표 목록을 불러오지 못했습니다. 백엔드 start.bat 실행 후 새로고침)'
                            : ' (저장된 좌표가 없습니다 — 영역 수동 선택에서 💾 좌표 저장)';
                      setPageStepError(
                        `「${fn}」과(와) 연결된 문항 영역이 없습니다. 영역 수동 선택에서 같은 PDF로 저장해 주세요.${nameHint}`,
                      );
                    }
                  }}
                >
                  <option value="">— 시험지를 선택해 주세요 —</option>
                  {examPaperChoices.map(({ entry, template }) => {
                    const meta = [entry.grade, entry.semester, entry.unit].filter(Boolean).join(' · ');
                    const tail = template
                      ? ` · 시험 ${template.total_pages}쪽 · 문항영역 ${template.regions?.length || 0}개`
                      : ' · 영역 정보 없음';
                    return (
                      <option key={entry.id} value={entry.id} disabled={!template}>
                        {entry.label}
                        {meta ? ` (${meta})` : ''}
                        {tail}
                      </option>
                    );
                  })}
                </select>
                {(() => {
                  const picked = examPaperChoices.find((x) => x.entry.id === selectedExamPaperId);
                  if (!picked) return null;
                  return (
                    <span style={{ fontSize: 14, color: '#64748b' }}>
                      현재 선택: <strong>{picked.entry.label}</strong>
                    </span>
                  );
                })()}
              </div>

              {unlinkedExamPaperCount > 0 ? (
                <div
                  style={{
                    marginTop: 10,
                    background: '#fffbeb',
                    border: '1px solid #fde68a',
                    borderRadius: 10,
                    padding: '10px 14px',
                    fontSize: 12,
                    color: '#92400e',
                    lineHeight: 1.5,
                  }}
                >
                  영역 정보가 없는 업로드 시험지 <strong>{unlinkedExamPaperCount}건</strong>은 선택할 수 없습니다.{' '}
                  「PDF 영역 수동 선택」에서 <strong>시험지 업로드와 같은 PDF 파일</strong>로 💾 좌표 저장하면 연결됩니다.
                  {templates.length === 0 ? (
                    <span style={{ display: 'block', marginTop: 6, color: '#b45309' }}>
                      ⚠ 좌표 목록 API 오류 가능 — 백엔드가 켜져 있는지 확인한 뒤 이 페이지를 새로고침하세요.
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          )}

          {selectedExam && (() => {
            const hasNameSpec = !!savedSpecs?.nameSpec;
            const hasNumberSpec = !!savedSpecs?.attendanceSpec;
            const hasNameRegion = !!selectedExam.name_region;
            const hasNumberRegion = !!selectedExam.student_number_region;
            const nameOk = hasNameSpec || hasNameRegion;
            const numberOk = hasNumberSpec || hasNumberRegion;
            const regionsCount = selectedExam.regions?.length || 0;
            const regionsOk = regionsCount > 0;
            const allOk = nameOk && numberOk && regionsOk;

            const nameSource = hasNameSpec
              ? '학생별 시험지 인쇄에서 저장됨'
              : hasNameRegion
              ? 'PDF 영역 수동 선택에서 저장됨'
              : '저장된 좌표 없음 — 기본 좌상단 박스를 사용합니다';
            const numberSource = hasNumberSpec
              ? '학생별 시험지 인쇄에서 저장됨'
              : hasNumberRegion
              ? 'PDF 영역 수동 선택에서 저장됨'
              : '저장된 좌표 없음 — 기본 좌상단 박스를 사용합니다';
            const regionsSource = regionsOk
              ? `${regionsCount}개 영역 저장됨`
              : '저장된 영역 없음 — PDF 영역 수동 선택에서 영역을 먼저 저장해 주세요';

            const Mark = ({ ok }) => (
              <span
                style={{
                  display: 'inline-block',
                  minWidth: 24,
                  textAlign: 'center',
                  fontWeight: 700,
                  fontSize: 13,
                  color: ok ? '#15803d' : '#b91c1c',
                  background: ok ? '#dcfce7' : '#fee2e2',
                  border: `1px solid ${ok ? '#86efac' : '#fecaca'}`,
                  borderRadius: 6,
                  padding: '1px 6px',
                  marginRight: 8,
                }}
              >
                {ok ? 'O' : 'X'}
              </span>
            );

            return (
              <div
                style={{
                  marginTop: 12,
                  background: allOk ? '#f0fdf4' : '#fffbeb',
                  border: `1px solid ${allOk ? '#bbf7d0' : '#fde68a'}`,
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontSize: 13,
                  color: '#475569',
                  lineHeight: 1.55,
                }}
              >
                <div style={{ marginBottom: 6 }}>
                  <strong style={{ color: '#1e293b' }}>{selectedExam.exam_name || '제목 없음'}</strong>
                  <span style={{ marginLeft: 8, color: '#94a3b8' }}>
                    {selectedExam.grade || '학년-'} · {selectedExam.semester || '학기-'} ·{' '}
                    {selectedExam.unit || '단원-'} · 시험 {selectedExam.total_pages}쪽
                  </span>
                </div>

                {savedSpecs?.specsScope === 'legacyFallback' ? (
                  <div
                    style={{
                      marginBottom: 8,
                      padding: '8px 10px',
                      background: '#eff6ff',
                      border: '1px solid #bfdbfe',
                      borderRadius: 8,
                      fontSize: 12,
                      color: '#1e40af',
                      lineHeight: 1.5,
                    }}
                  >
                    이 시험지 파일명(<strong>{selectedExam.pdf_name || '—'}</strong>)으로 저장된 칸 좌표가 없어,
                    예전에 저장된 전역 좌표를 임시로 불러왔습니다. 다른 시험지에서 찍은 좌표가 섞이면 OCR이 엉뚱한 곳을
                    잘라 볼 수 있으니, 「학생별 시험지 인쇄」에서 <strong>이 PDF</strong>를 연 뒤 이름·번호 칸을 다시 찍고
                    저장한 다음 여기서 새로고침하세요.
                  </div>
                ) : null}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Mark ok={nameOk} />
                    <span style={{ minWidth: 110, fontWeight: 600 }}>이름 좌표</span>
                    <span style={{ color: '#64748b' }}>{nameSource}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Mark ok={numberOk} />
                    <span style={{ minWidth: 110, fontWeight: 600 }}>출석번호 좌표</span>
                    <span style={{ color: '#64748b' }}>{numberSource}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                    <Mark ok={regionsOk} />
                    <span style={{ minWidth: 110, fontWeight: 600 }}>문항 영역 좌표</span>
                    <span style={{ color: '#64748b' }}>{regionsSource}</span>
                  </div>
                </div>

                {!allOk ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#92400e' }}>
                    X 표시된 항목은 좌표 저장 후 위 「새로고침」을 눌러 다시 확인해 주세요.
                  </div>
                ) : null}
              </div>
            );
          })()}
        </HudFrame>

        {selectedExam && pdfPageCount != null && templateN > 0 && (
          <HudFrame style={{ marginBottom: 16 }}>
            <h2 className="section-title">3. 페이지 수 확인</h2>
            <p>
              선택한 시험지 기준 한 학생당 <strong>{templateN}</strong>쪽입니다. 업로드한 스캔본의 페이지 수는{' '}
              <strong>{templateN}의 배수여야 합니다</strong>.
            </p>
            {pdfPageCount % templateN !== 0 && pageChoice !== 'no' && (
              <p style={{ color: '#b45309', fontSize: 14 }}>
                현재 {pdfPageCount}페이지는 {templateN}의 배수가 아닙니다. 선택한 시험지와 다른 쪽수라면「아니오」에서 한 학생당
                페이지 수를 직접 입력해 주세요.
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              <button
                type="button"
                className={`btn ${pageChoice === 'yes' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => {
                  setPageChoice('yes');
                  setCustomPagesInput(String(templateN));
                  setPageStepError('');
                }}
              >
                예
              </button>
              <button
                type="button"
                className={`btn ${pageChoice === 'no' ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => {
                  setPageChoice('no');
                  setCustomPagesInput(pageChoice === 'no' ? customPagesInput : String(templateN));
                  setPageStepError('');
                }}
              >
                아니오
              </button>
            </div>

            {pageChoice === 'no' && (
              <div style={{ marginTop: 16 }}>
                <label style={{ display: 'block', fontSize: 14, marginBottom: 6 }}>
                  한 학생당 페이지 수 (정수)
                </label>
                <input
                  type="number"
                  className="input"
                  min={1}
                  style={{ maxWidth: 200, padding: 8 }}
                  value={customPagesInput}
                  onChange={(e) => {
                    setCustomPagesInput(e.target.value);
                    setPageStepError('');
                  }}
                />
              </div>
            )}

            {pageStepError && (
              <div className="alert alert-error" style={{ marginTop: 12 }}>
                {pageStepError}
              </div>
            )}

            {divisorPreview != null && pdfPageCount % divisorPreview === 0 && (
              <p style={{ marginTop: 10, fontSize: 14, color: '#15803d' }}>
                {`현재 설정(학생당 ${divisorPreview}쪽)은 업로드 스캔본 ${pdfPageCount}페이지와 맞습니다.`}
              </p>
            )}

            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!pdfFile || pageChoice == null}
                onClick={goToLayoutPage}
              >
                페이지 순서·회전 편집으로 이동
              </button>
              <button type="button" className="btn btn-outline" style={{ marginLeft: 8 }} onClick={resetFlow}>
                처음부터
              </button>
            </div>
          </HudFrame>
        )}

        {layoutDone && pdfFile && selectedExam && effectiveN > 0 && items.length === effectiveN && (
          <HudFrame style={{ marginBottom: 16 }}>
            <h2 className="section-title">4. 채점 실행</h2>
            <p style={{ color: '#6b7280', marginBottom: 12 }}>
              순서·회전 편집이 끝났습니다. 한 학생당 <strong>{effectiveN}</strong>쪽 기준으로 OCR·markBox 채점을 실행합니다.
            </p>

            <div
              style={{
                background: '#f0f9ff',
                border: '1px solid #bae6fd',
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 13,
                color: '#075985',
                marginBottom: 12,
                lineHeight: 1.5,
              }}
            >
              <div>
                <strong>학급 명단 OCR 후보:</strong>{' '}
                {rosterForOcr.length > 0
                  ? `${rosterForOcr.length}명 (Gemini가 이 안에서만 이름을 고릅니다)`
                  : '명단 정보가 없어 자유롭게 인식합니다 — 환각 가능성 있음. 교사 대시보드에서 학생 실명을 등록해 주세요.'}
              </div>
              {rosterForOcr.length > 0 ? (
                <details style={{ marginTop: 4 }}>
                  <summary style={{ cursor: 'pointer' }}>명단 미리 보기</summary>
                  <div style={{ marginTop: 4 }}>
                    {rosterForOcr.map((r) => `${r.number}번 ${r.name}`).join(' · ')}
                  </div>
                </details>
              ) : null}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <button
                type="button"
                className="btn btn-outline"
                disabled={cropPreviewLoading || processLoading}
                onClick={() => runCropPreview(gradeCropPreview?.blockIndex ?? 0)}
              >
                {cropPreviewLoading ? '크롭 생성 중…' : '채점 크롭만 미리보기 (API 없음·무료)'}
              </button>
              <button type="button" className="btn btn-primary" disabled={processLoading || cropPreviewLoading} onClick={runProcess}>
                {processLoading
                  ? '처리 중… (AI 이후 PDF 합성·전송 — 스캔이 크면 여기서 시간이 걸립니다)'
                  : '전체 적용 · OCR · markBox 채점'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => navigate('/scan-organize/layout', { state: { pdfFile, selectedExam, effectiveN, items } })}
              >
                순서·회전 다시 편집
              </button>
            </div>
            <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 4px' }}>
              크롭이 번호·빨간 표시를 제대로 담는지 확인한 뒤 「전체 적용」을 누르세요. 미리보기는 로컬 PyMuPDF만 사용합니다.
            </p>

            <GradeCropPreviewPanel
              preview={gradeCropPreview}
              loading={cropPreviewLoading}
              onSelectBlock={gradeCropPreview?.nBlocks > 1 ? runCropPreview : null}
            />
          </HudFrame>
        )}

        {students.length > 0 && (
          <HudFrame style={{ marginBottom: 16 }}>
            <h2 className="section-title">5. 인식 결과 · 수동 수정</h2>
            {ocrBoxesUsed ? (() => {
              const isDefaultName = ocrBoxesUsed.nameSource === 'default';
              const isDefaultNumber = ocrBoxesUsed.numberSource === 'default';
              const anyDefault = isDefaultName || isDefaultNumber;
              const ocrMode = ocrBoxesUsed.nameOcrMode || 'header';
              const headerFrac = ocrBoxesUsed.headerFraction;
              return (
                <div
                  style={{
                    background: anyDefault ? '#fffbeb' : '#f8fafc',
                    border: `1px solid ${anyDefault ? '#fde68a' : '#e2e8f0'}`,
                    borderRadius: 8,
                    padding: '10px 12px',
                    fontSize: 12,
                    color: '#475569',
                    marginBottom: 10,
                    lineHeight: 1.55,
                  }}
                >
                  {ocrMode === 'crop_then_header' ? (
                    <div style={{ marginBottom: 8 }}>
                      <strong>이름·출석번호 OCR</strong>: 저장된 이름·번호 박스로 <strong>crop 우선</strong>
                      (인쇄 글자·손글씨). 번호를 못 읽으면 상단 약{' '}
                      <strong>{headerFrac != null ? Math.round(headerFrac * 100) : 26}%</strong> 띠로 다시 시도합니다.
                    </div>
                  ) : ocrMode === 'header' && headerFrac != null ? (
                    <div style={{ marginBottom: 8 }}>
                      <strong>이름·출석번호 OCR</strong>: 페이지 맨 위부터 높이 약{' '}
                      <strong>{Math.round(headerFrac * 100)}%</strong>를 잘라 한 장으로 Gemini에 보냅니다. (
                      <code>SCAN_ORGANIZE_NAME_OCR_MODE=header</code>)
                    </div>
                  ) : (
                    <div style={{ marginBottom: 8 }}>
                      <strong>이름·출석번호 OCR</strong>: 저장된 좌표로 이름·번호 칸을 각각 잘라 두 장으로 보냅니다. (
                      <code>SCAN_ORGANIZE_NAME_OCR_MODE=crop</code>)
                    </div>
                  )}
                  <div>
                    <strong>좌표 기준(참고·힌트용)</strong> 이름 — <code>{ocrBoxesUsed.nameSource || 'unknown'}</code>
                    {ocrBoxesUsed.nameBox
                      ? ` (x=${ocrBoxesUsed.nameBox.x.toFixed(3)}, y=${ocrBoxesUsed.nameBox.y.toFixed(3)}, w=${ocrBoxesUsed.nameBox.w.toFixed(3)}, h=${ocrBoxesUsed.nameBox.h.toFixed(3)})`
                      : ''}
                  </div>
                  <div>
                    출석번호 — <code>{ocrBoxesUsed.numberSource || 'unknown'}</code>
                    {ocrBoxesUsed.numberBox
                      ? ` (x=${ocrBoxesUsed.numberBox.x.toFixed(3)}, y=${ocrBoxesUsed.numberBox.y.toFixed(3)}, w=${ocrBoxesUsed.numberBox.w.toFixed(3)}, h=${ocrBoxesUsed.numberBox.h.toFixed(3)})`
                      : ''}
                  </div>
                  {ocrBoxesUsed.rosterCount != null ? (
                    <div>명단 후보: <strong>{ocrBoxesUsed.rosterCount}명</strong></div>
                  ) : null}

                  {ocrBoxesUsed.firstBlockHeaderCropBase64 ? (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>
                        1번 블록 · AI에 넣은 머리글(상단) 이미지
                      </div>
                      <img
                        src={`data:image/png;base64,${ocrBoxesUsed.firstBlockHeaderCropBase64}`}
                        alt="OCR 머리글 영역"
                        style={{ maxWidth: '100%', maxHeight: 140, border: '1px solid #cbd5e1', background: '#fff' }}
                      />
                    </div>
                  ) : null}

                  {(ocrBoxesUsed.firstBlockNameCropBase64 || ocrBoxesUsed.firstBlockNumberCropBase64) ? (
                    <div style={{ marginTop: 8, display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      {ocrBoxesUsed.firstBlockNameCropBase64 ? (
                        <div>
                          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>1번 블록 · 이름 칸만 크롭</div>
                          <img
                            src={`data:image/png;base64,${ocrBoxesUsed.firstBlockNameCropBase64}`}
                            alt="이름 칸만"
                            style={{ maxHeight: 80, border: '1px solid #cbd5e1', background: '#fff' }}
                          />
                        </div>
                      ) : null}
                      {ocrBoxesUsed.firstBlockNumberCropBase64 ? (
                        <div>
                          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>1번 블록 · 출석번호 칸만 크롭</div>
                          <img
                            src={`data:image/png;base64,${ocrBoxesUsed.firstBlockNumberCropBase64}`}
                            alt="출석번호 칸만"
                            style={{ maxHeight: 80, border: '1px solid #cbd5e1', background: '#fff' }}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {ocrBoxesUsed.gradeCropMode != null ? (
                    <div style={{ marginTop: 8 }}>
                      <strong>문항 O/X 채점</strong>:{' '}
                      <strong>채점 네모(markBox)</strong> — 빈 시험지와 비교해{' '}
                      <strong>빨간 색연필 채움</strong>이 있으면 틀림 (Gemini·API 사용 안 함)
                      {ocrBoxesUsed.gradeEngine === 'markbox_red_diff' ? null : (
                        <> · 엔진: {ocrBoxesUsed.gradeEngine || 'markbox_red_diff'}</>
                      )}
                    </div>
                  ) : null}

                  {Array.isArray(ocrBoxesUsed.firstBlockGradeCrops) &&
                  ocrBoxesUsed.firstBlockGradeCrops.length > 0 ? (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6 }}>
                        1번 블록 · markBox 채점 크롭 미리보기 (문항별)
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 8,
                          maxHeight: 320,
                          overflowY: 'auto',
                          padding: 4,
                          background: '#fff',
                          border: '1px solid #e2e8f0',
                          borderRadius: 6,
                        }}
                      >
                        {ocrBoxesUsed.firstBlockGradeCrops.map((item) => (
                          <div
                            key={`gc-${item.page}-${item.problemNumber}`}
                            style={{ textAlign: 'center', fontSize: 10, color: '#64748b' }}
                          >
                            <div style={{ marginBottom: 2 }}>
                              {item.page > 1 ? `${item.page}쪽 ` : ''}
                              {item.problemNumber}번
                            </div>
                            <img
                              src={`data:image/png;base64,${item.cropBase64}`}
                              alt={`${item.problemNumber}번 채점 크롭`}
                              style={{
                                maxHeight: 72,
                                maxWidth: 120,
                                border: '1px solid #cbd5e1',
                                background: '#fff',
                                display: 'block',
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {anyDefault ? (
                    <div style={{ marginTop: 8, color: '#92400e' }}>
                      ⚠ 저장된 이름·번호 좌표가 없어 기본 좌상단 박스를 사용했습니다. 위 크롭 이미지가 실제 이름/번호 칸이 아니라면,
                      「학생별 시험지 인쇄」에서 이름·출석번호 칸을 다시 찍고 「좌표 저장」을 누른 뒤 위 「새로고침」을 눌러 다시
                      실행해 주세요.
                    </div>
                  ) : null}
                </div>
              );
            })() : null}
            {missingExpected.length > 0 && (
              <div className="alert" style={{ background: '#fef2f2', borderColor: '#fecaca', marginBottom: 12 }}>
                <strong>결석/스캔 누락 가능:</strong> 명단에 있으나 OCR에 없는 출석번호: {missingExpected.join(', ')}
              </div>
            )}
            {studentsNotSavable.length > 0 && (
              <div className="alert" style={{ background: '#fffbeb', borderColor: '#fde68a', marginBottom: 12 }}>
                <strong>Firestore 저장 시 제외됨 ({studentsNotSavable.length}명):</strong>{' '}
                채점 O/X는 위에 보이지만 출석번호가 없거나 학급에 없으면 저장되지 않습니다. 아래 표에서
                출석번호를 직접 입력한 뒤 다시 저장하세요.
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {studentsNotSavable.map(({ s, reason }) => (
                    <li key={s.blockIndex}>
                      {formatStudentRowLabel(s)} — {reason}
                      {s.ocrError ? ` (OCR: ${s.ocrError})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th>블록</th>
                    <th>썸네일</th>
                    <th>이름</th>
                    <th>출석번호</th>
                    <th>AI O/X</th>
                    <th>
                      시험 점수
                      <div style={{ fontWeight: 400, fontSize: 10, color: '#64748b', marginTop: 2 }}>
                        만점{' '}
                        <input
                          type="number"
                          className="input"
                          style={{ width: 48, padding: '2px 4px', fontSize: 11 }}
                          min={1}
                          value={examMaxScore}
                          onChange={(e) => {
                            const v = parseInt(String(e.target.value), 10);
                            setExamMaxScore(Number.isFinite(v) && v > 0 ? v : 100);
                          }}
                          title="수동 점수 분모 (예: 100)"
                        />
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {studentsSortedByAttendance.map((s) => (
                    <tr key={s.blockIndex}>
                      <td>{s.blockIndex + 1}</td>
                      <td>
                        {s.thumbnailBase64 ? (
                          <img src={`data:image/png;base64,${s.thumbnailBase64}`} alt="" style={{ height: 72 }} />
                        ) : (
                          '-'
                        )}
                      </td>
                      <td>
                        <input
                          className="input"
                          style={{ width: 120 }}
                          value={s.studentName || ''}
                          title={
                            s.ocrNameDiscarded
                              ? `OCR 이름(무시됨): ${s.ocrNameDiscarded}`
                              : s.ocrNameRaw && s.ocrNameRaw !== (s.studentName || '')
                                ? `OCR: ${s.ocrNameRaw}`
                                : undefined
                          }
                          onChange={(e) => updateStudentField(s.blockIndex, 'studentName', e.target.value)}
                        />
                        {(s.nameSource === 'roster' ||
                          s.nameSource === 'roster_by_name' ||
                          s.nameSource === 'ocr+roster') && (
                          <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>명단</div>
                        )}
                      </td>
                      <td>
                        <input
                          className="input"
                          style={{ width: 72 }}
                          type="number"
                          min={1}
                          value={s.studentNumber ?? ''}
                          onChange={(e) =>
                            updateStudentField(
                              s.blockIndex,
                              'studentNumber',
                              e.target.value === '' ? null : parseInt(e.target.value, 10)
                            )
                          }
                        />
                      </td>
                      <td style={{ fontSize: 12, color: '#64748b' }}>
                        {formatAiScoreDisplay(s.totalCorrect ?? 0, s.totalCount ?? 0)}
                      </td>
                      <td>
                        <input
                          className="input"
                          style={{ width: 64 }}
                          type="number"
                          min={0}
                          step={0.5}
                          placeholder="—"
                          value={s.manualScore ?? ''}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (raw === '') {
                              updateStudentField(s.blockIndex, 'manualScore', null);
                              return;
                            }
                            const m = parseFloat(raw);
                            updateStudentField(s.blockIndex, 'manualScore', Number.isFinite(m) ? m : null);
                          }}
                          title={`실제 점수 (만점 ${examMaxScore}). AI 문항 수와 다를 수 있음`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="section-title" style={{ marginTop: 20, fontSize: 16 }}>
              문항별 O/X (학생별) — 클릭하여 수정
            </h3>
            <p className="section-desc" style={{ marginTop: -8, marginBottom: 10 }}>
              AI가 틀리게 잡으면 여기서 고친 뒤 저장하세요. 시험 점수(85점 등)는 위 표에 직접 입력하면 학생 화면에
              표시됩니다. Firestore 저장은 <strong>출석번호</strong>가 있어야 합니다(이름만으로는 저장 안 됨).
            </p>
            {studentsSortedByAttendance.map((s) => (
              <div key={`d-${s.blockIndex}`} style={{ marginBottom: 12, fontSize: 13 }}>
                <strong>{formatStudentRowLabel(s)}</strong>
                <span style={{ marginLeft: 6, fontSize: 11, color: '#94a3b8' }}>
                  (스캔 {s.blockIndex + 1}번째)
                </span>
                {s.ocrError ? (
                  <span style={{ marginLeft: 6, fontSize: 11, color: '#b45309' }} title={s.ocrError}>
                    ⚠ 이름·번호 OCR 실패
                  </span>
                ) : null}
                {s.gradeFailed ? (
                  <span style={{ marginLeft: 6, fontSize: 11, color: '#b45309' }}>
                    ⚠ markBox 채점 미확정(빈 시험지 PDF·좌표 확인) — ? 를 눌러 O/X 지정
                  </span>
                ) : null}
                {s.manualScore != null && s.manualScore !== '' ? (
                  <span style={{ marginLeft: 8, color: '#4f46e5' }}>
                    기록 점수 {s.manualScore}/{examMaxScore}
                  </span>
                ) : null}{' '}
                {(s.results || []).map((r) => (
                  <button
                    key={r.problemNumber}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{
                      marginRight: 4,
                      marginTop: 4,
                      padding: '2px 8px',
                      fontSize: 12,
                      border: `1px solid ${
                        r.correct == null ? '#fde68a' : r.correct ? '#86efac' : '#fecaca'
                      }`,
                      background: r.correct == null ? '#fffbeb' : r.correct ? '#f0fdf4' : '#fef2f2',
                    }}
                    onClick={() => toggleStudentResult(s.blockIndex, r.problemNumber)}
                    title={r.correct == null ? '채점 미확정 — 클릭하여 O/X 지정' : '클릭하여 O/X 전환'}
                  >
                    {r.problemNumber}번 {r.correct == null ? '?' : r.correct ? 'O' : 'X'}
                  </button>
                ))}
              </div>
            ))}

            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className="btn btn-outline" onClick={downloadProcessed}>
                변환 PDF (스캔 순) 다운로드
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => downloadSortedByNumber().catch((e) => setError(e.message))}
              >
                출석번호순 PDF 다운로드
              </button>
              <button type="button" className="btn btn-primary" disabled={!classCode || firestoreSaving} onClick={() => saveToFirestore().catch((e) => setSaveMsg(e.message))}>
                {firestoreSaving ? '저장 중…' : '채점 결과 Firestore 저장'}
              </button>
            </div>
            {saveMsg && <p style={{ marginTop: 8 }}>{saveMsg}</p>}
            <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 8 }}>
              Firestore에는 examName·학년·학기·단원·출석번호·문항별 correct·AI 맞은 수·시험 점수(입력 시)·시각이
              저장됩니다 (이름 미저장). 학생은 오답노트 화면에서 문항 O/X를 직접 고칠 수 있습니다.
            </p>
          </HudFrame>
        )}
      </main>
    </div>
  );
}
