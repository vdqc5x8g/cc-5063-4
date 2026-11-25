import { Scene, SCENES, getScene } from '../core/scenes.js';
import { Surface, cloneSurface, withOrientation } from '../core/surface.js';
import { ContinuityMode, FixedSide, SolveReport, StitchResult, solveStitch } from '../core/solver.js';
import { buildCorrespondence, autoDirection, Correspondence, Side } from '../core/seam.js';
import { SeamMetrics, measureSeam } from '../core/continuity.js';

export interface AppState {
  scene: Scene;
  a: Surface;
  b: Surface;
  sideA: Side;
  sideB: Side;
  continuity: ContinuityMode;
  correspondenceMode: 'arclength' | 'parameter';
  direction: 1 | -1;
  fixed: FixedSide;
  deformRows: number;
  stiffness: number;
  shapeBias: number;
  samples: number;
  result: StitchResult | null;
  metrics: SeamMetrics | null;
  statusText: string;
  statusKind: 'ok' | 'conflict' | 'degenerate' | 'info';
  /** base surfaces before any solve (for reset) */
  baseA: Surface;
  baseB: Surface;
}

export type Listener = (state: AppState) => void;

export class AppStore {
  state: AppState;
  private listeners = new Set<Listener>();

  constructor(sceneId = 'tilt') {
    const scene = getScene(sceneId);
    const dir = autoDirection(scene.a, scene.sideA, scene.b, scene.sideB);
    this.state = {
      scene,
      a: cloneSurface(scene.a),
      b: cloneSurface(scene.b),
      sideA: scene.sideA,
      sideB: scene.sideB,
      continuity: scene.continuity,
      correspondenceMode: 'arclength',
      direction: dir,
      fixed: scene.fixed ?? 'A',
      deformRows: scene.deformRows ?? 3,
      stiffness: 1e-2,
      shapeBias: 0,
      samples: 48,
      result: null,
      metrics: null,
      statusText: '尚未求解。调整接边条件后点击“求解拼接”。',
      statusKind: 'info',
      baseA: cloneSurface(scene.a),
      baseB: cloneSurface(scene.b),
    };
    this.recomputeMetrics();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  private patch(partial: Partial<AppState>) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  loadScene(id: string) {
    const scene = getScene(id);
    const dir = autoDirection(scene.a, scene.sideA, scene.b, scene.sideB);
    this.state = {
      ...this.state,
      scene,
      a: cloneSurface(scene.a),
      b: cloneSurface(scene.b),
      sideA: scene.sideA,
      sideB: scene.sideB,
      continuity: scene.continuity,
      correspondenceMode: 'arclength',
      direction: dir,
      fixed: scene.fixed ?? 'A',
      deformRows: scene.deformRows ?? 3,
      result: null,
      metrics: null,
      statusText: `${scene.name} — ${scene.note}`,
      statusKind: 'info',
      baseA: cloneSurface(scene.a),
      baseB: cloneSurface(scene.b),
    };
    this.recomputeMetrics();
  }

  setSide(which: 'A' | 'B', side: Side) {
    const key = which === 'A' ? 'sideA' : 'sideB';
    const nextSideA = which === 'A' ? side : this.state.sideA;
    const nextSideB = which === 'B' ? side : this.state.sideB;
    const dir = autoDirection(this.state.a, nextSideA, this.state.b, nextSideB);
    this.patch({ [key]: side, direction: dir, result: null } as Partial<AppState>);
    this.recomputeMetrics();
  }

  setContinuity(mode: ContinuityMode) {
    this.patch({ continuity: mode, result: null });
    this.recomputeMetrics();
  }

  setCorrespondenceMode(mode: 'arclength' | 'parameter') {
    this.patch({ correspondenceMode: mode, result: null });
    this.recomputeMetrics();
  }

  setDirection(d: 1 | -1) {
    this.patch({ direction: d, result: null });
    this.recomputeMetrics();
  }

  setFixed(f: FixedSide) {
    this.patch({ fixed: f });
  }

  setDeformRows(n: number) {
    this.patch({ deformRows: Math.max(1, Math.round(n)) });
  }

  setStiffness(v: number) {
    this.patch({ stiffness: v });
  }

  setShapeBias(v: number) {
    this.patch({ shapeBias: v });
  }

  setSamples(n: number) {
    this.patch({ samples: Math.max(6, Math.round(n)) });
    this.recomputeMetrics();
  }

  flipOrientation(which: 'A' | 'B') {
    if (which === 'A') this.patch({ a: withOrientation(this.state.a, this.state.a.orientation === 1 ? -1 : 1), result: null, baseA: withOrientation(this.state.baseA, this.state.baseA.orientation === 1 ? -1 : 1) });
    else this.patch({ b: withOrientation(this.state.b, this.state.b.orientation === 1 ? -1 : 1), result: null, baseB: withOrientation(this.state.baseB, this.state.baseB.orientation === 1 ? -1 : 1) });
    this.recomputeMetrics();
  }

  resetGeometry() {
    this.patch({ a: cloneSurface(this.state.baseA), b: cloneSurface(this.state.baseB), result: null });
    this.recomputeMetrics();
  }

  private currentCorrespondence(): Correspondence {
    return buildCorrespondence(
      this.state.a,
      this.state.sideA,
      this.state.b,
      this.state.sideB,
      this.state.samples,
      this.state.direction,
      this.state.correspondenceMode,
    );
  }

  recomputeMetrics() {
    try {
      const corr = this.currentCorrespondence();
      const metrics = measureSeam(this.state.a, this.state.sideA, this.state.b, this.state.sideB, corr, 200);
      this.patch({ metrics });
    } catch (err) {
      this.patch({ metrics: null, statusText: `误差计算异常：${(err as Error).message}`, statusKind: 'degenerate' });
    }
  }

  runSolve() {
    try {
      const corr = this.currentCorrespondence();
      const res = solveStitch(this.state.a, this.state.b, {
        sideA: this.state.sideA,
        sideB: this.state.sideB,
        continuity: this.state.continuity,
        correspondence: corr,
        fixed: this.state.fixed,
        deformRows: this.state.deformRows,
        stiffness: this.state.stiffness,
        shapeBias: this.state.shapeBias,
      });
      const metrics = measureSeam(res.a, this.state.sideA, res.b, this.state.sideB, corr, 200);
      const statusText =
        res.report.status === 'ok'
          ? `拼接完成（${this.state.continuity}）。` + res.report.messages.join(' ')
          : res.report.status === 'conflict'
            ? '约束冲突：' + res.report.messages.join(' ')
            : '数值退化：' + res.report.messages.join(' ');
      this.patch({
        a: res.a,
        b: res.b,
        result: res,
        metrics,
        statusText,
        statusKind: res.report.status,
      });
    } catch (err) {
      this.patch({ statusText: `求解异常：${(err as Error).message}`, statusKind: 'degenerate' });
    }
  }
}

export { SCENES };
export type { SolveReport };
