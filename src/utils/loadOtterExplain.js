import { parseOtterExplain } from './parseOtterExplain';

const EXPLAIN_URL = `${process.env.PUBLIC_URL}/brand/student/character/otter-explain.txt`;

let cache = null;
let loadPromise = null;

/** 공개 폴더 otter-explain.txt (내용은 .md와 동일, 파서 불필요) */
export function loadOtterExplain() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;

  loadPromise = fetch(EXPLAIN_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`otter-explain fetch ${res.status}`);
      return res.text();
    })
    .then((text) => {
      cache = parseOtterExplain(text);
      return cache;
    })
    .catch(() => {
      cache = {};
      return cache;
    });

  return loadPromise;
}

export function getCachedOtterExplain() {
  return cache;
}
