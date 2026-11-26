import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AppStore, AppState } from './store.js';
import { Surface, evalSurface } from '../core/surface.js';
import { boundarySamples, Side, sideGeom } from '../core/seam.js';
import { gapComb, surfaceMesh } from '../core/render.js';
import { lockEdgeToSide } from '../core/route-lab.js';
import { lockEdgeCpIndices, LockEdge } from '../core/solver.js';
import { Vec3 } from '../core/vec.js';

interface PatchView {
  mesh: THREE.Mesh;
  wire: THREE.LineSegments;
  controlPts: THREE.Points;
  controlNet: THREE.LineSegments;
  material: THREE.MeshStandardMaterial;
}

export class Viewport {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private patches: { A: PatchView; B: PatchView };
  private seamGroup = new THREE.Group();
  private selectionGroup = new THREE.Group();
  private annotationGroup = new THREE.Group();
  private lastFocusNonce = 0;
  private resizeObs: ResizeObserver;
  private store: AppStore;
  private container: HTMLElement;
  private needsRebuild = true;
  private pendingState: AppState | null = null;
  private rafHandle = 0;
  private disposed = false;
  private onPickSide: (which: 'A' | 'B', side: Side) => void;
  private selectedSide: { which: 'A' | 'B'; side: Side } | null = null;
  private hoverEl: HTMLElement;
  private showGapComb = true;
  private showStripes = true;
  private showControlNet = false;
  private stripeFreq = 22;
  private fitted = false;
  private clipPlaneTexture: THREE.DataTexture | null = null;

  constructor(container: HTMLElement, store: AppStore, onPickSide: (which: 'A' | 'B', side: Side) => void) {
    this.container = container;
    this.store = store;
    this.onPickSide = onPickSide;

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 500;
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(0x0b0f15, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.005, 500);
    this.camera.position.set(3.6, 2.8, 3.2);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.target.set(0.7, 0.45, 0.35);

    this.setupLights();
    this.patches = { A: this.buildPatch('A'), B: this.buildPatch('B') };
    this.scene.add(this.seamGroup, this.selectionGroup, this.annotationGroup);

    this.hoverEl = document.createElement('div');
    this.hoverEl.className = 'viewport-hover';
    container.appendChild(this.hoverEl);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);

    canvas.addEventListener('pointerdown', this.handlePointer);
    canvas.addEventListener('pointermove', this.handleHover);
    canvas.addEventListener('pointerleave', () => this.setHover(null));

    this.applyState(store.state);
    this.loop();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  private setupLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(4, 6, 5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x93b8ff, 0.9);
    fill.position.set(-4, 1.5, -3);
    this.scene.add(fill);
  }

  /**
   * Surface material with injected reflection-line stripes. The stripe value is
   * the elevation of the reflected view ray: a real reflection-line pattern, not
   * a texture. If the two patches share a tangent plane the stripes run
   * continuously across the seam; a kink in a stripe means a G1 break.
   */
  private makeMaterial(color: number, which: 'A' | 'B'): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.4,
      roughness: 0.28,
      side: THREE.DoubleSide,
    });
    const uniforms = {
      uEye: { value: new THREE.Vector3(0, 0, 5) },
      uFreq: { value: this.stripeFreq },
      uShow: { value: 1 },
      uTint: { value: new THREE.Color(color) },
    };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uEye = uniforms.uEye;
      shader.uniforms.uFreq = uniforms.uFreq;
      shader.uniforms.uShow = uniforms.uShow;
      shader.uniforms.uTint = uniforms.uTint;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vWorldPos;
          varying vec3 vWorldNrm;`,
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          vWorldNrm = normalize(mat3(modelMatrix) * normal);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform vec3 uEye;
          uniform float uFreq;
          uniform float uShow;
          uniform vec3 uTint;
          varying vec3 vWorldPos;
          varying vec3 vWorldNrm;`,
        )
        .replace(
          '#include <opaque_fragment>',
          `{
            vec3 n = normalize(vWorldNrm);
            vec3 v = normalize(uEye - vWorldPos);
            vec3 r = reflect(-v, n);
            // Reflection lines: the bright band follows the elevation of the
            // reflected view ray, exactly like a striped environment reflected
            // in the surface. Continuity of a band across the seam == shared
            // tangent plane; a kink or jump is a G1 break.
            float ang = r.y * 0.75 + r.z * 0.45 + r.x * 0.18;
            float band = sin(ang * uFreq * 6.2831853);
            float line = smoothstep(0.94, 0.998, band);
            float sheen = smoothstep(0.65, 0.98, band) * 0.14;
            vec3 lineColor = mix(outgoingLight, vec3(0.98, 0.99, 1.0), 0.9);
            outgoingLight = mix(outgoingLight, lineColor, line * 0.85 * uShow);
            outgoingLight += outgoingLight * sheen * uShow;
          }
          #include <opaque_fragment>`,
        );
    };
    mat.userData.uniforms = uniforms;
    void which;
    return mat;
  }

  private buildPatch(which: 'A' | 'B'): PatchView {
    const mat = this.makeMaterial(which === 'A' ? 0x5f8fd8 : 0xd8a05f, which);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.name = `patch_${which}`;
    mesh.userData.patch = which;
    const wire = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xbcd4f0, transparent: true, opacity: 0.14 }),
    );
    const controlPts = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: 0xffef8a, size: 0.05, sizeAttenuation: true }),
    );
    controlPts.visible = false;
    const controlNet = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x9a8a3a, transparent: true, opacity: 0.55 }),
    );
    controlNet.visible = false;
    this.scene.add(mesh, wire, controlPts, controlNet);
    return { mesh, wire, controlPts, controlNet, material: mat };
  }

  private lastSceneId: string | null = null;

  applyState(state: AppState) {
    // A new scene needs a fresh camera framing; a solve keeps the current view.
    if (state.scene.id !== this.lastSceneId) {
      this.lastSceneId = state.scene.id;
      this.fitted = false;
    }
    if (state.focusRequest && state.focusRequest.nonce !== this.lastFocusNonce) {
      this.lastFocusNonce = state.focusRequest.nonce;
      this.focusPoint(state.focusRequest.p);
    }
    this.pendingState = state;
    this.needsRebuild = true;
  }

  setVisualOptions(opts: { stripes?: boolean; gapComb?: boolean; controlNet?: boolean; stripeFreq?: number }) {
    if (opts.stripes !== undefined) this.showStripes = opts.stripes;
    if (opts.gapComb !== undefined) this.showGapComb = opts.gapComb;
    if (opts.controlNet !== undefined) this.showControlNet = opts.controlNet;
    if (opts.stripeFreq !== undefined) this.stripeFreq = opts.stripeFreq;
    for (const which of ['A', 'B'] as const) {
      const u = this.patches[which].material.userData.uniforms as Record<string, { value: unknown }>;
      if (u?.uShow) u.uShow.value = this.showStripes ? 1 : 0;
      if (u?.uFreq) u.uFreq.value = this.stripeFreq;
    }
    if (opts.controlNet !== undefined) {
      this.patches.A.controlPts.visible = this.showControlNet;
      this.patches.A.controlNet.visible = this.showControlNet;
      this.patches.B.controlPts.visible = this.showControlNet;
      this.patches.B.controlNet.visible = this.showControlNet;
    }
    this.needsRebuild = true;
  }

  private rebuild() {
    if (!this.pendingState) return;
    const st = this.pendingState;
    this.needsRebuild = false;
    this.updatePatch('A', st.a, 64);
    this.updatePatch('B', st.b, 64);
    for (const which of ['A', 'B'] as const) {
      const u = this.patches[which].material.userData.uniforms as Record<string, { value: unknown }>;
      if (u?.uEye) (u.uEye.value as THREE.Vector3).copy(this.camera.position);
      if (u?.uShow) u.uShow.value = this.showStripes ? 1 : 0;
      if (u?.uFreq) u.uFreq.value = this.stripeFreq;
    }

    clearGroup(this.seamGroup);
    if (st.metrics) {
      const pa = st.metrics.samples.map((s) => s.pa);
      const pb = st.metrics.samples.map((s) => s.pb);
      this.seamGroup.add(makeLine(pa, 0x8fe3ff, true));
      this.seamGroup.add(makeLine(pb, 0xffd27a, true));
      if (this.showGapComb) {
        const gap = gapComb(pa, pb, 150);
        this.seamGroup.add(makeLineSegments(gap, st.metrics.maxGap > 1e-4 ? 0xff5a5a : 0x7fe0a0));
      }
    }
    this.rebuildSelection(st);
    this.rebuildAnnotations(st);
    if (!this.fitted) {
      this.fitCamera(st);
      this.fitted = true;
    }
  }

  private rebuildAnnotations(st: AppState) {
    clearGroup(this.annotationGroup);

    // Conflict / anomaly markers. A route comparison wins over the ordinary
    // single-route anomaly list because it carries the 不可兼得 classification.
    const clusters = st.comparison ? st.comparison.g1.clusters : st.anomalies;
    for (const c of clusters) {
      const color =
        c.level === 'blocked' ? 0xff4d4d : c.level === 'exclusive' ? 0xff9f1c : 0xffd23f;
      const selected = st.selectedClusterId === c.id;
      const r = selected ? 0.055 : 0.034;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(r, 20, 14),
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      );
      sphere.position.set(c.point[0], c.point[1], c.point[2]);
      sphere.renderOrder = 20;
      this.annotationGroup.add(sphere);
      if (selected) {
        const beam = makeLine(
          [
            c.point,
            [c.point[0], c.point[1] + 0.35, c.point[2]],
          ],
          color,
          false,
        );
        (beam.material as THREE.LineBasicMaterial).depthTest = false;
        beam.renderOrder = 19;
        this.annotationGroup.add(beam);
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.09, 0.008, 10, 40),
          new THREE.MeshBasicMaterial({ color, depthTest: false }),
        );
        ring.position.set(c.point[0], c.point[1], c.point[2]);
        ring.renderOrder = 21;
        this.annotationGroup.add(ring);
      }
    }

    // Highlight the selected lock edge on the free patch + its locked poles.
    if (st.selectedLockEdge) {
      const freeWhich: 'A' | 'B' = st.fixed === 'A' ? 'B' : 'A';
      const freeSurf = freeWhich === 'A' ? st.a : st.b;
      const seamSide = freeWhich === 'A' ? st.sideA : st.sideB;
      const edge: LockEdge = st.selectedLockEdge;
      const locked = st.edgeLocks[edge];
      const color = locked ? 0xff5cf0 : 0x7a5578;
      try {
        const edgeSide = lockEdgeToSide(seamSide, sideGeom(freeSurf, seamSide), edge);
        const bs = boundarySamples(freeSurf, edgeSide, 100);
        this.annotationGroup.add(makeTube(bs.pts, color, 0.014));
        for (const [i, j] of lockEdgeCpIndices(freeSurf, seamSide, edge)) {
          const p = freeSurf.cps[i][j];
          const pole = new THREE.Mesh(
            new THREE.SphereGeometry(0.028, 14, 10),
            new THREE.MeshBasicMaterial({ color, depthTest: false }),
          );
          pole.position.set(p[0], p[1], p[2]);
          pole.renderOrder = 18;
          this.annotationGroup.add(pole);
        }
      } catch {
        // surface/side geometry not evaluable for this selection; skip highlight
      }
    }

    // Edge-release counterfactual: concession arrows + healed segment tubes.
    const pv = st.edgePreview;
    if (pv) {
      const gain = st.arrowExaggeration;
      for (const ar of pv.arrows) {
        if (ar.move < 1e-9) continue;
        const dir = new THREE.Vector3(ar.delta[0], ar.delta[1], ar.delta[2]).normalize();
        const len = ar.move * gain;
        const arrow = new THREE.ArrowHelper(
          dir,
          new THREE.Vector3(ar.from[0], ar.from[1], ar.from[2]),
          len,
          0xff5cf0,
          Math.min(0.09, len * 0.35),
          Math.min(0.05, len * 0.2),
        );
        this.annotationGroup.add(arrow);
        const tip = new THREE.Mesh(
          new THREE.SphereGeometry(0.02, 10, 8),
          new THREE.MeshBasicMaterial({ color: 0x4fc3ff, depthTest: false }),
        );
        tip.position.set(ar.to[0], ar.to[1], ar.to[2]);
        tip.renderOrder = 22;
        this.annotationGroup.add(tip);
      }
      for (const r of pv.healed) this.annotationGroup.add(makeTube(r.points, 0x39ff88, 0.016));
      for (const r of pv.relieved) this.annotationGroup.add(makeTube(r.points, 0xffb020, 0.014));
      for (const r of pv.improved) this.annotationGroup.add(makeTube(r.points, 0x4fc3ff, 0.012));
    }
  }

  /** Focus the camera on a world point without changing the viewing direction. */
  focusPoint(p: Vec3) {
    const target = this.controls.target;
    const dir = new THREE.Vector3(
      this.camera.position.x - target.x,
      this.camera.position.y - target.y,
      this.camera.position.z - target.z,
    );
    const curDist = dir.length() || 1;
    dir.normalize();
    const dist = Math.min(Math.max(curDist * 0.45, 0.55), 1.6);
    this.controls.target.set(p[0], p[1], p[2]);
    this.camera.position.set(p[0] + dir.x * dist, p[1] + dir.y * dist, p[2] + dir.z * dist);
    this.camera.near = Math.max(0.002, dist * 0.02);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private rebuildSelection(st: AppState) {
    clearGroup(this.selectionGroup);
    if (!this.selectedSide) return;
    const surf = this.selectedSide.which === 'A' ? st.a : st.b;
    const bs = boundarySamples(surf, this.selectedSide.side, 80);
    this.selectionGroup.add(makeLine(bs.pts, 0x7dffb2, false));
    const ticks: number[] = [];
    for (let k = 0; k < bs.pts.length; k += 8) {
      const f = bs.pts[k];
      const n = bs.normals[k];
      ticks.push(f[0], f[1], f[2], f[0] + n[0] * 0.1, f[1] + n[1] * 0.1, f[2] + n[2] * 0.1);
    }
    this.selectionGroup.add(makeLineSegments(new Float32Array(ticks), 0x7dffb2));
  }

  private updatePatch(which: 'A' | 'B', surface: Surface, res: number) {
    const view = this.patches[which];
    const data = surfaceMesh(surface, res);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    g.setIndex(new THREE.BufferAttribute(data.indices, 1));
    view.mesh.geometry.dispose();
    view.mesh.geometry = g;
    view.mesh.userData.surface = surface;

    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(data.wires, 3));
    view.wire.geometry.dispose();
    view.wire.geometry = wg;

    const { nu, nv } = { nu: surface.cps.length, nv: surface.cps[0].length };
    const cpts: number[] = [];
    const netLines: number[] = [];
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const p = surface.cps[i][j];
        cpts.push(p[0], p[1], p[2]);
        if (j < nv - 1) {
          const q = surface.cps[i][j + 1];
          netLines.push(p[0], p[1], p[2], q[0], q[1], q[2]);
        }
        if (i < nu - 1) {
          const q = surface.cps[i + 1][j];
          netLines.push(p[0], p[1], p[2], q[0], q[1], q[2]);
        }
      }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cpts), 3));
    view.controlPts.geometry.dispose();
    view.controlPts.geometry = cg;
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.BufferAttribute(new Float32Array(netLines), 3));
    view.controlNet.geometry.dispose();
    view.controlNet.geometry = ng;
  }

  private fitCamera(st: AppState) {
    let min: Vec3 = [Infinity, Infinity, Infinity];
    let max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const surf of [st.a, st.b]) {
      for (let i = 0; i <= 24; i++)
        for (let j = 0; j <= 24; j++) {
          const p = evalSurface(surf, Math.min(i / 24, 1 - 1e-9), Math.min(j / 24, 1 - 1e-9)).pt;
          for (let c = 0; c < 3; c++) {
            min[c] = Math.min(min[c], p[c]);
            max[c] = Math.max(max[c], p[c]);
          }
        }
    }
    const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 0.5);
    const dist = size * 1.9 + 0.6;
    this.controls.target.set(center[0], center[1], center[2]);
    const dir = new THREE.Vector3(0.82, 0.72, 0.72).normalize().multiplyScalar(dist);
    this.camera.position.set(center[0] + dir.x, center[1] + dir.y, center[2] + dir.z);
    this.camera.near = Math.max(0.005, dist * 0.01);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private handlePointer = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    const hit = this.pick(ev);
    if (!hit) return;
    const which = hit.object.userData.patch as 'A' | 'B';
    const surface = which === 'A' ? this.store.state.a : this.store.state.b;
    const side = nearestBoundarySide(surface, hit.point as unknown as Vec3);
    this.selectSide(which, side);
  };

  private handleHover = (ev: PointerEvent) => {
    const hit = this.pick(ev);
    if (!hit) {
      this.setHover(null);
      return;
    }
    const which = hit.object.userData.patch as 'A' | 'B';
    const surface = which === 'A' ? this.store.state.a : this.store.state.b;
    const side = nearestBoundarySide(surface, hit.point as unknown as Vec3);
    this.setHover(`点击选择 ${which} 的 ${sideLabelShort(side)} 作为接边`);
  };

  private pick(ev: PointerEvent): THREE.Intersection | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects([this.patches.A.mesh, this.patches.B.mesh], false);
    return hits.length ? hits[0] : null;
  }

  private setHover(text: string | null) {
    this.hoverEl.textContent = text ?? '';
    this.hoverEl.style.display = text ? 'block' : 'none';
  }

  selectSide(which: 'A' | 'B', side: Side) {
    this.selectedSide = { which, side };
    this.onPickSide(which, side);
    this.needsRebuild = true;
  }

  clearSelection() {
    this.selectedSide = null;
    this.needsRebuild = true;
  }

  refit() {
    this.fitted = false;
    this.needsRebuild = true;
  }

  /**
   * Frame the seam so reflection stripes across it can be inspected closely.
   * Centres on the midpoint between the correspondence samples and aims along
   * the average seam normal.
   */
  focusSeam() {
    const st = this.pendingState;
    if (!st || !st.metrics || st.metrics.samples.length < 2) return;
    const smp = st.metrics.samples;
    let c: Vec3 = [0, 0, 0];
    let nsum: Vec3 = [0, 0, 0];
    for (const s of smp) {
      c = [c[0] + s.pa[0], c[1] + s.pa[1], c[2] + s.pa[2]];
      nsum = [nsum[0] + s.na[0], nsum[1] + s.na[1], nsum[2] + s.na[2]];
    }
    c = [c[0] / smp.length, c[1] / smp.length, c[2] / smp.length];
    const nl = Math.hypot(nsum[0], nsum[1], nsum[2]) || 1;
    const n: Vec3 = [nsum[0] / nl, nsum[1] / nl, nsum[2] / nl];
    let span = 0;
    for (const s of smp) {
      const d = Math.hypot(s.pa[0] - c[0], s.pa[1] - c[1], s.pa[2] - c[2]);
      span = Math.max(span, d);
    }
    const dist = Math.max(span * 2.4, 0.35);
    this.controls.target.set(c[0], c[1], c[2]);
    // View along the seam normal, slightly off-axis so the seam is visible.
    const view = new THREE.Vector3(n[0], n[1], n[2]).normalize();
    view.add(new THREE.Vector3(0.25, 0.2, 0.1)).normalize();
    this.camera.position.set(c[0] + view.x * dist, c[1] + view.y * dist, c[2] + view.z * dist);
    this.camera.near = Math.max(0.002, dist * 0.01);
    this.camera.far = dist * 30;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.needsRebuild = true;
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private loop = () => {
    if (this.disposed) return;
    this.rafHandle = requestAnimationFrame(this.loop);
    this.controls.update();
    if (this.needsRebuild) this.rebuild();
    const u = this.patches.A.material.userData.uniforms as Record<string, { value: unknown }>;
    if (u?.uEye) (u.uEye.value as THREE.Vector3).copy(this.camera.position);
    const ub = this.patches.B.material.userData.uniforms as Record<string, { value: unknown }>;
    if (ub?.uEye) (ub.uEye.value as THREE.Vector3).copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.rafHandle);
    this.resizeObs.disconnect();
    const c = this.renderer.domElement;
    c.removeEventListener('pointerdown', this.handlePointer);
    c.removeEventListener('pointermove', this.handleHover);
    this.controls.dispose();
    this.renderer.dispose();
  }
}

function clearGroup(g: THREE.Group) {
  for (const child of [...g.children]) {
    g.remove(child);
    child.traverse((o) => {
      const anyO = o as THREE.Mesh | THREE.Line;
      if (anyO.geometry) anyO.geometry.dispose();
      const mat = (anyO as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
  }
}

function makeTube(pts: Vec3[], color: number, radius: number): THREE.Group {
  const group = new THREE.Group();
  if (pts.length === 0) return group;
  if (pts.length < 3) {
    group.add(makeLine(pts, color, false));
    return group;
  }
  const v = pts.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(v, false, 'catmullrom', 0.1);
  const segs = Math.max(24, Math.min(240, pts.length * 2));
  const geom = new THREE.TubeGeometry(curve, segs, radius, 8, false);
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color }));
  group.add(mesh);
  return group;
}

function makeLine(pts: Vec3[], color: number, dashed = false): THREE.Line {
  const geom = new THREE.BufferGeometry();
  const arr = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => {
    arr[i * 3] = p[0];
    arr[i * 3 + 1] = p[1];
    arr[i * 3 + 2] = p[2];
  });
  geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.05, gapSize: 0.03 })
    : new THREE.LineBasicMaterial({ color });
  const line = new THREE.Line(geom, mat);
  if (dashed) line.computeLineDistances();
  return line;
}

function makeLineSegments(arr: Float32Array, color: number): THREE.LineSegments {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
}

function sideLabelShort(side: Side): string {
  return side === 'u0' ? 'U=0' : side === 'u1' ? 'U=1' : side === 'v0' ? 'V=0' : 'V=1';
}

function nearestBoundarySide(surface: Surface, p: Vec3): Side {
  const candidates: Side[] = ['u0', 'u1', 'v0', 'v1'];
  let best: Side = 'u0';
  let bestD = Infinity;
  for (const side of candidates) {
    const bs = boundarySamples(surface, side, 24);
    for (const q of bs.pts) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = side;
      }
    }
  }
  return best;
}
