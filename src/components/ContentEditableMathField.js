/**
 * 검수 등 — contenteditable + OCR 수식 칩(삭제·클릭 편집)
 */
import React, { useRef, useEffect, useCallback, useState } from 'react';
import {
  hydrateContentEditable,
  serializeContentEditable,
  updateFrozenMathElement,
  INLINE_MATH_FROZEN_CLASS,
} from '../utils/inlineMathStorage';
import {
  handleContentEditableAtomicKeyDown,
  selectAfterChip,
} from '../utils/contentEditableMathChip';
import { copyPlainFromContentEditableSelection } from './ExamOCR';
import { elementaryScriptToLatex } from '../utils/elementaryMathScript';
import ElementaryMathOverlay from './ElementaryMathOverlay';

/**
 * @param {{
 *   value: string;
 *   onChange: (s: string) => void;
 *   className?: string;
 *   placeholder?: string;
 *   as?: 'div' | 'span';
 *   multiline?: boolean;
 *   serializeTransform?: (s: string) => string;
 *   onBlurExtra?: () => void;
 * }} props
 */
export default function ContentEditableMathField({
  value,
  onChange,
  className = '',
  placeholder,
  as: Tag = 'div',
  multiline = true,
  serializeTransform,
  onBlurExtra,
}) {
  const ref = useRef(null);
  const editTargetRef = useRef(null);
  const lastEmitted = useRef(value);
  const [mathModalOpen, setMathModalOpen] = useState(false);
  const [overlayInitialLatex, setOverlayInitialLatex] = useState('');

  const emit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    let s = serializeContentEditable(el);
    if (serializeTransform) s = serializeTransform(s);
    if (s !== lastEmitted.current) {
      lastEmitted.current = s;
      onChange(s);
    }
  }, [onChange, serializeTransform]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = value || '';
    const cur = serializeContentEditable(el);
    if (cur === next) {
      lastEmitted.current = next;
      return;
    }
    hydrateContentEditable(el, next);
    lastEmitted.current = next;
  }, [value]);

  const onKeyDown = useCallback(
    (e) => {
      if (!multiline && e.key === 'Enter') {
        e.preventDefault();
        return;
      }
      handleContentEditableAtomicKeyDown(e, ref.current, emit);
    },
    [multiline, emit],
  );

  const onPointerDown = useCallback((e) => {
    const el = ref.current;
    if (!el) return;
    if (e.target?.nodeType !== Node.ELEMENT_NODE) return;
    const chip = /** @type {HTMLElement} */ (e.target).closest(`.${INLINE_MATH_FROZEN_CLASS}`);
    if (!chip || !el.contains(chip)) return;
    e.preventDefault();
    setOverlayInitialLatex(chip.getAttribute('data-latex') || '');
    editTargetRef.current = /** @type {HTMLSpanElement} */ (chip);
    setMathModalOpen(true);
  }, []);

  const closeMathModal = useCallback(() => {
    setMathModalOpen(false);
    editTargetRef.current = null;
    ref.current?.focus();
  }, []);

  const confirmElementaryMath = useCallback(
    (script) => {
      const latex = elementaryScriptToLatex(script).trim();
      if (!latex) return;
      const editable = ref.current;
      const editTarget = editTargetRef.current;
      if (editTarget && editable?.contains(editTarget)) {
        updateFrozenMathElement(editTarget, latex);
      }
      setMathModalOpen(false);
      editTargetRef.current = null;
      emit();
      window.requestAnimationFrame(() => {
        const ed = ref.current;
        if (!ed) return;
        if (editTarget && ed.contains(editTarget)) {
          selectAfterChip(editTarget, ed);
        } else {
          ed.focus();
        }
      });
    },
    [emit],
  );

  return (
    <>
      <Tag
        ref={ref}
        className={className}
        contentEditable
        suppressContentEditableWarning
        onCopy={copyPlainFromContentEditableSelection}
        onBlur={() => {
          emit();
          onBlurExtra?.();
        }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        data-placeholder={placeholder}
      />
      {mathModalOpen ? (
        <ElementaryMathOverlay
          open={mathModalOpen}
          onClose={closeMathModal}
          onConfirm={confirmElementaryMath}
          initialLatex={overlayInitialLatex}
          title="수식 고치기"
        />
      ) : null}
    </>
  );
}
