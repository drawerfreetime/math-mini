import React from 'react';
import { Link } from 'react-router-dom';
import './Footer.css';

export default function Footer() {
  return (
    <footer className="site-footer" role="contentinfo">
      <div className="site-footer__inner">
        <div className="site-footer__brand">
          <span className="site-footer__name">수학 사고력 연구소</span>
          <p className="site-footer__copy">
            © 2026 수학사고력연구소. All rights reserved.
          </p>
        </div>
        <nav className="site-footer__nav" aria-label="법적 고지">
          <Link className="site-footer__link" to="/privacy">
            개인정보 처리방침
          </Link>
          <span className="site-footer__sep" aria-hidden="true">
            |
          </span>
          <Link className="site-footer__link" to="/terms">
            이용약관
          </Link>
        </nav>
      </div>
    </footer>
  );
}
