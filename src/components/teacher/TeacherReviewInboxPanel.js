import React, { useMemo } from 'react';
import HudFrame from '../HudFrame';
import { restoreNames } from '../../utils/anonymizeText';
import {
  SUBMISSION_STATUS_PEER_REVIEW,
  AI_MODE_LABELS,
  getPeerApprovalProgress,
} from '../../constants/aiSubmissionPolicy';
import { getUnitLabel, resolveUnitKeyFromSource } from '../../constants/unitProgress';
import {
  resolveReviewStudentLabel,
  resolveVariantStrategyLabel,
  renderReviewMathLines,
  reviewSubmissionMillis,
} from '../../utils/teacherDashboardUtils';
import TeacherAiFeedbackBox from './TeacherAiFeedbackBox';
import {
  NEW_PROBLEM_TEACHER_MANUAL_CHECK_KEYS,
  VARIANT_TEACHER_MANUAL_CHECK_KEYS,
  isAiReviewPending,
  isNewProblemItem,
} from '../../utils/teacherAiFeedback';
import { WRONG_NOTE_CHECK_KEYS } from '../../constants/wrongNoteCompetency';

function InboxFilters({ filter, counts, onChange }) {
  const tabs = [
    { id: 'all', label: `전체 (${counts.all})` },
    { id: 'variant', label: `변형 문제 (${counts.variant})` },
    { id: 'newProblem', label: `새 문제 (${counts.newProblem})` },
    { id: 'wrongNote', label: `오답노트 (${counts.wrongNote})` },
  ];
  return (
    <div className="td-inbox-filters" role="tablist" aria-label="검수함 필터">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={filter === tab.id}
          className={`td-inbox-filters__btn${filter === tab.id ? ' td-inbox-filters__btn--active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function VariantReviewCard({
  item,
  studentLabel,
  isBusy,
  feedbackDraft,
  onToggleCheck,
  onNoteChange,
  onSendFeedback,
  showDevPurge,
  onDevPurge,
  isPurging,
}) {
  const restoredQ = restoreNames(item.question || '', item.nameMap || {});
  const restoredBogi = item.bogi ? restoreNames(item.bogi, item.nameMap || {}) : null;
  const restoredSol = item.solutionProcess
    ? restoreNames(item.solutionProcess, item.nameMap || {})
    : null;
  const isPeer = item.status === SUBMISSION_STATUS_PEER_REVIEW;
  const isAiPending = isAiReviewPending(item.aiReviewStatus, item);
  const isAiRejected = !isPeer && !isAiPending && item.aiApproved === false;
  const isNewProblem = isNewProblemItem(item);
  const unitKey = resolveUnitKeyFromSource(item);
  const unitLabel = unitKey ? getUnitLabel(unitKey) : '';
  const peerProgress = isPeer ? getPeerApprovalProgress(item) : null;
  const cardBorder = isPeer ? '#fca5a5' : isAiRejected ? '#fcd34d' : '#c7d2fe';
  const cardBg = isPeer ? '#fff7f7' : isAiRejected ? '#fffbeb' : '#f8f7ff';

  return (
    <div style={{ border: `1px solid ${cardBorder}`, borderRadius: 12, padding: 16, background: cardBg }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{
          display: 'inline-block', fontWeight: 800, fontSize: 16,
          color: '#1e3a8a', background: '#e0e7ff',
          padding: '5px 12px', borderRadius: 8, marginBottom: 8,
        }}>
          제출 학생: {studentLabel}
        </div>
        {!isNewProblem && (
          <div style={{
            fontSize: 14, fontWeight: 700, color: '#312e81',
            background: '#eef2ff', border: '1px solid #c7d2fe',
            borderRadius: 8, padding: '6px 12px', marginBottom: 8,
          }}>
            문제 만들기 전략: {resolveVariantStrategyLabel(item)}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, background: '#e0e7ff', color: '#3730a3', padding: '2px 8px', borderRadius: 99 }}>
            {isNewProblem ? '새 문제' : '변형 문제'}
          </span>
          {unitLabel && (
            <span style={{ fontSize: 12, background: '#ecfccb', color: '#365314', padding: '2px 8px', borderRadius: 99, fontWeight: 700 }}>
              {unitLabel}
            </span>
          )}
          <span style={{ fontWeight: 600, fontSize: 14, color: '#475569' }}>
            {item.examTitle || (isNewProblem ? '(직접 만든 문제)' : '(시험지)')}
            {!isNewProblem && item.questionNumber != null ? ` — ${item.questionNumber}번` : ''}
          </span>
          {item.classProblemLabel && (
            <span style={{ fontSize: 12, background: '#f3e8ff', color: '#6b21a8', padding: '2px 8px', borderRadius: 99 }}>
              {item.classProblemLabel}
            </span>
          )}
          {isPeer ? (
            <span style={{ fontSize: 12, padding: '2px 10px', borderRadius: 99, background: '#fef9c3', color: '#854d0e', fontWeight: 600 }}>
              👥 동료 검토 {peerProgress?.count ?? 0}/{peerProgress?.required ?? 2}
            </span>
          ) : isAiPending ? (
            <span style={{ fontSize: 12, background: '#fef9c3', color: '#854d0e', padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>
              AI 검수 중
            </span>
          ) : isAiRejected ? (
            <span style={{ fontSize: 12, background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>
              AI 미승인 · 교사 확인
            </span>
          ) : (
            <span style={{ fontSize: 12, background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: 99 }}>
              AI 승인 후 대기
            </span>
          )}
          {item.aiMode && (
            <span style={{ fontSize: 11, color: '#6b7280' }}>
              ({AI_MODE_LABELS[item.aiMode] || item.aiMode})
            </span>
          )}
        </div>
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 8 }}>
        <strong>문제:</strong>{' '}
        <span className="prob-question">{renderReviewMathLines(restoredQ)}</span>
      </div>
      {restoredBogi && (
        <div style={{ fontSize: 13, color: '#374151', background: '#f3f4f6', borderRadius: 6, padding: '6px 10px', marginBottom: 6 }}>
          <strong>[보기]</strong>{' '}
          <span className="prob-question">{renderReviewMathLines(restoredBogi)}</span>
        </div>
      )}
      {item.choices?.length > 0 && (
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          {item.choices.map((c, i) => (
            <div key={i}>
              {'①②③④⑤'[i]}{' '}
              <span className="prob-choice-text">{renderReviewMathLines(c)}</span>
            </div>
          ))}
        </div>
      )}
      {restoredSol && (
        <div style={{ fontSize: 13, color: '#374151', marginBottom: 6 }}>
          <strong>풀이:</strong>{' '}
          <span className="prob-choice-text">{renderReviewMathLines(restoredSol)}</span>
        </div>
      )}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
        정답:{' '}
        <span className="prob-choice-text">{renderReviewMathLines(item.answer)}</span>
      </div>
      <TeacherAiFeedbackBox
        item={item}
        interactive
        manualCheckKeys={isNewProblem ? NEW_PROBLEM_TEACHER_MANUAL_CHECK_KEYS : VARIANT_TEACHER_MANUAL_CHECK_KEYS}
        checks={feedbackDraft?.checks}
        onToggleCheck={onToggleCheck}
        note={feedbackDraft?.note}
        onNoteChange={onNoteChange}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={isBusy || isPurging} onClick={onSendFeedback}>
          {isBusy ? <><span className="spinner" /> 처리 중...</> : '📨 피드백 보내기'}
        </button>
        {showDevPurge && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ color: '#7c2d12', marginLeft: 'auto' }}
            disabled={isBusy || isPurging}
            onClick={onDevPurge}
            title="개발용: 검수 문서·학생 저장소·학급 문제은행 등 관련 데이터를 모두 삭제합니다."
          >
            {isPurging ? <><span className="spinner" /> 삭제 중...</> : '🗑️ 완전 삭제 (개발)'}
          </button>
        )}
      </div>
    </div>
  );
}

function VariantDiagnosticsPanel({ variantDiag }) {
  if (!variantDiag) return null;
  const s = variantDiag.summary || {};
  const queryCount = s.queryResults
    ? Object.values(s.queryResults).reduce((n, r) => n + (r?.count || 0), 0)
    : null;
  return (
    <div style={{
      background: '#f1f5f9',
      border: '1px solid #cbd5e1',
      borderRadius: 10,
      padding: '10px 14px',
      fontSize: 12,
      color: '#0f172a',
      marginBottom: 12,
    }}>
      {variantDiag.phase === 'running' ? (
        <div>진단 중… (학생 problemBank에서 reviewId 수집 → variantReviews 존재/권한 확인)</div>
      ) : variantDiag.phase === 'error' ? (
        <div style={{ color: '#b91c1c' }}>진단 오류: {variantDiag.message}</div>
      ) : (
        <>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>진단 결과</div>
          {s.classProblemBankCount != null && queryCount != null && s.classProblemBankCount > queryCount && (
            <div style={{
              marginBottom: 8, padding: '8px 10px', borderRadius: 8,
              background: '#fff7ed', border: '1px solid #fdba74', color: '#9a3412', lineHeight: 1.5,
            }}>
              학급 problemBank <strong>{s.classProblemBankCount}건</strong>인데 검수함 쿼리는{' '}
              <strong>{queryCount}건</strong>입니다.
              학급 등록만 되고 <code>variantReviews</code> 검수 문서가 없는 경우가 많습니다.
              아래 <strong>「검수 문서 백필」</strong>을 눌러 주세요.
            </div>
          )}
          <div style={{ fontFamily: 'monospace', lineHeight: 1.6 }}>
            <div>serverStudentsCount: {s.serverStudentsCount}</div>
            <div>classProblemBankCount: {s.classProblemBankCount ?? '(미집계)'}</div>
            <div>studentCounts(by classCode, limit 5): {JSON.stringify(s.studentCounts)}</div>
            <div>problemBankDocCount(sampled): {s.problemBankDocCount}</div>
            <div>foundInProblemBank: {s.foundInProblemBank}</div>
            <div>uniqueReviewIds: {s.uniqueReviewIds}</div>
            <div>variantReviews.exists (읽기 성공): {s.existsCount}</div>
            <div>variantReviews.missing (NOT_FOUND): {s.missingCount}</div>
            <div>variantReviews.likelyMissing (permission-denied): {s.likelyMissingReviews ?? s.deniedCount}</div>
            <div>otherErrors: {s.errorCount}</div>
            {variantDiag.summary.queryResults && (
              <div style={{ marginTop: 6, padding: '6px 8px', background: '#f0f9ff', borderRadius: 6 }}>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>실제 쿼리 결과 (classCode별)</div>
                {Object.entries(variantDiag.summary.queryResults).map(([cc, r]) => (
                  <div key={cc}>
                    [{cc}] → {r.error ? `오류: ${r.error}` : `${r.count}건`}
                  </div>
                ))}
              </div>
            )}
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
            Firestore는 문서가 없으면 <code>permission-denied</code>로 보일 수 있습니다.
            likelyMissing 수치가 크면 검수 문서가 아직 생성되지 않은 것입니다.
          </p>
          {Array.isArray(variantDiag.sampleChecks) && variantDiag.sampleChecks.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>샘플 (최대 8개)</div>
              <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
                {variantDiag.sampleChecks.map((c) => (
                  <div key={c.reviewId}>
                    - {c.reviewId}:{' '}
                    {c.ok
                      ? (c.exists
                        ? `OK (classCode=${c.vrClassCode || '?'}, status=${c.vrStatus || '?'})`
                        : 'NOT_FOUND')
                      : (c.code === 'permission-denied'
                        ? 'NO_DOC (permission-denied — 검수 문서 없음)'
                        : `ERR (${c.code || ''})`)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function WrongNoteReviewCard({
  item,
  studentLabel,
  isBusy,
  feedbackDraft,
  onToggleCheck,
  onNoteChange,
  onSendFeedback,
  showDevPurge,
  onDevPurge,
  isPurging,
}) {
  const isAiFallback = item.aiMode === 'peer_review';
  return (
    <div style={{ border: '1px solid #bfdbfe', borderRadius: 12, padding: 16, background: '#f8fafc' }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{
          display: 'inline-block', fontWeight: 800, fontSize: 16,
          color: '#1e3a8a', background: '#e0e7ff',
          padding: '5px 12px', borderRadius: 8, marginBottom: 8,
        }}>
          제출 학생: {studentLabel}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, background: '#dbeafe', color: '#1d4ed8', padding: '2px 8px', borderRadius: 99 }}>
            오답노트
          </span>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#475569' }}>
            {item.examName || '(시험)'} — {item.questionNumber}번
          </span>
          <span style={{ fontSize: 12, background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: 99 }}>
            {isAiFallback ? 'AI 불가 · 교사 검수' : 'AI 승인 후 대기'}
          </span>
        </div>
      </div>
      {item.questionText && (
        <div style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 8 }}>
          <strong>문제:</strong>{' '}
          <span className="prob-question">{renderReviewMathLines(item.questionText)}</span>
        </div>
      )}
      {item.bogi && (
        <div style={{ fontSize: 13, color: '#374151', background: '#f3f4f6', borderRadius: 6, padding: '6px 10px', marginBottom: 6 }}>
          <strong>[보기]</strong>{' '}
          <span className="prob-question">{renderReviewMathLines(item.bogi)}</span>
        </div>
      )}
      {item.choices?.length > 0 && (
        <div style={{ fontSize: 13, marginBottom: 6 }}>
          {item.choices.map((c, i) => (
            <div key={i}>
              {'①②③④⑤'[i]}{' '}
              <span className="prob-choice-text">{renderReviewMathLines(c)}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 6 }}>
        <strong>틀린 이유:</strong> {item.wrongReason}
      </div>
      {item.preventionPlan && (
        <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 6 }}>
          <strong>다시 틀리지 않으려면:</strong> {item.preventionPlan}
        </div>
      )}
      {item.solutionProcess && (
        <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 6 }}>
          <strong>옳은 풀이:</strong>{' '}
          <span className="prob-choice-text">{renderReviewMathLines(item.solutionProcess)}</span>
        </div>
      )}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
        학생 정답:{' '}
        <span className="prob-choice-text">{renderReviewMathLines(item.answer)}</span>
        {item.teacherAnswer && (
          <span style={{ marginLeft: 8, color: '#6b7280', fontWeight: 500 }}>
            (교사 정답: {renderReviewMathLines(item.teacherAnswer)})
          </span>
        )}
      </div>
      <TeacherAiFeedbackBox
        item={item}
        interactive
        manualCheckKeys={WRONG_NOTE_CHECK_KEYS}
        checks={feedbackDraft?.checks}
        onToggleCheck={onToggleCheck}
        note={feedbackDraft?.note}
        onNoteChange={onNoteChange}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={isBusy || isPurging} onClick={onSendFeedback}>
          {isBusy ? <><span className="spinner" /> 처리 중...</> : '📨 피드백 보내기'}
        </button>
        {showDevPurge && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ color: '#7c2d12', marginLeft: 'auto' }}
            disabled={isBusy || isPurging}
            onClick={onDevPurge}
            title="개발용: 검수 문서·학생 오답노트 초안을 모두 삭제합니다."
          >
            {isPurging ? <><span className="spinner" /> 삭제 중...</> : '🗑️ 완전 삭제 (개발)'}
          </button>
        )}
      </div>
    </div>
  );
}

export default function TeacherReviewInboxPanel({
  filter,
  onFilterChange,
  variantReviews,
  variantReviewsSorted,
  wrongNoteReviews,
  wrongNoteReviewsSorted,
  variantReviewsLoading,
  wrongNoteReviewsLoading,
  mergedStudents,
  localMappings,
  allLocalMappings,
  resolvingVariantId,
  resolvingWrongNoteId,
  getReviewFeedbackDraft,
  onReviewFeedbackToggleCheck,
  onReviewFeedbackNoteChange,
  onSendVariantFeedback,
  onSendWrongNoteFeedback,
  onRefreshVariants,
  onRefreshWrongNotes,
  variantDiag,
  onRunVariantDiagnostics,
  onBackfillVariantReviews,
  variantBackfillLoading,
  onRerunClassProblemAiReviews,
  classAiRerunLoading,
  migrationState,
  onMigrateVariantClassCode,
  legacyPendingMigrationState,
  onMigrateLegacyPendingStatuses,
  serverStudents,
  classCode,
  showDevPurge,
  purgingVariantId,
  purgingWrongNoteId,
  onPurgeVariant,
  onPurgeWrongNote,
}) {
  const { variantOnlyReviews, newProblemReviews } = useMemo(() => {
    const variantOnly = [];
    const newProblem = [];
    for (const item of variantReviewsSorted) {
      if (isNewProblemItem(item)) newProblem.push(item);
      else variantOnly.push(item);
    }
    return { variantOnlyReviews: variantOnly, newProblemReviews: newProblem };
  }, [variantReviewsSorted]);

  const counts = useMemo(() => ({
    variant: variantOnlyReviews.length,
    newProblem: newProblemReviews.length,
    wrongNote: wrongNoteReviews.length,
    all: variantOnlyReviews.length + newProblemReviews.length + wrongNoteReviews.length,
  }), [variantOnlyReviews, newProblemReviews, wrongNoteReviews]);

  const loading = (
    (variantReviewsLoading && variantReviews.length === 0)
    || (wrongNoteReviewsLoading && wrongNoteReviews.length === 0)
  );
  const showVariantTools = filter === 'all' || filter === 'variant' || filter === 'newProblem';
  const isEmpty = counts.all === 0;
  const mergedInboxItems = useMemo(() => {
    if (filter !== 'all') return null;
    const items = [
      ...variantReviewsSorted.map((item) => ({ kind: 'variant', item })),
      ...wrongNoteReviewsSorted.map((item) => ({ kind: 'wrongNote', item })),
    ];
    return items.sort((a, b) => reviewSubmissionMillis(a.item) - reviewSubmissionMillis(b.item));
  }, [filter, variantReviewsSorted, wrongNoteReviewsSorted]);

  const labelOpts = { serverStudents, classCode };
  const nameMappings = (allLocalMappings?.length ? allLocalMappings : localMappings);

  const feedbackPropsFor = (item, kind) => ({
    feedbackDraft: getReviewFeedbackDraft?.(item),
    onToggleCheck: (checkKey) => onReviewFeedbackToggleCheck(item, checkKey),
    onNoteChange: (note) => onReviewFeedbackNoteChange(item.id, note),
    onSendFeedback: () => (
      kind === 'variant' ? onSendVariantFeedback(item) : onSendWrongNoteFeedback(item)
    ),
  });

  return (
    <HudFrame>
      <div className="section-header">
        <h2 className="section-title">📥 검수함</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {showVariantTools && (
            <>
              <button type="button" className="btn btn-outline btn-sm" onClick={onRunVariantDiagnostics} disabled={variantReviewsLoading || !serverStudents.length}>
                🩺 진단
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={onMigrateLegacyPendingStatuses}
                disabled={legacyPendingMigrationState === 'running' || variantReviewsLoading || !serverStudents.length}
                title="옛 배포본에서 status=pending 으로 남은 검수 문서를 pending_review 로 정리합니다. (검수함 누락 방지)"
              >
                {legacyPendingMigrationState === 'running' ? '⏳ pending 정리…' : '🧹 pending 정리'}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={onRerunClassProblemAiReviews}
                disabled={classAiRerunLoading || variantBackfillLoading || variantReviewsLoading || !serverStudents.length}
                title="검수함·학급 문제은행의 AI 미검수/오류 항목(새 문제 포함)을 다시 검수합니다. 백엔드(8002)가 켜져 있어야 합니다."
              >
                {classAiRerunLoading ? <><span className="spinner" /> AI 재검수 중...</> : '검수함 AI 재검수(미완료·새 문제)'}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onBackfillVariantReviews}
                disabled={variantBackfillLoading || classAiRerunLoading || variantReviewsLoading || !serverStudents.length}
                title="학급 problemBank에는 있는데 variantReviews 검수 문서가 없는 항목을 생성합니다. 생성 후 AI 미검수 건은 자동 재검수합니다."
              >
                {variantBackfillLoading ? <><span className="spinner" /> 백필 중...</> : '📥 검수 문서 백필'}
              </button>
              <button type="button" className="btn btn-outline btn-sm" onClick={onMigrateVariantClassCode} disabled={migrationState === 'running' || !serverStudents.length}>
                {migrationState === 'running' ? '⏳ 마이그레이션…' : '🔧 classCode 수정'}
              </button>
            </>
          )}
          <button type="button" className="btn btn-outline btn-sm" onClick={() => { onRefreshVariants(); onRefreshWrongNotes(); }} disabled={loading}>
            🔄 새로고침
          </button>
        </div>
        {migrationState && migrationState !== 'running' && (
          <div style={{ fontSize: 12, color: migrationState.errors > 0 ? '#b91c1c' : '#166534', marginTop: 4, textAlign: 'right' }}>
            마이그레이션 결과: {migrationState.updated}건 업데이트, {migrationState.errors}건 오류
          </div>
        )}
      </div>

      <InboxFilters filter={filter} counts={counts} onChange={onFilterChange} />

      {showVariantTools && (
        <VariantDiagnosticsPanel variantDiag={variantDiag} />
      )}

      {loading ? (
        <div className="loading-box"><div className="spinner-large" /><p>검수 목록 로드 중...</p></div>
      ) : isEmpty ? (
        <div className="empty-box">
          <span className="empty-icon">✅</span>
          <p>검수 대기 항목이 없습니다.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {filter === 'all' && mergedInboxItems?.map((entry) => (
            entry.kind === 'variant' ? (
              <VariantReviewCard
                key={`v_${entry.item.id}`}
                item={entry.item}
                studentLabel={resolveReviewStudentLabel(entry.item, mergedStudents, nameMappings, labelOpts)}
                isBusy={resolvingVariantId === entry.item.id}
                {...feedbackPropsFor(entry.item, 'variant')}
                showDevPurge={showDevPurge}
                isPurging={purgingVariantId === entry.item.id}
                onDevPurge={() => onPurgeVariant(entry.item)}
              />
            ) : (
              <WrongNoteReviewCard
                key={`w_${entry.item.id}`}
                item={entry.item}
                studentLabel={resolveReviewStudentLabel(entry.item, mergedStudents, nameMappings, labelOpts)}
                isBusy={resolvingWrongNoteId === entry.item.id}
                {...feedbackPropsFor(entry.item, 'wrongNote')}
                showDevPurge={showDevPurge}
                isPurging={purgingWrongNoteId === entry.item.id}
                onDevPurge={() => onPurgeWrongNote(entry.item)}
              />
            )
          ))}
          {filter === 'variant' && variantOnlyReviews.map((item) => (
            <VariantReviewCard
              key={`v_${item.id}`}
              item={item}
              studentLabel={resolveReviewStudentLabel(item, mergedStudents, nameMappings, labelOpts)}
              isBusy={resolvingVariantId === item.id}
              {...feedbackPropsFor(item, 'variant')}
              showDevPurge={showDevPurge}
              isPurging={purgingVariantId === item.id}
              onDevPurge={() => onPurgeVariant(item)}
            />
          ))}
          {filter === 'newProblem' && newProblemReviews.map((item) => (
            <VariantReviewCard
              key={`v_${item.id}`}
              item={item}
              studentLabel={resolveReviewStudentLabel(item, mergedStudents, nameMappings, labelOpts)}
              isBusy={resolvingVariantId === item.id}
              {...feedbackPropsFor(item, 'variant')}
              showDevPurge={showDevPurge}
              isPurging={purgingVariantId === item.id}
              onDevPurge={() => onPurgeVariant(item)}
            />
          ))}
          {filter === 'wrongNote' && wrongNoteReviewsSorted.map((item) => (
            <WrongNoteReviewCard
              key={`w_${item.id}`}
              item={item}
              studentLabel={resolveReviewStudentLabel(item, mergedStudents, nameMappings, labelOpts)}
              isBusy={resolvingWrongNoteId === item.id}
              {...feedbackPropsFor(item, 'wrongNote')}
              showDevPurge={showDevPurge}
              isPurging={purgingWrongNoteId === item.id}
              onDevPurge={() => onPurgeWrongNote(item)}
            />
          ))}
          {filter === 'variant' && variantOnlyReviews.length === 0 && (
            <p style={{ color: '#6b7280', textAlign: 'center' }}>변형 문제 검수 대기가 없습니다.</p>
          )}
          {filter === 'newProblem' && newProblemReviews.length === 0 && (
            <p style={{ color: '#6b7280', textAlign: 'center' }}>새 문제 검수 대기가 없습니다.</p>
          )}
          {filter === 'wrongNote' && wrongNoteReviews.length === 0 && (
            <p style={{ color: '#6b7280', textAlign: 'center' }}>오답노트 검수 대기가 없습니다.</p>
          )}
        </div>
      )}
    </HudFrame>
  );
}
