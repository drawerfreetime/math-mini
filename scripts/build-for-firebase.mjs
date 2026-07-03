/**
 * Firebase Hosting 배포용 빌드 — API를 Railway 백엔드로 연결합니다.
 * 사용: npm run build:firebase  →  firebase deploy --only hosting
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const apiBase =
  (process.env.REACT_APP_API_BASE || '').trim().replace(/\/$/, '')
  || 'https://susayeon58-production.up.railway.app';

console.log('[build:firebase] REACT_APP_API_BASE =', apiBase);

const r = spawnSync('npx', ['react-scripts', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, REACT_APP_API_BASE: apiBase },
  shell: true,
});

process.exit(r.status ?? 1);
