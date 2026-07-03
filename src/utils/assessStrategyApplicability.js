/**
 * 전략 생략 추천 — POST /api/assess-strategy-applicability
 * (Gemini 문제 만들기 6전략 지시 + 결정론적 폴백)
 */
import { getBackendBaseUrl, backendConfig } from './backendUrl';

const PATHS = ['/api/assess-strategy-applicability', '/assess-strategy-applicability'];

function buildRequestUrls() {
  const envBase = getBackendBaseUrl().replace(/\/$/, '');
  if (envBase) {
    return PATHS.map((p) => `${envBase}${p}`);
  }
  const direct = `http://${backendConfig.host}:${backendConfig.port}`;
  const out = [];
  PATHS.forEach((p) => out.push(p));
  if (typeof window !== 'undefined') {
    PATHS.forEach((p) => out.push(`${direct}${p}`));
  }
  return [...new Set(out)];
}

/**
 * @param {{ questionPlain: string; bogi?: string; choices?: string[]|null }} p
 * @returns {Promise<{ signals: object; byStrategy: Record<string, { level: string; reasonHint: string; reason: string; message: string }>; mcqNote?: string }>}
 */
export function buildStrategyApplicabilityCacheKey(p) {
  const choices = Array.isArray(p.choices)
    ? p.choices.map((c) => String(c || '').trim()).filter(Boolean).join('§')
    : '';
  return `${p.questionPlain || ''}||${p.bogi || ''}||${choices}`;
}

export async function fetchStrategyApplicability(p) {
  const choices = Array.isArray(p.choices)
    ? p.choices.map((c) => String(c || '').trim()).filter(Boolean)
    : null;
  const body = JSON.stringify({
    questionPlain: p.questionPlain || '',
    bogi: p.bogi || '',
    choices: choices && choices.length ? choices : null,
    questionNumber: p.questionNumber ?? null,
    unitLabel: p.unitLabel || '',
  });
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
  const urls = buildRequestUrls();

  let res;
  let raw = '';
  for (let i = 0; i < urls.length; i++) {
    res = await fetch(urls[i], opts);
    raw = await res.text();
    if (res.ok) break;
    if (res.status !== 404) break;
    if (i === urls.length - 1) break;
  }

  if (!res.ok) {
    let detail = raw;
    try {
      const j = JSON.parse(raw);
      detail = j.detail || j.error || raw;
    } catch {
      /* ignore */
    }
    throw new Error(typeof detail === 'string' ? detail : '전략 적용 가능 여부를 불러오지 못했습니다.');
  }

  try {
    return raw ? JSON.parse(raw) : { signals: {}, byStrategy: {} };
  } catch {
    throw new Error('서버 응답을 해석할 수 없습니다.');
  }
}

/**
 * @param {string} level
 * @returns {boolean}
 */
export function shouldRecommendStrategySkip(level) {
  return level === 'weak' || level === 'not_applicable';
}
