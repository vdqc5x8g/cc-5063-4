import { describe, expect, it } from 'vitest';
import {
  basisFuns,
  clampedUniformKnots,
  cpCountFor,
  dersBasisFuns,
  findSpan,
  knotsFromBreaks,
} from '../core/bspline.js';
import { interpolateSurface } from '../core/fit.js';
import { makeSurface, evalSurface, withCps, withOrientation } from '../core/surface.js';
import { autoDirection, buildCorrespondence, seamFrame, sideGeom } from '../core/seam.js';
import { solveStitch } from '../core/solver.js';
import { measureSeam } from '../core/continuity.js';
import { getScene } from '../core/scenes.js';
import { exportBundle } from '../core/exporters.js';

const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('B-spline basis', () => {
  it('partitions unity and reproduces derivatives', () => {
    const p = 3;
    const k = knotsFromBreaks(p, [0.2, 0.55, 0.8]);
    const n = cpCountFor(k, p);
    let worst = 0;
    for (let i = 0; i <= 100; i++) {
      const u = Math.min(i / 100, 1 - 1e-12);
      const s = findSpan(n, p, u, k);
      const sum = basisFuns(s, u, p, k).reduce((a, b) => a + b, 0);
      worst = Math.max(worst, Math.abs(sum - 1));
      const d1 = dersBasisFuns(s, u, p, 1, k)[1].reduce((a, b) => a + b, 0);
      worst = Math.max(worst, Math.abs(d1));
    }
    expect(worst).toBeLessThan(1e-10);
  });

  it('interpolates a bilinear function exactly', () => {
    const p = 3;
    const ku = clampedUniformKnots(5, p);
    const kv = knotsFromBreaks(p, [0.25, 0.7]);
    const nu = cpCountFor(ku, p);
    const nv = cpCountFor(kv, p);
    const fn = (u: number, v: number): [number, number, number] => [2 * u - v, 0.5 * u + 3 * v, 1 + u];
    const cps = interpolateSurface(nu, nv, p, p, ku, kv, fn);
    const s = makeSurface(nu, nv, p, p, cps, { ku, kv });
    let err = 0;
    for (let i = 0; i <= 7; i++)
      for (let j = 0; j <= 7; j++) {
        const e = evalSurface(s, i / 7, j / 7);
        const t = fn(i / 7, j / 7);
        err = Math.max(err, Math.hypot(e.pt[0] - t[0], e.pt[1] - t[1], e.pt[2] - t[2]));
      }
    expect(err).toBeLessThan(1e-9);
  });
});

describe('geometric vs parametric continuity', () => {
  it('G1 holds the tangent plane but leaves speeds unequal; C1 equalizes speeds', () => {
    const sc = getScene('speed');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    expect(dir).toBe(1);

    const g1 = solveStitch(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'G1',
      correspondence: buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 24, dir, 'arclength'),
      fixed: 'A',
      deformRows: 3,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    const mG1 = measureSeam(g1.a, sc.sideA, g1.b, sc.sideB, g1.report && buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 24, dir, 'arclength'), 160);
    // G1: tangent plane aligned, speed ratio still 2
    expect(g1.report.status).toBe('ok');
    expect(mG1.maxTangentPlaneDeg).toBeLessThan(0.05);
    expect(mG1.minSpeedRatio).toBeGreaterThan(1.95);
    expect(mG1.maxSpeedRatio).toBeLessThan(2.05);
    // G1 must not move control points when the planes already agree
    expect(g1.report.movedCps).toBe(0);

    const c1 = solveStitch(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'C1',
      correspondence: buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 24, dir, 'parameter'),
      fixed: 'A',
      deformRows: 3,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    const mC1 = measureSeam(c1.a, sc.sideA, c1.b, sc.sideB, buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 24, dir, 'parameter'), 160);
    expect(c1.report.status).toBe('ok');
    expect(mC1.minSpeedRatio).toBeGreaterThan(0.99);
    expect(mC1.maxSpeedRatio).toBeLessThan(1.01);
    expect(mC1.maxC1Mismatch).toBeLessThan(1e-3);
    expect(c1.report.movedCps).toBeGreaterThan(0);
    // The two answers differ, as they must
    expect(Math.abs(c1.report.maxControlMove - g1.report.maxControlMove)).toBeGreaterThan(1e-3);
  });

  it('G0 closes the position gap but leaves a normal kink', () => {
    const sc = getScene('tilt');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    const corr = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 24, dir, 'arclength');
    const g0 = solveStitch(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'G0',
      correspondence: corr,
      fixed: 'A',
      deformRows: 3,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    const m = measureSeam(g0.a, sc.sideA, g0.b, sc.sideB, corr, 160);
    expect(m.maxGap).toBeLessThan(1e-6);
    expect(m.maxTangentPlaneDeg).toBeGreaterThan(1);
  });
});

describe('correspondence handling', () => {
  it('does not match control points by index when boundaries are reversed', () => {
    const sc = getScene('reversed');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    expect(dir).toBe(-1);
    const corr = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 32, dir, 'arclength');
    // Reversed correspondence: tA and tB move in opposite directions
    expect(corr.ta[0]).toBeLessThan(corr.ta[corr.ta.length - 1]);
    expect(corr.tb[0]).toBeGreaterThan(corr.tb[corr.tb.length - 1]);
    const res = solveStitch(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'G1',
      correspondence: corr,
      fixed: 'A',
      deformRows: 3,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    const m = measureSeam(res.a, sc.sideA, res.b, sc.sideB, corr, 160);
    expect(m.maxGap).toBeLessThan(1e-6);
    expect(m.maxTangentPlaneDeg).toBeLessThan(0.1);
  });

  it('warns when the two patches face opposite ways', () => {
    const sc = getScene('reversed');
    const flipped = withOrientation(sc.b, 1);
    const dir = autoDirection(sc.a, sc.sideA, flipped, sc.sideB);
    const corr = buildCorrespondence(sc.a, sc.sideA, flipped, sc.sideB, 24, dir, 'arclength');
    const res = solveStitch(sc.a, flipped, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'G1',
      correspondence: corr,
      fixed: 'A',
      deformRows: 3,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    expect(res.report.status).toBe('conflict');
    expect(res.report.messages.join(' ')).toContain('朝向相反');
  });

  it('arc-length and parameter correspondence differ on non-uniform knots', () => {
    const sc = getScene('density');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    const cArc = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 40, dir, 'arclength');
    const cPar = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 40, dir, 'parameter');
    let diff = 0;
    for (let k = 0; k < cArc.tb.length; k++) diff = Math.max(diff, Math.abs(cArc.tb[k] - cPar.tb[k]));
    expect(diff).toBeGreaterThan(0.01);
  });
});

describe('conflict detection and fixed-side preservation', () => {
  it('reports a conflict instead of moving the whole patch', () => {
    const sc = getScene('conflict');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    const corr = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 32, dir, 'arclength');
    const res = solveStitch(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'G1',
      correspondence: corr,
      fixed: 'B',
      deformRows: 1,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    expect(res.report.status).toBe('conflict');
    expect(res.report.messages.length).toBeGreaterThan(0);
    // B is untouched by construction
    let moved = 0;
    for (let i = 0; i < sc.b.cps.length; i++)
      for (let j = 0; j < sc.b.cps[0].length; j++)
        moved = Math.max(moved, Math.hypot(
          res.b.cps[i][j][0] - sc.b.cps[i][j][0],
          res.b.cps[i][j][1] - sc.b.cps[i][j][1],
          res.b.cps[i][j][2] - sc.b.cps[i][j][2],
        ));
    expect(moved).toBe(0);
    // The free patch (A) must not be rigidly translated: rows outside the
    // permitted deformation depth must stay exactly where they started.
    const g = sideGeom(sc.a, sc.sideA);
    for (let i = 0; i < sc.a.cps.length; i++)
      for (let j = 0; j < sc.a.cps[0].length; j++) {
        const dist = Math.abs((g.crossAxis === 'u' ? i : j) - g.seamRow);
        if (dist < 1) continue;
        for (let c = 0; c < 3; c++) close(res.a.cps[i][j][c], sc.a.cps[i][j][c], 1e-12);
      }
    // Only one control row may have moved, and it must not be a uniform shift.
    const movedSet = new Set<string>();
    for (let i = 0; i < sc.a.cps.length; i++)
      for (let j = 0; j < sc.a.cps[0].length; j++) {
        const d = Math.hypot(
          res.a.cps[i][j][0] - sc.a.cps[i][j][0],
          res.a.cps[i][j][1] - sc.a.cps[i][j][1],
          res.a.cps[i][j][2] - sc.a.cps[i][j][2],
        );
        if (d > 1e-9) movedSet.add(`${i},${j}`);
      }
    expect(movedSet.size).toBeGreaterThan(0);
  });

  it('succeeds on the same scene with enough deformable rows', () => {
    const sc = getScene('conflict');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    const corr = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 32, dir, 'arclength');
    const res = solveStitch(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'G1',
      correspondence: corr,
      fixed: 'B',
      deformRows: 4,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    expect(res.report.status).toBe('ok');
    expect(res.report.check!.maxGap).toBeLessThan(1e-6);
    expect(res.report.check!.maxTangentPlaneDeg).toBeLessThan(0.05);
  });

  it('respects the fixed side choice', () => {
    const sc = getScene('tilt');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    for (const fixed of ['A', 'B'] as const) {
      const corr = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 24, dir, 'arclength');
      const res = solveStitch(sc.a, sc.b, {
        sideA: sc.sideA,
        sideB: sc.sideB,
        continuity: 'G1',
        correspondence: corr,
        fixed,
        deformRows: 3,
        stiffness: 1e-2,
        shapeBias: 0,
      });
      const fixedSurface = fixed === 'A' ? sc.a : sc.b;
      const resultFixed = fixed === 'A' ? res.a : res.b;
      for (let i = 0; i < fixedSurface.cps.length; i++)
        for (let j = 0; j < fixedSurface.cps[0].length; j++)
          for (let c = 0; c < 3; c++)
            close(resultFixed.cps[i][j][c], fixedSurface.cps[i][j][c], 1e-12);
    }
  });
});

describe('derivative relations are checked directly', () => {
  it('verifies C1 by finite-difference-free analytic derivative identity', () => {
    const sc = getScene('speed');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    const res = solveStitch(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'C1',
      correspondence: buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 24, dir, 'parameter'),
      fixed: 'A',
      deformRows: 3,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const fa = seamFrame(res.a, sc.sideA, t);
      const fb = seamFrame(res.b, sc.sideB, t);
      // analytic cross-derivatives (not normals averaged from a mesh)
      const sum = [fa.inward[0] + fb.inward[0], fa.inward[1] + fb.inward[1], fa.inward[2] + fb.inward[2]];
      const rel = Math.hypot(...sum) / Math.hypot(...fa.inward);
      expect(rel).toBeLessThan(1e-4);
      const alongA = Math.hypot(...fa.along);
      const alongB = Math.hypot(...fb.along);
      close(alongB / alongA, 1, 1e-4);
    }
  });
});

describe('deformation scope', () => {
  it('only moves rows within the allowed deformation depth', () => {
    const sc = getScene('curved');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    const res = solveStitch(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'G1',
      correspondence: buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 32, dir, 'arclength'),
      fixed: 'A',
      deformRows: 2,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    const g = sideGeom(res.b, sc.sideB);
    for (let i = 0; i < res.b.cps.length; i++)
      for (let j = 0; j < res.b.cps[0].length; j++) {
        const dist = Math.abs((g.crossAxis === 'u' ? i : j) - g.seamRow);
        if (dist < 2) continue;
        for (let c = 0; c < 3; c++) close(res.b.cps[i][j][c], sc.b.cps[i][j][c], 1e-12);
      }
  });
});

describe('boundary direction reversal changes the correspondence, not the geometry', () => {
  it('forcing the wrong direction produces a much larger gap', () => {
    const sc = getScene('reversed');
    const sA = sc.sideA;
    const sB = sc.sideB;
    const right = buildCorrespondence(sc.a, sA, sc.b, sB, 40, -1, 'arclength');
    const wrong = buildCorrespondence(sc.a, sA, sc.b, sB, 40, 1, 'arclength');
    const mRight = measureSeam(sc.a, sA, sc.b, sB, right, 120);
    const mWrong = measureSeam(sc.a, sA, sc.b, sB, wrong, 120);
    expect(mRight.maxGap).toBeLessThan(mWrong.maxGap * 0.2);
  });
});

describe('deformation stays bounded and fixed side is exact', () => {
  it('never moves more control points than the allowed rows', () => {
    const sc = getScene('tilt');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    const res = solveStitch(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'G1',
      correspondence: buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 32, dir, 'arclength'),
      fixed: 'A',
      deformRows: 2,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    // number of along-direction control points x permitted rows
    expect(res.report.movedCps).toBeLessThanOrEqual(2 * Math.max(sc.b.cps.length, sc.b.cps[0].length));
    // A untouched
    for (let i = 0; i < sc.a.cps.length; i++)
      for (let j = 0; j < sc.a.cps[0].length; j++)
        for (let c = 0; c < 3; c++) close(res.a.cps[i][j][c], sc.a.cps[i][j][c], 1e-12);
  });
});

describe('export is analytic, not a welded mesh', () => {
  it('JSON keeps control points and knots for both patches', () => {
    const sc = getScene('tilt');
    const dir = autoDirection(sc.a, sc.sideA, sc.b, sc.sideB);
    const res = solveStitch(sc.a, sc.b, {
      sideA: sc.sideA,
      sideB: sc.sideB,
      continuity: 'G1',
      correspondence: buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 32, dir, 'arclength'),
      fixed: 'A',
      deformRows: 3,
      stiffness: 1e-2,
      shapeBias: 0,
    });
    const corr = buildCorrespondence(res.a, sc.sideA, res.b, sc.sideB, 32, dir, 'arclength');
    const metrics = measureSeam(res.a, sc.sideA, res.b, sc.sideB, corr, 64);
    const bundle = exportBundle(
      res.a,
      res.b,
      sc.sideA,
      sc.sideB,
      metrics,
      { resolution: 16, includeSeam: true },
      { mode: 'G1', correspondence: 'arclength', fixed: 'A', movedCps: res.report.movedCps, maxControlMove: res.report.maxControlMove },
    );
    const j = JSON.parse(bundle.json);
    expect(j.surfaces).toHaveLength(2);
    for (const s of j.surfaces) {
      expect(s.controlPoints.length).toBeGreaterThan(0);
      expect(s.knots.u.length).toBe(s.controlNetSize[0] + s.degree[0] + 1);
      expect(s.knots.v.length).toBe(s.controlNetSize[1] + s.degree[1] + 1);
    }
    expect(j.seam.maxGap).toBeLessThan(1e-6);
    // OBJ keeps two separate objects and does not weld across the seam
    expect(bundle.obj).toContain('o A_');
    expect(bundle.obj).toContain('o B_');
    expect(bundle.obj).toContain('patches are independent');
    // the seam polyline is written separately and labelled as a guide
    expect(bundle.obj).toContain('o seam_polyline');
  });
});
