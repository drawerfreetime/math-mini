/**
 * 문항 확인 — 스테퍼 + 번호 미니 네비, 좌 크롭 / 우 분류·이미지
 */
import React, { useEffect, useMemo, useState } from 'react';
import { problemDisplayLabel } from '../utils/pdfRegionOcrPipeline';

const STRUCTURE_TYPE_OPTIONS = ['표', '선잇기', '세로셈', '빈칸채우기', '기타'];

const STRUCTURE_BADGE = {
  표: { label: '표' },
  선잇기: { label: '선잇기' },
  세로셈: { label: '세로셈' },
  빈칸채우기: { label: '빈칸' },
  기타: { label: '기타' },
};

const TYPE_SOURCE_LABEL = {
  user: '확정',
  ai: 'AI',
  heuristic: '자동',
};

function findNextUnconfirmedIndex(units, confirmedKeys, startIndex, treatAsConfirmedKey) {
  const total = units.length;
  if (!total) return null;
  const isConfirmed = (key) => confirmedKeys.has(key) || (treatAsConfirmedKey && key === treatAsConfirmedKey);
  // Search forward with wrap-around, skipping confirmed ones.
  for (let step = 1; step <= total; step++) {
    const i = (startIndex + step) % total;
    const k = units[i]?.key;
    if (!k) continue;
    if (!isConfirmed(k)) return i;
  }
  return null;
}

export default function ProblemConfirmStep({
  units,
  confirmIndex,
  onConfirmIndexChange,
  confirmedKeys,
  ocrStatusByKey,
  regions,
  previewUrlByKey,
  onSetProblemType,
  onSetHasImage,
  onDrawImage,
  onBackToSelect,
  onConfirmCurrent,
  onStartReview,
  finishingReview,
  ocrSummaryText,
}) {
  const [listOpen, setListOpen] = useState(false);
  const total = units.length;
  const current = units[confirmIndex] || units[0];
  const currentKey = current?.key;

  const imgCountFor = (parentId) =>
    regions.filter((ir) => ir.isImageRegion && ir.parentId === parentId).length;

  const confirmedCount = useMemo(
    () => units.filter((u) => confirmedKeys.has(u.key)).length,
    [units, confirmedKeys],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft' && confirmIndex > 0) {
        onConfirmIndexChange(confirmIndex - 1);
      } else if (e.key === 'ArrowRight' && confirmIndex < total - 1) {
        onConfirmIndexChange(confirmIndex + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmIndex, total, onConfirmIndexChange]);

  if (!current) {
    return (
      <div className="prs-confirm-empty">
        <p>확인할 문항이 없습니다.</p>
        <button type="button" className="btn btn-outline" onClick={onBackToSelect}>
          영역 선택으로
        </button>
      </div>
    );
  }

  const r = current.primaryRegion;
  const imgCount = imgCountFor(r.id);
  const isAiType =
    r.problemType &&
    (r.problemTypeSource === 'ai' || r.problemTypeSource === 'heuristic');
  const needImageDraw = r.hasImage && imgCount === 0;
  const previewUrl = previewUrlByKey[currentKey] || r.cropDataUrl;
  const ocrSt = ocrStatusByKey[currentKey] || 'idle';
  const isConfirmed = confirmedKeys.has(currentKey);
  const typePending = !r.problemType && r.problemTypeSource !== 'user';
  const typeSelected = !!r.problemType;
  const imageSelected = r.hasImage === true || r.hasImage === false;
  const canStartOcr = typeSelected && imageSelected;

  return (
    <div className="prs-confirm-root">
      <div className="prs-confirm-toolbar">
        <div className="prs-confirm-toolbar-main">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onBackToSelect}>
            ← 영역 수동 선택
          </button>
          <span className="prs-confirm-progress">
            {confirmedCount} / {total} 확인 · OCR {ocrSummaryText}
          </span>
        </div>
        <div className="prs-confirm-toolbar-actions">
          <button
            type="button"
            className={`btn btn-outline btn-sm ${listOpen ? 'active' : ''}`}
            onClick={() => setListOpen((v) => !v)}
          >
            {listOpen ? '스테퍼' : '목록'}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm prs-confirm-toolbar-review-btn"
            onClick={onStartReview}
            disabled={finishingReview}
          >
            {finishingReview ? (
              <>
                <span className="spinner" /> 검수 준비…
              </>
            ) : (
              '검수 시작 →'
            )}
          </button>
        </div>
      </div>

      {listOpen ? (
        <div className="prs-confirm-list-view">
          {units.map((u, i) => {
            const pr = u.primaryRegion;
            const st = ocrStatusByKey[u.key] || 'idle';
            const thumb = previewUrlByKey[u.key] || pr.cropDataUrl;
            return (
              <button
                key={u.key}
                type="button"
                className={`prs-confirm-list-card ${i === confirmIndex ? 'active' : ''} ${
                  confirmedKeys.has(u.key) ? 'confirmed' : ''
                }`}
                onClick={() => onConfirmIndexChange(i)}
              >
                <span className="prs-confirm-list-num">{problemDisplayLabel(pr.problem_number)}</span>
                {thumb && <img src={thumb} alt="" className="prs-confirm-list-thumb" />}
                <span className="prs-confirm-list-meta">
                  {pr.problemType || '유형 ?'}
                  {pr.hasImage ? ' · 이미지' : ''}
                  {st === 'loading' && ' · OCR…'}
                  {st === 'done' && ' · ✓OCR'}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="prs-confirm-body">
          <nav className="prs-confirm-mini-nav" aria-label="문항 번호">
            {units.map((u, i) => {
              const pr = u.primaryRegion;
              const st = ocrStatusByKey[u.key] || 'idle';
              let chipClass = 'prs-confirm-chip';
              if (i === confirmIndex) chipClass += ' active';
              if (confirmedKeys.has(u.key)) chipClass += ' confirmed';
              if (st === 'loading') chipClass += ' ocr-loading';
              if (st === 'error') chipClass += ' ocr-error';
              return (
                <button
                  key={u.key}
                  type="button"
                  className={chipClass}
                  title={`${problemDisplayLabel(pr.problem_number)}번`}
                  onClick={() => onConfirmIndexChange(i)}
                >
                  {problemDisplayLabel(pr.problem_number)}
                </button>
              );
            })}
          </nav>

          <div className="prs-confirm-stepper">
            <div className="prs-confirm-nav-row">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={confirmIndex <= 0}
                onClick={() => onConfirmIndexChange(confirmIndex - 1)}
              >
                ← 이전
              </button>
              <span className="prs-confirm-title">
                {problemDisplayLabel(r.problem_number)}번 ({confirmIndex + 1}/{total})
              </span>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={confirmIndex >= total - 1}
                onClick={() => onConfirmIndexChange(confirmIndex + 1)}
              >
                다음 →
              </button>
            </div>

            <div className="prs-confirm-split">
              <div className="prs-confirm-crop-pane">
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt={`${problemDisplayLabel(r.problem_number)}번 크롭`}
                    className="prs-confirm-crop-img"
                  />
                ) : (
                  <div className="prs-confirm-crop-placeholder">크롭 미리보기 준비 중…</div>
                )}
              </div>

              <div className="prs-confirm-meta-pane">
                <h3 className="prs-confirm-pane-title">문항 분류</h3>

                {typePending && (
                  <p className="prs-confirm-hint">유형 분석 중… (바꿀 수 있습니다)</p>
                )}

                <div className="prs-confirm-field">
                  <span className="prs-confirm-label">문항 유형</span>
                  {isAiType && r.problemTypeSource !== 'user' && (
                    <p className="prs-confirm-hint">
                      AI가 「{STRUCTURE_BADGE[r.problemType]?.label || r.problemType}」을 선택했습니다.
                      다르면 아래에서 고르세요.
                    </p>
                  )}
                  <div
                    className="prs-confirm-option-group"
                    role="radiogroup"
                    aria-label="문항 유형"
                  >
                    {STRUCTURE_TYPE_OPTIONS.map((type) => {
                      const badge = STRUCTURE_BADGE[type];
                      const selected = r.problemType === type;
                      return (
                        <button
                          key={type}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          data-structure-type={type}
                          className={[
                            'prs-confirm-option-btn',
                            'prs-confirm-option-btn--structure',
                            selected ? 'prs-confirm-option-btn--selected' : '',
                            selected && isAiType ? 'prs-confirm-option-btn--ai' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() => onSetProblemType(r.id, type)}
                        >
                          {badge.label}
                          {selected && isAiType && (
                            <span className="prs-confirm-option-tag">
                              {TYPE_SOURCE_LABEL[r.problemTypeSource] || 'AI'}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="prs-confirm-field">
                  <p className="prs-confirm-image-desc">
                    문항에 이미지나 도형이 있습니까?
                    <span className="prs-confirm-image-desc-note">
                      (이미지나 도형을 선택하면 해당 영역은 텍스트로 변환하지 않고 그대로 반영합니다.)
                    </span>
                  </p>
                  <div
                    className="prs-confirm-option-group prs-confirm-option-group--pair"
                    role="radiogroup"
                    aria-label="이미지 또는 도형 포함 여부"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={r.hasImage === true}
                      className={[
                        'prs-confirm-option-btn',
                        'prs-confirm-option-btn--image-yes',
                        r.hasImage === true ? 'prs-confirm-option-btn--selected' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => onSetHasImage(r.id, true)}
                    >
                      이미지(도형) 있음
                      {r.hasImage === true && imgCount > 0 ? ` · 영역 ${imgCount}개` : ''}
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={r.hasImage === false}
                      className={[
                        'prs-confirm-option-btn',
                        'prs-confirm-option-btn--image-no',
                        r.hasImage === false ? 'prs-confirm-option-btn--selected' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => onSetHasImage(r.id, false)}
                    >
                      이미지(도형) 없음
                    </button>
                  </div>
                </div>

                {needImageDraw && (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm prs-confirm-draw-img"
                    onClick={() => onDrawImage(r.id)}
                  >
                    ❗ 이미지 영역 그리기 (캔버스로 이동)
                  </button>
                )}

                {!needImageDraw && r.hasImage && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => onDrawImage(r.id)}
                  >
                    + 이미지 영역 추가
                  </button>
                )}

                <div className="prs-confirm-ocr-status">
                  {!canStartOcr && (
                    <span className="prs-confirm-ocr-idle prs-confirm-ocr-blocked">
                      {!typeSelected && !imageSelected
                        ? '문항 유형과 이미지(도형) 여부를 선택하면 OCR을 시작할 수 있습니다'
                        : !typeSelected
                          ? '문항 유형을 선택하면 OCR을 시작할 수 있습니다'
                          : '이미지(도형) 여부를 선택하면 OCR을 시작할 수 있습니다'}
                    </span>
                  )}
                  {ocrSt === 'idle' && !isConfirmed && canStartOcr && (
                    <span className="prs-confirm-ocr-idle">완료를 누르면 OCR이 시작됩니다</span>
                  )}
                  {ocrSt === 'loading' && (
                    <span className="prs-confirm-ocr-loading">
                      <span className="spinner" /> OCR 인식 중…
                    </span>
                  )}
                  {ocrSt === 'done' && (
                    <span className="prs-confirm-ocr-done">✓ OCR 완료</span>
                  )}
                  {ocrSt === 'error' && (
                    <span className="prs-confirm-ocr-error">⚠ OCR 실패 — 검수에서 수정 가능</span>
                  )}
                </div>

                <button
                  type="button"
                  className={`btn btn-primary prs-confirm-done-btn ${
                    isConfirmed ? 'prs-confirm-done-btn--done' : ''
                  }`}
                  disabled={!canStartOcr}
                  title={
                    !canStartOcr
                      ? !typeSelected && !imageSelected
                        ? '문항 유형과 이미지(도형) 여부를 먼저 선택하세요'
                        : !typeSelected
                          ? '문항 유형을 먼저 선택하세요'
                          : '이미지(도형) 여부를 먼저 선택하세요'
                      : undefined
                  }
                  onClick={() => {
                    if (!canStartOcr) return;
                    onConfirmCurrent(currentKey);
                    const next = findNextUnconfirmedIndex(units, confirmedKeys, confirmIndex, currentKey);
                    if (next != null) onConfirmIndexChange(next);
                  }}
                >
                  {isConfirmed ? '✓ 확인됨 (다시 OCR)' : '이 문항 확인 · OCR 시작'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
