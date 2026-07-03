/**
 * TeacherDashboard.js — 교사 전용 대시보드
 *
 * 주요 기능:
 * 1. 학생 일괄 등록 (명단 붙여넣기 → 번호 자동 부여 → 수정 가능)
 * 2. 학생 로그인 비밀번호(4자리) 초기화
 * 3. 매핑 테이블 내보내기/가져오기 (AES-256-GCM)
 * 4. 학급 초기화 (영구 삭제)
 *
 * ★ 개인정보 보호 ★
 * 화면에는 실명 표시, Firebase에는 UUID + 해시값만 저장
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import app from '../firebase/config';
import { collection, getDocs, getDoc, doc as fsDoc, query, where, limit, orderBy, updateDoc, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase/config';
import { buildVariantReviewId } from '../utils/variantBankIds';
import {
  generateUUID, hashStudentName, hashPIN,
  aesEncrypt, aesDecrypt,
} from '../utils/crypto';
import {
  getAllMappings, deleteMappingByUUID,
  deleteMappingsByClass, updateMappingPIN,
  saveClassInfo, getClassInfo, deleteClassInfo,
  exportAllData, importAllData,
  migrateLocalClassCode,
} from '../utils/teacherDB';
import {
  mergeStudentsForTeacherView,
  sortRowsByStudentAttendance,
} from '../utils/mergeTeacherStudents';
import { sortRowsBySubmissionTime, extractReviewStudentUuid } from '../utils/teacherDashboardUtils';
import {
  saveStudentMappingWithCloud,
  syncClassRosterWithCloud,
  pushClassRosterToCloud,
} from '../utils/teacherRosterCloudSync';
import {
  createClass, createStudent, getStudentsByClass,
  resetStudentPIN, deleteStudent, purgeClassData,
  getClassesByTeacher,
  syncTeacherEmailOnTeacherClasses,
  canTeacherAccessClass,
  backfillStudentNumbersFromMappings,
  backfillStudentDisplayNamesFromMappings,
  updateStudentDisplayName,
  getVariantReviewsByClass,
  loadVariantReviewsForClassProblemBank,
  backfillMissingVariantReviewsForClass,
  migrateLegacyPendingVariantReviews,
  resolveVariantReview,
  getWrongNoteReviewsByClass,
  resolveWrongNoteReview,
  migrateClassCode,
  purgeVariantReviewSubmission,
  purgeWrongNoteReviewSubmission,
} from '../firebase/firestoreOps';
import {
  SUBMISSION_STATUS_PENDING_REVIEW,
  SUBMISSION_STATUS_REGISTERED,
  SUBMISSION_STATUS_APPROVED,
  SUBMISSION_STATUS_APPROVED_PARTIAL,
  SUBMISSION_STATUS_REJECTED,
  VARIANT_REVIEW_OPEN_STATUSES,
  isOpenVariantReviewForTeacherInbox,
} from '../constants/aiSubmissionPolicy';
import {
  ensureTeacherManualChecks,
  resolveTeacherManualCheckKeys,
  deriveAiApprovedFromChecks,
  deriveReviewStatusFromChecks,
  deriveVariantReviewStatusFromChecks,
  buildTeacherReviewFeedbackDraft,
  finalizeTeacherFeedbackDraft,
  syncTeacherFeedbackNote,
  teacherChecksMatchBaseline,
  cloneAiChecks,
} from '../utils/teacherAiFeedback';
import { normalizeClassCode } from '../utils/classCode';
import { getClassMakingCompetency, getClassMakingSubmitStats } from '../firebase/makingEventsOps';
import { getClassWrongNoteCompetency } from '../firebase/wrongNoteCompetencyOps';
import {
  backfillExplorationPointsForClass,
  isExplorationBackfillDone,
  markExplorationBackfillDone,
  reconcilePeerEvalExplorationRewardsForClass,
} from '../firebase/explorationBackfillOps';
import {
  getClassSolveStatsByStudent,
  rerunClassProblemAiReviews,
  rerunVariantReviewsAiReviews,
  getClassProblems,
  getClassProblemEvaluations,
  reconcileClassProblemLabels,
  backfillClassProblemCurriculumLabels,
  backfillClassProblemCreatorSolutions,
  syncClassProblemBankAiFromVariantReviews,
  syncClassProblemBankAiToVariantReviews,
  syncClassProblemBankLabelsToVariantReviews,
  syncClassProblemBankTeacherReviewFromVariantReviews,
  syncStudentProblemsToClassBank,
} from '../firebase/classProblemBankOps';
import { useTeacherReviewAlerts } from '../hooks/useTeacherReviewAlerts';
import {
  unlockTeacherNotificationAudio,
  isTeacherNotificationAudioUnlocked,
} from '../utils/teacherNotificationSound';
import '../components/ProblemMakingCompetencyCard.css';
import { isDevMakingSubmitPanelEnabled } from '../utils/devMakingSubmitPanel';
import { isDevReviewInboxPurgeEnabled } from '../utils/devReviewInboxPurge';
import BrandHomeButton from './BrandHomeButton';
import TeacherHomePanel from './teacher/TeacherHomePanel';
import TeacherReviewInboxPanel from './teacher/TeacherReviewInboxPanel';
import TeacherStudentsPanel from './teacher/TeacherStudentsPanel';
import TeacherClassPanel from './teacher/TeacherClassPanel';
import TeacherClassProblemBankPanel from './teacher/TeacherClassProblemBankPanel';
import TeacherExamResultModal from './teacher/TeacherExamResultModal';
import './teacher/TeacherDashboard.css';
import { buildVariantReviewLookupMaps, enrichVariantReviewsWithClassProblemAi } from '../utils/teacherAiFeedback';
import { formatExplorationPoints } from '../constants/explorationRewards';

function canonicalClassDocCode(cls) {
  if (!cls || typeof cls !== 'object') return '';
  return normalizeClassCode(cls.classCode ?? cls.id);
}

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────
function generateClassCode() {
  // 'U'는 학급코드에 사용하지 않음
  // 또한 혼동을 줄이기 위해 'S', '2'도 사용하지 않음
  const chars = 'ABCDEFGHJKLMNPQRTVWXYZ3456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => chars[b % chars.length]).join('');
}

function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }, []);
  return [toast, show];
}

/** 이름 목록 텍스트 파싱 — 줄바꿈·탭·쉼표·공백줄 처리 */
function parseNameList(text) {
  return text
    .split(/[\n,\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────
// 학급 생성/선택 화면
// ─────────────────────────────────────────────
function ClassSetup({ teacherUID, teacherEmail, onClassReady }) {
  const [classes,  setClasses]  = useState([]);
  const [newName,  setNewName]  = useState('');
  const [creating, setCreating] = useState(false);
  const [error,    setError]    = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joining,  setJoining]  = useState(false);
  const [joinError, setJoinError] = useState('');

  useEffect(() => {
    if (!teacherUID) return;
    (async () => {
      try {
        if (teacherEmail) await syncTeacherEmailOnTeacherClasses(teacherUID, teacherEmail);
        const list = await getClassesByTeacher(teacherUID, teacherEmail);
        setClasses(list);
      } catch {
        setClasses([]);
      }
    })();
  }, [teacherUID, teacherEmail]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true); setError('');
    try {
      const code = generateClassCode();
      await createClass(code, teacherUID, newName.trim(), teacherEmail);
      await saveClassInfo({ classCode: code, className: newName.trim(), teacherUID });
      onClassReady(code);
    } catch (err) {
      setError('학급 생성 오류: ' + err.message);
    }
    setCreating(false);
  }

  async function handleJoinByCode(e) {
    e.preventDefault();
    if (joining) return;
    setJoinError('');
    const code = normalizeClassCode(joinCode);
    if (!code) { setJoinError('학급 코드를 입력해 주세요.'); return; }
    setJoining(true);
    try {
      const allowed = await canTeacherAccessClass(code, teacherUID, teacherEmail);
      if (!allowed) {
        setJoinError('접근할 수 없는 학급 코드입니다. (교사 계정/프로젝트 확인)');
        return;
      }
      onClassReady(code);
    } catch (err) {
      setJoinError('학급 코드 확인 중 오류: ' + (err?.message || 'unknown'));
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="result-container">
      <div className="result-card" style={{ maxWidth: 480 }}>
        <div className="result-emoji">🏫</div>
        <h2 className="result-title">학급 설정</h2>

        {classes.length > 0 && (
          <div style={{ width: '100%', marginBottom: 20 }}>
            <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 12 }}>기존 학급 선택</p>
            {classes.map((c) => (
              <button key={c.id} className="btn btn-outline"
                style={{ width: '100%', marginBottom: 8, display: 'flex',
                  justifyContent: 'space-between', alignItems: 'center' }}
                onClick={() => onClassReady(canonicalClassDocCode(c))}>
                <span>{c.className}</span>
                <span style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>
                  {canonicalClassDocCode(c)}
                </span>
              </button>
            ))}
            <div style={{ border: '1px solid #e5e7eb', margin: '16px 0' }} />
          </div>
        )}

        <form onSubmit={handleJoinByCode} style={{ width: '100%', marginBottom: 14 }}>
          <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 10px' }}>
            학급 코드가 목록에 안 보이면, <strong>학급 코드로 바로 들어가기</strong>
          </p>
          {joinError && <div className="alert alert-error" style={{ marginBottom: 10 }}>{joinError}</div>}
          <div className="form-row" style={{ gap: 10, alignItems: 'flex-end' }}>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label className="form-label">학급 코드</label>
              <input
                type="text"
                className="form-input"
                placeholder="예: SVT2S9"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                style={{ fontFamily: 'monospace', letterSpacing: 1 }}
              />
            </div>
            <button type="submit" className="btn btn-outline" disabled={joining}>
              {joining ? <><span className="spinner" /> 확인 중...</> : '들어가기'}
            </button>
          </div>
        </form>

        <form onSubmit={handleCreate} style={{ width: '100%' }}>
          {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
          <div className="form-group">
            <label className="form-label">새 학급 만들기</label>
            <input type="text" className="form-input" placeholder="예: 4학년 3반"
              value={newName} onChange={(e) => setNewName(e.target.value)} required />
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={creating}>
            {creating ? <><span className="spinner" /> 생성 중...</> : '+ 학급 생성'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
/** 등록된 출석번호 최댓값+1 — 중간 번호 삭제 후에도 기존 번호와 겹치지 않게 */
function computeNextStudentNumber(students) {
  let max = 0;
  for (const s of students || []) {
    const n = typeof s.studentNumber === 'number'
      ? s.studentNumber
      : parseInt(String(s.studentNumber ?? ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

// 학생 일괄 추가 모달
// ─────────────────────────────────────────────
function BulkAddModal({ classCode, teacherUid, startStudentNumber, onDone, onClose }) {
  const [step, setStep] = useState(1); // 1: 입력, 2: 확인/수정
  const [rawText, setRawText] = useState('');
  const [sharedPin,  setSharedPin]  = useState('');
  const [sharedPin2, setSharedPin2] = useState('');
  const [pinError, setPinError] = useState('');

  // 2단계: 미리보기 명단 (번호 수정 가능)
  const [preview, setPreview] = useState([]); // [{name, number}]
  const [adding, setAdding]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [addError, setAddError] = useState('');

  function handleNext(e) {
    e.preventDefault();
    setPinError('');
    if (sharedPin.length !== 4)  { setPinError('비밀번호는 4자리 숫자여야 합니다.'); return; }
    if (sharedPin !== sharedPin2) { setPinError('비밀번호가 일치하지 않습니다.'); return; }

    const names = parseNameList(rawText);
    if (names.length === 0) { setPinError('이름을 하나 이상 입력해 주세요.'); return; }

    const seen = new Set();
    const dupes = names.filter((n) => {
      if (seen.has(n)) return true;
      seen.add(n);
      return false;
    });
    if (dupes.length) {
      setPinError(`같은 이름이 중복되었습니다: ${[...new Set(dupes)].join(', ')} — 이름을 구분해 주세요. (예: 김민수2)`);
      return;
    }

    const startNum = startStudentNumber;
    setPreview(names.map((name, i) => ({ name, number: startNum + i })));
    setStep(2);
  }

  function updateNumber(i, val) {
    const n = parseInt(val) || 0;
    setPreview((prev) => prev.map((r, idx) => idx === i ? { ...r, number: n } : r));
  }

  async function handleConfirm() {
    if (adding) return;
    setAdding(true); setAddError('');
    let successCount = 0;
    for (let i = 0; i < preview.length; i++) {
      const { name, number } = preview[i];
      try {
        const uuid     = generateUUID();
        const nameHash = await hashStudentName(name, classCode);
        const pinHash  = await hashPIN(sharedPin, classCode);

        // Firebase: UUID + 해시만 저장
        await createStudent({ uuid, classCode, nameHash, pinHash, studentNumber: number, displayName: name });
        // IndexedDB: 실명 저장 (교사 기기만)
        await saveStudentMappingWithCloud(teacherUid, { uuid, classCode, realName: name, studentNumber: number, pinHash });

        successCount++;
        setProgress(Math.round(((i + 1) / preview.length) * 100));
      } catch (err) {
        console.error(`${name} 등록 오류:`, err);
        setAddError(`'${name}' 등록 중 오류: ${err.message}`);
      }
    }
    setAdding(false);
    onDone(successCount);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>학생 일괄 추가 — {step === 1 ? '명단 입력' : '번호 확인 · 수정'}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {/* ── 단계 인디케이터 ── */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            {['명단 입력', '번호 확인'].map((label, i) => (
              <div key={i} style={{
                flex: 1, textAlign: 'center', padding: '6px 0', borderRadius: 8, fontSize: 13,
                background: step === i + 1 ? '#4f46e5' : '#f1f5f9',
                color: step === i + 1 ? '#fff' : '#94a3b8', fontWeight: step === i + 1 ? 700 : 400,
              }}>
                {i + 1}. {label}
              </div>
            ))}
          </div>

          {/* ── Step 1: 이름 입력 ── */}
          {step === 1 && (
            <form onSubmit={handleNext}>
              <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>
                🔒 실명은 이 기기(IndexedDB)에만 저장됩니다.
              </p>

              <div className="form-group">
                <label className="form-label">
                  학생 명단
                  <span className="form-hint"> — 줄바꿈, 쉼표, 탭 중 하나로 구분</span>
                </label>
                <textarea
                  className="form-input"
                  rows={8}
                  placeholder={'홍길동\n김철수\n이영희\n\n또는: 홍길동, 김철수, 이영희'}
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  required
                  style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.8 }}
                />
                {rawText && (
                  <p style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                    {parseNameList(rawText).length}명 인식됨
                  </p>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">
                  공통 초기 비밀번호
                  <span className="form-hint"> — 로그인용 4자리 숫자, 나중에 개별 초기화 가능</span>
                </label>
                <div className="form-row" style={{ gap: 12 }}>
                  <input type="password" inputMode="numeric" className="form-input"
                    placeholder="••••" maxLength={4} value={sharedPin}
                    onChange={(e) => setSharedPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    required style={{ letterSpacing: 8, fontSize: 20, textAlign: 'center' }}
                  />
                  <input type="password" inputMode="numeric" className="form-input"
                    placeholder="확인" maxLength={4} value={sharedPin2}
                    onChange={(e) => setSharedPin2(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    required style={{ letterSpacing: 8, fontSize: 20, textAlign: 'center' }}
                  />
                </div>
              </div>

              {pinError && <div className="alert alert-error" style={{ marginBottom: 12 }}>⚠️ {pinError}</div>}

              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={onClose}>취소</button>
                <button type="submit" className="btn btn-primary">다음 →</button>
              </div>
            </form>
          )}

          {/* ── Step 2: 번호 확인/수정 ── */}
          {step === 2 && (
            <div>
              <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                출석 번호는 직접 수정할 수 있습니다. 확인 후 등록 버튼을 누르세요.
              </p>

              <div className="table-wrapper" style={{ maxHeight: 340, overflowY: 'auto', marginBottom: 16 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 80 }}>출석 번호</th>
                      <th>이름</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            type="number" min="1" max="99"
                            className="form-input"
                            style={{ width: 64, padding: '4px 8px', textAlign: 'center' }}
                            value={row.number}
                            onChange={(e) => updateNumber(i, e.target.value)}
                          />
                        </td>
                        <td><strong>{row.name}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {addError && <div className="alert alert-error" style={{ marginBottom: 12 }}>⚠️ {addError}</div>}

              {adding && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ height: 6, background: '#e5e7eb', borderRadius: 9999, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#4f46e5', width: `${progress}%`,
                      transition: 'width 0.3s' }} />
                  </div>
                  <p style={{ fontSize: 12, color: '#6b7280', marginTop: 6, textAlign: 'center' }}>
                    등록 중... {progress}%
                  </p>
                </div>
              )}

              <div className="modal-footer">
                <button type="button" className="btn btn-ghost"
                  onClick={() => setStep(1)} disabled={adding}>← 뒤로</button>
                <button type="button" className="btn btn-primary"
                  onClick={handleConfirm} disabled={adding}>
                  {adding
                    ? <><span className="spinner" /> 등록 중...</>
                    : `✅ ${preview.length}명 등록하기`}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 로컬 실명(IndexedDB) 일괄 연결 모달
// ─────────────────────────────────────────────
function BulkLinkLocalNamesModal({ classCode, teacherUid, targets, onDone, onClose }) {
  const [step, setStep] = useState(1); // 1: 이름 붙여넣기, 2: 매칭 확인
  const [rawText, setRawText] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState([]); // [{ uuid, studentNumber, oldLabel, newName }]
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);

  const sortedTargets = useMemo(() => {
    const rows = Array.isArray(targets) ? [...targets] : [];
    rows.sort((a, b) => {
      const na = typeof a?.studentNumber === 'number' ? a.studentNumber : parseInt(String(a?.studentNumber ?? ''), 10);
      const nb = typeof b?.studentNumber === 'number' ? b.studentNumber : parseInt(String(b?.studentNumber ?? ''), 10);
      const aOk = Number.isFinite(na) && na > 0;
      const bOk = Number.isFinite(nb) && nb > 0;
      if (aOk && bOk && na !== nb) return na - nb;
      if (aOk && !bOk) return -1;
      if (!aOk && bOk) return 1;
      return String(a?.uuid || '').localeCompare(String(b?.uuid || ''));
    });
    return rows;
  }, [targets]);

  function handleNext(e) {
    e.preventDefault();
    setError('');
    const names = parseNameList(rawText);
    if (names.length === 0) {
      setError('이름 명단을 1줄에 1명씩 붙여넣어 주세요.');
      return;
    }
    if (names.length !== sortedTargets.length) {
      setError(`줄 수가 맞지 않습니다: 로컬 없음 ${sortedTargets.length}명 / 입력 ${names.length}줄`);
      return;
    }
    const rows = sortedTargets.map((t, i) => ({
      uuid: String(t.uuid || '').trim(),
      studentNumber: t.studentNumber ?? null,
      oldLabel: t.displayName || '',
      newName: names[i],
      pinHash: t.pinHash,
    }));
    setPreview(rows);
    setStep(2);
  }

  async function handleConfirm() {
    if (saving) return;
    setSaving(true);
    setProgress(0);
    setError('');
    try {
      for (let i = 0; i < preview.length; i++) {
        const row = preview[i];
        if (!row.uuid) continue;
        const name = String(row.newName || '').trim();
        if (!name) continue;
        await saveStudentMappingWithCloud(teacherUid, {
          uuid: row.uuid,
          classCode,
          realName: name,
          studentNumber: row.studentNumber ?? null,
          pinHash: row.pinHash,
        });
        await updateStudentDisplayName(row.uuid, name);
        setProgress(Math.round(((i + 1) / preview.length) * 100));
      }
      onDone(preview.length);
    } catch (err) {
      setError('저장 중 오류: ' + (err?.message || 'unknown'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>로컬 이름 일괄 연결 — {step === 1 ? '명단 붙여넣기' : '매칭 확인'}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <p style={{ fontSize: 12, color: '#64748b', marginTop: -4, marginBottom: 12, lineHeight: 1.5 }}>
            <strong>로컬 없음</strong> 학생 {sortedTargets.length}명을 <strong>출석번호 순</strong>으로 정렬한 뒤,
            붙여넣은 이름 {sortedTargets.length}줄을 위에서부터 순서대로 매칭합니다. (서버에는 실명 저장 안 됨)
          </p>

          {step === 1 && (
            <form onSubmit={handleNext}>
              <div className="form-group">
                <label className="form-label">
                  이름 명단 (1줄 1명)
                  <span className="form-hint"> — 줄 수가 로컬 없음 인원과 같아야 합니다</span>
                </label>
                <textarea
                  className="form-input"
                  rows={10}
                  placeholder={'홍길동\n김철수\n이영희'}
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  style={{ resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.8 }}
                  required
                />
                {rawText && (
                  <p style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
                    {parseNameList(rawText).length}줄 인식됨 / 로컬 없음 {sortedTargets.length}명
                  </p>
                )}
              </div>

              {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>⚠️ {error}</div>}

              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={onClose}>취소</button>
                <button type="submit" className="btn btn-primary">다음 →</button>
              </div>
            </form>
          )}

          {step === 2 && (
            <div>
              <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                아래 매칭이 맞는지 확인하고 저장을 누르세요.
              </p>

              <div className="table-wrapper" style={{ maxHeight: 360, overflowY: 'auto', marginBottom: 16 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 80 }}>번호</th>
                      <th style={{ width: 160 }}>현재 표시</th>
                      <th>저장할 이름(로컬)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r) => (
                      <tr key={r.uuid}>
                        <td className="text-center">{r.studentNumber || '-'}</td>
                        <td style={{ fontSize: 12, color: '#64748b' }}>{r.oldLabel || '-'}</td>
                        <td><strong>{r.newName}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {saving && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ height: 6, background: '#e5e7eb', borderRadius: 9999, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#4f46e5', width: `${progress}%`,
                      transition: 'width 0.3s' }} />
                  </div>
                  <p style={{ fontSize: 12, color: '#6b7280', marginTop: 6, textAlign: 'center' }}>
                    저장 중... {progress}%
                  </p>
                </div>
              )}

              {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>⚠️ {error}</div>}

              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setStep(1)} disabled={saving}>
                  ← 뒤로
                </button>
                <button type="button" className="btn btn-primary" onClick={handleConfirm} disabled={saving}>
                  {saving ? <><span className="spinner" /> 저장 중...</> : `✅ ${preview.length}명 로컬 이름 저장`}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// 메인 대시보드
// ─────────────────────────────────────────────
export default function TeacherDashboard() {
  const { teacherUser, teacherProfile, teacherLogout, updateTeacherGeminiKey } = useAuth();
  const navigate = useNavigate();
  const [toast, showToast] = useToast();
  const [classAiRerunLoading, setClassAiRerunLoading] = useState(false);
  const [variantBackfillLoading, setVariantBackfillLoading] = useState(false);
  const [debugEnvOpen, setDebugEnvOpen] = useState(false);
  const [variantDiag, setVariantDiag] = useState(null);

  // ─── 탭 상태 ───
  const [activeTab, setActiveTab] = useState('home'); // 'home' | 'inbox' | 'students' | 'class'
  const [homeToolView, setHomeToolView] = useState(null); // null | 'problemBank'
  const [inboxFilter, setInboxFilter] = useState('all'); // 'all' | 'variant' | 'newProblem' | 'wrongNote'
  const [evaluationSubTab, setEvaluationSubTab] = useState('studentDb');
  const [selectedStudentUuid, setSelectedStudentUuid] = useState(null);
  const [studentDetailTab, setStudentDetailTab] = useState('summary');

  const [classCode,      setClassCode]      = useState(null);
  /** Firestore 학급 목록으로 학급 코드를 확정하기 전까지 true === 아직 초기 학급 선택 중 */
  const [classSelecting, setClassSelecting] = useState(true);
  const [classInfo,      setClassInfo]      = useState(null);
  const [localMappings,  setLocalMappings]  = useState([]); // IndexedDB (실명 포함, 현재 학급)
  const [allLocalMappings, setAllLocalMappings] = useState([]); // IndexedDB 전체 — 검수함 이름 매칭용
  const [showBulkLinkModal, setShowBulkLinkModal] = useState(false);
  const [serverStudents, setServerStudents] = useState([]); // Firebase (UUID만)
  const [loading,        setLoading]        = useState(false);

  // 모달
  const [showAddModal,    setShowAddModal]    = useState(false);
  const [showPinModal,    setShowPinModal]    = useState(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showPurgeModal,  setShowPurgeModal]  = useState(false);
  const [showExamResultModal, setShowExamResultModal] = useState(false);

  /** 학생 목록 다중 선택 (uuid) */
  const [selectedStudentUuids, setSelectedStudentUuids] = useState([]);
  const selectAllCheckboxRef = useRef(null);

  // 로그인 비밀번호(4자리) 초기화 모달 입력
  const [newPin,  setNewPin]  = useState('');
  const [newPin2, setNewPin2] = useState('');
  const [pinResetting, setPinResetting] = useState(false);

  // Export
  const [exportPw,  setExportPw]  = useState('');
  const [exportPw2, setExportPw2] = useState('');
  const [exporting, setExporting] = useState(false);

  // Import
  const importFileRef = useRef(null);
  const [importPw,   setImportPw]   = useState('');
  const [importFile, setImportFile] = useState(null);
  const [importing,  setImporting]  = useState(false);

  // Purge
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [purging,      setPurging]      = useState(false);

  // 학급코드 이관
  const [showMigrateModal, setShowMigrateModal] = useState(false);
  const [migrateToCode, setMigrateToCode] = useState('');
  const [migrating, setMigrating] = useState(false);
  const [migrateSummary, setMigrateSummary] = useState(null);

  // ─── 변형 문제 검수 ───
  const [variantReviews,        setVariantReviews]        = useState([]);
  const [variantReviewsLoading, setVariantReviewsLoading] = useState(false);
  const [resolvingId,           setResolvingId]           = useState(null);
  const [reviewFeedbackDraftMap, setReviewFeedbackDraftMap] = useState({});

  const runVariantReviewDiagnostics = useCallback(async () => {
    if (!classCode) return;
    setVariantDiag({ phase: 'running' });
    try {
      const classCodesToTry = Array.from(new Set([
        normalizeClassCode(classCode),
        String(classCode || '').trim(),
        String(classCode || '').trim().toLowerCase(),
      ].filter(Boolean)));

      async function countStudentsByCode(cc) {
        const qRef = query(collection(db, 'students'), where('classCode', '==', cc), limit(5));
        const snap = await getDocs(qRef);
        return snap.size;
      }

      const studentCounts = {};
      for (const cc of classCodesToTry) {
        try {
          studentCounts[cc] = await countStudentsByCode(cc);
        } catch (e) {
          studentCounts[cc] = `ERR:${e?.code || 'unknown'}`;
        }
      }

      const uuids = (serverStudents || []).map((s) => s.uuid).filter(Boolean);
      const maxStudents = 60;
      const maxPerStudent = 80;
      const maxReviewIds = 120;

      let problemBankDocCount = 0;
      const found = [];

      for (const uuid of uuids.slice(0, maxStudents)) {
        const snap = await getDocs(collection(db, 'students', uuid, 'problemBank'));
        const docs = snap.docs.slice(0, maxPerStudent);
        problemBankDocCount += docs.length;
        for (const d of docs) {
          const row = d.data() || {};
          const inferredReviewId =
            String(row.reviewId || '').trim()
            || (row.examId && row.sourceNumber != null
              ? `exam_${String(row.examId).trim()}_s${uuid}_q${Number(row.sourceNumber)}`
              : '')
            || buildVariantReviewId(uuid, d.id);

          if (inferredReviewId) {
            found.push({
              uuid,
              bankId: d.id,
              reviewId: inferredReviewId,
              status: row.status || '',
              bankClassCode: row.classCode || '',
              examId: row.examId || '',
              sourceNumber: row.sourceNumber ?? null,
              savedAt: row.savedAt || '',
            });
          }
          if (found.length >= maxReviewIds) break;
        }
        if (found.length >= maxReviewIds) break;
      }

      const uniq = new Map();
      for (const r of found) {
        if (!uniq.has(r.reviewId)) uniq.set(r.reviewId, r);
      }
      const samples = Array.from(uniq.values()).slice(0, maxReviewIds);

      const checks = [];
      for (const s of samples) {
        try {
          const vrSnap = await getDoc(fsDoc(db, 'variantReviews', s.reviewId));
          if (vrSnap.exists()) {
            const data = vrSnap.data() || {};
            checks.push({
              reviewId: s.reviewId,
              ok: true,
              exists: true,
              vrClassCode: data.classCode || '',
              vrStatus: data.status || '',
              vrCreatedAt: data.createdAt || null,
            });
          } else {
            checks.push({ reviewId: s.reviewId, ok: true, exists: false });
          }
        } catch (e) {
          checks.push({
            reviewId: s.reviewId,
            ok: false,
            code: e?.code || '',
            message: String(e?.message || ''),
          });
        }
      }

      // ── 실제 getVariantReviewsByClass 쿼리 결과도 직접 확인 ──
      const queryResults = {};
      for (const cc of classCodesToTry) {
        try {
          const q = query(
            collection(db, 'variantReviews'),
            where('classCode', '==', cc),
            where('status', 'in', VARIANT_REVIEW_OPEN_STATUSES),
            orderBy('createdAt', 'desc'),
          );
          const snap = await getDocs(q);
          queryResults[cc] = { count: snap.size, error: null };
        } catch (e) {
          queryResults[cc] = { count: 0, error: `${e?.code || ''}:${e?.message || ''}` };
        }
      }

      const summary = {
        classCodeTried: classCodesToTry,
        studentCounts,
        serverStudentsCount: uuids.length,
        problemBankDocCount,
        foundInProblemBank: found.length,
        uniqueReviewIds: samples.length,
        existsCount: checks.filter((c) => c.ok && c.exists).length,
        missingCount: checks.filter((c) => c.ok && c.exists === false).length,
        deniedCount: checks.filter((c) => !c.ok && /permission|denied/i.test(c.message)).length,
        likelyMissingReviews: checks.filter((c) => !c.ok && c.code === 'permission-denied').length,
        errorCount: checks.filter((c) => !c.ok && c.code !== 'permission-denied').length,
        queryResults,
      };

      try {
        const norm = normalizeClassCode(classCode);
        const cpSnap = await getDocs(query(
          collection(db, 'classes', norm, 'problemBank'),
          limit(500),
        ));
        summary.classProblemBankCount = cpSnap.size;
      } catch {
        summary.classProblemBankCount = null;
      }

      setVariantDiag({
        phase: 'done',
        summary,
        sampleFromBank: samples.slice(0, 8),
        sampleChecks: checks.slice(0, 8),
      });
    } catch (e) {
      setVariantDiag({
        phase: 'error',
        message: String(e?.message || e),
      });
    }
  }, [classCode, serverStudents]);

  // ─── 오답노트 검수 ───
  const [wrongNoteReviews,        setWrongNoteReviews]        = useState([]);
  const [wrongNoteReviewsLoading, setWrongNoteReviewsLoading] = useState(false);
  const [resolvingWrongNoteId,    setResolvingWrongNoteId]    = useState(null);
  const [purgingVariantId,        setPurgingVariantId]        = useState(null);
  const [purgingWrongNoteId,      setPurgingWrongNoteId]      = useState(null);
  const [competencyRows,            setCompetencyRows]            = useState([]);
  const [competencyLoading,         setCompetencyLoading]         = useState(false);
  const [wrongNoteCompetencyRows,   setWrongNoteCompetencyRows]   = useState([]);
  const [wrongNoteCompetencyLoading, setWrongNoteCompetencyLoading] = useState(false);
  const [classSolveStatsRows,       setClassSolveStatsRows]       = useState([]);
  const [classSolveStatsLoading,    setClassSolveStatsLoading]    = useState(false);
  const [classProblemBankProblems,  setClassProblemBankProblems]  = useState([]);
  const [classProblemBankEvaluations, setClassProblemBankEvaluations] = useState([]);
  const [classProblemBankLinkedReviews, setClassProblemBankLinkedReviews] = useState([]);
  const [classProblemBankLoading,   setClassProblemBankLoading]   = useState(false);
  const [selectedClassProblemId,    setSelectedClassProblemId]    = useState(null);

  const showDevMakingSubmitPanel = isDevMakingSubmitPanelEnabled();
  const showDevReviewInboxPurge = isDevReviewInboxPurgeEnabled();
  const [makingSubmitStatsRows,   setMakingSubmitStatsRows]   = useState([]);
  const [makingSubmitStatsLoading, setMakingSubmitStatsLoading] = useState(false);

  const mergedStudents = React.useMemo(
    () => mergeStudentsForTeacherView(localMappings, serverStudents, classCode),
    [localMappings, serverStudents, classCode],
  );

  const variantReviewsSorted = React.useMemo(
    () => sortRowsBySubmissionTime(variantReviews),
    [variantReviews],
  );

  const allVariantReviewsForBank = useMemo(() => {
    const merged = [...variantReviews, ...classProblemBankLinkedReviews];
    const byId = new Map();
    for (const row of merged) {
      if (row?.id) byId.set(row.id, row);
    }
    return Array.from(byId.values());
  }, [variantReviews, classProblemBankLinkedReviews]);

  const wrongNoteReviewsSorted = React.useMemo(
    () => sortRowsBySubmissionTime(wrongNoteReviews),
    [wrongNoteReviews],
  );

  const buildReviewFeedbackDraft = useCallback(
    (item) => buildTeacherReviewFeedbackDraft(item),
    [],
  );

  const buildAiPatchFromDraft = useCallback((item, draft) => {
    if (!draft) return null;
    const finalized = finalizeTeacherFeedbackDraft(item, draft);
    return {
      aiNote: String(finalized.note || '').trim(),
      aiChecks: finalized.checks,
      aiApproved: deriveAiApprovedFromChecks(finalized.checks, item),
    };
  }, []);

  useEffect(() => {
    const items = [...variantReviews, ...wrongNoteReviews];
    if (items.length === 0) return;
    setReviewFeedbackDraftMap((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const item of items) {
        if (!item?.id) continue;
        const built = buildReviewFeedbackDraft(item);
        const existing = next[item.id];
        if (!existing) {
          next[item.id] = built;
          changed = true;
          continue;
        }
        if (existing.noteEditedByTeacher) continue;
        if (!teacherChecksMatchBaseline(existing.checks, existing.baselineChecks)) continue;
        const reviewMetaChanged = (
          String(item.aiReviewStatus || 'pending') !== String(existing.sourceAiReviewStatus || 'pending')
          || String(item.aiMode || '') !== String(existing.sourceAiMode || '')
          || String(item.aiCompletionLevel || '') !== String(existing.sourceAiCompletionLevel || '')
        );
        const aiArrived = item.aiReviewStatus === 'done' && (
          reviewMetaChanged
          || String(item.aiNote || '').trim() !== String(existing.baselineNote || '').trim()
          || JSON.stringify(item.aiChecks || null) !== JSON.stringify(existing.baselineChecks || null)
        );
        if (aiArrived) {
          next[item.id] = built;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [variantReviews, wrongNoteReviews, buildReviewFeedbackDraft]);

  const getReviewFeedbackDraft = useCallback((item) => {
    if (!item?.id) {
      return {
        checks: {},
        note: '',
        baselineNote: '',
        baselineChecks: {},
        noteEditedByTeacher: false,
      };
    }
    const built = buildReviewFeedbackDraft(item);
    const raw = reviewFeedbackDraftMap[item.id];
    const manualKeys = resolveTeacherManualCheckKeys(item);
    if (!raw) return built;
    if (raw.noteEditedByTeacher) {
      return {
        ...built,
        checks: ensureTeacherManualChecks(raw.checks, manualKeys),
        note: raw.note ?? '',
        baselineNote: raw.baselineNote ?? built.baselineNote,
        baselineChecks: raw.baselineChecks ?? built.baselineChecks,
        noteEditedByTeacher: true,
      };
    }
    if (teacherChecksMatchBaseline(raw.checks, raw.baselineChecks)) {
      return built;
    }
    return {
      ...built,
      checks: ensureTeacherManualChecks(raw.checks, manualKeys),
      note: raw.note ?? syncTeacherFeedbackNote({
        checks: raw.checks,
        baselineNote: raw.baselineNote ?? built.baselineNote,
        baselineChecks: raw.baselineChecks ?? built.baselineChecks,
        item,
      }),
      baselineNote: raw.baselineNote ?? built.baselineNote,
      baselineChecks: raw.baselineChecks ?? built.baselineChecks,
      noteEditedByTeacher: false,
    };
  }, [reviewFeedbackDraftMap, buildReviewFeedbackDraft]);

  const competencyRowsSorted = React.useMemo(
    () => sortRowsByStudentAttendance(competencyRows, mergedStudents, 'uuid'),
    [competencyRows, mergedStudents],
  );

  const wrongNoteCompetencyRowsSorted = React.useMemo(
    () => sortRowsByStudentAttendance(wrongNoteCompetencyRows, mergedStudents, 'uuid'),
    [wrongNoteCompetencyRows, mergedStudents],
  );

  const classSolveStatsByUuid = React.useMemo(() => {
    const map = new Map();
    classSolveStatsRows.forEach((row) => {
      if (row.uuid) map.set(row.uuid, row);
    });
    return map;
  }, [classSolveStatsRows]);

  const classSolveStatsSorted = React.useMemo(
    () => mergedStudents
      .filter((s) => s.uuid)
      .map((st) => {
        const stats = classSolveStatsByUuid.get(st.uuid);
        return {
          uuid: st.uuid,
          total: stats?.total || 0,
          correct: stats?.correct || 0,
        };
      }),
    [mergedStudents, classSolveStatsByUuid],
  );

  const makingSubmitStatsByUuid = React.useMemo(() => {
    const map = new Map();
    makingSubmitStatsRows.forEach((row) => {
      if (row.uuid) map.set(row.uuid, row);
    });
    return map;
  }, [makingSubmitStatsRows]);

  const competencyByUuid = React.useMemo(() => {
    const map = new Map();
    competencyRows.forEach((row) => {
      if (row.uuid) map.set(row.uuid, row);
    });
    return map;
  }, [competencyRows]);

  const wrongNoteCompetencyByUuid = React.useMemo(() => {
    const map = new Map();
    wrongNoteCompetencyRows.forEach((row) => {
      if (row.uuid) map.set(row.uuid, row);
    });
    return map;
  }, [wrongNoteCompetencyRows]);

  // ─── 마이페이지: Gemini API 키 ───
  const [geminiKeyInput,    setGeminiKeyInput]    = useState('');
  const [geminiKeySaving,   setGeminiKeySaving]   = useState(false);
  const [geminiKeyRevealed, setGeminiKeyRevealed] = useState(false);
  const [reviewAlertAudioReady, setReviewAlertAudioReady] = useState(
    () => isTeacherNotificationAudioUnlocked(),
  );
  /** 학급 명단(loadData) 동기화 전 검수 목록 로드 방지 */
  const [rosterSynced, setRosterSynced] = useState(false);
  const variantReviewsLoadGenRef = useRef(0);

  // ─── 변형 문제 검수 목록 로드 ───
  const loadVariantReviews = useCallback(async (opts = {}) => {
    const silent = opts.silent === true;
    if (!classCode) return;
    const gen = variantReviewsLoadGenRef.current + 1;
    variantReviewsLoadGenRef.current = gen;
    const isStale = () => variantReviewsLoadGenRef.current !== gen;
    if (!silent) setVariantReviewsLoading(true);
    try {
      // ① classCode 기반 쿼리 (정상 케이스)
      const itemsByCode = await getVariantReviewsByClass(classCode, VARIANT_REVIEW_OPEN_STATUSES);
      const byId = new Map(itemsByCode.map((i) => [i.id, i]));

      // ② studentUUID 기반 쿼리 (학급 이관 등으로 classCode가 다른 경우도 포함)
      const uuids = (serverStudents || []).map((s) => s.uuid).filter(Boolean);
      if (uuids.length > 0) {
        // Firestore in 연산자 최대 30개 → 30개씩 나눠서 쿼리
        const BATCH = 30;
        for (let i = 0; i < uuids.length; i += BATCH) {
          const batch = uuids.slice(i, i + BATCH);
          try {
            const q = query(
              collection(db, 'variantReviews'),
              where('studentUUID', 'in', batch),
            );
            const snap = await getDocs(q);
            snap.docs.forEach((d) => {
              const data = d.data() || {};
              // status 필터는 클라이언트에서 처리
              if (isOpenVariantReviewForTeacherInbox({ id: d.id, ...data }) && !byId.has(d.id)) {
                byId.set(d.id, { id: d.id, ...data });
              }
            });
          } catch (e) {
            console.warn('[loadVariantReviews] studentUUID query err', e?.code);
          }
        }
      }

      let allItems = Array.from(byId.values()).filter(isOpenVariantReviewForTeacherInbox);

      // 학급 problemBank에는 있는데 variantReviews 검수 문서만 없는 경우 자동 백필
      if (allItems.length === 0 && (serverStudents || []).length > 0) {
        try {
          const backfill = await backfillMissingVariantReviewsForClass(classCode, { maxItems: 200 });
          if (backfill.created > 0) {
            const refetched = await getVariantReviewsByClass(classCode, VARIANT_REVIEW_OPEN_STATUSES);
            allItems = refetched;
            showToast(`검수 문서 ${backfill.created}건을 자동 연결했어요.`, 'success');
          }
        } catch (backfillErr) {
          console.warn('[loadVariantReviews] auto backfill', backfillErr);
        }
      }

      let problems = [];
      try {
        problems = await getClassProblems(classCode, '', 500);
      } catch (e) {
        console.warn('[loadVariantReviews] getClassProblems', e?.code);
      }

      if (problems.length > 0) {
        try {
          const { synced } = await syncClassProblemBankAiToVariantReviews(
            classCode,
            problems,
            allItems,
          );
          if (synced > 0) {
            const refetchedByCode = await getVariantReviewsByClass(
              classCode,
              VARIANT_REVIEW_OPEN_STATUSES,
            );
            const refetchedById = new Map(refetchedByCode.map((i) => [i.id, i]));
            for (const item of allItems) {
              if (!refetchedById.has(item.id)) refetchedById.set(item.id, item);
            }
            refetchedByCode.forEach((item) => refetchedById.set(item.id, item));
            allItems = Array.from(refetchedById.values()).filter(isOpenVariantReviewForTeacherInbox);
          }
        } catch (syncErr) {
          console.warn('[loadVariantReviews] sync AI to variantReviews', syncErr);
        }
      }

      allItems = enrichVariantReviewsWithClassProblemAi(allItems, problems);
      setClassProblemBankProblems((prev) => (
        problems.length >= (prev?.length || 0) ? problems : prev
      ));

      if (isStale()) return;
      setVariantReviews(sortRowsBySubmissionTime(allItems));
    } catch (e) {
      if (isStale()) return;
      console.error('변형 문제 검수 로드 오류:', e);
      const indexHint = /index|failed-precondition/i.test(String(e?.message || ''))
        ? ' (Firestore 색인 배포 필요: firebase deploy --only firestore:indexes)'
        : '';
      showToast('변형 문제 검수 목록 로드 오류: ' + e.message + indexHint, 'error');
    }
    if (!silent && !isStale()) setVariantReviewsLoading(false);
  }, [classCode, showToast, serverStudents]);

  /** 실시간 구독으로 AI 검수 완료된 항목만 목록에 반영 (전체 새로고침 없음) */
  const patchVariantReviewItem = useCallback((updatedItem) => {
    if (!updatedItem?.id) return;
    setVariantReviews((prev) => {
      const [enriched] = enrichVariantReviewsWithClassProblemAi(
        [updatedItem],
        classProblemBankProblems,
      );
      const idx = prev.findIndex((i) => i.id === updatedItem.id);
      if (idx < 0) {
        return sortRowsBySubmissionTime([...prev, enriched]);
      }
      const next = [...prev];
      next[idx] = { ...prev[idx], ...enriched };
      return next;
    });
  }, [classProblemBankProblems]);

  // ─── variantReviews classCode 마이그레이션 (학급 이관 후 구버전 classCode 일괄 수정) ───
  const [migrationState, setMigrationState] = useState(null); // null | 'running' | {updated, errors}

  const migrateVariantReviewsClassCode = useCallback(async () => {
    if (!classCode || !serverStudents.length) return;
    const norm = normalizeClassCode(classCode);
    setMigrationState('running');
    let updated = 0;
    let errors = 0;

    for (const student of serverStudents) {
      const uuid = student.uuid;
      if (!uuid) continue;
      try {
        const q = query(collection(db, 'variantReviews'), where('studentUUID', '==', uuid));
        const snap = await getDocs(q);
        for (const d of snap.docs) {
          const existing = d.data()?.classCode || '';
          if (existing !== norm) {
            await updateDoc(d.ref, { classCode: norm, updatedAt: serverTimestamp() });
            updated++;
          }
        }
      } catch (e) {
        console.warn('[migrate] 학생 오류', uuid, e?.code, e?.message);
        errors++;
      }
    }

    setMigrationState({ updated, errors });
    showToast(
      `classCode 마이그레이션: ${updated}건 업데이트, ${errors}건 오류`,
      errors > 0 ? 'warn' : 'success',
    );
    void loadVariantReviews();
  }, [classCode, serverStudents, showToast, loadVariantReviews]);

  // ─── legacy pending → pending_review 정리 (검수함 누락 방지) ───
  const [legacyPendingMigrationState, setLegacyPendingMigrationState] = useState(null); // null | 'running' | {updated, errors}
  const migrateLegacyPendingStatuses = useCallback(async () => {
    if (!classCode) return;
    setLegacyPendingMigrationState('running');
    try {
      const res = await migrateLegacyPendingVariantReviews(classCode, { maxItems: 800 });
      setLegacyPendingMigrationState({ updated: res.updated, errors: res.errors });
      if (res.updated > 0) {
        showToast(
          `레거시 pending ${res.updated}건을 pending_review로 정리했어요.`,
          res.errors > 0 ? 'warn' : 'success',
        );
      } else {
        showToast('레거시 pending 문서가 없습니다.', 'success');
      }
      await loadVariantReviews({ silent: true });
    } catch (e) {
      console.warn('[migrateLegacyPendingStatuses]', e?.code, e?.message);
      setLegacyPendingMigrationState({ updated: 0, errors: 1 });
      showToast('레거시 pending 정리 오류: ' + (e?.message || 'unknown'), 'error');
    }
  }, [classCode, showToast, loadVariantReviews]);

  const loadWrongNoteReviews = useCallback(async () => {
    if (!classCode) return;
    setWrongNoteReviewsLoading(true);
    try {
      const items = await getWrongNoteReviewsByClass(
        classCode,
        [SUBMISSION_STATUS_PENDING_REVIEW],
      );
      setWrongNoteReviews(sortRowsBySubmissionTime(items));
    } catch (e) {
      console.error('오답노트 검수 로드 오류:', e);
      showToast('오답노트 검수 목록 로드 오류: ' + e.message, 'error');
    }
    setWrongNoteReviewsLoading(false);
  }, [classCode, showToast]);

  // ─── 기존 활동 탐구 포인트 백필 (학급당 1회, 승인일=오늘 KST) ───
  const explorationBackfillStartedRef = useRef(false);
  useEffect(() => {
    if (!classCode || explorationBackfillStartedRef.current) return;
    explorationBackfillStartedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        if (await isExplorationBackfillDone(classCode)) return;
        const result = await backfillExplorationPointsForClass(classCode);
        if (cancelled) return;
        await markExplorationBackfillDone(classCode);
        if (result.applied > 0) {
          showToast(
            `기존 활동 점수 반영 완료 — ${result.applied}건 · ${formatExplorationPoints(result.points, { signed: true })} (최근 30일 랭킹 포함)`,
            'success',
          );
        }
      } catch (e) {
        console.warn('[explorationBackfill]', e?.code, e?.message || e);
        explorationBackfillStartedRef.current = false;
      }
    })();

    return () => { cancelled = true; };
  }, [classCode, showToast]);

  async function handleResolveWrongNote(item, newStatus, draft) {
    if (resolvingWrongNoteId) return;
    setResolvingWrongNoteId(item.id);
    try {
      const aiPatch = buildAiPatchFromDraft(item, draft || getReviewFeedbackDraft(item));
      await resolveWrongNoteReview(
        item.id,
        item.studentUUID,
        item.examResultId,
        item.questionNumber,
        newStatus,
        '',
        aiPatch,
      );
      showToast(
        newStatus === SUBMISSION_STATUS_APPROVED
          ? '피드백을 보냈습니다. (승인)'
          : '피드백을 보냈습니다. (반려)',
      );
      setReviewFeedbackDraftMap((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      await loadWrongNoteReviews();
    } catch (e) {
      showToast('처리 오류: ' + e.message, 'error');
    }
    setResolvingWrongNoteId(null);
  }

  function handleReviewFeedbackToggleCheck(item, checkKey) {
    if (!item?.id) return;
    setReviewFeedbackDraftMap((prev) => {
      const draft = prev[item.id] || buildReviewFeedbackDraft(item);
      const checks = { ...draft.checks };
      checks[checkKey] = typeof checks[checkKey] === 'boolean' ? !checks[checkKey] : true;
      const nextDraft = {
        ...draft,
        checks,
        baselineNote: draft.baselineNote ?? String(item?.aiNote || '').trim(),
        baselineChecks: draft.baselineChecks ?? cloneAiChecks(
          ensureTeacherManualChecks(item?.aiChecks, resolveTeacherManualCheckKeys(item)),
        ),
      };
      if (!draft.noteEditedByTeacher) {
        nextDraft.note = syncTeacherFeedbackNote({
          checks,
          baselineNote: nextDraft.baselineNote,
          baselineChecks: nextDraft.baselineChecks,
          item,
        });
      }
      return { ...prev, [item.id]: nextDraft };
    });
  }

  function handleReviewFeedbackNoteChange(reviewId, note) {
    setReviewFeedbackDraftMap((prev) => ({
      ...prev,
      [reviewId]: {
        ...(prev[reviewId] || { checks: {} }),
        note,
        noteEditedByTeacher: true,
      },
    }));
  }

  function handleSendWrongNoteFeedback(item) {
    const draft = getReviewFeedbackDraft(item);
    const newStatus = deriveReviewStatusFromChecks(
      draft.checks,
      SUBMISSION_STATUS_APPROVED,
      SUBMISSION_STATUS_REJECTED,
      item,
    );
    void handleResolveWrongNote(item, newStatus, draft);
  }

  // ─── 변형 문제 검수 결과 처리 ───
  async function handleResolveVariant(reviewId, studentUUID, newStatus, draft, item) {
    if (resolvingId) return;
    setResolvingId(reviewId);
    try {
      const aiPatch = buildAiPatchFromDraft(item, draft);
      await resolveVariantReview(reviewId, studentUUID, newStatus, '', aiPatch);
      showToast(
        newStatus === SUBMISSION_STATUS_APPROVED
          ? '피드백을 보냈습니다. (승인)'
          : newStatus === SUBMISSION_STATUS_APPROVED_PARTIAL
            ? '피드백을 보냈습니다. (풀이 과정 보완 필요)'
            : '피드백을 보냈습니다. (반려)',
      );
      setReviewFeedbackDraftMap((prev) => {
        const next = { ...prev };
        delete next[reviewId];
        return next;
      });
      await loadVariantReviews();
      await loadClassProblemBank();
    } catch (e) {
      showToast('처리 오류: ' + e.message, 'error');
    }
    setResolvingId(null);
  }

  function handleSendVariantFeedback(item) {
    const draft = getReviewFeedbackDraft(item);
    const newStatus = deriveVariantReviewStatusFromChecks(draft.checks, item);
    const sid = extractReviewStudentUuid(item);
    void handleResolveVariant(item.id, sid, newStatus, draft, item);
  }

  async function handlePurgeVariant(item) {
    if (purgingVariantId || !showDevReviewInboxPurge) return;
    const label = item.examTitle
      ? `${item.examTitle} — ${item.questionNumber ?? '?'}번`
      : (item.question || '').slice(0, 40) || item.id;
    const ok = window.confirm(
      `[개발용 완전 삭제]\n\n「${label}」 제출을 삭제할까요?\n\n`
      + '검수 문서, 학생 문제 저장소, 시험 변형 기록, 학급 문제은행(있을 경우)이 모두 삭제됩니다. 되돌릴 수 없습니다.',
    );
    if (!ok) return;

    setPurgingVariantId(item.id);
    try {
      await purgeVariantReviewSubmission(item);
      showToast('제출을 완전히 삭제했습니다. (개발)', 'success');
      await loadVariantReviews();
      await loadClassProblemBank();
    } catch (e) {
      showToast('삭제 오류: ' + e.message, 'error');
    }
    setPurgingVariantId(null);
  }

  async function handlePurgeWrongNote(item) {
    if (purgingWrongNoteId || !showDevReviewInboxPurge) return;
    const label = `${item.examName || '(시험)'} — ${item.questionNumber}번`;
    const ok = window.confirm(
      `[개발용 완전 삭제]\n\n「${label}」 오답노트 제출을 삭제할까요?\n\n`
      + '검수 문서와 학생 오답노트 초안이 삭제됩니다. 되돌릴 수 없습니다.',
    );
    if (!ok) return;

    setPurgingWrongNoteId(item.id);
    try {
      await purgeWrongNoteReviewSubmission(item);
      showToast('오답노트 제출을 완전히 삭제했습니다. (개발)', 'success');
      await loadWrongNoteReviews();
    } catch (e) {
      showToast('삭제 오류: ' + e.message, 'error');
    }
    setPurgingWrongNoteId(null);
  }

  const loadMakingCompetency = useCallback(async () => {
    if (!classCode) return;
    setCompetencyLoading(true);
    try {
      const uuids = mergedStudents.map((s) => s.uuid).filter(Boolean);
      const rows = await getClassMakingCompetency(classCode, uuids);
      setCompetencyRows(rows);
    } catch (e) {
      console.error('역량 로드 오류:', e);
      showToast('문제 만들기 역량 로드 오류: ' + e.message, 'error');
    }
    setCompetencyLoading(false);
  }, [classCode, mergedStudents, showToast]);

  const loadWrongNoteCompetency = useCallback(async () => {
    if (!classCode) return;
    setWrongNoteCompetencyLoading(true);
    try {
      const uuids = mergedStudents.map((s) => s.uuid).filter(Boolean);
      const rows = await getClassWrongNoteCompetency(classCode, uuids);
      setWrongNoteCompetencyRows(rows);
    } catch (e) {
      console.error('오답노트 역량 로드 오류:', e);
      showToast('오답노트 역량 로드 오류: ' + e.message, 'error');
    }
    setWrongNoteCompetencyLoading(false);
  }, [classCode, mergedStudents, showToast]);

  const loadClassSolveStats = useCallback(async () => {
    if (!classCode) return;
    setClassSolveStatsLoading(true);
    try {
      const rows = await getClassSolveStatsByStudent(classCode);
      setClassSolveStatsRows(rows);
    } catch (e) {
      console.error('학급 문제 풀이 통계 로드 오류:', e);
      showToast('학급 문제 풀이 통계 로드 오류: ' + e.message, 'error');
    }
    setClassSolveStatsLoading(false);
  }, [classCode, showToast]);

  const loadClassProblemBank = useCallback(async (opts = {}) => {
    if (!classCode) return;
    setClassProblemBankLoading(true);
    try {
      if (opts.syncStudents && serverStudents?.length) {
        for (const student of serverStudents) {
          const uuid = student?.uuid;
          if (!uuid) continue;
          // eslint-disable-next-line no-await-in-loop
          await syncStudentProblemsToClassBank(uuid, classCode).catch((e) => {
            console.warn('[classProblemBank] syncStudentProblemsToClassBank', uuid, e?.code);
          });
        }
      }

      await reconcileClassProblemLabels(classCode).catch((e) => {
        console.warn('[classProblemBank] reconcile labels', e);
      });
      await backfillClassProblemCurriculumLabels(classCode).catch((e) => {
        console.warn('[classProblemBank] backfill curriculum labels', e);
      });
      await backfillClassProblemCreatorSolutions(classCode).catch((e) => {
        console.warn('[classProblemBank] backfill creator solutions', e);
      });
      const [problems, evaluations] = await Promise.all([
        getClassProblems(classCode, '', 500),
        getClassProblemEvaluations(classCode),
      ]);

      const { synced: labelsSynced } = await syncClassProblemBankLabelsToVariantReviews(
        classCode,
        problems,
      ).catch((e) => {
        console.warn('[classProblemBank] sync labels to variantReviews', e);
        return { synced: 0 };
      });
      if (labelsSynced > 0) {
        await loadVariantReviews();
      }

      const linkedReviews = await loadVariantReviewsForClassProblemBank(
        classCode,
        problems,
        VARIANT_REVIEW_OPEN_STATUSES,
      );
      setClassProblemBankLinkedReviews(linkedReviews);

      const lookup = buildVariantReviewLookupMaps(linkedReviews);
      const { synced: syncedFromInbox } = await syncClassProblemBankAiFromVariantReviews(
        classCode,
        problems,
        lookup,
        linkedReviews,
      ).catch((e) => {
        console.warn('[classProblemBank] sync AI from variantReviews', e);
        return { synced: 0 };
      });

      const { synced: syncedTeacherReview } = await syncClassProblemBankTeacherReviewFromVariantReviews(
        classCode,
        problems,
        linkedReviews,
      ).catch((e) => {
        console.warn('[classProblemBank] sync teacher review from variantReviews', e);
        return { synced: 0 };
      });

      let displayProblems = problems;
      if (syncedFromInbox > 0 || syncedTeacherReview > 0) {
        displayProblems = await getClassProblems(classCode, '', 500);
      }

      const { synced: syncedToInbox } = await syncClassProblemBankAiToVariantReviews(
        classCode,
        displayProblems,
        linkedReviews,
      ).catch((e) => {
        console.warn('[classProblemBank] sync AI to variantReviews', e);
        return { synced: 0 };
      });
      if (syncedToInbox > 0) {
        await loadVariantReviews();
      }

      setClassProblemBankProblems(displayProblems);
      setClassProblemBankEvaluations(evaluations);
      setSelectedClassProblemId((prev) => {
        if (prev && displayProblems.some((p) => p.id === prev)) return prev;
        return displayProblems[0]?.id || null;
      });
    } catch (e) {
      console.error('학급 문제은행 로드 오류:', e);
      showToast('학급 문제은행 로드 오류: ' + e.message, 'error');
    }
    setClassProblemBankLoading(false);
  }, [classCode, showToast, loadVariantReviews, serverStudents]);

  const classProblemBankRefreshTimerRef = useRef(null);
  const scheduleClassProblemBankRefresh = useCallback((opts = {}) => {
    if (!classCode) return;
    if (classProblemBankRefreshTimerRef.current) {
      clearTimeout(classProblemBankRefreshTimerRef.current);
    }
    classProblemBankRefreshTimerRef.current = setTimeout(() => {
      loadClassProblemBank(opts);
    }, 400);
  }, [classCode, loadClassProblemBank]);

  const loadMakingSubmitStats = useCallback(async () => {
    if (!classCode || !showDevMakingSubmitPanel) return;
    setMakingSubmitStatsLoading(true);
    try {
      const uuids = mergedStudents.map((s) => s.uuid).filter(Boolean);
      const rows = await getClassMakingSubmitStats(uuids);
      setMakingSubmitStatsRows(rows);
    } catch (e) {
      console.error('문제 만들기 제출 현황 로드 오류:', e);
      showToast('문제 만들기 제출 현황 로드 오류: ' + e.message, 'error');
    }
    setMakingSubmitStatsLoading(false);
  }, [classCode, mergedStudents, showDevMakingSubmitPanel, showToast]);

  useEffect(() => {
    variantReviewsLoadGenRef.current += 1;
    setRosterSynced(false);
    setServerStudents([]);
    setVariantReviews([]);
    setWrongNoteReviews([]);
    setVariantReviewsLoading(false);
  }, [classCode]);

  useEffect(() => {
    if (!classCode || !rosterSynced) return;
    loadVariantReviews();
    loadWrongNoteReviews();
  }, [classCode, rosterSynced, loadVariantReviews, loadWrongNoteReviews]);

  const variantAiPendingCount = useMemo(
    () => variantReviews.filter(
      (item) => item.aiReviewStatus && item.aiReviewStatus !== 'done',
    ).length,
    [variantReviews],
  );

  // 검수함에 AI 검수 중 항목이 있으면 완료 시점에 맞춰 목록 갱신 (실시간 구독 보조, UI 깜빡임 없음)
  useEffect(() => {
    if (activeTab !== 'inbox' || !classCode || variantAiPendingCount === 0) return undefined;
    const timer = setInterval(() => {
      loadVariantReviews({ silent: true });
    }, 5000);
    return () => clearInterval(timer);
  }, [activeTab, classCode, variantAiPendingCount, loadVariantReviews]);

  const prevInboxVariantCountRef = useRef(0);

  // 검수함 건수가 늘면 학급 문제은행도 맞춰 갱신
  useEffect(() => {
    const n = variantReviews.length;
    if (n > prevInboxVariantCountRef.current && classCode) {
      scheduleClassProblemBankRefresh({ syncStudents: true });
    }
    prevInboxVariantCountRef.current = n;
  }, [variantReviews.length, classCode, scheduleClassProblemBankRefresh]);

  // 브라우저 자동재생 정책 — 첫 클릭 후 알림음 활성화
  useEffect(() => {
    const unlock = () => {
      unlockTeacherNotificationAudio();
      setReviewAlertAudioReady(true);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  useTeacherReviewAlerts({
    classCode,
    enabled: !!classCode && !classSelecting,
    onAlert: (alert) => {
      showToast(`🔔 ${alert.label}`, 'success');
      if (alert.kind === 'variant') {
        loadVariantReviews();
        scheduleClassProblemBankRefresh({ syncStudents: true });
        setInboxFilter('variant');
        setActiveTab('inbox');
      } else if (alert.kind === 'wrongNote') {
        loadWrongNoteReviews();
        setInboxFilter('wrongNote');
        setActiveTab('inbox');
      }
    },
    onAiReviewDone: (item) => {
      patchVariantReviewItem(item);
      scheduleClassProblemBankRefresh();
    },
  });

  useEffect(() => {
    if (activeTab !== 'students' || !classCode || serverStudents.length === 0) return;
    if (evaluationSubTab === 'making') loadMakingCompetency();
    else if (evaluationSubTab === 'wrongNote') loadWrongNoteCompetency();
    else if (evaluationSubTab === 'classSolve') loadClassSolveStats();
  }, [
    activeTab,
    evaluationSubTab,
    classCode,
    serverStudents.length,
    loadMakingCompetency,
    loadWrongNoteCompetency,
    loadClassSolveStats,
  ]);

  const showClassProblemBank = activeTab === 'home' && homeToolView === 'problemBank';

  const refreshClassProblemBankView = useCallback(async () => {
    await loadClassProblemBank();
    await loadVariantReviews();
    if (!classCode) return;
    try {
      const result = await reconcilePeerEvalExplorationRewardsForClass(classCode);
      if (result.applied > 0) {
        showToast(
          `동료평가 탐구점수 보정 — ${result.applied}건 · ${formatExplorationPoints(result.points, { signed: true })}`,
          'success',
        );
      }
    } catch (e) {
      console.warn('[peerEvalReconcile]', e?.code, e?.message || e);
    }
  }, [loadClassProblemBank, loadVariantReviews, classCode, showToast]);

  useEffect(() => {
    if (activeTab !== 'home') setHomeToolView(null);
  }, [activeTab]);

  useEffect(() => {
    if (!showClassProblemBank || !classCode) return;
    refreshClassProblemBankView();
  }, [showClassProblemBank, classCode, refreshClassProblemBankView]);

  // 학급 문제은행 Firestore 변경 시 목록 자동 갱신
  useEffect(() => {
    if (!classCode || activeTab !== 'home') return undefined;
    const norm = normalizeClassCode(classCode);
    const q = query(
      collection(db, 'classes', norm, 'problemBank'),
      where('status', '==', SUBMISSION_STATUS_REGISTERED),
      limit(500),
    );
    let debounceTimer = null;
    const unsub = onSnapshot(
      q,
      () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (showClassProblemBank) {
            loadClassProblemBank();
          } else {
            scheduleClassProblemBankRefresh();
          }
        }, 400);
      },
      (err) => console.warn('[classProblemBank] onSnapshot', err?.code),
    );
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unsub();
    };
  }, [classCode, activeTab, showClassProblemBank, loadClassProblemBank, scheduleClassProblemBankRefresh]);

  useEffect(() => {
    if (!showDevMakingSubmitPanel || activeTab !== 'students' || evaluationSubTab !== 'makingSubmit' || !classCode) return;
    loadMakingSubmitStats();
    const timer = setInterval(loadMakingSubmitStats, 15000);
    return () => clearInterval(timer);
  }, [
    showDevMakingSubmitPanel,
    activeTab,
    evaluationSubTab,
    classCode,
    mergedStudents.length,
    loadMakingSubmitStats,
  ]);

  useEffect(() => {
    if (activeTab === 'class') {
      setGeminiKeyInput(teacherProfile?.geminiApiKey || '');
    }
  }, [activeTab, teacherProfile?.geminiApiKey]);

  const refreshEvaluation = useCallback(() => {
    if (evaluationSubTab === 'making') loadMakingCompetency();
    else if (evaluationSubTab === 'wrongNote') loadWrongNoteCompetency();
    else if (evaluationSubTab === 'classSolve') loadClassSolveStats();
  }, [evaluationSubTab, loadMakingCompetency, loadWrongNoteCompetency, loadClassSolveStats]);

  const goInbox = useCallback((filter = 'all') => {
    setInboxFilter(filter);
    setActiveTab('inbox');
  }, []);

  const goTeacherHome = useCallback(() => {
    setActiveTab('home');
    setHomeToolView(null);
  }, []);

  // ─── Gemini API 키 저장 ───
  async function handleSaveGeminiKey(e) {
    e.preventDefault();
    setGeminiKeySaving(true);
    try {
      await updateTeacherGeminiKey(geminiKeyInput.trim());
      showToast('Gemini API 키가 저장되었습니다.');
    } catch (err) {
      showToast('저장 오류: ' + err.message, 'error');
    }
    setGeminiKeySaving(false);
  }

  const loadData = useCallback(async () => {
    if (!classCode) return;
    setLoading(true);
    try {
      if (teacherUser?.uid) {
        try {
          await syncClassRosterWithCloud(teacherUser.uid, classCode);
        } catch (e) {
          console.warn('실명 명단 클라우드 동기화:', e);
        }
      }

      // IndexedDB와 Firebase를 병렬로 불러오기
      const [students, mappingsAll, info] = await Promise.all([
        getStudentsByClass(classCode).catch((e) => { console.warn('Firebase 오류:', e); return []; }),
        getAllMappings().catch((e) => { console.warn('IndexedDB 오류:', e); return []; }),
        getClassInfo(classCode).catch(() => null),
      ]);
      const want = normalizeClassCode(classCode);
      const localRelevant = (mappingsAll || []).filter(
        (m) => normalizeClassCode(m?.classCode) === want
      );

      let studentsNext = students;
      let needsRefresh = false;
      try {
        const bfNum = await backfillStudentNumbersFromMappings(classCode, students, localRelevant);
        if (bfNum.updated > 0) needsRefresh = true;
        const bfName = await backfillStudentDisplayNamesFromMappings(classCode, students, localRelevant);
        if (bfName.updated > 0) needsRefresh = true;
        if (needsRefresh) {
          studentsNext = await getStudentsByClass(classCode).catch(() => students);
        }
      } catch (e) {
        console.warn('학생 서버 백필:', e);
      }

      setLocalMappings(localRelevant);
      setAllLocalMappings(mappingsAll || []);
      setServerStudents(studentsNext);
      if (info) setClassInfo(info);
      setRosterSynced(true);
    } catch (err) {
      console.error('loadData 오류:', err);
      showToast('데이터 로드 오류: ' + err.message, 'error');
      setRosterSynced(true);
    }
    setLoading(false);
  }, [classCode, showToast, teacherUser?.uid]);

  // ─── 로컬 실명(IndexedDB) 빠른 등록: [이름 없음] / 로컬 없음 행에 인라인 입력 ───
  const [inlineNameDrafts, setInlineNameDrafts] = useState({});
  const [inlineNameSavingUuid, setInlineNameSavingUuid] = useState('');

  const saveInlineRealName = useCallback(async (studentRow) => {
    if (!studentRow?.uuid || !classCode) return;
    const uuid = String(studentRow.uuid).trim();
    const draft = String(inlineNameDrafts?.[uuid] ?? '').trim();
    if (!draft) {
      showToast('이름을 입력해 주세요.', 'error');
      return;
    }
    try {
      setInlineNameSavingUuid(uuid);
      await saveStudentMappingWithCloud(teacherUser?.uid, {
        uuid,
        classCode,
        realName: draft,
        studentNumber: studentRow.studentNumber ?? null,
        pinHash: studentRow.pinHash,
      });
      await updateStudentDisplayName(uuid, draft);
      setInlineNameDrafts((prev) => ({ ...prev, [uuid]: '' }));
      await loadData();
      showToast('로컬 실명이 저장되었습니다.');
    } catch (err) {
      showToast('저장 오류: ' + (err?.message || 'unknown'), 'error');
    } finally {
      setInlineNameSavingUuid('');
    }
  }, [classCode, inlineNameDrafts, loadData, showToast, teacherUser?.uid]);

  const missingLocalStudents = useMemo(() => {
    return (mergedStudents || []).filter((s) => !s?.hasLocalData || s?.displayName === '[이름 없음]');
  }, [mergedStudents]);

  useEffect(() => {
    if (!teacherUser?.uid) {
      setClassSelecting(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setClassSelecting(true);
      try {
        if (teacherUser.email) {
          await syncTeacherEmailOnTeacherClasses(teacherUser.uid, teacherUser.email);
        }
        const list = await getClassesByTeacher(teacherUser.uid, teacherUser.email);
        if (cancelled) return;
        const savedNorm = normalizeClassCode(localStorage.getItem('teacher_class_code'));
        const matchSaved =
          savedNorm && list.some((c) => canonicalClassDocCode(c) === savedNorm)
            ? savedNorm
            : '';

        let chosenNorm = matchSaved;

        if (!chosenNorm && savedNorm) {
          const allowedStale = await canTeacherAccessClass(
            savedNorm,
            teacherUser.uid,
            teacherUser.email,
          ).catch(() => false);
          if (allowedStale) chosenNorm = savedNorm;
        }

        if (!chosenNorm && list.length) {
          chosenNorm = canonicalClassDocCode(list[0]);
        }
        if (chosenNorm) {
          localStorage.setItem('teacher_class_code', chosenNorm);
          setClassCode(chosenNorm);
        } else {
          localStorage.removeItem('teacher_class_code');
          setClassCode(null);
        }
      } catch {
        if (!cancelled) {
          localStorage.removeItem('teacher_class_code');
          setClassCode(null);
        }
      } finally {
        if (!cancelled) setClassSelecting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [teacherUser?.uid, teacherUser?.email]);

  useEffect(() => {
    if (!classCode || !teacherUser?.uid) return;
    let cancelled = false;
    (async () => {
      try {
        if (teacherUser.email) {
          await syncTeacherEmailOnTeacherClasses(teacherUser.uid, teacherUser.email);
        }
        const list = await getClassesByTeacher(teacherUser.uid, teacherUser.email);
        const want = normalizeClassCode(classCode);
        const inList = list.some((c) => canonicalClassDocCode(c) === want);
        const allowed = inList || (await canTeacherAccessClass(classCode, teacherUser.uid, teacherUser.email));
        if (cancelled) return;
        if (!allowed) {
          localStorage.removeItem('teacher_class_code');
          setClassCode(null);
          return;
        }
        localStorage.setItem('teacher_class_code', normalizeClassCode(classCode));
        await loadData();
      } catch {
        if (!cancelled) {
          localStorage.removeItem('teacher_class_code');
          setClassCode(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [classCode, teacherUser?.uid, teacherUser?.email, loadData]);

  useEffect(() => {
    setSelectedStudentUuids([]);
  }, [classCode]);

  useEffect(() => {
    const el = selectAllCheckboxRef.current;
    if (!el) return;
    const n = mergedStudents.length;
    const sel = selectedStudentUuids.length;
    el.indeterminate = n > 0 && sel > 0 && sel < n;
  }, [mergedStudents.length, selectedStudentUuids.length]);

  useEffect(() => {
    const valid = new Set(mergedStudents.map((s) => s.uuid));
    setSelectedStudentUuids((prev) => prev.filter((u) => valid.has(u)));
  }, [mergedStudents]);

  function toggleStudentSelected(uuid) {
    setSelectedStudentUuids((prev) => (
      prev.includes(uuid) ? prev.filter((u) => u !== uuid) : [...prev, uuid]
    ));
  }

  const totalSolved  = mergedStudents.reduce((s, st) => s + (st.totalSolved  || 0), 0);
  const totalCorrect = mergedStudents.reduce((s, st) => s + (st.totalCorrect || 0), 0);

  // ─── 로그인 비밀번호 초기화 ───
  async function handleResetPIN(e) {
    e.preventDefault();
    if (newPin.length !== 4) { showToast('비밀번호는 4자리 숫자여야 합니다.', 'error'); return; }
    if (newPin !== newPin2)  { showToast('비밀번호가 일치하지 않습니다.', 'error'); return; }
    setPinResetting(true);
    try {
      const pinHash = await hashPIN(newPin, classCode);
      if (showPinModal.kind === 'bulk') {
        const { uuids } = showPinModal;
        for (const uuid of uuids) {
          await resetStudentPIN(uuid, pinHash);
          await updateMappingPIN(uuid, pinHash);
        }
        showToast(`${uuids.length}명의 비밀번호가 초기화되었습니다.`);
        const uSet = new Set(uuids);
        setSelectedStudentUuids((prev) => prev.filter((u) => !uSet.has(u)));
      } else {
        await resetStudentPIN(showPinModal.uuid, pinHash);
        await updateMappingPIN(showPinModal.uuid, pinHash);
        showToast(`${showPinModal.displayName} 학생의 비밀번호가 초기화되었습니다.`);
      }
      setShowPinModal(null); setNewPin(''); setNewPin2('');
    } catch (err) {
      showToast('비밀번호 초기화 오류: ' + err.message, 'error');
    }
    setPinResetting(false);
  }

  // ─── 학생 삭제 ───
  async function handleDeleteStudent(s) {
    if (!window.confirm(`${s.displayName} 학생을 삭제하시겠습니까?`)) return;
    try {
      await deleteStudent(s.uuid);
      await deleteMappingByUUID(s.uuid);
      setSelectedStudentUuids((prev) => prev.filter((u) => u !== s.uuid));
      await loadData();
      showToast(`${s.displayName} 학생이 삭제되었습니다.`);
    } catch (err) {
      showToast('삭제 오류: ' + err.message, 'error');
    }
  }

  async function handleDeleteSelected() {
    const list = mergedStudents.filter((s) => selectedStudentUuids.includes(s.uuid));
    const n = list.length;
    if (!n) return;
    const preview = list.slice(0, 5).map((s) => s.displayName).join(', ');
    const suffix = list.length > 5 ? ` 외 ${list.length - 5}명` : '';
    if (!window.confirm(
      `${list.length}명의 학생을 삭제하시겠습니까?\n(${preview}${suffix})\n삭제 후에는 되돌릴 수 없습니다.`
    )) return;
    try {
      for (const s of list) {
        await deleteStudent(s.uuid);
        await deleteMappingByUUID(s.uuid);
      }
      setSelectedStudentUuids([]);
      await loadData();
      showToast(`${n}명의 학생이 삭제되었습니다.`);
    } catch (err) {
      showToast('삭제 오류: ' + err.message, 'error');
    }
  }

  // ─── AES-256 내보내기 ───
  async function handleExport(e) {
    e.preventDefault();
    if (exportPw !== exportPw2) { showToast('비밀번호가 일치하지 않습니다.', 'error'); return; }
    if (exportPw.length < 8)   { showToast('비밀번호는 8자 이상 입력해 주세요.', 'error'); return; }
    setExporting(true);
    try {
      const rawData   = await exportAllData();
      const encrypted = await aesEncrypt(JSON.stringify(rawData), exportPw);
      const blob = new Blob([JSON.stringify({ encrypted, format: 'AES-256-GCM-v1' })],
        { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `class_${classCode}_${new Date().toISOString().slice(0, 10)}.enc.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setShowExportModal(false); setExportPw(''); setExportPw2('');
      showToast('AES-256-GCM 암호화 백업 파일을 저장했습니다.');
    } catch (err) {
      showToast('내보내기 오류: ' + err.message, 'error');
    }
    setExporting(false);
  }

  // ─── AES-256 가져오기 ───
  async function handleImport(e) {
    e.preventDefault();
    if (!importFile) return;
    setImporting(true);
    try {
      const text       = await importFile.text();
      const { encrypted } = JSON.parse(text);
      const plaintext  = await aesDecrypt(encrypted, importPw);
      const result     = await importAllData(JSON.parse(plaintext));
      setShowImportModal(false); setImportPw(''); setImportFile(null);
      await loadData();
      if (teacherUser?.uid && classCode) {
        await pushClassRosterToCloud(teacherUser.uid, classCode).catch(() => {});
      }
      showToast(`복구 완료! ${result.imported}명 불러왔습니다.`);
    } catch (err) {
      showToast('가져오기 오류: ' + err.message, 'error');
    }
    setImporting(false);
  }

  // ─── 학급 전체 삭제 ───
  async function handlePurge(e) {
    e.preventDefault();
    if (purgeConfirm !== classCode) { showToast('학급 코드를 정확히 입력해 주세요.', 'error'); return; }
    setPurging(true);
    try {
      await purgeClassData(classCode);
      await deleteMappingsByClass(classCode);
      await deleteClassInfo(classCode);
      localStorage.removeItem('teacher_class_code');
      setShowPurgeModal(false); setClassCode(null);
      showToast('학급 데이터가 영구적으로 삭제되었습니다.');
    } catch (err) {
      showToast('초기화 오류: ' + err.message, 'error');
    }
    setPurging(false);
  }

  function isDisallowedForNewCode(code) {
    const s = String(code || '').trim().toUpperCase();
    return !s || s.includes('U') || s.includes('S') || s.includes('2');
  }

  async function handleMigrateClassCode(e) {
    e.preventDefault();
    if (migrating) return;
    const from = String(classCode || '').trim().toUpperCase();
    const to = String(migrateToCode || '').trim().toUpperCase();
    setMigrateSummary(null);
    if (!from) { showToast('기존 학급코드가 없습니다.', 'error'); return; }
    if (isDisallowedForNewCode(to)) {
      showToast('새 학급코드에는 U/S/2를 사용할 수 없습니다.', 'error');
      return;
    }
    if (from === to) { showToast('새 학급코드는 기존과 달라야 합니다.', 'error'); return; }

    setMigrating(true);
    try {
      const res = await migrateClassCode(from, to, {
        teacherUID: teacherUser?.uid,
        teacherEmail: teacherUser?.email,
        dryRun: false,
      });

      const localRes = await migrateLocalClassCode(from, to).catch((err) => {
        console.warn('[migrateLocalClassCode] failed', err);
        return null;
      });

      localStorage.setItem('teacher_class_code', to);
      setClassCode(to);
      setShowMigrateModal(false);
      setMigrateToCode('');

      setMigrateSummary({ res, localRes });
      showToast(`학급코드 이관 완료: ${from} → ${to}`);
    } catch (err) {
      showToast('이관 오류: ' + (err?.message || 'unknown'), 'error');
    } finally {
      setMigrating(false);
    }
  }

  async function handleRerunClassProblemAiReviews() {
    if (!classCode || classAiRerunLoading) return;
    setClassAiRerunLoading(true);
    try {
      const inboxReviews = [...variantReviews, ...classProblemBankLinkedReviews];
      const vrRes = await rerunVariantReviewsAiReviews(classCode, inboxReviews, {
        maxItems: 200,
        onlyNotDone: true,
      });
      const bankRes = await rerunClassProblemAiReviews(classCode, { maxItems: 200, onlyNotDone: true });
      await loadClassProblemBank();
      await loadVariantReviews();
      const queued = vrRes.queued + bankRes.queued;
      showToast(
        `AI 재검수 완료: 검수함 ${vrRes.queued}건 · 학급은행 ${bankRes.queued}건 (스캔 ${vrRes.scanned + bankRes.scanned}건).`,
        queued > 0 ? 'success' : 'warn',
      );
    } catch (err) {
      showToast('AI 재검수 오류: ' + (err?.message || 'unknown'), 'error');
    } finally {
      setClassAiRerunLoading(false);
    }
  }

  async function handleBackfillVariantReviews() {
    if (!classCode || variantBackfillLoading) return;
    setVariantBackfillLoading(true);
    try {
      const res = await backfillMissingVariantReviewsForClass(classCode, { maxItems: 500 });
      let aiMsg = '';
      if (res.created > 0) {
        const inboxReviews = await getVariantReviewsByClass(classCode, VARIANT_REVIEW_OPEN_STATUSES);
        const vrRes = await rerunVariantReviewsAiReviews(classCode, inboxReviews, {
          maxItems: 200,
          onlyNotDone: true,
        });
        const bankRes = await rerunClassProblemAiReviews(classCode, { maxItems: 200, onlyNotDone: true });
        aiMsg = ` · AI 재검수 검수함 ${vrRes.queued}건 · 학급은행 ${bankRes.queued}건`;
      }
      showToast(
        `검수 문서 백필: ${res.created}건 생성 (스캔 ${res.scanned}건, 기존 ${res.skipped}건, 오류 ${res.errors}건)${aiMsg}`,
        res.errors > 0 ? 'warn' : 'success',
      );
      await loadVariantReviews();
      setVariantDiag(null);
    } catch (err) {
      showToast('검수 문서 백필 오류: ' + (err?.message || 'unknown'), 'error');
    } finally {
      setVariantBackfillLoading(false);
    }
  }

  // 학급 확정 전: 깜박임 방지 로딩
  if (teacherUser?.uid && classSelecting) {
    return (
      <div className="dashboard-container dashboard-container--brand-bg">
        <div className="loading-box" style={{ minHeight: 320 }}>
          <div className="spinner-large" />
          <p>학급 정보를 불러오는 중…</p>
        </div>
      </div>
    );
  }

  // 학급 없음 — 새로 만들거나 목록에서 선택
  if (!classCode) {
    return (
      <ClassSetup
        teacherUID={teacherUser?.uid}
        teacherEmail={teacherUser?.email}
        onClassReady={(code) => setClassCode(normalizeClassCode(code))}
      />
    );
  }

  return (
    <div
      className={`dashboard-container dashboard-container--brand-bg${
        activeTab === 'home' && homeToolView === 'problemBank' ? ' dashboard-container--tcpb' : ''
      }`}
    >
      {/* 헤더 */}
      <header className="dashboard-header">
        <div className="header-left">
          <BrandHomeButton onClick={goTeacherHome} />
          <div>
            <h1 className="header-title">교사 대시보드</h1>
            <p className="header-subtitle">
              {classInfo?.className || classCode}
              <span style={{ marginLeft: 8, fontFamily: 'monospace', background: '#f1f5f9',
                padding: '2px 8px', borderRadius: 6, fontSize: 13, color: '#4f46e5' }}>
                학급코드: {classCode}
              </span>
              <button
                type="button"
                className="btn btn-outline btn-xs"
                style={{ marginLeft: 8, fontSize: 12, padding: '2px 8px' }}
                onClick={() => { setShowMigrateModal(true); setMigrateSummary(null); }}
                title="기존 학급 데이터를 새 코드로 이관"
              >
                학급코드 이관
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                style={{ marginLeft: 8, fontSize: 12, padding: '2px 8px' }}
                onClick={() => setDebugEnvOpen((v) => !v)}
                title="Firebase 연결 상태(디버그)"
              >
                {debugEnvOpen ? '디버그 닫기' : '디버그 보기'}
              </button>
            </p>
            {debugEnvOpen && (
              <div style={{
                marginTop: 8,
                fontSize: 12,
                color: '#475569',
                background: '#f8fafc',
                border: '1px solid #e2e8f0',
                borderRadius: 10,
                padding: '8px 10px',
                maxWidth: 720,
              }}>
                <div style={{ fontFamily: 'monospace' }}>
                  <div>firebase.projectId(env): {process.env.REACT_APP_FIREBASE_PROJECT_ID || '(없음)'}</div>
                  <div>firebase.projectId(app): {app?.options?.projectId || '(없음)'}</div>
                  <div>auth.uid: {teacherUser?.uid || '(미로그인)'}</div>
                  <div>auth.email: {teacherUser?.email || '(없음)'}</div>
                  <div>classCode(state): {classCode || '(없음)'}</div>
                </div>
                <div style={{ marginTop: 6, color: '#64748b', lineHeight: 1.5 }}>
                  위의 projectId가 Vercel/localhost에서 다르면 서로 다른 Firebase를 보고 있는 상태입니다.
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge teacher-badge">교사</span>
          <span className="user-name" style={{ fontSize: 13 }}>{teacherUser?.email}</span>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => {
              localStorage.removeItem('teacher_class_code');
              setClassCode(null);
              setClassInfo(null);
              setLocalMappings([]);
              setRosterSynced(false);
              setActiveTab('home');
            }}
            title="학급 선택 화면으로 돌아가기"
          >
            학급 변경
          </button>
          <button className="btn btn-outline btn-sm"
            onClick={() => { teacherLogout(); navigate('/'); }}>
            로그아웃
          </button>
        </div>
      </header>

      <main
        className={`dashboard-main${
          activeTab === 'home' && homeToolView === 'problemBank' ? ' td-main--problem-bank' : ''
        }`}
      >
        {toast && (
          <div className={`alert ${toast.type === 'error' ? 'alert-error' : 'alert-success'}`}>
            {toast.type === 'error' ? '⚠️' : '✅'} {toast.msg}
          </div>
        )}

        {migrateSummary && (
          <div className="info-banner" style={{ marginBottom: 12 }}>
            <span className="info-banner-icon">🔁</span>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <strong>학급코드 이관 요약</strong><br />
              Firestore: students {migrateSummary?.res?.updated?.students ?? 0}명 ·
              problemBank {migrateSummary?.res?.copied?.problemBank ?? 0}건 ·
              variantReviews {migrateSummary?.res?.updated?.variantReviews ?? 0}건<br />
              로컬(교사 기기): 매핑 {migrateSummary?.localRes?.migratedMappings ?? 0}건
            </div>
          </div>
        )}

        {showMigrateModal && (
          <div className="modal-overlay" onClick={() => !migrating && setShowMigrateModal(false)}>
            <div className="modal" style={{ maxWidth: 520 }} onClick={(ev) => ev.stopPropagation()}>
              <div className="modal-header">
                <h3>학급코드 이관</h3>
                <button className="modal-close" onClick={() => !migrating && setShowMigrateModal(false)}>×</button>
              </div>
              <div className="modal-body">
                <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.6 }}>
                  기존 학급코드 <strong style={{ fontFamily: 'monospace' }}>{classCode}</strong>의 데이터를
                  새 학급코드로 복사하고, 학생/검수 데이터의 <code>classCode</code> 참조도 함께 갱신합니다.
                  <br />
                  새 코드에는 <strong>U / S / 2</strong>를 사용할 수 없습니다.
                </div>
                <form onSubmit={handleMigrateClassCode} style={{ marginTop: 14 }}>
                  <div className="form-group">
                    <label className="form-label">새 학급 코드</label>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="예: PVT3R9"
                      value={migrateToCode}
                      onChange={(e) => setMigrateToCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
                      style={{ fontFamily: 'monospace', letterSpacing: 2, textTransform: 'uppercase' }}
                      required
                      disabled={migrating}
                    />
                    {migrateToCode && isDisallowedForNewCode(migrateToCode) && (
                      <p style={{ marginTop: 6, fontSize: 12, color: '#dc2626' }}>
                        ⚠️ 새 학급코드에는 U/S/2를 넣을 수 없습니다.
                      </p>
                    )}
                  </div>
                  <button type="submit" className="btn btn-primary" style={{ width: '100%' }}
                    disabled={migrating || !migrateToCode || isDisallowedForNewCode(migrateToCode)}>
                    {migrating ? <><span className="spinner" /> 이관 중...</> : '이관 실행'}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        {classCode && !reviewAlertAudioReady && (
          <p className="section-desc" style={{ margin: '0 0 12px', color: '#6b7280', fontSize: 13 }}>
            🔔 학생 제출 알림음을 쓰려면 화면을 한 번 클릭해 주세요.
          </p>
        )}

        {/* ── 탭 네비게이션 ── */}
        <div className="td-main-tabs">
          {[
            { id: 'home', label: '🏠 홈' },
            {
              id: 'inbox',
              label: `📥 검수함${variantReviews.length + wrongNoteReviews.length > 0 ? ` (${variantReviews.length + wrongNoteReviews.length})` : ''}`,
            },
            { id: 'students', label: '👨‍🎓 학생' },
            { id: 'class', label: '🏫 학급' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`td-main-tabs__btn${activeTab === tab.id ? ' td-main-tabs__btn--active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'home' && homeToolView !== 'problemBank' && (
          <TeacherHomePanel
            mergedStudents={mergedStudents}
            totalSolved={totalSolved}
            totalCorrect={totalCorrect}
            variantReviewCount={variantReviews.length}
            wrongNoteReviewCount={wrongNoteReviews.length}
            onGoInbox={goInbox}
            onGoInboxFilter={(filter) => goInbox(filter)}
            onGoStudents={() => setActiveTab('students')}
            onGoProblemBank={() => setHomeToolView('problemBank')}
            navigate={navigate}
            onShowExamResultModal={() => setShowExamResultModal(true)}
          />
        )}

        {showClassProblemBank && (
          <>
            <div className="td-home-tool-back">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setHomeToolView(null)}
              >
                ← 홈
              </button>
            </div>
            <TeacherClassProblemBankPanel
              problems={classProblemBankProblems}
              evaluations={classProblemBankEvaluations}
              loading={classProblemBankLoading}
              mergedStudents={mergedStudents}
              localMappings={localMappings}
              selectedProblemId={selectedClassProblemId}
              onSelectProblem={setSelectedClassProblemId}
              onRefresh={refreshClassProblemBankView}
              classCode={classCode}
              inboxVariantReviews={variantReviews}
              variantReviewsForBank={allVariantReviewsForBank}
            />
          </>
        )}

        {activeTab === 'inbox' && (
          <TeacherReviewInboxPanel
            filter={inboxFilter}
            onFilterChange={setInboxFilter}
            variantReviews={variantReviews}
            variantReviewsSorted={variantReviewsSorted}
            wrongNoteReviews={wrongNoteReviews}
            wrongNoteReviewsSorted={wrongNoteReviewsSorted}
            variantReviewsLoading={variantReviewsLoading}
            wrongNoteReviewsLoading={wrongNoteReviewsLoading}
            mergedStudents={mergedStudents}
            localMappings={localMappings}
            allLocalMappings={allLocalMappings}
            resolvingVariantId={resolvingId}
            resolvingWrongNoteId={resolvingWrongNoteId}
            getReviewFeedbackDraft={getReviewFeedbackDraft}
            onReviewFeedbackToggleCheck={handleReviewFeedbackToggleCheck}
            onReviewFeedbackNoteChange={handleReviewFeedbackNoteChange}
            onSendVariantFeedback={handleSendVariantFeedback}
            onSendWrongNoteFeedback={handleSendWrongNoteFeedback}
            onRefreshVariants={loadVariantReviews}
            onRefreshWrongNotes={loadWrongNoteReviews}
            variantDiag={variantDiag}
            onRunVariantDiagnostics={() => { setVariantDiag(null); void runVariantReviewDiagnostics(); }}
            onBackfillVariantReviews={() => void handleBackfillVariantReviews()}
            variantBackfillLoading={variantBackfillLoading}
            onRerunClassProblemAiReviews={() => void handleRerunClassProblemAiReviews()}
            classAiRerunLoading={classAiRerunLoading}
            migrationState={migrationState}
            onMigrateVariantClassCode={() => void migrateVariantReviewsClassCode()}
            legacyPendingMigrationState={legacyPendingMigrationState}
            onMigrateLegacyPendingStatuses={() => void migrateLegacyPendingStatuses()}
            serverStudents={serverStudents}
            classCode={classCode}
            showDevPurge={showDevReviewInboxPurge}
            purgingVariantId={purgingVariantId}
            purgingWrongNoteId={purgingWrongNoteId}
            onPurgeVariant={handlePurgeVariant}
            onPurgeWrongNote={handlePurgeWrongNote}
          />
        )}

        {activeTab === 'students' && (
          <TeacherStudentsPanel
            teacherEmail={teacherUser?.email}
            classCode={classCode}
            mergedStudents={mergedStudents}
            loading={loading}
            evaluationSubTab={evaluationSubTab}
            onEvaluationSubTabChange={setEvaluationSubTab}
            competencyRowsSorted={competencyRowsSorted}
            wrongNoteCompetencyRowsSorted={wrongNoteCompetencyRowsSorted}
            classSolveStatsSorted={classSolveStatsSorted}
            competencyLoading={competencyLoading}
            wrongNoteCompetencyLoading={wrongNoteCompetencyLoading}
            classSolveStatsLoading={classSolveStatsLoading}
            onRefreshEvaluation={refreshEvaluation}
            selectedStudentUuid={selectedStudentUuid}
            onSelectStudent={(uuid) => {
              setSelectedStudentUuid(uuid);
              if (uuid) setStudentDetailTab('summary');
            }}
            studentDetailTab={studentDetailTab}
            onStudentDetailTabChange={setStudentDetailTab}
            variantReviews={variantReviews}
            wrongNoteReviews={wrongNoteReviews}
            competencyByUuid={competencyByUuid}
            wrongNoteCompetencyByUuid={wrongNoteCompetencyByUuid}
            classSolveStatsByUuid={classSolveStatsByUuid}
            onGoInbox={() => goInbox('all')}
            onShowAddModal={() => setShowAddModal(true)}
            onRefreshList={loadData}
            selectedStudentUuids={selectedStudentUuids}
            selectAllCheckboxRef={selectAllCheckboxRef}
            onSelectAll={(e) => {
              if (e.target.checked) {
                setSelectedStudentUuids(mergedStudents.map((st) => st.uuid));
              } else {
                setSelectedStudentUuids([]);
              }
            }}
            onToggleStudent={toggleStudentSelected}
            onDeleteSelected={handleDeleteSelected}
            onBulkPinReset={() => setShowPinModal({ kind: 'bulk', uuids: [...selectedStudentUuids] })}
            onDeleteStudent={handleDeleteStudent}
            onShowPinModal={(s) => setShowPinModal({ kind: 'single', uuid: s.uuid, displayName: s.displayName })}
            onShowBulkLinkModal={() => setShowBulkLinkModal(true)}
            missingLocalStudents={missingLocalStudents}
            inlineNameDrafts={inlineNameDrafts}
            inlineNameSavingUuid={inlineNameSavingUuid}
            onInlineNameDraftChange={(uuid, v) => setInlineNameDrafts((prev) => ({ ...prev, [uuid]: v }))}
            onSaveInlineRealName={saveInlineRealName}
            showDevMakingSubmitPanel={showDevMakingSubmitPanel}
            makingSubmitStatsByUuid={makingSubmitStatsByUuid}
            makingSubmitStatsLoading={makingSubmitStatsLoading}
            onRefreshMakingSubmitStats={loadMakingSubmitStats}
          />
        )}

        {activeTab === 'class' && (
          <TeacherClassPanel
            onShowExportModal={() => setShowExportModal(true)}
            onShowImportModal={() => setShowImportModal(true)}
            onShowPurgeModal={() => setShowPurgeModal(true)}
            geminiKeyInput={geminiKeyInput}
            geminiKeyRevealed={geminiKeyRevealed}
            geminiKeySaving={geminiKeySaving}
            teacherProfile={teacherProfile}
            onGeminiKeyInputChange={setGeminiKeyInput}
            onToggleGeminiKeyReveal={() => setGeminiKeyRevealed((v) => !v)}
            onSaveGeminiKey={handleSaveGeminiKey}
            onClearGeminiKey={() => setGeminiKeyInput('')}
          />
        )}


      </main>

      {/* ── 채점 결과 공개 모달 ── */}
      {showExamResultModal && (
        <TeacherExamResultModal
          classCode={classCode}
          serverStudents={serverStudents}
          showToast={showToast}
          onStudentsRefresh={async () => {
            const students = await getStudentsByClass(classCode).catch(() => []);
            setServerStudents(students);
          }}
          onClose={() => setShowExamResultModal(false)}
        />
      )}

      {/* ── 일괄 추가 모달 ── */}
      {showAddModal && (
        <BulkAddModal
          classCode={classCode}
          teacherUid={teacherUser?.uid}
          startStudentNumber={computeNextStudentNumber(mergedStudents)}
          onClose={() => setShowAddModal(false)}
          onDone={async (count) => {
            setShowAddModal(false);
            await loadData();
            showToast(`${count}명의 학생이 등록되었습니다.`);
          }}
        />
      )}

      {/* ── 로컬 이름 일괄 연결 모달 ── */}
      {showBulkLinkModal && (
        <BulkLinkLocalNamesModal
          classCode={classCode}
          teacherUid={teacherUser?.uid}
          targets={missingLocalStudents}
          onClose={() => setShowBulkLinkModal(false)}
          onDone={async (count) => {
            setShowBulkLinkModal(false);
            await loadData();
            showToast(`로컬 이름 ${count}명 저장 완료`);
          }}
        />
      )}

      {/* ── 비밀번호 초기화 모달 ── */}
      {showPinModal && (
        <div className="modal-overlay" onClick={() => setShowPinModal(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                🔑 비밀번호 초기화
                {' — '}
                {showPinModal.kind === 'bulk'
                  ? `선택 ${showPinModal.uuids.length}명`
                  : showPinModal.displayName}
              </h3>
              <button type="button" className="modal-close" onClick={() => setShowPinModal(null)}>×</button>
            </div>
            <form onSubmit={handleResetPIN} className="modal-body">
              {showPinModal.kind === 'bulk' && (
                <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
                  선택한 학생 모두에게 동일한 새 비밀번호(4자리 숫자)가 적용됩니다.
                </p>
              )}
              <div className="form-row" style={{ gap: 12 }}>
                <div className="form-group">
                  <label className="form-label">새 비밀번호 (4자리 숫자)</label>
                  <input type="password" inputMode="numeric" className="form-input"
                    placeholder="••••" value={newPin} maxLength={4}
                    onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    required style={{ letterSpacing: 8, fontSize: 20, textAlign: 'center' }} />
                </div>
                <div className="form-group">
                  <label className="form-label">확인</label>
                  <input type="password" inputMode="numeric" className="form-input"
                    placeholder="••••" value={newPin2} maxLength={4}
                    onChange={(e) => setNewPin2(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    required style={{ letterSpacing: 8, fontSize: 20, textAlign: 'center' }} />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setShowPinModal(null)}>취소</button>
                <button type="submit" className="btn btn-primary" disabled={pinResetting}>
                  {pinResetting ? <><span className="spinner" /> 처리 중...</> : '비밀번호 적용'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── 내보내기 모달 ── */}
      {showExportModal && (
        <div className="modal-overlay" onClick={() => setShowExportModal(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>⬇️ 매핑 테이블 내보내기</h3>
              <button className="modal-close" onClick={() => setShowExportModal(false)}>×</button>
            </div>
            <form onSubmit={handleExport} className="modal-body">
              <div className="alert" style={{ background: '#fffbeb', border: '1px solid #fde68a',
                color: '#92400e', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>
                ⚠️ 이 파일에는 학생 실명이 포함됩니다. AES-256-GCM으로 암호화됩니다.
              </div>
              <div className="form-group">
                <label className="form-label">암호화 비밀번호 (8자 이상)</label>
                <input type="password" className="form-input" placeholder="강력한 비밀번호"
                  value={exportPw} onChange={(e) => setExportPw(e.target.value)}
                  required minLength={8} />
              </div>
              <div className="form-group">
                <label className="form-label">비밀번호 확인</label>
                <input type="password" className="form-input" placeholder="다시 입력"
                  value={exportPw2} onChange={(e) => setExportPw2(e.target.value)} required />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setShowExportModal(false)}>취소</button>
                <button type="submit" className="btn btn-primary" disabled={exporting}>
                  {exporting ? <><span className="spinner" /> 암호화 중...</> : '암호화 내보내기'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── 가져오기 모달 ── */}
      {showImportModal && (
        <div className="modal-overlay" onClick={() => setShowImportModal(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>⬆️ 매핑 테이블 가져오기</h3>
              <button className="modal-close" onClick={() => setShowImportModal(false)}>×</button>
            </div>
            <form onSubmit={handleImport} className="modal-body">
              <div className="form-group">
                <label className="form-label">백업 파일 선택 (.enc.json)</label>
                <input ref={importFileRef} type="file" accept=".json" className="form-input"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)} required />
              </div>
              <div className="form-group">
                <label className="form-label">복호화 비밀번호</label>
                <input type="password" className="form-input"
                  placeholder="내보낼 때 사용한 비밀번호"
                  value={importPw} onChange={(e) => setImportPw(e.target.value)} required />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setShowImportModal(false)}>취소</button>
                <button type="submit" className="btn btn-primary" disabled={importing || !importFile}>
                  {importing ? <><span className="spinner" /> 복호화 중...</> : '가져오기'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── 학급 전체 삭제 모달 ── */}
      {showPurgeModal && (
        <div className="modal-overlay" onClick={() => setShowPurgeModal(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 style={{ color: '#dc2626' }}>🗑️ 학급 데이터 전체 삭제</h3>
              <button className="modal-close" onClick={() => setShowPurgeModal(false)}>×</button>
            </div>
            <form onSubmit={handlePurge} className="modal-body">
              <div className="alert alert-error" style={{ marginBottom: 16 }}>
                ⚠️ <strong>복구 불가능한 영구 삭제</strong><br />
                Firebase의 모든 학습 데이터와 IndexedDB의 실명 매핑이 삭제됩니다.
              </div>
              <div className="form-group">
                <label className="form-label">
                  확인: 학급 코드 입력 <strong>{classCode}</strong>
                </label>
                <input type="text" className="form-input" placeholder={classCode}
                  value={purgeConfirm}
                  onChange={(e) => setPurgeConfirm(e.target.value.toUpperCase())} required />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setShowPurgeModal(false)}>취소</button>
                <button type="submit" className="btn btn-danger"
                  disabled={purging || purgeConfirm !== classCode}>
                  {purging ? <><span className="spinner" /> 삭제 중...</> : '영구 삭제'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
