import backend from '../config/backend.json';

const DEFAULT_ORIGIN = `http://${backend.host}:${backend.port}`;

/**
 * Python API 베이스 URL.
 *
 * - REACT_APP_API_BASE 가 있으면 별도 호스트(배포 분리)로 직접 호출.
 * - 브라우저에서 미설정이면 '' → 현재 출처의 `/api/*`만 사용(CRA dev 서버의 setupProxy로 전달, CORS 불필요).
 * - SSR 등 window 없음 → backend.json 기본 경로.
 *
 * 덮어쓰기: REACT_APP_API_BASE=http://호스트:포트
 */
export function getBackendBaseUrl() {
  const env = (process.env.REACT_APP_API_BASE || '').trim().replace(/\/$/, '');
  if (env) return env;
  if (typeof window !== 'undefined') {
    return '';
  }
  return DEFAULT_ORIGIN;
}

export { backend as backendConfig };

/** @param {string} path 예: '/api/review-student-variant' */
export function backendUrl(path) {
  const b = getBackendBaseUrl();
  const p = path.startsWith('/') ? path : `/${path}`;
  return b ? `${b}${p}` : p;
}
