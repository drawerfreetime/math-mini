/**
 * 단원평가 오답노트 재풀이 AI 검토 — POST /api/review-wrong-note-retry
 */
import { backendUrl, getBackendBaseUrl, backendConfig } from './backendUrl';

const { projectFolder } = backendConfig;
const API_HINT = '.env 의 REACT_APP_API_BASE(원격 API URL)를 확인하세요.';

const REVIEW_POST_PATHS = ['/api/review-wrong-note-retry', '/review-wrong-note-retry'];

async function help404WrongBackend() {
  const base = getBackendBaseUrl().replace(/\/$/, '');
  try {
    const ir = await fetch(`${base}/api/server-info`);
    const t = await ir.text();
    if (!ir.ok) throw new Error('no info');
    const j = JSON.parse(t);
    const file = j.server_py || '(경로 없음)';
    return [
      'AI 검토 API가 없습니다(404). 아래 server.py 가 이 앱의 백엔드인지 확인하세요.',
      file,
      '',
      `다른 터미널을 닫은 뒤 ${API_HINT}`,
    ].join('\n');
  } catch {
    return [
      'AI 검토 API를 찾을 수 없습니다(404).',
      `${API_HINT}`,
    ].join('\n');
  }
}

/**
 * @param {object} payload
 * @returns {Promise<{ approved: boolean, peerReview: boolean, feedback: string, hints: string[], aiMode?: string, checks?: Record<string, boolean> }>}
 */
export async function reviewWrongNoteRetry(payload) {
  let res;
  let raw = '';

  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };

  for (let i = 0; i < REVIEW_POST_PATHS.length; i++) {
    const route = REVIEW_POST_PATHS[i];
    res = await fetch(backendUrl(route), opts);
    raw = await res.text();
    if (res.status !== 404 || i === REVIEW_POST_PATHS.length - 1) break;
  }

  let data = {};
  let parseFailed = false;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    parseFailed = true;
    const head = raw.trim();
    const isHtml = head.startsWith('<!') || head.startsWith('<html');
    if (isHtml) {
      throw new Error(
        `API 대신 HTML 을 받았습니다. (${projectFolder}) ${API_HINT}`
      );
    }
  }

  if (!res.ok) {
    if (parseFailed) {
      throw new Error(
        `검토 서버 오류 (${res.status}). 응답(JSON 아님): ${(raw || '').slice(0, 280) || '빈 본문'}`
      );
    }
    if (res.status === 404) {
      throw new Error(await help404WrongBackend());
    }
    throw new Error(data.detail || data.error || `검토 요청 오류 (${res.status})`);
  }

  if (parseFailed || !data || typeof data !== 'object') {
    throw new Error(raw ? `서버 응답을 읽을 수 없습니다.` : '서버 응답이 비어 있습니다.');
  }

  const chk = data.checks;
  /** @type {Record<string, boolean>|undefined} */
  let checksOut;
  if (chk && typeof chk === 'object' && !Array.isArray(chk)) {
    checksOut = {};
    for (const [k, v] of Object.entries(chk)) {
      if (typeof v === 'boolean') checksOut[k] = v;
    }
    if (Object.keys(checksOut).length === 0) checksOut = undefined;
  }

  return {
    approved: !!data.approved,
    peerReview: !!data.peer_review,
    feedback: data.feedback || '',
    hints: Array.isArray(data.hints) ? data.hints : [],
    aiMode: data.ai_mode || '',
    ...(checksOut ? { checks: checksOut } : {}),
  };
}
