import React from 'react';
import './HomeBrandScreen.css';

const BRAND = `${process.env.PUBLIC_URL}/brand`;
/** SVG 교체 시 숫자만 올려 캐시 무효화 (구버전 739×809 viewBox 혼재 방지) */
const LOGIN_BTN_ASSET_V = '3';

/**
 * ref/title-final — 프레임 안에 타이틀·버튼이 들어가는 가로형 시작 화면
 * teacher_login.svg / student_login.svg — 버튼 이미지 자체가 눌림 피드백(scale)
 */
export default function HomeBrandScreen({ onSelect }) {
  return (
    <div className="login-home" role="main" aria-label="수학 사고력 연구소 시작 화면">
      <div className="login-home__stage">
        <picture className="login-home__frame-wrap">
          <source srcSet={`${BRAND}/logo-frame.svg`} type="image/svg+xml" />
          <img
            className="login-home__frame"
            src={`${BRAND}/logo-frame.png`}
            alt=""
            aria-hidden="true"
          />
        </picture>

        <div className="login-home__stage-inner">
          <img
            className="login-home__title"
            src={`${BRAND}/logo-title.png`}
            alt="수학 사고력 연구소"
          />

          <div className="login-home__actions login-home__actions--stack">
            <button
              type="button"
              className="login-home__btn login-home__btn--student"
              onClick={() => onSelect('student')}
              aria-label="학생 로그인"
            >
              <img
                src={`${BRAND}/student_login.svg?v=${LOGIN_BTN_ASSET_V}`}
                alt=""
                aria-hidden="true"
              />
            </button>
            <div className="login-home__teacher-group">
              <button
                type="button"
                className="login-home__btn login-home__btn--teacher"
                onClick={() => onSelect('teacher')}
                aria-label="교사 로그인"
              >
                <img
                  src={`${BRAND}/teacher_login.svg?v=${LOGIN_BTN_ASSET_V}`}
                  alt=""
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                className="login-home__signup"
                onClick={() => onSelect('signup')}
              >
                교사 회원가입
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
