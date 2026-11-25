import { Surface } from './surface.js';
import { Correspondence, Side, resampleCorrespondence, seamFrame, sideGeom } from './seam.js';
import { Vec3, angleBetween, dot, len, norm, sub, toDeg } from './vec.js';

export interface SeamSample {
  tA: number;
  tB: number;
  pa: Vec3;
  pb: Vec3;
  gap: number;
  na: Vec3;
  nb: Vec3;
  normalAngleDeg: number;
  /** angle between B's inward derivative and A's tangent plane (0 = tangent-plane continuous) */
  tangentPlaneDeg: number;
  /** |inward_B| / |inward_A| */
  speedRatio: number;
  /** |inward_B + inward_A| / |inward_A|  (0 = parametric C1 across the seam) */
  c1Mismatch: number;
  /** direction-aware along-tangent mismatch in degrees */
  alongMismatchDeg: number;
}

export interface SeamMetrics {
  samples: SeamSample[];
  maxGap: number;
  rmsGap: number;
  /** unoriented normal deviation: 0 = normals parallel, 90 = perpendicular */
  maxNormalAngleDeg: number;
  maxTangentPlaneDeg: number;
  maxAlongMismatchDeg: number;
  minSpeedRatio: number;
  maxSpeedRatio: number;
  maxC1Mismatch: number;
  /** true when the two analytic normals point to opposite sides (orientation mismatch) */
  facingOpposed: boolean;
  worstGapAt: { tA: number; tB: number } | null;
}

const mul = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

/** Angle between two unoriented surface normals, in degrees, range [0, 90]. */
function normalDeviationDeg(a: Vec3, b: Vec3): number {
  const deg = toDeg(angleBetween(a, b));
  return Number.isFinite(deg) ? Math.min(deg, 180 - deg) : NaN;
}

/**
 * Measure a seam between two analytic B-spline patches using geometric
 * correspondence (arc length or parameter) and boundary direction. The seam
 * row's control points are never matched by index.
 */
export function measureSeam(
  a: Surface,
  sideA: Side,
  b: Surface,
  sideB: Side,
  corr: Correspondence,
  density = 200,
): SeamMetrics {
  const pairs = resampleCorrespondence(a, sideA, b, sideB, corr, density);
  const samples: SeamSample[] = [];
  let maxGap = 0;
  let sumGap2 = 0;
  let maxNormal = 0;
  let maxTangent = 0;
  let maxAlong = 0;
  let minRatio = Infinity;
  let maxRatio = 0;
  let maxC1 = 0;
  let facingOpposed = false;
  let worstGapAt: SeamMetrics['worstGapAt'] = null;

  const gB = sideGeom(b, sideB);
  const dirSign = corr.direction;

  for (const { ta, tb } of pairs) {
    const fa = seamFrame(a, sideA, ta);
    const fb = seamFrame(b, sideB, tb);
    const gap = len(sub(fa.pt, fb.pt));
    const normalAngle = normalDeviationDeg(fa.normal, fb.normal);
    if (dot(fa.normal, fb.normal) < 0) facingOpposed = true;
    const inwardB = mul(fb.cross, gB.inwardSign);
    const tangentPlaneDev = Math.abs(90 - toDeg(angleBetween(fa.normal, inwardB)));
    const alongMismatch = toDeg(angleBetween(fa.along, mul(fb.along, dirSign)));
    const speedRatio = len(fa.inward) > 1e-15 ? len(inwardB) / len(fa.inward) : NaN;
    // C1 requires opposite inward derivatives of equal magnitude:
    //   inward_A = -inward_B  <=>  inward_A + inward_B = 0
    const sum: Vec3 = [fa.inward[0] + inwardB[0], fa.inward[1] + inwardB[1], fa.inward[2] + inwardB[2]];
    const c1Mismatch = len(fa.inward) > 1e-15 ? len(sum) / len(fa.inward) : len(sum);

    samples.push({
      tA: ta,
      tB: tb,
      pa: fa.pt,
      pb: fb.pt,
      gap,
      na: fa.normal,
      nb: fb.normal,
      normalAngleDeg: normalAngle,
      tangentPlaneDeg: tangentPlaneDev,
      speedRatio,
      c1Mismatch,
      alongMismatchDeg: alongMismatch,
    });

    if (gap > maxGap) {
      maxGap = gap;
      worstGapAt = { tA: ta, tB: tb };
    }
    sumGap2 += gap * gap;
    if (Number.isFinite(normalAngle)) maxNormal = Math.max(maxNormal, normalAngle);
    if (Number.isFinite(tangentPlaneDev)) maxTangent = Math.max(maxTangent, tangentPlaneDev);
    if (Number.isFinite(alongMismatch)) maxAlong = Math.max(maxAlong, alongMismatch);
    if (Number.isFinite(speedRatio)) {
      minRatio = Math.min(minRatio, speedRatio);
      maxRatio = Math.max(maxRatio, speedRatio);
    }
    if (Number.isFinite(c1Mismatch)) maxC1 = Math.max(maxC1, c1Mismatch);
  }

  return {
    samples,
    maxGap,
    rmsGap: Math.sqrt(sumGap2 / Math.max(1, samples.length)),
    maxNormalAngleDeg: maxNormal,
    maxTangentPlaneDeg: maxTangent,
    maxAlongMismatchDeg: maxAlong,
    minSpeedRatio: Number.isFinite(minRatio) ? minRatio : NaN,
    maxSpeedRatio: Number.isFinite(maxRatio) ? maxRatio : NaN,
    maxC1Mismatch: maxC1,
    facingOpposed,
    worstGapAt,
  };
}

/**
 * Export record. Both patches remain independent analytic surfaces; the
 * display seam polyline is a visual guide and is explicitly not a continuity
 * proof. Consumers should read `metrics` for the true error.
 */
export interface StitchedModel {
  a: Surface;
  b: Surface;
  sideA: Side;
  sideB: Side;
  correspondence: Correspondence;
  metrics: SeamMetrics;
  displaySeam: Vec3[];
}

export function buildStitchedModel(
  a: Surface,
  sideA: Side,
  b: Surface,
  sideB: Side,
  corr: Correspondence,
  density = 200,
): StitchedModel {
  const metrics = measureSeam(a, sideA, b, sideB, corr, density);
  const displaySeam = metrics.samples.map((s) => {
    const p = s.pa;
    const q = s.pb;
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2] as Vec3;
  });
  return { a, b, sideA, sideB, correspondence: corr, metrics, displaySeam };
}


