import { useCallback, useRef, useState } from 'react';

/**
 * ref(동기) + state(UI) 로 async 버튼 중복 클릭 방지
 */
export function useAsyncLock() {
  const lockRef = useRef(false);
  const [locked, setLocked] = useState(false);

  const acquire = useCallback(() => {
    if (lockRef.current) return false;
    lockRef.current = true;
    setLocked(true);
    return true;
  }, []);

  const release = useCallback(() => {
    lockRef.current = false;
    setLocked(false);
  }, []);

  const withLock = useCallback(
    async (fn) => {
      if (!acquire()) return undefined;
      try {
        return await fn();
      } finally {
        release();
      }
    },
    [acquire, release],
  );

  return { locked, acquire, release, withLock };
}
