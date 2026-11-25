/**
 * B-spline basis utilities for tensor-product surfaces.
 *
 * A surface is stored as a (nu x nv) grid of control points, with knot vectors
 * ku (length nu + pu + 1) and kv (length nv + pv + 1).
 *
 * Convention: u is the "column direction" / first parameter, v the second.
 * cps[i][j] is the control point for basis function i in u and j in v.
 */

export function clampedUniformKnots(n: number, p: number): number[] {
  // n control points, degree p, clamped at both ends.
  const m = n + p + 1;
  const inner = n - p;
  const knots: number[] = [];
  for (let i = 0; i < m; i++) {
    if (i <= p) knots.push(0);
    else if (i >= m - p - 1) knots.push(1);
    else {
      const k = i - p; // 1..inner-1
      knots.push(k / inner);
    }
  }
  return knots;
}

/** Clamped knot vector from interior breakpoints, each repeated `mult` times. */
export function knotsFromBreaks(p: number, breaks: number[], mults: number[] = []): number[] {
  const knots: number[] = [];
  for (let i = 0; i < p + 1; i++) knots.push(0);
  for (let b = 0; b < breaks.length; b++) {
    const mult = mults[b] ?? 1;
    const t = breaks[b];
    if (!(t > 0 && t < 1)) throw new Error(`interior break ${t} outside (0,1)`);
    for (let r = 0; r < mult; r++) knots.push(t);
  }
  for (let i = 0; i < p + 1; i++) knots.push(1);
  return knots;
}

/** Number of control points implied by a knot vector for degree p. */
export function cpCountFor(knots: number[], p: number): number {
  return knots.length - p - 1;
}

/** Clamped uniform knots for n control points and degree p. */
export function knotsFromInterior(n: number, p: number, interior: number[]): number[] {
  const knots = knotsFromBreaks(p, interior);
  const expected = n + p + 1;
  if (knots.length !== expected) {
    throw new Error(
      `knot vector length ${knots.length} != n+p+1 = ${expected}; ` +
        `with p=${p} and ${interior.length} simple interior breaks the control count is ${cpCountFor(knots, p)}`,
    );
  }
  return knots;
}

export function knotMultiplicity(knots: number[], t: number): number {
  let c = 0;
  for (const k of knots) if (Math.abs(k - t) < 1e-12) c++;
  return c;
}

/** Find the knot span index for parameter u. Returns i in [p, n-1]. */
export function findSpan(n: number, p: number, u: number, knots: number[]): number {
  if (u >= knots[n]) return n - 1; // n here = number of control points
  if (u <= knots[p]) return p;
  let lo = p;
  let hi = n;
  let mid = (lo + hi) >> 1;
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/** Non-vanishing basis functions N[0..p] at u (The NURBS Book A2.2). */
export function basisFuns(span: number, u: number, p: number, knots: number[]): number[] {
  const N = new Array(p + 1).fill(0);
  const left = new Array(p + 1).fill(0);
  const right = new Array(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom > 1e-15 ? N[r] / denom : 0;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/**
 * Basis functions and derivatives up to order d (The NURBS Book A2.3).
 * Returns ders[k][j] = k-th derivative of basis j.
 */
export function dersBasisFuns(
  span: number,
  u: number,
  p: number,
  order: number,
  knots: number[],
): number[][] {
  const d = Math.min(order, p);
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0));
  const ders = Array.from({ length: order + 1 }, () => new Array(p + 1).fill(0));
  const left = new Array(p + 1).fill(0);
  const right = new Array(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[j][r] > 1e-15 ? ndu[r][j - 1] / ndu[j][r] : 0;
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];

  // ndu[i][j] holds the value of local basis function i of degree j; indices
  // outside the triangle (i<0 or i>j) are zero.
  const nd = (i: number, j: number): number => (i >= 0 && i <= j ? ndu[i][j] : 0);

  const a: number[][] = [new Array(p + 1).fill(0), new Array(p + 1).fill(0)];
  for (let r = 0; r <= p; r++) {
    let s1 = 0;
    let s2 = 1;
    a[0][0] = 1;
    for (let k = 1; k <= d; k++) {
      let acc = 0;
      const rk = r - k;
      const pk = p - k;
      if (r >= k) {
        const den = ndu[pk + 1][rk];
        a[s2][0] = den !== 0 ? a[s1][0] / den : 0;
        acc = a[s2][0] * ndu[rk][pk];
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        const den = ndu[pk + 1][rk + j];
        a[s2][j] = den !== 0 ? (a[s1][j] - a[s1][j - 1]) / den : 0;
        acc += a[s2][j] * nd(rk + j, pk);
      }
      if (r <= pk) {
        const den = ndu[pk + 1][r];
        a[s2][k] = den !== 0 ? -a[s1][k - 1] / den : 0;
        acc += a[s2][k] * nd(r, pk);
      }
      ders[k][r] = acc;
      const tmp = s1;
      s1 = s2;
      s2 = tmp;
    }
  }
  let rr = p;
  for (let k = 1; k <= d; k++) {
    for (let j = 0; j <= p; j++) ders[k][j] *= rr;
    rr *= p - k;
  }
  return ders;
}

/** Non-zero basis indices and values at u. */
export function basisAt(n: number, p: number, u: number, knots: number[]): { idx: number[]; N: number[] } {
  const span = findSpan(n, p, u, knots);
  return { idx: Array.from({ length: p + 1 }, (_, j) => span - p + j), N: basisFuns(span, u, p, knots) };
}

/** Evaluate a 1D B-spline (vector-valued) at u. Pts length n. */
export function evalCurve1D(n: number, p: number, knots: number[], pts: number[], u: number): number {
  const span = findSpan(n, p, u, knots);
  const N = basisFuns(span, u, p, knots);
  let s = 0;
  for (let j = 0; j <= p; j++) s += N[j] * pts[span - p + j];
  return s;
}

/** Derivative (order 1 or 2) of a 1D B-spline at u, per axis array. */
export function evalCurve1DDeriv(
  n: number,
  p: number,
  knots: number[],
  pts: number[],
  u: number,
  order: number,
): number {
  const span = findSpan(n, p, u, knots);
  const d = dersBasisFuns(span, u, p, Math.min(order, p), knots);
  const o = Math.min(order, p);
  let s = 0;
  for (let j = 0; j <= p; j++) s += d[o][j] * pts[span - p + j];
  return s;
}

/** Boundary curves of a surface as 1D B-spline data (for fitting). */
export type BoundarySide = 'u0' | 'u1' | 'v0' | 'v1';
