import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { fetchMiniGameDailyRanking } from '../firebase/miniGameDailyOps';

/**
 * @param {{ gameId: string; enabled?: boolean }} p
 */
export function useMiniGameRankBoard({ gameId, enabled = true }) {
  const { studentSession } = useAuth();
  const [state, setState] = useState({ loading: false, ranking: null, error: false });

  const reload = useCallback(() => {
    const classCode = studentSession?.classCode;
    const uuid = studentSession?.uuid;
    if (!enabled || !gameId || !classCode) {
      setState({ loading: false, ranking: null, error: false });
      return Promise.resolve(null);
    }

    setState({ loading: true, ranking: null, error: false });

    return fetchMiniGameDailyRanking(classCode, gameId, {
      highlightUuid: uuid,
      selfRealName: studentSession?.realName,
    })
      .then((ranking) => {
        setState({ loading: false, ranking, error: false });
        return ranking;
      })
      .catch(() => {
        setState({ loading: false, ranking: null, error: true });
        return null;
      });
  }, [
    enabled,
    gameId,
    studentSession?.classCode,
    studentSession?.uuid,
    studentSession?.realName,
  ]);

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, ranking: null, error: false });
      return undefined;
    }
    let cancelled = false;
    reload().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, reload]);

  return { ...state, reload };
}
