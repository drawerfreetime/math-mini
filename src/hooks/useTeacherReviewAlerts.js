import { useEffect, useRef } from 'react';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { getFirebaseDb } from '../firebase/config';
import {
  SUBMISSION_STATUS_PENDING_REVIEW,
  VARIANT_REVIEW_OPEN_STATUSES,
  isOpenVariantReviewForTeacherInbox,
} from '../constants/aiSubmissionPolicy';
import { playTeacherNotificationSound } from '../utils/teacherNotificationSound';
import { normalizeClassCode } from '../utils/classCode';

/** @typedef {{ kind: 'variant'|'wrongNote', id: string, label: string }} TeacherReviewAlert */

/**
 * 교사 학급: 변형 문제·오답노트 검수 대기를 실시간 감지하고 알림음 재생
 *
 * @param {object} opts
 * @param {string|null} opts.classCode
 * @param {(alert: TeacherReviewAlert) => void} [opts.onAlert]
 * @param {(item: object) => void} [opts.onAiReviewDone] — variantReviews AI 검수 완료 시
 * @param {boolean} [opts.enabled]
 */
export function useTeacherReviewAlerts({
  classCode,
  onAlert,
  onAiReviewDone,
  enabled = true,
}) {
  const seenRef = useRef(new Set());
  const aiStatusRef = useRef(new Map());
  const primedRef = useRef(false);
  const onAlertRef = useRef(onAlert);
  const onAiReviewDoneRef = useRef(onAiReviewDone);
  onAlertRef.current = onAlert;
  onAiReviewDoneRef.current = onAiReviewDone;

  const emitIfNew = (alert) => {
    if (seenRef.current.has(alert.id)) return;
    seenRef.current.add(alert.id);
    if (!primedRef.current) return;
    playTeacherNotificationSound();
    onAlertRef.current?.(alert);
  };

  useEffect(() => {
    seenRef.current = new Set();
    aiStatusRef.current = new Map();
    primedRef.current = false;
    const t = window.setTimeout(() => {
      primedRef.current = true;
    }, 1800);
    return () => window.clearTimeout(t);
  }, [classCode]);

  useEffect(() => {
    if (!enabled || !classCode) return undefined;

    const db = getFirebaseDb();
    if (!db) return undefined;

    const norm = normalizeClassCode(classCode);
    const lower = norm.toLowerCase();
    const codes = norm === lower ? [norm] : [norm, lower];

    const unsubs = codes.map((cc) => {
      const q = query(
        collection(db, 'variantReviews'),
        where('classCode', '==', cc),
        where('status', 'in', VARIANT_REVIEW_OPEN_STATUSES),
      );
      return onSnapshot(
        q,
        (snap) => {
          snap.docs.forEach((d) => {
            const data = d.data();
            const item = { id: d.id, ...data };
            if (!isOpenVariantReviewForTeacherInbox(item)) return;

            const prevAi = aiStatusRef.current.get(d.id);
            const curAi = data.aiReviewStatus || 'pending';
            aiStatusRef.current.set(d.id, curAi);
            if (
              primedRef.current
              && prevAi
              && prevAi !== 'done'
              && curAi === 'done'
            ) {
              onAiReviewDoneRef.current?.(item);
            }

            const qNum = data.questionNumber ?? '?';
            const aiPending = curAi !== 'done';
            emitIfNew({
              kind: 'variant',
              id: `vr_${d.id}`,
              label: aiPending
                ? `변형 문제 ${qNum}번 — AI 검수 중`
                : `변형 문제 ${qNum}번 — 교사 검수 대기${data.aiApproved === false ? ' (AI 미승인)' : ''}`,
            });
          });
        },
        (err) => console.warn('[teacherReviewAlerts] variantReviews', err),
      );
    });

    return () => unsubs.forEach((u) => u());
  }, [classCode, enabled]);

  useEffect(() => {
    if (!enabled || !classCode) return undefined;

    const db = getFirebaseDb();
    if (!db) return undefined;

    const q = query(
      collection(db, 'wrongNoteReviews'),
      where('classCode', '==', classCode),
      where('status', '==', SUBMISSION_STATUS_PENDING_REVIEW),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        snap.docs.forEach((d) => {
          const data = d.data();
          if (data.status !== SUBMISSION_STATUS_PENDING_REVIEW) return;
          const qNum = data.questionNumber ?? '?';
          emitIfNew({
            kind: 'wrongNote',
            id: `wn_${d.id}`,
            label: `오답노트 ${qNum}번 — 교사 검수 대기`,
          });
        });
      },
      (err) => console.warn('[teacherReviewAlerts] wrongNoteReviews', err),
    );

    return () => unsub();
  }, [classCode, enabled]);
}
