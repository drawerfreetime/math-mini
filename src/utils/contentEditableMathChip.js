/**
 * contenteditable 안의 편집 불가 수식·단위 칩 — Backspace/Delete 삭제
 */
import {
  INLINE_MATH_FROZEN_CLASS,
  INLINE_ATOMIC_UNIT_CLASS,
} from './inlineMathStorage';
import { INLINE_BARGRAPH_CLASS } from './barGraphStorage';

const ZWSP = '\u200B';

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
export function isAtomicInlineBlock(n) {
  return isEquationChip(n) || isAtomicUnitChip(n) || isBarGraphChip(n);
}

/**
 * @param {HTMLElement} root
 * @param {Range} range
 * @returns {HTMLElement | null}
 */
export function getAtomicBlockBeforeCaret(root, range) {
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
export function getAtomicBlockAfterCaret(root, range) {
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

/** @param {HTMLElement} chip */
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
 * @param {HTMLElement} chip
 * @param {HTMLElement} editable
 */
export function selectAfterChip(chip, editable) {
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
 * Backspace/Delete 로 수식·단위 칩 삭제.
 * @returns {boolean} 이벤트를 처리했으면 true
 */
export function handleContentEditableAtomicKeyDown(e, editable, onMutated) {
  if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
  if (e.isComposing) return false;
  if (!editable) return false;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const r = sel.getRangeAt(0);
  if (!editable.contains(r.commonAncestorContainer)) return false;

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
        onMutated?.();
        return true;
      }
    }
  }

  const blockBefore = e.key === 'Backspace' ? getAtomicBlockBeforeCaret(editable, r) : null;
  const blockAfter = e.key === 'Delete' ? getAtomicBlockAfterCaret(editable, r) : null;
  const block = blockBefore || blockAfter;
  if (!block) return false;

  e.preventDefault();
  const next = block.nextSibling;
  const prev = block.previousSibling;
  if (isAtomicUnitChip(block)) stripLeadingZwspAfterAtomicUnit(block);
  block.remove();

  const nr = document.createRange();
  if (e.key === 'Backspace') {
    if (prev && prev.nodeType === Node.TEXT_NODE) {
      nr.setStart(prev, prev.textContent?.length ?? 0);
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
  } else if (next && next.isConnected && next.nodeType === Node.TEXT_NODE) {
    nr.setStart(next, 0);
    nr.collapse(true);
  } else if (prev && prev.nodeType === Node.TEXT_NODE) {
    nr.setStart(prev, prev.textContent?.length ?? 0);
    nr.collapse(true);
  } else {
    const z = document.createTextNode('');
    editable.appendChild(z);
    nr.setStart(z, 0);
    nr.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(nr);
  onMutated?.();
  return true;
}
