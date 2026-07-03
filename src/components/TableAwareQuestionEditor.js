/**

 * 마크다운 표가 포함된 문제 본문 편집기 — 표는 HTML 격자, 나머지는 InlineMathEditor.

 * question 본문에 표가 없고 tableData 만 있는 문항도 지원한다.

 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';

import InlineMathEditor from './InlineMathEditor';

import {

  parseTableSegments,

  segmentsToText,

  hasMarkdownTable,

} from '../utils/markdownTableSegments';

import { isExamLongBlankBracket } from '../utils/examBlankBrackets';

import { hydrateContentEditable, serializeContentEditable } from '../utils/inlineMathStorage';

import { copyPlainFromContentEditableSelection } from './ExamOCR';



function isBlankCellValue(cell) {

  if (cell === '' || cell === undefined || cell === null) return true;

  return isExamLongBlankBracket(cell);

}



function MathCell({ value, onChange }) {

  const ref = React.useRef(null);

  useEffect(() => {

    if (ref.current) hydrateContentEditable(ref.current, String(value ?? ''));

  }, [value]);

  return (

    <span

      ref={ref}

      className="exam-table-cell-edit"

      contentEditable

      suppressContentEditableWarning

      onCopy={copyPlainFromContentEditableSelection}

      onBlur={() => onChange(serializeContentEditable(ref.current).trim())}

    />

  );

}



function EditableExamTable({ headerRows: initH, bodyRows: initB, onChange }) {

  const [header, setHeader] = useState(initH);

  const [body, setBody] = useState(initB);



  useEffect(() => {

    setHeader(initH);

    setBody(initB);

  }, [initH, initB]);



  const updateCell = (isH, ri, ci, val) => {

    if (isH) {

      const next = header.map((r, row) => r.map((c, col) => (row === ri && col === ci ? val : c)));

      setHeader(next);

      onChange(next, body);

    } else {

      const next = body.map((r, row) => r.map((c, col) => (row === ri && col === ci ? val : c)));

      setBody(next);

      onChange(header, next);

    }

  };



  const renderCell = (cell, isH, ri, ci, Tag) => {

    const empty = isBlankCellValue(cell);

    return (

      <Tag key={ci} className={empty ? 'exam-table-cell--blank' : undefined}>

        {empty ? (

          <input

            type="text"

            className="exam-table-blank-input"

            value={cell || ''}

            onChange={(e) => updateCell(isH, ri, ci, e.target.value)}

            aria-label="빈칸"

          />

        ) : (

          <MathCell value={cell} onChange={(v) => updateCell(isH, ri, ci, v)} />

        )}

      </Tag>

    );

  };



  return (

    <div className="exam-table-wrap">

      <table className="exam-table">

        {header.length > 0 && (

          <thead>

            {header.map((row, ri) => (

              <tr key={ri}>{row.map((c, ci) => renderCell(c, true, ri, ci, 'th'))}</tr>

            ))}

          </thead>

        )}

        <tbody>

          {body.map((row, ri) => (

            <tr key={ri}>{row.map((c, ci) => renderCell(c, false, ri, ci, 'td'))}</tr>

          ))}

        </tbody>

      </table>

    </div>

  );

}



function tableDataToRows(tableData) {

  if (!tableData?.length) return { headerRows: [], bodyRows: [] };

  if (tableData.length === 1) return { headerRows: [], bodyRows: tableData };

  return { headerRows: [tableData[0]], bodyRows: tableData.slice(1) };

}



function rowsToTableData(headerRows, bodyRows) {

  if (headerRows?.length > 0) return [...headerRows, ...(bodyRows || [])];

  return bodyRows || [];

}



/**

 * @param {React.ComponentProps<typeof InlineMathEditor> & {

 *   tableData?: string[][] | null;

 *   onTableDataChange?: (next: string[][] | null) => void;

 * }} props

 */

export default function TableAwareQuestionEditor({

  value,

  onChange,

  tableData = null,

  onTableDataChange,

  ...inlineProps

}) {

  const rawValue = value || '';

  const segments = useMemo(() => parseTableSegments(rawValue), [rawValue]);

  const hasInlineTable = hasMarkdownTable(rawValue);

  const hasSeparateTable = !hasInlineTable && tableData?.length > 0;

  const separateRows = useMemo(() => tableDataToRows(tableData), [tableData]);



  const handleTextChange = useCallback(

    (idx, newContent) => {

      const next = segments.map((s, i) => (i === idx ? { ...s, content: newContent } : s));

      onChange(segmentsToText(next));

    },

    [segments, onChange],

  );



  const handleTableChange = useCallback(

    (idx, newH, newB) => {

      const next = segments.map((s, i) =>

        i === idx ? { ...s, headerRows: newH, bodyRows: newB } : s,

      );

      onChange(segmentsToText(next));

    },

    [segments, onChange],

  );



  const handleSeparateTableChange = useCallback(

    (newH, newB) => {

      onTableDataChange?.(rowsToTableData(newH, newB));

    },

    [onTableDataChange],

  );



  if (!hasInlineTable && !hasSeparateTable) {

    return <InlineMathEditor value={value} onChange={onChange} {...inlineProps} />;

  }



  if (!hasInlineTable && hasSeparateTable) {

    return (

      <div className="table-aware-question-editor">

        <InlineMathEditor value={value} onChange={onChange} {...inlineProps} />

        <EditableExamTable

          headerRows={separateRows.headerRows}

          bodyRows={separateRows.bodyRows}

          onChange={handleSeparateTableChange}

        />

      </div>

    );

  }



  return (

    <div className="table-aware-question-editor">

      {segments.map((seg, i) =>

        seg.type === 'table' ? (

          <EditableExamTable

            key={i}

            headerRows={seg.headerRows}

            bodyRows={seg.bodyRows}

            onChange={(h, b) => handleTableChange(i, h, b)}

          />

        ) : (

          <InlineMathEditor

            key={i}

            value={seg.content}

            onChange={(v) => handleTextChange(i, v)}

            {...inlineProps}

          />

        ),

      )}

    </div>

  );

}


