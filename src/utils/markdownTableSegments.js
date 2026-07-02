/**
 * 마크다운 파이프 표(| … |) 파싱 — question 본문 내 표 블록 분리·자릿값 표 모서리 보정.
 */

/** `176×76 = | | |` 처럼 식만 있는 행(지문 없음) — 선두 `|` 없는 본문 행 */
function isBareCalcPipeRow(line) {
  const t = line.trim();
  if (!t.includes('|') || !/=\s*\|/.test(t)) return false;
  const beforeEq = t.split('=')[0].trim();
  return /^\d+\s*[×÷]\s*\d+$/.test(beforeEq);
}

/** `지문… 176×76 = | | |` — 앞은 글, 뒤는 표 본문 행 */
function splitMixedProseAndCalcRow(line) {
  const t = line.trim();
  const m = t.match(/^(.+?)(\d+\s*[×÷]\s*\d+\s*=\s*\|.+)$/);
  if (!m) return null;
  const prose = m[1].trimEnd();
  const tableRow = m[2].trim();
  if (!prose || !isBareCalcPipeRow(tableRow)) return null;
  return { prose, tableRow };
}

function isTableLine(line) {
  const t = line.trim();
  if (t.startsWith('|') && t.endsWith('|') && t.length > 1) return true;
  if (isSepLine(line)) return true;
  return isBareCalcPipeRow(line);
}

/**
 * 연속 표 행 수집 — 헤더·구분선·본문 사이 빈 줄은 표 안쪽으로 본다.
 * @param {string[]} lines
 * @param {number} startIdx
 */
function collectConsecutiveTableLines(lines, startIdx) {
  const tableLines = [];
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      if (j < lines.length && isTableLine(lines[j])) {
        i = j;
        continue;
      }
      break;
    }
    if (!isTableLine(line)) break;
    tableLines.push(line);
    i += 1;
  }
  return { tableLines, nextIdx: i };
}

function isSepLine(line) {
  const t = line.trim();
  if (/^\|[\s\-:|]+\|$/.test(t)) return true;
  return /^[\s\-:|]+\|$/.test(t) && t.includes('-');
}

function parseTableRow(line) {
  const t = line.trim();
  let cells;
  if (t.startsWith('|')) {
    const inner = t.endsWith('|') ? t.slice(1, -1) : t.slice(1);
    cells = inner.split('|').map((c) => c.trim());
  } else if (t.includes('|')) {
    cells = t.split('|').map((c) => c.trim());
  } else {
    return [t];
  }
  if (cells.length > 1 && cells[cells.length - 1] === '' && t.endsWith('|') && !t.startsWith('|')) {
    cells.pop();
  }
  return cells;
}

function isPlaceValueLabel(cell) {
  const t = String(cell ?? '').trim();
  if (!t) return false;
  if (/^(천|백|십|일|만|억|조|십만|백만|천만|십억|백억|천억)$/.test(t)) return true;
  if (/^(천|백|십|일)의\s*자리$/.test(t)) return true;
  return false;
}

function looksLikeCalcLabel(cell) {
  const t = String(cell ?? '').trim();
  if (!t) return false;
  return /[×÷=]/.test(t) || /\d.*[+\-*/].*\d/.test(t);
}

function autoFixPlaceValueTableCorner(headerRows, bodyRows) {
  if (!headerRows?.length || !bodyRows?.length) return { headerRows, bodyRows };
  const lastHeader = headerRows[headerRows.length - 1];
  const firstBody = bodyRows[0];
  if (!lastHeader || !firstBody) return { headerRows, bodyRows };

  const hdrAllPlaceValues =
    lastHeader.length >= 2 && lastHeader.every(isPlaceValueLabel);
  if (!hdrAllPlaceValues) return { headerRows, bodyRows };

  const bodyHasCalcInFirstCol = bodyRows.some((r) => looksLikeCalcLabel(r[0]));
  if (!bodyHasCalcInFirstCol) return { headerRows, bodyRows };

  if (lastHeader.length === firstBody.length - 1) {
    return {
      headerRows: headerRows.map((r) => ['', ...r]),
      bodyRows,
    };
  }

  if (lastHeader.length === firstBody.length) {
    return {
      headerRows: headerRows.map((r) => ['', ...r]),
      bodyRows: bodyRows.map((r) => [...r, '']),
    };
  }

  return { headerRows, bodyRows };
}

/**
 * OCR 가 본문 행을 헤더보다 먼저 두거나 구분선 위치가 어긋난 자릿값 표를 정리한다.
 * @param {string[]} tableLines
 * @returns {{ headerRows: string[][], bodyRows: string[][] }}
 */
function normalizePlaceValueTableBlock(tableLines) {
  const sepIdx = tableLines.findIndex((l) => isSepLine(l));
  const parsed = (sepIdx >= 0
    ? [...tableLines.slice(0, sepIdx), ...tableLines.slice(sepIdx + 1)]
    : tableLines
  )
    .filter((l) => !isSepLine(l))
    .map(parseTableRow);

  const placeRows = [];
  const calcRows = [];
  const otherRows = [];

  for (const row of parsed) {
    if (row.some(isPlaceValueLabel) && !looksLikeCalcLabel(row[0])) {
      placeRows.push(row);
    } else if (looksLikeCalcLabel(row[0])) {
      calcRows.push(row);
    } else {
      otherRows.push(row);
    }
  }

  if (placeRows.length > 0) {
    return autoFixPlaceValueTableCorner(placeRows, [...calcRows, ...otherRows]);
  }
  if (calcRows.length > 0) {
    return autoFixPlaceValueTableCorner(otherRows.slice(0, 1), [...calcRows, ...otherRows.slice(1)]);
  }
  return autoFixPlaceValueTableCorner(parsed.slice(0, 1), parsed.slice(1));
}

/** 파싱된 표 세그먼트가 실제 격자로 렌더할 만한지 */
export function isValidTableSegment(seg) {
  if (!seg || seg.type !== 'table') return false;
  const { headerRows = [], bodyRows = [] } = seg;
  if (bodyRows.length > 0) return true;
  const flat = headerRows.flat().filter(Boolean);
  if (flat.length === 0) return false;
  if (flat.some(isPlaceValueLabel)) return false;
  return headerRows.length > 0;
}

function mergeFragmentedTableSegments(segments) {
  const merged = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const next = segments[i + 1];

    if (
      seg.type === 'table' &&
      next?.type === 'table' &&
      (seg.bodyRows?.length ?? 0) === 0 &&
      (next.bodyRows?.length ?? 0) > 0 &&
      (next.headerRows?.length ?? 0) === 0
    ) {
      merged.push({
        type: 'table',
        headerRows: seg.headerRows,
        bodyRows: next.bodyRows,
      });
      i += 1;
      continue;
    }

    if (seg.type === 'text' && !String(seg.content ?? '').trim()) continue;
    merged.push(seg);
  }
  return merged.length > 0 ? merged : segments;
}

const TABLE_SEG_MATH_PLACEHOLDER_RE = /⟦TABLESEG:M(\d+)⟧/g;

/** `$…$` / `$$…$$` 안의 `|`, `\hline` 등이 마크다운 표로 잘못 쪼개지지 않도록 보호 */
function protectMathBlocksForTableParse(text) {
  const blocks = [];
  const protectedText = String(text ?? '').replace(
    /\$\$([\s\S]+?)\$\$|\$([\s\S]+?)\$/g,
    (full) => {
      const id = blocks.length;
      blocks.push(full);
      return `⟦TABLESEG:M${id}⟧`;
    },
  );
  return { protectedText, blocks };
}

function restoreMathBlocksInString(s, blocks) {
  return String(s ?? '').replace(
    TABLE_SEG_MATH_PLACEHOLDER_RE,
    (_, i) => blocks[Number(i)] ?? '',
  );
}

function restoreMathBlocksInSegments(segments, blocks) {
  return segments.map((seg) => {
    if (seg.type === 'text') {
      return { ...seg, content: restoreMathBlocksInString(seg.content, blocks) };
    }
    return {
      ...seg,
      headerRows: seg.headerRows.map((row) =>
        row.map((cell) => restoreMathBlocksInString(cell, blocks)),
      ),
      bodyRows: seg.bodyRows.map((row) =>
        row.map((cell) => restoreMathBlocksInString(cell, blocks)),
      ),
    };
  });
}

/**
 * @param {string} rawText
 * @returns {Array<{ type: 'text', content: string } | { type: 'table', headerRows: string[][], bodyRows: string[][] }>}
 */
export function parseTableSegments(rawText) {
  if (!rawText) return [{ type: 'text', content: '' }];
  const { protectedText, blocks } = protectMathBlocksForTableParse(rawText);
  const lines = protectedText.split('\n');
  const segments = [];
  let textBuf = [];
  let i = 0;
  while (i < lines.length) {
    const mixed = splitMixedProseAndCalcRow(lines[i]);
    if (mixed) {
      if (textBuf.length > 0) {
        segments.push({ type: 'text', content: textBuf.join('\n') });
        textBuf = [];
      }
      const rest = collectConsecutiveTableLines(lines, i + 1);
      const tableLines = [mixed.tableRow, ...rest.tableLines];
      i = rest.nextIdx;
      const { headerRows, bodyRows } = normalizePlaceValueTableBlock(tableLines);
      if (isValidTableSegment({ type: 'table', headerRows, bodyRows })) {
        segments.push({ type: 'text', content: mixed.prose });
        segments.push({ type: 'table', headerRows, bodyRows });
      } else {
        textBuf.push(mixed.prose, ...tableLines);
      }
      continue;
    }

    if (isTableLine(lines[i])) {
      if (textBuf.length > 0) {
        segments.push({ type: 'text', content: textBuf.join('\n') });
        textBuf = [];
      }
      const collected = collectConsecutiveTableLines(lines, i);
      const tableLines = collected.tableLines;
      i = collected.nextIdx;
      const { headerRows, bodyRows } = normalizePlaceValueTableBlock(tableLines);
      if (isValidTableSegment({ type: 'table', headerRows, bodyRows })) {
        segments.push({ type: 'table', headerRows, bodyRows });
      } else {
        textBuf.push(...tableLines);
      }
    } else {
      textBuf.push(lines[i]);
      i += 1;
    }
  }
  if (textBuf.length > 0) segments.push({ type: 'text', content: textBuf.join('\n') });
  const normalized = segments.length > 0 ? segments : [{ type: 'text', content: protectedText }];
  return restoreMathBlocksInSegments(mergeFragmentedTableSegments(normalized), blocks);
}

export function hasMarkdownTable(rawText) {
  return parseTableSegments(rawText || '').some((s) => s.type === 'table' && isValidTableSegment(s));
}

/** tableData 2차원 배열 → 마크다운 표 문자열 */
export function tableDataToMarkdown(tableData) {
  if (!tableData?.length) return '';
  const cols = Math.max(...tableData.map((r) => r.length));
  const rowToMd = (row) => `| ${row.map((c) => c || '   ').join(' | ')} |`;
  const sep = `|${' --- |'.repeat(cols)}`;
  const lines = [];
  if (tableData.length > 0) lines.push(rowToMd(tableData[0]));
  if (tableData.length > 1) {
    lines.push(sep);
    tableData.slice(1).forEach((r) => lines.push(rowToMd(r)));
  }
  return lines.join('\n');
}

/** 표 세그먼트를 파이프 표가 아닌 일반 텍스트로 평탄화 */
export function flattenTableSegmentToPlain(seg) {
  const rows = [...(seg.headerRows || []), ...(seg.bodyRows || [])];
  return rows.map((row) => row.join('\t')).join('\n');
}

/** 세그먼트 배열 → 원본 텍스트 재조합 */
export function segmentsToText(segments) {
  return segments
    .map((seg) => {
      if (seg.type !== 'table') return seg.content;
      const { headerRows, bodyRows } = seg;
      const cols = Math.max(
        ...(headerRows[0] ? [headerRows[0].length] : [0]),
        ...(bodyRows[0] ? [bodyRows[0].length] : [0]),
      );
      const rowToMd = (row) => `| ${row.map((c) => c || '   ').join(' | ')} |`;
      const sep = `|${' --- |'.repeat(cols)}`;
      const lines = [];
      headerRows.forEach((r) => lines.push(rowToMd(r)));
      if (headerRows.length > 0) lines.push(sep);
      bodyRows.forEach((r) => lines.push(rowToMd(r)));
      return lines.join('\n');
    })
    .join('\n');
}
