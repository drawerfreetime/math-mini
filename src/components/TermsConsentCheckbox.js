import React from 'react';
import { Link } from 'react-router-dom';

export default function TermsConsentCheckbox({
  checked,
  onChange,
  id = 'terms-consent',
}) {
  return (
    <div className="form-checkbox">
      <label className="checkbox-label" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="checkbox-input"
        />
        <span className="checkbox-custom" aria-hidden="true" />
        <span className="checkbox-text">
          이용약관에 동의합니다.{' '}
          <Link
            to="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="legal-consent__view"
            onClick={(e) => e.stopPropagation()}
          >
            (보기)
          </Link>
        </span>
      </label>
    </div>
  );
}
