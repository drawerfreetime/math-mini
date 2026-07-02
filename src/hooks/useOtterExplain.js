import { useState, useEffect } from 'react';
import { getCachedOtterExplain, loadOtterExplain } from '../utils/loadOtterExplain';

export function useOtterExplain() {
  const [explains, setExplains] = useState(() => getCachedOtterExplain() ?? {});
  const [loading, setLoading] = useState(!getCachedOtterExplain());

  useEffect(() => {
    let cancelled = false;
    loadOtterExplain().then((data) => {
      if (!cancelled) setExplains(data);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return { explains, loading };
}
