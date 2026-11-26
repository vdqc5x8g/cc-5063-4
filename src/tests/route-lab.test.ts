import { describe, expect, it } from 'vitest';
import { getScene } from '../core/scenes.js';
import { buildCorrespondence } from '../core/seam.js';
import { solveStitch, noLocks, EdgeLocks } from '../core/solver.js';
import { measureSeam } from '../core/continuity.js';
import { makeRoutePrototype, speedBumpProfile } from '../core/prototypes.js';
import { compareRoutes, previewEdgeRelease } from '../core/route-lab.js';

const ALL_LOCKS: EdgeLocks = { opposite: true, side0: true, side1: true };

describe('G1 vs C1 route prototypes', () => {
  it('G1 keeps unequal parameter speed at ~zero shape cost; C1 forces ratio to 1', () => {
    const p = makeRoutePrototype({ lambda: 2 });
    const corr = buildCorrespondence(p.a, p.sideA, p.b, p.sideB, 64, 1, 'parameter');

    const g1 = solveStitch(p.a, p.b, {
      sideA: p.sideA,
      sideB: p.sideB,
      continuity: 'G1',
      correspondence: corr,
      fixed: 'A',
      deformRows: 3,
      stiffness: 1e-2,
      shapeBias: 0,
      edgeLocks: noLocks(),
    });
    const g1m = measureSeam(g1.a, p.sideA, g1.b, p.sideB, corr, 160);
    expect(g1.report.maxControlMove).toBeLessThan(1e-6);
    expect(g1m.maxTangentPlaneDeg).toBeLessThan(1e-3);
    expect(g1m.maxSpeedRatio).toBeGreaterThan(1.9);
    expect(g1m.minSpeedRatio).toBeLessThan(2.1);

    const c1 = solveStitch(p.a, p.b, {
      sideA: p.sideA,
      sideB: p.sideB,
      continuity: 'C1',
      correspondence: corr,
      fixed: 'A',
      deformRows: 3,
      stiffness: 1e-2,
      shapeBias: 0,
      edgeLocks: noLocks(),
    });
    const c1m = measureSeam(c1.a, p.sideA, c1.b, p.sideB, corr, 160);
    expect(c1m.maxC1Mismatch).toBeLessThan(1e-3);
    expect(Math.abs(c1m.maxSpeedRatio - 1)).toBeLessThan(0.02);
    // Real, measurable shape cost — never a coincident-CP fake tangency claim.
    expect(c1.report.maxControlMove).toBeGreaterThan(0.03);
    expect(c1.report.maxControlMove).toBeGreaterThan(1e4 * g1.report.maxControlMove);
  });

  it('compareRoutes returns DOF ranks and locates conflict clusters', () => {
    const p = makeRoutePrototype({ lambda: 2 });
    const cmp = compareRoutes(p.a, p.b, {
      sideA: p.sideA,
      sideB: p.sideB,
      direction: 1,
      correspondenceMode: 'parameter',
      fixed: 'A',
      deformRows: 3,
      stiffness: 1e-2,
      shapeBias: 0,
      edgeLocks: noLocks(),
      samples: 64,
    });
    expect(cmp.g1.dof.variables).toBeGreaterThan(0);
    expect(cmp.g1.dof.constraintRank).toBeGreaterThan(0);
    // C1 carries more independent constraints than G1.
    expect(cmp.c1.dof.constraintRank).toBeGreaterThanOrEqual(cmp.g1.dof.constraintRank);
    expect(['G1', 'C1']).toContain(cmp.recommendation);
    expect(cmp.recommendationReasons.length).toBeGreaterThan(0);
  });

  it('strict all-edge locks make the 1-row speed bump C1-exclusive, more rows relax it', () => {
    const proto = makeRoutePrototype({ speedProfile: speedBumpProfile(), nvA: 15, nvB: 15 });
    const cfg = (rows: number) => ({
      sideA: proto.sideA,
      sideB: proto.sideB,
      direction: 1 as const,
      correspondenceMode: 'parameter' as const,
      fixed: 'A' as const,
      deformRows: rows,
      stiffness: 1e-2,
      shapeBias: 0,
      edgeLocks: ALL_LOCKS,
      samples: 80,
    });
    const one = compareRoutes(proto.a, proto.b, cfg(1));
    expect(one.recommendation).toBe('G1');
    expect(one.g1.clusters.some((c) => c.level === 'exclusive')).toBe(true);

    const two = compareRoutes(proto.a, proto.b, cfg(2));
    // More freedom must not make the best attainable C1 mismatch worse.
    expect(two.c1.metrics.maxC1Mismatch).toBeLessThan(one.c1.metrics.maxC1Mismatch);
  });
});

describe('lock edge release preview', () => {
  const sc = getScene('locklab');
  const corr = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 64, 1, 'parameter');
  const base = {
    sideA: sc.sideA,
    sideB: sc.sideB,
    continuity: 'G1' as const,
    corr,
    fixed: (sc.fixed ?? 'A') as 'A',
    deformRows: sc.deformRows ?? 6,
    stiffness: 1e-2,
    shapeBias: 0,
    edgeLocks: ALL_LOCKS,
  };

  it('side1 materially participates and release eliminates the bad segment', () => {
    const pv = previewEdgeRelease(sc.a, sc.b, base, 'side1');
    expect(pv.edgeParticipates).toBe(true);
    expect(pv.maxConcession).toBeGreaterThan(0.1);
    expect(pv.badFractionBefore).toBeGreaterThan(0.3);
    expect(pv.healedFraction).toBeGreaterThan(0.5);
    expect(pv.healed.length).toBeGreaterThanOrEqual(1);
    // Analytic re-measurement after release is dramatically better.
    expect(pv.after.maxGap).toBeLessThan(1e-3);
    expect(pv.after.maxTangentPlaneDeg).toBeLessThan(0.25);
  });

  it('opposite far edge is non-participating on this cubic prototype', () => {
    const pv = previewEdgeRelease(sc.a, sc.b, base, 'opposite');
    expect(pv.edgeParticipates).toBe(false);
    expect(pv.maxConcession).toBeLessThan(1e-4);
    expect(pv.healed.length).toBe(0);
  });
});

describe('reversed boundary orientation', () => {
  it('correct -1 direction is ok; forced +1 stays facing-opposed even if gap closes', () => {
    const sc = getScene('reversed');
    for (const direction of [1, -1] as const) {
      const corr = buildCorrespondence(sc.a, sc.sideA, sc.b, sc.sideB, 80, direction, 'arclength');
      const res = solveStitch(sc.a, sc.b, {
        sideA: sc.sideA,
        sideB: sc.sideB,
        continuity: 'G1',
        correspondence: corr,
        fixed: sc.fixed ?? 'A',
        deformRows: sc.deformRows ?? 3,
        stiffness: 1e-2,
        shapeBias: 0,
        edgeLocks: noLocks(),
      });
      const m = measureSeam(res.a, sc.sideA, res.b, sc.sideB, corr, 200);
      if (direction === -1) {
        expect(m.facingOpposed).toBe(false);
        expect(res.report.status).toBe('ok');
        expect(m.maxTangentPlaneDeg).toBeLessThan(1e-2);
      } else {
        // Wrong correspondence: tiny solved gap does NOT imply valid continuity.
        expect(m.facingOpposed).toBe(true);
      }
    }
  });
});
