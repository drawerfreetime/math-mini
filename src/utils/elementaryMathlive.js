/**
 * MathLive 전역 UI — 초등용 2탭 가상 키보드 (연산 / 단위)
 * 화면 도구줄 없이 수식 칸 안 키보드에서만 연산·단위 입력
 */
import { initVirtualKeyboardInCurrentBrowsingContext } from 'mathlive';

const UNITS_FLAT = [
  ['mm', '\\mathrm{mm}'],
  ['cm', '\\mathrm{cm}'],
  ['m', '\\mathrm{m}'],
  ['km', '\\mathrm{km}'],
  ['g', '\\mathrm{g}'],
  ['kg', '\\mathrm{kg}'],
  ['t', '\\mathrm{t}'],
  ['mL', '\\mathrm{mL}'],
  ['L', '\\mathrm{L}'],
  ['s', '\\mathrm{s}'],
  ['min', '\\mathrm{min}'],
  ['h', '\\mathrm{h}'],
  ['°', '^\\circ'],
  ['cm²', '\\mathrm{cm}^{2}'],
  ['m²', '\\mathrm{m}^{2}'],
  ['km²', '\\mathrm{km}^{2}'],
  ['cm³', '\\mathrm{cm}^{3}'],
  ['m³', '\\mathrm{m}^{3}'],
];

/**
 * @param {(string | Record<string, unknown>)[]} flat
 * @param {number} chunkSize
 * @returns {(string | Record<string, unknown>)[][]}
 */
function chunkKeycapRows(flat, chunkSize) {
  /** @type {(string | Record<string, unknown>)[][]} */
  const rows = [];
  for (let i = 0; i < flat.length; i += chunkSize) {
    rows.push(flat.slice(i, i + chunkSize));
  }
  return rows;
}

/** @type {(string | { latex: string; variants: [] })[]} */
const UNIT_LATEX_LIST = UNITS_FLAT.map(([, latex]) =>
  ({ latex, variants: [] })
);

const LAYOUT_OPERATION = {
  label: '연산',
  id: 'elementary-ops',
  layers: [
    {
      rows: [
        ['+', '-', '\\times', '\\div', '(', ')', '='],
        ['\\leq', '\\geq', '<', '>'],
        [{ latex: '.', variants: [] }, '\\square', ':', '\\%'],
        [
          { latex: '\\frac{#@}{#0}', class: 'small' },
          '[left]',
          '[right]',
          { label: '[backspace]', class: 'action hide-shift' },
          '[hide-keyboard]',
        ],
      ],
    },
  ],
};

const LAYOUT_UNITS = {
  label: '단위',
  id: 'elementary-units',
  layers: [
    {
      rows: [
        ...chunkKeycapRows(UNIT_LATEX_LIST, 5),
        [
          '[left]',
          '[right]',
          { label: '[backspace]', class: 'action hide-shift' },
          '[hide-keyboard]',
        ],
      ],
    },
  ],
};

export const ELEMENTARY_LAYOUTS = [LAYOUT_OPERATION, LAYOUT_UNITS];

/**
 * 모달에 키보드를 붙일 때: [hide-keyboard] 제거 — 숨기면 패널 안에서 다시 켜기 어려움
 */
export const ELEMENTARY_LAYOUTS_FOR_MODAL = ELEMENTARY_LAYOUTS.map((layout) => ({
  ...layout,
  layers: layout.layers.map((layer) => ({
    ...layer,
    rows: layer.rows.map((row) => row.filter((cell) => cell !== '[hide-keyboard]')),
  })),
}));

/**
 * 앱 로드 시 한 번만 호출
 */
export function configureGlobalMathLiveElementary() {
  if (typeof window === 'undefined' || window.__elementaryMathLiveVk) return;
  window.__elementaryMathLiveVk = true;

  try {
    initVirtualKeyboardInCurrentBrowsingContext();
  } catch (_) {
    /* no-op */
  }

  let tries = 0;
  const applyVk = () => {
    const vk = window.mathVirtualKeyboard;
    if (!vk && tries++ < 30) {
      requestAnimationFrame(applyVk);
      return;
    }
    if (!vk) return;

    vk.editToolbar = 'none';
    vk.layouts = ELEMENTARY_LAYOUTS;

    const stripVariants = ['[.]', '+', '-', '[+]', '[-]', '[*]', '[/]'];
    for (const k of stripVariants) {
      try {
        vk.setKeycap(k, { variants: [] });
      } catch (_) {
        /* no-op */
      }
    }
  };
  applyVk();
}
