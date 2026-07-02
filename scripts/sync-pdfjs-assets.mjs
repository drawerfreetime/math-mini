#!/usr/bin/env node
/**
 * pdfjs-dist 빌드 산출물을 CRA public/ 으로 복사합니다.
 * 브라우저 worker(importScripts)는 같은 출처 파일이 필요합니다.
 */
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const buildDir = join(root, 'node_modules', 'pdfjs-dist', 'build');
const publicDir = join(root, 'public');

const assets = [
  { src: 'pdf.min.js', dest: 'pdf.min.js' },
  { src: 'pdf.worker.min.js', dest: 'pdf.worker.min.js' },
];

if (!existsSync(buildDir)) {
  console.error('sync-pdfjs-assets: pdfjs-dist가 설치되지 않았습니다. npm install 을 실행하세요.');
  process.exit(1);
}

mkdirSync(publicDir, { recursive: true });

for (const { src, dest } of assets) {
  const from = join(buildDir, src);
  const to = join(publicDir, dest);
  if (!existsSync(from)) {
    console.error(`sync-pdfjs-assets: 원본이 없습니다: ${from}`);
    process.exit(1);
  }
  copyFileSync(from, to);
  console.log(`sync-pdfjs-assets: ${to}`);
}
