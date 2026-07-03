/**
 * 스캔본 자동 정리 4단계 — 페이지 순서·회전 (별도 라우트)
 *
 * state: { pdfFile, selectedExam, effectiveN, items }
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAuth } from '../contexts/AuthContext';
import { backendUrl } from '../utils/backendUrl';

function GridThumb({ slot, outputOrder, thumbSrc, onRotate }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: slot.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    background: '#fff',
    borderRadius: 12,
    border: '1px solid #e5e7eb',
    padding: 12,
    boxShadow: isDragging ? '0 8px 24px rgba(0,0,0,.12)' : 'none',
  };
  return (
    <div ref={setNodeRef} style={style}>
      <div
        {...attributes}
        {...listeners}
        style={{
          cursor: 'grab',
          borderRadius: 8,
          overflow: 'hidden',
          background: '#f3f4f6',
          minHeight: 280,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt=""
            style={{ width: '100%', maxHeight: 300, objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <span style={{ color: '#9ca3af' }}>미리보기</span>
        )}
      </div>
      <p style={{ margin: '10px 0 6px', fontSize: 15, fontWeight: 600, textAlign: 'center' }}>
        페이지 {outputOrder} · 원본 {slot.physicalIndex + 1}쪽
      </p>
      <p style={{ margin: '0 0 8px', fontSize: 13, color: '#6b7280', textAlign: 'center' }}>
        회전 {slot.rotation}°
      </p>
      <button type="button" className="btn btn-outline btn-sm" style={{ width: '100%' }} onClick={() => onRotate(slot.id)}>
        +90° 회전
      </button>
    </div>
  );
}

export default function ScanOrganizeLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { teacherUser } = useAuth();
  const st = location.state || {};

  const { pdfFile, selectedExam, effectiveN, items: initialItems } = st;

  const [items, setItems] = useState(() =>
    Array.isArray(initialItems) && initialItems.length
      ? initialItems
      : []
  );
  const [thumbs, setThumbs] = useState([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState('');

  const n = typeof effectiveN === 'number' && effectiveN > 0 ? effectiveN : 0;

  const stateOk = Boolean(
    pdfFile && selectedExam && n > 0 && Array.isArray(items) && items.length === n
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const fetchPreview = useCallback(async () => {
    if (!stateOk) return;
    setPreviewLoading(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', pdfFile);
      fd.append('n', String(n));
      fd.append(
        'slots',
        JSON.stringify(items.map((it) => ({ physicalIndex: it.physicalIndex, rotation: it.rotation })))
      );
      const res = await fetch(backendUrl('/api/scan-organize/preview-slots'), { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || res.statusText);
      setThumbs(Array.isArray(data.thumbnailsBase64) ? data.thumbnailsBase64 : []);
    } catch (e) {
      setError(e.message || String(e));
      setThumbs([]);
    } finally {
      setPreviewLoading(false);
    }
  }, [pdfFile, n, items, stateOk]);

  useEffect(() => {
    if (!stateOk) return;
    const t = setTimeout(() => fetchPreview(), 400);
    return () => clearTimeout(t);
  }, [fetchPreview, stateOk]);

  const handleRotate = (id) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, rotation: ((it.rotation || 0) + 90) % 360 } : it))
    );
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const oldIndex = prev.findIndex((x) => x.id === active.id);
      const newIndex = prev.findIndex((x) => x.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const finish = () => {
    if (!stateOk) return;
    navigate('/scan-organize', {
      replace: true,
      state: {
        fromLayout: true,
        layoutReturnToken: Date.now(),
        pdfFile,
        selectedExam,
        effectiveN: n,
        items,
      },
    });
  };

  if (!stateOk) {
    return <Navigate to="/scan-organize" replace />;
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="header-left">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/scan-organize', { replace: true })}>
            ← 이전 단계
          </button>
          <span style={{ fontSize: 26 }}>📄</span>
          <div>
            <h1 className="header-title">페이지 순서·회전</h1>
            <p className="header-subtitle">한 학생당 {n}쪽 · 드래그로 순서 변경</p>
          </div>
        </div>
        <div className="header-right">
          <span className="user-badge" style={{ background: '#eef2ff', color: '#4338ca' }}>교사</span>
          <span className="user-name">{teacherUser?.email || ''}</span>
        </div>
      </header>

      <div
        style={{
          display: 'flex',
          gap: 28,
          alignItems: 'flex-start',
          padding: '16px 20px 32px',
          maxWidth: 1400,
          margin: '0 auto',
        }}
      >
        <main style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}>
          {error && (
            <div className="alert alert-error" style={{ marginBottom: 12 }}>
              {error}
            </div>
          )}
          {previewLoading && <p style={{ marginBottom: 12, color: '#6b7280' }}>미리보기 갱신 중…</p>}

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items.map((i) => i.id)} strategy={rectSortingStrategy}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                  gap: 16,
                }}
              >
                {items.map((slot, idx) => (
                  <GridThumb
                    key={slot.id}
                    slot={slot}
                    outputOrder={idx + 1}
                    thumbSrc={thumbs[idx] ? `data:image/png;base64,${thumbs[idx]}` : ''}
                    onRotate={handleRotate}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </main>

        <aside
          style={{
            width: 220,
            flexShrink: 0,
            position: 'sticky',
            top: 16,
            padding: 16,
            background: '#f9fafb',
            borderRadius: 12,
            border: '1px solid #e5e7eb',
          }}
        >
          <button type="button" className="btn btn-primary" style={{ width: '100%' }} onClick={finish}>
            순서 편집 완료
          </button>
        </aside>
      </div>
    </div>
  );
}
