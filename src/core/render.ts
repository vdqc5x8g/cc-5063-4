import { Surface, evalSurface, sampleGrid } from './surface.js';
import { Vec3 } from './vec.js';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  wires: Float32Array;
}

/** Triangulated grid of a patch with analytic normals. */
export function surfaceMesh(s: Surface, res: number): MeshData {
  const grid = sampleGrid(s, res, res);
  const positions: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i <= res; i++)
    for (let j = 0; j <= res; j++) {
      const u = Math.min(i / res, 1 - 1e-12);
      const v = Math.min(j / res, 1 - 1e-12);
      const p = grid[i][j];
      const e = evalSurface(s, u, v);
      positions.push(p[0], p[1], p[2]);
      normals.push(e.normal[0], e.normal[1], e.normal[2]);
    }
  const indices: number[] = [];
  for (let i = 0; i < res; i++)
    for (let j = 0; j < res; j++) {
      const a = i * (res + 1) + j;
      const b = a + 1;
      const c = a + (res + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  // wireframe: iso-curves for orientation cues
  const wires: number[] = [];
  const iso = Math.min(24, res);
  for (let k = 0; k <= iso; k++) {
    const t = Math.min(k / iso, 1 - 1e-12);
    for (let i = 0; i < res; i++) {
      const p = evalSurface(s, i / res, t).pt;
      const q = evalSurface(s, (i + 1) / res, t).pt;
      wires.push(p[0], p[1], p[2], q[0], q[1], q[2]);
      const p2 = evalSurface(s, t, i / res).pt;
      const q2 = evalSurface(s, t, (i + 1) / res).pt;
      wires.push(p2[0], p2[1], p2[2], q2[0], q2[1], q2[2]);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    wires: new Float32Array(wires),
  };
}

/** Gap "comb": line segments from A boundary points to their matched B points. */
export function gapComb(pa: Vec3[], pb: Vec3[], maxSegments = 160): Float32Array {
  const out: number[] = [];
  const n = Math.min(pa.length, pb.length);
  const stride = Math.max(1, Math.floor(n / maxSegments));
  for (let k = 0; k < n; k += stride) {
    const p = pa[k];
    const q = pb[k];
    out.push(p[0], p[1], p[2], q[0], q[1], q[2]);
  }
  return new Float32Array(out);
}
