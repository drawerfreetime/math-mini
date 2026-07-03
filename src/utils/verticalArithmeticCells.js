/**
 * 세로셈(MULTVERT/LONGDIV) 격자 — 한 칸에 글자 하나.
 * 가로 빈칸 규칙 `[  ㉠  ]` 는 세로셈 행 안에서 쓰지 않는다.
 */

/** MULTVERT/LONGDIV 한 행 문자열 정규화 */
export function normalizeVerticalArithmeticRow(row) {
  let s = String(row ?? '');
  s = s.replace(/\[\s*([㉠-㉣])\s*\]/g, '$1');
  s = s.replace(/\[\s*\(([ㄱ-ㅎ])\)\s*\]/g, '$1');
  s = s.replace(/\[\s*([ㄱ-ㅎ])\s*\]/g, '$1');
  s = s.replace(/\[\s+\]/g, '');
  s = s.replace(/\[\s*\]/g, '');
  return s;
}

function processVerticalScriptBlock(inner) {
  const t = String(inner ?? '').trim();
  if (/^MULTVERT/i.test(t)) {
    return String(inner).replace(/rows\s*:\s*"([^"]*)"/i, (m, rowsStr) => {
      const rows = rowsStr.split('#').map((r) => normalizeVerticalArithmeticRow(r.trim()));
      return `rows: "${rows.join(' # ')}"`;
    });
  }
  const ld = t.match(
    /^LONGDIV\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}(?:\s+STEPS\s+\{([^}]*)\})?\s*$/i,
  );
  if (ld) {
    const d = normalizeVerticalArithmeticRow(ld[1]);
    const n = normalizeVerticalArithmeticRow(ld[2]);
    const q = normalizeVerticalArithmeticRow(ld[3]);
    const stepsPart = ld[4]
      ? ` STEPS {${ld[4].split('#').map((s) => normalizeVerticalArithmeticRow(s.trim())).join('#')}}`
      : '';
    return `LONGDIV {${d}} {${n}} {${q}}${stepsPart}`;
  }
  return inner;
}

/** question 본문의 `$MULTVERT…$`·`$LONGDIV…$` 안 행을 격자 1칸=1글자로 정리 */
export function normalizeVerticalScriptsInText(text) {
  let s = String(text ?? '');
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (full, inner) => {
    const out = processVerticalScriptBlock(inner);
    return out !== inner ? `$$${out}$$` : full;
  });
  s = s.replace(/\$([^$\n]+)\$/g, (full, inner) => {
    const out = processVerticalScriptBlock(inner);
    return out !== inner ? `$${out}$` : full;
  });
  return s;
}
