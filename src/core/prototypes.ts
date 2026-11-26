import { Surface, makeSurface } from './surface.js';
import { interpolateSurface } from './fit.js';
import { clampedUniformKnots } from './bspline.js';
import { Side } from './seam.js';
import { Vec3 } from './vec.js';

/**
 * Controlled two-patch prototypes for the derivative-vs-tangent-plane route
 * comparison. Patch A occupies [0,1] x [0,1]; its u=1 edge is the seam.
 * Patch B starts at x=1 and its u=0 edge matches the same straight seam, while
 * its cross-boundary parameter speed is lambda(t) times A's unit speed.
 *
 * With lambda != 1 the tangent planes already agree (G1 holds for free) but
 * direct parametric derivative equality (C1) does not, isolating exactly the
 * continuity-model trade-off under study.
 */
export interface RoutePrototypeOptions {
  nuA?: number;
  nvA?: number;
  nuB?: number;
  nvB?: number;
  pA?: number;
  qA?: number;
  pB?: number;
  qB?: number;
  /** constant speed ratio when speedProfile is omitted */
  lambda?: number;
  /** varying cross speed ratio along the seam; overrides lambda */
  speedProfile?: (t: number) => number;
  /** extra z bow on B so tangency correction is genuinely required */
  bow?: number;
  nameA?: string;
  nameB?: string;
}

export interface RoutePrototype {
  a: Surface;
  b: Surface;
  sideA: Side;
  sideB: Side;
}

export function speedBumpProfile(center = 0.62, width = 0.16, amplitude = 1.6): (t: number) => number {
  return (t: number) => 1 + amplitude * Math.exp(-(((t - center) / width) ** 2));
}

export function makeRoutePrototype(opts: RoutePrototypeOptions = {}): RoutePrototype {
  const pA = opts.pA ?? 3;
  const qA = opts.qA ?? 3;
  const pB = opts.pB ?? 3;
  const qB = opts.qB ?? 3;
  const nuA = opts.nuA ?? 8;
  const nvA = opts.nvA ?? 9;
  const nuB = opts.nuB ?? opts.nuA ?? 8;
  const nvB = opts.nvB ?? opts.nvA ?? 9;
  const lambda = opts.lambda ?? 2;
  const profile = opts.speedProfile ?? (() => lambda);
  const bow = opts.bow ?? 0;

  const kuA = clampedUniformKnots(nuA, pA);
  const kvA = clampedUniformKnots(nvA, qA);
  const kuB = clampedUniformKnots(nuB, pB);
  const kvB = clampedUniformKnots(nvB, qB);

  const cpsA = interpolateSurface(nuA, nvA, pA, qA, kuA, kvA, (u, v) => [u, v, 0]);
  const cpsB = interpolateSurface(nuB, nvB, pB, qB, kuB, kvB, (s, t) => {
    const lam = profile(t);
    const x = 1 + s * lam;
    const y = t;
    const z = bow * s * s * Math.sin(Math.PI * t);
    return [x, y, z] as Vec3;
  });

  return {
    a: makeSurface(nuA, nvA, pA, qA, cpsA, { ku: kuA, kv: kvA, name: opts.nameA ?? '原型A' }),
    b: makeSurface(nuB, nvB, pB, qB, cpsB, { ku: kuB, kv: kvB, name: opts.nameB ?? '原型B' }),
    sideA: 'u1',
    sideB: 'u0',
  };
}
