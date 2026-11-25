import { Surface, evalSurface, surfaceDims, boundaryCurve } from './surface.js';
import { Side, seamFrame } from './seam.js';
import { SeamMetrics } from './continuity.js';
import { Vec3 } from './vec.js';

export interface ExportOptions {
  /** samples per parameter direction for the mesh */
  resolution: number;
  /** include a dense analytic seam polyline */
  includeSeam: boolean;
  /** precision for control points in the JSON */
  precision?: number;
}

export interface ExportBundle {
  json: string;
  obj: string;
  csv: string;
  metricsText: string;
}

function fmt(n: number, digits = 9): string {
  if (!Number.isFinite(n)) return '0';
  const v = n.toFixed(digits);
  return v.replace(/\.?0+$/, '') || '0';
}

/** JSON record of both patches as analytic B-spline surfaces plus the seam report. */
export function exportJson(
  a: Surface,
  b: Surface,
  sideA: Side,
  sideB: Side,
  metrics: SeamMetrics,
  opts: ExportOptions,
): string {
  const surf = (s: Surface) => {
    const { nu, nv } = surfaceDims(s);
    return {
      name: s.name,
      degree: [s.pu, s.pv],
      controlPoints: s.cps.map((row) => row.map((p) => p.map((x) => +x.toFixed(opts.precision ?? 12)))),
      knots: { u: s.ku, v: s.kv },
      orientation: s.orientation,
      controlNetSize: [nu, nv],
    };
  };
  const rec = {
    format: 'surface-stitch-studio/analytic',
    note:
      'Each patch is kept as an independent analytic B-spline surface. ' +
      'The seam continuous-error metrics are computed analytically from the ' +
      'surfaces, not from a display mesh. The seam polyline is a visual guide only.',
    seam: {
      sideA,
      sideB,
      maxGap: metrics.maxGap,
      rmsGap: metrics.rmsGap,
      maxNormalAngleDeg: metrics.maxNormalAngleDeg,
      maxTangentPlaneDeg: metrics.maxTangentPlaneDeg,
      maxAlongMismatchDeg: metrics.maxAlongMismatchDeg,
      minSpeedRatio: metrics.minSpeedRatio,
      maxSpeedRatio: metrics.maxSpeedRatio,
      maxC1Mismatch: metrics.maxC1Mismatch,
    },
    surfaces: [surf(a), surf(b)],
  };
  return JSON.stringify(rec, null, 2);
}

/** Sample a patch grid. */
function gridPoints(s: Surface, res: number): Vec3[][] {
  const out: Vec3[][] = [];
  for (let i = 0; i <= res; i++) {
    const row: Vec3[] = [];
    for (let j = 0; j <= res; j++) row.push(evalSurface(s, i / res, j / res).pt);
    out.push(row);
  }
  return out;
}

/**
 * OBJ export. The two patches are written as separate objects and the seam is
 * exported as a polyline *plus* the measured gap, so a viewer cannot mistake a
 * welded display seam for a closed analytic surface.
 */
export function exportObj(
  a: Surface,
  b: Surface,
  sideA: Side,
  sideB: Side,
  metrics: SeamMetrics,
  opts: ExportOptions,
): string {
  const lines: string[] = [];
  lines.push('# surface-stitch-studio analytic export');
  lines.push(`# seam max gap = ${metrics.maxGap.toExponential(4)}`);
  lines.push(`# seam max tangent-plane deviation = ${metrics.maxTangentPlaneDeg.toFixed(4)} deg`);
  lines.push('# patches are independent; vertices are not welded across the seam');
  let offset = 1;
  const surfNames = ['A', 'B'];
  [a, b].forEach((s, si) => {
    const pts = gridPoints(s, opts.resolution);
    lines.push(`o ${surfNames[si]}_${s.name}`);
    for (const row of pts) for (const p of row) lines.push(`v ${fmt(p[0])} ${fmt(p[1])} ${fmt(p[2])}`);
    const res = opts.resolution;
    for (let i = 0; i < res; i++)
      for (let j = 0; j < res; j++) {
        const a0 = offset + i * (res + 1) + j;
        const a1 = a0 + 1;
        const b0 = a0 + (res + 1);
        const b1 = b0 + 1;
        lines.push(`f ${a0} ${b0} ${b1} ${a1}`);
      }
    offset += (res + 1) * (res + 1);
  });
  if (opts.includeSeam) {
    lines.push('o seam_polyline');
    const seamA: Vec3[] = [];
    for (const smp of metrics.samples) seamA.push(smp.pa);
    for (const p of seamA) lines.push(`v ${fmt(p[0])} ${fmt(p[1])} ${fmt(p[2])}`);
    for (let i = 0; i < seamA.length - 1; i++) lines.push(`l ${offset + i} ${offset + i + 1}`);
  }
  return lines.join('\n') + '\n';
}

/** Per-sample seam error table, for spreadsheets and independent checking. */
export function exportSeamCsv(metrics: SeamMetrics): string {
  const rows = ['tA,tB,gapX,gapY,gapZ,gap,normal_angle_deg,tangent_plane_dev_deg,speed_ratio,c1_mismatch'];
  for (const s of metrics.samples) {
    const gx = s.pb[0] - s.pa[0];
    const gy = s.pb[1] - s.pa[1];
    const gz = s.pb[2] - s.pa[2];
    rows.push(
      [
        fmt(s.tA, 8),
        fmt(s.tB, 8),
        fmt(gx, 9),
        fmt(gy, 9),
        fmt(gz, 9),
        fmt(s.gap, 12),
        fmt(s.normalAngleDeg, 6),
        fmt(s.tangentPlaneDeg, 6),
        fmt(s.speedRatio, 6),
        fmt(s.c1Mismatch, 12),
      ].join(','),
    );
  }
  return rows.join('\n') + '\n';
}

/** Human-readable seam report. */
export function exportMetricsText(
  a: Surface,
  b: Surface,
  sideA: Side,
  sideB: Side,
  metrics: SeamMetrics,
  extra: { mode: string; correspondence: string; fixed: string; movedCps: number; maxControlMove: number },
): string {
  const lines: string[] = [];
  lines.push('Surface stitch report');
  lines.push('=====================');
  lines.push(`Patch A: ${a.name}  degree (${a.pu},${a.pv})  net ${a.cps.length}x${a.cps[0].length}`);
  lines.push(`Patch B: ${b.name}  degree (${b.pu},${b.pv})  net ${b.cps.length}x${b.cps[0].length}`);
  lines.push(`Seam: A.${sideA}  <->  B.${sideB}`);
  lines.push(`Continuity requested: ${extra.mode}`);
  lines.push(`Correspondence: ${extra.correspondence}`);
  lines.push(`Fixed patch: ${extra.fixed}`);
  lines.push(`Control points moved: ${extra.movedCps}   max |delta| = ${extra.maxControlMove.toExponential(4)}`);
  lines.push('');
  lines.push('Analytic seam errors (evaluated on the true surfaces):');
  lines.push(`  position gap       max ${metrics.maxGap.toExponential(4)}   rms ${metrics.rmsGap.toExponential(4)}`);
  lines.push(`  normal angle       max ${metrics.maxNormalAngleDeg.toFixed(4)} deg`);
  lines.push(`  tangent-plane dev  max ${metrics.maxTangentPlaneDeg.toFixed(4)} deg`);
  lines.push(`  along-tangent dev  max ${metrics.maxAlongMismatchDeg.toFixed(4)} deg`);
  lines.push(`  speed ratio        ${metrics.minSpeedRatio.toFixed(4)} .. ${metrics.maxSpeedRatio.toFixed(4)}`);
  lines.push(`  C1 mismatch        max ${metrics.maxC1Mismatch.toExponential(4)}`);
  lines.push('');
  lines.push('Notes:');
  lines.push('- The seam polyline in OBJ/JSON is a display guide and is NOT a continuity proof.');
  lines.push('- Tangent-plane continuity (G1) does not imply equal parameter speed;');
  lines.push('  compare the speed ratio to distinguish G1 from C1.');
  return lines.join('\n') + '\n';
}

export function exportBundle(
  a: Surface,
  b: Surface,
  sideA: Side,
  sideB: Side,
  metrics: SeamMetrics,
  opts: ExportOptions,
  extra: { mode: string; correspondence: string; fixed: string; movedCps: number; maxControlMove: number },
): ExportBundle {
  return {
    json: exportJson(a, b, sideA, sideB, metrics, opts),
    obj: exportObj(a, b, sideA, sideB, metrics, opts),
    csv: exportSeamCsv(metrics),
    metricsText: exportMetricsText(a, b, sideA, sideB, metrics, extra),
  };
}
