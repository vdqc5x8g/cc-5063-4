import { Matrix, SVD } from 'ml-matrix';
import { basisFuns, findSpan } from './bspline.js';
import { Vec3 } from './vec.js';

/** Greville abscissae for n control points / degree p. */
export function greville(n: number, p: number, knots: number[]): number[] {
  const g: number[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 1; j <= p; j++) s += knots[i + j];
    g.push(s / p);
  }
  return g;
}

function collocationMatrix(n: number, p: number, knots: number[]): { A: Matrix; pts: number[] } {
  const g = greville(n, p, knots);
  const A = new Matrix(n, n);
  for (let i = 0; i < n; i++) {
    const span = findSpan(n, p, g[i], knots);
    const N = basisFuns(span, g[i], p, knots);
    for (let j = 0; j <= p; j++) A.set(i, span - p + j, N[j]);
  }
  return { A, pts: g };
}

/**
 * Interpolate a tensor-product B-spline surface through samples at Greville
 * abscissae. For polynomial generators in the spline space this reproduces the
 * surface exactly (up to floating point).
 */
export function interpolateSurface(
  nu: number,
  nv: number,
  pu: number,
  pv: number,
  ku: number[],
  kv: number[],
  fn: (u: number, v: number) => Vec3,
): Vec3[][] {
  const { A: Au, pts: gu } = collocationMatrix(nu, pu, ku);
  const { A: Av, pts: gv } = collocationMatrix(nv, pv, kv);
  const F = new Matrix(nu, nv);
  // Solve per coordinate separately.
  const coords: number[][][] = [[], [], []];
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) F.set(i, j, fn(gu[i], gv[j])[k]);
    // Au X = F
    const X = new SVD(Au, { autoTranspose: true }).solve(F); // nu x nv
    // X = C Av^T  =>  solve Av * C^T = X^T
    const Xt = X.transpose();
    const Ct = new SVD(Av, { autoTranspose: true }).solve(Xt); // nv x nu
    const C = Ct.transpose(); // nu x nv
    for (let i = 0; i < nu; i++) {
      coords[k][i] = [];
      for (let j = 0; j < nv; j++) coords[k][i][j] = C.get(i, j);
    }
  }
  const cps: Vec3[][] = [];
  for (let i = 0; i < nu; i++) {
    const row: Vec3[] = [];
    for (let j = 0; j < nv; j++) row.push([coords[0][i][j], coords[1][i][j], coords[2][i][j]]);
    cps.push(row);
  }
  return cps;
}

/** Rigid transform of a control net (affine invariance of B-splines). */
export function transformCps(
  cps: Vec3[][],
  t: { translate?: Vec3; rotateY?: number; rotateX?: number; rotateZ?: number; pivot?: Vec3 },
): Vec3[][] {
  const pivot = t.pivot ?? [0, 0, 0];
  const rx = t.rotateX ?? 0;
  const ry = t.rotateY ?? 0;
  const rz = t.rotateZ ?? 0;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const tr = t.translate ?? [0, 0, 0];
  const apply = (p: Vec3): Vec3 => {
    let x = p[0] - pivot[0];
    let y = p[1] - pivot[1];
    let z = p[2] - pivot[2];
    // rotate Z
    let x1 = x * cz - y * sz;
    let y1 = x * sz + y * cz;
    x = x1; y = y1;
    // rotate Y
    x1 = x * cy + z * sy;
    let z1 = -x * sy + z * cy;
    x = x1; z = z1;
    // rotate X
    y1 = y * cx - z * sx;
    z1 = y * sx + z * cx;
    y = y1; z = z1;
    return [x + pivot[0] + tr[0], y + pivot[1] + tr[1], z + pivot[2] + tr[2]];
  };
  return cps.map((row) => row.map(apply));
}
