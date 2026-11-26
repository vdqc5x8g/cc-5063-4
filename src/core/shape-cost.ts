import { Surface, evalSurface } from './surface.js';
import { Vec3 } from './vec.js';

export interface MoveStats {
  max: number;
  rms: number;
  sum: number;
  moved: number;
}

/** Control-point displacement statistics between two same-sized control nets. */
export function cpMoveStats(before: Surface, after: Surface): MoveStats {
  let max = 0;
  let sum = 0;
  let sum2 = 0;
  let count = 0;
  let moved = 0;
  const ni = Math.min(before.cps.length, after.cps.length);
  const nj = Math.min(before.cps[0].length, after.cps[0].length);
  for (let i = 0; i < ni; i++)
    for (let j = 0; j < nj; j++) {
      const p = before.cps[i][j];
      const q = after.cps[i][j];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      max = Math.max(max, d);
      sum += d;
      sum2 += d * d;
      count++;
      if (d > 1e-9) moved++;
    }
  return { max, rms: count ? Math.sqrt(sum2 / count) : 0, sum, moved };
}

/**
 * Discrete bending energy of a control net: sum of squared second differences
 * in both grid directions. This is a comparable shape-cost proxy between two
 * solves of the same patch, not a physical strain measure.
 */
export function controlNetEnergy(s: Surface): number {
  let e = 0;
  const d2 = (a: Vec3, b: Vec3, c: Vec3) => {
    for (let k = 0; k < 3; k++) {
      const v = a[k] - 2 * b[k] + c[k];
      e += v * v;
    }
  };
  for (let i = 0; i < s.cps.length; i++)
    for (let j = 1; j < s.cps[i].length - 1; j++) d2(s.cps[i][j - 1], s.cps[i][j], s.cps[i][j + 1]);
  for (let i = 1; i < s.cps.length - 1; i++)
    for (let j = 0; j < s.cps[i].length; j++) d2(s.cps[i - 1][j], s.cps[i][j], s.cps[i + 1][j]);
  return e;
}

/** Bending energy carried by the displacement field itself (zero before). */
export function deformationEnergy(before: Surface, after: Surface): number {
  const delta: Vec3[][] = before.cps.map((row, i) =>
    row.map((p, j) => {
      const q = after.cps[i][j];
      return [q[0] - p[0], q[1] - p[1], q[2] - p[2]] as Vec3;
    }),
  );
  let e = 0;
  const d2 = (a: Vec3, b: Vec3, c: Vec3) => {
    for (let k = 0; k < 3; k++) {
      const v = a[k] - 2 * b[k] + c[k];
      e += v * v;
    }
  };
  for (let i = 0; i < delta.length; i++)
    for (let j = 1; j < delta[i].length - 1; j++) d2(delta[i][j - 1], delta[i][j], delta[i][j + 1]);
  for (let i = 1; i < delta.length - 1; i++)
    for (let j = 0; j < delta[i].length; j++) d2(delta[i - 1][j], delta[i][j], delta[i + 1][j]);
  return e;
}

export interface SurfaceDeviation {
  max: number;
  rms: number;
  samples: number;
}

/**
 * Geometric deformation: distance between the two surfaces at identical
 * parameters. Used as the true "形变" number, independent of control counts.
 */
export function surfaceDeviation(before: Surface, after: Surface, n = 28): SurfaceDeviation {
  let max = 0;
  let sum2 = 0;
  let count = 0;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    for (let j = 0; j <= n; j++) {
      const v = j / n;
      const p = evalSurface(before, u, v).pt;
      const q = evalSurface(after, u, v).pt;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      max = Math.max(max, d);
      sum2 += d * d;
      count++;
    }
  }
  return { max, rms: Math.sqrt(sum2 / Math.max(1, count)), samples: count };
}
