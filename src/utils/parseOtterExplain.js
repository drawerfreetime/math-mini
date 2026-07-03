/**
 * otter-explain.txt 파싱
 * 블록 형식:
 *   otter-N
 *   부제목
 *   설명 (한 줄 이상)
 *   잠금 설명 (선택, 마지막 줄 — 미달성 단계 미리보기용)
 */
export function parseOtterExplain(text) {
  const map = {};
  if (!text || typeof text !== 'string') return map;

  const rawBlocks = text.trim().split(/\n\s*\n/);
  const blocks = [];
  rawBlocks.forEach((raw) => {
    if (/^otter-\d+/im.test(raw.trim())) {
      blocks.push(raw);
    } else if (blocks.length > 0) {
      blocks[blocks.length - 1] = `${blocks[blocks.length - 1]}\n\n${raw}`;
    }
  });

  blocks.forEach((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return;

    const id = lines[0];
    const match = /^otter-(\d+)$/i.exec(id);
    if (!match) return;

    const level = Number(match[1]);
    const subtitle = lines[1];
    const bodyLines = lines.slice(2);

    let description = '';
    let lockedDescription = '';

    if (bodyLines.length > 1) {
      lockedDescription = bodyLines[bodyLines.length - 1];
      description = bodyLines.slice(0, -1).join(' ').replace(/\s+/g, ' ').trim();
    } else if (bodyLines.length === 1) {
      description = bodyLines[0].replace(/\s+/g, ' ').trim();
    }

    map[level] = {
      id, level, subtitle, description, lockedDescription,
    };
  });

  return map;
}
