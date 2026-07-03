import React, { useState, useEffect, useCallback, useRef } from 'react';
import { elementaryScriptToLatex, tryParseLatexForElementaryEditor } from '../utils/elementaryMathScript';
import { normalizeVerticalArithmeticRow } from '../utils/verticalArithmeticCells';
import './ElementaryMathOverlay.css';

const LADDER_INITIAL_CELLS = 2; // 기본 피제수 칸 수 (나누는 수 제외)

/** @type {{ divisor: string; dividend: string; quotient: string; steps: string[] }} */
const EMPTY_LONGDIV = { divisor: '', dividend: '', quotient: '', steps: [] };

/** 곱셈 세로셈 초기 행 (피승수, 승수, 최종 곱) */
const MULTVERT_INITIAL_ROWS = ['', '', ''];

/** MULTVERT·LONGDIV 행 입력 — 스크립트 구분자(`{}#\"`)·줄바꿈만 제외. 숫자·ㄱㄴㄷ·㉠·빈칸 허용 */
function sanitizeVerticalRowInput(raw) {
  return Array.from(String(raw ?? ''))
    .filter((ch) => ch !== '{' && ch !== '}' && ch !== '#' && ch !== '"' && ch !== '\n' && ch !== '\r')
    .join('');
}

/** @deprecated — sanitizeVerticalRowInput 와 동일 */
function sanitizeMultVertRowInput(raw) {
  return sanitizeVerticalRowInput(raw);
}

/** @deprecated — sanitizeVerticalRowInput 와 동일 */
function sanitizeLdRowInput(raw) {
  return sanitizeVerticalRowInput(raw);
}

const LD_MIN_COLS = 3;

/** @param {string} val @param {number} cols */
function ldCellsFromVal(val, cols) {
  const chars = Array.from(val);
  return Array.from({ length: cols }, (_, ci) => {
    const fromRight = cols - 1 - ci;
    return fromRight < chars.length ? chars[chars.length - 1 - fromRight] : '';
  });
}

/** @param {string} s */
function ldColCount(s) {
  return Math.max(LD_MIN_COLS, Array.from(s).length);
}
// row 0: 피승수, row 1: 승수(× 기호), row 2+: 부분곱·최종 곱
// opRow(1)부터 2행마다 굵은 구분선 (× 행 아래, 부분곱 2행 아래, …)

/**
 * @param {string} templateId
 * @param {{ values?: string[]; longDiv?: typeof EMPTY_LONGDIV; ladderRows?: Array<{type:'bracket';divisor:string;cells:string[]}|{type:'final';cells:string[]}>; multRows?: string[]; multCols?: number; multDivLine?: number; multOpRow?: number }} opts
 */
export function buildElementaryMathScript(templateId, opts) {
  const { values = [], longDiv = EMPTY_LONGDIV, ladderRows = [], multRows = [], multCols = 4, multDivLine = 1, multOpRow = 1 } = opts;
  if (templateId === 'fraction') {
    return `{${values[0]}} over {${values[1]}}`;
  }
  if (templateId === 'mixed') {
    return `{${values[0]}} {${values[1]}} over {${values[2]}}`;
  }
  if (templateId === 'longdiv') {
    const stepList = longDiv.steps || [];
    const stepsStr = stepList.length > 0
      ? ` STEPS {${stepList.map((s) => normalizeVerticalArithmeticRow(String(s ?? '').trim())).join('#')}}`
      : '';
    const d = normalizeVerticalArithmeticRow(longDiv.divisor);
    const n = normalizeVerticalArithmeticRow(longDiv.dividend);
    const q = normalizeVerticalArithmeticRow(longDiv.quotient);
    return `LONGDIV {${d}} {${n}} {${q}}${stepsStr}`;
  }
  if (templateId === 'bar') {
    return `bar {${values[0]}}`;
  }
  if (templateId === 'ladder') {
    const lines = ladderRows
      .map(row => {
        const all = row.type === 'bracket'
          ? [row.divisor, ...row.cells]
          : ['', ...row.cells];
        return all.map(c => c.trim()).join(' & ');
      })
      .filter(line => line.replace(/&/g, '').trim().length > 0);
    if (lines.length === 0) return '';
    return `LADDER { ${lines.join(' # ')} }`;
  }
  if (templateId === 'multvert') {
    const rowStr = multRows.map((r) => normalizeVerticalArithmeticRow(r)).join(' # ');
    return `MULTVERT { rows: "${rowStr}" ; cols: ${multCols} ; divLine: ${multDivLine} ; opRow: ${multOpRow} }`;
  }
  return '';
}

/** @type {{ id: string; label: string; slots?: number; kind?: string }[]} */
const TEMPLATES = [
  { id: 'fraction', label: '분수', slots: 2 },
  { id: 'mixed', label: '대분수', slots: 3 },
  { id: 'longdiv', label: '나눗셈 (세로셈)', slots: 3 },
  { id: 'multvert', label: '곱셈 (세로셈)', kind: 'multvert' },
  { id: 'bar', label: '선분 기호', slots: 1 },
  { id: 'ladder', label: '약수/배수', kind: 'ladder' },
];

function defaultLadderRows() {
  const emptyCells = () => Array(LADDER_INITIAL_CELLS).fill('');
  return [
    { type: 'bracket', divisor: '', cells: emptyCells() },
    { type: 'final',                cells: emptyCells() },
  ];
}

function PickIcon({ templateId }) {
  switch (templateId) {
    case 'fraction':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-frac">
            <span className="emath-pick-b">▢</span>
            <span className="emath-pick-line" />
            <span className="emath-pick-b">▢</span>
          </span>
        </span>
      );
    case 'mixed':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-mixed">
            <span className="emath-pick-b emath-pick-mixed-whole">▢</span>
            <span className="emath-pick-frac">
              <span className="emath-pick-b">▢</span>
              <span className="emath-pick-line" />
              <span className="emath-pick-b">▢</span>
            </span>
          </span>
        </span>
      );
    case 'longdiv':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-longdiv-parenico">
            <span className="emath-pick-ld-d" />
            <span className="emath-pick-ld-paren">)</span>
            <span className="emath-pick-ld-stem">
              <span className="emath-pick-ld-topline" />
              <span className="emath-pick-ld-b" />
            </span>
          </span>
        </span>
      );
    case 'bar':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-bar" />
        </span>
      );
    case 'multvert':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-multvert-ico">
            <span className="emath-pick-mv-row">□ □ □</span>
            <span className="emath-pick-mv-row">× □ □</span>
            <span className="emath-pick-mv-divline" />
            <span className="emath-pick-mv-row">□ □ □</span>
          </span>
        </span>
      );
    case 'ladder':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-ladder-ico">
            <span className="emath-pick-ladder-corners">┕</span>
            <span className="emath-pick-ladder-twocells">
              <span className="emath-pick-ladder-mcell" />
              <span className="emath-pick-ladder-mcell" />
            </span>
          </span>
        </span>
      );
    default:
      return null;
  }
}

/**
 * @param {{ open: boolean; onClose: () => void; onConfirm: (script: string) => void; initialLatex?: string; title?: string; variant?: 'modal' | 'sidebar' }} p
 */
export default function ElementaryMathOverlay({
  open,
  onClose,
  onConfirm,
  initialLatex = '',
  title = '수식 입력',
  variant = 'modal',
}) {
  const [activeId, setActiveId] = useState(/** @type {string} */ ('fraction'));
  const [values, setValues] = useState(() => ['', '', '']);
  const [longDiv, setLongDiv] = useState(() => ({ ...EMPTY_LONGDIV }));
  const [ladderRows, setLadderRows] = useState(defaultLadderRows);
  const [localErr, setLocalErr] = useState('');
  const ladderRefMatrix = useRef(/** @type {(HTMLInputElement | null)[][]} */ ([]));
  const ldRefs = useRef(/** @type {(HTMLInputElement|null)[]} */ ([])); // [0]=몫,[1]=제수,[2]=피제수,[3+si]=중간과정

  // ── 곱셈 세로셈 상태 ──
  // rows[0]=피승수, rows[1]=승수(× 행), rows[2~]=부분곱·합계
  const [multRows, setMultRows] = useState(() => [...MULTVERT_INITIAL_ROWS]);
  // 열 수 (가장 긴 행 기준, 최소 4)
  const [multCols, setMultCols] = useState(1);
  const multRowRefs = useRef(/** @type {(HTMLInputElement|null)[]} */ ([]));

  // multRows 변경 시 cols 자동 갱신 — 가장 긴 행의 글자 수만큼, 여유 없음
  useEffect(() => {
    const maxLen = Math.max(1, ...multRows.map(r => Array.from(r).length));
    setMultCols(maxLen);
  }, [multRows]);

  const resetFromInitial = useCallback(() => {
    setLocalErr('');
    const parsed = tryParseLatexForElementaryEditor(initialLatex);

    if (parsed) {
      // LONGDIV: longDiv 키로 반환
      if (parsed.templateId === 'longdiv' && 'longDiv' in parsed) {
        setActiveId('longdiv');
        setLongDiv({ ...(/** @type {any} */ (parsed).longDiv) });
        setValues(['', '', '']);
        setLadderRows(defaultLadderRows());
        return;
      }
      if (parsed.templateId === 'multvert' && 'multRows' in parsed) {
        setActiveId('multvert');
        setValues(['', '', '']);
        setLongDiv({ ...EMPTY_LONGDIV });
        setLadderRows(defaultLadderRows());
        let rows = [...(/** @type {any} */ (parsed).multRows || [])];
        while (rows.length < 3) rows.push('');
        setMultRows(rows);
        return;
      }
      // fraction / mixed / bar: values 키로 반환
      if ('values' in parsed && parsed.values) {
        setActiveId(parsed.templateId);
        if (parsed.templateId === 'fraction') {
          setValues([parsed.values[0] || '', parsed.values[1] || '', '']);
        } else if (parsed.templateId === 'mixed') {
          setValues([parsed.values[0] || '', parsed.values[1] || '', parsed.values[2] || '']);
        } else if (parsed.templateId === 'bar') {
          setValues([parsed.values[0] || '', '', '']);
        }
        setLongDiv({ ...EMPTY_LONGDIV });
        setLadderRows(defaultLadderRows());
        return;
      }
    }

    setActiveId('fraction');
    setValues(['', '', '']);
    setLongDiv({ ...EMPTY_LONGDIV });
    setLadderRows(defaultLadderRows());
    setMultRows([...MULTVERT_INITIAL_ROWS]);
  }, [initialLatex]);

  useEffect(() => {
    if (open) {
      resetFromInitial();
    }
  }, [open, resetFromInitial]);

  const focusLadderCell = useCallback((r, c) => {
    const el = ladderRefMatrix.current[r]?.[c];
    if (el) {
      el.focus();
      el.select?.();
    }
  }, []);

  const onPickTemplate = useCallback((id) => {
    setActiveId(id);
    setLocalErr('');
    const t = TEMPLATES.find((x) => x.id === id);
    if (t?.kind === 'ladder') {
      setLadderRows(defaultLadderRows());
      return;
    }
    if (t?.kind === 'multvert') {
      setMultRows([...MULTVERT_INITIAL_ROWS]);
      return;
    }
    if (id === 'longdiv') {
      setLongDiv((prev) => ({
        divisor: prev.divisor || '',
        dividend: prev.dividend || '',
        quotient: prev.quotient || '',
        steps: prev.steps || [],
      }));
    }
    const slots = t?.slots ?? 2;
    setValues((prev) => {
      const next = ['', '', ''];
      for (let i = 0; i < slots; i++) next[i] = i < prev.length ? prev[i] : '';
      return next;
    });
  }, []);

  const onLadderKeyDown = useCallback(
    (e, r, c) => {
      const totalCols = ladderRows[0]?.cells?.length ?? LADDER_INITIAL_CELLS;
      const totalRows = ladderRows.length;
      const isLastRow = (ri) => ladderRows[ri]?.type === 'final';
      const minCol    = (ri) => isLastRow(ri) ? 1 : 0;

      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          if (c > minCol(r)) focusLadderCell(r, c - 1);
          else if (r > 0) focusLadderCell(r - 1, totalCols);
        } else {
          if (c < totalCols) focusLadderCell(r, c + 1);
          else if (r < totalRows - 1) focusLadderCell(r + 1, minCol(r + 1));
        }
      } else if (e.key === 'ArrowRight') {
        if (c < totalCols) { e.preventDefault(); focusLadderCell(r, c + 1); }
      } else if (e.key === 'ArrowLeft') {
        if (c > minCol(r)) { e.preventDefault(); focusLadderCell(r, c - 1); }
      } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (r < totalRows - 1) {
          focusLadderCell(r + 1, c === 0 ? minCol(r + 1) : c);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (r > 0) focusLadderCell(r - 1, c);
      }
    },
    [ladderRows, focusLadderCell]
  );

  const updateLadderCell = useCallback((r, c, v) => {
    setLadderRows(prev => {
      const copy = prev.map(row => ({ ...row, cells: [...row.cells] }));
      const row = copy[r];
      if (!row) return copy;
      if (c === 0 && row.type === 'bracket') {
        copy[r] = { ...row, divisor: v };
      } else {
        const ci = c - 1;
        const cells = [...row.cells];
        while (cells.length <= ci) cells.push('');
        cells[ci] = v;
        copy[r] = { ...row, cells };
      }
      return copy;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    setLocalErr('');
    let script = '';

    if (activeId === 'ladder') {
      script = buildElementaryMathScript('ladder', { ladderRows });
    } else if (activeId === 'multvert') {
      const hasContent = multRows.some(r => r.trim().length > 0);
      if (!hasContent) { setLocalErr('하나 이상의 칸에 글자나 숫자를 입력해 주세요.'); return; }
      script = buildElementaryMathScript('multvert', {
        multRows,
        multCols,
        multDivLine: 1,  // × 행(index 1) 아래 구분선
        multOpRow:   1,
      });
    } else if (activeId === 'longdiv') {
      const { divisor, dividend, quotient, steps } = longDiv;
      const hasContent = [divisor, dividend, quotient, ...(steps || [])].some(
        (s) => String(s).trim().length > 0,
      );
      if (!hasContent) {
        setLocalErr('하나 이상의 칸에 글자나 숫자를 입력해 주세요.');
        return;
      }
      script = buildElementaryMathScript('longdiv', { longDiv });
    } else {
      const v =
        activeId === 'fraction'
          ? [values[0], values[1]]
          : activeId === 'bar'
            ? [values[0]]
            : [values[0], values[1], values[2]];
      const empty = v.some((s) => !String(s).trim());
      if (empty) {
        setLocalErr('입력 칸을 모두 채워 주세요.');
        return;
      }
      script = buildElementaryMathScript(activeId, { values: v });
    }

    if (!script.trim()) {
      setLocalErr('입력할 내용이 없어요.');
      return;
    }
    const latex = elementaryScriptToLatex(script);
    if (!latex.trim()) {
      setLocalErr('수식을 만들 수 없어요. 입력을 확인해 주세요.');
      return;
    }
    onConfirm(script);
    if (variant === 'modal') onClose();
  }, [activeId, values, ladderRows, longDiv, multRows, multCols, onConfirm, onClose, variant]);

  const onRootKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  if (!open) return null;

  const activeTemplate = TEMPLATES.find((t) => t.id === activeId);

  // ── LONGDIV: steps 배열만 필요 ──
  const ldSteps = longDiv.steps || [];

  const templatePicker = (
    <>
      <h2
        id="emath-overlay-title"
        className="emath-template-heading"
        style={{ margin: variant === 'sidebar' ? '0 0 10px' : '0 0 12px', fontSize: variant === 'sidebar' ? 15 : 17, color: '#0f172a' }}
      >
        수식 템플릿
      </h2>
      <div className={variant === 'sidebar' ? 'emath-template-grid emath-template-grid--sidebar' : 'emath-template-grid'}>
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`emath-template-pick ${activeId === t.id ? 'is-active' : ''}${variant === 'sidebar' ? ' emath-template-pick--compact' : ''}`}
            onClick={() => onPickTemplate(t.id)}
          >
            <PickIcon templateId={t.id} />
            <span className="emath-template-pick-label">{t.label}</span>
          </button>
        ))}
      </div>
    </>
  );

  const editorHead = (
    <div className="emath-overlay-editor-head">
      <span style={{ fontSize: variant === 'sidebar' ? 14 : 16, fontWeight: 700, color: '#1e293b' }}>{title}</span>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <button type="button" className="emath-btn-ghost" onClick={onClose}>
          {variant === 'sidebar' ? '접기' : '닫기'}
        </button>
        <button type="button" className="emath-btn-primary" onClick={handleSubmit}>
          수식 입력
        </button>
      </div>
    </div>
  );

  const editorBody = (
    <div className="emath-overlay-editor-body">
              {activeTemplate?.kind === 'multvert' ? (
                /* ── 곱셈 세로셈 에디터 ── */
                <div className="emath-multvert-wrap">
                  <p className="emath-hint-muted">
                    각 행에 글자를 입력하세요 (한 칸에 한 글자, 숫자·한글·영문 등). <strong>Enter/↓</strong>: 다음 행 · <strong>↑</strong>: 이전 행
                  </p>
                  <div className="emath-mv-table">
                    {multRows.map((rowVal, ri) => {
                      const isOpRow  = ri === 1;           // × 기호 행
                      const isDivRow = ri >= 1 && (ri - 1) % 2 === 0 && ri < multRows.length - 1;
                      const chars = Array.from(rowVal);
                      // 칸 배열: cols 수 만큼, 오른쪽 정렬 (한 글자 = 한 칸)
                      const cells = Array.from({ length: multCols }, (_, ci) => {
                        const fromRight = multCols - 1 - ci;
                        return fromRight < chars.length ? chars[chars.length - 1 - fromRight] : '';
                      });
                      return (
                        <div
                          key={ri}
                          className={`emath-mv-row${isDivRow ? ' emath-mv-row--divline' : ''}`}
                        >
                          {/* × 기호 or 공백 */}
                          <div className="emath-mv-op-cell">
                            {isOpRow ? '×' : ''}
                          </div>
                          {/* 글자 박스들 (시각) */}
                          {cells.map((d, ci) => (
                            <div
                              key={ci}
                              className={`emath-mv-digit${d ? ' has-digit' : ''}`}
                            >{d}</div>
                          ))}
                          {/* 숨겨진 input — 실제 편집 */}
                          <input
                            ref={el => { multRowRefs.current[ri] = el; }}
                            className="emath-mv-hidden-input"
                            type="text"
                            inputMode="text"
                            value={rowVal}
                            placeholder={ri === 0 ? '피승수' : ri === 1 ? '승수' : ri === multRows.length - 1 ? '최종 곱' : '부분 곱'}
                            onChange={e => {
                              const v = sanitizeVerticalRowInput(e.target.value);
                              setMultRows(prev => prev.map((r, i) => i === ri ? v : r));
                            }}
                            onKeyDown={e => {
                              if (e.key === 'Enter' || e.key === 'ArrowDown') {
                                e.preventDefault();
                                multRowRefs.current[Math.min(ri + 1, multRows.length - 1)]?.focus();
                              } else if (e.key === 'ArrowUp') {
                                e.preventDefault();
                                multRowRefs.current[Math.max(ri - 1, 0)]?.focus();
                              } else if (e.key === 'Backspace' && rowVal === '') {
                                // 빈 행에서 Backspace → 행 삭제 (최소 3행 유지)
                                if (multRows.length > 3) {
                                  e.preventDefault();
                                  setMultRows(prev => prev.filter((_, i) => i !== ri));
                                  queueMicrotask(() => multRowRefs.current[Math.max(ri - 1, 0)]?.focus());
                                }
                              }
                            }}
                            aria-label={`${ri + 1}번 행`}
                          />
                        </div>
                      );
                    })}
                  </div>
                  {/* 행 추가 버튼 */}
                  <button
                    type="button"
                    className="emath-mv-add-row"
                    onClick={() => {
                      setMultRows(prev => [...prev, '']);
                      queueMicrotask(() => multRowRefs.current[multRows.length]?.focus());
                    }}
                  >
                    + 행 추가
                  </button>
                </div>
              ) : activeTemplate?.kind === 'ladder' ? (
                <div className="emath-ladder-wrap">
                  <p className="emath-hint-muted">
                    <strong>Tab/→</strong>: 다음 칸 &nbsp;·&nbsp; <strong>Enter/↓</strong>: 다음 행 &nbsp;·&nbsp; 각 행 <strong>[+]</strong>: 전체 열 추가
                  </p>
                  <div className="emath-ladder-rows-new">
                    {ladderRows.map((row, r) => {
                      const isFinal   = row.type === 'final';
                      const totalCols = row.cells.length;
                      return (
                        <div key={r} className="emath-ladder-row-new">
                          {/* 나누는 수 영역 — final 행은 빈 공간으로 열 정렬 유지 */}
                          <div className="emath-ladder-divisor-area">
                            {!isFinal && (
                              <input
                                ref={el => { if (!ladderRefMatrix.current[r]) ladderRefMatrix.current[r] = []; ladderRefMatrix.current[r][0] = el; }}
                                className="emath-ladder-digit emath-ladder-digit--divisor"
                                type="text"
                                inputMode="numeric"
                                value={row.divisor || ''}
                                onChange={e => {
                                  updateLadderCell(r, 0, e.target.value);
                                  const v = e.target.value || '';
                                  e.target.style.width = Math.max(2, v.length + 0.5) + 'em';
                                }}
                                onKeyDown={e => onLadderKeyDown(e, r, 0)}
                                aria-label={`${r + 1}행 나누는 수`}
                              />
                            )}
                          </div>
                          {/* ㄴ 브래킷 + 칸들 wrapper — final 행은 bracket 없이 숫자만 */}
                          <div className={isFinal ? 'emath-ladder-cells-only' : 'emath-ladder-bracket-wrap'}>
                            <div className="emath-ladder-cells">
                              {Array.from({ length: totalCols }, (_, ci) => (
                                <input
                                  key={ci}
                                  ref={el => { if (!ladderRefMatrix.current[r]) ladderRefMatrix.current[r] = []; ladderRefMatrix.current[r][ci + 1] = el; }}
                                  className="emath-ladder-digit"
                                  type="text"
                                  inputMode="numeric"
                                  value={row.cells[ci] || ''}
                                  onChange={e => {
                                    updateLadderCell(r, ci + 1, e.target.value);
                                    const v = e.target.value || '';
                                    e.target.style.width = Math.max(2, v.length + 0.5) + 'em';
                                  }}
                                  onKeyDown={e => onLadderKeyDown(e, r, ci + 1)}
                                  aria-label={`${r + 1}행 ${ci + 1}번 칸`}
                                />
                              ))}
                            </div>
                            {/* + 칸 추가: 전체 행 동시에 칸 1개 추가 */}
                            <button
                              type="button"
                              className="emath-ladder-add-col"
                              title="전체 행에 칸 1개 추가"
                              onClick={() =>
                                setLadderRows(prev =>
                                  prev.map(rw => ({ ...rw, cells: [...rw.cells, ''] }))
                                )
                              }
                            >+</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* + 행 추가: 현재 final 행을 bracket으로 전환 + 빈 final 행 append */}
                  <button
                    type="button"
                    className="emath-mv-add-row"
                    onClick={() => {
                      setLadderRows(prev => {
                        const lastIdx = prev.length - 1;
                        const last    = prev[lastIdx]; // 현재 final 행
                        // 현재 final → bracket (값 유지, 빈 divisor 추가)
                        const converted = { type: 'bracket', divisor: '', cells: [...last.cells] };
                        // 새 빈 final 행 (열 수 맞춤)
                        const newFinal  = { type: 'final', cells: Array(last.cells.length).fill('') };
                        const next = [...prev.slice(0, lastIdx), converted, newFinal];
                        queueMicrotask(() => ladderRefMatrix.current[lastIdx]?.[0]?.focus());
                        return next;
                      });
                    }}
                  >
                    + 행 추가
                  </button>
                </div>
              ) : activeId === 'fraction' ? (
                <div className="emath-vis-frac">
                  <label className="emath-vslot">
                    <input
                      className="emath-vslot-input"
                      inputMode="numeric"
                      value={values[0]}
                      onChange={(e) => setValues((p) => [e.target.value, p[1], p[2] ?? ''])}
                      aria-label="분자"
                    />
                  </label>
                  <span className="emath-vis-frac-bar" aria-hidden />
                  <label className="emath-vslot">
                    <input
                      className="emath-vslot-input"
                      inputMode="numeric"
                      value={values[1]}
                      onChange={(e) => setValues((p) => [p[0], e.target.value, p[2] ?? ''])}
                      aria-label="분모"
                    />
                  </label>
                </div>
              ) : activeId === 'mixed' ? (
                <div className="emath-vis-mixed">
                  <label className="emath-vslot">
                    <input
                      className="emath-vslot-input"
                      inputMode="numeric"
                      value={values[0]}
                      onChange={(e) => setValues((p) => [e.target.value, p[1], p[2] ?? ''])}
                      aria-label="정수"
                    />
                  </label>
                  <div className="emath-vis-mixed-frac">
                    <label className="emath-vslot">
                      <input
                        className="emath-vslot-input"
                        inputMode="numeric"
                        value={values[1]}
                        onChange={(e) => setValues((p) => [p[0], e.target.value, p[2] ?? ''])}
                        aria-label="분자"
                      />
                    </label>
                    <span className="emath-vis-frac-bar" aria-hidden />
                    <label className="emath-vslot">
                      <input
                        className="emath-vslot-input"
                        inputMode="numeric"
                        value={values[2]}
                        onChange={(e) => setValues((p) => [p[0], p[1], e.target.value])}
                        aria-label="분모"
                      />
                    </label>
                  </div>
                </div>
              ) : activeId === 'longdiv' ? (
                <div className="emath-longdiv-wrap">
                  <p className="emath-hint-muted">
                    각 행에 글자를 입력하세요 (한 칸에 한 글자, 숫자·ㄱㄴㄷ·㉠ 등). 빈 칸이 있어도 등록됩니다. <strong>Enter/↓</strong>: 다음 행 · <strong>↑</strong>: 이전 행
                  </p>
                  {(() => {
                    const ldCols = Math.max(
                      ldColCount(longDiv.quotient),
                      ldColCount(longDiv.dividend),
                      ...ldSteps.map((s) => ldColCount(s)),
                    );
                    const sideW = 36 * Math.max(1, Array.from(longDiv.divisor).length);
                    const qCells = ldCellsFromVal(longDiv.quotient, ldCols);
                    const nCells = ldCellsFromVal(longDiv.dividend, ldCols);

                    return (
                      <div className="emath-ld-table">
                        {/* 몫 */}
                        <div className="emath-ld-row">
                          <div
                            className="emath-ld-side-cell emath-ld-side-cell--spacer"
                            style={{ width: sideW, minWidth: sideW, maxWidth: sideW }}
                            aria-hidden="true"
                          />
                          <div className="emath-ld-paren-cell emath-ld-paren-cell--spacer" aria-hidden="true" />
                          <div className="emath-ld-digit-area">
                            {qCells.map((d, ci) => (
                              <div key={ci} className={`emath-mv-digit${d ? ' has-digit' : ''}`}>{d}</div>
                            ))}
                            <input
                              ref={(el) => { ldRefs.current[0] = el; }}
                              className="emath-ld-hidden-input"
                              type="text"
                              inputMode="text"
                              value={longDiv.quotient}
                              onChange={(e) =>
                                setLongDiv((p) => ({ ...p, quotient: sanitizeVerticalRowInput(e.target.value) }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === 'ArrowDown') {
                                  e.preventDefault();
                                  ldRefs.current[1]?.focus();
                                }
                              }}
                              aria-label="몫"
                            />
                          </div>
                        </div>

                        {/* 제수 + ) + 피제수 */}
                        <div className="emath-ld-row">
                          <div
                            className="emath-ld-side-cell"
                            style={{ width: sideW, minWidth: sideW, maxWidth: sideW }}
                          >
                            <input
                              ref={(el) => { ldRefs.current[1] = el; }}
                              className="emath-ld-side-input"
                              type="text"
                              inputMode="text"
                              value={longDiv.divisor}
                              onChange={(e) =>
                                setLongDiv((p) => ({ ...p, divisor: sanitizeVerticalRowInput(e.target.value) }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === 'ArrowDown') {
                                  e.preventDefault();
                                  ldRefs.current[2]?.focus();
                                } else if (e.key === 'ArrowUp') {
                                  e.preventDefault();
                                  ldRefs.current[0]?.focus();
                                }
                              }}
                              aria-label="나누는 수"
                            />
                          </div>
                          <div className="emath-ld-paren-cell emath-ld-paren-cell--curve" aria-hidden="true" />
                          <div className="emath-ld-digit-area emath-ld-digit-area--hline">
                            {nCells.map((d, ci) => (
                              <div key={ci} className={`emath-mv-digit${d ? ' has-digit' : ''}`}>{d}</div>
                            ))}
                            <input
                              ref={(el) => { ldRefs.current[2] = el; }}
                              className="emath-ld-hidden-input"
                              type="text"
                              inputMode="text"
                              value={longDiv.dividend}
                              onChange={(e) =>
                                setLongDiv((p) => ({ ...p, dividend: sanitizeVerticalRowInput(e.target.value) }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === 'ArrowDown') {
                                  e.preventDefault();
                                  if (ldSteps.length === 0) {
                                    setLongDiv((p) => ({ ...p, steps: [''] }));
                                    queueMicrotask(() => ldRefs.current[3]?.focus());
                                  } else {
                                    ldRefs.current[3]?.focus();
                                  }
                                } else if (e.key === 'ArrowUp') {
                                  e.preventDefault();
                                  ldRefs.current[1]?.focus();
                                }
                              }}
                              aria-label="나뉘는 수"
                            />
                          </div>
                        </div>

                        {/* 중간과정 */}
                        {ldSteps.map((sv, si) => (
                          <div
                            key={si}
                            className={`emath-ld-row${si % 2 === 1 ? ' emath-ld-row--subline' : ''}`}
                          >
                            <div
                              className="emath-ld-side-cell emath-ld-side-cell--spacer"
                              style={{ width: sideW, minWidth: sideW, maxWidth: sideW }}
                              aria-hidden="true"
                            />
                            <div className="emath-ld-paren-cell emath-ld-paren-cell--spacer" aria-hidden="true" />
                            <div className="emath-ld-digit-area">
                              {ldCellsFromVal(sv, ldCols).map((d, ci) => (
                                <div key={ci} className={`emath-mv-digit${d ? ' has-digit' : ''}`}>{d}</div>
                              ))}
                              <input
                                ref={(el) => { ldRefs.current[3 + si] = el; }}
                                className="emath-ld-hidden-input"
                                type="text"
                                inputMode="text"
                                value={sv}
                                onChange={(e) => {
                                  const v = sanitizeVerticalRowInput(e.target.value);
                                  setLongDiv((p) => ({
                                    ...p,
                                    steps: p.steps.map((s, i) => (i === si ? v : s)),
                                  }));
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    if (si === ldSteps.length - 1) {
                                      setLongDiv((p) => ({ ...p, steps: [...p.steps, ''] }));
                                      queueMicrotask(() => ldRefs.current[3 + si + 1]?.focus());
                                    } else {
                                      ldRefs.current[3 + si + 1]?.focus();
                                    }
                                  } else if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    ldRefs.current[si === 0 ? 2 : 3 + si - 1]?.focus();
                                  } else if (e.key === 'Backspace' && sv === '') {
                                    e.preventDefault();
                                    setLongDiv((p) => ({ ...p, steps: p.steps.filter((_, i) => i !== si) }));
                                    queueMicrotask(() =>
                                      ldRefs.current[si === 0 ? 2 : 3 + si - 1]?.focus()
                                    );
                                  }
                                }}
                                aria-label={`${si + 1}번 중간과정`}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  <button
                    type="button"
                    className="emath-mv-add-row"
                    onClick={() => {
                      setLongDiv((p) => ({ ...p, steps: [...(p.steps || []), ''] }));
                      queueMicrotask(() => ldRefs.current[3 + ldSteps.length]?.focus());
                    }}
                  >
                    + 중간과정 추가
                  </button>
                </div>
              ) : activeId === 'bar' ? (
                <div className="emath-vis-bar">
                  <label className="emath-vslot">
                    <input
                      className="emath-vslot-input"
                      value={values[0]}
                      onChange={(e) => setValues((p) => [e.target.value, p[1], p[2] ?? ''])}
                      aria-label="선분 기호 위"
                      placeholder=""
                    />
                  </label>
                </div>
              ) : null}

              {localErr ? (
                <p className="emath-err" role="alert">
                  {localErr}
                </p>
              ) : null}
    </div>
  );

  if (variant === 'sidebar') {
    return (
      <div
        className="emath-sidebar-root"
        onKeyDown={onRootKeyDown}
        tabIndex={-1}
        role="region"
        aria-labelledby="emath-overlay-title"
      >
        <div className="emath-sidebar-stack">
          <div className="emath-sidebar-editor-wrap">
            {editorHead}
            {editorBody}
          </div>
          <div className="emath-sidebar-templates-wrap">{templatePicker}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="emath-overlay-root"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onRootKeyDown}
      tabIndex={-1}
    >
      <div
        className="emath-overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="emath-overlay-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="emath-overlay-split">
          <div className="emath-overlay-left">{templatePicker}</div>
          <div className="emath-overlay-right">
            {editorHead}
            {editorBody}
          </div>
        </div>
      </div>
    </div>
  );
}
