/** @param {string|undefined|null} iso */
export function isTodayLocal(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
}

/**
 * @param {Array<{ kind?: string; submitCount?: number; firstSubmittedAt?: string; lastSubmittedAt?: string }>} problems
 * @returns {{ variant: { today: number; total: number }; new: { today: number; total: number } }}
 */
export function countMakingSubmitsByKind(problems) {
  const result = {
    variant: { today: 0, total: 0 },
    new: { today: 0, total: 0 },
  };

  (problems || []).forEach((p) => {
    const submitted = (Number(p.submitCount) || 0) > 0 || !!p.lastSubmittedAt;
    if (!submitted) return;

    const kind = p.kind === 'new' ? 'new' : 'variant';
    result[kind].total += 1;

    const firstAt = p.firstSubmittedAt || p.lastSubmittedAt;
    if (isTodayLocal(firstAt)) {
      result[kind].today += 1;
    }
  });

  return result;
}
