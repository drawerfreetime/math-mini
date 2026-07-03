import React from 'react';

const BRAND = `${process.env.PUBLIC_URL}/brand`;

/** 수사연 로고(집 아이콘) — 대시보드 헤더 왼쪽 홈 버튼 */
export default function BrandHomeButton({ onClick, className = '' }) {
  return (
    <button
      type="button"
      className={`brand-home-btn${className ? ` ${className}` : ''}`}
      onClick={onClick}
      aria-label="홈으로"
      title="홈으로"
    >
      <img
        src={`${BRAND}/susayeon_3letters.png`}
        alt=""
        aria-hidden="true"
        className="brand-home-btn__img"
      />
    </button>
  );
}
