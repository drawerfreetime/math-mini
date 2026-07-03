/**
 * UnitTestReview.js — 단원평가 20문항 검수 · 편집 · 저장 (교사 전용)
 *
 * 기능:
 *   - 문항 카드 인라인 편집 (문제, 선지, 보기, 정답)
 *   - 카드 드래그로 순서 변경
 *   - 번호 자동 재정렬 버튼
 *   - 완료 → Firebase 저장
 */
import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { collection, addDoc, doc, setDoc, getDoc, getDocs, deleteDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from '../contexts/AuthContext';
import {
  mergeSolutionAreaIntoQuestion,
  prepareProblemForSolutionEdit,
} from '../utils/examSolutionArea';
import { firebaseExamQuestionsToReviewProblems } from '../utils/examToReview';
import {
  circledDigitsToMcNumber,
  normalizeProblemsCircledMcAnswers,
  stripLeadingCircledFromChoiceText,
} from '../utils/circledAnswer';
import { getExamQuestions } from '../firebase/firestoreOps';
import { elementaryScriptToLatex } from '../utils/elementaryMathScript';
import {
  mathTextToHybridEditDisplay,
  hybridEditDisplayToCanonical,
  isComplexLatexForPlainTransform,
  latexToPlain,
  renderMathText,
} from './ExamOCR';
import {
  EXAM_BLANK_INNER_SPACES,
  hasExamAnswerBlankLines,
  isExamLongBlankBracket,
  normalizeExamQuestionText,
} from '../utils/examBlankBrackets';
import PrecisionReviewChat from './PrecisionReviewChat';
import { mergePrecisionReviewIntoProblem } from '../api/precisionReview';
import { createFrozenMathElement } from '../utils/inlineMathStorage';
import ContentEditableMathField from './ContentEditableMathField';
import ReviewMathToolsSidebar from './ReviewMathToolsSidebar';
import HudFrame from './HudFrame';
import {
  parseTableSegments,
  flattenTableSegmentToPlain,
  segmentsToText,
} from '../utils/markdownTableSegments';
import {
  defaultMatchingLabel,
  resolveMatchingSide,
} from '../utils/matchingItems';

const CHOICE_LABELS = ['①', '②', '③', '④', '⑤', '⑥'];
const UTR_MC_ANSWER_MAX = 3;

function parseChoiceNums(answerStr) {
  return String(answerStr || '')
    .split(/[,，\s]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function utrParseMcAnswerNums(ans) {
  return String(ans || '')
    .split(/[,，\s]+/)
    .map((s) => {
      const trimmed = s.trim();
      if (!trimmed) return null;
      const n = circledDigitsToMcNumber(trimmed);
      return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? n : null;
    })
    .filter((n) => n != null);
}

function formatMcAnswer(nums) {
  if (!nums?.length) return null;
  return [...nums].sort((a, b) => a - b).join(', ');
}

function utrNormalizeMcAnswer(ans, choices) {
  if (ans == null || ans === '') return null;
  if (choices?.length) return formatMcAnswer(utrParseMcAnswerNums(ans));
  return ans;
}

function isMcAnswerEmpty(answer) {
  return answer == null || answer === '' || parseChoiceNums(answer).length === 0;
}

function isProblemAnswerEmpty(problem) {
  if (problem.answer == null || problem.answer === '') return true;
  if (problem.choices?.length) return parseChoiceNums(problem.answer).length === 0;
  return false;
}

const UTR_PROBLEM_TA_LINE_PX = 24;
const UTR_PROBLEM_TA_MIN_LINES = 3;
const UTR_PROBLEM_TA_MAX_LINES = 7;

function syncProblemBodyTextareaSize(textareaEl) {
  if (!textareaEl || textareaEl.tagName !== 'TEXTAREA') return;
  textareaEl.style.height = 'auto';
  const lineHeight = UTR_PROBLEM_TA_LINE_PX;
  const minHeight = lineHeight * UTR_PROBLEM_TA_MIN_LINES;
  const maxHeight = lineHeight * UTR_PROBLEM_TA_MAX_LINES;
  const sh = textareaEl.scrollHeight;
  const newHeight = Math.min(sh, maxHeight);
  textareaEl.style.height = Math.max(newHeight, minHeight) + 'px';
  textareaEl.style.overflowY = sh > maxHeight ? 'auto' : 'hidden';
}

/** 「문제」 본문: 빈 상태 3줄, 내용 따라 최대 7줄까지 확장, 초과분만 세로 스크롤 */
function AutoGrowProblemTextarea({ value, onChange, className, placeholder, onBlur }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    syncProblemBodyTextareaSize(ref.current);
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
    />
  );
}

function clampQuestionNumber(raw) {
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(100, n);
}

/** 문항 스크롤 앵커용 HTML id (`_utrRowId` 등 안정 키 기반) */
function utrAnchorId(rowKey) {
  const s = String(rowKey ?? 'row').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `utr-q-${s}`;
}

/**
 * 왼쪽 번호 레일: 묶음은 하위 문항마다 한 칸, 단일·선잇기는 문항당 한 칸
 * @returns {{ anchorId: string, label: string }[]}
 */
function buildUtrNavTargets(problems) {
  const targets = [];
  for (const p of problems) {
    if (p.type === 'group') {
      for (const q of p.questions || []) {
        targets.push({
          anchorId: utrAnchorId(q._utrRowId),
          label: String(q.number ?? '?'),
        });
      }
    } else {
      targets.push({
        anchorId: utrAnchorId(p._utrRowId),
        label: String(p.number ?? '?'),
      });
    }
  }
  return targets;
}

function scrollToUtrAnchor(anchorId) {
  const el = document.getElementById(anchorId);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 인라인/사이드바 초등 수식 편집기 — 이 안의 입력은 삽입 대상(ref)에서 제외 */
const UTR_MATH_EDITOR_ROOT_SEL = '.emath-sidebar-root, .emath-overlay-panel';

function isInsideUtrMathEditor(el) {
  return el instanceof Element && !!el.closest(UTR_MATH_EDITOR_ROOT_SEL);
}

/**
 * 검수 우측 패널에서 마지막으로 포커스가 나간 입력란에 삽입 (React controlled textarea/input 호환).
 * @param {React.MutableRefObject<{ el: HTMLTextAreaElement | HTMLInputElement | null; start: number; end: number }>} ref
 */
function insertChunkIntoUtrFocusedField(ref, chunk, setError) {
  const { el, start, end } = ref.current;
  if (!chunk) return;
  if (!el || !document.body.contains(el)) {
    setError('먼저 문제·선지 등 입력란을 선택한 뒤 다시 눌러 주세요.');
    return;
  }
  setError('');
  const len = el.value.length;
  const s = Math.min(Math.max(0, start), len);
  const en = Math.min(Math.max(0, end), len);
  el.focus();
  el.setSelectionRange(s, en);
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, chunk);
  } catch {
    ok = false;
  }
  if (!ok) {
    const next = el.value.slice(0, s) + chunk + el.value.slice(en);
    const Proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(Proto, 'value');
    if (desc?.set) desc.set.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  ref.current = { el, start: s + chunk.length, end: s + chunk.length };
}

function ensureProblemRowId(prefix = 'p') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 리스트 카드 레이아웃 안정용 — 제목 순서 변경·정렬 시에도 React state 유지 */
function normalizeProblemsStableIds(prev) {
  return prev.map((p, pi) => {
    if (p.type === 'group') {
      const gid = p._utrRowId ?? ensureProblemRowId('grp');
      const questions = (p.questions || []).map((q) =>
        (q._utrRowId ? q : { ...q, _utrRowId: ensureProblemRowId('gq') }),
      );
      return { ...p, _utrRowId: gid, questions };
    }
    return p._utrRowId ? p : { ...p, _utrRowId: ensureProblemRowId(`row${pi}`) };
  });
}

/** 카드 간 정렬 기준 번호 — 묶음은 소문항 번호 최솟값 */
function primarySortKeyForTopItem(p) {
  if (p?.type === 'group') {
    const nums = (p.questions || []).map((q) => Number(q.number)).filter(Number.isFinite);
    return nums.length ? Math.min(...nums) : Infinity;
  }
  const n = Number(p?.number);
  return Number.isFinite(n) ? n : Infinity;
}

/** 문항 카드 순서를 등록번호 오름차순으로 스테이블 정렬 */
function sortProblemsStableByNumber(prev) {
  const list = normalizeProblemsStableIds(prev);
  return [...list]
    .map((p, order) => ({ p, order }))
    .sort((a, b) => {
      const ka = primarySortKeyForTopItem(a.p);
      const kb = primarySortKeyForTopItem(b.p);
      if (ka !== kb) return ka - kb;
      return a.order - b.order;
    })
    .map(({ p }) => p);
}

/** 묶음 카드 안 문항 순서 오름차순 */
/** 검수·임시저장 데이터에 OCR 빈칸·세로곱 중복 정규화 적용 */
function normalizeReviewProblems(problems) {
  return (problems || []).map((p) => {
    if (p?.type === 'group') {
      return {
        ...p,
        questions: (p.questions || []).map((q) => ({
          ...q,
          question: normalizeExamQuestionText(q.question || ''),
        })),
      };
    }
    return {
      ...p,
      question: normalizeExamQuestionText(p.question || ''),
    };
  });
}

function sortGroupQuestionsStable(questions) {
  const stamped = (questions || []).map((q) =>
    (q._utrRowId ? q : { ...q, _utrRowId: ensureProblemRowId('gq') }),
  );
  return [...stamped]
    .map((q, order) => ({ q, order }))
    .sort((a, b) => {
      const na = Number(a.q.number); const nb = Number(b.q.number);
      const ia = Number.isFinite(na) ? na : Infinity;
      const ib = Number.isFinite(nb) ? nb : Infinity;
      if (ia !== ib) return ia - ib;
      return a.order - b.order;
    })
    .map(({ q }) => q);
}

/** 문항 `_utrRowId` 기준 패치 후 번호순 정렬 */
function patchProblemByRowKey(prev, rowKey, patchFn) {
  const base = normalizeProblemsStableIds(prev);
  const next = base.map((p) => {
    if (p.type === 'group') {
      const qs = p.questions || [];
      let hit = false;
      const mapped = qs.map((q) => {
        if (q._utrRowId !== rowKey) return q;
        hit = true;
        return patchFn(q);
      });
      if (!hit) return p;
      return { ...p, questions: sortGroupQuestionsStable(mapped) };
    }
    if (p._utrRowId !== rowKey) return p;
    return patchFn(p);
  });
  return sortProblemsStableByNumber(next);
}

function insertNodeAtCaret(editable, node) {
  if (!editable) return;
  editable.focus();
  const sel = window.getSelection();
  if (!sel) return;
  let range;
  if (sel.rangeCount > 0) {
    range = sel.getRangeAt(0);
    if (!editable.contains(range.commonAncestorContainer)) range = null;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
  }
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  editable.focus();
}


// 단순 수식은 읽기 쉬운 문자열로, 배열·세로셈 등은 `$...$` 원문 유지 (ExamOCR.mathTextToHybridEditDisplay).
function MathField({ label, value, onChange, rows, placeholder }) {
  return (
    <div className="utr-field-row">
      <label className="utr-label">{label}</label>
      <div style={{ flex: 1 }}>
        <ContentEditableMathField
          className="form-input utr-question-textarea"
          value={value || ''}
          onChange={onChange}
          placeholder={placeholder}
        />
      </div>
    </div>
  );
}

function MathChoiceField({ ci, value, onChange, onRemove }) {
  return (
    <div className="utr-choice-item">
      <span className="utr-choice-label">{CHOICE_LABELS[ci]}</span>
      <div style={{ flex: 1 }}>
        <ContentEditableMathField
          className="form-input utr-choice-input"
          value={value || ''}
          onChange={(v) => onChange(ci, v)}
          placeholder={`${ci + 1}번 선지`}
        />
      </div>
      <button className="btn btn-ghost btn-xs" onClick={() => onRemove(ci)}>✕</button>
    </div>
  );
}

function AnswerContentEditable({ value, onChange }) {
  return (
    <ContentEditableMathField
      className="form-input utr-answer-input"
      value={value || ''}
      onChange={(v) => onChange(v || null)}
      placeholder="정답 입력"
    />
  );
}

function SolutionAreaContentEditable({ value, onChange }) {
  return (
    <ContentEditableMathField
      className="form-input utr-solution-area-input"
      value={value || ''}
      onChange={(v) => onChange(v || '')}
      placeholder="학생이 쓸 풀이 칸 (빈칸·줄)"
    />
  );
}

/** 표 셀이 비어 있는지(또는 학생용 빈칸 기호 `[     ]` · `□` 인지) 판정. */
function isBlankCellValue(cell) {
  if (cell === '' || cell === undefined || cell === null) return true;
  return isExamLongBlankBracket(cell);
}

/**
 * 표 셀의 비-빈 값(수식 포함) 을 KaTeX 로 렌더하면서 인플레이스 편집을 지원한다.
 * 본문 MathField 와 동일한 hydrate/serialize 라운드트립을 사용해 `$...$` 가 텍스트로 새지 않게 한다.
 */
function MathCell({ value, onChange }) {
  return (
    <ContentEditableMathField
      as="span"
      className="utr-cell-text"
      value={String(value ?? '')}
      onChange={(v) => onChange(v.trim())}
    />
  );
}

/** 편집 가능한 HTML 표 */
function EditableTable({ headerRows: initH, bodyRows: initB, onChange, onRemove }) {
  const [header, setHeader] = useState(initH);
  const [body,   setBody]   = useState(initB);

  useEffect(() => {
    setHeader(initH);
    setBody(initB);
  }, [initH, initB]);

  const updateCell = (isH, ri, ci, val) => {
    if (isH) {
      const next = header.map((r, row) => r.map((c, col) => row === ri && col === ci ? val : c));
      setHeader(next);
      onChange(next, body);
    } else {
      const next = body.map((r, row) => r.map((c, col) => row === ri && col === ci ? val : c));
      setBody(next);
      onChange(header, next);
    }
  };

  const renderCell = (cell, isH, ri, ci, Tag) => {
    const empty = isBlankCellValue(cell);
    return (
      <Tag key={ci} className={`utr-etd ${isH ? 'utr-eth' : ''} ${empty ? 'utr-etd--blank' : ''}`}>
        {empty ? (
          <input
            type="text"
            className="utr-blank-cell-input"
            onChange={e => updateCell(isH, ri, ci, e.target.value)}
          />
        ) : (
          <MathCell
            value={cell}
            onChange={(v) => updateCell(isH, ri, ci, v)}
          />
        )}
      </Tag>
    );
  };

  return (
    <div className={`utr-table-wrap ${onRemove ? 'utr-table-wrap--dismissible' : ''}`}>
      {onRemove ? (
        <button
          type="button"
          className="utr-table-dismiss"
          title="표 구조 해제 (내용은 아래처럼 텍스트로 유지)"
          aria-label="표 구조 해제"
          onClick={onRemove}
        >
          ✕
        </button>
      ) : null}
      <table className="utr-editable-table">
        {header.length > 0 && (
          <thead>
            {header.map((row, ri) => (
              <tr key={ri}>{row.map((c, ci) => renderCell(c, true, ri, ci, 'th'))}</tr>
            ))}
          </thead>
        )}
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri}>{row.map((c, ci) => renderCell(c, false, ri, ci, 'td'))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 텍스트 세그먼트를 렌더링 — `= ` 또는 `=` 로 끝나는 줄 뒤에 빈 input 추가
 */
function TextSegment({ content, onChange }) {
  const canon = useMemo(() => normalizeExamQuestionText(content || ''), [content]);
  const hasBlankPattern = hasExamAnswerBlankLines(content);
  const display = useMemo(() => mathTextToHybridEditDisplay(canon), [canon]);

  const commitDisplay = useCallback(
    (rawDisplay, e) => {
      const rt = e?.relatedTarget;
      if (rt instanceof HTMLElement && rt.closest('.utr-text-seg--blanks')) return;
      onChange(hybridEditDisplayToCanonical(rawDisplay, content || ''));
    },
    [content, onChange],
  );

  if (hasBlankPattern) {
    const lines = canon.split('\n');
    return (
      <div className="utr-text-seg utr-text-seg--blanks">
        {lines.map((line, i) => {
          const bracketBlank =
            line.match(new RegExp(`^(.*?=\\s*)\\[\\s{${EXAM_BLANK_INNER_SPACES},}\\](.*)$`)) ||
            line.match(/^(.*?=\s*)\[\s*\](.*)$/);
          if (bracketBlank) {
            return (
              <div key={i} className="utr-blank-line">
                <span className="utr-blank-line-text">{bracketBlank[1]}</span>
                <input type="text" className="utr-blank-answer-input" placeholder="?" />
                {bracketBlank[2] ? <span className="utr-blank-line-suffix">{bracketBlank[2]}</span> : null}
              </div>
            );
          }
          const blankMatch = line.match(/^(.*?=\s*)(?:□+|\s*)$/);
          if (blankMatch) {
            return (
              <div key={i} className="utr-blank-line">
                <span className="utr-blank-line-text">{blankMatch[1]}</span>
                <input type="text" className="utr-blank-answer-input" placeholder="?" />
              </div>
            );
          }
          return (
            <div key={i} className="utr-blank-line-plain">
              {renderMathText(line) || '\u00A0'}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <AutoGrowProblemTextarea
      className="form-input utr-math-textarea utr-text-seg utr-problem-body-textarea"
      value={display}
      onChange={(v) => onChange(hybridEditDisplayToCanonical(v, content || ''))}
      onBlur={(e) => commitDisplay(display, e)}
      placeholder=""
    />
  );
}

/**
 * 마크다운 표가 포함된 텍스트를 처리하는 MathField 확장판
 *
 * 표가 발견되면 항상 구조적 렌더링을 적용한다 — 셀 안에 `$...$` LaTeX 가 섞여 있어도
 * MathCell(아래) 이 KaTeX 로 렌더하므로, 사용자가 마크다운 원문을 보게 되는 일은 없다.
 */
function TableAwareMathField({ label, value, onChange, placeholder }) {
  const rawValue = value || '';
  const segments = useMemo(() => parseTableSegments(rawValue), [rawValue]);
  const hasTable   = segments.some(s => s.type === 'table');

  const handleTextChange = useCallback((idx, newContent) => {
    const next = segments.map((s, i) => i === idx ? { ...s, content: newContent } : s);
    onChange(segmentsToText(next));
  }, [segments, onChange]);

  const handleTableChange = useCallback((idx, newH, newB) => {
    const next = segments.map((s, i) => i === idx ? { ...s, headerRows: newH, bodyRows: newB } : s);
    onChange(segmentsToText(next));
  }, [segments, onChange]);

  const handleTableRemove = useCallback((idx) => {
    const seg = segments[idx];
    if (!seg || seg.type !== 'table') return;
    const flat = flattenTableSegmentToPlain(seg);
    const next = [
      ...segments.slice(0, idx),
      { type: 'text', content: flat },
      ...segments.slice(idx + 1),
    ];
    onChange(segmentsToText(next));
  }, [segments, onChange]);

  if (!hasTable) {
    if (hasExamAnswerBlankLines(rawValue)) {
      return (
        <div className="utr-field-row">
          <label className="utr-label">{label}</label>
          <div style={{ flex: 1 }}>
            <TextSegment content={rawValue} onChange={onChange} />
          </div>
        </div>
      );
    }
    return (
      <div className="utr-field-row">
        <label className="utr-label">{label}</label>
        <div style={{ flex: 1 }}>
          <ContentEditableMathField
            className="form-input utr-question-textarea utr-problem-body-textarea"
            value={rawValue}
            onChange={onChange}
            placeholder={placeholder}
            serializeTransform={normalizeExamQuestionText}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="utr-field-row utr-field-row--table-aware">
      <label className="utr-label">{label}</label>
      <div className="utr-taf-body utr-problem-taf-body">
        {segments.map((seg, i) =>
          seg.type === 'table' ? (
            <EditableTable
              key={i}
              headerRows={seg.headerRows}
              bodyRows={seg.bodyRows}
              onChange={(h, b) => handleTableChange(i, h, b)}
              onRemove={() => handleTableRemove(i)}
            />
          ) : (
            <TextSegment
              key={i}
              content={seg.content}
              onChange={v => handleTextChange(i, v)}
            />
          )
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 이미지 영역 선택 오버레이
// ─────────────────────────────────────────────
function ImageRegionSelector({ imageUrl, onConfirm, onCancel }) {
  const canvasRef  = useRef(null);
  const startPtRef = useRef(null);
  const [selections,   setSelections]   = useState([]);
  const [drawing,      setDrawing]      = useState(false);
  const [currentRect,  setCurrentRect]  = useState(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const getCanvasPos = (e) => {
    const canvas = canvasRef.current;
    const rect   = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width  / rect.width),
      y: (e.clientY - rect.top)  * (canvas.height / rect.height),
    };
  };

  const toDisplayRect = (sel) => {
    const canvas = canvasRef.current;
    if (!canvas) return {};
    // canvas.clientWidth/Height = CSS 렌더 크기 (scroll·padding 무관)
    const scaleX = canvas.clientWidth  / canvas.width;
    const scaleY = canvas.clientHeight / canvas.height;
    return {
      left:   sel.x * scaleX,
      top:    sel.y * scaleY,
      width:  sel.w * scaleX,
      height: sel.h * scaleY,
    };
  };

  const handleMouseDown = (e) => {
    e.preventDefault();
    startPtRef.current = getCanvasPos(e);
    setDrawing(true);
    setCurrentRect(null);
  };

  const handleMouseMove = (e) => {
    if (!drawing || !startPtRef.current) return;
    const cur = getCanvasPos(e);
    const sp  = startPtRef.current;
    setCurrentRect({ x: Math.min(sp.x, cur.x), y: Math.min(sp.y, cur.y),
                     w: Math.abs(cur.x - sp.x), h: Math.abs(cur.y - sp.y) });
  };

  const handleMouseUp = (e) => {
    if (!drawing || !startPtRef.current) return;
    const end = getCanvasPos(e);
    const sp  = startPtRef.current;
    const x = Math.min(sp.x, end.x), y = Math.min(sp.y, end.y);
    const w = Math.abs(end.x - sp.x), h = Math.abs(end.y - sp.y);
    if (w > 5 && h > 5) setSelections(prev => [...prev, { x, y, w, h }]);
    setDrawing(false);
    setCurrentRect(null);
    startPtRef.current = null;
  };

  const removeSelection = (i) => setSelections(prev => prev.filter((_, idx) => idx !== i));

  const handleConfirm = () => {
    const canvas = canvasRef.current;
    const croppedImages = selections.map(sel => {
      const c = document.createElement('canvas');
      c.width  = Math.round(sel.w);
      c.height = Math.round(sel.h);
      c.getContext('2d').drawImage(
        canvas,
        Math.round(sel.x), Math.round(sel.y), Math.round(sel.w), Math.round(sel.h),
        0, 0, Math.round(sel.w), Math.round(sel.h),
      );
      return c.toDataURL('image/jpeg', 0.92);
    });
    onConfirm(croppedImages);
  };

  const dispCurrent = currentRect ? toDisplayRect(currentRect) : null;

  return (
    <div className="irs-overlay" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="irs-panel">
        <div className="irs-header">
          <span className="irs-title">이미지 영역 선택</span>
          <span className="irs-hint">추출할 이미지(그림) 영역을 드래그하세요 — 여러 개 가능</span>
          <button className="btn btn-ghost btn-xs" onClick={onCancel}>✕ 취소</button>
        </div>
        <div
          className="irs-canvas-wrap"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { setDrawing(false); setCurrentRect(null); }}
        >
          {/* inner wrapper: 캔버스에 딱 맞게 position:relative — 선택 박스 기준점 */}
          <div style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
            <canvas ref={canvasRef} className="irs-canvas" />
            {selections.map((sel, i) => (
              <div key={i} className="irs-sel-box" style={toDisplayRect(sel)}>
                <span className="irs-sel-num">{i + 1}</span>
                <button className="irs-sel-del" onClick={e => { e.stopPropagation(); removeSelection(i); }}>✕</button>
              </div>
            ))}
            {dispCurrent && (
              <div className="irs-sel-box irs-sel-box--drawing" style={dispCurrent} />
            )}
          </div>
        </div>
        <div className="irs-footer">
          <span className="irs-count">{selections.length}개 영역 선택됨</span>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={selections.length === 0}
          >
            완료
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 개별 문항 카드
// ─────────────────────────────────────────────
function ProblemCard({
  problem,
  idx,
  total,
  onUpdate,
  onDelete,
  anchorId,
  onPrecisionReviewRequest,
  onTogglePrecisionCompare,
}) {
  const [expanded,         setExpanded]         = useState(true);
  const [localData,        setLocalData]        = useState({ ...problem });
  const [dirty,            setDirty]            = useState(false);
  const [viewMode,         setViewMode]         = useState(problem._isImageOnly ? 'image' : 'text');
  const [imageRegions,     setImageRegions]     = useState(problem._imageRegions || []);
  const [showRegionSel,    setShowRegionSel]    = useState(false);
  const [numberEditing,    setNumberEditing]    = useState(false);
  const [numDraft,         setNumDraft]         = useState(String(problem.number ?? ''));

  useEffect(() => {
    const merged = prepareProblemForSolutionEdit({
      ...problem,
      explanation: problem.explanation ?? null,
    });
    if (merged.choices?.length && merged.answer != null && merged.answer !== '') {
      merged.answer = utrNormalizeMcAnswer(merged.answer, merged.choices);
    }
    setLocalData(merged);
    setDirty(false);
    setViewMode(problem._isImageOnly ? 'image' : 'text');
    setImageRegions(problem._imageRegions || []);
  }, [problem]);

  useEffect(() => {
    if (!numberEditing) setNumDraft(String(localData.number ?? ''));
  }, [localData.number, numberEditing]);

  const update = (field, value) => {
    setLocalData(prev => ({ ...prev, [field]: value }));
    setDirty(true);
  };

  const toggleMcAnswer = (num) => {
    const prev = utrParseMcAnswerNums(localData.answer);
    let next;
    if (prev.includes(num)) {
      next = prev.filter((n) => n !== num);
    } else if (prev.length >= UTR_MC_ANSWER_MAX) {
      return;
    } else {
      next = [...prev, num].sort((a, b) => a - b);
    }
    update('answer', formatMcAnswer(next));
  };

  const selectedAnswerNums = utrParseMcAnswerNums(localData.answer);

  const updateChoice = (ci, value) => {
    const newChoices = [...(localData.choices || [])];
    newChoices[ci] = stripLeadingCircledFromChoiceText(value);
    setLocalData(prev => ({ ...prev, choices: newChoices }));
    setDirty(true);
  };

  const saveCard = () => {
    onUpdate(idx, { ...localData, _isImageOnly: viewMode === 'image', _imageRegions: imageRegions });
    setDirty(false);
  };

  const addChoice = () => {
    const newChoices = [...(localData.choices || []), ''];
    setLocalData(prev => ({ ...prev, choices: newChoices }));
    setDirty(true);
  };

  const removeChoice = (ci) => {
    const newChoices = (localData.choices || []).filter((_, i) => i !== ci);
    setLocalData(prev => ({ ...prev, choices: newChoices.length ? newChoices : null }));
    setDirty(true);
  };

  const openNumberEdit = () => {
    setNumDraft(String(localData.number ?? ''));
    setNumberEditing(true);
  };

  const cancelNumberEdit = () => {
    setNumDraft(String(localData.number ?? ''));
    setNumberEditing(false);
  };

  const confirmNumberEdit = () => {
    const n = clampQuestionNumber(numDraft);
    const merged = {
      ...localData,
      number: n,
      _isImageOnly: viewMode === 'image',
      _imageRegions: imageRegions,
    };
    setLocalData(prev => ({ ...prev, number: n }));
    setNumberEditing(false);
    onUpdate(idx, merged);
    setDirty(false);
  };

  return (
    <div className="utr-card" id={anchorId || undefined}>
      {/* 카드 헤더 */}
      <div className="utr-card-header">
        <div className="utr-card-header-left">
          <div className="utr-card-num-cluster">
            {numberEditing ? (
              <>
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="form-input utr-number-input utr-number-input--header"
                  value={numDraft}
                  onChange={(e) => setNumDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmNumberEdit();
                    if (e.key === 'Escape') cancelNumberEdit();
                  }}
                  autoFocus
                  aria-label="문항 번호"
                />
                <span className="utr-card-num-suffix">번</span>
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  title="번호 적용 (문항 순서가 번호 순으로 정렬됩니다)"
                  onClick={confirmNumberEdit}
                >확인</button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={cancelNumberEdit}
                >취소</button>
              </>
            ) : (
              <>
                <span className="utr-card-num">{localData.number}번</span>
                <button
                  type="button"
                  className="utr-card-num-edit"
                  title="문항 번호 수정"
                  onClick={openNumberEdit}
                  aria-label="문항 번호 수정"
                >✏️</button>
              </>
            )}
          </div>
          {localData.choices ? (
            <span className="utr-type-badge multiple">객관식 {localData.choices.length}지</span>
          ) : (
            <span className="utr-type-badge short">서술형</span>
          )}
          {localData._failed && <span className="utr-failed-badge">인식실패</span>}
          {dirty && <span className="utr-dirty-dot" title="저장 안 된 변경 있음" />}
        </div>
        <div className="utr-card-header-right">
          {/* 이미지 / 텍스트 모드 토글 */}
          <div className="utr-view-mode-toggle">
            <button
              className={`utr-vmode-btn ${viewMode === 'text' ? 'active' : ''}`}
              onClick={() => setViewMode('text')}
              title="텍스트 모드"
            >📝 텍스트</button>
            <button
              className={`utr-vmode-btn ${viewMode === 'image' ? 'active' : ''}`}
              onClick={() => {
                setViewMode('image');
                if (localData._cropDataUrl && imageRegions.length === 0) {
                  setShowRegionSel(true);
                }
              }}
              title="이미지 모드 — 문제 그림 영역 직접 선택"
            >🖼️ 이미지</button>
          </div>
          {dirty && (
            <button className="btn btn-primary btn-xs" onClick={saveCard}>
              저장
            </button>
          )}
          {localData._cropDataUrl && onPrecisionReviewRequest && (
            <>
              <button
                type="button"
                className="btn btn-outline btn-xs"
                title="지시를 입력하면 AI가 문항 OCR을 다시 실행합니다"
                onClick={() =>
                  onPrecisionReviewRequest({
                    rowKey: problem._utrRowId,
                    kind: 'single',
                    cropDataUrl: localData._cropDataUrl,
                    number: localData.number,
                    problemType: localData.problemType ?? '',
                    baseline: {
                      number: localData.number,
                      question: localData.question ?? '',
                      choices: localData.choices ? [...localData.choices] : null,
                      bogi: localData.bogi ?? null,
                      hasImage: !!localData.hasImage,
                      imageDescription: localData.imageDescription ?? null,
                      tableData: localData.tableData ?? null,
                      answer: localData.answer ?? null,
                    },
                  })
                }
              >
                🔬 OCR 개선 지시
              </button>
              {localData.ocrPrecisionUsed &&
                localData.gemini_result &&
                localData.claude_result &&
                onTogglePrecisionCompare && (
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    onClick={() => onTogglePrecisionCompare(problem._utrRowId)}
                  >
                    {localData.ocrCompareShowsGemini ? '재검토 결과 보기' : '이전 결과 보기'}
                  </button>
                )}
            </>
          )}
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => setExpanded(v => !v)}
          >
            {expanded ? '접기 ▲' : '펼치기 ▼'}
          </button>
          <button
            className="btn btn-ghost btn-xs"
            style={{ color: 'var(--danger)' }}
            onClick={() => onDelete(idx)}
            title="이 문항 삭제"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 이미지 영역 선택 오버레이 */}
      {showRegionSel && localData._cropDataUrl && (
        <ImageRegionSelector
          imageUrl={localData._cropDataUrl}
          onConfirm={(regions) => {
            setImageRegions(regions);
            setShowRegionSel(false);
            setDirty(true);
          }}
          onCancel={() => {
            setShowRegionSel(false);
            if (imageRegions.length === 0) setViewMode('text');
          }}
        />
      )}

      {/* 카드 본문 */}
      {expanded && (
        <div className="utr-card-body">

          {/* ── 문제 원본 (기본 펼침) ── */}
          {localData._cropDataUrl && (
            <details className="utr-crop-section utr-crop-section--collapsible" open>
              <summary className="utr-crop-summary">
                {viewMode === 'image'
                  ? <span className="utr-crop-badge imgonly">🖼️ 이미지 모드</span>
                  : localData._failed
                    ? <span className="utr-crop-badge failed">⚠️ 인식 실패</span>
                    : <span className="utr-crop-badge ok">📷 문제 원본</span>
                }
              </summary>
              <img
                src={localData._cropDataUrl}
                alt={`${localData.number}번 원본`}
                className="utr-crop-img"
                style={{ marginTop: 6 }}
              />
            </details>
          )}

          {/* 문제 본문 — 모드 무관하게 항상 편집 가능 */}
          <TableAwareMathField
            label="문제"
            value={localData.question || ''}
            placeholder="문제 내용을 입력하세요"
            onChange={v => update('question', v)}
          />

          {/* ── 이미지 모드: 선택된 이미지 영역 표시 ── */}
          {viewMode === 'image' && (
            <div className="utr-image-regions-section">
              <div className="utr-image-regions-header">
                <span className="utr-label">🖼️ 첨부 이미지</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {localData._cropDataUrl && (
                    <button
                      className="btn btn-outline btn-xs"
                      onClick={() => setShowRegionSel(true)}
                    >
                      + 영역 추가
                    </button>
                  )}
                  {imageRegions.length > 0 && (
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ color: 'var(--danger)' }}
                      onClick={() => { setImageRegions([]); setDirty(true); }}
                    >
                      전체 삭제
                    </button>
                  )}
                </div>
              </div>
              {imageRegions.length === 0 ? (
                <div className="utr-image-regions-empty">
                  {localData._cropDataUrl
                    ? '문제 원본 이미지에서 추출할 그림 영역을 선택하세요'
                    : '문제 원본 이미지가 없습니다 (텍스트 모드로 전환하세요)'}
                </div>
              ) : (
                <div className="utr-image-regions-list">
                  {imageRegions.map((url, i) => (
                    <div key={i} className="utr-image-region-item">
                      <span className="utr-image-region-num">{i + 1}</span>
                      <img src={url} alt={`이미지 ${i + 1}`} className="utr-image-region-img" />
                      <button
                        className="utr-image-region-del"
                        title="이 이미지 제거"
                        onClick={() => {
                          setImageRegions(prev => prev.filter((_, idx) => idx !== i));
                          setDirty(true);
                        }}
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 〈보기〉: AI/API가 채워 넣은 경우에만 표시 */}
          {String(localData.bogi ?? '').trim().length > 0 && (
            <MathField
              label="〈보기〉"
              value={localData.bogi || ''}
              rows={2}
              placeholder="〈보기〉 내용"
              onChange={v => update('bogi', (v || '').trim() ? v : null)}
            />
          )}

          {/* 선지 */}
          {localData.choices && localData.choices.length > 0 && (
            <div className="utr-field-row utr-choices-row">
              <label className="utr-label">선지</label>
              <div className="utr-choices-list">
                {localData.choices.map((c, ci) => (
                  <MathChoiceField
                    key={ci}
                    ci={ci}
                    value={c}
                    onChange={updateChoice}
                    onRemove={removeChoice}
                  />
                ))}
                {localData.choices.length < 6 && (
                  <button className="btn btn-outline btn-xs utr-add-choice" onClick={addChoice}>
                    + 선지 추가
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 선지 없는 경우 추가 버튼 */}
          {!localData.choices && (
            <div className="utr-field-row">
              <label className="utr-label" />
              <button
                className="btn btn-outline btn-xs"
                onClick={() => { update('choices', ['', '', '', '', '']); }}
              >
                + 객관식 선지 추가
              </button>
            </div>
          )}

          {localData.requiresSolution && (
            <div className="utr-field-row">
              <label className="utr-label">풀이과정</label>
              <SolutionAreaContentEditable
                value={localData.solutionArea || ''}
                onChange={(v) => update('solutionArea', v ?? '')}
              />
            </div>
          )}

          {/* 정답 */}
          <div className="utr-field-row">
            <label className="utr-label">정답</label>
            {localData.choices ? (
              <div>
                <p className="utr-hint-text" style={{ marginBottom: 6 }}>
                  최대 {UTR_MC_ANSWER_MAX}개 선택 · 다시 누르면 해제
                </p>
                <div className="utr-answer-choices">
                  {localData.choices.map((_, ci) => {
                    const num = ci + 1;
                    const isSelected = selectedAnswerNums.includes(num);
                    const isMaxed = !isSelected && selectedAnswerNums.length >= UTR_MC_ANSWER_MAX;
                    return (
                      <button
                        key={ci}
                        type="button"
                        className={`utr-answer-btn ${isSelected ? 'selected' : ''} ${isMaxed ? 'pmod-answer-btn--maxed' : ''}`}
                        onClick={() => !isMaxed && toggleMcAnswer(num)}
                        disabled={isMaxed}
                      >
                        {CHOICE_LABELS[ci]}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={`utr-answer-btn ${isMcAnswerEmpty(localData.answer) ? 'selected' : ''}`}
                    onClick={() => update('answer', null)}
                    title="정답 초기화"
                  >
                    미정
                  </button>
                </div>
                {selectedAnswerNums.length > 0 && (
                  <p className="utr-hint-text" style={{ marginTop: 6 }}>
                    선택된 정답: {selectedAnswerNums.map((n) => CHOICE_LABELS[n - 1]).join(' ')}
                  </p>
                )}
              </div>
            ) : (
              <AnswerContentEditable
                value={localData.answer || ''}
                onChange={(v) => update('answer', v)}
              />
            )}
          </div>

          {/* 풀이과정 요구 & 모범 해설 */}
          <div className="utr-field-row utr-requires-row">
            <label className="utr-label">풀이 유형</label>
            <div>
              <label className="utr-inline-check">
                <input
                  type="checkbox"
                  checked={!!localData.requiresSolution}
                  onChange={(e) => {
                    const on = e.target.checked;
                    if (on) {
                      const split = prepareProblemForSolutionEdit({
                        ...localData,
                        requiresSolution: true,
                      });
                      setLocalData((prev) => ({
                        ...prev,
                        requiresSolution: true,
                        question: split.question,
                        solutionArea: split.solutionArea ?? '',
                      }));
                    } else {
                      setLocalData((prev) => ({
                        ...prev,
                        requiresSolution: false,
                        question: mergeSolutionAreaIntoQuestion(
                          prev.question,
                          prev.solutionArea,
                        ),
                        solutionArea: null,
                      }));
                    }
                    setDirty(true);
                  }}
                />
                학생에게 <strong>풀이 과정(서술)</strong>을 요구하는 문항
              </label>
              <p className="utr-hint-text">지문에 ‘풀이’, ‘과정을 쓰시오’ 등이 있으면 자동으로 켜집니다.</p>
            </div>
          </div>

          {localData.requiresSolution && (
            <MathField
              label="모범 풀이·해설 (선생님용)"
              value={localData.explanation || ''}
              rows={4}
              placeholder="채점·참고용 모범 풀이를 적어 두세요 (선택)"
              onChange={(v) => update('explanation', v || null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 선잇기 문제 카드
// ─────────────────────────────────────────────

function initMatchingSide(problem, side) {
  const itemsKey = side === 'left' ? 'leftItems' : 'rightItems';
  const labelsKey = side === 'left' ? 'leftLabels' : 'rightLabels';
  return resolveMatchingSide(problem[itemsKey], side, problem[labelsKey]);
}

function MatchingCard({
  problem,
  idx,
  onUpdate,
  onDelete,
  anchorId,
  onPrecisionReviewRequest,
  onTogglePrecisionCompare,
}) {
  const [expanded, setExpanded] = useState(true);
  const [number,   setNumber]   = useState(problem.number ?? idx + 1);
  const [question, setQuestion] = useState(problem.question || '다음을 알맞게 이으세요.');
  const initialLeft = initMatchingSide(problem, 'left');
  const initialRight = initMatchingSide(problem, 'right');

  const [leftItems, setLeftItems] = useState(() => initialLeft.items);
  const [leftLabels, setLeftLabels] = useState(() => initialLeft.labels);
  const [rightItems, setRightItems] = useState(() => initialRight.items);
  const [rightLabels, setRightLabels] = useState(() => initialRight.labels);
  // 정답: { '가': 'a', '나': 'b', ... }
  const [answer, setAnswer] = useState({});
  const [dirty, setDirty] = useState(false);
  const [numberEditing, setNumberEditing] = useState(false);
  const [numDraft, setNumDraft] = useState('');

  const normalizedLeftFromProps = useMemo(
    () => resolveMatchingSide(problem.leftItems, 'left', problem.leftLabels),
    [problem.leftItems, problem.leftLabels],
  );
  const normalizedRightFromProps = useMemo(
    () => resolveMatchingSide(problem.rightItems, 'right', problem.rightLabels),
    [problem.rightItems, problem.rightLabels],
  );

  useEffect(() => {
    setLeftItems(normalizedLeftFromProps.items);
    setLeftLabels(normalizedLeftFromProps.labels);
    setRightItems(normalizedRightFromProps.items);
    setRightLabels(normalizedRightFromProps.labels);
    setQuestion(problem.question || '다음을 알맞게 이으세요.');
    setNumber(problem.number ?? idx + 1);
    const ansStr = typeof problem.answer === 'string' ? problem.answer.trim() : '';
    if (!ansStr) setAnswer({});
    else {
      const next = {};
      ansStr.split(',').forEach((seg) => {
        const part = seg.trim();
        const m = part.match(/^\(([^)]+)\)\s*[→⇒]+\s*\(([^)]+)\)$/u);
        if (m) next[`(${m[1]})`] = `(${m[2]})`;
      });
      setAnswer(next);
    }
  }, [
    idx,
    problem.number,
    problem.question,
    problem.answer,
    normalizedLeftFromProps,
    normalizedRightFromProps,
  ]);

  useEffect(() => {
    if (!numberEditing) setNumDraft(String(number));
  }, [number, numberEditing]);

  const buildPayload = useCallback((overrideNumber) => ({
    ...problem,
    number: overrideNumber !== undefined ? overrideNumber : number,
    question,
    leftItems,
    rightItems,
    leftLabels,
    rightLabels,
    answer: Object.entries(answer).map(([l, r]) => `${l}→${r}`).join(', '),
  }), [problem, number, question, leftItems, rightItems, leftLabels, rightLabels, answer]);

  const handleSave = () => {
    onUpdate(idx, buildPayload());
    setDirty(false);
  };

  const openMatchingNumberEdit = () => {
    setNumDraft(String(number));
    setNumberEditing(true);
  };

  const cancelMatchingNumberEdit = () => {
    setNumDraft(String(number));
    setNumberEditing(false);
  };

  const confirmMatchingNumberEdit = () => {
    const n = clampQuestionNumber(numDraft);
    setNumber(n);
    setNumberEditing(false);
    onUpdate(idx, buildPayload(n));
    setDirty(false);
  };

  return (
    <div className="utr-card utr-card--matching" id={anchorId || undefined}>
      <div className="utr-card-header utr-card-header--matching">
        <div className="utr-card-header-left">
          <span className="utr-num-badge utr-num-badge--matching">선잇기</span>
          <div className="utr-card-num-cluster">
            {numberEditing ? (
              <>
                <input
                  type="number"
                  min={1}
                  max={100}
                  className="form-input utr-number-input utr-number-input--header"
                  value={numDraft}
                  onChange={(e) => setNumDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmMatchingNumberEdit();
                    if (e.key === 'Escape') cancelMatchingNumberEdit();
                  }}
                  autoFocus
                  aria-label="문항 번호"
                />
                <span className="utr-card-num-suffix">번</span>
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  title="번호 적용 (문항 순서가 번호 순으로 정렬됩니다)"
                  onClick={confirmMatchingNumberEdit}
                >확인</button>
                <button type="button" className="btn btn-ghost btn-xs" onClick={cancelMatchingNumberEdit}>취소</button>
              </>
            ) : (
              <>
                <span className="utr-card-num">{number}번</span>
                <button
                  type="button"
                  className="utr-card-num-edit"
                  title="문항 번호 수정"
                  onClick={openMatchingNumberEdit}
                  aria-label="문항 번호 수정"
                >✏️</button>
              </>
            )}
          </div>
        </div>
        <div className="utr-card-header-right">
          {dirty && <span className="utr-dirty-dot" title="저장 필요">●</span>}
          {dirty && (
            <button type="button" className="btn btn-primary btn-xs" onClick={handleSave}>저장</button>
          )}
          {problem._cropDataUrl && onPrecisionReviewRequest && (
            <>
              <button
                type="button"
                className="btn btn-outline btn-xs"
                title="지시를 입력하면 AI가 문항 OCR을 다시 실행합니다"
                onClick={() =>
                  onPrecisionReviewRequest({
                    rowKey: problem._utrRowId,
                    kind: 'matching',
                    cropDataUrl: problem._cropDataUrl,
                    number,
                    problemType: problem.problemType || '선잇기',
                    baseline: {
                      number,
                      question,
                      choices: null,
                      hasImage: !!problem.hasImage,
                      bogi: null,
                      answer: Object.entries(answer)
                        .map(([l, r]) => `${l}→${r}`)
                        .join(', '),
                    },
                  })
                }
              >
                🔬 OCR 개선 지시
              </button>
              {problem.ocrPrecisionUsed &&
                problem.gemini_result &&
                problem.claude_result &&
                onTogglePrecisionCompare && (
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    onClick={() => onTogglePrecisionCompare(problem._utrRowId)}
                  >
                    {problem.ocrCompareShowsGemini ? '재검토 결과 보기' : '이전 결과 보기'}
                  </button>
                )}
            </>
          )}
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setExpanded(v => !v)}>
            {expanded ? '접기 ▲' : '펼치기 ▼'}
          </button>
          <button type="button" className="btn btn-ghost btn-xs utr-delete-btn" onClick={() => onDelete(idx)}>✕</button>
        </div>
      </div>

      {expanded && (
        <div className="utr-card-body">
          {/* 문제 지문 */}
          <div className="utr-field-row">
            <label className="utr-label">문제 지문</label>
            <input
              className="form-input"
              value={question}
              onChange={e => { setQuestion(e.target.value); setDirty(true); }}
            />
          </div>

          {/* 선잇기 항목 편집 + 답안 선택 */}
          <div className="utr-matching-layout">
            {/* 왼쪽 항목 */}
            <div className="utr-matching-col">
              <p className="utr-matching-col-title">왼쪽 항목</p>
              {leftItems.map((item, i) => (
                <div key={i} className="utr-matching-item-row">
                  <span className="utr-matching-label">{leftLabels[i]}</span>
                  <input
                    className="form-input utr-matching-input"
                    value={item}
                    onChange={e => {
                      const next = [...leftItems];
                      next[i] = e.target.value;
                      setLeftItems(next);
                      setDirty(true);
                    }}
                  />
                </div>
              ))}
              <button
                className="btn btn-outline btn-xs utr-matching-add"
                onClick={() => {
                  const i = leftItems.length;
                  setLeftItems([...leftItems, '']);
                  setLeftLabels([...leftLabels, defaultMatchingLabel('left', i)]);
                  setDirty(true);
                }}
              >+ 항목 추가</button>
            </div>

            {/* 오른쪽 항목 */}
            <div className="utr-matching-col">
              <p className="utr-matching-col-title">오른쪽 항목</p>
              {rightItems.map((item, i) => (
                <div key={i} className="utr-matching-item-row">
                  <span className="utr-matching-label">{rightLabels[i]}</span>
                  <input
                    className="form-input utr-matching-input"
                    value={item}
                    onChange={e => {
                      const next = [...rightItems];
                      next[i] = e.target.value;
                      setRightItems(next);
                      setDirty(true);
                    }}
                  />
                </div>
              ))}
              <button
                className="btn btn-outline btn-xs utr-matching-add"
                onClick={() => {
                  const i = rightItems.length;
                  setRightItems([...rightItems, '']);
                  setRightLabels([...rightLabels, defaultMatchingLabel('right', i)]);
                  setDirty(true);
                }}
              >+ 항목 추가</button>
            </div>

            {/* 정답 드롭다운 */}
            <div className="utr-matching-col utr-matching-col--answer">
              <p className="utr-matching-col-title">정답 설정</p>
              {leftItems.map((_, i) => {
                const lKey = leftLabels[i] || `(${i + 1})`;
                const selected = answer[lKey] || '';
                return (
                  <div key={i} className="utr-matching-item-row">
                    <span className="utr-matching-label">{lKey} →</span>
                    <select
                      className="form-input utr-matching-select"
                      value={selected}
                      onChange={(e) => {
                        setAnswer((prev) => ({ ...prev, [lKey]: e.target.value }));
                        setDirty(true);
                      }}
                    >
                      <option value="">선택</option>
                      {rightItems.map((_, j) => (
                        <option key={j} value={rightLabels[j] || `(${j + 1})`}>
                          {rightLabels[j] || `(${j + 1})`} {rightItems[j]}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 문제 원본 (기본 펼침) */}
          {problem._cropDataUrl && (
            <details className="utr-crop-section utr-crop-section--collapsible utr-matching-crop" open>
              <summary className="utr-crop-summary">
                <span className="utr-crop-badge ok">📷 문제 원본</span>
              </summary>
              <img src={problem._cropDataUrl} alt="선잇기 원본" className="utr-crop-img" style={{ marginTop: 6 }} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 묶음 문제 그룹 카드
// ─────────────────────────────────────────────
function ProblemGroupCard({
  group,
  idx,
  onUpdate,
  onDelete,
  onPrecisionReviewRequest,
  onTogglePrecisionCompare,
}) {
  const [expanded, setExpanded] = useState(true);
  const [passage,  setPassage]  = useState(group.passage || '');
  const [label,    setLabel]    = useState(group.label   || '');
  const [dirty, setDirty] = useState(false);

  const questionsList = Array.isArray(group.questions) ? group.questions : [];

  useEffect(() => {
    setPassage(group.passage || '');
    setLabel(group.label || '');
  }, [group.passage, group.label]);

  // 보기/레이블 변경
  const updatePassage = (val) => { setPassage(val); setDirty(true); };
  const updateLabel   = (val) => { setLabel(val);   setDirty(true); };

  // 그룹 내 문항 업데이트 → 상위 상태에 반영 후 전체가 번호순 재정렬됨(updateProblem 쪽에서 처리)
  const updateGroupQuestion = (qi, data) => {
    const nextQs = sortGroupQuestionsStable(
      questionsList.map((q, i) => (i === qi ? { ...q, ...data, _utrRowId: q._utrRowId } : q)),
    );
    onUpdate(idx, { ...group, passage, label, questions: nextQs, _utrRowId: group._utrRowId });
    setDirty(true);
  };

  // 그룹 내 문항 삭제
  const deleteGroupQuestion = (qi) => {
    if (!window.confirm('이 문항을 그룹에서 제거하시겠습니까?')) return;
    const nextQs = questionsList.filter((_, i) => i !== qi);
    onUpdate(idx, { ...group, passage, label, questions: nextQs, _utrRowId: group._utrRowId });
    setDirty(true);
  };

  // 그룹에 빈 문항 추가
  const addGroupQuestion = () => {
    const maxNum = Math.max(...questionsList.map((q) => q.number || 0), 0);
    const row = { number: maxNum + 1, question: '', choices: null, _utrRowId: ensureProblemRowId('nq') };
    const nextQs = [...questionsList, row];
    onUpdate(idx, { ...group, passage, label, questions: nextQs, _utrRowId: group._utrRowId });
    setDirty(true);
  };

  // 그룹 전체 저장 → 부모에 전달
  const saveGroup = () => {
    onUpdate(idx, { ...group, passage, label, questions: questionsList, _utrRowId: group._utrRowId });
    setDirty(false);
  };

  return (
    <div className="utr-group-card">
      {/* 그룹 헤더 */}
      <div className="utr-group-header">
        <div className="utr-group-header-left">
          <span className="utr-group-badge">묶음</span>
          <input
            className="utr-group-label-input"
            value={label}
            onChange={e => updateLabel(e.target.value)}
            placeholder="범위 (예: 1~2)"
          />
          <span className="utr-group-count">{questionsList.length}문항</span>
          {dirty && <span className="utr-dirty-dot" title="저장 안 된 변경 있음" />}
        </div>
        <div className="utr-group-header-right">
          {dirty && (
            <button className="btn btn-primary btn-xs" onClick={saveGroup}>저장</button>
          )}
          <button className="btn btn-ghost btn-xs" onClick={() => setExpanded(v => !v)}>
            {expanded ? '접기 ▲' : '펼치기 ▼'}
          </button>
          <button
            className="btn btn-ghost btn-xs"
            style={{ color: 'var(--danger)' }}
            onClick={() => onDelete(idx)}
            title="그룹 전체 삭제"
          >✕</button>
        </div>
      </div>

      {expanded && (
        <div className="utr-group-body">
          {/* 보기(지문) 영역 */}
          <div className="utr-group-passage">
            <div className="utr-group-passage-label">
              [{label || '보기'}]
            </div>
            <textarea
              className="form-input utr-group-passage-textarea"
              value={passage}
              onChange={e => updatePassage(e.target.value)}
              rows={4}
              placeholder="공통 보기(지문) 내용을 입력하세요"
            />
          </div>

          {/* 묶음 내 문제 카드들 */}
          <div className="utr-group-questions">
            {questionsList.map((q, qi) => (
              <div
                key={q._utrRowId ?? `gq-${qi}`}
                className="utr-group-question-wrap"
              >
                <ProblemCard
                  problem={q}
                  idx={qi}
                  total={questionsList.length}
                  onUpdate={updateGroupQuestion}
                  onDelete={deleteGroupQuestion}
                  anchorId={utrAnchorId(q._utrRowId)}
                  onPrecisionReviewRequest={onPrecisionReviewRequest}
                  onTogglePrecisionCompare={onTogglePrecisionCompare}
                />
              </div>
            ))}
          </div>

          <button className="btn btn-outline btn-sm utr-group-add-q" onClick={addGroupQuestion}>
            + 문항 추가
          </button>
        </div>
      )}
    </div>
  );
}


export default function UnitTestReview() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { teacherUser } = useAuth();

  const [problems,  setProblems]  = useState([]);
  const [examTitle, setExamTitle] = useState('단원평가');
  const [examGrade, setExamGrade] = useState('');
  const [saving,    setSaving]    = useState(false);
  const [savedId,   setSavedId]   = useState(null);
  const [error,     setError]     = useState('');
  const [done,      setDone]      = useState(false);
  /** 문제 보관함에서 ?edit= 로 열었을 때 기존 시험 문서 ID (덮어쓰기 저장) */
  const [editingExamId, setEditingExamId] = useState(null);


  const [curriculumMeta, setCurriculumMeta] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const editId = searchParams.get('edit');

    (async () => {
      if (editId && teacherUser?.uid) {
        setError('');
        try {
          const examSnap = await getDoc(doc(db, 'exams', editId));
          if (!examSnap.exists()) {
            if (!cancelled) {
              setError('시험지를 찾을 수 없습니다.');
            }
            return;
          }
          const exData = examSnap.data();
          if (exData.createdBy !== teacherUser.uid) {
            if (!cancelled) {
              setError('본인이 만든 시험만 검수 화면에서 수정할 수 있습니다.');
            }
            return;
          }
          const rawList = await getExamQuestions(editId);
          if (!cancelled) {
            setProblems(
              normalizeReviewProblems(
                sortProblemsStableByNumber(firebaseExamQuestionsToReviewProblems(rawList)),
              ),
            );
            setExamTitle(exData.title || '단원평가');
            const g = exData.examGrade ?? exData.grade ?? '';
            setExamGrade(typeof g === 'string' ? g : String(g));
            setCurriculumMeta({
              grade: exData.grade || '',
              semester: exData.semester || '',
              unit: exData.unit || '',
            });
            setEditingExamId(editId);
          }
        } catch (e) {
          if (!cancelled) setError('불러오기 오류: ' + (e.message || String(e)));
        }
        return;
      }

      // URL에 edit 없음: 인증 대기 중에는 스킵(로컬 draft를 edit 모드로 오염 방지)
      if (editId && !teacherUser?.uid) return;

      const stored = localStorage.getItem('unitTestProblems');
      const title  = localStorage.getItem('unitTestTitle');
      const grade  = localStorage.getItem('unitTestGrade');
      const curRaw = localStorage.getItem('unitTestCurriculum');
      if (stored) {
        try {
          const parsed = normalizeProblemsCircledMcAnswers(JSON.parse(stored));
          if (!cancelled) setProblems(normalizeReviewProblems(sortProblemsStableByNumber(parsed)));
        } catch { /* ignore */ }
      }
      if (title && !cancelled) setExamTitle(title);
      if (grade && !cancelled) setExamGrade(grade);
      if (curRaw && !cancelled) {
        try {
          const meta = JSON.parse(curRaw);
          setCurriculumMeta(meta);
          if (meta.grade && !grade) setExamGrade(meta.grade);
        } catch { /* ignore */ }
      }
    })();

    return () => { cancelled = true; };
  }, [searchParams, teacherUser?.uid]);

  const navTargets = useMemo(() => buildUtrNavTargets(problems), [problems]);

  const utrLayoutRef = useRef(null);
  const utrFocusCleanupRef = useRef(null);
  /** @type {React.MutableRefObject<{ el: HTMLTextAreaElement | HTMLInputElement | null; start: number; end: number }>} */
  const utrInsertRef = useRef({ el: null, start: 0, end: 0 });
  const [reviewMathOpen, setReviewMathOpen] = useState(false);

  const setUtrLayoutRef = useCallback((node) => {
    utrFocusCleanupRef.current?.();
    utrFocusCleanupRef.current = null;
    utrLayoutRef.current = node;
    if (!node) return;
    const onFocusOut = (e) => {
      const t = e.target;
      if (isInsideUtrMathEditor(t)) return;
      if (t instanceof HTMLTextAreaElement) {
        utrInsertRef.current = { el: t, start: t.selectionStart, end: t.selectionEnd };
        return;
      }
      if (t instanceof HTMLInputElement && (!t.type || t.type === 'text' || t.type === 'search')) {
        utrInsertRef.current = { el: t, start: t.selectionStart ?? 0, end: t.selectionEnd ?? 0 };
        return;
      }
      // contentEditable div 추가
      if (t instanceof HTMLElement && t.isContentEditable) {
        utrInsertRef.current = { el: t, start: 0, end: 0 };
      }
    };
    node.addEventListener('focusout', onFocusOut);
    utrFocusCleanupRef.current = () => node.removeEventListener('focusout', onFocusOut);
  }, []);

  const insertReviewChunk = useCallback((chunk) => {
    insertChunkIntoUtrFocusedField(utrInsertRef, chunk, setError);
  }, []);

  const insertReviewMathFromScript = useCallback(
    (script) => {
      const latex = elementaryScriptToLatex(script).trim();
      if (!latex) return;
      const { el } = utrInsertRef.current;
      if (el && el.isContentEditable) {
        el.focus();
        insertNodeAtCaret(el, createFrozenMathElement(latex));
      } else {
        if (isComplexLatexForPlainTransform(latex)) {
          insertReviewChunk(`$${latex}$`);
        } else {
          insertReviewChunk(latexToPlain(latex));
        }
      }
    },
    [insertReviewChunk],
  );

  const insertReviewSymbol = useCallback(
    (kind, sym) => {
      insertReviewChunk(kind === 'op' ? sym : `⟦UNIT:${encodeURIComponent(sym)}⟧`);
    },
    [insertReviewChunk],
  );

  const toggleReviewMathPanel = useCallback(() => setReviewMathOpen((v) => !v), []);

  /** '수식 넣기' 클릭 직전(mousedown)에 아직 포커스가 왼쪽 입력에 있을 때 커서 위치를 확정 */
  const onReviewMathTogglePointerDown = useCallback(
    (e) => {
      if (e.button !== 0 || reviewMathOpen) return;
      const ae = document.activeElement;
      if (ae instanceof HTMLTextAreaElement) {
        if (isInsideUtrMathEditor(ae)) return;
        utrInsertRef.current = { el: ae, start: ae.selectionStart, end: ae.selectionEnd };
        return;
      }
      if (
        ae instanceof HTMLInputElement &&
        (!ae.type || ae.type === 'text' || ae.type === 'search')
      ) {
        if (isInsideUtrMathEditor(ae)) return;
        utrInsertRef.current = {
          el: ae,
          start: ae.selectionStart ?? 0,
          end: ae.selectionEnd ?? 0,
        };
      }
    },
    [reviewMathOpen],
  );

  const [precisionPanel, setPrecisionPanel] = useState(null);
  const precisionPanelRef = useRef(null);

  useEffect(() => {
    precisionPanelRef.current = precisionPanel;
  }, [precisionPanel]);

  const openPrecisionReviewPanel = useCallback((payload) => {
    setPrecisionPanel({ payload });
  }, []);

  const handlePrecisionReviewApply = useCallback((apiResult) => {
    const rowKey = precisionPanelRef.current?.payload?.rowKey;
    if (!rowKey) return;
    setProblems((prev) =>
      patchProblemByRowKey(prev, rowKey, (p) => mergePrecisionReviewIntoProblem(p, apiResult)),
    );
  }, []);

  const togglePrecisionCompare = useCallback((rowKey) => {
    setProblems((prev) =>
      patchProblemByRowKey(prev, rowKey, (p) => {
        if (!p.ocrPrecisionUsed || !p.gemini_result || !p.claude_result) return p;
        const nextGem = !p.ocrCompareShowsGemini;
        const snap = nextGem ? p.gemini_result : p.claude_result;
        if (p.problemType === '선잇기') {
          return {
            ...p,
            question: snap.question ?? p.question,
            leftItems: snap.leftItems ? [...snap.leftItems] : p.leftItems,
            rightItems: snap.rightItems ? [...snap.rightItems] : p.rightItems,
            leftLabels: snap.leftLabels ? [...snap.leftLabels] : p.leftLabels,
            rightLabels: snap.rightLabels ? [...snap.rightLabels] : p.rightLabels,
            answer: snap.answer ?? p.answer,
            ocrCompareShowsGemini: nextGem,
          };
        }
        const choices = snap.choices !== undefined ? snap.choices : p.choices;
        const ans = utrNormalizeMcAnswer(snap.answer, choices);
        return {
          ...p,
          question: snap.question ?? p.question,
          choices,
          bogi: snap.bogi !== undefined ? snap.bogi : p.bogi,
          answer: ans,
          explanation: snap.explanation !== undefined ? snap.explanation : p.explanation,
          requiresSolution:
            snap.requiresSolution !== undefined ? !!snap.requiresSolution : p.requiresSolution,
          ocrCompareShowsGemini: nextGem,
        };
      }),
    );
  }, []);

  // ── 문항 업데이트 ──
  const updateProblem = (idx, data) => {
    setProblems((prev) => {
      const base = normalizeProblemsStableIds(prev);
      const next = base.map((p, i) => {
        if (i !== idx) return p;
        return { ...p, ...data, _utrRowId: p._utrRowId };
      });
      return sortProblemsStableByNumber(next);
    });
  };

  // ── 문항 삭제 ──
  const deleteProblem = (idx) => {
    const label = problems[idx].type === 'group'
      ? `[${problems[idx].label || '묶음'}] 그룹`
      : `${problems[idx].number}번 문항`;
    if (!window.confirm(`${label}을 삭제하시겠습니까?`)) return;
    setProblems(prev => prev.filter((_, i) => i !== idx));
  };

  // ── 묶음 문제 그룹 추가 ──
  const addGroup = () => {
    const maxNum = problems.reduce((acc, p) => {
      if (p.type === 'group') return Math.max(acc, ...p.questions.map(q => q.number || 0));
      return Math.max(acc, p.number || 0);
    }, 0);
    setProblems((prev) => sortProblemsStableByNumber([
      ...prev,
      {
        type: 'group',
        label: `${maxNum + 1}~${maxNum + 2}`,
        passage: '',
        questions: [
          { number: maxNum + 1, question: '', choices: null },
          { number: maxNum + 2, question: '', choices: null },
        ],
      },
    ]));
  };

  // ── 번호 재정렬 ──
  const renumber = () => {
    setProblems((prev) => sortProblemsStableByNumber(prev.map((p, i) => ({ ...p, number: i + 1 }))));
  };

  // ── 순서 이동 (▲▼ 버튼) ──
  const moveItem = (idx, dir) => {
    setProblems(prev => {
      const arr  = [...prev];
      const dest = idx + dir;
      if (dest < 0 || dest >= arr.length) return prev;
      [arr[idx], arr[dest]] = [arr[dest], arr[idx]];
      return arr;
    });
  };

  // ── Firestore 저장 ──
  const saveToFirestore = async () => {
    if (saving) return;
    if (!examTitle.trim()) { setError('시험지 제목을 입력해주세요.'); return; }
    if (!examGrade)        { setError('학년을 선택해주세요.'); return; }
    setSaving(true); setError('');

    // 그룹 포함 전체 문항 평탄화
    const flatProblems = [];
    for (const p of problems) {
      if (p.type === 'group') {
        for (const q of p.questions) {
          flatProblems.push({
            ...q,
            passage: p.passage || null,
            groupLabel: p.label || null,
            // 묶음 공통 보기(지문) 캡처 이미지 — 열기/가이드 화면에서 3분할(보기/7/8)로 쓰기
            passageImage_b64: p.passageImage_b64 || null,
            // 묶음 전체 스택 이미지(보기+소문항) — 일부 화면에서 보기 누락 방지용 fallback
            groupStackImage_b64: p.groupStackImage_b64 || null,
          });
        }
      } else if (p.problemType === '선잇기') {
        // 선잇기: 구조화된 데이터 그대로 저장
        flatProblems.push({
          ...p,
          leftItems: p.leftItems || [],
          rightItems: p.rightItems || [],
          leftLabels: p.leftLabels || [],
          rightLabels: p.rightLabels || [],
        });
      } else {
        flatProblems.push(p);
      }
    }

    try {
      const questionDocData = (p) => ({
        number: p.number,
        question: p.question,
        choices: p.choices || null,
        bogi: p.bogi || null,
        passage: p.passage || null,
        groupLabel: p.groupLabel || null,
        passageImage_b64: p.passageImage_b64 || null,
        groupStackImage_b64: p.groupStackImage_b64 || null,
        hasImage: !!(p.hasImage || p._cropDataUrl || p.image_b64),
        image_b64: p._cropDataUrl || p.image_b64 || null,
        answer: p.answer ?? null,
        requiresSolution: !!p.requiresSolution,
        solutionArea: p.requiresSolution ? (p.solutionArea || null) : null,
        explanation: p.explanation ?? null,
        ...(p.problemType === '선잇기'
          ? {
              problemType: '선잇기',
              leftItems: p.leftItems || [],
              rightItems: p.rightItems || [],
              leftLabels: p.leftLabels || [],
              rightLabels: p.rightLabels || [],
            }
          : {}),
      });

      let examPaperLibraryId = '';
      let examPaperSha256 = '';
      try {
        examPaperLibraryId = localStorage.getItem('unitTestExamPaperLibraryId') || '';
        examPaperSha256 = localStorage.getItem('unitTestExamPaperSha256') || '';
      } catch { /* ignore */ }

      const examLinkFields = {
        ...(examPaperLibraryId ? { examPaperLibraryId } : {}),
        ...(examPaperSha256 ? { examPaperSha256 } : {}),
      };

      let examIdSaved;
      if (editingExamId) {
        const existingSnap = await getDoc(doc(db, 'exams', editingExamId));
        const prevSrc = existingSnap.exists()
          ? (existingSnap.data().source ?? 'unit-test-upload')
          : 'unit-test-upload';
        await updateDoc(doc(db, 'exams', editingExamId), {
          examGrade,
          title: examTitle.trim(),
          questionCount: flatProblems.length,
          updatedAt: new Date().toISOString(),
          source: prevSrc,
          ...examLinkFields,
          ...(curriculumMeta && curriculumMeta.grade
            ? {
                grade: curriculumMeta.grade,
                semester: curriculumMeta.semester || null,
                unit: curriculumMeta.unit || null,
              }
            : {}),
        });
        const qsSnap = await getDocs(collection(db, 'exams', editingExamId, 'questions'));
        await Promise.all(qsSnap.docs.map((d) => deleteDoc(d.ref)));
        for (const p of flatProblems) {
          await setDoc(
            doc(db, 'exams', editingExamId, 'questions', String(p.number)),
            questionDocData(p),
          );
        }
        examIdSaved = editingExamId;
      } else {
        const examRef = await addDoc(collection(db, 'exams'), {
          createdBy: teacherUser?.uid || 'anonymous',
          examGrade,
          title: examTitle.trim(),
          questionCount: flatProblems.length,
          createdAt: new Date().toISOString(),
          source: 'unit-test-upload',
          ...examLinkFields,
          ...(curriculumMeta && curriculumMeta.grade
            ? {
                grade: curriculumMeta.grade,
                semester: curriculumMeta.semester || null,
                unit: curriculumMeta.unit || null,
              }
            : {}),
        });
        examIdSaved = examRef.id;
        for (const p of flatProblems) {
          await setDoc(
            doc(db, 'exams', examRef.id, 'questions', String(p.number)),
            questionDocData(p),
          );
        }
      }

      setSavedId(examIdSaved);
      localStorage.removeItem('unitTestProblems');
      localStorage.removeItem('unitTestTitle');
      localStorage.removeItem('unitTestGrade');
      localStorage.removeItem('unitTestCurriculum');
      localStorage.removeItem('unitTestTempSavedAt');
      setDone(true);
    } catch (err) {
      setError('저장 오류: ' + err.message);
    }
    setSaving(false);
  };

  // ── 완료 화면 ──
  if (done) {
    return (
      <div className="ocr-processing-container">
        <HudFrame className="ocr-processing-hud">
          <div className="ocr-processing-icon">🎉</div>
          <h2 className="ocr-processing-title">저장 완료!</h2>
          <p className="ocr-processing-msg"><strong>{examTitle}</strong>이(가) 저장되었습니다.</p>
          <p className="ocr-processing-sub">총 <strong>{problems.length}</strong>문항</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 28 }}>
            <button className="btn btn-primary" onClick={() => navigate(`/exam/${savedId}`)}>📋 문제 보기</button>
            <button className="btn btn-ghost"   onClick={() => navigate('/teacher')}>대시보드로</button>
          </div>
        </HudFrame>
      </div>
    );
  }

  const GRADES = ['초1', '초2', '초3', '초4', '초5', '초6'];
  const unanswered = problems.reduce((acc, p) => {
    if (p.type === 'group') {
      return acc + p.questions.filter((q) => isProblemAnswerEmpty(q)).length;
    }
    return acc + (isProblemAnswerEmpty(p) ? 1 : 0);
  }, 0);
  const totalQuestions = problems.reduce((acc, p) =>
    acc + (p.type === 'group' ? p.questions.length : 1), 0);

  return (
    <div className="dashboard-container">
      <PrecisionReviewChat
        open={precisionPanel != null}
        cropPreviewUrl={precisionPanel?.payload?.cropDataUrl}
        problemNumber={precisionPanel?.payload?.number}
        currentCore={precisionPanel?.payload?.baseline ?? null}
        onApply={handlePrecisionReviewApply}
        onClose={() => setPrecisionPanel(null)}
      />
      {/* ── 헤더 ── */}
      <header className="dashboard-header utr-header">
        <div className="header-left">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => navigate(editingExamId ? `/exam-bank` : '/unit-test')}
          >
            {editingExamId ? '← 문제 보관함' : '← 다시 업로드'}
          </button>
          <span style={{ fontSize: 26 }}>🔍</span>
          <div>
            <h1 className="header-title">검수 페이지</h1>
            <p className="header-subtitle">총 {totalQuestions}문항 · 정답 미입력 {unanswered}개</p>
          </div>
        </div>

        <div className="header-right utr-header-right">
          {/* 학년 선택 */}
          <div className="review-grade-row">
            <span className="review-grade-label">학년</span>
            {GRADES.map(g => (
              <button
                key={g}
                className={`review-grade-btn ${examGrade === g ? 'active' : ''}`}
                onClick={() => setExamGrade(g)}
              >
                {g}
              </button>
            ))}
          </div>

          <button
            className="btn btn-primary"
            onClick={saveToFirestore}
            disabled={saving || !examGrade}
            title={!examGrade ? '학년을 선택해주세요' : ''}
          >
            {saving ? <><span className="spinner" /> 저장 중...</> : '저장'}
          </button>
        </div>
      </header>

      <main className="dashboard-main utr-main">
        <div className="utr-layout" ref={setUtrLayoutRef}>
          {problems.length > 0 && (
            <aside className="utr-qnav" aria-label="문항 번호 빠른 이동">
              <div className="utr-qnav-label">문항</div>
              <nav className="utr-qnav-inner">
                {navTargets.map((t) => (
                  <button
                    key={t.anchorId}
                    type="button"
                    className="utr-qnav-btn"
                    onClick={() => scrollToUtrAnchor(t.anchorId)}
                  >
                    {t.label}
                  </button>
                ))}
              </nav>
            </aside>
          )}
          <div className="utr-layout-content">
        {error && (
          <div className="alert alert-error">
            ⚠️ {error}
            <button type="button" className="alert-close" onClick={() => setError('')}>×</button>
          </div>
        )}

        {/* 툴바 */}
        <div className="utr-toolbar">
          <input
            className="form-input utr-title-input-sm"
            value={examTitle}
            onChange={e => setExamTitle(e.target.value)}
            placeholder="시험지 제목"
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <span className="utr-count-badge">{totalQuestions}문항</span>
            <button type="button" className="btn btn-outline btn-sm" onClick={renumber} title="1번부터 순서대로 번호 재정렬">
              🔢 번호 재정렬
            </button>
            <button type="button" className="btn btn-outline btn-sm" onClick={addGroup} title="공통 보기가 있는 묶음 문제 추가">
              🗂️ 묶음 추가
            </button>
          </div>
        </div>

        {problems.length > 0 && (
          <p className="utr-drag-hint">
            ✏️ 문항 카드 왼쪽 위 번호 옆 연필로 번호를 바꾸면 전체 순서가 번호 오름차순으로 다시 정렬됩니다 · ⠿ 핸들 드래그로 순서 변경 가능 · 각 필드를 직접 수정하세요
          </p>
        )}

        {/* 문항 카드 목록 */}
        {problems.length === 0 ? (
          <div className="utr-empty">
            <p>불러온 문항이 없습니다.</p>
            <button type="button" className="btn btn-primary" onClick={() => navigate('/unit-test')}>
              업로드 페이지로
            </button>
          </div>
        ) : (
          <div className="utr-card-list">
            {problems.map((p, i) => (
              <div
                key={p._utrRowId ?? `${p.type === 'group' ? 'g' : 'q'}-${i}`}
                className="utr-item-wrap"
              >
                <div className="utr-move-btns">
                  <button
                    type="button"
                    className="utr-move-btn"
                    onClick={() => moveItem(i, -1)}
                    disabled={i === 0}
                    title="위로 이동"
                  >▲</button>
                  <button
                    type="button"
                    className="utr-move-btn"
                    onClick={() => moveItem(i, 1)}
                    disabled={i === problems.length - 1}
                    title="아래로 이동"
                  >▼</button>
                </div>
                {p.type === 'group' ? (
                  <ProblemGroupCard
                    group={p}
                    idx={i}
                    onUpdate={updateProblem}
                    onDelete={deleteProblem}
                    onPrecisionReviewRequest={openPrecisionReviewPanel}
                    onTogglePrecisionCompare={togglePrecisionCompare}
                  />
                ) : p.problemType === '선잇기' ? (
                  <MatchingCard
                    problem={p}
                    idx={i}
                    onUpdate={updateProblem}
                    onDelete={deleteProblem}
                    anchorId={utrAnchorId(p._utrRowId)}
                    onPrecisionReviewRequest={openPrecisionReviewPanel}
                    onTogglePrecisionCompare={togglePrecisionCompare}
                  />
                ) : (
                  <ProblemCard
                    problem={p}
                    idx={i}
                    total={problems.length}
                    onUpdate={updateProblem}
                    onDelete={deleteProblem}
                    anchorId={utrAnchorId(p._utrRowId)}
                    onPrecisionReviewRequest={openPrecisionReviewPanel}
                    onTogglePrecisionCompare={togglePrecisionCompare}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {/* 하단 완료 버튼 */}
        {problems.length > 0 && (
          <div className="utr-footer-btns">
            <button
              type="button"
              className="btn btn-primary btn-large"
              onClick={saveToFirestore}
              disabled={saving || !examGrade}
              title={!examGrade ? '상단에서 학년을 선택해주세요' : ''}
            >
              {saving ? <><span className="spinner" /> 저장 중...</> : '저장'}
            </button>
          </div>
        )}
          </div>

          <ReviewMathToolsSidebar
            mathOpen={reviewMathOpen}
            onToggleMath={toggleReviewMathPanel}
            onMathTogglePointerDown={onReviewMathTogglePointerDown}
            onInsertMathScript={insertReviewMathFromScript}
            onPickSymbol={insertReviewSymbol}
          />
        </div>
      </main>
    </div>
  );
}
