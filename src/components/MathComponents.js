/**
 * 수학 공통 컴포넌트
 * - renderMathText : 분수 등 초등 수식 렌더링
 * - EditableTable  : 편집 가능한 표
 * - ProblemDetail  : 문제 상세 (보기/조건 박스 포함)
 */
import React, { useState } from 'react';

// ─────────────────────────────────────────────
// 분수 렌더링 (초등 수준: 1/2, 3/4 등)
// ─────────────────────────────────────────────
export function renderMathText(text) {
  if (!text) return null;
  const parts = [];
  const regex = /(\d+)\/(\d+)/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    parts.push(
      <span key={`frac-${match.index}`} className="math-fraction">
        <span className="math-num">{match[1]}</span>
        <span className="math-den">{match[2]}</span>
      </span>
    );
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? parts : text;
}

// ─────────────────────────────────────────────
// 편집 가능 표
// ─────────────────────────────────────────────
export function EditableTable({ data, onChange, readOnly = false }) {
  const [cells, setCells] = useState(() =>
    Array.isArray(data) && data.length > 0 ? data : [['', '']]
  );

  function updateCell(ri, ci, value) {
    const next = cells.map((row, r) =>
      r === ri ? row.map((c, col) => (col === ci ? value : c)) : row
    );
    setCells(next);
    onChange?.(next);
  }

  function addRow() {
    const next = [...cells, Array(cells[0].length).fill('')];
    setCells(next);
    onChange?.(next);
  }

  function addCol() {
    const next = cells.map((row) => [...row, '']);
    setCells(next);
    onChange?.(next);
  }

  function removeRow(ri) {
    if (cells.length <= 1) return;
    const next = cells.filter((_, r) => r !== ri);
    setCells(next);
    onChange?.(next);
  }

  return (
    <div className="math-table-wrapper">
      <table className="math-table">
        <tbody>
          {cells.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className={ri === 0 ? 'math-table-header' : ''}>
                  {readOnly ? (
                    <span>{renderMathText(cell)}</span>
                  ) : (
                    <input
                      className="math-table-input"
                      value={cell}
                      onChange={(e) => updateCell(ri, ci, e.target.value)}
                      placeholder={ri === 0 ? '헤더' : '값'}
                    />
                  )}
                </td>
              ))}
              {!readOnly && (
                <td className="math-table-action">
                  <button
                    className="table-btn-del"
                    onClick={() => removeRow(ri)}
                    title="행 삭제"
                  >×</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <div className="math-table-controls">
          <button className="btn btn-ghost btn-xs" onClick={addRow}>+ 행 추가</button>
          <button className="btn btn-ghost btn-xs" onClick={addCol}>+ 열 추가</button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// 문제 상세 컴포넌트
// ─────────────────────────────────────────────
export function ProblemDetail({
  problem,
  croppedImage,
  tableOverride,
  onTableChange,
  readOnly = false,
  children,          // 추가 버튼(수정 등)을 슬롯으로 받음
}) {
  if (!problem) return null;

  return (
    <div className="problem-detail-card">
      {/* 문제 번호 헤더 */}
      <div className="problem-detail-header">
        <span className="problem-detail-num">{problem.number}번</span>
        {children}
      </div>

      {/* 크롭된 원본 이미지 (OCR 검토 화면에서만 표시) */}
      {croppedImage && (
        <div className="problem-crop-wrap">
          <img
            src={croppedImage}
            alt={`${problem.number}번 원본`}
            className="problem-crop-img"
          />
        </div>
      )}

      {/* 문제 텍스트 */}
      <div className="problem-question-text">
        {renderMathText(problem.question)}
      </div>

      {/* 보기 박스 */}
      {problem.hasBogi && problem.bogiContent && (
        <div className="bogi-box">
          <span className="bogi-label">보기</span>
          {problem.bogiContent
            .split('\n')
            .filter(Boolean)
            .map((line, i) => (
              <p key={i} className="bogi-line">
                {renderMathText(line)}
              </p>
            ))}
        </div>
      )}

      {/* 조건 박스 */}
      {problem.hasCondition && problem.conditionContent && (
        <div className="condition-box">
          <span className="condition-label">조건</span>
          {problem.conditionContent
            .split('\n')
            .filter(Boolean)
            .map((line, i) => (
              <p key={i} className="condition-line">
                {renderMathText(line)}
              </p>
            ))}
        </div>
      )}

      {/* 표 */}
      {problem.hasTable && (problem.tableData || tableOverride) && (
        <div className="problem-table-wrap">
          <EditableTable
            data={tableOverride || problem.tableData}
            onChange={onTableChange}
            readOnly={readOnly}
          />
        </div>
      )}
    </div>
  );
}
