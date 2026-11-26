import type { Evidence, CompactComparison } from './run.js';

/** Marker block ids embedded in docs/surface-seam-experiments.md. */
export const BLOCK_IDS = [
  'velocity',
  'dof',
  'modellock',
  'bump',
  'reverse',
  'degrees',
  'scenes',
  'locks',
] as const;

function f(x: number | null | undefined, d = 3): string {
  if (x === null || x === undefined) return '—';
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  const ax = Math.abs(x);
  if (ax < 1e-3) return x.toExponential(1);
  if (ax >= 100) return x.toFixed(0);
  return x.toFixed(d);
}

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return '—';
  return `${(x * 100).toFixed(0)}%`;
}

function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

function compactLines(title: string, c: CompactComparison): string {
  const clusters = c.exclusiveClusters.length
    ? c.exclusiveClusters
        .map((k) => `${k.level} ξ ${k.xi0.toFixed(2)}–${k.xi1.toFixed(2)}（C1 失配 ${f(k.maxC1, 2)}，局部位移 ${f(k.maxMoveC1)}）`)
        .join('；')
    : '无';
  return [
    `**${title}**：实测推荐 **${c.recommendation}**。`,
    '',
    `- G1：状态 ${c.g1Status}，最大切平面偏差 ${f(c.g1Tan)}°，最大控制点位移 ${f(c.g1Move)}，零空间 ${c.nullityG1}。`,
    `- C1：状态 ${c.c1Status}，最大 C1 失配 ${f(c.c1C1)}，最大控制点位移 ${f(c.c1Move)}，曲面采样偏差 ${f(c.c1Dev)}，零空间 ${c.nullityC1}。`,
    `- 冲突段：${clusters}。`,
  ].join('\n');
}

export function renderBlocks(e: Evidence): Record<(typeof BLOCK_IDS)[number], string> {
  const velocity = table(
    ['λ（横向速度比）', 'G1 位移', 'G1 切平面°', 'G1 速度比', 'G1 的 C1 失配', 'C1 位移', 'C1 失配', 'C1 速度比', 'C1 曲面偏差', 'C1 形变能'],
    e.velocity.map((v) => [
      String(v.lambda),
      f(v.g1Move, 4),
      f(v.g1Tan, 3),
      v.g1Ratio,
      f(v.g1C1, 2),
      f(v.c1Move, 4),
      f(v.c1C1, 2),
      v.c1Ratio,
      f(v.c1Dev, 4),
      f(v.c1Energy, 3),
    ]),
  );

  const dof = table(
    ['情形', '模式', '未知量', '约束秩', '零空间 DOF'],
    e.dof.map((d) => [d.case, d.mode, String(d.variables), String(d.constraintRank), String(d.nullity)]),
  );

  const modellock = [
    compactLines('不附加边界锁 / 变形 3 行', e.modelLock.noLock),
    '',
    compactLines('锁住对侧边 opposite / 全部 8 行可变形', e.modelLock.oppositeLocked),
  ].join('\n');

  const bumpLines = [
    `局部鼓包速度剖面的实测速度比范围：**${f(e.bump.ratioMin, 2)} – ${f(e.bump.ratioMax, 2)}**。`,
    '',
    compactLines('变形 1 行 + 三侧全锁', e.bump.rows1),
    '',
    compactLines('变形 2 行 + 三侧全锁', e.bump.rows2),
    '',
    '**变形 2 行时，仅松开 side1 的反事实复检：**',
    '',
    table(
      ['量', '锁定', '仅松开 side1 后'],
      [
        ['最大间隙', f(e.bump.releaseSide1.beforeGap), f(e.bump.releaseSide1.afterGap)],
        ['最大切平面偏差°', f(e.bump.releaseSide1.beforeTan, 3), f(e.bump.releaseSide1.afterTan, 3)],
        ['最大 C1 失配', f(e.bump.releaseSide1.beforeC1, 4), f(e.bump.releaseSide1.afterC1, 4)],
        ['最大让步控制点位移', f(e.bump.releaseSide1.concession, 4), '—'],
        ['超差样本占比', pct(e.bump.releaseSide1.badFractionBefore), '—'],
        ['消除样本 / 超差样本', '—', pct(e.bump.releaseSide1.healedFractionOfBad)],
        ['消除 / 缓解 / 显著压低段数', '—', `${e.bump.releaseSide1.eliminatedRanges} / ${e.bump.releaseSide1.relievedRanges} / ${e.bump.releaseSide1.improvedRanges}`],
      ],
    ),
  ].join('\n');

  const reverse = table(
    ['对应方向', '阶段', '最大间隙', '切平面偏差°', '法向相反', '状态'],
    e.reverse.map((r) => [
      r.direction === -1 ? '-1（正确反向）' : '+1（错误同向）',
      r.stage === 'initial' ? '原始两片' : 'G1 求解后',
      f(r.maxGap),
      f(r.tangentDeg, 3),
      r.opposed ? '是' : '否',
      r.status ?? '未求解',
    ]),
  );

  const degrees = table(
    ['次数组合', 'CP 网格', 'G1 位移', 'G1 切平面°', 'G1 状态', 'C1 位移', 'C1 失配', 'C1 状态'],
    e.degrees.map((d) => [
      d.degrees,
      `${d.nu}×${d.nv}`,
      f(d.g1Move, 4),
      f(d.g1Tan, 3),
      d.g1Status,
      f(d.c1Move, 4),
      f(d.c1C1, 2),
      d.c1Status,
    ]),
  );

  const scenes = table(
    ['场景', '模式', '固定侧', '行数', '状态', '最大间隙', '切平面°', 'C1 失配', '最大位移'],
    e.scenes.map((s) => [
      s.scene,
      s.mode,
      s.fixed,
      String(s.deformRows),
      s.status,
      f(s.maxGap),
      f(s.tangentDeg, 3),
      f(s.c1, 2),
      f(s.maxMove, 4),
    ]),
  );

  const locks = table(
    ['边', '参与', '让步位移', '间隙 锁→松', '切平面° 锁→松', 'C1 失配 锁→松', '超差占比', '消除/超差', '消/缓/压段'],
    e.locks.map((l) => [
      l.edge,
      l.participates ? '是' : '否',
      f(l.concession, 4),
      `${f(l.beforeGap)} → ${f(l.afterGap)}`,
      `${f(l.beforeTan, 2)} → ${f(l.afterTan, 3)}`,
      `${f(l.beforeC1, 2)} → ${f(l.afterC1, 2)}`,
      pct(l.badFractionBefore),
      pct(l.healedFractionOfBad),
      `${l.eliminatedRanges}/${l.relievedRanges}/${l.improvedRanges}`,
    ]),
  );

  return {
    velocity,
    dof,
    modellock,
    bump: bumpLines,
    reverse,
    degrees,
    scenes,
    locks,
  };
}
