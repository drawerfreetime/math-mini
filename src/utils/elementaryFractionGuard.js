/**
 * MathLive 분수(genfrac) 분자·분모 안에서만 초등용 숫자 가드(자연수 ≥ 1, 소수·단위 등 차단)
 * — HTML input이 아니라 math-field 내부 _mathfield.model 로 분기/내용을 읽음.
 */

export const FRACTION_GUARD_MESSAGE =
  '분수 칸에는 1 이상의 자연수(숫자)만 쓸 수 있어요!';

const NAV_KEYS = new Set([
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'Enter',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

/**
 * @param {string} latex
 * @returns {boolean} 빈 문자열(입력 중) 또는 1 이상 정수만 true
 */
export function isValidElementaryFractionPartLatex(latex) {
  const s = String(latex ?? '')
    .replace(/\s/g, '')
    .trim();
  if (s === '') return true;
  if (!/^\d+$/.test(s)) return false;
  if (/^0\d/.test(s)) return false;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 1;
}

/**
 * @param {HTMLElement} mathFieldEl
 * @returns {{ branch: 'numerator' | 'denominator'; genfracOffset: number } | null}
 */
export function findGenfracCaretContext(mathFieldEl) {
  /** @type {{ _mathfield?: { model?: { position: number; offsetOf: Function; at: Function; getBranchRange: Function } } }} */
  const wrap = mathFieldEl;
  const mf = wrap._mathfield;
  const model = mf?.model;
  if (!model) return null;

  const pos = model.position;
  let atom = model.at(pos);
  for (let depth = 0; depth < 64 && atom; depth++) {
    const parent = atom.parent;
    if (parent?.type === 'genfrac') {
      const poff = model.offsetOf(parent);
      let above;
      let below;
      try {
        above = model.getBranchRange(poff, 'above');
        below = model.getBranchRange(poff, 'below');
      } catch {
        return null;
      }
      if (pos >= above[0] && pos <= above[1]) {
        return { branch: 'numerator', genfracOffset: poff };
      }
      if (pos >= below[0] && pos <= below[1]) {
        return { branch: 'denominator', genfracOffset: poff };
      }
      return null;
    }
    atom = parent;
  }
  return null;
}

/**
 * @param {HTMLElement} mathFieldEl
 * @param {{ branch: 'numerator' | 'denominator'; genfracOffset: number }} ctx
 */
export function getGenfracBranchLatex(mathFieldEl, ctx) {
  /** @type {{ _mathfield?: { model?: { getBranchRange: Function; getValue: Function } } }} */
  const wrap = mathFieldEl;
  const model = wrap._mathfield?.model;
  if (!model) return '';
  const branchName = ctx.branch === 'numerator' ? 'above' : 'below';
  try {
    const [a, b] = model.getBranchRange(ctx.genfracOffset, branchName);
    return String(model.getValue(a, b, 'latex') ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * 붙여넣기 문자열: 오직 숫자만(빈 문자열 허용), 합쳐졌을 때 규칙은 입력 후 input에서 검사
 * @param {string} text
 */
export function isPasteAllowedInFractionPart(text) {
  const t = String(text ?? '');
  if (t === '') return true;
  return /^\d+$/.test(t);
}

/**
 * @param {HTMLElement} mf — math-field 요소
 * @param {() => void} onReject
 * @returns {() => void} detach
 */
export function attachElementaryFractionGuard(mf, onReject) {
  const show = () => {
    try {
      onReject();
    } catch {
      /* ignore */
    }
  };

  const rejectIfInvalidBranch = () => {
    const ctx = findGenfracCaretContext(mf);
    if (!ctx) return;
    const part = getGenfracBranchLatex(mf, ctx);
    if (!isValidElementaryFractionPartLatex(part)) {
      try {
        mf.executeCommand('undo');
      } catch {
        /* ignore */
      }
      show();
    }
  };

  /** @param {KeyboardEvent} e */
  const onKeyDownCapture = (e) => {
    if (e.isComposing) return;
    const ctx = findGenfracCaretContext(mf);
    if (!ctx) return;

    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (NAV_KEYS.has(e.key)) return;

    if (e.key.length === 1) {
      if (/[0-9]/.test(e.key)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      show();
    }
  };

  /** @param {InputEvent} e */
  const onBeforeInput = (e) => {
    const ctx = findGenfracCaretContext(mf);
    if (!ctx) return;

    const t = e.inputType;
    if (t === 'insertFromPaste' || t === 'insertReplacementText') {
      const data =
        e.inputType === 'insertFromPaste'
          ? e.clipboardData?.getData('text/plain') ?? ''
          : /** @type {string} */ (e.data ?? '');
      if (!isPasteAllowedInFractionPart(data)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (t === 'insertText' && e.data != null && e.data !== '') {
      if (!/^[0-9]+$/.test(e.data)) {
        e.preventDefault();
        show();
      }
    }
  };

  /** @param {ClipboardEvent} e */
  const onPasteCapture = (e) => {
    const ctx = findGenfracCaretContext(mf);
    if (!ctx) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!isPasteAllowedInFractionPart(text)) {
      e.preventDefault();
      show();
    }
  };

  let raf = 0;
  const onInput = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => rejectIfInvalidBranch());
  };

  mf.addEventListener('keydown', onKeyDownCapture, true);
  mf.addEventListener('beforeinput', onBeforeInput, true);
  mf.addEventListener('paste', onPasteCapture, true);
  mf.addEventListener('input', onInput);

  return () => {
    cancelAnimationFrame(raf);
    mf.removeEventListener('keydown', onKeyDownCapture, true);
    mf.removeEventListener('beforeinput', onBeforeInput, true);
    mf.removeEventListener('paste', onPasteCapture, true);
    mf.removeEventListener('input', onInput);
  };
}
