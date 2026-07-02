/**
 * 초등 수학 학년·학기·단원 선택 (curriculum.js와 동일 데이터)
 */
import React from 'react';
import { CURRICULUM, GRADES, SEMESTERS } from '../constants/curriculum';

/**
 * @param {{
 *   grade: string,
 *   semester: string,
 *   unit: string,
 *   onChange: (next: { grade: string, semester: string, unit: string }) => void,
 *   disabled?: boolean,
 * }} props
 */
export default function CurriculumPickers({ grade, semester, unit, onChange, disabled }) {
  const set = (patch) => onChange({ grade, semester, unit, ...patch });

  return (
    <div className="curriculum-pickers" style={{ marginBottom: 8 }}>
      <p className="form-label" style={{ marginBottom: 8 }}>
        학년 <span style={{ color: '#dc2626', fontSize: 12 }}>*</span>
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {GRADES.map((g) => (
          <button
            key={g}
            type="button"
            className={`btn btn-sm ${grade === g ? 'btn-primary' : 'btn-outline'}`}
            disabled={disabled}
            onClick={() => set({ grade: g, semester: '', unit: '' })}
          >
            {g}
          </button>
        ))}
      </div>

      {grade ? (
        <>
          <p className="form-label" style={{ marginTop: 14, marginBottom: 8 }}>
            학기 <span style={{ color: '#dc2626', fontSize: 12 }}>*</span>
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SEMESTERS.map((s) => (
              <button
                key={s}
                type="button"
                className={`btn btn-sm ${semester === s ? 'btn-primary' : 'btn-outline'}`}
                disabled={disabled}
                onClick={() => set({ semester: s, unit: '' })}
              >
                {s}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {grade && semester ? (
        <>
          <p className="form-label" style={{ marginTop: 14, marginBottom: 8 }}>
            단원 <span style={{ color: '#dc2626', fontSize: 12 }}>*</span>
          </p>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              maxHeight: 220,
              overflowY: 'auto',
              padding: '4px 0',
            }}
          >
            {(CURRICULUM[grade]?.[semester] ?? []).map((u) => (
              <button
                key={u}
                type="button"
                className={`btn btn-sm ${unit === u ? 'btn-primary' : 'btn-outline'}`}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                disabled={disabled}
                onClick={() => set({ unit: u })}
              >
                {u}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function curriculumSelectionComplete(grade, semester, unit) {
  return Boolean(String(grade || '').trim() && String(semester || '').trim() && String(unit || '').trim());
}
