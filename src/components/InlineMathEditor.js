/**
 * contenteditable 본문 + «수식 넣기»(초등 수식 템플릿 오버레이) + 인라인 연산·단위 툴바. 원자 단위 블록(⟦UNIT:…⟧ 저장).
 */
import React, { useRef, useLayoutEffect, useCallback, useState, useMemo, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import katex from 'katex';
import {
  serializeContentEditable,
  hydrateContentEditable,
  createFrozenMathElement,
  updateFrozenMathElement,
  createAtomicUnitElement,
  createBarGraphChipElement,
  updateBarGraphChipElement,
  parseUnitDisplaySegments,
  unitCanonicalToKatexLatex,
  INLINE_MATH_FROZEN_CLASS,
  INLINE_ATOMIC_UNIT_CLASS,
} from '../utils/inlineMathStorage';
import {
  INLINE_BARGRAPH_CLASS,
  decodeBarGraphPayload,
  createDefaultBarGraphConfig,
} from '../utils/barGraphStorage';
import { BarGraphEditorModal, BarGraphPreview } from './BarGraphWidget';
import { elementaryScriptToLatex } from '../utils/elementaryMathScript';
import {
  copyPlainFromContentEditableSelection,
  mathTextToHybridEditDisplay,
  hybridEditDisplayToCanonical,
  isComplexLatexForPlainTransform,
  latexToPlain,
} from './ExamOCR';
import ElementaryMathOverlay from './ElementaryMathOverlay';
import { mathUnits, mathUnitCategoryOrder } from '../constants/mathUnits';
import './InlineMathEditor.css';

/** 기호 버튼에서 스크롤 제스처와 탭을 구분하기 위한 이동 임계값(px) */
const SYM_TOOLBAR_SCROLL_MOVE_PX = 25;
/** CSS `.inline-math-editor__unit-panel-scroll` gap과 동기 */
const SYM_TOOLBAR_SCROLL_GAP_PX = 14;

/** @param {Node} n */
function isEquationChip(n) {
  return (
    n?.nodeType === Node.ELEMENT_NODE &&
    /** @type {Element} */ (n).classList?.contains(INLINE_MATH_FROZEN_CLASS)
  );
}

/** @param {Node} n */
function isAtomicUnitChip(n) {
  return (
    n?.nodeType === Node.ELEMENT_NODE &&
    /** @type {Element} */ (n).classList?.contains(INLINE_ATOMIC_UNIT_CLASS)
  );
}

/** @param {Node} n */
function isBarGraphChip(n) {
  return (
    n?.nodeType === Node.ELEMENT_NODE &&
    /** @type {Element} */ (n).classList?.contains(INLINE_BARGRAPH_CLASS)
  );
}

/** @param {Node} n */
function isAtomicInlineBlock(n) {
  return isEquationChip(n) || isAtomicUnitChip(n) || isBarGraphChip(n);
}

/**
 * @param {HTMLElement} root
 * @param {Range} range
 * @returns {HTMLElement | null}
 */
function getAtomicBlockBeforeCaret(root, range) {
  if (!range.collapsed) return null;
  const { startContainer, startOffset } = range;
  if (startContainer === root) {
    if (startOffset === 0) return null;
    const prev = root.childNodes[startOffset - 1];
    return isAtomicInlineBlock(prev) ? /** @type {HTMLElement} */ (prev) : null;
  }
  if (startContainer.nodeType === Node.TEXT_NODE) {
    if (startOffset > 0) return null;
    const prev = startContainer.previousSibling;
    return isAtomicInlineBlock(prev) ? /** @type {HTMLElement} */ (prev) : null;
  }
  return null;
}

/**
 * @param {HTMLElement} root
 * @param {Range} range
 * @returns {HTMLElement | null}
 */
function getAtomicBlockAfterCaret(root, range) {
  if (!range.collapsed) return null;
  const { startContainer, startOffset } = range;
  if (startContainer === root) {
    if (startOffset >= root.childNodes.length) return null;
    const next = root.childNodes[startOffset];
    return isAtomicInlineBlock(next) ? /** @type {HTMLElement} */ (next) : null;
  }
  if (startContainer.nodeType === Node.TEXT_NODE) {
    const len = startContainer.textContent?.length ?? 0;
    if (startOffset < len) return null;
    const next = startContainer.nextSibling;
    return isAtomicInlineBlock(next) ? /** @type {HTMLElement} */ (next) : null;
  }
  return null;
}

/**
 * @param {HTMLElement} chip
 * @param {HTMLElement} editable
 */
function selectAfterChip(chip, editable) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  const next = chip.nextSibling;
  if (next && next.nodeType === Node.TEXT_NODE) {
    r.setStart(next, 0);
    r.collapse(true);
  } else if (next) {
    r.setStartBefore(next);
    r.collapse(true);
  } else {
    const z = document.createTextNode('');
    chip.after(z);
    r.setStart(z, 0);
    r.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(r);
  editable.focus();
}

/**
 * @param {HTMLElement} editable
 * @param {string} text
 */
function insertPlainAtCaret(editable, text) {
  if (!text) return;
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
  range.insertNode(document.createTextNode(text));
  range.setStartAfter(range.endContainer);
  if (
    range.endContainer.nodeType === Node.TEXT_NODE &&
    range.endOffset < (range.endContainer.textContent || '').length
  ) {
    range.setStart(range.endContainer, range.endOffset);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * @param {HTMLElement | null} editable
 * @param {HTMLElement} node
 */
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

const ZWSP = '\u200B';

/**
 * 원자 단위 바로 뒤에 붙은 ZWSP(삽입 시 넣은 것)만 제거한다.
 * @param {HTMLElement} chip
 */
function stripLeadingZwspAfterAtomicUnit(chip) {
  if (!isAtomicUnitChip(chip)) return null;
  const next = chip.nextSibling;
  if (!next || next.nodeType !== Node.TEXT_NODE) return null;
  const t = next.textContent || '';
  if (!t.startsWith(ZWSP)) return next;
  const rest = t.slice(ZWSP.length);
  if (rest === '') {
    next.remove();
    return null;
  }
  next.textContent = rest;
  return next;
}

/**
 * 원자 단위 삽입 후 한글 IME 자모 분리 완화를 위해 ZWSP를 단위 바로 뒤에 둔다.
 * @param {HTMLElement | null} editable
 * @param {string} unit
 */
function insertAtomicUnitAtCaret(editable, unit) {
  if (!editable) return;
  const span = createAtomicUnitElement(unit);
  insertNodeAtCaret(editable, span);
  const tail = document.createTextNode(ZWSP);
  span.after(tail);
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.setStart(tail, tail.length);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  editable.focus();
}

/**
 * @param {HTMLElement | null} editable
 * @param {string} latex
 */
function insertFrozenMathAtCaret(editable, latex) {
  if (!editable || !latex.trim()) return;
  insertNodeAtCaret(editable, createFrozenMathElement(latex.trim()));
}

/**
 * @param {HTMLElement | null} editable
 * @param {import('../utils/barGraphStorage').BarGraphConfig} config
 */
function insertBarGraphAtCaret(editable, config) {
  if (!editable) return;
  insertNodeAtCaret(editable, createBarGraphChipElement(config));
}

/**
 * @param {HTMLElement | null} editable
 * @param {string} latex
 * @param {boolean} hybridPlainMath
 */
function insertLatexAtCaret(editable, latex, hybridPlainMath) {
  const trimmed = String(latex ?? '').trim();
  if (!editable || !trimmed) return;
  if (hybridPlainMath && !isComplexLatexForPlainTransform(trimmed)) {
    insertPlainAtCaret(editable, latexToPlain(trimmed));
    return;
  }
  insertFrozenMathAtCaret(editable, trimmed);
}

/** 넓이/부피: $ \\mathrm{mm}^{2} $ 형태를 KaTeX로 표시 (HTML sup 대신) */
/** @param {{ unit: string }} p */
function ToolbarAreaVolumeKatexLabel({ unit }) {
  const html = useMemo(() => {
    const latex = unitCanonicalToKatexLatex(unit);
    return katex.renderToString(latex, {
      throwOnError: false,
      displayMode: false,
      strict: 'ignore',
    });
  }, [unit]);
  return (
    <span
      className="inline-math-editor__sym-katex-label"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** @param {{ symbol: string }} p */
function ToolbarSymbolLabel({ symbol }) {
  return (
    <span className="inline-math-editor__sym-label">
      {parseUnitDisplaySegments(symbol).map((part, idx) =>
        part.type === 'text' ? (
          <React.Fragment key={`${symbol}-t-${idx}`}>{part.v}</React.Fragment>
        ) : (
          <sup key={`${symbol}-s-${idx}`} className="inline-math-editor__sym-sup">
            {part.v}
          </sup>
        )
      )}
    </span>
  );
}

/** 카테고리 키(예: '길이/들이')는 유지하되, 화면에는 '/' 없이 두 줄로 표시 */
/** @param {{ category: string }} p */
function CategoryToolbarLabel({ category }) {
  const c = String(category);
  const i = c.indexOf('/');
  if (i === -1) return <>{c}</>;
  return (
    <span className="inline-math-editor__cat-btn-label">
      <span className="inline-math-editor__cat-btn-line">{c.slice(0, i)}</span>
      <span className="inline-math-editor__cat-btn-line">{c.slice(i + 1)}</span>
    </span>
  );
}

/**
 * @param {object} props
 * @param {string} props.value
 * @param {(s: string) => void} props.onChange
 * @param {string} [props.placeholder]
 * @param {boolean} [props.multiline]
 * @param {boolean} [props.compact]
 * @param {'insert' | 'none'} [props.toolbar]
 * @param {boolean} [props.enableGraphInsert] 막대그래프 넣기 (새 문제 만들기 등)
 * @param {string} [props.className]
 * @param {(api: null | { insertElementaryFromLatex: (latex: string) => void; insertReviewChunk: (chunk: string) => void }) => void} [props.registerInsertBridge] 단원평가 검수 등: 우측 패널에서 이 에디터로 삽입
 * @param {React.MutableRefObject<Range | null>} [props.savedCaretRangeRef] 사이드바 클릭 직전 커서 복원(부모가 mousedown 시 clone)
 * @param {boolean} [props.hybridPlainMath] true면 단순 사칙연산은 보라 수식 칩 대신 일반 글자로 편집
 */
export default function InlineMathEditor({
  value,
  onChange,
  placeholder = '글을 쓰고 아래에서 기호·단위를 넣을 수 있어요. «수식 넣기»로 수식 블록을 넣어 보세요.',
  multiline = true,
  compact = false,
  className = '',
  toolbar = 'insert',
  enableGraphInsert = false,
  registerInsertBridge,
  savedCaretRangeRef,
  hybridPlainMath = false,
}) {
  const editableRef = useRef(null);
  const lastEmitted = useRef(value);
  const editTargetRef = useRef(null);

  const [mathModalOpen, setMathModalOpen] = useState(false);
  const [overlayInitialLatex, setOverlayInitialLatex] = useState('');
  const [modalMode, setModalMode] = useState(/** @type {'insert' | 'edit'} */ ('insert'));
  const [graphModalOpen, setGraphModalOpen] = useState(false);
  const [graphInitialConfig, setGraphInitialConfig] = useState(null);
  /** @type {React.MutableRefObject<HTMLDivElement | null>} */
  const graphEditTargetRef = useRef(null);
  const barGraphRootsRef = useRef(/** @type {import('react-dom/client').Root[]} */ ([]));
  const [expandedCategory, setExpandedCategory] = useState(/** @type {string | null} */ (null));
  const symScrollRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [symScrollNeeded, setSymScrollNeeded] = useState(false);
  const [symScrollEdges, setSymScrollEdges] = useState({ left: false, right: false });
  /** @type {React.MutableRefObject<{ active: boolean; startX: number; startY: number; movedTooMuch: boolean; pointerId: number }>} */
  const symGestureRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    movedTooMuch: false,
    pointerId: -1,
  });

  const emit = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;
    const s = serializeContentEditable(el);
    const out = hybridPlainMath ? hybridEditDisplayToCanonical(s, value) : s;
    if (out !== lastEmitted.current) {
      lastEmitted.current = out;
      onChange(out);
    }
  }, [onChange, hybridPlainMath, value]);

  const emitLatestRef = useRef(emit);
  emitLatestRef.current = emit;

  const onEditableFocusForBridge = useCallback(() => {
    if (!registerInsertBridge) return;
    const api = {
      /** @param {string} latex */
      insertElementaryFromLatex: (latex) => {
        const trimmed = String(latex ?? '').trim();
        if (!trimmed) return;
        const ed = editableRef.current;
        if (!ed) return;
        ed.focus();
        const sel = window.getSelection();
        const saved = savedCaretRangeRef?.current;
        if (sel && saved && ed.contains(saved.commonAncestorContainer)) {
          sel.removeAllRanges();
          sel.addRange(saved);
          savedCaretRangeRef.current = null;
        }
        insertLatexAtCaret(ed, trimmed, hybridPlainMath);
        emitLatestRef.current();
        window.requestAnimationFrame(() => {
          const e2 = editableRef.current;
          if (!e2) return;
          e2.focus();
          const chips = e2.querySelectorAll(`.${INLINE_MATH_FROZEN_CLASS}`);
          const last = chips[chips.length - 1];
          if (last) selectAfterChip(/** @type {HTMLElement} */ (last), e2);
        });
      },
      /** @param {string} chunk */
      insertReviewChunk: (chunk) => {
        if (!chunk) return;
        const ed = editableRef.current;
        if (!ed) return;
        ed.focus();
        const sel = window.getSelection();
        const saved = savedCaretRangeRef?.current;
        if (sel && saved && ed.contains(saved.commonAncestorContainer)) {
          sel.removeAllRanges();
          sel.addRange(saved);
          savedCaretRangeRef.current = null;
        }
        if (chunk.startsWith('⟦UNIT:')) {
          const m = chunk.match(/^⟦UNIT:([^⟧]+)⟧$/);
          if (m) {
            try {
              insertAtomicUnitAtCaret(ed, decodeURIComponent(m[1]));
            } catch {
              insertPlainAtCaret(ed, chunk);
            }
          } else {
            insertPlainAtCaret(ed, chunk);
          }
        } else {
          insertPlainAtCaret(ed, chunk);
        }
        emitLatestRef.current();
      },
    };
    registerInsertBridge(api);
  }, [registerInsertBridge, savedCaretRangeRef, hybridPlainMath]);

  const onEditableBlurForBridge = useCallback(
    (e) => {
      emit();
      if (!registerInsertBridge) return;
      const rt = /** @type {Node | null} */ (e.relatedTarget);
      if (rt instanceof Node) {
        if (
          rt.closest?.('.review-tools-sidebar') ||
          rt.closest?.('.emath-sidebar-root') ||
          rt.closest?.('.emath-overlay-panel')
        ) {
          return;
        }
      }
      registerInsertBridge(null);
    },
    [emit, registerInsertBridge],
  );

  const mountBarGraphChips = useCallback(() => {
    barGraphRootsRef.current.forEach((root) => {
      try {
        root.unmount();
      } catch {
        /* ignore */
      }
    });
    barGraphRootsRef.current = [];

    const el = editableRef.current;
    if (!el) return;
    el.querySelectorAll(`.${INLINE_BARGRAPH_CLASS}`).forEach((chip) => {
      const mount = chip.querySelector('[data-bar-graph-mount]');
      const payload = chip.getAttribute('data-bar-graph');
      const cfg = decodeBarGraphPayload(payload);
      if (!mount || !cfg) return;
      mount.replaceChildren();
      const root = createRoot(mount);
      root.render(<BarGraphPreview config={cfg} compact />);
      barGraphRootsRef.current.push(root);
    });
  }, []);

  useLayoutEffect(() => {
    const el = editableRef.current;
    if (!el) return;
    const hydrateVal = hybridPlainMath ? mathTextToHybridEditDisplay(value) : (value || '');
    const cur = serializeContentEditable(el);
    if (cur === hydrateVal) {
      mountBarGraphChips();
      return;
    }
    hydrateContentEditable(el, hydrateVal);
    lastEmitted.current = value || '';
    mountBarGraphChips();
  }, [value, hybridPlainMath, mountBarGraphChips]);

  useEffect(
    () => () => {
      barGraphRootsRef.current.forEach((root) => {
        try {
          root.unmount();
        } catch {
          /* ignore */
        }
      });
      barGraphRootsRef.current = [];
    },
    [],
  );

  const onInput = useCallback(() => {
    emit();
  }, [emit]);

  const onPaste = useCallback(
    (e) => {
      e.preventDefault();
      const t = e.clipboardData?.getData('text/plain') ?? '';
      insertPlainAtCaret(e.currentTarget, t);
      emit();
    },
    [emit]
  );

  const onEditablePointerDown = useCallback((e) => {
    const el = editableRef.current;
    if (!el) return;
    const t = e.target;
    if (t.nodeType !== Node.ELEMENT_NODE) return;
    const graphChip = /** @type {HTMLElement} */ (t).closest(`.${INLINE_BARGRAPH_CLASS}`);
    if (graphChip && el.contains(graphChip) && enableGraphInsert) {
      e.preventDefault();
      const payload = graphChip.getAttribute('data-bar-graph');
      setGraphInitialConfig(decodeBarGraphPayload(payload) || createDefaultBarGraphConfig());
      graphEditTargetRef.current = /** @type {HTMLDivElement} */ (graphChip);
      setGraphModalOpen(true);
      return;
    }
    const chip = /** @type {HTMLElement} */ (t).closest(`.${INLINE_MATH_FROZEN_CLASS}`);
    if (!chip || !el.contains(chip)) return;
    e.preventDefault();
    setOverlayInitialLatex(chip.getAttribute('data-latex') || '');
    editTargetRef.current = /** @type {HTMLSpanElement} */ (chip);
    setModalMode('edit');
    setMathModalOpen(true);
  }, [enableGraphInsert]);

  const onKeyDown = useCallback(
    (e) => {
      if (!multiline && e.key === 'Enter') {
        e.preventDefault();
        return;
      }
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      if (e.isComposing) return;
      const editable = editableRef.current;
      if (!editable) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
      const r = sel.getRangeAt(0);
      if (!editable.contains(r.commonAncestorContainer)) return;

      // 커서가 단위 뒤 ZWSP '안쪽'에 있을 때(offset>0): 한 번에 [단위+ZWSP] 삭제
      if (e.key === 'Backspace' && r.startContainer.nodeType === Node.TEXT_NODE) {
        const tn = /** @type {Text} */ (r.startContainer);
        const off = r.startOffset;
        if (off > 0 && (tn.textContent || '').charAt(off - 1) === ZWSP) {
          const chip = tn.previousSibling;
          if (isAtomicUnitChip(chip)) {
            e.preventDefault();
            const prevSib = chip.previousSibling;
            chip.remove();
            const t = tn.textContent || '';
            const merged = t.slice(0, off - 1) + t.slice(off);
            const nr = document.createRange();
            if (merged === '') {
              tn.remove();
              if (prevSib && prevSib.nodeType === Node.TEXT_NODE) {
                nr.setStart(prevSib, prevSib.textContent?.length ?? 0);
              } else if (prevSib) {
                nr.setStartAfter(prevSib);
              } else {
                const z = document.createTextNode('');
                editable.prepend(z);
                nr.setStart(z, 0);
              }
            } else {
              tn.textContent = merged;
              nr.setStart(tn, off - 1);
            }
            nr.collapse(true);
            sel.removeAllRanges();
            sel.addRange(nr);
            emit();
            return;
          }
        }
      }

      const blockBefore =
        e.key === 'Backspace' ? getAtomicBlockBeforeCaret(editable, r) : null;
      const blockAfter = e.key === 'Delete' ? getAtomicBlockAfterCaret(editable, r) : null;
      const block = blockBefore || blockAfter;
      if (!block) return;

      e.preventDefault();
      const next = block.nextSibling;
      const prev = block.previousSibling;
      if (isAtomicUnitChip(block)) stripLeadingZwspAfterAtomicUnit(block);
      block.remove();

      const nr = document.createRange();
      if (e.key === 'Backspace') {
        if (prev && prev.nodeType === Node.TEXT_NODE) {
          const len = prev.textContent?.length ?? 0;
          nr.setStart(prev, len);
          nr.collapse(true);
        } else if (next && next.isConnected && next.nodeType === Node.TEXT_NODE) {
          nr.setStart(next, 0);
          nr.collapse(true);
        } else {
          const z = document.createTextNode('');
          if (prev) prev.after(z);
          else editable.prepend(z);
          nr.setStart(z, 0);
          nr.collapse(true);
        }
      } else {
        if (next && next.isConnected && next.nodeType === Node.TEXT_NODE) {
          nr.setStart(next, 0);
          nr.collapse(true);
        } else if (prev && prev.nodeType === Node.TEXT_NODE) {
          const len = prev.textContent?.length ?? 0;
          nr.setStart(prev, len);
          nr.collapse(true);
        } else {
          const z = document.createTextNode('');
          editable.appendChild(z);
          nr.setStart(z, 0);
          nr.collapse(true);
        }
      }
      sel.removeAllRanges();
      sel.addRange(nr);

      emit();
    },
    [emit, multiline]
  );

  const openMathModal = useCallback(() => {
    editTargetRef.current = null;
    setOverlayInitialLatex('');
    setModalMode('insert');
    setMathModalOpen(true);
  }, []);

  const openGraphModal = useCallback(() => {
    graphEditTargetRef.current = null;
    setGraphInitialConfig(createDefaultBarGraphConfig());
    setGraphModalOpen(true);
  }, []);

  const closeGraphModal = useCallback(() => {
    setGraphModalOpen(false);
    graphEditTargetRef.current = null;
    editableRef.current?.focus();
  }, []);

  const confirmBarGraph = useCallback(
    (config) => {
      const editable = editableRef.current;
      const editTarget = graphEditTargetRef.current;
      if (editTarget && editable?.contains(editTarget)) {
        updateBarGraphChipElement(editTarget, config);
      } else if (editable) {
        insertBarGraphAtCaret(editable, config);
      }
      setGraphModalOpen(false);
      graphEditTargetRef.current = null;
      emit();
      window.requestAnimationFrame(() => {
        mountBarGraphChips();
        const ed = editableRef.current;
        if (!ed) return;
        if (editTarget && ed.contains(editTarget)) {
          selectAfterChip(editTarget, ed);
        } else {
          ed.focus();
        }
      });
    },
    [emit, mountBarGraphChips],
  );

  const closeMathModal = useCallback(() => {
    setMathModalOpen(false);
    editTargetRef.current = null;
    editableRef.current?.focus();
  }, []);

  const confirmElementaryMath = useCallback(
    (script) => {
      const latex = elementaryScriptToLatex(script).trim();
      if (!latex) return;

      const editable = editableRef.current;
      const editTarget = editTargetRef.current;

      if (editTarget && editable?.contains(editTarget)) {
        updateFrozenMathElement(editTarget, latex);
      } else if (editable) {
        insertLatexAtCaret(editable, latex, hybridPlainMath);
      }

      setMathModalOpen(false);
      editTargetRef.current = null;
      emit();

      window.requestAnimationFrame(() => {
        const ed = editableRef.current;
        if (!ed) return;
        if (editTarget && ed.contains(editTarget)) {
          selectAfterChip(editTarget, ed);
        } else {
          ed.focus();
        }
      });
    },
    [emit, hybridPlainMath]
  );

  const toggleCategory = useCallback((cat) => {
    setExpandedCategory((prev) => (prev === cat ? null : cat));
  }, []);

  const updateSymScrollEdges = useCallback(() => {
    const el = symScrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    const needs = maxScroll > 2;
    setSymScrollNeeded((prev) => (prev === needs ? prev : needs));
    const left = needs && scrollLeft > 4;
    const right = needs && maxScroll > 4 && scrollLeft < maxScroll - 4;
    setSymScrollEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useLayoutEffect(() => {
    if (!expandedCategory) {
      setSymScrollEdges({ left: false, right: false });
      setSymScrollNeeded(false);
      return;
    }
    const el = symScrollRef.current;
    if (el) el.scrollLeft = 0;
    updateSymScrollEdges();
    const ro = new ResizeObserver(() => updateSymScrollEdges());
    if (el) ro.observe(el);
    window.addEventListener('resize', updateSymScrollEdges);
    const t = window.setTimeout(updateSymScrollEdges, 380);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateSymScrollEdges);
      window.clearTimeout(t);
    };
  }, [expandedCategory, updateSymScrollEdges]);

  const scrollSymToolbar = useCallback((dir) => {
    const el = symScrollRef.current;
    if (!el) return;
    const btns = el.querySelectorAll('.inline-math-editor__sym-btn');
    const first = btns[0];
    const w = first ? first.getBoundingClientRect().width : 48;
    const gap = el.classList.contains('inline-math-editor__unit-panel-scroll--dense')
      ? 8
      : SYM_TOOLBAR_SCROLL_GAP_PX;
    const step = w * 3 + gap * 2;
    el.scrollBy({ left: dir * step, behavior: 'smooth' });
  }, []);

  const handleSymPointerDown = useCallback((e) => {
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    symGestureRef.current = {
      active: true,
      startX,
      startY,
      movedTooMuch: false,
      pointerId,
    };

    const onMove = (/** @type {PointerEvent} */ ev) => {
      const g = symGestureRef.current;
      if (!g.active || ev.pointerId !== pointerId) return;
      if (
        Math.hypot(ev.clientX - startX, ev.clientY - startY) >= SYM_TOOLBAR_SCROLL_MOVE_PX
      ) {
        g.movedTooMuch = true;
      }
    };

    const onEnd = (/** @type {PointerEvent} */ ev) => {
      const g = symGestureRef.current;
      if (ev.pointerId !== pointerId) return;
      g.active = false;
      if (ev.type === 'pointercancel') g.movedTooMuch = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }, []);

  const insertSymbolFromToolbar = useCallback(
    (symbol, mode) => {
      const ed = editableRef.current;
      if (!ed) return;
      if (mode === 'op') {
        insertPlainAtCaret(ed, symbol);
      } else {
        insertAtomicUnitAtCaret(ed, symbol);
      }
      emit();
      ed.focus();
    },
    [emit]
  );

  const handleSymClick = useCallback(
    (e, symbol, mode) => {
      if (symGestureRef.current.movedTooMuch) {
        e.preventDefault();
        e.stopPropagation();
        symGestureRef.current.movedTooMuch = false;
        return;
      }
      insertSymbolFromToolbar(symbol, mode);
    },
    [insertSymbolFromToolbar]
  );

  return (
    <div
      className={`inline-math-editor ${compact ? 'inline-math-editor--compact' : ''} ${className}`.trim()}
    >
      {toolbar === 'insert' && (
        <div className="inline-math-editor__toolbar inline-math-editor__toolbar--insert-only">
          <button
            type="button"
            className="inline-math-editor__btn inline-math-editor__btn--accent inline-math-editor__btn--wide"
            onMouseDown={(e) => e.preventDefault()}
            onClick={openMathModal}
          >
            ➕ 수식 넣기
          </button>
          {enableGraphInsert ? (
            <button
              type="button"
              className="inline-math-editor__btn inline-math-editor__btn--wide inline-math-editor__btn--graph"
              onMouseDown={(e) => e.preventDefault()}
              onClick={openGraphModal}
            >
              📊 그래프 넣기
            </button>
          ) : null}
          <p className="inline-math-editor__hint">
            아래 <strong>연산·단위</strong>를 펼쳐 넣거나, «수식 넣기»로 수식을 넣을 수 있어요.
            {enableGraphInsert ? ' «그래프 넣기»로 막대그래프를 문제 안에 넣을 수 있어요.' : ''}
          </p>
        </div>
      )}
      <div
        ref={editableRef}
        className={`inline-math-editable ${multiline ? '' : 'inline-math-editable--single'}`.trim()}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={onInput}
        onFocus={registerInsertBridge ? onEditableFocusForBridge : undefined}
        onBlur={registerInsertBridge ? onEditableBlurForBridge : onInput}
        onPaste={onPaste}
        onCopy={copyPlainFromContentEditableSelection}
        onPointerDownCapture={onEditablePointerDown}
        onKeyDown={onKeyDown}
      />

      {toolbar === 'insert' && (
        <div className="inline-math-editor__unit-toolbar" aria-label="연산 및 단위">
          <div className="inline-math-editor__unit-toolbar-inner">
            {mathUnitCategoryOrder.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`inline-math-editor__cat-btn ${expandedCategory === cat ? 'is-active' : ''}`}
                aria-label={cat}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleCategory(cat)}
              >
                <CategoryToolbarLabel category={cat} />
              </button>
            ))}
            <div
              className={`inline-math-editor__unit-panel ${expandedCategory ? 'is-open' : ''}`}
              aria-hidden={!expandedCategory}
            >
              {expandedCategory ? (
                <div
                  className={`inline-math-editor__sym-scroll-wrap${symScrollNeeded ? '' : ' inline-math-editor__sym-scroll-wrap--fit'}`.trim()}
                >
                  <div
                    ref={symScrollRef}
                    className={[
                      'inline-math-editor__unit-panel-scroll',
                      expandedCategory === '연산기호'
                        ? 'inline-math-editor__unit-panel-scroll--dense'
                        : '',
                      symScrollNeeded ? '' : 'inline-math-editor__unit-panel-scroll--fit',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onScroll={updateSymScrollEdges}
                  >
                    {(mathUnits[/** @type {keyof typeof mathUnits} */ (expandedCategory)] ?? []).map(
                      (sym) => (
                        <button
                          key={`${expandedCategory}-${sym}`}
                          type="button"
                          className="inline-math-editor__sym-btn"
                          onMouseDown={(e) => e.preventDefault()}
                          onPointerDown={handleSymPointerDown}
                          onClick={(e) =>
                            handleSymClick(e, sym, expandedCategory === '연산기호' ? 'op' : 'unit')
                          }
                        >
                          {expandedCategory === '넓이/부피' ? (
                            <ToolbarAreaVolumeKatexLabel unit={sym} />
                          ) : (
                            <ToolbarSymbolLabel symbol={sym} />
                          )}
                        </button>
                      )
                    )}
                  </div>
                  {symScrollNeeded ? (
                    <>
                      <button
                        type="button"
                        tabIndex={-1}
                        className={`inline-math-editor__sym-scroll-btn inline-math-editor__sym-scroll-btn--prev ${symScrollEdges.left ? 'is-visible' : ''}`}
                        aria-label="기호 목록 왼쪽으로 스크롤"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => scrollSymToolbar(-1)}
                      >
                        {'<'}
                      </button>
                      <button
                        type="button"
                        tabIndex={-1}
                        className={`inline-math-editor__sym-scroll-btn inline-math-editor__sym-scroll-btn--next ${symScrollEdges.right ? 'is-visible' : ''}`}
                        aria-label="기호 목록 오른쪽으로 스크롤"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => scrollSymToolbar(1)}
                      >
                        {'>'}
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {mathModalOpen && (
        <ElementaryMathOverlay
          open={mathModalOpen}
          onClose={closeMathModal}
          onConfirm={confirmElementaryMath}
          initialLatex={overlayInitialLatex}
          title={modalMode === 'edit' ? '수식 고치기' : '수식 입력'}
        />
      )}

      {enableGraphInsert && (
        <BarGraphEditorModal
          open={graphModalOpen}
          initialConfig={graphInitialConfig}
          onConfirm={confirmBarGraph}
          onCancel={closeGraphModal}
        />
      )}
    </div>
  );
}
