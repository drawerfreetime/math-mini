/**
 * 학생 변형 문제 AI 검토 — POST /api/review-student-variant
 *
 * 백엔드 Fallback (Gemini 전용):
 *   1st: 교사 Gemini 키 (teacherGeminiKey)
 *   2nd: 기본 Gemini 키 (.env REACT_APP_DEFAULT_GEMINI_KEY)
 *   3rd: peer_review 모드 반환 (Gemini 전부 실패 시)
 */

import { backendUrl, getBackendBaseUrl, backendConfig } from './backendUrl';

const { projectFolder } = backendConfig;
const API_HINT = '.env 의 REACT_APP_API_BASE(원격 API URL)를 확인하세요.';

const REVIEW_POST_PATHS = ['/api/review-student-variant', '/review-student-variant'];

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
      '다른 버전(math-app0424 등)이 포트 8001 을 쓰는 경우가 있습니다. 이 프로젝트는 포트 8002 입니다.',
      `다른 터미널을 닫은 뒤 ${API_HINT}`,
    ].join('\n');
  } catch {
    return [
      'AI 검토 API를 찾을 수 없습니다(404).',
      `${API_HINT}`,
      '원격 API 서버가 응답하는지 확인한 뒤 브라우저를 새로고침하세요.',
    ].join('\n');
  }
}

/**
 * @param {object} payload
 * @param {string} payload.question              익명화된 문제 텍스트
 * @param {string} [payload.originalQuestion]
 * @param {string} [payload.originalBogi]
 * @param {string[]|null} [payload.originalChoices]
 * @param {string} [payload.variantStrategyId]
 * @param {string} [payload.variantStrategyName]
 * @param {string} [payload.unitGoal]
 * @param {string} [payload.solutionProcess]
 * @param {string} payload.answer
 * @param {boolean} payload.requiresSolution
 * @param {string|null} [payload.bogi]
 * @param {string[]|null} [payload.choices]
 * @param {string} [payload.examGrade]
 * @param {string} [payload.grade]
 * @param {string} [payload.semester]
 * @param {string} [payload.unit]
 * @param {string} [payload.teacherGeminiKey]    교사 개인 Gemini API 키 (1st fallback용)
 * @returns {Promise<{
 *   approved: boolean,
 *   peerReview: boolean,
 *   feedback: string,
 *   hints: string[],
 *   aiMode?: string,
 *   checks?: Record<string, boolean>
 * }>}
 */
export async function reviewStudentVariant(payload) {
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
        [
          `API 대신 HTML 을 받았습니다. (${projectFolder}) ${API_HINT}`,
          '배포 빌드는 .env 에 REACT_APP_API_BASE 설정 후 재빌드하세요.',
        ].join(' ')
      );
    }
  }

  if (!res.ok) {
    if (parseFailed) {
      throw new Error(
        `검토 서버 오류 (${res.status}). 응답(JSON 아님): ${(raw || '').slice(0, 280) || '빈 본문'} … ` +
          `(REACT_APP_API_BASE·원격 API 서버 확인)`
      );
    }
    if (res.status === 404) {
      throw new Error(await help404WrongBackend());
    }
    throw new Error(data.detail || data.error || `검토 요청 오류 (${res.status})`);
  }

  if (parseFailed || !data || typeof data !== 'object') {
    throw new Error(
      raw
        ? `서버 응답을 읽을 수 없습니다. (${raw.slice(0, 120)}${raw.length > 120 ? '…' : ''})`
        : '서버 응답이 비어 있습니다. 백엔드 실행 여부를 확인해 주세요.'
    );
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
    completionLevel: data.completion_level || '',
    ...(checksOut ? { checks: checksOut } : {}),
  };
}
