import { latexToPlain } from './latexPlainTransform';

/** 오른쪽 기본 라벨 — (가)(나)(다)… */
export const MATCHING_RIGHT_KO = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차'];

const PAREN_LABEL_RE = /^\s*\(([^)]+)\)\s*/u;
const BARE_KO_LABEL_RE = /^\s*([가-힣])\s+/u;
const BARE_LATIN_LABEL_RE = /^\s*([a-zA-Z])\s+/u;
const CIRCLED_NUMS = '①②③④⑤⑥⑦⑧⑨⑩';
const CIRCLED_LABEL_RE = /^\s*([①②③④⑤⑥⑦⑧⑨⑩])\s*/u;

/** 선잇기 항목: OCR LaTeX(`$240 \\div 16$`) → 인쇄형(`240÷16`) */
export function matchingItemToPlain(raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!s) return '';
  const inner = /^\$+([\s\S]+?)\$+$/.test(s) ? s.replace(/^\$+|\$+$/g, '').trim() : s;
  if (inner.includes('\\') || /\\(?:div|times|frac)\b/.test(inner)) {
    return latexToPlain(inner);
  }
  return inner.replace(/(\d)\s*([÷×])\s*(\d)/g, '$1$2$3');
}

/**
 * 항목 앞 기호 분리 — `(1)`, `(가)`, `가`, `(a)`, `①` 등
 * @returns {{ label: string|null, content: string }}
 */
export function extractMatchingItemLabel(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { label: null, content: '' };

  let m = s.match(PAREN_LABEL_RE);
  if (m) {
    const inner = m[1].trim();
    if (inner) {
      return { label: `(${inner})`, content: s.slice(m[0].length).trim() };
    }
  }

  m = s.match(CIRCLED_LABEL_RE);
  if (m) {
    const idx = CIRCLED_NUMS.indexOf(m[1]);
    if (idx >= 0) {
      return { label: `(${idx + 1})`, content: s.slice(m[0].length).trim() };
    }
  }

  m = s.match(BARE_KO_LABEL_RE);
  if (m) {
    return { label: `(${m[1]})`, content: s.slice(m[0].length).trim() };
  }

  m = s.match(BARE_LATIN_LABEL_RE);
  if (m) {
    return { label: `(${m[1]})`, content: s.slice(m[0].length).trim() };
  }

  return { label: null, content: s };
}

/** @param {'left'|'right'} side */
export function defaultMatchingLabel(side, index) {
  if (side === 'left') return `(${index + 1})`;
  return `(${MATCHING_RIGHT_KO[index] || String(index + 1)})`;
}

/**
 * @param {'left'|'right'} side
 * @returns {{ items: string[], labels: string[] }}
 */
export function normalizeMatchingSideItems(items, side) {
  const arr = Array.isArray(items) && items.length > 0 ? items : ['', '', ''];
  const outItems = [];
  const outLabels = [];
  arr.forEach((raw, i) => {
    const plain = matchingItemToPlain(raw);
    const { label, content } = extractMatchingItemLabel(plain);
    outItems.push(content);
    outLabels.push(label || defaultMatchingLabel(side, i));
  });
  return { items: outItems, labels: outLabels };
}

/** API·OCR matching 객체 정규화 */
export function normalizeMatchingPayload(matching) {
  const m = matching && typeof matching === 'object' ? matching : {};
  const left = normalizeMatchingSideItems(m.leftItems, 'left');
  const right = normalizeMatchingSideItems(m.rightItems, 'right');
  return {
    question: String(m.question || '').trim() || '다음을 알맞게 이으세요.',
    leftItems: left.items,
    rightItems: right.items,
    leftLabels: left.labels,
    rightLabels: right.labels,
  };
}

/** 저장된 labels 가 있으면 우선, 없으면 항목에서 추출·기본값 */
export function resolveMatchingSide(items, side, storedLabels) {
  const normalized = normalizeMatchingSideItems(items, side);
  if (
    Array.isArray(storedLabels) &&
    storedLabels.length === normalized.items.length &&
    storedLabels.every((l) => String(l || '').trim())
  ) {
    return { items: normalized.items, labels: storedLabels.map((l) => String(l).trim()) };
  }
  return normalized;
}
