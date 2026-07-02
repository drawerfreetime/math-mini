import React from 'react';
import { Link } from 'react-router-dom';
import './LegalDocumentPage.css';

export default function LegalDocumentPage({ title, children }) {
  return (
    <div className="legal-doc">
      <div className="legal-doc__card">
        <Link className="legal-doc__back" to="/">
          ← 처음으로
        </Link>
        <h1 className="legal-doc__title">{title}</h1>
        <div className="legal-doc__body">{children}</div>
      </div>
    </div>
  );
}
