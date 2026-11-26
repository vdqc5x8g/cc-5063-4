import { Surface, cloneSurface } from '../core/surface.js';
import {
  ContinuityMode,
  FixedSide,
  EdgeLocks,
  LockEdge,
  noLocks,
  solveStitch,
} from '../core/solver.js';
import { buildCorrespondence, Side, autoDirection } from '../core/seam.js';
import { measureSeam } from '../core/continuity.js';
import { cpMoveStats, surfaceDeviation, deformationEnergy } from '../core/shape-cost.js';
import { makeRoutePrototype, speedBumpProfile } from '../core/prototypes.js';
import { SCENES } from '../core/scenes.js';
import {
  compareRoutes,
  previewEdgeRelease,
  RouteComparison,
  EdgeReleasePreview,
} from '../core/route-lab.js';

/**
 * Code-recomputed evidence for the seam-continuity experiment document.
 * Nothing here is hand-entered: every number comes from a real weighted-LS
 * solve followed by an independent analytic seam measurement. The JSON output
 * is diff-checked by `npm run experiments:check` and a vitest freshness test,
 * so the markdown tables cannot silently drift from the implementation.
 */

const SIG = 6;
export function rs(x: number | null | undefined, sig = SIG): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  if (x === 0) return 0;
  const y = Number(x.toPrecision(sig));
  return Object.is(y, -0) ? 0 : y;
}

const ALL_LOCKS: EdgeLocks = { opposite: true, side0: true, side1: true };

interface PairRefs {
  a: Surface;
  b: Surface;
  sideA: Side;
  sideB: Side;
}

interface SolveRow {
  status: string;
  maxGap: number | null;
  tangentDeg: number | null;
  normalDeg: number | null;
  c1: number | null;
  alongDeg: number | null;
  ratioMin: number | null;
  ratioMax: number | null;
  maxMove: number | null;
  rmsMove: number | null;
  surfDevMax: number | null;
  deformEnergy: number | null;
  variables: number;
  rank: number;
  constraintRank: number;
  nullity: number;
  facingOpposed: boolean;
}

function solvePair(
  refs: PairRefs,
  mode: ContinuityMode,
  opts: {
    fixed?: FixedSide;
    deformRows?: number;
    stiffness?: number;
    locks?: EdgeLocks;
    dir?: 1 | -1;
    corrMode?: 'arclength' | 'parameter';
    samples?: number;
    density?: number;
  } = {},
): SolveRow {
  const fixed = opts.fixed ?? 'A';
  const dir = opts.dir ?? 1;
  const corrMode = opts.corrMode ?? 'parameter';
  const corr = buildCorrespondence(
    refs.a,
    refs.sideA,
    refs.b,
    refs.sideB,
    opts.samples ?? 64,
    dir,
    corrMode,
  );
  const res = solveStitch(cloneSurface(refs.a), cloneSurface(refs.b), {
    sideA: refs.sideA,
    sideB: refs.sideB,
    continuity: mode,
    correspondence: corr,
    fixed,
    deformRows: opts.deformRows ?? 3,
    stiffness: opts.stiffness ?? 1e-2,
    shapeBias: 0,
    edgeLocks: opts.locks ?? noLocks(),
  });
  const m = measureSeam(res.a, refs.sideA, res.b, refs.sideB, corr, opts.density ?? 160);
  const before = fixed === 'A' ? refs.b : refs.a;
  const after = fixed === 'A' ? res.b : res.a;
  const move = cpMoveStats(before, after);
  const dev = surfaceDeviation(before, after, 24);
  return {
    status: res.report.status,
    maxGap: rs(m.maxGap),
    tangentDeg: rs(m.maxTangentPlaneDeg, 5),
    normalDeg: rs(m.maxNormalAngleDeg, 5),
    c1: rs(m.maxC1Mismatch),
    alongDeg: rs(m.maxAlongMismatchDeg, 5),
    ratioMin: rs(m.minSpeedRatio, 5),
    ratioMax: rs(m.maxSpeedRatio, 5),
    maxMove: rs(move.max),
    rmsMove: rs(move.rms),
    surfDevMax: rs(dev.max),
    deformEnergy: rs(deformationEnergy(before, after)),
    variables: res.report.variables,
    rank: res.report.rank,
    constraintRank: res.report.constraintRank,
    nullity: res.report.nullity,
    facingOpposed: m.facingOpposed,
  };
}

export interface VelocityRow {
  lambda: number;
  g1Move: number | null;
  g1Tan: number | null;
  g1Ratio: string;
  g1C1: number | null;
  c1Move: number | null;
  c1C1: number | null;
  c1Ratio: string;
  c1Dev: number | null;
  c1Energy: number | null;
}

function ratioStr(lo: number | null, hi: number | null): string {
  return lo === null || hi === null ? '—' : `${lo.toFixed(2)}–${hi.toFixed(2)}`;
}

function velocitySweep(): VelocityRow[] {
  const out: VelocityRow[] = [];
  for (const lambda of [1, 1.25, 1.5, 2, 3]) {
    const p = makeRoutePrototype({ lambda });
    const refs: PairRefs = { a: p.a, b: p.b, sideA: p.sideA, sideB: p.sideB };
    const g1 = solvePair(refs, 'G1', { deformRows: 3 });
    const c1 = solvePair(refs, 'C1', { deformRows: 3 });
    out.push({
      lambda,
      g1Move: g1.maxMove,
      g1Tan: g1.tangentDeg,
      g1Ratio: ratioStr(g1.ratioMin, g1.ratioMax),
      g1C1: g1.c1,
      c1Move: c1.maxMove,
      c1C1: c1.c1,
      c1Ratio: ratioStr(c1.ratioMin, c1.ratioMax),
      c1Dev: c1.surfDevMax,
      c1Energy: c1.deformEnergy,
    });
  }
  return out;
}

export interface DofRow {
  case: string;
  mode: ContinuityMode;
  variables: number;
  constraintRank: number;
  nullity: number;
}

function dofTable(): DofRow[] {
  const p = makeRoutePrototype({ lambda: 2 });
  const refs: PairRefs = { a: p.a, b: p.b, sideA: p.sideA, sideB: p.sideB };
  const rows: DofRow[] = [];
  for (const mode of ['G0', 'G1', 'C1'] as const) {
    const r = solvePair(refs, mode, { deformRows: 3 });
    rows.push({ case: 'λ=2，变形 3 行，无附加锁', mode, variables: r.variables, constraintRank: r.constraintRank, nullity: r.nullity });
  }
  for (const mode of ['G1', 'C1'] as const) {
    const r = solvePair(refs, mode, { deformRows: 8, locks: { ...noLocks(), opposite: true } });
    rows.push({ case: 'λ=2，全部 8 行可变形但锁住对侧边', mode, variables: r.variables, constraintRank: r.constraintRank, nullity: r.nullity });
  }
  return rows;
}

export interface ModelLockEvidence {
  noLock: CompactComparison;
  oppositeLocked: CompactComparison;
}

export interface CompactComparison {
  recommendation: 'G1' | 'C1';
  g1Status: string;
  c1Status: string;
  g1Tan: number | null;
  c1C1: number | null;
  g1Move: number | null;
  c1Move: number | null;
  c1Dev: number | null;
  nullityG1: number;
  nullityC1: number;
  exclusiveClusters: Array<{ xi0: number; xi1: number; level: string; maxC1: number | null; maxMoveC1: number | null }>;
  reasons: string[];
}

function compactComparison(cmp: RouteComparison): CompactComparison {
  return {
    recommendation: cmp.recommendation,
    g1Status: cmp.g1.status,
    c1Status: cmp.c1.status,
    g1Tan: rs(cmp.g1.metrics.maxTangentPlaneDeg, 5),
    c1C1: rs(cmp.c1.metrics.maxC1Mismatch),
    g1Move: rs(cmp.g1.move.max),
    c1Move: rs(cmp.c1.move.max),
    c1Dev: rs(cmp.c1.deviation.max),
    nullityG1: cmp.g1.dof.nullity,
    nullityC1: cmp.c1.dof.nullity,
    exclusiveClusters: cmp.c1.clusters.map((c) => ({
      xi0: rs(c.xi0, 4) ?? 0,
      xi1: rs(c.xi1, 4) ?? 0,
      level: c.level,
      maxC1: rs(c.maxC1Mismatch),
      maxMoveC1: rs(c.maxLocalMoveC1),
    })),
    reasons: cmp.recommendationReasons,
  };
}

function modelLockComparison(): ModelLockEvidence {
  const p = makeRoutePrototype({ lambda: 2 });
  const base = {
    sideA: p.sideA,
    sideB: p.sideB,
    direction: 1 as const,
    correspondenceMode: 'parameter' as const,
    fixed: 'A' as const,
    stiffness: 1e-2,
    shapeBias: 0,
    samples: 64,
    density: 160,
    moveBudgetFrac: 0.04,
  };
  const noLock = compareRoutes(p.a, p.b, { ...base, deformRows: 3, edgeLocks: noLocks() });
  const oppositeLocked = compareRoutes(p.a, p.b, {
    ...base,
    deformRows: 8,
    edgeLocks: { ...noLocks(), opposite: true },
  });
  return { noLock: compactComparison(noLock), oppositeLocked: compactComparison(oppositeLocked) };
}

export interface ReverseRow {
  direction: 1 | -1;
  stage: 'initial' | 'G1';
  maxGap: number | null;
  tangentDeg: number | null;
  opposed: boolean;
  status?: string;
}

function reverseExperiment(): ReverseRow[] {
  const sc = SCENES.find((s) => s.id === 'reversed')!;
  const out: ReverseRow[] = [];
  for (const direction of [1, -1] as const) {
    const corr = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 80, direction, 'arclength');
    const init = measureSeam(sc.a, sc.sideA, sc.b, sc.sideB, corr, 200);
    out.push({
      direction,
      stage: 'initial',
      maxGap: rs(init.maxGap),
      tangentDeg: rs(init.maxTangentPlaneDeg, 5),
      opposed: init.facingOpposed,
    });
    const r = solvePair(
      { a: sc.a, b: sc.b, sideA: sc.sideA, sideB: sc.sideB },
      'G1',
      { dir: direction, corrMode: 'arclength', fixed: sc.fixed ?? 'A', deformRows: sc.deformRows ?? 3 },
    );
    out.push({
      direction,
      stage: 'G1',
      maxGap: r.maxGap,
      tangentDeg: r.tangentDeg,
      opposed: r.facingOpposed,
      status: r.status,
    });
  }
  return out;
}

export interface DegreeRow {
  degrees: string;
  nu: number;
  nv: number;
  g1Move: number | null;
  g1Tan: number | null;
  g1Status: string;
  c1Move: number | null;
  c1C1: number | null;
  c1Status: string;
}

function degreeSweep(): DegreeRow[] {
  const cases: Array<{ label: string; pA: number; qA: number; pB: number; qB: number; n?: number }> = [
    { label: '2 / 2 同次', pA: 2, qA: 2, pB: 2, qB: 2, n: 7 },
    { label: '3 / 3 同次', pA: 3, qA: 3, pB: 3, qB: 3, n: 8 },
    { label: '4 / 4 同次', pA: 4, qA: 4, pB: 4, qB: 4, n: 9 },
    { label: 'A2 / B3 异次', pA: 2, qA: 2, pB: 3, qB: 3, n: 8 },
    { label: 'A3 / B4 异次', pA: 3, qA: 3, pB: 4, qB: 4, n: 9 },
  ];
  return cases.map((c) => {
    const p = makeRoutePrototype({
      lambda: 2,
      nuA: c.n,
      nvA: c.n! + 1,
      nuB: c.n,
      nvB: c.n! + 1,
      pA: c.pA,
      qA: c.qA,
      pB: c.pB,
      qB: c.qB,
    });
    const refs = { a: p.a, b: p.b, sideA: p.sideA, sideB: p.sideB };
    const g1 = solvePair(refs, 'G1', { deformRows: 3 });
    const c1 = solvePair(refs, 'C1', { deformRows: 3 });
    return {
      degrees: c.label,
      nu: c.n!,
      nv: c.n! + 1,
      g1Move: g1.maxMove,
      g1Tan: g1.tangentDeg,
      g1Status: g1.status,
      c1Move: c1.maxMove,
      c1C1: c1.c1,
      c1Status: c1.status,
    };
  });
}

export interface SceneRow {
  scene: string;
  mode: ContinuityMode;
  fixed: FixedSide;
  deformRows: number;
  status: string;
  maxGap: number | null;
  tangentDeg: number | null;
  c1: number | null;
  maxMove: number | null;
}

function sceneMatrix(): SceneRow[] {
  const out: SceneRow[] = [];
  for (const sc of SCENES) {
    const fixed = sc.fixed ?? 'A';
    const deformRows = sc.deformRows ?? 3;
    const direction = sc.direction ?? autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    for (const mode of ['G0', 'G1', 'C1'] as const) {
      const r = solvePair(
        { a: sc.a, b: sc.b, sideA: sc.sideA, sideB: sc.sideB },
        mode,
        {
          fixed,
          deformRows,
          locks: sc.edgeLocks,
          dir: direction,
          corrMode: sc.correspondenceMode ?? 'arclength',
        },
      );
      out.push({
        scene: sc.id,
        mode,
        fixed,
        deformRows,
        status: r.status,
        maxGap: r.maxGap,
        tangentDeg: r.tangentDeg,
        c1: r.c1,
        maxMove: r.maxMove,
      });
    }
  }
  return out;
}

export interface LockRow {
  scene: string;
  edge: LockEdge;
  baseLocks: string;
  participates: boolean;
  concession: number | null;
  beforeGap: number | null;
  afterGap: number | null;
  beforeTan: number | null;
  afterTan: number | null;
  beforeC1: number | null;
  afterC1: number | null;
  badFractionBefore: number | null;
  healedFractionOfBad: number | null;
  eliminatedRanges: number;
  relievedRanges: number;
  improvedRanges: number;
}

function previewToRow(sceneId: string, edge: LockEdge, baseLocks: EdgeLocks, pv: EdgeReleasePreview): LockRow {
  return {
    scene: sceneId,
    edge,
    baseLocks: JSON.stringify(baseLocks),
    participates: pv.edgeParticipates,
    concession: rs(pv.maxConcession),
    beforeGap: rs(pv.before.maxGap),
    afterGap: rs(pv.after.maxGap),
    beforeTan: rs(pv.before.maxTangentPlaneDeg, 5),
    afterTan: rs(pv.after.maxTangentPlaneDeg, 5),
    beforeC1: rs(pv.before.maxC1Mismatch),
    afterC1: rs(pv.after.maxC1Mismatch),
    badFractionBefore: rs(pv.badFractionBefore, 4),
    healedFractionOfBad: rs(pv.healedFraction, 4),
    eliminatedRanges: pv.healed.length,
    relievedRanges: pv.relieved.length,
    improvedRanges: pv.improved.length,
  };
}

function lockExperiments(): { rows: LockRow[]; bump: LockRow } {
  const sc = SCENES.find((s) => s.id === 'locklab')!;
  const corr = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 64, 1, 'parameter');
  const rows: LockRow[] = (['opposite', 'side0', 'side1'] as LockEdge[]).map((edge) => {
    const pv = previewEdgeRelease(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'G1',
      corr,
      fixed: sc.fixed ?? 'A',
      deformRows: sc.deformRows ?? 6,
      stiffness: 1e-2,
      shapeBias: 0,
      edgeLocks: ALL_LOCKS,
    }, edge);
    return previewToRow('locklab(all-locked)', edge, ALL_LOCKS, pv);
  });

  // Varying-speed prototype, two deform rows, all edges locked: a small
  // side1 concession should release the residual C1 mismatch.
  const bumpProto = makeRoutePrototype({ speedProfile: speedBumpProfile(), nvA: 15, nvB: 15 });
  const bumpCorr = buildCorrespondence(bumpProto.a, bumpProto.sideA, bumpProto.b, bumpProto.sideB, 80, 1, 'parameter');
  const bumpPv = previewEdgeRelease(bumpProto.a, bumpProto.b, {
    sideA: bumpProto.sideA,
    sideB: bumpProto.sideB,
    continuity: 'C1',
    corr: bumpCorr,
    fixed: 'A',
    deformRows: 2,
    stiffness: 1e-2,
    shapeBias: 0,
    edgeLocks: ALL_LOCKS,
  }, 'side1');
  const bump = previewToRow('bump(rows2,C1)', 'side1', ALL_LOCKS, bumpPv);
  return { rows, bump };
}

export interface BumpEvidence {
  ratioMin: number | null;
  ratioMax: number | null;
  rows1: CompactComparison;
  rows2: CompactComparison;
  releaseSide1: LockRow;
}

function bumpExperiment(releaseSide1: LockRow): BumpEvidence {
  const proto = makeRoutePrototype({ speedProfile: speedBumpProfile(), nvA: 15, nvB: 15 });
  const corr = buildCorrespondence(proto.a, proto.sideA, proto.b, proto.sideB, 120, 1, 'parameter');
  const initial = measureSeam(proto.a, proto.sideA, proto.b, proto.sideB, corr, 200);
  const cfg = (deformRows: number): Parameters<typeof compareRoutes>[2] => ({
    sideA: proto.sideA,
    sideB: proto.sideB,
    direction: 1,
    correspondenceMode: 'parameter',
    fixed: 'A',
    deformRows,
    stiffness: 1e-2,
    shapeBias: 0,
    edgeLocks: ALL_LOCKS,
    samples: 80,
    density: 160,
    moveBudgetFrac: 0.04,
  });
  const rows1 = compactComparison(compareRoutes(proto.a, proto.b, cfg(1)));
  const rows2 = compactComparison(compareRoutes(proto.a, proto.b, cfg(2)));
  return {
    ratioMin: rs(initial.minSpeedRatio, 5),
    ratioMax: rs(initial.maxSpeedRatio, 5),
    rows1,
    rows2,
    releaseSide1,
  };
}

export interface Evidence {
  schemaVersion: 1;
  note: string;
  velocity: VelocityRow[];
  dof: DofRow[];
  modelLock: ModelLockEvidence;
  bump: BumpEvidence;
  reverse: ReverseRow[];
  degrees: DegreeRow[];
  scenes: SceneRow[];
  locks: LockRow[];
}

export function runAllExperiments(): Evidence {
  const velocity = velocitySweep();
  const dof = dofTable();
  const modelLock = modelLockComparison();
  const reverse = reverseExperiment();
  const degrees = degreeSweep();
  const scenes = sceneMatrix();
  const lockBundle = lockExperiments();
  const bump = bumpExperiment(lockBundle.bump);
  return {
    schemaVersion: 1,
    note: 'All values computed by src/experiments/run.ts; regenerate with `npm run experiments`.',
    velocity,
    dof,
    modelLock,
    bump,
    reverse,
    degrees,
    scenes,
    locks: lockBundle.rows,
  };
}
