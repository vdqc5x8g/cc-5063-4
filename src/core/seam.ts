import { Surface, evalSurface, surfaceDims } from './surface.js';
import { basisFuns, dersBasisFuns, findSpan } from './bspline.js';
import { Vec3, cross, norm } from './vec.js';

export type Side = 'u0' | 'u1' | 'v0' | 'v1';

export interface Coeff {
  i: number;
  j: number;
  w: number;
}

export interface SideGeom {
  crossAxis: 'u' | 'v';
  alongAxis: 'u' | 'v';
  seamRow: number;
  crossParam: 0 | 1;
  /** +1 when increasing the cross parameter points into the patch */
  inwardSign: 1 | -1;
}

export const SIDES: Side[] = ['u0', 'u1', 'v0', 'v1'];

export function sideLabel(side: Side): string {
  return side === 'u0' ? 'U = 0' : side === 'u1' ? 'U = 1' : side === 'v0' ? 'V = 0' : 'V = 1';
}

export function sideGeom(s: Surface, side: Side): SideGeom {
  const { nu, nv } = surfaceDims(s);
  switch (side) {
    case 'u0':
      return { crossAxis: 'u', alongAxis: 'v', seamRow: 0, crossParam: 0, inwardSign: 1 };
    case 'u1':
      return { crossAxis: 'u', alongAxis: 'v', seamRow: nu - 1, crossParam: 1, inwardSign: -1 };
    case 'v0':
      return { crossAxis: 'v', alongAxis: 'u', seamRow: 0, crossParam: 0, inwardSign: 1 };
    case 'v1':
      return { crossAxis: 'v', alongAxis: 'u', seamRow: nv - 1, crossParam: 1, inwardSign: -1 };
  }
}

export function alongCount(s: Surface, side: Side): number {
  const { nu, nv } = surfaceDims(s);
  return sideGeom(s, side).alongAxis === 'u' ? nu : nv;
}

export function crossCount(s: Surface, side: Side): number {
  const { nu, nv } = surfaceDims(s);
  return sideGeom(s, side).crossAxis === 'u' ? nu : nv;
}

const clampT = (t: number) => Math.min(Math.max(t, 0), 1);

/** Coefficients of the boundary position at parameter t. */
export function seamPosCoeffs(s: Surface, side: Side, t: number): Coeff[] {
  const { nu, nv } = surfaceDims(s);
  const g = sideGeom(s, side);
  const tt = clampT(t);
  const out: Coeff[] = [];
  if (g.crossAxis === 'u') {
    const span = findSpan(nv, s.pv, tt, s.kv);
    const N = basisFuns(span, tt, s.pv, s.kv);
    for (let b = 0; b <= s.pv; b++) out.push({ i: g.seamRow, j: span - s.pv + b, w: N[b] });
  } else {
    const span = findSpan(nu, s.pu, tt, s.ku);
    const N = basisFuns(span, tt, s.pu, s.ku);
    for (let a = 0; a <= s.pu; a++) out.push({ i: span - s.pu + a, j: g.seamRow, w: N[a] });
  }
  void nu;
  void nv;
  return out;
}

/** Coefficients of the derivative along the boundary. */
export function seamAlongCoeffs(s: Surface, side: Side, t: number): Coeff[] {
  const { nu, nv } = surfaceDims(s);
  const g = sideGeom(s, side);
  const tt = clampT(t);
  const out: Coeff[] = [];
  if (g.crossAxis === 'u') {
    const span = findSpan(nv, s.pv, tt, s.kv);
    const d = dersBasisFuns(span, tt, s.pv, 1, s.kv);
    for (let b = 0; b <= s.pv; b++) if (d[1][b] !== 0) out.push({ i: g.seamRow, j: span - s.pv + b, w: d[1][b] });
  } else {
    const span = findSpan(nu, s.pu, tt, s.ku);
    const d = dersBasisFuns(span, tt, s.pu, 1, s.ku);
    for (let a = 0; a <= s.pu; a++) if (d[1][a] !== 0) out.push({ i: span - s.pu + a, j: g.seamRow, w: d[1][a] });
  }
  void nu;
  void nv;
  return out;
}

/**
 * Coefficients of the cross-axis derivative at the seam. Touches the seam row
 * and the <degree> rows inward — geometric continuity cannot in general be
 * achieved by moving the seam row alone.
 */
export function seamCrossCoeffs(s: Surface, side: Side, t: number): Coeff[] {
  const { nu, nv } = surfaceDims(s);
  const g = sideGeom(s, side);
  const tt = clampT(t);
  const out: Coeff[] = [];
  if (g.crossAxis === 'u') {
    const u = g.crossParam;
    const su = findSpan(nu, s.pu, u, s.ku);
    const du = dersBasisFuns(su, u, s.pu, 1, s.ku);
    const sv = findSpan(nv, s.pv, tt, s.kv);
    const Nv = basisFuns(sv, tt, s.pv, s.kv);
    for (let a = 0; a <= s.pu; a++) {
      const ia = su - s.pu + a;
      for (let b = 0; b <= s.pv; b++) {
        const w = du[1][a] * Nv[b];
        if (w !== 0) out.push({ i: ia, j: sv - s.pv + b, w });
      }
    }
  } else {
    const v = g.crossParam;
    const sv = findSpan(nv, s.pv, v, s.kv);
    const dv = dersBasisFuns(sv, v, s.pv, 1, s.kv);
    const su = findSpan(nu, s.pu, tt, s.ku);
    const Nu = basisFuns(su, tt, s.pu, s.ku);
    for (let a = 0; a <= s.pu; a++) {
      for (let b = 0; b <= s.pv; b++) {
        const w = Nu[a] * dv[1][b];
        if (w !== 0) out.push({ i: su - s.pu + a, j: sv - s.pv + b, w });
      }
    }
  }
  return out;
}

export function evalCoeffs(cps: Vec3[][], coeffs: Coeff[]): Vec3 {
  let x = 0,
    y = 0,
    z = 0;
  for (const c of coeffs) {
    const p = cps[c.i][c.j];
    x += c.w * p[0];
    y += c.w * p[1];
    z += c.w * p[2];
  }
  return [x, y, z];
}

export interface SeamFrame {
  pt: Vec3;
  normal: Vec3;
  along: Vec3;
  /** cross-axis derivative as stored (not sign-adjusted) */
  cross: Vec3;
  /** derivative pointing into the patch */
  inward: Vec3;
}

export function seamFrame(s: Surface, side: Side, t: number): SeamFrame {
  const g = sideGeom(s, side);
  const tt = clampT(t);
  const u = g.crossAxis === 'u' ? g.crossParam : tt;
  const v = g.crossAxis === 'v' ? g.crossParam : tt;
  const e = evalSurface(s, u, v);
  const crossVec = g.crossAxis === 'u' ? e.dU : e.dV;
  const alongVec = g.alongAxis === 'u' ? e.dU : e.dV;
  return {
    pt: e.pt,
    normal: e.normal,
    along: alongVec,
    cross: crossVec,
    inward: [g.inwardSign * crossVec[0], g.inwardSign * crossVec[1], g.inwardSign * crossVec[2]],
  };
}

/** Build a seam coordinate sampler (arc length or parameter) for one boundary. */
interface SeamCoord {
  /** normalized seam coordinate xi in [0,1] -> boundary parameter */
  toParam: (xi: number) => number;
}

const ARC_RES = 192;

function seamCoord(s: Surface, side: Side, mode: 'arclength' | 'parameter'): SeamCoord {
  if (mode === 'parameter') return { toParam: (xi) => clampT(xi) };
  const n = ARC_RES;
  const arc: number[] = [0];
  let prev = seamFrame(s, side, 0).pt;
  for (let k = 1; k <= n; k++) {
    const p = seamFrame(s, side, k / n).pt;
    const dx = p[0] - prev[0];
    const dy = p[1] - prev[1];
    const dz = p[2] - prev[2];
    arc.push(arc[k - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz));
    prev = p;
  }
  const total = arc[n];
  if (!(total > 1e-15)) return { toParam: (xi) => clampT(xi) };
  for (let k = 0; k <= n; k++) arc[k] /= total;
  return {
    toParam(xi: number): number {
      const target = clampT(xi);
      let lo = 0;
      let hi = n;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arc[mid] <= target) lo = mid;
        else hi = mid;
      }
      const span = arc[hi] - arc[lo];
      const f = span > 1e-15 ? (target - arc[lo]) / span : 0;
      return (lo + f) / n;
    },
  };
}

export interface Correspondence {
  mode: 'arclength' | 'parameter';
  direction: 1 | -1;
  /** normalized seam coordinates (uniform) */
  xi: number[];
  /** parameter on side A */
  ta: number[];
  /** parameter on side B */
  tb: number[];
}

/** Direction that aligns the boundaries end-to-end by position (not index). */
export function autoDirection(a: Surface, sideA: Side, b: Surface, sideB: Side): 1 | -1 {
  const a0 = seamFrame(a, sideA, 0).pt;
  const a1 = seamFrame(a, sideA, 1).pt;
  const b0 = seamFrame(b, sideB, 0).pt;
  const b1 = seamFrame(b, sideB, 1).pt;
  const d = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  return d(a0, b0) + d(a1, b1) <= d(a0, b1) + d(a1, b0) ? 1 : -1;
}

export interface CorrespondenceSampler {
  at: (xi: number) => { ta: number; tb: number };
}

export function correspondenceSampler(
  a: Surface,
  sideA: Side,
  b: Surface,
  sideB: Side,
  mode: 'arclength' | 'parameter',
  direction: 1 | -1,
): CorrespondenceSampler {
  const ca = seamCoord(a, sideA, mode);
  const cb = seamCoord(b, sideB, mode);
  return {
    at(xi: number) {
      const x = clampT(xi);
      const xb = direction === 1 ? x : 1 - x;
      return { ta: ca.toParam(x), tb: cb.toParam(xb) };
    },
  };
}

/** Build correspondence arrays at a given number of samples. */
export function buildCorrespondence(
  a: Surface,
  sideA: Side,
  b: Surface,
  sideB: Side,
  n: number,
  direction: 1 | -1,
  mode: 'arclength' | 'parameter',
): Correspondence {
  const smp = correspondenceSampler(a, sideA, b, sideB, mode, direction);
  const xi: number[] = [];
  const ta: number[] = [];
  const tb: number[] = [];
  for (let k = 0; k <= n; k++) {
    const x = k / n;
    const p = smp.at(x);
    xi.push(x);
    ta.push(p.ta);
    tb.push(p.tb);
  }
  return { mode, direction, xi, ta, tb };
}

/** Resample a correspondence at higher density, preserving its mode and direction. */
export function resampleCorrespondence(
  a: Surface,
  sideA: Side,
  b: Surface,
  sideB: Side,
  corr: Correspondence,
  density: number,
): Array<{ ta: number; tb: number }> {
  const smp = correspondenceSampler(a, sideA, b, sideB, corr.mode, corr.direction);
  const out: Array<{ ta: number; tb: number }> = [];
  for (let k = 0; k <= density; k++) out.push(smp.at(k / density));
  return out;
}

export function seamNormal(s: Surface, side: Side, t: number): Vec3 {
  return seamFrame(s, side, t).normal;
}

/** Boundary samples (positions + unit normals), for picking and display. */
export function boundarySamples(
  s: Surface,
  side: Side,
  n: number,
): { pts: Vec3[]; normals: Vec3[]; params: number[] } {
  const pts: Vec3[] = [];
  const normals: Vec3[] = [];
  const params: number[] = [];
  for (let k = 0; k <= n; k++) {
    const f = seamFrame(s, side, k / n);
    pts.push(f.pt);
    normals.push(f.normal);
    params.push(k / n);
  }
  return { pts, normals, params };
}
