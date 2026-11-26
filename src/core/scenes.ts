import { interpolateSurface } from './fit.js';
import { Surface, makeSurface, withOrientation, withCps } from './surface.js';
import { clampedUniformKnots, knotsFromBreaks, cpCountFor } from './bspline.js';
import type { EdgeLocks } from './solver.js';
import { Vec3 } from './vec.js';

export interface ScenePatch {
  surface: Surface;
}

export interface Scene {
  id: string;
  name: string;
  description: string;
  a: Surface;
  b: Surface;
  sideA: 'u0' | 'u1' | 'v0' | 'v1';
  sideB: 'u0' | 'u1' | 'v0' | 'v1';
  /** suggested direction/correspondence */
  direction: 1 | -1;
  /** suggested continuity to open with */
  continuity: 'G0' | 'G1' | 'C1';
  /** suggested fixed patch when opening the scene */
  fixed?: 'A' | 'B';
  /** suggested deformable control-row count when opening the scene */
  deformRows?: number;
  /** edge locks to enable when opening the scene */
  edgeLocks?: EdgeLocks;
  /** suggested correspondence when opening the scene (defaults to arc-length) */
  correspondenceMode?: 'arclength' | 'parameter';
  /** suggested note for the user */
  note: string;
}

function build(
  knotsU: number[],
  knotsV: number[],
  p: number,
  fn: (u: number, v: number) => Vec3,
  name: string,
): Surface {
  const nu = cpCountFor(knotsU, p);
  const nv = cpCountFor(knotsV, p);
  const cps = interpolateSurface(nu, nv, p, p, knotsU, knotsV, fn);
  return makeSurface(nu, nv, p, p, cps, { ku: knotsU, kv: knotsV, name });
}

const uni = (n: number, p = 3) => clampedUniformKnots(n, p);

/** B1 — different cross-boundary parameter speed but identical tangent plane. */
function sceneSpeed(): Scene {
  const a = build(uni(7, 3), uni(6, 3), 3, (u, v) => [u, v, 0], 'A');
  // B placed to the +x side with cross speed doubled: x = 1 + 2s.
  const b = build(uni(7, 3), uni(6, 3), 3, (s, t) => [1 + 2 * s, t, 0], 'B');
  return {
    id: 'speed',
    name: '不同参数速度 / 相同切平面',
    description:
      '两片均为平面，接缝处切平面完全一致，但 B 的横向参数速度是 A 的两倍。' +
      '几何连续(G1)不会改动形状，参数连续(C1)必须调整控制点使横向导数相等。',
    a,
    b,
    sideA: 'u1',
    sideB: 'u0',
    direction: 1,
    continuity: 'G1',
    fixed: 'A',
    deformRows: 3,
    note: '观察速度比：G1 保持约 2.0 且控制点不动，C1 将其校正到 1.0 并压缩近缝控制行。',
  };
}

/** B2 — tilted second patch that needs real tangency correction. */
function sceneTilt(): Scene {
  const a = build(uni(7), uni(7), 3, (u, v) => [u, v, 0.45 * u * u + 0.08 * u * v], 'A');
  const b = build(
    knotsFromBreaks(3, [0.2, 0.45, 0.7]),
    knotsFromBreaks(3, [0.33]),
    3,
    (s, t) => [1.2 + 0.8 * s, t, 0.45 + 0.1 * t + 0.6 * s + 0.25 * s * s + 0.35 * s * t],
    'B',
  );
  return {
    id: 'tilt',
    name: '倾斜邻片 / 曲边界',
    description:
      'A 为弯曲薄片，B 与其分离并带倾角接上来。初始位置间隙与法线夹角都较大，' +
      '需要求解控制点才能达到 G0/G1。',
    a,
    b,
    sideA: 'u1',
    sideB: 'u0',
    direction: 1,
    continuity: 'G1',
    fixed: 'A',
    deformRows: 3,
    note: '初始法线夹角较大；G1 应把切平面偏差压到接近 0，但速度比保持不等于 1。',
  };
}

/** B3 — boundary direction reversed. */
function sceneReversed(): Scene {
  const a = build(uni(7), uni(6), 3, (u, v) => [u, v, 0.4 * u * u + 0.1 * u * v], 'A');
  const b = build(
    knotsFromBreaks(3, [0.25, 0.5, 0.75]),
    uni(6),
    3,
    (s, t) => [1.15 + 0.7 * s, 1 - t, 0.4 + 0.1 * (1 - t) + 0.5 * s + 0.2 * s * s + 0.3 * s * (1 - t)],
    'B',
  );
  // Reversing the boundary walk flips dU x dV; declare the matching outside.
  const bFlipped = withOrientation(b, -1);
  return {
    id: 'reversed',
    name: '边界走向相反',
    description:
      'B 的 u=0 边界参数走向与 A 的 u=1 边界相反。工具需自动/手动反转对应方向，' +
      '绝不能按相同索引比较控制点。',
    a,
    b: bFlipped,
    sideA: 'u1',
    sideB: 'u0',
    direction: -1,
    continuity: 'G1',
    fixed: 'A',
    deformRows: 3,
    note: '方向应识别为 -1；若强制 +1，位置误差会显著变大。',
  };
}

/** B4 — different knot density (non-uniform vs uniform). */
function sceneDensity(): Scene {
  const a = build(uni(8), uni(7), 3, (u, v) => [u, v, 0.3 * Math.sin(1.6 * v) * u + 0.25 * u * u], 'A');
  const b = build(
    knotsFromBreaks(3, [0.12, 0.18, 0.55, 0.85]),
    knotsFromBreaks(3, [0.1, 0.9]),
    3,
    (s, t) => [1.18 + 0.8 * s, t, 0.3 * Math.sin(1.6 * t) + 0.45 * s + 0.2 * s * s + 0.25 * s * t],
    'B',
  );
  return {
    id: 'density',
    name: '不同节点密度',
    description:
      '两片沿接边的节点分布完全不同。几何对应必须按弧长匹配，' +
      '参数对应则会把不同几何位置的点强行对齐并导致形状扭曲。',
    a,
    b,
    sideA: 'u1',
    sideB: 'u0',
    direction: 1,
    continuity: 'G1',
    fixed: 'B',
    deformRows: 4,
    note: '对比“弧长对应”和“参数对应”的位置间隙差异；两片节点分布不同，固定 B 时自由侧才能完全贴合。',
  };
}

/** B5 — curved boundary requiring genuine conforming of a curved seam. */
function sceneCurved(): Scene {
  const a = build(uni(8), uni(8), 3, (u, v) => [
    u,
    v + 0.18 * Math.sin(Math.PI * v) * u,
    0.5 * u * u + 0.12 * Math.cos(2 * v) * u,
  ], 'A');
  const b = build(
    knotsFromBreaks(3, [0.22, 0.5, 0.78]),
    knotsFromBreaks(3, [0.18, 0.62]),
    3,
    (s, t) => [
      1.22 + 0.7 * s,
      t + 0.18 * Math.sin(Math.PI * t) + 0.1 * s * Math.sin(Math.PI * t),
      0.62 + 0.12 * Math.cos(2 * t) + 0.35 * s + 0.2 * s * s + 0.3 * s * t,
    ],
    'B',
  );
  return {
    id: 'curved',
    name: '弯曲接边',
    description:
      '接缝是一条空间曲线，叶状弯曲。检验弯曲边界上的对应、法线与位置误差，' +
      '避免沿直线假设导致的错配。',
    a,
    b,
    sideA: 'u1',
    sideB: 'u0',
    direction: 1,
    continuity: 'G1',
    fixed: 'B',
    deformRows: 4,
    note: '弯曲接边下弧长对应与参数对应差别明显。',
  };
}

/** B6 — impossible under the given fixed side / shape preference. */
function sceneConflict(): Scene {
  const a = build(uni(6, 2), uni(6, 2), 2, (u, v) => [u, v, 0.3 * u], 'A');
  const b = build(uni(6, 2), uni(6, 2), 2, (s, t) => [1.5 + 0.8 * s, t, 0.6 * s], 'B');
  return {
    id: 'conflict',
    name: '固定侧受限 / 约束冲突',
    description:
      'A 与 B 分离且 B 带入明显倾角。把变形行数设为 1 时，仅一行控制点无法同时闭合位置间隙并扭转切平面，' +
      '工具应返回“约束冲突”，而不是把整片模型平移来掩盖问题。',
    a,
    b,
    sideA: 'u1',
    sideB: 'u0',
    direction: 1,
    continuity: 'G1',
    fixed: 'B',
    deformRows: 1,
    note: '默认变形 1 行 + 固定 B：位置与切平面无法同时满足，应出现冲突提示。增大变形行数后应转为成功。',
  };
}

/**
 * B7 — a clean, localised end conflict for the lock-edge / concession lab.
 * The pair starts as an almost perfect C1 match; the V=1 end control column of B
 * is then pushed away to mimic an incompatible neighbouring face that holds
 * that edge. With `side1` locked the solver cannot heal the last seam segment;
 * releasing that one edge removes exactly that segment (measured, not asserted).
 */
function sceneLockLab(): Scene {
  const nu = 8;
  const nv = 13;
  const a = build(uni(nu, 3), uni(nv, 3), 3, (u, v) => [u, v, 0], 'A');
  const bPerfect = build(
    uni(nu, 3),
    uni(nv, 3),
    3,
    (s, t) => [1 + s, t, 0.35 * s * s],
    'B',
  );
  const cps = bPerfect.cps.map((row) => row.map((q) => [...q] as Vec3));
  for (let i = 0; i < nu; i++) {
    const fall = 1 - i / (nu - 1);
    cps[i][nv - 1][0] += 0.16 * fall;
    cps[i][nv - 1][2] += 0.3 * fall;
  }
  const b = withCps(bPerfect, cps, 'B');
  return {
    id: 'locklab',
    name: '锁定边冲突 / 让步预演',
    description:
      '两片本已几乎完全连续，仅 B 的 V=1 端列被外侧邻面顶偏。该端边默认锁定，' +
      '求解后只有接缝末段超差；在右侧对该锁定边做“松开预演”，可看到将消除哪段误差折线、' +
      '需要多大的控制点让步，并可在副本上应用后重新量测。',
    a,
    b,
    sideA: 'u1',
    sideB: 'u0',
    direction: 1,
    continuity: 'G1',
    fixed: 'A',
    deformRows: 6,
    edgeLocks: { opposite: false, side0: false, side1: true },
    correspondenceMode: 'parameter',
    note: '选中“终点侧边 side1”查看松开效果：误差段应在解析复检中消失，让步箭头即该边控制点位移。',
  };
}

export const SCENES: Scene[] = [
  sceneSpeed(),
  sceneTilt(),
  sceneReversed(),
  sceneDensity(),
  sceneCurved(),
  sceneConflict(),
  sceneLockLab(),
];

export function getScene(id: string): Scene {
  const s = SCENES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scene: ${id}`);
  return s;
}
