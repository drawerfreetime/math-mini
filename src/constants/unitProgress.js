/**
 * 단원별 수달·탐구점수·뱃지·심사위원 — 단일 소스 상수·파생 함수
 */
import { CURRICULUM, GRADES, SEMESTERS } from './curriculum';
import { VARIANT_STRATEGY_IDS } from './investigationBadges';
import { calcStudentLevel } from './studentCharacterLevels';

/** @deprecated 누적 탐구점수 구간 — stagePoints(단계별)로 대체 */
export const OTTER_STAGE_POINTS = [0, 200, 450, 750];

/** 이번 단계에서 모아야 하는 탐구점수 (진화 시 stagePoints 리셋) */
export const OTTER_STAGE_POINT_REQUIREMENTS = {
  2: 200,
  3: 250,
  4: 300,
};

export const PEER_JUDGE_APPROVAL_THRESHOLD = 2;
export const ADEPT_BADGE_THRESHOLD = 5;
export const LEGENDARY_BADGE_THRESHOLD = 12;

/** stage 2~4 진화 — 이번 단계(stage*) 기준 */
export const OTTER_EVOLUTION_REQUIREMENTS = {
  2: { stagePoints: 200, stageSolveDone: 3, peerEvalTotal: 2 },
  3: { stagePoints: 250, stageSolveDone: 6, eachStrategyPeerMin: 1 },
  4: { stagePoints: 300, stageSolveDone: 10, eachStrategyPeerMin: 2 },
};

export const OTTER_STAGE_NAMES = {
  1: '탐구달',
  2: '분석달',
  3: '추론달',
  4: '창의달',
};

/**
 * 수달 단계별 미니 레벨 상한 (이번 stagePoints 기준)
 * 0~caps[0]: 레벨1, caps[0]+1~caps[1]: 레벨2, caps[1]+1~caps[2]: 레벨3
 * 글로벌 레벨 = (stage-1)*3 + subLevel  (탐구달 1~3, 분석달 4~6, 추론달 7~9)
 */
export const OTTER_SUBLEVEL_POINT_CAPS = {
  1: [40, 95, 155],
  2: [50, 120, 195],
  3: [60, 145, 235],
};

/** @param {number} stage 1~3 @param {number} stagePoints */
export function computeOtterSubLevel(stage, stagePoints) {
  const caps = OTTER_SUBLEVEL_POINT_CAPS[stage];
  if (!caps || stage >= 4) return 3;
  const pts = Math.max(0, Number(stagePoints) || 0);
  if (pts <= caps[0]) return 1;
  if (pts <= caps[1]) return 2;
  return 3;
}

/** @param {number} stage @param {number} stagePoints */
export function getGlobalProgressLevel(stage, stagePoints) {
  if (stage >= 4) return 10;
  return (stage - 1) * 3 + computeOtterSubLevel(stage, stagePoints);
}

/**
 * @param {number} stage
 * @param {number} stagePoints
 * @param {number} stagePointTarget
 * @param {string} nextOtterName
 */
function buildSubLevelProgress(stage, stagePoints, stagePointTarget, nextOtterName) {
  const caps = OTTER_SUBLEVEL_POINT_CAPS[stage] || OTTER_SUBLEVEL_POINT_CAPS[1];
  const subLevel = computeOtterSubLevel(stage, stagePoints);
  const globalLevel = getGlobalProgressLevel(stage, stagePoints);
  const pts = Math.max(0, Number(stagePoints) || 0);

  if (subLevel < 3) {
    const nextThreshold = caps[subLevel - 1] + 1;
    const segStart = subLevel === 1 ? 0 : caps[subLevel - 2] + 1;
    const remaining = Math.max(0, nextThreshold - pts);
    const nextGlobalLevel = globalLevel + 1;
    const barPct = nextThreshold > segStart
      ? Math.min(100, Math.round(((pts - segStart) / (nextThreshold - segStart)) * 100))
      : 0;
    return {
      subLevel,
      globalLevel,
      nextGlobalLevel,
      remainingLabel: `레벨 ${nextGlobalLevel}까지 ${remaining}점`,
      barPct,
    };
  }

  const segStart = caps[1] + 1;
  const remaining = Math.max(0, stagePointTarget - pts);
  const barPct = stagePointTarget > segStart
    ? Math.min(100, Math.round(((pts - segStart) / (stagePointTarget - segStart)) * 100))
    : 0;
  return {
    subLevel,
    globalLevel,
    nextGlobalLevel: null,
    remainingLabel: `${nextOtterName}까지 ${remaining}점`,
    barPct,
  };
}

/** @returns {Record<string, number>} */
export function createEmptyApprovedByStrategy() {
  return Object.fromEntries(VARIANT_STRATEGY_IDS.map((sid) => [sid, 0]));
}

/** @returns {import('./unitProgress').UnitProgressEntry} */
export function createEmptyUnitProgress() {
  return {
    points: 0,
    stagePoints: 0,
    solveDone: 0,
    stageSolveDone: 0,
    approvedByStrategy: createEmptyApprovedByStrategy(),
    stagePeerEvalByStrategy: createEmptyApprovedByStrategy(),
    otterStage: 1,
    creativeOtterEarned: false,
    badgesEarned: {},
    badgeUnlockedAt: {},
  };
}

/**
 * @param {string} grade 초4 | 4 | 4학년
 * @param {string} semester 1학기 | 1
 * @param {string} unit 3 | 3. 곱셈과 나눗셈
 * @returns {string} 예: 4-1-3
 */
export function buildUnitKey(grade, semester, unit) {
  const g = String(grade || '').match(/\d+/)?.[0] || '';
  const s = String(semester || '').match(/\d+/)?.[0] || '';
  const u = String(unit || '').match(/\d+/)?.[0] || '';
  if (!g || !s || !u) return '';
  return `${g}-${s}-${u}`;
}

/**
 * @param {string} unitKey
 * @returns {string}
 */
export function getUnitLabel(unitKey) {
  const m = String(unitKey || '').match(/^(\d+)-(\d+)-(\d+)$/);
  if (!m) return unitKey || '';
  const gradeKey = `초${m[1]}`;
  const sem = SEMESTERS[Number(m[2]) - 1] || `${m[2]}학기`;
  const units = CURRICULUM[gradeKey]?.[sem];
  const idx = Number(m[3]) - 1;
  if (units && idx >= 0 && idx < units.length) {
    return units[idx].replace(/^\d+\.\s*/, '').trim();
  }
  return `${m[1]}학년 ${m[2]}학기 ${m[3]}단원`;
}

/**
 * @param {object|null|undefined} source
 * @returns {string}
 */
export function resolveUnitKeyFromSource(source) {
  if (!source) return '';
  const direct = String(source.unitKey || source.curriculumUnitKey || '').trim();
  if (/^\d+-\d+-\d+$/.test(direct)) return direct;
  const fromCurriculumUnit = String(source.curriculumUnit || '').trim();
  if (/^\d+-\d+-\d+$/.test(fromCurriculumUnit)) return fromCurriculumUnit;
  return buildUnitKey(
    source.curriculumGrade || source.grade || source.examGrade,
    source.curriculumSemester || source.semester,
    source.curriculumUnit || source.unit,
  );
}

/**
 * @param {import('./unitProgress').UnitProgressEntry|null|undefined} raw
 * @returns {import('./unitProgress').UnitProgressEntry}
 */
function normalizeStrategyCountMap(rawMap, fallbackMap) {
  const base = createEmptyApprovedByStrategy();
  const merged = { ...base, ...(fallbackMap || {}), ...(rawMap || {}) };
  for (const sid of VARIANT_STRATEGY_IDS) {
    merged[sid] = Math.max(0, Number(merged[sid]) || 0);
  }
  return merged;
}

/** @param {number} totalPoints @param {number} otterStage */
function inferLegacyStagePoints(totalPoints, otterStage) {
  const pts = Math.max(0, Number(totalPoints) || 0);
  const stage = Math.min(4, Math.max(1, Number(otterStage) || 1));
  if (stage >= 4) return 0;
  const legacyBandStart = [0, 0, 200, 450][stage] || 0;
  const nextReq = OTTER_STAGE_POINT_REQUIREMENTS[Math.min(4, stage + 1)] || 0;
  return Math.min(Math.max(0, pts - legacyBandStart), nextReq);
}

export function normalizeUnitProgress(raw) {
  const base = createEmptyUnitProgress();
  if (!raw || typeof raw !== 'object') return base;
  const approved = normalizeStrategyCountMap(raw.approvedByStrategy);
  const otterStage = Math.min(4, Math.max(1, Number(raw.otterStage) || 1));
  const points = Math.max(0, Number(raw.points) || 0);
  const solveDone = Math.max(0, Number(raw.solveDone) || 0);
  const hasStagePeer = raw.stagePeerEvalByStrategy != null;
  const stagePeerEvalByStrategy = normalizeStrategyCountMap(
    hasStagePeer ? raw.stagePeerEvalByStrategy : null,
    hasStagePeer ? null : approved,
  );
  const stagePoints = raw.stagePoints != null
    ? Math.max(0, Number(raw.stagePoints) || 0)
    : inferLegacyStagePoints(points, otterStage);
  const stageSolveDone = raw.stageSolveDone != null
    ? Math.max(0, Number(raw.stageSolveDone) || 0)
    : solveDone;
  return {
    points,
    stagePoints,
    solveDone,
    stageSolveDone,
    approvedByStrategy: approved,
    stagePeerEvalByStrategy,
    otterStage,
    creativeOtterEarned: Boolean(raw.creativeOtterEarned),
    badgesEarned: { ...(raw.badgesEarned || {}) },
    badgeUnlockedAt: { ...(raw.badgeUnlockedAt || {}) },
  };
}

/** @param {import('./unitProgress').UnitProgressEntry} progress */
export function totalStrategyApprovals(progress) {
  const p = normalizeUnitProgress(progress);
  return VARIANT_STRATEGY_IDS.reduce((sum, sid) => sum + (p.approvedByStrategy[sid] || 0), 0);
}

/** @param {import('./unitProgress').UnitProgressEntry} progress @param {number} min */
export function allStrategiesAtLeast(progress, min) {
  const p = normalizeUnitProgress(progress);
  return VARIANT_STRATEGY_IDS.every((sid) => (p.approvedByStrategy[sid] || 0) >= min);
}

/**
 * @param {number} stage 2|3|4
 * @param {import('./unitProgress').UnitProgressEntry} progress
 */
/** @param {import('./unitProgress').UnitProgressEntry} progress */
export function totalStagePeerEvalSuccess(progress) {
  const p = normalizeUnitProgress(progress);
  return VARIANT_STRATEGY_IDS.reduce(
    (sum, sid) => sum + (p.stagePeerEvalByStrategy[sid] || 0),
    0,
  );
}

/** @param {import('./unitProgress').UnitProgressEntry} progress @param {number} min */
export function countStagePeerEvalStrategiesAtLeast(progress, min) {
  const p = normalizeUnitProgress(progress);
  return VARIANT_STRATEGY_IDS.filter(
    (sid) => (p.stagePeerEvalByStrategy[sid] || 0) >= min,
  ).length;
}

export function meetsEvolutionRequirements(stage, progress) {
  const req = OTTER_EVOLUTION_REQUIREMENTS[stage];
  if (!req) return false;
  const p = normalizeUnitProgress(progress);
  if (p.stagePoints < req.stagePoints) return false;
  if (p.stageSolveDone < req.stageSolveDone) return false;
  if (stage === 2) return totalStagePeerEvalSuccess(p) >= (req.peerEvalTotal || 0);
  if (req.eachStrategyPeerMin) {
    return countStagePeerEvalStrategiesAtLeast(p, req.eachStrategyPeerMin) >= VARIANT_STRATEGY_IDS.length;
  }
  return true;
}

/** @param {import('./unitProgress').UnitProgressEntry} progress */
export function computeOtterStage(progress) {
  const p = normalizeUnitProgress(progress);
  if (meetsEvolutionRequirements(4, p)) return 4;
  if (meetsEvolutionRequirements(3, p)) return 3;
  if (meetsEvolutionRequirements(2, p)) return 2;
  return 1;
}

/** @param {import('./unitProgress').UnitProgressEntry} progress @param {string} strategyId */
export function isPeerJudge(progress, strategyId) {
  const p = normalizeUnitProgress(progress);
  return (p.approvedByStrategy[strategyId] || 0) >= PEER_JUDGE_APPROVAL_THRESHOLD;
}

/** @param {import('./unitProgress').UnitProgressEntry} progress @param {string} strategyId */
export function hasAdeptBadge(progress, strategyId) {
  const p = normalizeUnitProgress(progress);
  return (p.approvedByStrategy[strategyId] || 0) >= ADEPT_BADGE_THRESHOLD;
}

/** @param {import('./unitProgress').UnitProgressEntry} progress @param {string} strategyId */
export function hasLegendaryBadge(progress, strategyId) {
  const p = normalizeUnitProgress(progress);
  return (p.approvedByStrategy[strategyId] || 0) >= LEGENDARY_BADGE_THRESHOLD;
}

/** @param {number} stage @param {import('./unitProgress').UnitProgressEntry} progress */
export function canEvolveTo(stage, progress) {
  if (stage < 2 || stage > 4) return stage === 1;
  return meetsEvolutionRequirements(stage, progress);
}

/**
 * @param {import('./unitProgress').UnitProgressEntry} progress
 * @returns {{ stage: number, label: string, summary: string } | null}
 */
export function getNextEvolutionGoal(progress) {
  const p = normalizeUnitProgress(progress);
  const current = computeOtterStage(p);
  if (current >= 4) return null;
  const next = current + 1;
  const req = OTTER_EVOLUTION_REQUIREMENTS[next];
  if (!req) return null;
  let peerPart = '';
  if (next === 2) {
    peerPart = `동료평가 ${req.peerEvalTotal}번`;
  } else {
    peerPart = `동료평가 6가지×${req.eachStrategyPeerMin}`;
  }
  return {
    stage: next,
    label: OTTER_STAGE_NAMES[next] || '',
    summary: `${peerPart}, 풀기 ${req.stageSolveDone}번, 탐구점수 ${req.stagePoints}`,
  };
}

/**
 * 학생 대시보드 진화 진행 표시용
 * @param {import('./unitProgress').UnitProgressEntry} progress
 */
export function buildEvolutionProgressView(progress) {
  const p = normalizeUnitProgress(progress);
  const stage = computeOtterStage(p);
  const totalPoints = p.points;

  if (stage >= 4) {
    return {
      complete: true,
      totalPoints,
      stagePoints: p.stagePoints,
      globalLevel: 10,
      barPct: 100,
      remainingLabel: null,
      nextLabel: null,
      rows: [],
    };
  }

  const next = stage + 1;
  const req = OTTER_EVOLUTION_REQUIREMENTS[next];
  const nextLabel = OTTER_STAGE_NAMES[next] || '';
  const stagePointTarget = req.stagePoints;
  const sub = buildSubLevelProgress(stage, p.stagePoints, stagePointTarget, nextLabel);
  const remainingPoints = Math.max(0, stagePointTarget - p.stagePoints);

  /** @type {{ key: string, label: string, current: number, target: number, done: boolean }[]} */
  const rows = [
    {
      key: 'solve',
      label: '풀기',
      current: p.stageSolveDone,
      target: req.stageSolveDone,
      done: p.stageSolveDone >= req.stageSolveDone,
    },
    {
      key: 'points',
      label: '단원 탐구점수',
      current: p.stagePoints,
      target: stagePointTarget,
      done: p.stagePoints >= stagePointTarget,
    },
  ];

  if (next === 2) {
    const peerCurrent = totalStagePeerEvalSuccess(p);
    rows.splice(1, 0, {
      key: 'peer',
      label: '동료평가',
      current: peerCurrent,
      target: req.peerEvalTotal,
      done: peerCurrent >= req.peerEvalTotal,
    });
  } else {
    const peerCurrent = countStagePeerEvalStrategiesAtLeast(p, req.eachStrategyPeerMin);
    rows.splice(1, 0, {
      key: 'peer',
      label: '동료평가',
      current: peerCurrent,
      target: VARIANT_STRATEGY_IDS.length,
      done: peerCurrent >= VARIANT_STRATEGY_IDS.length,
    });
  }

  return {
    complete: false,
    totalPoints,
    stagePoints: p.stagePoints,
    stagePointTarget,
    barPct: sub.barPct,
    remainingPoints,
    remainingLabel: sub.remainingLabel,
    nextLabel,
    subLevel: sub.subLevel,
    globalLevel: sub.globalLevel,
    nextGlobalLevel: sub.nextGlobalLevel,
    rows,
  };
}

/**
 * @param {object|null|undefined} student
 * @returns {string}
 */
export function pickActiveUnitKey(student) {
  const explicit = String(student?.activeUnitKey || '').trim();
  if (/^\d+-\d+-\d+$/.test(explicit)) return explicit;
  const up = student?.unitProgress || {};
  const keys = Object.keys(up).filter((k) => /^\d+-\d+-\d+$/.test(k));
  if (!keys.length) return '';
  keys.sort((a, b) => {
    const pa = normalizeUnitProgress(up[a]);
    const pb = normalizeUnitProgress(up[b]);
    if (pb.points !== pa.points) return pb.points - pa.points;
    return b.localeCompare(a);
  });
  return keys[0];
}

/**
 * @param {object|null|undefined} student
 * @returns {import('./unitProgress').UnitProgressEntry}
 */
export function getActiveUnitProgress(student) {
  const key = pickActiveUnitKey(student);
  if (!key) return createEmptyUnitProgress();
  return normalizeUnitProgress(student?.unitProgress?.[key]);
}

/**
 * 랭킹·프로필 표시용 — 단원 체계 우선, 레거시 totalSolved 폴백
 * @param {object|null|undefined} student
 */
export function getStudentDisplayOtterStage(student) {
  const up = student?.unitProgress || {};
  const keys = Object.keys(up).filter((k) => /^\d+-\d+-\d+$/.test(k));
  if (keys.length) {
    const active = pickActiveUnitKey(student);
    if (active) return computeOtterStage(normalizeUnitProgress(up[active]));
    const stages = keys.map((k) => computeOtterStage(normalizeUnitProgress(up[k])));
    return Math.max(...stages, 1);
  }
  return calcStudentLevel(Number(student?.totalSolved) || 0);
}

/**
 * @param {object|null|undefined} student
 * @returns {number}
 */
export function countCreativeOtters(student) {
  const coll = student?.creativeOtterCollection || {};
  return Object.keys(coll).filter((k) => /^\d+-\d+-\d+$/.test(k)).length;
}

/** @returns {string[]} 수와 연산 단원용 — 등록된 curriculum 키 목록 */
export function listKnownUnitKeys() {
  /** @type {string[]} */
  const out = [];
  for (const g of GRADES) {
    const gradeDigit = g.replace(/\D/g, '');
    if (!gradeDigit) continue;
    for (const sem of SEMESTERS) {
      const semDigit = sem.replace(/\D/g, '');
      const units = CURRICULUM[g]?.[sem] || [];
      units.forEach((_, idx) => {
        const label = units[idx] || '';
        if (!label.includes('미등록')) out.push(`${gradeDigit}-${semDigit}-${idx + 1}`);
      });
    }
  }
  return out;
}

/**
 * @typedef {Object} UnitProgressEntry
 * @property {number} points
 * @property {number} stagePoints
 * @property {number} solveDone
 * @property {number} stageSolveDone
 * @property {Record<string, number>} approvedByStrategy
 * @property {Record<string, number>} stagePeerEvalByStrategy
 * @property {1|2|3|4} otterStage
 * @property {boolean} creativeOtterEarned
 * @property {Record<string, { adept?: boolean, legendary?: boolean }>} [badgesEarned]
 * @property {Record<string, { adept?: string|null, legendary?: string|null }>} [badgeUnlockedAt]
 */
