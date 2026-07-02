/**
 * 수사연 — 변형·제출 선검증(전략 선택 필요, 복붙 차단) + 제출 잠금
 * 단원 목표·수학 성립은 AI 검토 API에서 판정한다.
 */
import { useState, useCallback, useRef, useMemo } from 'react';
import {
  validateInvestigationSubmit,
  validateMcqDuplicateChoices,
  isStudentWorkIdenticalToOriginal,
  ETHICS_EXACT_COPY_MSG,
  DEFAULT_SIMILARITY_THRESHOLD,
} from '../utils/investigationSubmitValidation';
import { mathTextToPlainString } from '../components/ExamOCR';

/**
 * @param {object} p
 * @param {object} p.original Firestore question doc
 */
export function useInvestigation({ original }) {
  const [strategyId, setStrategyId] = useState(null);
  const [submitError, setSubmitError] = useState('');
  const [submitLocked, setSubmitLocked] = useState(false);
  const submitLockRef = useRef(false);

  const originalPlain = useMemo(
    () => ({
      question: mathTextToPlainString(original?.question || original?.text || ''),
      bogi: mathTextToPlainString(original?.bogi || ''),
      choices: (original?.choices || []).map((c) => mathTextToPlainString(String(c))),
    }),
    [original]
  );

  const toggleStrategy = useCallback((id) => {
    setStrategyId((cur) => (cur === id ? null : id));
    setSubmitError('');
  }, []);

  const resetInvestigation = useCallback(() => {
    setStrategyId(null);
    setSubmitError('');
    submitLockRef.current = false;
    setSubmitLocked(false);
  }, []);

  /**
   * @returns {{ ok: boolean, message?: string }}
   */
  const validateBeforeAiCall = useCallback(
    ({ question, bogi, choices, hasChoices }) => {
      if (!strategyId) {
        return {
          ok: false,
          message:
            '연구원님, 문제 만들기 전략을 하나 선택해 주세요! 그에 맞게 변형하면 더 좋아요.',
        };
      }

      const qPlain = mathTextToPlainString(question.trim());
      const bPlain = mathTextToPlainString(String(bogi ?? '').trim());
      const cPlain = (hasChoices ? choices : []).map((c) => mathTextToPlainString(String(c)));

      if (
        isStudentWorkIdenticalToOriginal(
          originalPlain.question,
          qPlain,
          originalPlain.bogi,
          bPlain,
          originalPlain.choices,
          hasChoices ? cPlain : []
        )
      ) {
        return { ok: false, message: ETHICS_EXACT_COPY_MSG };
      }

      const v = validateInvestigationSubmit({
        originalQuestionPlain: originalPlain.question,
        newQuestionPlain: qPlain,
        originalBogiPlain: originalPlain.bogi,
        newBogiPlain: bPlain,
        originalChoices: originalPlain.choices,
        newChoices: hasChoices ? cPlain : [],
        similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
      });
      if (!v.ok) return { ok: false, message: v.message };

      if (hasChoices) {
        const dup = validateMcqDuplicateChoices(cPlain);
        if (!dup.ok) return { ok: false, message: dup.message };
      }

      return { ok: true };
    },
    [originalPlain, strategyId]
  );

  const beginSubmit = useCallback(() => {
    if (submitLockRef.current) return false;
    submitLockRef.current = true;
    setSubmitLocked(true);
    setSubmitError('');
    return true;
  }, []);

  const endSubmit = useCallback(() => {
    submitLockRef.current = false;
    setSubmitLocked(false);
  }, []);

  return {
    strategyId,
    setStrategyId,
    toggleStrategy,
    resetInvestigation,
    validateBeforeAiCall,
    submitError,
    setSubmitError,
    submitLocked,
    beginSubmit,
    endSubmit,
  };
}
