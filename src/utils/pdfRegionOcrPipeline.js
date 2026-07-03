/**
 * PDF 영역 선택 → 크롭 → parse-problem(single_pipeline) → UnitTestReview 문제 목록
 * PDFRegionSelector 의 검수/OCR 로직 공유 (일괄 검수 + 문항별 선행 OCR)
 */

import { normalizeExamQuestionText } from './examBlankBrackets';
import {
  normalizeBlankFillArithmeticProblem,
  normalizeNumberCardProblem,
  normalizeOperationBoxProblem,
} from './pdfRegionNumberCards';
import { resolveProblemType } from './problemTypeFromContent';
import { normalizeMatchingPayload } from './matchingItems';

export const RENDER_SCALE = 3.0;

export const OCR_CONCURRENCY = (() => {
  const raw = Number(process.env.REACT_APP_OCR_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 10) return Math.floor(raw);
  return 1;
})();

/** OCR 결과가 비었거나 거절됐으면 재시도 대상 */
export function ocrResultNeedsRetry(entry) {
  if (!entry) return true;
  if (entry.status === 'rejected') return true;
  if (entry.status === 'fulfilled') {
    const v = entry.value;
    if (v?.isImageMode) return false;
    return !v?.parsed;
  }
  return false;
}

export async function runWithConcurrency(items, limit, asyncFn) {
  const total = items.length;
  const results = new Array(total);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit | 0 || 1, total));
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      try {
        const value = await asyncFn(items[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function problemDisplayLabel(v) {
  return String(v ?? '').trim() || '?';
}

export function problemBaseInt(v) {
  const s = problemDisplayLabel(v);
  const m = s.match(/^(\d{1,2})(?:-\d{1,3})?$/);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(s.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : NaN;
}

function sortRegionsTopToBottom(regs) {
  return [...regs].sort((a, b) => {
    if (Math.abs(a.y - b.y) > 1e-4) return a.y - b.y;
    return a.x - b.x;
  });
}

function collectManualMergeChains(ordered) {
  const consumed = new Set();
  const chains = [];
  for (let i = 0; i < ordered.length; i++) {
    if (consumed.has(ordered[i].id)) continue;
    if (ordered[i]?.groupId != null) continue;
    if (ordered[i + 1]?.groupId != null) continue;
    if (ordered[i + 1] && ordered[i].vmMergeAfter === ordered[i + 1].id) {
      const chain = [ordered[i]];
      let j = i;
      while (ordered[j + 1] && ordered[j].vmMergeAfter === ordered[j + 1].id) {
        j += 1;
        chain.push(ordered[j]);
      }
      chain.forEach((r) => consumed.add(r.id));
      chains.push(chain);
    }
  }
  return { chains, consumed };
}

export function buildApiUnits(ordered) {
  const { chains, consumed } = collectManualMergeChains(ordered);
  const manualUnits = chains.map((regions) => ({ kind: 'merged', regions }));

  const remaining = ordered.filter((r) => !consumed.has(r.id));

  const mergeKey = (r) => {
    if (r.groupId != null) return null;
    const n = problemBaseInt(r.problem_number);
    if (!Number.isFinite(n) || n < 1) return null;
    return `${r.page}:${n}`;
  };
  const byKey = new Map();
  for (const r of remaining) {
    const k = mergeKey(r);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const mergedKeys = new Set(
    [...byKey.entries()].filter(([, arr]) => arr.length >= 2).map(([k]) => k),
  );
  const autoKeyConsumed = new Set();
  const autoUnits = [];
  for (const r of remaining) {
    const k = mergeKey(r);
    if (!k) {
      autoUnits.push({ kind: 'single', regions: [r] });
      continue;
    }
    if (mergedKeys.has(k)) {
      if (autoKeyConsumed.has(k)) continue;
      autoKeyConsumed.add(k);
      autoUnits.push({ kind: 'merged', regions: sortRegionsTopToBottom(byKey.get(k)) });
    } else {
      autoUnits.push({ kind: 'single', regions: [r] });
    }
  }

  const idToUnit = new Map();
  for (const u of manualUnits) {
    u.regions.forEach((reg) => idToUnit.set(reg.id, u));
  }
  for (const u of autoUnits) {
    for (const reg of u.regions) {
      if (!idToUnit.has(reg.id)) idToUnit.set(reg.id, u);
    }
  }

  const out = [];
  const seenUnit = new Set();
  for (const r of ordered) {
    const u = idToUnit.get(r.id);
    if (!u || seenUnit.has(u)) continue;
    seenUnit.add(u);
    out.push(u);
  }
  return out;
}

export async function verticalMergeRegionsToPng(regions, pageCache, gapPx = 6) {
  if (!regions.length) throw new Error('병합할 영역이 없습니다.');
  const crops = regions.map((r) => {
    const pc = pageCache[r.page];
    if (!pc) throw new Error(`페이지 ${r.page} 캔버스가 없습니다.`);
    const { canvas: pgCanvas, viewport: pgVp } = pc;
    const cx = Math.round(r.x * pgVp.width);
    const cy = Math.round(r.y * pgVp.height);
    const cw = Math.max(Math.round(r.w * pgVp.width), 1);
    const ch = Math.max(Math.round(r.h * pgVp.height), 1);
    return { r, pgCanvas, cx, cy, cw, ch };
  });
  const maxW = Math.max(...crops.map((c) => c.cw));
  const totalH = crops.reduce((s, c) => s + c.ch, 0) + gapPx * Math.max(0, crops.length - 1);
  const out = document.createElement('canvas');
  out.width = maxW;
  out.height = Math.max(totalH, 1);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, maxW, out.height);
  const yOffsetByRegionId = {};
  let yOff = 0;
  for (let i = 0; i < crops.length; i++) {
    const { r, pgCanvas, cx, cy, cw, ch } = crops[i];
    yOffsetByRegionId[r.id] = yOff;
    ctx.drawImage(pgCanvas, cx, cy, cw, ch, 0, yOff, cw, ch);
    yOff += ch + (i < crops.length - 1 ? gapPx : 0);
  }
  const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
  const cropDataUrl = await new Promise((res) => {
    const reader = new FileReader();
    reader.onload = (e) => res(e.target.result);
    reader.readAsDataURL(blob);
  });
  return { blob, cropDataUrl, yOffsetByRegionId, primaryRegion: regions[0] };
}

export async function stackDataUrlsToSingle(passageDataUrl, questionDataUrls) {
  const urls = [passageDataUrl, ...(questionDataUrls || [])].filter(Boolean);
  if (!urls.length) return null;
  const imgs = await Promise.all(
    urls.map(
      (u) =>
        new Promise((resolve) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => resolve(null);
          im.src = u;
        }),
    ),
  );
  const ok = imgs.filter(Boolean);
  if (!ok.length) return null;
  const widths = ok.map((im) => im.naturalWidth || im.width || 1);
  const heights = ok.map((im) => im.naturalHeight || im.height || 1);
  const W = Math.max(...widths);
  const gap = 10;
  const H = heights.reduce((s, h) => s + h, 0) + gap * Math.max(0, ok.length - 1);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  let y = 0;
  for (let i = 0; i < ok.length; i++) {
    const im = ok[i];
    const iw = im.naturalWidth || im.width || 1;
    const ih = im.naturalHeight || im.height || 1;
    ctx.drawImage(im, 0, y, iw, ih);
    y += ih + (i < ok.length - 1 ? gap : 0);
  }
  return c.toDataURL('image/jpeg', 0.9);
}

export function getOcrUnitKey(unit) {
  const ids = unit.regions.map((r) => r.id).sort((a, b) => a - b);
  return unit.kind === 'merged' ? `m:${ids.join(',')}` : `s:${ids[0]}`;
}

/** OCR·문항 확인 대상 (보기 passage 제외) */
export function listQuestionOcrUnits(regions) {
  const ordered = regions.filter((r) => !r.isImageRegion);
  const apiUnits = buildApiUnits(ordered);
  return apiUnits
    .filter((u) => u.regions[0].groupRole !== 'passage')
    .map((u) => ({
      key: getOcrUnitKey(u),
      unit: u,
      primaryRegion: u.regions[0],
      label: problemDisplayLabel(u.regions[0].problem_number),
    }));
}

/** 선택된 영역 패널용 번호 상태 */
export function getRegionNumberStatus(region, allRegions) {
  if (region.isImageRegion || region.groupRole === 'passage') return null;
  if (region.detecting) return 'detecting';
  const label = problemDisplayLabel(region.problem_number);
  if (!label || label === '?') return 'missing';
  const parents = allRegions.filter(
    (r) => !r.isImageRegion && r.groupRole !== 'passage',
  );
  const dup = parents.some(
    (r) =>
      r.id !== region.id &&
      problemDisplayLabel(r.problem_number) === label,
  );
  if (dup) return 'duplicate';
  return 'ok';
}

export function canOpenProblemConfirm(regions) {
  if (regions.some((r) => r.detecting)) return false;
  const questions = regions.filter(
    (r) => !r.isImageRegion && r.groupRole !== 'passage',
  );
  if (questions.length === 0) return false;
  return questions.every((r) => getRegionNumberStatus(r, regions) !== 'missing');
}

export async function preparePageCache(pdfDoc, pageNums, scale = RENDER_SCALE) {
  const pageCache = {};
  for (const pageNum of pageNums) {
    const pg = await pdfDoc.getPage(pageNum);
    const vp = pg.getViewport({ scale });
    const tempC = document.createElement('canvas');
    tempC.width = vp.width;
    tempC.height = vp.height;
    await pg.render({ canvasContext: tempC.getContext('2d'), viewport: vp }).promise;
    pageCache[pageNum] = { canvas: tempC, viewport: vp };
  }
  return pageCache;
}

async function cropSingleFromCache(region, pageCache) {
  if (region.cropDataUrl) {
    try {
      const res = await fetch(region.cropDataUrl);
      const blob = await res.blob();
      return { blob, cropDataUrl: region.cropDataUrl };
    } catch {
      /* fall through */
    }
  }
  const { canvas: pgCanvas, viewport: pgVp } = pageCache[region.page];
  const cx = Math.round(region.x * pgVp.width);
  const cy = Math.round(region.y * pgVp.height);
  const cw = Math.round(region.w * pgVp.width);
  const ch = Math.round(region.h * pgVp.height);
  const cropC = document.createElement('canvas');
  cropC.width = Math.max(cw, 1);
  cropC.height = Math.max(ch, 1);
  cropC.getContext('2d').drawImage(pgCanvas, cx, cy, cw, ch, 0, 0, cw, ch);
  const blob = await new Promise((res) => cropC.toBlob(res, 'image/png'));
  const cropDataUrl = await new Promise((res) => {
    const reader = new FileReader();
    reader.onload = (e) => res(e.target.result);
    reader.readAsDataURL(blob);
  });
  return { blob, cropDataUrl };
}

/** apiUnits 순서와 동일한 cropData[] + imgSubCropMap */
export async function buildCropPipelineData(regions, pageCache) {
  const ordered = regions.filter((r) => !r.isImageRegion);
  const imgRegions = regions.filter((r) => r.isImageRegion);
  const apiUnits = buildApiUnits(ordered);

  const cropData = await Promise.all(
    apiUnits.map(async (unit) => {
      if (unit.kind === 'merged') {
        const { blob, cropDataUrl, yOffsetByRegionId, primaryRegion } =
          await verticalMergeRegionsToPng(unit.regions, pageCache, 6);
        return {
          unit,
          region: primaryRegion,
          mergedRegionIds: unit.regions.map((rr) => rr.id),
          yOffsetByRegionId,
          blob,
          cropDataUrl,
        };
      }
      const r0 = unit.regions[0];
      const { blob, cropDataUrl } = await cropSingleFromCache(r0, pageCache);
      return {
        unit,
        region: r0,
        mergedRegionIds: [r0.id],
        yOffsetByRegionId: { [r0.id]: 0 },
        blob,
        cropDataUrl,
      };
    }),
  );

  const imgSubCropMap = {};
  await Promise.all(
    imgRegions.map(async (ir) => {
      const parent = ordered.find((r) => r.id === ir.parentId);
      if (!parent) return;

      const { canvas: pgCanvas, viewport: pgVp } =
        pageCache[ir.page] || pageCache[parent.page] || {};
      if (!pgCanvas) return;

      const ix = Math.round(ir.x * pgVp.width);
      const iy = Math.round(ir.y * pgVp.height);
      const iw = Math.max(Math.round(ir.w * pgVp.width), 1);
      const ih = Math.max(Math.round(ir.h * pgVp.height), 1);
      const cc = document.createElement('canvas');
      cc.width = iw;
      cc.height = ih;
      cc.getContext('2d').drawImage(pgCanvas, ix, iy, iw, ih, 0, 0, iw, ih);
      const dataUrl = await new Promise((res) => {
        const rd = new FileReader();
        rd.onload = (ev) => res(ev.target.result);
        cc.toBlob((b) => rd.readAsDataURL(b), 'image/png');
      });

      const px = Math.round(parent.x * pgVp.width);
      const py = Math.round(parent.y * pgVp.height);
      const pw = Math.max(Math.round(parent.w * pgVp.width), 1);
      const ph = Math.max(Math.round(parent.h * pgVp.height), 1);
      const relX = Math.round(ix - px);
      const relY = Math.round(iy - py);

      if (!imgSubCropMap[ir.parentId]) imgSubCropMap[ir.parentId] = [];
      imgSubCropMap[ir.parentId].push({
        imageIdx: ir.imageIdx,
        dataUrl,
        x1: Math.max(0, relX),
        y1: Math.max(0, relY),
        x2: Math.min(pw, relX + iw),
        y2: Math.min(ph, relY + ih),
      });
    }),
  );

  return { ordered, apiUnits, cropData, imgSubCropMap };
}

export function cropEntryIndexByUnitKey(cropData, unitKey) {
  return cropData.findIndex((cd) => getOcrUnitKey(cd.unit) === unitKey);
}

/**
 * 단일 문항(또는 병합 단위) OCR — runAiReviewExtract Step 3 와 동일
 */
export async function runOcrOnCropEntry(
  entry,
  { selGrade, selSemester, selUnit, imgSubCropMap, signal },
) {
  const { region, blob, cropDataUrl, mergedRegionIds, yOffsetByRegionId } = entry;

  if (region.insertMode === 'image') {
    return { parsed: null, cropDataUrl, isImageMode: true };
  }

  const makeForm = (m, problemTypeHint = '') => {
    const f = new FormData();
    f.append('file', blob, `region_p${region.page}_${region.problem_number}.png`);
    f.append('mode', m);
    f.append(
      'problem_number',
      region.problem_number != null ? String(region.problem_number) : '',
    );
    if (selGrade) f.append('grade', selGrade);
    if (selSemester) f.append('semester', selSemester);
    if (selUnit) f.append('unit', selUnit);
    if ((m === 'single' || m === 'single_pipeline') && problemTypeHint) {
      f.append('problem_type_hint', problemTypeHint);
    }
    const subParts = [];
    for (const rid of mergedRegionIds) {
      const y0 = yOffsetByRegionId[rid] ?? 0;
      const subImgs = imgSubCropMap[rid] || [];
      for (const s of subImgs) {
        subParts.push({
          x1: s.x1,
          y1: s.y1 + y0,
          x2: s.x2,
          y2: s.y2 + y0,
        });
      }
    }
    if (subParts.length > 0) {
      f.append('exclude_regions', JSON.stringify(subParts));
    }
    return f;
  };

  const userTypeHint = String(region.problemType || '').trim();
  const pipRes = await fetch('/api/parse-problem', {
    method: 'POST',
    body: makeForm('single_pipeline', userTypeHint),
    signal,
  });
  let pip = {};
  try {
    pip = await pipRes.json();
  } catch {
    pip = {};
  }
  if (!pipRes.ok) {
    const detail =
      typeof pip?.detail === 'string'
        ? pip.detail
        : JSON.stringify(pip?.detail || '');
    throw new Error(detail || `파싱 오류 (${pipRes.status})`);
  }

  const aiType = (pip.problem_type || '기타').trim();
  const arr = Array.isArray(pip.problems) ? pip.problems : [];
  const qPreview = String((arr[0] || {}).question || '');
  const problemType = resolveProblemType(userTypeHint, aiType, qPreview);

  if (problemType === '선잇기') {
    const normalized = normalizeMatchingPayload(pip.matching || {});
    return {
      parsed: {
        question: normalized.question,
        leftItems: normalized.leftItems,
        rightItems: normalized.rightItems,
        leftLabels: normalized.leftLabels,
        rightLabels: normalized.rightLabels,
        problemType: '선잇기',
        choices: null,
      },
      cropDataUrl,
    };
  }

  const parsed = arr[0] ?? null;
  if (parsed && problemType === '표') {
    parsed.problemType = '표';
  }
  return { parsed, cropDataUrl };
}

/** cropData + apiResults(fulfilled/rejected) → unit-test-review용 finalProblems */
export async function assembleFinalProblems(
  ordered,
  apiUnits,
  cropData,
  apiResults,
  imgSubCropMap,
) {
  const regionIdToUnitIndex = new Map();
  apiUnits.forEach((u, ui) => {
    u.regions.forEach((rr) => regionIdToUnitIndex.set(rr.id, ui));
  });
  const mergedPrimaryIdByUi = new Map();
  apiUnits.forEach((u, ui) => {
    if (u.kind === 'merged') {
      mergedPrimaryIdByUi.set(ui, u.regions[0].id);
    }
  });

  const problems = ordered.map((region) => {
    const ui = regionIdToUnitIndex.get(region.id);
    const u = apiUnits[ui];
    if (u.kind === 'merged' && region.id !== mergedPrimaryIdByUi.get(ui)) {
      return { _skipInLayout: true };
    }
    const r = apiResults[ui];
    const cd = cropData[ui];
    const { region: logicalRegion, cropDataUrl, mergedRegionIds } = cd;
    const mergeSourceIds =
      mergedRegionIds.length > 1 ? mergedRegionIds : undefined;

    if (logicalRegion.insertMode === 'image') {
      return {
        number: logicalRegion.problem_number,
        question: '',
        choices: null,
        bogi: null,
        hasImage: true,
        answer: null,
        _uid: logicalRegion.id,
        _mergeSourceIds: mergeSourceIds,
        _failed: false,
        _cropDataUrl: cropDataUrl,
        _isImageOnly: true,
        _apiError: null,
      };
    }

    if (r?.status === 'fulfilled') {
      const { parsed, isImageMode } = r.value;
      const aiNumber = parsed?.questionNumber ?? parsed?.id ?? null;
      const useNumber =
        aiNumber != null && Number.isInteger(aiNumber) && aiNumber > 0
          ? aiNumber
          : logicalRegion.problem_number;
      if (isImageMode) {
        return {
          number: useNumber,
          question: '',
          choices: null,
          bogi: null,
          hasImage: true,
          answer: null,
          _uid: logicalRegion.id,
          _failed: false,
          _mergeSourceIds: mergeSourceIds,
          _cropDataUrl: cropDataUrl,
          _isImageOnly: true,
          _apiError: null,
        };
      }
      return normalizeOperationBoxProblem(normalizeBlankFillArithmeticProblem(normalizeNumberCardProblem({
        number: useNumber,
        question: normalizeExamQuestionText(parsed?.question ?? ''),
        choices: parsed?.choices ?? null,
        bogi: parsed?.bogi ?? null,
        hasImage: parsed?.hasImage ?? false,
        imageDescription: parsed?.imageDescription ?? null,
        answer: null,
        concept: parsed?.concept ?? '',
        geometry_config: parsed?.geometry_config ?? null,
        _uid: logicalRegion.id,
        _mergeSourceIds: mergeSourceIds,
        _failed: !parsed,
        _cropDataUrl: cropDataUrl,
        _apiError: null,
        ...(parsed?.problemType === '선잇기'
          ? {
              problemType: '선잇기',
              leftItems: Array.isArray(parsed.leftItems) ? parsed.leftItems : [],
              rightItems: Array.isArray(parsed.rightItems) ? parsed.rightItems : [],
              leftLabels: Array.isArray(parsed.leftLabels) ? parsed.leftLabels : [],
              rightLabels: Array.isArray(parsed.rightLabels) ? parsed.rightLabels : [],
            }
          : {}),
      })));
    }

    return {
      number: logicalRegion.problem_number,
      question: '',
      choices: null,
      bogi: null,
      hasImage: false,
      answer: null,
      _uid: logicalRegion.id,
      _mergeSourceIds: mergeSourceIds,
      _failed: true,
      _cropDataUrl: cropDataUrl,
      _apiError: r?.reason?.message ?? '알 수 없는 오류',
    };
  });

  const groupMap = {};
  const uidToProblem = new Map();
  const mergeIdToPrimary = new Map();
  for (const p of problems) {
    if (p?._uid == null) continue;
    uidToProblem.set(String(p._uid), p);
    const ids =
      Array.isArray(p._mergeSourceIds) && p._mergeSourceIds.length
        ? p._mergeSourceIds
        : [p._uid];
    for (const mid of ids) mergeIdToPrimary.set(String(mid), p);
  }

  const pushedUngrouped = new Set();
  const ungrouped = [];
  for (let i = 0; i < ordered.length; i++) {
    const region = ordered[i];
    const prob =
      uidToProblem.get(String(region.id)) ??
      mergeIdToPrimary.get(String(region.id));
    if (!prob || prob._skipInLayout) continue;

    if (region.groupId != null) {
      if (!groupMap[region.groupId]) {
        groupMap[region.groupId] = {
          passageItem: null,
          questionItems: [],
          firstIdx: i,
        };
      }
      if (region.groupRole === 'passage') {
        groupMap[region.groupId].passageItem = prob;
      } else {
        groupMap[region.groupId].questionItems.push({
          ...prob,
          _groupOrder: region.groupOrder,
        });
      }
    } else if (prob._uid != null) {
      const uid = String(prob._uid);
      if (!pushedUngrouped.has(uid)) {
        pushedUngrouped.add(uid);
        ungrouped.push({ item: prob, origIdx: i });
      }
    }
  }

  const groupItems = await Promise.all(
    Object.entries(groupMap).map(
      async ([, { passageItem, questionItems, firstIdx }]) => {
        const questions = questionItems
          .sort((a, b) => a._groupOrder - b._groupOrder)
          .map(({ _groupOrder, ...q }) => q);
        const nums = questions.map((q) => q.number).filter(Boolean);
        const label =
          nums.length >= 2
            ? `${Math.min(...nums)}~${Math.max(...nums)}`
            : String(nums[0] ?? '');
        const passageImage =
          passageItem?._cropDataUrl || passageItem?.image_b64 || null;
        const qImgs = questions
          .map((q) => q._cropDataUrl || q.image_b64 || null)
          .filter(Boolean);
        const stacked = await stackDataUrlsToSingle(passageImage, qImgs).catch(
          () => null,
        );
        return {
          _origIdx: firstIdx,
          item: {
            type: 'group',
            label,
            passage: passageItem?.question || '',
            passageImage_b64: passageImage,
            groupStackImage_b64: stacked,
            questions,
          },
        };
      },
    ),
  );

  const allItems = [
    ...ungrouped.map((u) => ({ item: u.item, sortKey: u.origIdx })),
    ...groupItems.map((g) => ({ item: g.item, sortKey: g._origIdx })),
  ].sort((a, b) => a.sortKey - b.sortKey);

  const finalProblems = allItems.map((a) => a.item);

  for (const prob of finalProblems) {
    const uids = prob._mergeSourceIds?.length
      ? prob._mergeSourceIds
      : [prob._uid];
    const mergedSubs = [];
    for (const uid of uids) {
      const subImgs = imgSubCropMap[uid];
      if (subImgs?.length) {
        mergedSubs.push(
          ...[...subImgs].sort((a, b) => a.imageIdx - b.imageIdx),
        );
      }
    }
    if (mergedSubs.length > 0) {
      prob._imageRegions = mergedSubs.map((s) => s.dataUrl);
    }
  }

  return finalProblems;
}
