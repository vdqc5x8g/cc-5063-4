import { Surface, cloneSurface } from './surface.js';
import {
  StitchConfig,
  ContinuityMode,
  FixedSide,
  EdgeLocks,
  LockEdge,
  solveStitch,
  lockEdgeCpIndices,
  modelScale,
} from './solver.js';
import { measureSeam, SeamMetrics } from './continuity.js';
import { buildCorrespondence, Correspondence, Side, seamCrossCoeffs } from './seam.js';
import { cpMoveStats, surfaceDeviation, deformationEnergy, MoveStats, SurfaceDeviation } from './shape-cost.js';
import { Vec3 } from './vec.js';

export interface LabThresholds {
  gapTol: number;
  tangentDeg: number;
  c1: number;
  moveBudget: number;
}

export function labThresholds(a: Surface, b: Surface, moveBudgetFrac = 0.04): LabThresholds {
  const L = modelScale(a, b);
  return { gapTol: 1e-4 * L, tangentDeg: 0.25, c1: 1e-2, moveBudget: moveBudgetFrac * L };
}

export type ConflictLevel = 'blocked' | 'exclusive' | 'costly';

export interface ConflictPoint {
  index: number;
  xi: number;
  tA: number;
  tB: number;
  point: Vec3;
  gap: number;
  tangentPlaneDeg: number;
  normalAngleDeg: number;
  c1Mismatch: number;
  localMoveG1: number;
  localMoveC1: number;
  level: ConflictLevel | null;
  score: number;
  reasons: string[];
}

export interface ConflictCluster {
  id: number;
  i0: number;
  i1: number;
  xi0: number;
  xi1: number;
  count: number;
  worstIndex: number;
  point: Vec3;
  level: ConflictLevel;
  maxScore: number;
  maxGap: number;
  maxTangentPlaneDeg: number;
  maxC1Mismatch: number;
  maxLocalMoveC1: number;
  title: string;
}

export interface DofInfo {
  variables: number;
  freeCps: number;
  constraintRows: number;
  constraintRank: number;
  nullity: number;
}

export interface RouteOutcome {
  mode: ContinuityMode;
  a: Surface;
  b: Surface;
  status: 'ok' | 'conflict' | 'degenerate';
  messages: string[];
  metrics: SeamMetrics;
  report: ReturnType<typeof solveStitch>['report'];
  maxAngleErrDeg: number;
  move: MoveStats;
  deviation: SurfaceDeviation;
  deformEnergy: number;
  dof: DofInfo;
  points: ConflictPoint[];
  clusters: ConflictCluster[];
}

export interface RouteLabConfig {
  sideA: Side;
  sideB: Side;
  direction: 1 | -1;
  correspondenceMode: 'arclength' | 'parameter';
  fixed: FixedSide;
  deformRows: number;
  stiffness: number;
  shapeBias: number;
  edgeLocks: EdgeLocks;
  samples?: number;
  density?: number;
  moveBudgetFrac?: number;
}

export interface RouteComparison {
  density: number;
  thresholds: LabThresholds;
  g1: RouteOutcome;
  c1: RouteOutcome;
  recommendation: 'G1' | 'C1';
  recommendationReasons: string[];
}

function displacementMap(before: Surface, after: Surface): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < before.cps.length; i++)
    for (let j = 0; j < before.cps[i].length; j++) {
      const p = before.cps[i][j];
      const q = after.cps[i][j];
      m.set(`${i},${j}`, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
    }
  return m;
}

/** Largest displacement among the control points supporting the cross derivative. */
function localSupportMove(s: Surface, side: Side, t: number, moves: Map<string, number>): number {
  let mx = 0;
  for (const c of seamCrossCoeffs(s, side, t)) mx = Math.max(mx, moves.get(`${c.i},${c.j}`) ?? 0);
  return mx;
}

function clusterPoints(points: ConflictPoint[], mergeGap = 2): ConflictCluster[] {
  const flagged = points.filter((p): p is ConflictPoint & { level: ConflictLevel } => p.level !== null);
  if (!flagged.length) return [];
  const clusters: ConflictCluster[] = [];
  let cur: Array<ConflictPoint & { level: ConflictLevel }> = [flagged[0]];
  const flush = () => {
    if (!cur.length) return;
    const i0 = cur[0].index;
    const i1 = cur[cur.length - 1].index;
    let worst = cur[0];
    for (const p of cur) if (p.score > worst.score) worst = p;
    const rank: Record<ConflictLevel, number> = { costly: 0, exclusive: 1, blocked: 2 };
    let level: ConflictLevel = cur[0].level;
    for (const p of cur) if (rank[p.level] > rank[level]) level = p.level;
    const id = clusters.length + 1;
    const levelName = level === 'blocked' ? '连接受阻' : level === 'exclusive' ? '不可兼得' : '代价过高';
    clusters.push({
      id,
      i0,
      i1,
      xi0: cur[0].xi,
      xi1: cur[cur.length - 1].xi,
      count: cur.length,
      worstIndex: worst.index,
      point: worst.point,
      level,
      maxScore: worst.score,
      maxGap: Math.max(...cur.map((p) => p.gap)),
      maxTangentPlaneDeg: Math.max(...cur.map((p) => p.tangentPlaneDeg)),
      maxC1Mismatch: Math.max(...cur.map((p) => p.c1Mismatch)),
      maxLocalMoveC1: Math.max(...cur.map((p) => p.localMoveC1)),
      title: `${levelName}段 ${id}：ξ ${cur[0].xi.toFixed(2)}–${cur[cur.length - 1].xi.toFixed(2)}`,
    });
    cur = [];
  };
  for (let k = 1; k < flagged.length; k++) {
    const p = flagged[k];
    if (p.index - cur[cur.length - 1].index <= mergeGap + 1) {
      cur.push(p);
    } else {
      flush();
      cur = [p];
    }
  }
  flush();
  return clusters;
}

function buildOutcome(
  mode: ContinuityMode,
  a: Surface,
  b: Surface,
  cfg: RouteLabConfig,
  corr: Correspondence,
  density: number,
): RouteOutcome {
  const stitchCfg: StitchConfig = {
    sideA: cfg.sideA,
    sideB: cfg.sideB,
    continuity: mode,
    correspondence: corr,
    fixed: cfg.fixed,
    deformRows: cfg.deformRows,
    stiffness: cfg.stiffness,
    shapeBias: cfg.shapeBias,
    edgeLocks: cfg.edgeLocks,
  };
  const res = solveStitch(cloneSurface(a), cloneSurface(b), stitchCfg);
  const metrics = measureSeam(res.a, cfg.sideA, res.b, cfg.sideB, corr, density);
  const freeBefore = cfg.fixed === 'A' ? b : a;
  const freeAfter = cfg.fixed === 'A' ? res.b : res.a;
  const freeSide = cfg.fixed === 'A' ? cfg.sideB : cfg.sideA;
  const moves = displacementMap(freeBefore, freeAfter);
  const move = cpMoveStats(freeBefore, freeAfter);
  const deviation = surfaceDeviation(freeBefore, freeAfter, 24);
  return {
    mode,
    a: res.a,
    b: res.b,
    status: res.report.status,
    messages: res.report.messages,
    metrics,
    report: res.report,
    maxAngleErrDeg: Math.max(metrics.maxTangentPlaneDeg, metrics.maxNormalAngleDeg),
    move,
    deviation,
    deformEnergy: deformationEnergy(freeBefore, freeAfter),
    dof: {
      variables: res.report.variables,
      freeCps: res.report.freeCps,
      constraintRows: res.report.positionRows * 3 + res.report.tangentRows,
      constraintRank: res.report.constraintRank,
      nullity: res.report.nullity,
    },
    points: [],
    clusters: [],
  };
}

/**
 * Run both continuity routes from the same original pair under identical lock /
 * DOF settings, then localise seam positions where the routes' attainable
 * quality differs ("不可兼得").
 */
export function compareRoutes(a: Surface, b: Surface, cfg: RouteLabConfig): RouteComparison {
  const density = cfg.density ?? 160;
  const samples = cfg.samples ?? 48;
  const corr = buildCorrespondence(a, cfg.sideA, b, cfg.sideB, samples, cfg.direction, cfg.correspondenceMode);
  const thresholds = labThresholds(a, b, cfg.moveBudgetFrac ?? 0.04);

  const g1 = buildOutcome('G1', a, b, cfg, corr, density);
  const c1 = buildOutcome('C1', a, b, cfg, corr, density);

  const freeBefore = cfg.fixed === 'A' ? b : a;
  const freeSide = cfg.fixed === 'A' ? cfg.sideB : cfg.sideA;
  const movesG1 = displacementMap(freeBefore, cfg.fixed === 'A' ? g1.b : g1.a);
  const movesC1 = displacementMap(freeBefore, cfg.fixed === 'A' ? c1.b : c1.a);

  const n = Math.min(g1.metrics.samples.length, c1.metrics.samples.length);
  const points: ConflictPoint[] = [];
  for (let i = 0; i < n; i++) {
    const sg = g1.metrics.samples[i];
    const sc = c1.metrics.samples[i];
    const xi = n > 1 ? i / (n - 1) : 0;
    const localMoveG1 = localSupportMove(freeBefore, freeSide, sc.tB, movesG1);
    const localMoveC1 = localSupportMove(freeBefore, freeSide, sc.tB, movesC1);

    const g1GeometryOk = sg.gap <= thresholds.gapTol && sg.tangentPlaneDeg <= thresholds.tangentDeg;
    const c1GeometryOk = sc.gap <= thresholds.gapTol && sc.tangentPlaneDeg <= thresholds.tangentDeg;
    const c1ParamOk = sc.c1Mismatch <= thresholds.c1;
    const costly = c1GeometryOk && c1ParamOk && localMoveC1 > thresholds.moveBudget;

    let level: ConflictLevel | null = null;
    const reasons: string[] = [];
    if (!g1GeometryOk) {
      level = 'blocked';
      if (sg.gap > thresholds.gapTol) reasons.push(`G1 路线间隙 ${sg.gap.toExponential(2)} > ${thresholds.gapTol.toExponential(1)}`);
      if (sg.tangentPlaneDeg > thresholds.tangentDeg) reasons.push(`切平面偏差 ${sg.tangentPlaneDeg.toFixed(2)}° > ${thresholds.tangentDeg}°`);
    } else if (!c1ParamOk || !c1GeometryOk) {
      level = 'exclusive';
      if (!c1ParamOk) reasons.push(`C1 失配 ${sc.c1Mismatch.toExponential(2)} > ${thresholds.c1}：参数导数一致不可达`);
      if (!c1GeometryOk) reasons.push('C1 路线连几何切面也未满足');
    } else if (costly) {
      level = 'costly';
      reasons.push(`C1 局部控制点位移 ${localMoveC1.toFixed(3)} 超过让步预算 ${thresholds.moveBudget.toFixed(3)}`);
    }

    const score = Math.max(
      sg.gap / thresholds.gapTol,
      sg.tangentPlaneDeg / thresholds.tangentDeg,
      sc.c1Mismatch / thresholds.c1,
      localMoveC1 / thresholds.moveBudget,
    );

    points.push({
      index: i,
      xi,
      tA: sc.tA,
      tB: sc.tB,
      point: sg.pa,
      gap: Math.max(sg.gap, sc.gap),
      tangentPlaneDeg: Math.max(sg.tangentPlaneDeg, sc.tangentPlaneDeg),
      normalAngleDeg: Math.max(sg.normalAngleDeg, sc.normalAngleDeg),
      c1Mismatch: sc.c1Mismatch,
      localMoveG1,
      localMoveC1,
      level,
      score: level ? score : 0,
      reasons,
    });
  }
  const clusters = clusterPoints(points);
  g1.points = points;
  c1.points = points;
  g1.clusters = clusters;
  c1.clusters = clusters;

  // Measured recommendation.
  const recReasons: string[] = [];
  const c1Feasible = c1.status === 'ok' && c1.metrics.maxC1Mismatch <= thresholds.c1;
  const c1WithinBudget = c1.move.max <= thresholds.moveBudget;
  const g1Feasible = g1.status === 'ok' && g1.metrics.maxTangentPlaneDeg <= thresholds.tangentDeg;
  let recommendation: 'G1' | 'C1';
  if (c1Feasible && c1WithinBudget) {
    recommendation = 'C1';
    recReasons.push(
      `实测 C1 可达（最大失配 ${c1.metrics.maxC1Mismatch.toExponential(2)}）且最大控制点位移 ${c1.move.max.toFixed(4)} 在让步预算 ${thresholds.moveBudget.toFixed(4)} 内。`,
    );
    if (Math.abs(c1.metrics.minSpeedRatio - 1) < 0.02) recReasons.push('两侧参数速度本就接近 1，坚持参数导数一致几乎没有形状代价。');
  } else {
    recommendation = 'G1';
    if (g1Feasible) recReasons.push(`G1 路线实测切平面偏差 ≤ ${thresholds.tangentDeg}°，几何连续成立。`);
    if (!c1Feasible)
      recReasons.push(`C1 路线在当前锁定/自由度下未达参数导数一致（最大失配 ${c1.metrics.maxC1Mismatch.toExponential(2)}，状态 ${c1.status}）。`);
    if (!c1WithinBudget)
      recReasons.push(
        `C1 最大控制点位移 ${c1.move.max.toFixed(4)} 超过让步预算 ${thresholds.moveBudget.toFixed(4)}，而 G1 最大位移仅 ${g1.move.max.toExponential(2)}；参数速度不等时坚持 C1 的形状代价过高。`,
      );
    recReasons.push('建议以共切面连续(G1)为优先，允许参数速度不同；需要 C1 时再松开锁定边或增加变形行。');
  }

  return { density, thresholds, g1, c1, recommendation, recommendationReasons: recReasons };
}

/** Clusters of threshold exceedances in an ordinary single-route seam measurement. */
export function anomalyClusters(
  metrics: SeamMetrics,
  opts: { gapTol: number; tangentDeg: number; c1?: number },
): ConflictCluster[] {
  const pts: ConflictPoint[] = metrics.samples.map((s, i) => {
    const xi = metrics.samples.length > 1 ? i / (metrics.samples.length - 1) : 0;
    const gapBad = s.gap > opts.gapTol;
    const tanBad = s.tangentPlaneDeg > opts.tangentDeg;
    const c1Bad = opts.c1 !== undefined && s.c1Mismatch > opts.c1;
    const level: ConflictLevel | null = gapBad || tanBad ? 'blocked' : c1Bad ? 'exclusive' : null;
    return {
      index: i,
      xi,
      tA: s.tA,
      tB: s.tB,
      point: s.pa,
      gap: s.gap,
      tangentPlaneDeg: s.tangentPlaneDeg,
      normalAngleDeg: s.normalAngleDeg,
      c1Mismatch: s.c1Mismatch,
      localMoveG1: 0,
      localMoveC1: 0,
      level,
      score: Math.max(s.gap / opts.gapTol, s.tangentPlaneDeg / opts.tangentDeg, opts.c1 ? s.c1Mismatch / opts.c1 : 0),
      reasons: [],
    };
  });
  return clusterPoints(pts);
}

export interface ConcessionArrow {
  i: number;
  j: number;
  from: Vec3;
  to: Vec3;
  delta: Vec3;
  move: number;
}

export type HealKind = 'eliminated' | 'relieved' | 'improved';

export interface HealedRange {
  kind: HealKind;
  i0: number;
  i1: number;
  xi0: number;
  xi1: number;
  points: Vec3[];
  scoreBeforeMax: number;
  scoreAfterMax: number;
  gapBeforeMax: number;
  gapAfterMax: number;
  tanBeforeMax: number;
  tanAfterMax: number;
  c1BeforeMax: number;
  c1AfterMax: number;
  /** 1 - median(afterScore / beforeScore) over the range, clamped to [0,1] */
  relief: number;
}

export interface EdgeReleasePreview {
  edge: LockEdge;
  /** solve with the edge still locked */
  lockedA: Surface;
  lockedB: Surface;
  lockedReport: ReturnType<typeof solveStitch>['report'];
  /** solve on a copy with only this edge released */
  afterA: Surface;
  afterB: Surface;
  afterReport: ReturnType<typeof solveStitch>['report'];
  /** marginal concession: locked-solution edge poles -> released-solution poles */
  arrows: ConcessionArrow[];
  maxConcession: number;
  /** true when at least one edge pole materially moves between the two solves */
  edgeParticipates: boolean;
  before: SeamMetrics;
  after: SeamMetrics;
  /** ranges that leave tolerance after release ("消除") */
  healed: HealedRange[];
  /** ranges that improve materially but stay over tolerance ("缓解") */
  relieved: HealedRange[];
  /** ranges already within tolerance whose error nonetheless drops >=85% ("显著压低") */
  improved: HealedRange[];
  /** fraction of all samples that were over tolerance before and within after */
  healedFraction: number;
  /** fraction of samples over tolerance in the locked solve */
  badFractionBefore: number;
  scoreBefore: number[];
  scoreAfter: number[];
  gapTol: number;
  tangentDeg: number;
  c1Tol: number | null;
}

/**
 * Solve twice from the same start pair — once with the current locks, once on
 * a copy with `edge` released — and compare the seam error polyline. Contiguous
 * sample ranges that are over tolerance in the locked solution and within
 * tolerance in the released solution are the segment eliminated by release.
 * Concession arrows measure how far the released edge poles move relative to
 * the locked solution (the marginal "让步量").
 */
export function previewEdgeRelease(
  a: Surface,
  b: Surface,
  base: {
    sideA: Side;
    sideB: Side;
    continuity: ContinuityMode;
    corr: Correspondence;
    fixed: FixedSide;
    deformRows: number;
    stiffness: number;
    shapeBias: number;
    edgeLocks: EdgeLocks;
    density?: number;
  },
  edge: LockEdge,
): EdgeReleasePreview {
  const density = base.density ?? 200;
  const mkCfg = (locks: EdgeLocks): StitchConfig => ({
    sideA: base.sideA,
    sideB: base.sideB,
    continuity: base.continuity,
    correspondence: base.corr,
    fixed: base.fixed,
    deformRows: base.deformRows,
    stiffness: base.stiffness,
    shapeBias: base.shapeBias,
    edgeLocks: locks,
  });

  const lockedRes = solveStitch(cloneSurface(a), cloneSurface(b), mkCfg(base.edgeLocks));
  const releasedLocks: EdgeLocks = { ...base.edgeLocks, [edge]: false };
  const res = solveStitch(cloneSurface(a), cloneSurface(b), mkCfg(releasedLocks));

  const before = measureSeam(lockedRes.a, base.sideA, lockedRes.b, base.sideB, base.corr, density);
  const after = measureSeam(res.a, base.sideA, res.b, base.sideB, base.corr, density);

  const freeIsB = base.fixed === 'A';
  const lockedFree = freeIsB ? lockedRes.b : lockedRes.a;
  const releasedFree = freeIsB ? res.b : res.a;
  const freeSide = freeIsB ? base.sideB : base.sideA;

  const arrows: ConcessionArrow[] = lockEdgeCpIndices(lockedFree, freeSide, edge).map(([i, j]) => {
    const from = lockedFree.cps[i][j];
    const to = releasedFree.cps[i][j];
    const delta: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    return { i, j, from, to, delta, move: Math.hypot(...delta) };
  });
  const maxConcession = Math.max(0, ...arrows.map((x) => x.move));

  const L = modelScale(a, b);
  const gapTol = 1e-4 * L;
  const tangentDeg = 0.25;
  const c1Tol = base.continuity === 'C1' ? 1e-2 : null;

  const score = (m: SeamMetrics, i: number) => {
    const s = m.samples[i];
    return Math.max(s.gap / gapTol, s.tangentPlaneDeg / tangentDeg, c1Tol ? s.c1Mismatch / c1Tol : 0);
  };
  const n = Math.min(before.samples.length, after.samples.length);
  const scoreBefore: number[] = [];
  const scoreAfter: number[] = [];
  for (let i = 0; i < n; i++) {
    scoreBefore.push(score(before, i));
    scoreAfter.push(score(after, i));
  }

  // Per-sample classifications. A sample is "bad before" when the locked solve
  // exceeds any active tolerance. "Eliminated" means release brings it within
  // tolerance; "relieved" means a >=50% score drop while still over tolerance.
  const badBefore = scoreBefore.map((v) => v > 1);
  const goodAfter = scoreAfter.map((v) => v <= 1);
  const eliminatedMask = badBefore.map((bad, i) => bad && goodAfter[i]);
  const relievedMask = badBefore.map(
    (bad, i) => bad && !goodAfter[i] && scoreBefore[i] >= 2 && scoreAfter[i] <= 0.5 * scoreBefore[i],
  );
  // Already inside tolerance, but release crushes a non-trivial residual.
  const improvedMask = badBefore.map(
    (bad, i) => !bad && scoreBefore[i] >= 0.1 && scoreAfter[i] <= 0.15 * scoreBefore[i],
  );

  const bridge = Math.max(2, Math.round(n * 0.02));
  const rawRanges = extractMaskRanges(eliminatedMask, bridge);
  const healed: HealedRange[] = rawRanges
    .filter(([i0, i1]) => i1 - i0 + 1 >= 2)
    .map(([i0, i1]) => makeRange('eliminated', i0, i1, n, before, after, scoreBefore, scoreAfter));

  const used = new Set<number>();
  for (const r of healed) for (let i = r.i0; i <= r.i1; i++) used.add(i);
  const relievedRanges = extractMaskRanges(
    relievedMask.map((v, i) => v && !used.has(i)),
    bridge,
  );
  const relieved: HealedRange[] = relievedRanges
    .filter(([i0, i1]) => i1 - i0 + 1 >= 2)
    .map(([i0, i1]) => makeRange('relieved', i0, i1, n, before, after, scoreBefore, scoreAfter));
  for (const r of relieved) for (let i = r.i0; i <= r.i1; i++) used.add(i);

  const improvedRanges = extractMaskRanges(
    improvedMask.map((v, i) => v && !used.has(i)),
    bridge,
  );
  const improved: HealedRange[] = improvedRanges
    .filter(([i0, i1]) => i1 - i0 + 1 >= 2)
    .map(([i0, i1]) => makeRange('improved', i0, i1, n, before, after, scoreBefore, scoreAfter));

  const badCount = badBefore.filter(Boolean).length;
  const healedRawCount = eliminatedMask.filter(Boolean).length;
  const edgeParticipates = maxConcession > 1e-6 * Math.max(1, L);
  return {
    edge,
    lockedA: lockedRes.a,
    lockedB: lockedRes.b,
    lockedReport: lockedRes.report,
    arrows,
    maxConcession,
    edgeParticipates,
    before,
    after,
    afterA: res.a,
    afterB: res.b,
    afterReport: res.report,
    healed,
    relieved,
    improved,
    healedFraction: badCount ? Math.min(1, healedRawCount / badCount) : 0,
    badFractionBefore: badCount / n,
    scoreBefore,
    scoreAfter,
    gapTol,
    tangentDeg,
    c1Tol,
  };
}

/** Extract true runs, bridging false gaps shorter than `bridge` samples. */
function extractMaskRanges(mask: boolean[], bridge: number): Array<[number, number]> {
  const n = mask.length;
  const closed = mask.slice();
  let i = 0;
  while (i < n) {
    if (closed[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !closed[j]) j++;
    if (i > 0 && j < n && j - i <= bridge) {
      for (let k = i; k < j; k++) closed[k] = true;
    }
    i = j;
  }
  const ranges: Array<[number, number]> = [];
  let start = -1;
  for (let k = 0; k <= n; k++) {
    const on = k < n && closed[k];
    if (on && start < 0) start = k;
    if (!on && start >= 0) {
      ranges.push([start, k - 1]);
      start = -1;
    }
  }
  return ranges;
}

function makeRange(
  kind: HealKind,
  i0: number,
  i1: number,
  n: number,
  before: SeamMetrics,
  after: SeamMetrics,
  scoreBefore: number[],
  scoreAfter: number[],
): HealedRange {
  let scoreBeforeMax = 0;
  let scoreAfterMax = 0;
  let gapBeforeMax = 0;
  let gapAfterMax = 0;
  let tanBeforeMax = 0;
  let tanAfterMax = 0;
  let c1BeforeMax = 0;
  let c1AfterMax = 0;
  const ratios: number[] = [];
  for (let i = i0; i <= i1; i++) {
    scoreBeforeMax = Math.max(scoreBeforeMax, scoreBefore[i]);
    scoreAfterMax = Math.max(scoreAfterMax, scoreAfter[i]);
    gapBeforeMax = Math.max(gapBeforeMax, before.samples[i].gap);
    gapAfterMax = Math.max(gapAfterMax, after.samples[i]?.gap ?? 0);
    tanBeforeMax = Math.max(tanBeforeMax, before.samples[i].tangentPlaneDeg);
    tanAfterMax = Math.max(tanAfterMax, after.samples[i]?.tangentPlaneDeg ?? 0);
    c1BeforeMax = Math.max(c1BeforeMax, before.samples[i].c1Mismatch);
    c1AfterMax = Math.max(c1AfterMax, after.samples[i]?.c1Mismatch ?? 0);
    if (scoreBefore[i] > 1e-9) ratios.push(Math.min(1, scoreAfter[i] / scoreBefore[i]));
  }
  const sorted = [...ratios].sort((x, y) => x - y);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
  return {
    kind,
    i0,
    i1,
    xi0: i0 / Math.max(1, n - 1),
    xi1: i1 / Math.max(1, n - 1),
    points: before.samples.slice(i0, i1 + 1).map((s) => s.pa),
    scoreBeforeMax,
    scoreAfterMax,
    gapBeforeMax,
    gapAfterMax,
    tanBeforeMax,
    tanAfterMax,
    c1BeforeMax,
    c1AfterMax,
    relief: Math.max(0, Math.min(1, 1 - med)),
  };
}

/** Map a lock edge to the actual boundary Side of the free patch. */
export function lockEdgeToSide(
  seamSide: Side,
  g: { crossAxis: 'u' | 'v'; seamRow: number },
  edge: LockEdge,
): Side {
  void seamSide;
  if (edge === 'opposite') {
    const farIsZero = g.seamRow !== 0;
    if (g.crossAxis === 'u') return farIsZero ? 'u0' : 'u1';
    return farIsZero ? 'v0' : 'v1';
  }
  if (g.crossAxis === 'u') {
    // along axis is v
    return edge === 'side0' ? 'v0' : 'v1';
  }
  // along axis is u
  return edge === 'side0' ? 'u0' : 'u1';
}
