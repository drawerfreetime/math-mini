/**
 * 문제 본문(마크다운 표 포함) 읽기 전용 렌더러.
 */
import React, { useMemo } from 'react';
import { renderMathText } from './ExamOCR';
import { parseTableSegments } from '../utils/markdownTableSegments';
import { isExamLongBlankBracket } from '../utils/examBlankBrackets';

function isBlankCellValue(cell) {
  if (cell === '' || cell === undefined || cell === null) return true;
  return isExamLongBlankBracket(cell);
}

function ReadOnlyTable({ headerRows, bodyRows }) {
  const renderCell = (cell, isHeader) => {
    const empty = isBlankCellValue(cell);
    if (empty) {
      return <span className="exam-table-blank" aria-hidden="true" />;
    }
    return renderMathText(String(cell));
  };

  return (
    <div className="exam-table-wrap">
      <table className="exam-table">
        {headerRows?.length > 0 && (
          <thead>
            {headerRows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <th key={ci}>{renderCell(cell, true)}</th>
                ))}
              </tr>
            ))}
          </thead>
        )}
        <tbody>
          {(bodyRows || []).map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci}>{renderCell(cell, false)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TextSegment({ content }) {
  const text = String(content || '').trim();
  if (!text) return null;
  return (
    <div className="question-body-text">
      <p className="question-body-line">
        {renderMathText(text)}
      </p>
    </div>
  );
}

/** tableData 배열(2차원) → 읽기 전용 표 */
export function TableDataRenderer({ tableData }) {
  if (!tableData?.length) return null;
  const headerRows = tableData.length > 1 ? [tableData[0]] : [];
  const bodyRows = tableData.length > 1 ? tableData.slice(1) : tableData;
  return <ReadOnlyTable headerRows={headerRows} bodyRows={bodyRows} />;
}

/**
 * @param {{ text?: string, tableData?: string[][] | null, className?: string }} props
 */
export function QuestionBodyRenderer({ text = '', tableData = null, className = '' }) {
  const segments = useMemo(() => parseTableSegments(text || ''), [text]);
  const hasInlineTable = segments.some((s) => s.type === 'table');
  const showSeparateTable = !hasInlineTable && tableData?.length > 0;

  return (
    <div className={className || undefined}>
      {segments.map((seg, i) =>
        seg.type === 'table' ? (
          <ReadOnlyTable key={i} headerRows={seg.headerRows} bodyRows={seg.bodyRows} />
        ) : (
          <TextSegment key={i} content={seg.content} />
        ),
      )}
      {showSeparateTable && <TableDataRenderer tableData={tableData} />}
    </div>
  );
}
