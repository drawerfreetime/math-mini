/**
 * 문제 만들기 역량 — 유창성·융통성·정확도 표시 카드
 */
import React from 'react';
import { VARIANT_STRATEGIES } from '../constants/variantStrategies';

function Metric({ label, value, hint }) {
  return (
    <div className="pmc-metric">
      <div className="pmc-metric__label">{label}</div>
      <div className="pmc-metric__value">{value}</div>
      {hint ? <div className="pmc-metric__hint">{hint}</div> : null}
    </div>
  );
}

/**
 * @param {{ competency: import('../utils/computeProblemMakingCompetency').computeProblemMakingCompetency extends Function ? ReturnType<import('../utils/computeProblemMakingCompetency').computeProblemMakingCompetency> : object; compact?: boolean }} props
 */
export default function ProblemMakingCompetencyCard({ competency, compact = false }) {
  if (!competency) return null;

  const { fluency, flexibility, accuracy } = competency;
  const evenPct = flexibility?.evenness != null ? Math.round(flexibility.evenness * 100) : 0;

  if (compact) {
    return (
      <div className="pmc-card pmc-card--compact">
        <span>유창성 <strong>{fluency}</strong>문제</span>
        <span>융통성 <strong>{evenPct}%</strong></span>
        <span>
          정확도{' '}
          <strong>
            {accuracy?.avgAttempts != null ? `${accuracy.avgAttempts}회` : '—'}
          </strong>
        </span>
      </div>
    );
  }

  return (
    <div className="pmc-card">
      <h3 className="pmc-card__title">문제 만들기 역량</h3>
      <p className="pmc-card__desc">
        성공한 문제만 집계합니다. (AI 통과 후 교사 승인, 또는 AI 불가 시 동료 승인)
      </p>

      <div className="pmc-grid">
        <Metric
          label="유창성"
          value={`${fluency}문제`}
          hint="기간 내 최종 성공한 문제 수 (변형+새 문제)"
        />
        <Metric
          label="융통성"
          value={`${evenPct}%`}
          hint={`전략 ${flexibility?.strategiesUsed ?? 0}/6 · 고른 정도`}
        />
        <Metric
          label="정확도 (평균 시도)"
          value={accuracy?.avgAttempts != null ? `${accuracy.avgAttempts}회` : '—'}
          hint="성공까지 제출 횟수 평균"
        />
        <Metric
          label="정확도 (평균 시간)"
          value={
            accuracy?.avgDurationMinutes != null
              ? `${accuracy.avgDurationMinutes}분`
              : '—'
          }
          hint="첫 편집~성공까지"
        />
      </div>

      {!compact && flexibility?.strategiesUsed > 0 && (
        <div className="pmc-strategies">
          <div className="pmc-strategies__title">변형 전략 (성공 기준)</div>
          <ul className="pmc-strategies__list">
            {VARIANT_STRATEGIES.map((s) => {
              const n = flexibility.byStrategy?.[s.id] ?? 0;
              if (!n) return null;
              return (
                <li key={s.id}>
                  {s.title} <strong>{n}</strong>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {accuracy?.firstTrySuccessRate != null && accuracy.problemCount > 0 && (
        <p className="pmc-card__foot">
          한 번에 성공 비율: {Math.round(accuracy.firstTrySuccessRate * 100)}%
          ({accuracy.byPath?.teacher ?? 0}건 교사 승인 · {accuracy.byPath?.peer ?? 0}건 동료 승인)
        </p>
      )}
    </div>
  );
}
