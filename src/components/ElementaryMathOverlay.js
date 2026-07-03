import React, { useState } from 'react';
import './ElementaryMathOverlay.css';

const TEMPLATES = [
  { id: 'fraction',  label: '분수' },
  { id: 'mixed',     label: '대분수' },
  { id: 'longdiv',   label: '나눗셈 (세로셈)' },
  { id: 'multvert',  label: '곱셈 (세로셈)' },
  { id: 'bar',       label: '선분 기호' },
  { id: 'ladder',    label: '약수/배수' },
];

function PickIcon({ templateId }) {
  switch (templateId) {
    case 'fraction':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-frac">
            <span className="emath-pick-b">▢</span>
            <span className="emath-pick-line" />
            <span className="emath-pick-b">▢</span>
          </span>
        </span>
      );
    case 'mixed':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-mixed">
            <span className="emath-pick-b emath-pick-mixed-whole">▢</span>
            <span className="emath-pick-frac">
              <span className="emath-pick-b">▢</span>
              <span className="emath-pick-line" />
              <span className="emath-pick-b">▢</span>
            </span>
          </span>
        </span>
      );
    case 'longdiv':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-longdiv-parenico">
            <span className="emath-pick-ld-d" />
            <span className="emath-pick-ld-paren">)</span>
            <span className="emath-pick-ld-stem">
              <span className="emath-pick-ld-topline" />
              <span className="emath-pick-ld-b" />
            </span>
          </span>
        </span>
      );
    case 'bar':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-bar" />
        </span>
      );
    case 'multvert':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-multvert-ico">
            <span className="emath-pick-mv-row">□ □ □</span>
            <span className="emath-pick-mv-row">× □ □</span>
            <span className="emath-pick-mv-divline" />
            <span className="emath-pick-mv-row">□ □ □</span>
          </span>
        </span>
      );
    case 'ladder':
      return (
        <span className="emath-pick-ico" aria-hidden>
          <span className="emath-pick-ladder-ico">
            <span className="emath-pick-ladder-corners">┕</span>
            <span className="emath-pick-ladder-twocells">
              <span className="emath-pick-ladder-mcell" />
              <span className="emath-pick-ladder-mcell" />
            </span>
          </span>
        </span>
      );
    default:
      return null;
  }
}

/** @param {{ open: boolean; onClose: () => void; onConfirm: (script: string) => void; initialLatex?: string; title?: string; variant?: 'modal' | 'sidebar' }} p */
export default function ElementaryMathOverlay({
  open,
  onClose,
  title = '수식 입력',
  variant = 'modal',
}) {
  const [activeId, setActiveId] = useState('fraction');

  if (!open) return null;

  return (
    <>
      <div className="emath-overlay-editor-head">
        <span style={{ fontSize: variant === 'sidebar' ? 14 : 16, fontWeight: 700, color: '#1e293b' }}>{title}</span>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button type="button" className="emath-btn-ghost" onClick={onClose}>
            {variant === 'sidebar' ? '접기' : '닫기'}
          </button>
          <button type="button" className="emath-btn-primary" disabled>
            수식 입력
          </button>
        </div>
      </div>

      <div className="emath-overlay-editor-body">
        <h2
          className="emath-template-heading"
          style={{ margin: variant === 'sidebar' ? '0 0 10px' : '0 0 12px', fontSize: variant === 'sidebar' ? 15 : 17, color: '#0f172a' }}
        >
          수식 템플릿
        </h2>
        <div className={variant === 'sidebar' ? 'emath-template-grid emath-template-grid--sidebar' : 'emath-template-grid'}>
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`emath-template-pick ${activeId === t.id ? 'is-active' : ''}${variant === 'sidebar' ? ' emath-template-pick--compact' : ''}`}
              onClick={() => setActiveId(t.id)}
            >
              <PickIcon templateId={t.id} />
              <span className="emath-template-pick-label">{t.label}</span>
            </button>
          ))}
        </div>

        <div style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          수식 편집기를 불러오는 중…
        </div>
      </div>
    </>
  );
}

export function buildElementaryMathScript(_templateId, _opts) {
  return '';
}
