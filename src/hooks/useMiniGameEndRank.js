import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { submitMiniGameDailyBestAndGetRanking } from '../firebase/miniGameDailyOps';

/**
 * 게임 종료(phase === 'done') 시 오늘 최고 점수 저장 + 반 랭킹 조회
 * @param {{ phase: string; gameId: string; sessionScore: number }} p
 */
export function useMiniGameEndRank({ phase, gameId, sessionScore }) {
  const { studentSession } = useAuth();
  const [state, setState] = useState({ loading: false, ranking: null });

  useEffect(() => {
    if (phase !== 'done') {
      setState({ loading: false, ranking: null });
      return undefined;
    }

    const uuid = studentSession?.uuid;
    const classCode = studentSession?.classCode;
    if (!uuid || !gameId) {
      setState({ loading: false, ranking: null });
      return undefined;
    }

    let cancelled = false;
    setState({ loading: true, ranking: null });

    submitMiniGameDailyBestAndGetRanking({
      studentUUID: uuid,
      classCode,
      gameId,
      sessionScore,
      selfRealName: studentSession?.realName,
    })
      .then((result) => {
        if (!cancelled) {
          setState({ loading: false, ranking: result.ranking });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ loading: false, ranking: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    phase,
    gameId,
    sessionScore,
    studentSession?.uuid,
    studentSession?.classCode,
    studentSession?.realName,
  ]);

  return state;
}
