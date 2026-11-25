import {
  basisFuns,
  dersBasisFuns,
  findSpan,
  clampedUniformKnots,
  knotsFromInterior,
} from './bspline.js';
import { Vec3, add, sub, cross, mul, norm, len, dot } from './vec.js';

export interface Surface {
  /** cps[i][j], i in u-direction (length nu), j in v-direction (length nv). */
  cps: Vec3[][];
  ku: number[];
  kv: number[];
  pu: number;
  pv: number;
  name: string;
  /**
   * Declared normal orientation: normal = orientation * normalize(dU x dV).
   * Reversing a boundary walk flips dU x dV, so an orientation flag lets the
   * user declare which side of the patch is "outside" without altering shape.
   */
  orientation: 1 | -1;
}

export function surfaceDims(s: Surface): { nu: number; nv: number } {
  return { nu: s.cps.length, nv: s.cps[0].length };
}

export function makeSurface(
  nu: number,
  nv: number,
  pu: number,
  pv: number,
  cps: Vec3[][],
  opts: { ku?: number[]; kv?: number[]; name?: string; orientation?: 1 | -1 } = {},
): Surface {
  if (cps.length !== nu || cps.some((r) => r.length !== nv)) {
    throw new Error(`control net shape mismatch: expected ${nu}x${nv}`);
  }
  return {
    cps: cps.map((r) => r.map((p) => [p[0], p[1], p[2]] as Vec3)),
    ku: opts.ku ?? clampedUniformKnots(nu, pu),
    kv: opts.kv ?? clampedUniformKnots(nv, pv),
    pu,
    pv,
    name: opts.name ?? 'surface',
    orientation: opts.orientation ?? 1,
  };
}

export function cloneSurface(s: Surface): Surface {
  return makeSurface(s.cps.length, s.cps[0].length, s.pu, s.pv, s.cps, {
    ku: s.ku.slice(),
    kv: s.kv.slice(),
    name: s.name,
    orientation: s.orientation,
  });
}

/** Evaluate position, first derivatives, second derivatives and unit normal. */
export function evalSurface(s: Surface, u: number, v: number) {
  const { nu, nv } = surfaceDims(s);
  // Clamp parameter to valid domain
  const uc = Math.min(Math.max(u, 0), 1 - 1e-12);
  const vc = Math.min(Math.max(v, 0), 1 - 1e-12);
  const su = findSpan(nu, s.pu, uc, s.ku);
  const sv = findSpan(nv, s.pv, vc, s.kv);
  const du = dersBasisFuns(su, uc, s.pu, 2, s.ku);
  const dv = dersBasisFuns(sv, vc, s.pv, 2, s.kv);

  const pt: Vec3 = [0, 0, 0];
  const dU: Vec3 = [0, 0, 0];
  const dV: Vec3 = [0, 0, 0];
  const dUU: Vec3 = [0, 0, 0];
  const dUV: Vec3 = [0, 0, 0];
  const dVV: Vec3 = [0, 0, 0];

  for (let a = 0; a <= s.pu; a++) {
    const ia = su - s.pu + a;
    for (let b = 0; b <= s.pv; b++) {
      const jb = sv - s.pv + b;
      const P = s.cps[ia][jb];
      const Nu = du[0][a];
      const Nv = dv[0][b];
      const w = Nu * Nv;
      if (w !== 0) {
        pt[0] += w * P[0];
        pt[1] += w * P[1];
        pt[2] += w * P[2];
      }
      const wu = du[1][a] * Nv;
      if (wu !== 0) {
        dU[0] += wu * P[0];
        dU[1] += wu * P[1];
        dU[2] += wu * P[2];
      }
      const wv = Nu * dv[1][b];
      if (wv !== 0) {
        dV[0] += wv * P[0];
        dV[1] += wv * P[1];
        dV[2] += wv * P[2];
      }
      const wuu = du[2][a] * Nv;
      if (wuu !== 0) {
        dUU[0] += wuu * P[0];
        dUU[1] += wuu * P[1];
        dUU[2] += wuu * P[2];
      }
      const wuv = du[1][a] * dv[1][b];
      if (wuv !== 0) {
        dUV[0] += wuv * P[0];
        dUV[1] += wuv * P[1];
        dUV[2] += wuv * P[2];
      }
      const wvv = Nu * dv[2][b];
      if (wvv !== 0) {
        dVV[0] += wvv * P[0];
        dVV[1] += wvv * P[1];
        dVV[2] += wvv * P[2];
      }
    }
  }
  const n = mul(norm(cross(dU, dV)), s.orientation);
  return { pt, dU, dV, dUU, dUV, dVV, normal: n };
}

/** Evaluate a boundary isocurve, returns array of points and tangents. */
export function boundaryCurve(
  s: Surface,
  side: 'u0' | 'u1' | 'v0' | 'v1',
  samples: number,
): { pts: Vec3[]; tangents: Vec3[]; params: number[] } {
  const pts: Vec3[] = [];
  const tangents: Vec3[] = [];
  const params: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    let e;
    if (side === 'u0') e = evalSurface(s, 0, t);
    else if (side === 'u1') e = evalSurface(s, 1, t);
    else if (side === 'v0') e = evalSurface(s, t, 0);
    else e = evalSurface(s, t, 1);
    pts.push(e.pt);
    // tangent along the boundary curve
    tangents.push(side === 'u0' || side === 'u1' ? e.dV : e.dU);
    params.push(t);
  }
  return { pts, tangents, params };
}

/** Point and outward-ish normal on boundary at parameter t. */
export function boundaryPointNormal(
  s: Surface,
  side: 'u0' | 'u1' | 'v0' | 'v1',
  t: number,
): { pt: Vec3; normal: Vec3; dU: Vec3; dV: Vec3 } {
  let e;
  if (side === 'u0') e = evalSurface(s, 0, t);
  else if (side === 'u1') e = evalSurface(s, 1, t);
  else if (side === 'v0') e = evalSurface(s, t, 0);
  else e = evalSurface(s, t, 1);
  return { pt: e.pt, normal: e.normal, dU: e.dU, dV: e.dV };
}

/**
 * Rebuild a surface with a new control net, keeping knot vectors.
 * cps must match the current dims.
 */
export function withCps(s: Surface, cps: Vec3[][], name?: string): Surface {
  return makeSurface(s.cps.length, s.cps[0].length, s.pu, s.pv, cps, {
    ku: s.ku,
    kv: s.kv,
    name: name ?? s.name,
    orientation: s.orientation,
  });
}

export function withOrientation(s: Surface, orientation: 1 | -1): Surface {
  return makeSurface(s.cps.length, s.cps[0].length, s.pu, s.pv, s.cps, {
    ku: s.ku,
    kv: s.kv,
    name: s.name,
    orientation,
  });
}

/** Sample grid of positions for rendering / export. */
export function sampleGrid(s: Surface, nu: number, nv: number): Vec3[][] {
  const out: Vec3[][] = [];
  for (let i = 0; i <= nu; i++) {
    const u = i / nu;
    const row: Vec3[] = [];
    for (let j = 0; j <= nv; j++) row.push(evalSurface(s, u, j / nv).pt);
    out.push(row);
  }
  return out;
}

/** Boundary control points (poles) of a given side, in order along the boundary. */
export function boundaryControlPoints(s: Surface, side: 'u0' | 'u1' | 'v0' | 'v1'): Vec3[] {
  const { nu, nv } = surfaceDims(s);
  if (side === 'u0') return s.cps[0].map((p) => p as Vec3);
  if (side === 'u1') return s.cps[nu - 1].map((p) => p as Vec3);
  if (side === 'v0') return s.cps.map((r) => r[0]);
  return s.cps.map((r) => r[nv - 1]);
}

/** Number of control points along a boundary. */
export function boundaryControlCount(s: Surface, side: 'u0' | 'u1' | 'v0' | 'v1'): number {
  const { nu, nv } = surfaceDims(s);
  return side === 'u0' || side === 'u1' ? nv : nu;
}

/** Index into the control net for boundary control point k of a side. */
export function boundaryCpIndex(
  s: Surface,
  side: 'u0' | 'u1' | 'v0' | 'v1',
  k: number,
): [number, number] {
  const { nu, nv } = surfaceDims(s);
  if (side === 'u0') return [0, k];
  if (side === 'u1') return [nu - 1, k];
  if (side === 'v0') return [k, 0];
  return [k, nv - 1];
}

/** One-dimensional B-spline data for a boundary side (poles + knots + degree). */
export function boundaryCurveData(
  s: Surface,
  side: 'u0' | 'u1' | 'v0' | 'v1',
): { poles: Vec3[]; knots: number[]; degree: number } {
  if (side === 'u0' || side === 'u1') {
    return { poles: boundaryControlPoints(s, side), knots: s.kv.slice(), degree: s.pv };
  }
  return { poles: boundaryControlPoints(s, side), knots: s.ku.slice(), degree: s.pu };
}

/** Bounding box of control net. */
export function controlBounds(s: Surface): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const row of s.cps)
    for (const p of row)
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
  return { min, max };
}

/** Dibounding box center and scale of sampled positions. */
export function sampledBounds(s: Surface, n = 24): { min: Vec3; max: Vec3; center: Vec3; radius: number } {
  const g = sampleGrid(s, n, n);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const row of g)
    for (const p of row)
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
  const center = mul(add(min, max), 0.5);
  let radius = 0;
  for (const row of g)
    for (const p of row) radius = Math.max(radius, len(sub(p, center)));
  return { min, max, center, radius };
}

export { clampedUniformKnots, knotsFromInterior };
