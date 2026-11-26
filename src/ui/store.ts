import { Scene, SCENES, getScene } from '../core/scenes.js';
import { Surface, cloneSurface, withOrientation } from '../core/surface.js';
import {
  ContinuityMode,
  FixedSide,
  SolveReport,
  StitchResult,
  EdgeLocks,
  LockEdge,
  noLocks,
  solveStitch,
} from '../core/solver.js';
import { buildCorrespondence, autoDirection, Correspondence, Side } from '../core/seam.js';
import { SeamMetrics, measureSeam } from '../core/continuity.js';
import { Vec3 } from '../core/vec.js';
import {
  RouteComparison,
  EdgeReleasePreview,
  ConflictCluster,
  compareRoutes,
  previewEdgeRelease,
  labThresholds,
  anomalyClusters,
} from '../core/route-lab.js';

export interface TrialState {
  edge: LockEdge;
  backupA: Surface;
  backupB: Surface;
  backupLocks: EdgeLocks;
}

export interface FocusRequest {
  p: Vec3;
  nonce: number;
}

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
  edgeLocks: EdgeLocks;
  moveBudgetFrac: number;
  result: StitchResult | null;
  metrics: SeamMetrics | null;
  anomalies: ConflictCluster[];
  statusText: string;
  statusKind: 'ok' | 'conflict' | 'degenerate' | 'info';
  solving: boolean;
  lastSolveMs: number | null;
  comparison: RouteComparison | null;
  comparisonBusy: boolean;
  labRunMs: number | null;
  selectedClusterId: number | null;
  selectedLockEdge: LockEdge | null;
  edgePreview: EdgeReleasePreview | null;
  previewBusy: boolean;
  arrowExaggeration: number;
  trial: TrialState | null;
  focusRequest: FocusRequest | null;
  /** base surfaces before any solve (reset / reproducible counterfactual source) */
  baseA: Surface;
  baseB: Surface;
}

export type Listener = (state: AppState) => void;

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export class AppStore {
  state: AppState;
  private listeners = new Set<Listener>();
  private focusNonce = 0;
  private previewSeq = 0;

  constructor(sceneId = 'tilt') {
    const scene = getScene(sceneId);
    const dir = autoDirection(scene.a, scene.sideA, scene.b, scene.sideB);
    const edgeLocks: EdgeLocks = { ...noLocks(), ...(scene.edgeLocks ?? {}) };
    this.state = {
      scene,
      a: cloneSurface(scene.a),
      b: cloneSurface(scene.b),
      sideA: scene.sideA,
      sideB: scene.sideB,
      continuity: scene.continuity,
      correspondenceMode: scene.correspondenceMode ?? 'arclength',
      direction: dir,
      fixed: scene.fixed ?? 'A',
      deformRows: scene.deformRows ?? 3,
      stiffness: 1e-2,
      shapeBias: 0,
      samples: 48,
      edgeLocks,
      moveBudgetFrac: 0.04,
      result: null,
      metrics: null,
      anomalies: [],
      statusText: '尚未求解。调整接边条件后点击“求解拼接”。',
      statusKind: 'info',
      solving: false,
      lastSolveMs: null,
      comparison: null,
      comparisonBusy: false,
      labRunMs: null,
      selectedClusterId: null,
      selectedLockEdge: null,
      edgePreview: null,
      previewBusy: false,
      arrowExaggeration: 1,
      trial: null,
      focusRequest: null,
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
    const edgeLocks: EdgeLocks = { ...noLocks(), ...(scene.edgeLocks ?? {}) };
    this.state = {
      ...this.state,
      scene,
      a: cloneSurface(scene.a),
      b: cloneSurface(scene.b),
      sideA: scene.sideA,
      sideB: scene.sideB,
      continuity: scene.continuity,
      correspondenceMode: scene.correspondenceMode ?? 'arclength',
      direction: dir,
      fixed: scene.fixed ?? 'A',
      deformRows: scene.deformRows ?? 3,
      edgeLocks,
      result: null,
      metrics: null,
      anomalies: [],
      statusText: `${scene.name} — ${scene.note}`,
      statusKind: 'info',
      solving: false,
      lastSolveMs: null,
      comparison: null,
      comparisonBusy: false,
      labRunMs: null,
      selectedClusterId: null,
      selectedLockEdge: null,
      edgePreview: null,
      previewBusy: false,
      trial: null,
      focusRequest: null,
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

  toggleLock(edge: LockEdge, value: boolean) {
    const edgeLocks = { ...this.state.edgeLocks, [edge]: value };
    this.patch({ edgeLocks, edgePreview: null });
    if (value && this.state.selectedLockEdge === edge) void this.selectLockEdge(edge);
  }

  setMoveBudgetFrac(v: number) {
    this.patch({ moveBudgetFrac: v });
  }

  setArrowExaggeration(v: number) {
    this.patch({ arrowExaggeration: v });
  }

  flipOrientation(which: 'A' | 'B') {
    if (which === 'A')
      this.patch({
        a: withOrientation(this.state.a, this.state.a.orientation === 1 ? -1 : 1),
        result: null,
        baseA: withOrientation(this.state.baseA, this.state.baseA.orientation === 1 ? -1 : 1),
      });
    else
      this.patch({
        b: withOrientation(this.state.b, this.state.b.orientation === 1 ? -1 : 1),
        result: null,
        baseB: withOrientation(this.state.baseB, this.state.baseB.orientation === 1 ? -1 : 1),
      });
    this.recomputeMetrics();
  }

  resetGeometry() {
    this.patch({
      a: cloneSurface(this.state.baseA),
      b: cloneSurface(this.state.baseB),
      result: null,
      edgePreview: null,
      trial: null,
    });
    this.recomputeMetrics();
  }

  private currentCorrespondence(): Correspondence {
    return buildCorrespondence(
      this.state.baseA,
      this.state.sideA,
      this.state.baseB,
      this.state.sideB,
      this.state.samples,
      this.state.direction,
      this.state.correspondenceMode,
    );
  }

  private classifyAnomalies(a: Surface, b: Surface, metrics: SeamMetrics): ConflictCluster[] {
    const th = labThresholds(a, b, this.state.moveBudgetFrac);
    return anomalyClusters(metrics, {
      gapTol: th.gapTol,
      tangentDeg: th.tangentDeg,
      c1: this.state.continuity === 'C1' ? th.c1 : undefined,
    });
  }

  recomputeMetrics() {
    try {
      const corr = buildCorrespondence(
        this.state.a,
        this.state.sideA,
        this.state.b,
        this.state.sideB,
        this.state.samples,
        this.state.direction,
        this.state.correspondenceMode,
      );
      const metrics = measureSeam(this.state.a, this.state.sideA, this.state.b, this.state.sideB, corr, 200);
      const anomalies = this.classifyAnomalies(this.state.a, this.state.b, metrics);
      this.patch({ metrics, anomalies });
    } catch (err) {
      this.patch({ metrics: null, anomalies: [], statusText: `误差计算异常：${(err as Error).message}`, statusKind: 'degenerate' });
    }
  }

  /** Solve from the scene baseline so repeated runs / comparisons are reproducible. */
  async runSolve() {
    if (this.state.solving) return;
    this.patch({ solving: true });
    await delay(24);
    const t0 = nowMs();
    try {
      const corr = this.currentCorrespondence();
      const res = solveStitch(cloneSurface(this.state.baseA), cloneSurface(this.state.baseB), {
        sideA: this.state.sideA,
        sideB: this.state.sideB,
        continuity: this.state.continuity,
        correspondence: corr,
        fixed: this.state.fixed,
        deformRows: this.state.deformRows,
        stiffness: this.state.stiffness,
        shapeBias: this.state.shapeBias,
        edgeLocks: this.state.edgeLocks,
      });
      const metrics = measureSeam(res.a, this.state.sideA, res.b, this.state.sideB, corr, 200);
      const anomalies = this.classifyAnomalies(res.a, res.b, metrics);
      const ms = nowMs() - t0;
      const statusText =
        res.report.status === 'ok'
          ? `拼接完成（${this.state.continuity}，${ms.toFixed(0)} ms）。` + res.report.messages.join(' ')
          : res.report.status === 'conflict'
            ? '约束冲突：' + res.report.messages.join(' ')
            : '数值退化：' + res.report.messages.join(' ');
      this.patch({
        a: res.a,
        b: res.b,
        result: res,
        metrics,
        anomalies,
        solving: false,
        lastSolveMs: ms,
        statusText,
        statusKind: res.report.status,
      });
    } catch (err) {
      this.patch({
        solving: false,
        statusText: `求解异常：${(err as Error).message}`,
        statusKind: 'degenerate',
      });
    }
  }

  async runComparison() {
    if (this.state.comparisonBusy) return;
    this.patch({ comparisonBusy: true, selectedClusterId: null });
    await delay(24);
    const t0 = nowMs();
    try {
      const s = this.state;
      const comparison = compareRoutes(cloneSurface(s.baseA), cloneSurface(s.baseB), {
        sideA: s.sideA,
        sideB: s.sideB,
        direction: s.direction,
        correspondenceMode: s.correspondenceMode,
        fixed: s.fixed,
        deformRows: s.deformRows,
        stiffness: s.stiffness,
        shapeBias: s.shapeBias,
        edgeLocks: s.edgeLocks,
        samples: s.samples,
        density: 160,
        moveBudgetFrac: s.moveBudgetFrac,
      });
      this.patch({ comparison, comparisonBusy: false, labRunMs: nowMs() - t0 });
    } catch (err) {
      this.patch({
        comparisonBusy: false,
        statusText: `路线对比异常：${(err as Error).message}`,
        statusKind: 'degenerate',
      });
    }
  }

  selectCluster(id: number | null) {
    this.patch({ selectedClusterId: id });
    if (id === null) return;
    const cluster = this.state.comparison?.g1.clusters.find((c) => c.id === id);
    if (cluster) this.requestFocus(cluster.point);
  }

  selectAnomaly(id: number) {
    const c = this.state.anomalies.find((x) => x.id === id);
    if (c) this.requestFocus(c.point);
  }

  requestFocus(p: Vec3) {
    this.focusNonce += 1;
    this.patch({ focusRequest: { p: [p[0], p[1], p[2]], nonce: this.focusNonce } });
  }

  async selectLockEdge(edge: LockEdge | null) {
    const seq = ++this.previewSeq;
    this.patch({ selectedLockEdge: edge, edgePreview: null, previewBusy: false });
    if (!edge) return;
    if (!this.state.edgeLocks[edge]) return;
    this.patch({ previewBusy: true });
    await delay(24);
    try {
      const s = this.state;
      const corr = buildCorrespondence(
        s.baseA,
        s.sideA,
        s.baseB,
        s.sideB,
        s.samples,
        s.direction,
        s.correspondenceMode,
      );
      const edgePreview = previewEdgeRelease(cloneSurface(s.baseA), cloneSurface(s.baseB), {
        sideA: s.sideA,
        sideB: s.sideB,
        continuity: s.continuity,
        corr,
        fixed: s.fixed,
        deformRows: s.deformRows,
        stiffness: s.stiffness,
        shapeBias: s.shapeBias,
        edgeLocks: s.edgeLocks,
        density: 200,
      }, edge);
      if (seq !== this.previewSeq || this.state.selectedLockEdge !== edge) return;
      this.patch({ edgePreview, previewBusy: false });
    } catch (err) {
      if (seq !== this.previewSeq) return;
      this.patch({ previewBusy: false, statusText: `锁定边预演异常：${(err as Error).message}`, statusKind: 'degenerate' });
    }
  }

  /** Apply the preview's released solution on a trial copy (cancel restores). */
  applyTrial() {
    const pv = this.state.edgePreview;
    const edge = this.state.selectedLockEdge;
    if (!pv || !edge) return;
    const trial: TrialState = {
      edge,
      backupA: cloneSurface(this.state.a),
      backupB: cloneSurface(this.state.b),
      backupLocks: { ...this.state.edgeLocks },
    };
    const edgeLocks = { ...this.state.edgeLocks, [edge]: false };
    this.patch({
      a: cloneSurface(pv.afterA),
      b: cloneSurface(pv.afterB),
      edgeLocks,
      metrics: pv.after,
      trial,
      edgePreview: null,
      statusKind: pv.afterReport.status,
      statusText: `试验副本：已在副本上松开 ${edge} 并重新量测（${pv.afterReport.status}）。可保留或还原。`,
    });
    const anomalies = this.classifyAnomalies(pv.afterA, pv.afterB, pv.after);
    this.patch({ anomalies });
  }

  keepTrial() {
    if (!this.state.trial) return;
    this.patch({
      trial: null,
      baseA: cloneSurface(this.state.a),
      baseB: cloneSurface(this.state.b),
      statusText: '已保留试验结果，并将其作为后续求解的新基准。',
      statusKind: 'ok',
    });
  }

  discardTrial() {
    const t = this.state.trial;
    if (!t) return;
    this.patch({
      a: cloneSurface(t.backupA),
      b: cloneSurface(t.backupB),
      edgeLocks: { ...t.backupLocks },
      trial: null,
    });
    this.recomputeMetrics();
  }
}

export { SCENES };
export type { SolveReport };
