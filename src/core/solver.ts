import { Matrix, SVD } from 'ml-matrix';
import { Surface, surfaceDims, withCps } from './surface.js';
import {
  Correspondence,
  Side,
  seamAlongCoeffs,
  seamCrossCoeffs,
  seamFrame,
  seamPosCoeffs,
  sideGeom,
} from './seam.js';
import { measureSeam } from './continuity.js';
import { Vec3, dot } from './vec.js';

export type ContinuityMode = 'G0' | 'G1' | 'C1';
export type FixedSide = 'A' | 'B';

/**
 * The three non-seam boundary edges of the free patch. `opposite` is the row
 * farthest from the seam; `side0`/`side1` are the two along-direction ends.
 * Locking one removes its boundary control points from the unknowns, matching
 * a neighbouring face that already constrains that edge.
 */
export type LockEdge = 'opposite' | 'side0' | 'side1';
export type EdgeLocks = Record<LockEdge, boolean>;

export const ALL_LOCK_EDGES: LockEdge[] = ['opposite', 'side0', 'side1'];

export function noLocks(): EdgeLocks {
  return { opposite: false, side0: false, side1: false };
}

export interface StitchConfig {
  sideA: Side;
  sideB: Side;
  continuity: ContinuityMode;
  correspondence: Correspondence;
  /** patch that must not move */
  fixed: FixedSide;
  /** control rows counted from the seam (inclusive) that may move on the free patch */
  deformRows: number;
  /** shape-preservation stiffness relative to continuity rows (0 disables) */
  stiffness: number;
  /** extra stiffness per row away from the seam */
  shapeBias: number;
  /** explicit boundary-edge locks; omitted means no extra edge is locked */
  edgeLocks?: EdgeLocks;
}

export interface SolveReport {
  status: 'ok' | 'conflict' | 'degenerate';
  messages: string[];
  freeCps: number;
  fixedCps: number;
  variables: number;
  equalityRows: number;
  positionRows: number;
  tangentRows: number;
  rank: number;
  /** rank of the unregularized equality/constraint block */
  constraintRank: number;
  /** scalar unknowns minus constraint rank: formal null-space DOF */
  nullity: number;
  /** LS residual of the equality block (normalized) */
  residual: number;
  maxControlMove: number;
  /** RMS displacement over all free-patch control points */
  rmsControlMove: number;
  /** sum of control-point displacements */
  totalControlMove: number;
  movedCps: number;
  deformationRows: number;
  edgeLocks: EdgeLocks;
  /** maximum displacement measured on each (possibly locked) boundary edge */
  edgeMaxMove: Record<LockEdge, number>;
  /** analytic post-check of the produced seam */
  check: {
    maxGap: number;
    maxNormalAngleDeg: number;
    maxTangentPlaneDeg: number;
    maxAlongMismatchDeg: number;
    minSpeedRatio: number;
    maxSpeedRatio: number;
    maxC1Mismatch: number;
  } | null;
  tolerances: { gap: number; tangentDeg: number; c1: number };
}

export interface StitchResult {
  a: Surface;
  b: Surface;
  report: SolveReport;
}

interface FreeVar {
  i: number;
  j: number;
  varIndex: number;
  distance: number;
}

/** Control-point indices of the three non-seam boundary edges of a free patch. */
export function lockEdgeCpIndices(free: Surface, side: Side, edge: LockEdge): Array<[number, number]> {
  const g = sideGeom(free, side);
  const { nu, nv } = surfaceDims(free);
  const crossN = g.crossAxis === 'u' ? nu : nv;
  const alongN = g.crossAxis === 'u' ? nv : nu;
  const farCross = g.seamRow === 0 ? crossN - 1 : 0;
  const out: Array<[number, number]> = [];
  if (edge === 'opposite') {
    for (let a = 0; a < alongN; a++) {
      const i = g.crossAxis === 'u' ? farCross : a;
      const j = g.crossAxis === 'u' ? a : farCross;
      out.push([i, j]);
    }
  } else {
    const alongIdx = edge === 'side0' ? 0 : alongN - 1;
    for (let c = 0; c < crossN; c++) {
      const i = g.crossAxis === 'u' ? c : alongIdx;
      const j = g.crossAxis === 'u' ? alongIdx : c;
      out.push([i, j]);
    }
  }
  return out;
}

function isLockedEdgeCp(
  free: Surface,
  side: Side,
  locks: EdgeLocks,
  i: number,
  j: number,
): LockEdge | null {
  for (const e of ALL_LOCK_EDGES) {
    if (!locks[e]) continue;
    for (const [ei, ej] of lockEdgeCpIndices(free, side, e)) {
      if (ei === i && ej === j) return e;
    }
  }
  return null;
}

function freeVarList(free: Surface, side: Side, deformRows: number, locks: EdgeLocks): FreeVar[] {
  const g = sideGeom(free, side);
  const { nu, nv } = surfaceDims(free);
  const crossN = g.crossAxis === 'u' ? nu : nv;
  const alongN = g.crossAxis === 'u' ? nv : nu;
  const depth = Math.max(1, Math.min(deformRows, crossN));
  const out: FreeVar[] = [];
  let k = 0;
  for (let c = 0; c < crossN; c++) {
    const dist = Math.abs(c - g.seamRow);
    if (dist >= depth) continue;
    for (let a = 0; a < alongN; a++) {
      const i = g.crossAxis === 'u' ? c : a;
      const j = g.crossAxis === 'u' ? a : c;
      if (isLockedEdgeCp(free, side, locks, i, j)) continue;
      out.push({ i, j, varIndex: 3 * k, distance: dist });
      k++;
    }
  }
  return out;
}

export function modelScale(a: Surface, b: Surface): number {
  let mn = Infinity;
  let mx = -Infinity;
  for (const s of [a, b])
    for (const row of s.cps)
      for (const p of row)
        for (let c = 0; c < 3; c++) {
          const v = p[c];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
  return Math.max(1e-6, mx - mn);
}

const W_POSITION = 1e3;
const W_CONTINUITY = 1;
const DEFAULT_STIFFNESS = 1e-2;

/**
 * Solve for free-patch control points meeting the requested continuity
 * condition against the fixed patch.
 *
 * The free patch's selected control rows are the only unknowns; the fixed patch
 * is never altered. Position rows are weighted far above tangency rows so that
 * a tangent constraint that cannot be met is reported as a conflict rather than
 * silently traded against the position gap. The result is then re-measured
 * analytically to decide the status (never inferred from the mesh).
 */
export function solveStitch(aIn: Surface, bIn: Surface, cfg: StitchConfig): StitchResult {
  const a = aIn;
  const b = bIn;
  const freeIsB = cfg.fixed === 'A';
  const free = freeIsB ? b : a;
  const fixedS = freeIsB ? a : b;
  const freeSide = freeIsB ? cfg.sideB : cfg.sideA;
  const fixedSide = freeIsB ? cfg.sideA : cfg.sideB;
  const dirSign = cfg.correspondence.direction;
  const L = modelScale(a, b);
  const invL = 1 / L;

  const messages: string[] = [];
  const edgeLocks: EdgeLocks = cfg.edgeLocks ?? noLocks();
  const vars = freeVarList(free, freeSide, cfg.deformRows, edgeLocks);
  const map = new Map<string, FreeVar>();
  for (const v of vars) map.set(`${v.i},${v.j}`, v);
  const nVars = vars.length * 3;

  const report: SolveReport = {
    status: 'ok',
    messages,
    freeCps: vars.length,
    fixedCps: surfaceDims(fixedS).nu * surfaceDims(fixedS).nv,
    variables: nVars,
    equalityRows: 0,
    positionRows: 0,
    tangentRows: 0,
    rank: 0,
    constraintRank: 0,
    nullity: 0,
    residual: 0,
    maxControlMove: 0,
    rmsControlMove: 0,
    totalControlMove: 0,
    movedCps: 0,
    deformationRows: new Set(vars.map((v) => v.distance)).size,
    edgeLocks: { ...edgeLocks },
    edgeMaxMove: { opposite: 0, side0: 0, side1: 0 },
    check: null,
    tolerances: { gap: 1e-4, tangentDeg: 0.25, c1: 1e-2 },
  };

  const fail = (status: SolveReport['status'], msg: string): StitchResult => {
    messages.push(msg);
    return { a, b, report: { ...report, status } };
  };

  if (nVars === 0) {
    return fail('degenerate', '自由侧没有可移动的控制点（变形行数为 0），无法建立任何连续性约束。');
  }

  const rows: number[][] = [];
  const rhs: number[] = [];
  let positionRows = 0;
  let tangentRows = 0;
  const pushRow = (pairs: Array<[number, number]>, value: number) => {
    const row = new Array(nVars).fill(0);
    for (const [idx, val] of pairs) row[idx] += val;
    rows.push(row);
    rhs.push(value);
  };

  const corr = cfg.correspondence;
  const nSamples = corr.ta.length;

  for (let k = 0; k < nSamples; k++) {
    const tA = corr.ta[k];
    const tB = corr.tb[k];
    const tFree = freeIsB ? tB : tA;
    const tFixed = freeIsB ? tA : tB;
    const fixedFrame = seamFrame(fixedS, fixedSide, tFixed);
    const freeFrame = seamFrame(free, freeSide, tFree);
    const gFree = sideGeom(free, freeSide);

    // ---- position (all modes), weighted highest ----
    {
      const coeffs = seamPosCoeffs(free, freeSide, tFree);
      for (let c = 0; c < 3; c++) {
        const pairs: Array<[number, number]> = [];
        for (const cc of coeffs) {
          const v = map.get(`${cc.i},${cc.j}`);
          if (v) pairs.push([v.varIndex + c, cc.w * invL * W_POSITION]);
        }
        pushRow(pairs, (fixedFrame.pt[c] - freeFrame.pt[c]) * invL * W_POSITION);
        positionRows++;
      }
    }

    if (cfg.continuity === 'G1' || cfg.continuity === 'C1') {
      const crossCoeffs = seamCrossCoeffs(free, freeSide, tFree);
      if (cfg.continuity === 'G1') {
        // tangent plane: dot(n_fixed, inward_free) = 0
        const nA = fixedFrame.normal;
        const pairs: Array<[number, number]> = [];
        for (const cc of crossCoeffs) {
          const v = map.get(`${cc.i},${cc.j}`);
          if (!v) continue;
          for (let c = 0; c < 3; c++)
            pairs.push([v.varIndex + c, nA[c] * gFree.inwardSign * cc.w * invL * W_CONTINUITY]);
        }
        const currentInward = mulVec(freeFrame.cross, gFree.inwardSign);
        pushRow(pairs, -dot(nA, currentInward) * invL * W_CONTINUITY);
        tangentRows++;
      } else {
        // parametric C1: inward_free = -inward_fixed, along equal up to direction
        for (let c = 0; c < 3; c++) {
          const pairs: Array<[number, number]> = [];
          for (const cc of crossCoeffs) {
            const v = map.get(`${cc.i},${cc.j}`);
            if (v) pairs.push([v.varIndex + c, gFree.inwardSign * cc.w * invL * W_CONTINUITY]);
          }
          const target = -fixedFrame.inward[c];
          const current = gFree.inwardSign * freeFrame.cross[c];
          pushRow(pairs, (target - current) * invL * W_CONTINUITY);
          tangentRows++;
        }
        const alongCoeffs = seamAlongCoeffs(free, freeSide, tFree);
        for (let c = 0; c < 3; c++) {
          const pairs: Array<[number, number]> = [];
          for (const cc of alongCoeffs) {
            const v = map.get(`${cc.i},${cc.j}`);
            if (v) pairs.push([v.varIndex + c, cc.w * invL * W_CONTINUITY]);
          }
          pushRow(pairs, (dirSign * fixedFrame.along[c] - freeFrame.along[c]) * invL * W_CONTINUITY);
          tangentRows++;
        }
      }
    }
  }
  report.positionRows = positionRows;
  report.tangentRows = tangentRows;
  report.equalityRows = rows.length;

  // Rank of the pure constraint block (shape regularization not included), so
  // the reported DOF/nullity describes the continuity problem itself.
  if (rows.length > 0 && nVars > 0) {
    try {
      const cSvd = new SVD(new Matrix(rows), { autoTranspose: true });
      report.constraintRank = cSvd.rank;
      report.nullity = Math.max(0, nVars - cSvd.rank);
    } catch {
      report.constraintRank = 0;
    }
  }

  // Shape preservation: pull each free control point toward its current value,
  // stronger further from the seam so the deformation stays local.
  const regW = (cfg.stiffness > 0 ? cfg.stiffness : DEFAULT_STIFFNESS) * invL;
  for (const v of vars) {
    const bias = 1 + cfg.shapeBias * v.distance;
    for (let c = 0; c < 3; c++) {
      pushRow([[v.varIndex + c, regW * bias]], 0);
    }
  }

  let x: number[];
  try {
    const A = new Matrix(rows);
    const y = Matrix.columnVector(rhs);
    const svd = new SVD(A, { autoTranspose: true });
    report.rank = svd.rank;
    x = svd.solve(y).to1DArray();
  } catch (err) {
    return fail('degenerate', `线性求解失败：${(err as Error).message}`);
  }

  if (x.some((v) => !Number.isFinite(v))) {
    return fail('degenerate', '线性系统解包含非有限值，数值退化。');
  }

  let sumSq = 0;
  for (let r = 0; r < rows.length; r++) {
    let acc = 0;
    const row = rows[r];
    for (let c = 0; c < nVars; c++) acc += row[c] * x[c];
    const res = acc - rhs[r];
    sumSq += res * res;
  }
  report.residual = Math.sqrt(sumSq / Math.max(1, rows.length));

  const newCps = free.cps.map((row) => row.map((p) => [p[0], p[1], p[2]] as Vec3));
  let maxMove = 0;
  let moved = 0;
  let sumMove = 0;
  let sumMove2 = 0;
  for (const v of vars) {
    const d: Vec3 = [x[v.varIndex], x[v.varIndex + 1], x[v.varIndex + 2]];
    const m = Math.hypot(d[0], d[1], d[2]);
    if (m > maxMove) maxMove = m;
    if (m > 1e-9 * L) moved++;
    sumMove += m;
    sumMove2 += m * m;
    const q = newCps[v.i][v.j];
    newCps[v.i][v.j] = [q[0] + d[0], q[1] + d[1], q[2] + d[2]];
  }
  report.maxControlMove = maxMove;
  report.totalControlMove = sumMove;
  report.rmsControlMove = vars.length ? Math.sqrt(sumMove2 / vars.length) : 0;
  report.movedCps = moved;

  for (const e of ALL_LOCK_EDGES) {
    let edgeMax = 0;
    for (const [i, j] of lockEdgeCpIndices(free, freeSide, e)) {
      const p0 = free.cps[i][j];
      const p1 = newCps[i][j];
      edgeMax = Math.max(edgeMax, Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]));
    }
    report.edgeMaxMove[e] = edgeMax;
  }

  const newFree = withCps(free, newCps, free.name);
  const resultA = freeIsB ? a : newFree;
  const resultB = freeIsB ? newFree : b;

  // Independent analytic verification of the produced seam.
  const m = measureSeam(resultA, cfg.sideA, resultB, cfg.sideB, corr, 160);
  const check = {
    maxGap: m.maxGap,
    maxNormalAngleDeg: m.maxNormalAngleDeg,
    maxTangentPlaneDeg: m.maxTangentPlaneDeg,
    maxAlongMismatchDeg: m.maxAlongMismatchDeg,
    minSpeedRatio: m.minSpeedRatio,
    maxSpeedRatio: m.maxSpeedRatio,
    maxC1Mismatch: m.maxC1Mismatch,
  };
  report.check = check;

  const gapTol = report.tolerances.gap * L;
  let status: SolveReport['status'] = 'ok';

  if (check.maxGap > gapTol) {
    status = 'conflict';
    messages.push(
      `位置约束无法满足：接缝最大间隙 ${check.maxGap.toExponential(3)} 超过容差 ${gapTol.toExponential(3)}。` +
        `可尝试增大变形行数、切换固定侧，或放宽内部形态偏好。`,
    );
  }
  if (cfg.continuity === 'G1' && check.maxTangentPlaneDeg > report.tolerances.tangentDeg) {
    status = 'conflict';
    messages.push(
      `切平面连续未达成：自由侧横向导数偏离固定侧切平面 ${check.maxTangentPlaneDeg.toFixed(3)}°，` +
        `超过容差 ${report.tolerances.tangentDeg}°。通常意味着变形行数不足或固定侧选择受限。`,
    );
  }
  if ((cfg.continuity === 'G1' || cfg.continuity === 'C1') && m.facingOpposed) {
    status = 'conflict';
    messages.push(
      '两侧曲面法向朝向相反：接缝处片体彼此背面相对，这在几何上不是可缝合的一致朝向。' +
        '请检查邻片的参数方向或翻转其法向，而不是靠移动控制点掩盖。',
    );
  }
  if (cfg.continuity === 'C1' && check.maxC1Mismatch > report.tolerances.c1) {
    status = 'conflict';
    messages.push(
      `参数 C1 未达成：|∂A + ∂B|/|∂A| 最大 ${check.maxC1Mismatch.toExponential(3)}，超过容差 ${report.tolerances.c1}。` +
        `参数连续要求两侧横向导数完全相等，不同参数速度下往往与几何约束冲突。`,
    );
  }
  if (cfg.continuity === 'C1' && corr.mode !== 'parameter') {
    messages.push('提示：参数 C1 的意义依赖参数对应；当前使用弧长对应，切向速度按各自自然参数比较。');
  }
  if (status === 'ok') {
    messages.push(
      `自由侧 ${freeIsB ? 'B' : 'A'} 已调整 ${moved} 个控制点（最大位移 ${maxMove.toPrecision(4)}），` +
        `固定侧未改动。`,
    );
  }
  return { a: resultA, b: resultB, report: { ...report, status } };
}

function mulVec(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}
