/**
 * pdfRegionHeuristics.js
 *
 * pdf.js의 텍스트·연산자 스트림을 이용해 드래그 영역의 문제 유형과
 * 이미지(도형) 포함 여부를 **즉시(0ms)** 판정한다. AI 비전 호출과 달리
 * 네트워크 왕복이 없고, 사용자 입장에선 모달 없이 박스에 바로 배지가 붙는다.
 *
 * 노출 함수:
 *   - analyzePage(page, viewport)        → 페이지 단위 메타 수집(캐싱 권장)
 *   - detectStructure(meta, rectN)       → '선잇기' | '표' | '세로셈' | '빈칸채우기' | '기타'
 *   - detectHasImage(meta, rectN)        → { hasImage: boolean, imageBoxes: [{x,y,w,h}], coverage }
 *
 * rectN: 캔버스 정규화 좌표(0~1) 사각형 {x,y,w,h}
 * viewport: pdf.js page.getViewport() 결과
 *
 * 설계 메모:
 *  - 텍스트 항목 좌표는 PDF 좌표계 → viewport.transform 곱으로 캔버스 px로 환산
 *  - 연산자 스트림(operatorList)은 CTM 누적이 필요해 save/restore/transform 을 직접 추적
 *  - 휴리스틱이 애매하면 'unknown' 또는 null을 돌려 호출자가 AI 보강을 시도할 수 있게 한다
 */

/* eslint-disable no-bitwise */

import { isNumberCardStem } from './pdfRegionNumberCards';

function getOPS() {
  const lib = window['pdfjs-dist/build/pdf'];
  return lib?.OPS || null;
}

function getUtil() {
  const lib = window['pdfjs-dist/build/pdf'];
  return lib?.Util || null;
}

/** [a,b,c,d,e,f] 형 행렬 곱 — pdf.js Util.transform 미가용 시 fallback. */
function mulMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function transformPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 텍스트 항목의 PDF 좌표 → 캔버스(viewport) 좌표 */
function textItemToCanvasXY(item, viewport) {
  const Util = getUtil();
  const tm = item.transform; // [a,b,c,d,e,f]
  if (Util?.transform) {
    const m = Util.transform(viewport.transform, tm);
    return { cx: m[4], cy: m[5], h: Math.abs(item.height || tm[3]) };
  }
  const m = mulMatrix(viewport.transform, tm);
  return { cx: m[4], cy: m[5], h: Math.abs(item.height || tm[3]) };
}

/**
 * 페이지 단위 분석: 텍스트 아이템과 이미지 박스, 선/사각형 후보를 한 번만 모은다.
 * 같은 페이지에 여러 영역을 그릴 때마다 다시 계산하지 않도록 호출자가 캐시하길 권장.
 *
 * @param {object} page  pdf.js PDFPageProxy
 * @param {object} viewport  page.getViewport({scale})
 * @returns {Promise<PageMeta>}
 *
 * PageMeta = {
 *   width, height,                                   // canvas px
 *   textItems: [{cx, cy, h, str}],                   // 각 아이템 좌하단 기준
 *   imageBoxes: [{x, y, w, h}],                      // 이미지 그리기 박스(canvas px)
 *   strokes:   [{x1, y1, x2, y2, horizontal, vertical}], // 직선 선분
 *   rects:     [{x, y, w, h}],                       // 박스 형태 사각형(테두리)
 * }
 */
export async function analyzePage(page, viewport) {
  const OPS = getOPS();

  // ── 1) 텍스트 아이템 (좌표 변환 포함) ──
  const tc = await page.getTextContent();
  const textItems = [];
  for (const it of tc.items) {
    const s = String(it.str ?? '');
    if (!s) continue;
    const { cx, cy, h } = textItemToCanvasXY(it, viewport);
    textItems.push({ cx, cy, h, str: s });
  }

  // ── 2) 이미지 박스 & 선분/사각형 추출 (operator list) ──
  const imageBoxes = [];
  const strokes = [];
  const rects = [];

  let opList = null;
  try {
    opList = await page.getOperatorList();
  } catch {
    /* 어떤 PDF는 일부 op이 비표준일 수 있다. 텍스트 휴리스틱만으로 진행 */
  }

  if (opList && OPS) {
    const { fnArray, argsArray } = opList;
    // ── CTM 스택 추적 (save/restore/transform) ──
    const Util = getUtil();
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0]; // 단위행렬
    const compose = (a, b) => (Util?.transform ? Util.transform(a, b) : mulMatrix(a, b));

    /** PDF 단위정사각형(0,0)-(1,1) 을 viewport 좌표 박스로 변환.
     *  PDF 이미지/형식은 보통 1×1 단위 정사각형을 그려서 CTM 으로 위치/크기를 결정한다. */
    const unitSquareToBox = () => {
      const m = compose(viewport.transform, ctm);
      const p0 = transformPoint(m, 0, 0);
      const p1 = transformPoint(m, 1, 0);
      const p2 = transformPoint(m, 0, 1);
      const p3 = transformPoint(m, 1, 1);
      const xs = [p0[0], p1[0], p2[0], p3[0]];
      const ys = [p0[1], p1[1], p2[1], p3[1]];
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    };

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];

      if (fn === OPS.save) {
        stack.push(ctm.slice());
      } else if (fn === OPS.restore) {
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS.transform) {
        // args: [a,b,c,d,e,f]
        ctm = compose(ctm, args);
      } else if (
        fn === OPS.paintImageXObject ||
        fn === OPS.paintInlineImageXObject ||
        fn === OPS.paintImageMaskXObject ||
        fn === OPS.paintJpegXObject /* legacy */ ||
        fn === OPS.paintImageXObjectRepeat
      ) {
        imageBoxes.push(unitSquareToBox());
      } else if (fn === OPS.constructPath) {
        // args: [pathOps, pathArgs, minMax?]
        // pdf.js 3.x: minMax 가 args[2] 에 종종 들어 있다 ([minX,minY,maxX,maxY])
        // 없으면 pathOps/pathArgs 를 직접 파싱.
        const pathOps = args?.[0];
        const pathArgs = args?.[1];
        const minMax = args?.[2];
        if (Array.isArray(minMax) && minMax.length === 4) {
          const m = compose(viewport.transform, ctm);
          const p0 = transformPoint(m, minMax[0], minMax[1]);
          const p1 = transformPoint(m, minMax[2], minMax[1]);
          const p2 = transformPoint(m, minMax[0], minMax[3]);
          const p3 = transformPoint(m, minMax[2], minMax[3]);
          const xs = [p0[0], p1[0], p2[0], p3[0]];
          const ys = [p0[1], p1[1], p2[1], p3[1]];
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);
          const w = maxX - minX;
          const h = maxY - minY;
          const HV_TOL = 1.5; // 1.5px 이내면 수평/수직선
          if (w >= 3 && h <= HV_TOL) {
            strokes.push({ x1: minX, y1: (minY + maxY) / 2, x2: maxX, y2: (minY + maxY) / 2, horizontal: true, vertical: false });
          } else if (h >= 3 && w <= HV_TOL) {
            strokes.push({ x1: (minX + maxX) / 2, y1: minY, x2: (minX + maxX) / 2, y2: maxY, horizontal: false, vertical: true });
          } else if (w >= 4 && h >= 4) {
            rects.push({ x: minX, y: minY, w, h });
          }
        } else if (Array.isArray(pathOps) && Array.isArray(pathArgs)) {
          // moveTo/lineTo 좌표를 따라가며 선분 추출
          const m = compose(viewport.transform, ctm);
          let cx = 0;
          let cy = 0;
          let ai = 0;
          for (const op of pathOps) {
            // pdf.js path opcodes: moveTo=13, lineTo=14, curveTo=15, curveTo2=16, curveTo3=17, closePath=18, rectangle=19
            if (op === 13 || op === 14) {
              const nx = pathArgs[ai++];
              const ny = pathArgs[ai++];
              if (op === 14) {
                const [a, b] = transformPoint(m, cx, cy);
                const [c, d] = transformPoint(m, nx, ny);
                const dx = Math.abs(c - a);
                const dy = Math.abs(d - b);
                if (dx >= 3 && dy <= 1.5) {
                  strokes.push({ x1: Math.min(a, c), y1: (b + d) / 2, x2: Math.max(a, c), y2: (b + d) / 2, horizontal: true, vertical: false });
                } else if (dy >= 3 && dx <= 1.5) {
                  strokes.push({ x1: (a + c) / 2, y1: Math.min(b, d), x2: (a + c) / 2, y2: Math.max(b, d), horizontal: false, vertical: true });
                }
              }
              cx = nx; cy = ny;
            } else if (op === 19) {
              // rectangle: x, y, w, h
              const rx = pathArgs[ai++];
              const ry = pathArgs[ai++];
              const rw = pathArgs[ai++];
              const rh = pathArgs[ai++];
              const [x0, y0] = transformPoint(m, rx, ry);
              const [x1, y1] = transformPoint(m, rx + rw, ry + rh);
              const minX = Math.min(x0, x1);
              const minY = Math.min(y0, y1);
              const maxX = Math.max(x0, x1);
              const maxY = Math.max(y0, y1);
              const W = maxX - minX;
              const H = maxY - minY;
              if (W >= 4 && H >= 4) rects.push({ x: minX, y: minY, w: W, h: H });
              cx = rx + rw; cy = ry + rh;
            } else if (op === 15) {
              ai += 6;
            } else if (op === 16 || op === 17) {
              ai += 4;
            }
          }
        }
      }
    }
  }

  return {
    width: viewport.width,
    height: viewport.height,
    textItems,
    imageBoxes,
    strokes,
    rects,
  };
}

function rectContainsPoint(rx, ry, rw, rh, x, y) {
  return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
}

function rectIntersectArea(ax, ay, aw, ah, bx, by, bw, bh) {
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

/** rectN(0~1) → 캔버스 px 박스 */
function denormalize(meta, rectN) {
  return {
    x: rectN.x * meta.width,
    y: rectN.y * meta.height,
    w: rectN.w * meta.width,
    h: rectN.h * meta.height,
  };
}

/** 영역 안 PDF 텍스트 레이어 아이템 */
function textsInRegion(meta, rectN) {
  const r = denormalize(meta, rectN);
  return meta.textItems.filter(
    (t) => t.cx >= r.x && t.cx <= r.x + r.w && t.cy >= r.y && t.cy <= r.y + r.h,
  );
}

/**
 * 「□ 안에 알맞은 수」+ 316×25=ㄱ+ㄴ 분해식 등 — 색 박스·화살표(XObject)는 장식이며 도형 이미지 아님.
 */
function isBlankFillArithmeticRegion(textsIn, joined) {
  const s = String(joined || '');
  const blankInstr = /□\s*안에|써\s*넣|알맞은\s*수/.test(s);
  if (!blankInstr) return false;

  const labels = countHangulBlankLabels(textsIn);
  const labelInText = (s.match(/[ㄱ-ㅎ㉠-㉣](?=\s*[:,)]|\s*\+|=)/g) || []).length;
  const labelTotal = labels + labelInText;
  const decomp = /\d+\s*[×x＊*]\s*\d+/.test(s);
  const sumOfParts = /=\s*[^=\n]*\+/.test(s);

  if (decomp && labelTotal >= 2) return true;
  if (decomp && sumOfParts) return true;
  if (labelTotal >= 2 && (decomp || sumOfParts)) return true;
  return decomp;
}

/**
 * XObject(카드·인쇄 숫자 등)가 있어도 hasImage=false 로 둘 이유.
 * null 이면 억제하지 않음.
 */
function imageSuppressReason(meta, rectN, overlapping) {
  const textsIn = textsInRegion(meta, rectN);
  const joined = textsIn.map((t) => t.str).join(' ');

  if (isNumberCardStem(joined)) return 'number-card-stem';

  if (isBlankFillArithmeticRegion(textsIn, joined)) return 'blank-fill-arithmetic';

  // 「그림과 같은 상자에 180을 넣었더니 5400…」 같은 '상자 기계' 문항:
  // 상자/화살표는 종종 XObject 이미지로 들어가지만, 내용은 180×□=5400 형태의 산술 텍스트 문항이다.
  if (isArithmeticMachineBoxRegion(joined)) return 'arithmetic-machine-box';

  const structure = detectStructure(meta, rectN);
  if (structure.type === '세로셈' && structure.confidence >= 0.65) {
    return 'vertical-arithmetic';
  }
  if (structure.type === '빈칸채우기' && structure.confidence >= 0.65) {
    return 'blank-fill-structure';
  }

  if (/계산/.test(joined) && /[(（]\s*[12]\s*[)）]/.test(joined)) {
    return 'calc-subitems';
  }

  if (overlapping.length >= 2) {
    const r = denormalize(meta, rectN);
    const regionArea = Math.max(r.w * r.h, 1);
    const smallBoxes = overlapping.filter(
      (ib) => (ib.w * ib.h) / regionArea < 0.15,
    );
    if (smallBoxes.length >= Math.min(2, overlapping.length)) {
      if (isNumberCardStem(joined)) return 'number-card-glyphs';
      if (/계산(?:을|해|식|하)|구하|곱|나눗|세로\s*셈/.test(joined)) return 'calc-glyphs';
    }
  }

  return null;
}

function isArithmeticMachineBoxRegion(joined) {
  const s = String(joined || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return false;

  // 핵심 키워드: 상자/그림 + 숫자 2개 이상 + 곱셈/나눗셈 기호 + (가능하면 =) 또는 결과를 묻는 표현
  if (!/(상자|그림)/.test(s)) return false;

  const nums = s.match(/\d[\d,]*/g) || [];
  if (nums.length < 2) return false;

  const hasOp = /[×x＊*÷]/.test(s);
  if (!hasOp) return false;

  const hasEquationSignal = /=/.test(s) || /(나왔|나오는\s*값|값은\s*얼마|얼마입니까|구하)/.test(s);
  if (!hasEquationSignal) return false;

  // 너무 넓은 이미지/도형 문제(표/선잇기 등)로 퍼지는 걸 막기 위해,
  // 선택지/격자/점선 신호가 강하면 제외.
  if (/[①②③④⑤]/.test(s)) return false;
  if (/점선|선\s*잇기|표\s*와|표를/.test(s)) return false;

  return true;
}

/**
 * 이미지(도형) 포함 여부.
 *
 * 신뢰성 우선: 진짜 이미지(JPEG/PNG XObject)가 영역과 ≥영역의 5% 겹칠 때만 true.
 * 벡터로만 그린 도형은 거짓 양성(분수선·등호·문항 테두리)을 너무 많이 만들어
 * 자동 적용에서 제외한다 — 그런 도형은 사용자가 "이미지" 토글로 손쉽게 켤 수 있다.
 *
 * imageBoxes는 영역 좌표계가 아니라 페이지 좌표계로 반환된다(호출자가 부모 기준 상대 좌표로 변환할 수 있게).
 */
export function detectHasImage(meta, rectN) {
  if (!meta) return { hasImage: false, imageBoxes: [], coverage: 0 };
  const r = denormalize(meta, rectN);
  const regionArea = Math.max(r.w * r.h, 1);

  const overlapping = [];
  let coveredArea = 0;
  for (const ib of meta.imageBoxes) {
    const area = rectIntersectArea(r.x, r.y, r.w, r.h, ib.x, ib.y, ib.w, ib.h);
    if (area > 0) {
      overlapping.push({
        x: Math.max(ib.x, r.x),
        y: Math.max(ib.y, r.y),
        w: Math.min(ib.x + ib.w, r.x + r.w) - Math.max(ib.x, r.x),
        h: Math.min(ib.y + ib.h, r.y + r.h) - Math.max(ib.y, r.y),
      });
      coveredArea += area;
    }
  }
  const coverage = coveredArea / regionArea;
  // 임계치 0.05 — 도형이 영역의 5% 이상을 차지해야 안전하게 'hasImage' 로 단정한다
  if (overlapping.length > 0 && coverage >= 0.05) {
    const suppress = imageSuppressReason(meta, rectN, overlapping);
    if (suppress) {
      return { hasImage: false, imageBoxes: [], coverage, suppressReason: suppress };
    }
    return { hasImage: true, imageBoxes: overlapping, coverage };
  }

  return { hasImage: false, imageBoxes: [], coverage };
}

/**
 * cy 인접도 기반으로 텍스트 아이템을 "행"으로 군집화한다.
 * 같은 줄의 글자/단어는 cy 가 거의 같으므로 tolerance 이하면 한 행으로 묶는다.
 */
function clusterRows(items, tolerance) {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.cy - b.cy);
  const rows = [];
  let cur = [sorted[0]];
  let curY = sorted[0].cy;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i];
    if (Math.abs(t.cy - curY) <= tolerance) {
      cur.push(t);
      curY = (curY * (cur.length - 1) + t.cy) / cur.length;
    } else {
      rows.push(cur);
      cur = [t];
      curY = t.cy;
    }
  }
  rows.push(cur);
  return rows;
}

/** 같은 행의 텍스트를 x 간격으로 열(칸) 군집 */
function clusterColumns(rowItems) {
  if (!rowItems.length) return [];
  const sorted = [...rowItems].sort((a, b) => a.cx - b.cx);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].cx - sorted[i - 1].cx);
  }
  const medGap = gaps.length
    ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
    : 24;
  const threshold = Math.max(medGap * 1.8, 18);

  const cols = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].cx - sorted[i - 1].cx;
    if (gap > threshold) {
      cols.push(cur);
      cur = [sorted[i]];
    } else {
      cur.push(sorted[i]);
    }
  }
  cols.push(cur);
  return cols.map((items) => {
    const xs = items.map((t) => t.cx);
    const medianX = xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const text = items.map((t) => t.str).join('').trim();
    return { medianX, text, items };
  });
}

/** ×÷+- 연산 기호(피연산자 행 왼쪽 등) */
function hasArithmeticOperator(text) {
  const s = String(text || '').trim();
  return /[×÷+-]/.test(s) || /^[×÷]\s*\d/.test(s);
}

/** 여러 줄 서술형 지문(단어 문제) — 숫자가 문장 안에 섞인 경우 */
function isProseDominant(textsIn) {
  if (textsIn.length < 3) return false;
  const proseItems = textsIn.filter((t) => {
    const s = t.str.trim();
    if (s.length < 5 || !/[가-힣]/.test(s)) return false;
    if (/^[ㄱ-ㅎ]$/.test(s)) return false;
    return /[습니다요니까]?$|[다고하면서와의을를에게]/.test(s) || s.length >= 12;
  });
  return proseItems.length / textsIn.length >= 0.28;
}

/** [희수]·[일훈] 등 대괄호 이름 라벨 */
function hasBracketPersonLabel(textsIn) {
  return textsIn.some((t) => /^\[[가-힣A-Za-z]{1,8}\]$/.test(t.str.trim()));
}

/** 「계산이 틀린 사람」 등 이름+세로셈 비교 박스 */
function detectCompareVerticalArithmetic(textsIn, horiz, vert, r) {
  if (textsIn.length < 4) return null;

  const joined = textsIn.map((t) => t.str).join(' ');
  const compareIntent = /계산.*틀린|틀린\s*사람|맞은\s*사람|이름을?\s*쓰|잘못\s*계산/.test(joined);
  const bracketNames = textsIn.filter((t) => /^\[[가-힣A-Za-z]{1,8}\]$/.test(t.str.trim())).length;

  if (!compareIntent && bracketNames < 1) return null;

  const numberItems = textsIn.filter((t) => /^\d[\d,.\s]*$/.test(t.str.trim()));
  if (numberItems.length < 2) return null;

  const hasOp = textsIn.some((t) => hasArithmeticOperator(t.str));
  const sumLines = horiz.filter((s) => {
    const len = s.x2 - s.x1;
    return len >= Math.min(r.w * 0.05, 14) && len <= r.w * 0.75;
  });

  const stacked = hasVerticalOperandStack(textsIn);
  const multiColumn = bracketNames >= 2 || (compareIntent && numberItems.length >= 4);

  if (!stacked && !(hasOp && numberItems.length >= 3)) return null;
  if (!multiColumn && !(compareIntent && (hasOp || sumLines.length >= 1))) return null;

  const gridVert = vert.filter((s) => (s.y2 - s.y1) >= r.h * 0.2);
  const gridHoriz = horiz.filter((s) => (s.x2 - s.x1) >= r.w * 0.25);
  if (!hasOp && !compareIntent && gridVert.length >= 3 && gridHoriz.length >= 3) {
    return null;
  }

  return {
    type: '세로셈',
    confidence: bracketNames >= 2 ? 0.92 : 0.86,
    debug: {
      mode: 'named-compare-vertical',
      compareIntent,
      bracketNames,
      numberItems: numberItems.length,
      sumLines: sumLines.length,
      stacked,
    },
  };
}

/** ㉠㉡㉢·ㄱ·(ㄱ) 등 빈칸 라벨 기호 개수 */
function countHangulBlankLabels(textsIn) {
  return textsIn.filter((t) => {
    const s = t.str.trim();
    return /^[ㄱ-ㅎ]$/.test(s)
      || /^[\u3260-\u3267]$/.test(s)
      || /^[㉠-㉣]$/.test(s)
      || /^\([ㄱ-ㅎ]\)$/.test(s);
  }).length;
}

/** □·ㄱㄴㄷ 빈칸 채우기 문항 */
function detectBlankFillEarly(textsIn) {
  const joined = textsIn.map((t) => t.str).join(' ');
  if (isMultipleChoiceStem(textsIn, joined)) return null;
  if (
    /계산.*틀린|틀린\s*사람|맞은\s*사람|이름을?\s*쓰/.test(joined) &&
    (hasBracketPersonLabel(textsIn) || hasVerticalOperandStack(textsIn))
  ) {
    return null;
  }
  if (/□\s*안에|써\s*넣|알맞은\s*수/.test(joined)) {
    const labels = countHangulBlankLabels(textsIn);
    const decomp = /\d+\s*[×x*]\s*\d+/.test(joined);
    return {
      type: '빈칸채우기',
      confidence: labels >= 2 && decomp ? 0.9 : 0.82,
      debug: { mode: decomp ? 'decomp-blank-fill' : 'blank-instruction', labels, decomp },
    };
  }
  const hangulLabels = countHangulBlankLabels(textsIn);
  const parenLabels = textsIn.filter((t) => /^\([ㄱ-ㅎ]\)/.test(t.str.trim())).length;
  let blankCount = 0;
  for (const t of textsIn) {
    const s = t.str;
    blankCount += (s.match(/[□▢☐]/g) || []).length;
    blankCount += (s.match(/\(\s*\)/g) || []).length;
  }
  if (hangulLabels >= 2 || parenLabels >= 2 || blankCount >= 2) {
    return {
      type: '빈칸채우기',
      confidence: hangulLabels >= 2 ? 0.8 : 0.75,
      debug: { mode: 'blank-labels', hangulLabels, parenLabels, blankCount },
    };
  }
  return null;
}

function medianTextHeight(textsIn, items) {
  const heights = (items || textsIn).map((t) => t.h).filter((h) => h > 0);
  if (!heights.length) return 14;
  const sorted = [...heights].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 같은 줄에 「472 × 28」처럼 가로 곱셈식이 있는지 */
function rowHasHorizontalMultiplyExpr(textsIn, cy, rowTol) {
  const onRow = textsIn.filter((t) => Math.abs(t.cy - cy) <= rowTol);
  const joined = onRow.map((t) => t.str).join('');
  if (/\d[\d,]*\s*[×x＊*÷]\s*\d/.test(joined)) return true;
  const numsOnRow = onRow.filter((t) => /^\d[\d,.\s]*$/.test(t.str.trim()));
  if (numsOnRow.length < 2) return false;
  return onRow.some((t) => /[×x＊*÷]/.test(t.str));
}

/**
 * 세로셈: 피연산자가 같은 열에 세로로 쌓임.
 * 보기(가)(나) 열의 숫자만 위아래로 맞춰진 경우(가로셈 객관식)는 제외한다.
 */
function hasVerticalOperandStack(textsIn) {
  const nums = textsIn.filter((t) => /^\d[\d,.\s]*$/.test(t.str.trim()));
  if (nums.length < 2) return false;
  const medH = medianTextHeight(textsIn, nums);
  const rowTol = Math.max(medH * 0.85, 10);
  const xTol = Math.max(medH * 1.8, 20);

  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      const dx = Math.abs(nums[i].cx - nums[j].cx);
      const dy = Math.abs(nums[i].cy - nums[j].cy);
      if (dx > xTol) continue;
      if (dy < Math.max(nums[i].h || 14, nums[j].h || 14) * 0.9) continue;
      if (rowHasHorizontalMultiplyExpr(textsIn, nums[i].cy, rowTol)) continue;
      if (rowHasHorizontalMultiplyExpr(textsIn, nums[j].cy, rowTol)) continue;
      return true;
    }
  }
  return false;
}

/** 「다음 중 … 어느 것」+ 가로 곱셈식 보기 여러 개 — 세로셈이 아님 */
function countHorizontalMultiplyExprs(joined) {
  return (String(joined || '').match(/\d[\d,]*\s*[×x＊*÷]\s*\d/g) || []).length;
}

function countChoiceLabels(textsIn) {
  let n = 0;
  for (const t of textsIn) {
    const s = t.str.trim();
    if (/^[가나다라마바사]\.?$/.test(s)) n += 1;
    if (/^[①②③④⑤⑥⑦⑧⑨⑩]/.test(s)) n += 1;
    if (/^\([가나다라마]\)/.test(s)) n += 1;
  }
  return n;
}

/** ①②③④⑤ 선지 3개 이상 — 지문 끝 ( ) 답란만 있는 5지선다 객관식 */
function isMultipleChoiceStem(textsIn, joined) {
  if (countChoiceLabels(textsIn) >= 3) return true;
  const circled = (String(joined || '').match(/[①②③④⑤⑥⑦⑧⑨⑩]/g) || []).length;
  return circled >= 3;
}

function isHorizontalChoiceArithmetic(textsIn, joined) {
  const exprs = countHorizontalMultiplyExprs(joined);
  if (exprs < 3) return false;
  if (countChoiceLabels(textsIn) >= 3) return true;
  if (/다음\s*중|어느\s*것|맞는\s*것|고르(?:시오|세요|라)|선택/.test(joined)) return true;
  return exprs >= 4;
}

/** 데이터 표 헤더·항목명 칸으로 보이는 한글(지문·답란 제외) */
function isDataTableHeaderCell(text) {
  const s = String(text || '').trim();
  if (!/[가-힣]{2,}/.test(s)) return false;
  if (/(계산|구하|하시오|답|문항|문제|\([12]\))/.test(s)) return false;
  return true;
}

/**
 * 「계산을 하시오」+ (1)(2) 소문항 — 숫자가 XObject(이미지)로만 있어도 세로셈으로 본다.
 */
function detectCalcMultiPart(textsIn, horiz, r) {
  const joined = textsIn.map((t) => t.str).join(' ');
  if (!/계산/.test(joined) || !/[(（]\s*[12]\s*[)）]/.test(joined)) return null;
  const sumLines = horiz.filter((s) => {
    const len = s.x2 - s.x1;
    return len >= Math.min(r.w * 0.06, 16) && len <= r.w * 0.7;
  });
  if (sumLines.length >= 1) {
    return {
      type: '세로셈',
      confidence: 0.8,
      debug: { mode: 'calc-subitems', sumLines: sumLines.length },
    };
  }
  return null;
}

/**
 * 세로 곱셈·덧셈 등 — 자릿수 열 정렬만으로는 표가 아님.
 * 한 영역에 (1)(2)처럼 세로셈이 나란히 여러 개 있어도 세로셈.
 */
function detectVerticalArithmetic(textsIn, horiz, vert, r) {
  if (textsIn.length < 3) return null;

  const joined = textsIn.map((t) => t.str).join(' ');
  // 「계산 결과가 …」같은 객관식 지문은 calcIntent 로 보지 않음 (가로셈 보기와 구분)
  const calcIntent = /계산(?:을|해|식|문제|하)|구하(?:시오|세요|여|라)?|세로\s*셈|곱하기|나누기|덧셈|뺄셈|틀린\s*사람|맞은\s*사람|이름을?\s*쓰/.test(
    joined,
  );

  const numberItems = textsIn.filter((t) => /^\d[\d,.\s]*$/.test(t.str.trim()));
  if (numberItems.length < 2) return null;

  const hasOp = textsIn.some((t) => hasArithmeticOperator(t.str));
  const sumLines = horiz.filter((s) => {
    const len = s.x2 - s.x1;
    return len >= Math.min(r.w * 0.06, 16) && len <= r.w * 0.7;
  });

  const dataHeaders = textsIn.filter((t) => isDataTableHeaderCell(t.str));
  if (dataHeaders.length >= 3 && !hasOp && !calcIntent) return null;

  if (!hasVerticalOperandStack(textsIn)) return null;

  const strong = hasOp && numberItems.length >= 2 && sumLines.length >= 1;
  const medium = calcIntent && numberItems.length >= 2 && (hasOp || sumLines.length >= 1);
  if (!strong && !medium) return null;

  const gridVert = vert.filter((s) => (s.y2 - s.y1) >= r.h * 0.2);
  const gridHoriz = horiz.filter((s) => (s.x2 - s.x1) >= r.w * 0.25);
  if (!hasOp && !calcIntent && gridVert.length >= 3 && gridHoriz.length >= 3) {
    return null;
  }

  return {
    type: '세로셈',
    confidence: strong ? 0.9 : medium ? 0.84 : 0.78,
    debug: {
      mode: 'vertical-arithmetic',
      hasOp,
      calcIntent,
      numberItems: numberItems.length,
      sumLines: sumLines.length,
    },
  };
}

/** 격자선 교차 개수 (선 길이 임계는 호출자가 정함) */
function countGridIntersections(horizSet, vertSet) {
  let intersections = 0;
  for (const H of horizSet) {
    for (const V of vertSet) {
      const hy = (H.y1 + H.y2) / 2;
      const vx = (V.x1 + V.x2) / 2;
      const onH = vx >= H.x1 - 2 && vx <= H.x2 + 2;
      const onV = hy >= V.y1 - 2 && hy <= V.y2 + 2;
      if (onH && onV) intersections++;
    }
  }
  return intersections;
}

/**
 * 서술형 지문 아래 2×N 데이터 표 — 텍스트 열 정렬 + 숫자 칸 신호.
 * 5지선다·(가)(나) 보기형은 제외.
 */
function detectTextAlignedDataTable(textsIn, r, horiz = []) {
  if (textsIn.length < 4) return null;

  const joined = textsIn.map((t) => t.str).join(' ');
  if (isNumberCardStem(joined)) return null;
  if (/계산/.test(joined) && /[(（]\s*[12]\s*[)）]/.test(joined)) return null;

  const calcIntent = /계산|구하(?:시오|세요|여|라)?/.test(joined);
  const hasOp = textsIn.some((t) => hasArithmeticOperator(t.str));
  const numericOnly = textsIn.filter((t) => /^\d+$/.test(t.str.trim())).length;
  const sumLines = horiz.filter((s) => {
    const len = s.x2 - s.x1;
    return len >= Math.min(r.w * 0.06, 16) && len <= r.w * 0.7;
  });
  if ((hasOp || calcIntent) && numericOnly >= 2 && sumLines.length >= 1) {
    return null;
  }

  const circledRows = textsIn.filter((t) => /^[①②③④⑤]/.test(t.str.trim())).length;
  if (circledRows >= 2) return null;

  const gaRows = textsIn.filter((t) => /^\([가나다라마바사]\)/.test(t.str.trim())).length;
  if (gaRows >= 2) return null;

  const heights = textsIn.map((t) => t.h).filter((h) => h > 0);
  const medH = heights.length
    ? heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)]
    : 14;
  const rowTol = Math.max(medH * 0.85, 10);
  const rows = clusterRows(textsIn, rowTol).filter((row) => row.length >= 1);
  if (rows.length < 2) return null;

  const rowCols = rows.map((row) => clusterColumns(row)).filter((cols) => cols.length >= 2);
  if (rowCols.length < 2) return null;

  const maxCols = Math.max(...rowCols.map((cols) => cols.length));
  if (maxCols < 2) return null;

  const xTol = Math.max(r.w * 0.08, 14);
  let alignedCols = 0;
  for (let j = 0; j < maxCols; j++) {
    const xs = rowCols
      .map((cols) => cols[j]?.medianX)
      .filter((x) => x != null);
    if (xs.length < 2) continue;
    const spread = Math.max(...xs) - Math.min(...xs);
    if (spread <= xTol) alignedCols++;
  }
  if (alignedCols < 2) return null;

  if (isProseDominant(textsIn)) return null;

  const numericCells = textsIn.filter((t) => /^\d+$/.test(t.str.trim())).length;
  const multiColRows = rowCols.filter((cols) => cols.length >= 3).length;
  const headerCells = textsIn.filter((t) => isDataTableHeaderCell(t.str)).length;

  // 오탐 방지: 서술형 문장에 숫자(가격/횟수)가 3개 이상 있어도
  // PDF 텍스트 분절 때문에 "열 정렬"로 보이며 표로 잘못 잡히는 케이스가 있다.
  // 따라서 숫자 개수만으로는 표로 단정하지 않고,
  // (헤더 같은 한글 칸) 또는 (3열 이상 행이 반복) 신호가 함께 있을 때만 표로 본다.
  const looksLikeDataTable =
    (headerCells >= 2 && numericCells >= 1) ||
    (multiColRows >= 2 && numericCells >= 2) ||
    (numericCells >= 4 && (headerCells >= 1 || multiColRows >= 1));

  if (looksLikeDataTable) {
    return {
      type: '표',
      confidence: numericCells >= 2 ? 0.84 : 0.78,
      debug: {
        mode: 'text-aligned-table',
        rows: rowCols.length,
        maxCols,
        alignedCols,
        numericCells,
      },
    };
  }
  return null;
}

/**
 * 구조 유형 추정.
 *
 * 정책: **확신할 때만 자동 적용한다**. 애매하면 'unknown' 반환 →
 * 호출자가 AI 보강(혹은 사용자 직접 토글)에 맡긴다.
 *
 * 0) 세로셈      : [이름] 비교 박스·×÷ 세로 정렬·계산용 가로선 (표·빈칸보다 우선)
 * 1) 표 (격자선)  : 영역 너비/높이의 30%+ 이상 뻗는 긴 수평·수직선이
 *                  실제로 교차해서 ≥6 개 교차점을 만들 때만 (문항 테두리 1개로는 안 됨)
 * 2) 표 (텍스트)  : 같은 아이템 개수(≥2)의 행이 ≥2개 있고,
 *                  각 컬럼 x좌표가 행 간에 정렬될 때
 * 3) 선잇기       : 좌/우 군집 사이에 명백한 여백 간격(≥영역폭 15%) +
 *                  점선/점 패턴 또는 같은 y에 짧은 가로선 ≥2개
 * 4) 세로셈       : 좁고(폭/높이<0.7) 키 큰(>40px) 영역 + 숫자 위주(60%+) + 가로선 ≥1
 * 5) 빈칸채우기   : □/(  )/_____ 등의 빈칸 기호 ≥2회
 * 그 외          : 'unknown'  (heuristic은 결정 보류)
 */
export function detectStructure(meta, rectN) {
  if (!meta) return { type: 'unknown', confidence: 0, debug: { reason: 'no-meta' } };
  const r = denormalize(meta, rectN);

  const textsIn = textsInRegion(meta, rectN);
  const joinedEarly = textsIn.map((t) => t.str).join(' ');
  if (isNumberCardStem(joinedEarly)) {
    return {
      type: 'unknown',
      confidence: 0,
      debug: { reason: 'number-card-stem', textsIn: textsIn.length },
    };
  }
  if (isHorizontalChoiceArithmetic(textsIn, joinedEarly)) {
    return {
      type: 'unknown',
      confidence: 0,
      debug: {
        reason: 'horizontal-mc-arithmetic',
        exprs: countHorizontalMultiplyExprs(joinedEarly),
        labels: countChoiceLabels(textsIn),
      },
    };
  }
  if (isMultipleChoiceStem(textsIn, joinedEarly)) {
    return {
      type: '기타',
      confidence: 0.86,
      debug: {
        reason: 'multiple-choice-circled-options',
        labels: countChoiceLabels(textsIn),
      },
    };
  }

  const strokesIn = meta.strokes.filter((s) => {
    const mx = (s.x1 + s.x2) / 2;
    const my = (s.y1 + s.y2) / 2;
    return rectContainsPoint(r.x, r.y, r.w, r.h, mx, my);
  });
  const horiz = strokesIn.filter((s) => s.horizontal);
  const vert = strokesIn.filter((s) => s.vertical);

  // ── 0-a) 이름+비교 세로셈 (틀린 사람·[이름] 박스 — 빈칸·표보다 우선) ──
  const compareVertical = detectCompareVerticalArithmetic(textsIn, horiz, vert, r);
  if (compareVertical) return compareVertical;

  // ── 0-b) 빈칸채우기 (□·ㄱㄴㄷ — 표보다 우선) ─────────
  const blankEarly = detectBlankFillEarly(textsIn);
  if (blankEarly) return blankEarly;

  // ── 0-b2) 계산 + (1)(2) 소문항 (인쇄 숫자가 XObject인 PDF) ──
  const calcMulti = detectCalcMultiPart(textsIn, horiz, r);
  if (calcMulti) return calcMulti;

  // ── 0-c) 세로셈 (표·열 정렬 휴리스틱보다 우선) ───────
  const verticalArithmetic = detectVerticalArithmetic(textsIn, horiz, vert, r);
  if (verticalArithmetic) return verticalArithmetic;

  // ── 1) 표 (격자선) — 진짜 격자만 인정 ────────────────
  // 짧은 데코 선(분수선, 등호, 밑줄)은 무시. 영역 너비/높이의 30% 이상 뻗어야 격자 후보.
  const longHoriz = horiz
    .filter((s) => (s.x2 - s.x1) >= r.w * 0.3)
    .map((s) => ({ ...s, len: s.x2 - s.x1 }));
  const longVert = vert
    .filter((s) => (s.y2 - s.y1) >= r.h * 0.3)
    .map((s) => ({ ...s, len: s.y2 - s.y1 }));

  // 진짜 격자: 수평선 ≥3개 + 수직선 ≥2개 (또는 반대) 이고, 교차점이 ≥6
  // (문항 테두리 사각형 1개는 수평 2 + 수직 2 + 교차점 4 → 통과 X)
  if (
    (longHoriz.length >= 3 && longVert.length >= 2) ||
    (longHoriz.length >= 2 && longVert.length >= 3)
  ) {
    const intersections = countGridIntersections(longHoriz, longVert);
    if (intersections >= 6) {
      return {
        type: '표',
        confidence: 0.92,
        debug: { longHoriz: longHoriz.length, longVert: longVert.length, intersections, mode: 'grid-lines' },
      };
    }
  }

  // ── 1-a) 표 (격자선 — 지문+표가 한 영역에 있을 때) ─────────
  // 세로선이 영역 높이의 30% 미만(표만 중간에 작게 있음)이어도, 가로선 2+·세로 2+·교차 4+ 면 표
  const medHoriz = horiz
    .filter((s) => (s.x2 - s.x1) >= r.w * 0.2)
    .map((s) => ({ ...s, len: s.x2 - s.x1 }));
  const medVert = vert
    .filter((s) => (s.y2 - s.y1) >= r.h * 0.1)
    .map((s) => ({ ...s, len: s.y2 - s.y1 }));
  if (medHoriz.length >= 2 && medVert.length >= 2) {
    const embeddedIx = countGridIntersections(medHoriz, medVert);
    // 사각형 1개 테두리만이면 교차 4 — 데이터 표 아님(상자·빈칸 박스 등)
    if (embeddedIx >= 6 || (embeddedIx >= 4 && (medHoriz.length >= 3 || medVert.length >= 3))) {
      return {
        type: '표',
        confidence: 0.88,
        debug: {
          medHoriz: medHoriz.length,
          medVert: medVert.length,
          intersections: embeddedIx,
          mode: 'grid-lines-embedded',
        },
      };
    }
  }

  // ── 1-b) 표 (텍스트 열 정렬 + 숫자 칸) — 데이터 표 전용 ────
  const textTable = detectTextAlignedDataTable(textsIn, r, horiz);
  if (textTable) return textTable;

  // ── 2) 선잇기 ──────────────────────────────────────────
  // 좌·우 두 군집 사이에 **명백한 가운데 여백** + (점선 패턴 ∥ 양쪽 페어링 가로선)
  if (textsIn.length >= 4) {
    const xs = textsIn.map((t) => t.cx).sort((a, b) => a - b);
    const minX = xs[0];
    const maxX = xs[xs.length - 1];
    if (maxX - minX >= r.w * 0.35) {
      const mid = (minX + maxX) / 2;
      const left = textsIn.filter((t) => t.cx < mid);
      const right = textsIn.filter((t) => t.cx >= mid);
      const leftMaxX = left.length ? Math.max(...left.map((t) => t.cx + (t.h || 0))) : 0;
      const rightMinX = right.length ? Math.min(...right.map((t) => t.cx)) : 0;
      const middleGap = rightMinX - leftMaxX;
      const leftRatio = left.length / textsIn.length;

      if (
        left.length >= 2 &&
        right.length >= 2 &&
        leftRatio >= 0.3 &&
        leftRatio <= 0.7 &&
        middleGap >= r.w * 0.15        // 가운데에 진짜 여백 (선잇기 사이 점선/공백 자리)
      ) {
        // 좌-우 페어링 (같은 y±medH 안에 양쪽 존재)
        const heights = textsIn.map((t) => t.h).filter((h) => h > 0);
        const medH = heights.length
          ? heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)]
          : 14;
        const yTol = Math.max(medH * 0.8, 10);
        let pairs = 0;
        for (const L of left) {
          if (right.some((R) => Math.abs(R.cy - L.cy) <= yTol)) pairs++;
        }
        const dottyText = textsIn.some((t) => /·{2,}|\.{3,}|⋯|…/.test(t.str));
        // 가운데 영역을 가로지르는 짧은 가로선 (선 잇기 전용 선이 그어진 경우)
        const midZoneHoriz = horiz.filter((s) => {
          const my = (s.y1 + s.y2) / 2;
          const sLen = s.x2 - s.x1;
          return sLen > r.w * 0.05 && sLen < r.w * 0.6 &&
                 my >= r.y && my <= r.y + r.h &&
                 (s.x1 + s.x2) / 2 >= leftMaxX - 5 &&
                 (s.x1 + s.x2) / 2 <= rightMinX + 5;
        });

        if (pairs >= 3 && (dottyText || midZoneHoriz.length >= 2)) {
          return {
            type: '선잇기',
            confidence: dottyText && midZoneHoriz.length >= 2 ? 0.9 :
                        dottyText || midZoneHoriz.length >= 2 ? 0.82 : 0.7,
            debug: { pairs, dottyText, midZoneHoriz: midZoneHoriz.length, middleGap },
          };
        }
      }
    }
  }

  // ── 3) 세로셈 (보조 — 좁은 단일 식 영역) ───────────────
  const isNarrow = r.w / Math.max(r.h, 1) < 0.7 && r.h > 40;
  if (isNarrow && textsIn.length >= 3) {
    const numericLines = textsIn.filter((t) => /^[\d\s+\-×÷=().]+$/.test(t.str.trim())).length;
    const total = textsIn.length;
    const numericRatio = total ? numericLines / total : 0;
    if (numericRatio >= 0.6 && horiz.length >= 1) {
      return { type: '세로셈', confidence: 0.75, debug: { numericRatio, horiz: horiz.length, mode: 'narrow-stack' } };
    }
  }
  // ── 4) 빈칸채우기 ──────────────────────────────────────
  // □/▢/( ) 패턴 다수 (텍스트 아이템에 등장) — 5지선다는 제외
  if (isMultipleChoiceStem(textsIn, joinedEarly)) {
    return {
      type: '기타',
      confidence: 0.84,
      debug: { reason: 'multiple-choice-late', labels: countChoiceLabels(textsIn) },
    };
  }
  const blankCount = textsIn.reduce((acc, t) => {
    const s = t.str;
    let n = 0;
    n += (s.match(/[□▢☐]/g) || []).length;
    n += (s.match(/\(\s+\)/g) || []).length;
    n += (s.match(/_{2,}/g) || []).length;
    return acc + n;
  }, 0);
  if (blankCount >= 2) {
    return { type: '빈칸채우기', confidence: 0.75, debug: { blankCount } };
  }

  // ── 5) 결정 보류: AI 보강 or 사용자 토글에 맡김 ──
  return {
    type: 'unknown',
    confidence: 0,
    debug: {
      textsIn: textsIn.length,
      horiz: horiz.length,
      vert: vert.length,
      longHoriz: longHoriz.length,
      longVert: longVert.length,
    },
  };
}

/**
 * 페이지 좌표계 이미지 박스 → 부모 영역(rectN, 0~1) 기준 0~1 상대 좌표로 변환.
 * 호출자가 imageRegions[]를 region에 저장할 때 사용.
 */
export function imageBoxToRelativeRect(box, meta, parentRectN) {
  const px = parentRectN.x * meta.width;
  const py = parentRectN.y * meta.height;
  const pw = parentRectN.w * meta.width;
  const ph = parentRectN.h * meta.height;
  if (pw <= 0 || ph <= 0) return null;
  return {
    x: Math.max(0, Math.min(1, (box.x - px) / pw)),
    y: Math.max(0, Math.min(1, (box.y - py) / ph)),
    w: Math.max(0, Math.min(1, box.w / pw)),
    h: Math.max(0, Math.min(1, box.h / ph)),
  };
}
