#!/usr/bin/env node
/**
 * Auxiliary command-line helper for the surface stitching workbench.
 *
 * The graphical viewport (npm run dev) is the primary interface; this CLI exists
 * for batch checks, regression runs and exporting the same analytic results.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCENES, getScene } from './core/scenes.js';
import { solveStitch, ContinuityMode, FixedSide } from './core/solver.js';
import { autoDirection, buildCorrespondence, SIDES, Side } from './core/seam.js';
import { measureSeam } from './core/continuity.js';
import { exportBundle } from './core/exporters.js';

interface Args {
  scene?: string;
  sideA?: Side;
  sideB?: Side;
  continuity?: ContinuityMode;
  fixed?: FixedSide;
  deformRows?: number;
  stiffness?: number;
  shapeBias?: number;
  samples?: number;
  correspondence?: 'arclength' | 'parameter';
  direction?: 1 | -1;
  out?: string;
  json?: boolean;
  list?: boolean;
  help?: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    const take = () => {
      i++;
      return v;
    };
    switch (k) {
      case '--scene':
        a.scene = take();
        break;
      case '--side-a':
        a.sideA = take() as Side;
        break;
      case '--side-b':
        a.sideB = take() as Side;
        break;
      case '--continuity':
        a.continuity = take() as ContinuityMode;
        break;
      case '--fixed':
        a.fixed = take() as FixedSide;
        break;
      case '--rows':
        a.deformRows = Number(take());
        break;
      case '--stiffness':
        a.stiffness = Number(take());
        break;
      case '--shape-bias':
        a.shapeBias = Number(take());
        break;
      case '--samples':
        a.samples = Number(take());
        break;
      case '--correspondence':
        a.correspondence = take() as 'arclength' | 'parameter';
        break;
      case '--direction':
        a.direction = Number(take()) as 1 | -1;
        break;
      case '--out':
        a.out = take();
        break;
      case '--json':
        a.json = true;
        break;
      case '--list':
        a.list = true;
        break;
      case '--help':
      case '-h':
        a.help = true;
        break;
      default:
        throw new Error(`unknown option: ${k}`);
    }
  }
  return a;
}

const HELP = `surface-stitch CLI — auxiliary helper (the GUI is the primary interface)

Usage:
  npm run cli -- --scene <id> [options]

Options:
  --list                     list available test scenes
  --scene <id>               scene id (default: tilt)
  --side-a <u0|u1|v0|v1>     boundary on patch A (default: scene value)
  --side-b <u0|u1|v0|v1>     boundary on patch B (default: scene value)
  --continuity <G0|G1|C1>    continuity condition (default: G1)
  --fixed <A|B>              patch that must not move (default: A)
  --rows <n>                 deformable control rows from the seam (default: 3)
  --stiffness <x>            shape-preservation stiffness (default: 1e-2)
  --shape-bias <x>           extra stiffness away from the seam (default: 0)
  --samples <n>              constraint samples along the seam (default: 48)
  --correspondence <mode>    arclength | parameter (default: arclength)
  --direction <1|-1>         boundary direction (default: auto)
  --out <dir>                write surfaces/seam report files into dir
  --json                     print the full result as JSON

Exit code is 0 on success, 2 on constraint conflict, 3 on degenerate solving.
`;

function main(): number {
  let args: Args;
  try {
    args = parse(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}\n`);
    console.error(HELP);
    return 1;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.list) {
    for (const sc of SCENES) {
      console.log(`${sc.id.padEnd(10)} ${sc.name}`);
      console.log(`           ${sc.description}`);
    }
    return 0;
  }

  const sceneId = args.scene ?? 'tilt';
  let scene;
  try {
    scene = getScene(sceneId);
  } catch {
    console.error(`error: unknown scene "${sceneId}". Use --list to see options.`);
    return 1;
  }

  const sideA = args.sideA ?? scene.sideA;
  const sideB = args.sideB ?? scene.sideB;
  for (const [name, s] of [
    ['--side-a', sideA],
    ['--side-b', sideB],
  ] as const) {
    if (!SIDES.includes(s)) {
      console.error(`error: ${name} must be one of ${SIDES.join(', ')}`);
      return 1;
    }
  }
  const continuity = args.continuity ?? scene.continuity;
  if (!['G0', 'G1', 'C1'].includes(continuity)) {
    console.error('error: --continuity must be G0, G1 or C1');
    return 1;
  }
  const fixed = args.fixed ?? 'A';
  if (fixed !== 'A' && fixed !== 'B') {
    console.error('error: --fixed must be A or B');
    return 1;
  }
  const samples = Math.max(6, args.samples ?? 48);
  const deformRows = Math.max(1, args.deformRows ?? 3);
  const stiffness = args.stiffness ?? 1e-2;
  const shapeBias = args.shapeBias ?? 0;
  const correspondence = args.correspondence ?? 'arclength';
  const direction = args.direction ?? autoDirection(scene.a, sideA, scene.b, sideB);

  const corr = buildCorrespondence(scene.a, sideA, scene.b, sideB, samples, direction, correspondence);
  const res = solveStitch(scene.a, scene.b, {
    sideA,
    sideB,
    continuity,
    correspondence: corr,
    fixed,
    deformRows,
    stiffness,
    shapeBias,
  });
  const metrics = measureSeam(res.a, sideA, res.b, sideB, corr, 240);

  const summary = {
    scene: sceneId,
    seam: { sideA, sideB, direction, correspondence, continuity, fixed, deformRows },
    status: res.report.status,
    messages: res.report.messages,
    move: { controlPoints: res.report.movedCps, maxDelta: res.report.maxControlMove },
    metrics: {
      maxGap: metrics.maxGap,
      rmsGap: metrics.rmsGap,
      maxNormalAngleDeg: metrics.maxNormalAngleDeg,
      maxTangentPlaneDeg: metrics.maxTangentPlaneDeg,
      maxAlongMismatchDeg: metrics.maxAlongMismatchDeg,
      speedRatio: [metrics.minSpeedRatio, metrics.maxSpeedRatio],
      maxC1Mismatch: metrics.maxC1Mismatch,
      facingOpposed: metrics.facingOpposed,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`scene      : ${sceneId}  (${scene.name})`);
    console.log(`seam       : A.${sideA} <-> B.${sideB}   direction ${direction}`);
    console.log(`condition  : ${continuity}   fixed ${fixed}   rows ${deformRows}   correspondence ${correspondence}`);
    console.log(`status     : ${res.report.status}`);
    if (res.report.messages.length) {
      for (const m of res.report.messages) console.log(`  note     : ${m}`);
    }
    console.log(`moved      : ${res.report.movedCps} control points, max |delta| = ${res.report.maxControlMove.toExponential(3)}`);
    console.log('seam errors (analytic):');
    console.log(`  gap              ${metrics.maxGap.toExponential(3)}  (rms ${metrics.rmsGap.toExponential(3)})`);
    console.log(`  normal angle     ${metrics.maxNormalAngleDeg.toFixed(4)} deg`);
    console.log(`  tangent plane    ${metrics.maxTangentPlaneDeg.toFixed(4)} deg`);
    console.log(`  along tangent    ${metrics.maxAlongMismatchDeg.toFixed(4)} deg`);
    console.log(`  speed ratio      ${metrics.minSpeedRatio.toFixed(4)} .. ${metrics.maxSpeedRatio.toFixed(4)}`);
    console.log(`  C1 mismatch      ${metrics.maxC1Mismatch.toExponential(3)}`);
  }

  if (args.out) {
    const dir = resolve(args.out);
    mkdirSync(dirname(dir + '/x'), { recursive: true });
    const bundle = exportBundle(
      res.a,
      res.b,
      sideA,
      sideB,
      metrics,
      { resolution: 64, includeSeam: true },
      {
        mode: continuity,
        correspondence,
        fixed,
        movedCps: res.report.movedCps,
        maxControlMove: res.report.maxControlMove,
      },
    );
    writeFileSync(resolve(dir, 'stitched-surfaces.json'), bundle.json);
    writeFileSync(resolve(dir, 'stitched-surfaces.obj'), bundle.obj);
    writeFileSync(resolve(dir, 'seam-errors.csv'), bundle.csv);
    writeFileSync(resolve(dir, 'stitch-report.txt'), bundle.metricsText);
    console.log(`\nwrote exports to ${dir}`);
  }

  if (res.report.status === 'conflict') return 2;
  if (res.report.status === 'degenerate') return 3;
  return 0;
}

process.exit(main());
