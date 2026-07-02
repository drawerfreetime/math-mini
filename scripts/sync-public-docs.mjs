#!/usr/bin/env node
/**
 * 법적·안내 문서 원본(docs/)을 CRA public 폴더로 복사합니다.
 * 브라우저에서 fetch로 읽으므로 빌드 결과에 포함되려면 public에 있어야 합니다.
 */
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const destDir = join(root, 'public', 'docs');

const files = ['privacy-policy.md', 'terms-of-service.md'];

mkdirSync(destDir, { recursive: true });

for (const name of files) {
  const src = join(root, 'docs', name);
  const dest = join(destDir, name);

  if (!existsSync(src)) {
    console.error(`sync-public-docs: 원본이 없습니다: ${src}`);
    process.exit(1);
  }

  copyFileSync(src, dest);
  console.log(`sync-public-docs: ${dest}`);
}
