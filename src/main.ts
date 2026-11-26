import { AppStore } from './ui/store.js';
import { Viewport } from './ui/viewport.js';
import { SCENES } from './core/scenes.js';
import { Side } from './core/seam.js';
import { exportBundle } from './core/exporters.js';
import { AppState } from './ui/store.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const store = new AppStore('locklab');
const viewportContainer = $<HTMLDivElement>('viewport');
const viewport = new Viewport(viewportContainer, store, (which, side) => {
  if (which === 'A' && store.state.sideA !== side) {
    store.setSide('A', side);
    syncSelects(store.state);
  } else if (which === 'B' && store.state.sideB !== side) {
    store.setSide('B', side);
    syncSelects(store.state);
  }
});

// ---------- populate selects ----------
const sceneSelect = $<HTMLSelectElement>('scene-select');
for (const sc of SCENES) {
  const opt = document.createElement('option');
  opt.value = sc.id;
  opt.textContent = sc.name;
  sceneSelect.appendChild(opt);
}
sceneSelect.value = store.state.scene.id;

const sideOptions: Array<{ value: Side; label: string }> = [
  { value: 'u0', label: 'U = 0' },
  { value: 'u1', label: 'U = 1' },
  { value: 'v0', label: 'V = 0' },
  { value: 'v1', label: 'V = 1' },
];
for (const id of ['side-a', 'side-b']) {
  const sel = $<HTMLSelectElement>(id);
  for (const o of sideOptions) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
}

const directionSel = $<HTMLSelectElement>('direction');
const corrModeSel = $<HTMLSelectElement>('corr-mode');
const fixedSel = $<HTMLSelectElement>('fixed-side');
const deformInput = $<HTMLInputElement>('deform-rows');
const deformOut = $<HTMLOutputElement>('deform-out');
const stiffnessInput = $<HTMLInputElement>('stiffness');
const stiffnessOut = $<HTMLOutputElement>('stiffness-out');
const biasInput = $<HTMLInputElement>('shape-bias');
const biasOut = $<HTMLOutputElement>('bias-out');
const samplesInput = $<HTMLInputElement>('samples');
const samplesOut = $<HTMLOutputElement>('samples-out');
const sceneNote = $<HTMLParagraphElement>('scene-note');
const continuityHint = $<HTMLParagraphElement>('continuity-hint');
const statusBanner = $<HTMLDivElement>('status-banner');
const statusTitle = $<HTMLElement>('status-title');
const statusDetail = $<HTMLParagraphElement>('status-detail');
const statsList = $<HTMLUListElement>('solve-stats');
const metricGrid = $<HTMLDivElement>('metric-grid');
const metricExplainer = $<HTMLParagraphElement>('metric-explainer');
const errorChart = $<HTMLCanvasElement>('error-chart');
const exportRes = $<HTMLSelectElement>('export-res');
const lockInputs: Record<'opposite' | 'side0' | 'side1', HTMLInputElement> = {
  opposite: $<HTMLInputElement>('lock-opposite'),
  side0: $<HTMLInputElement>('lock-side0'),
  side1: $<HTMLInputElement>('lock-side1'),
};
const budgetInput = $<HTMLInputElement>('move-budget');
const budgetOut = $<HTMLOutputElement>('budget-out');
const compareBtn = $<HTMLButtonElement>('btn-compare');
const labBusy = $<HTMLParagraphElement>('lab-busy');
const solveState = $<HTMLSpanElement>('solve-state');
const recBox = $<HTMLDivElement>('rec-box');
const dofList = $<HTMLDivElement>('dof-list');
const clusterList = $<HTMLUListElement>('cluster-list');
const anomalyList = $<HTMLUListElement>('anomaly-list');
const edgeList = $<HTMLDivElement>('edge-list');
const edgePreviewText = $<HTMLDivElement>('edge-preview-text');
const edgeTrialBtn = $<HTMLButtonElement>('btn-edge-trial');
const trialBar = $<HTMLDivElement>('trial-bar');
const trialText = $<HTMLSpanElement>('trial-text');

/** Map the 0..100 stiffness slider to a log scale. */
const sliderToStiffness = (v: number) => Math.pow(10, -4 + (v / 100) * 3); // 1e-4 .. 1e-1
const stiffnessToSlider = (s: number) => ((Math.log10(s) + 4) / 3) * 100;

function syncSelects(st: AppState) {
  sceneSelect.value = st.scene.id;
  $<HTMLSelectElement>('side-a').value = st.sideA;
  $<HTMLSelectElement>('side-b').value = st.sideB;
  directionSel.value = String(st.direction);
  corrModeSel.value = st.correspondenceMode;
  fixedSel.value = st.fixed;
  deformInput.value = String(st.deformRows);
  deformOut.textContent = String(st.deformRows);
  stiffnessInput.value = String(Math.round(stiffnessToSlider(st.stiffness)));
  stiffnessOut.textContent = st.stiffness.toFixed(3);
  biasInput.value = String(Math.round(st.shapeBias * 100));
  biasOut.textContent = st.shapeBias.toFixed(1);
  samplesInput.value = String(st.samples);
  samplesOut.textContent = String(st.samples);
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#continuity-seg button')) {
    btn.classList.toggle('active', btn.dataset.mode === st.continuity);
  }
  (Object.keys(lockInputs) as Array<keyof typeof lockInputs>).forEach((edge) => {
    lockInputs[edge].checked = st.edgeLocks[edge];
  });
  const budgetPct = Math.round(st.moveBudgetFrac * 100);
  budgetInput.value = String(budgetPct);
  budgetOut.textContent = `${budgetPct}%`;
  sceneNote.textContent = `${st.scene.description}  ${st.scene.note}`;
}

const continuityHints: Record<string, string> = {
  G0: '仅闭合位置间隙：接缝点重合，但两侧切平面可存在折角。',
  G1: '要求共同切平面：自由侧横向导数须位于固定侧切平面内，参数速度可不同。',
  C1: '要求参数导数相等：横向与沿边导数都需匹配，参数速度不同时会强制压缩近缝控制行。',
};

function render(state: AppState) {
  syncSelects(state);
  continuityHint.textContent = continuityHints[state.continuity];

  // Status banner
  statusBanner.className = `status-banner ${state.statusKind}`;
  const titles: Record<string, string> = {
    ok: '拼接成功',
    conflict: '约束冲突',
    degenerate: '求解退化',
    info: '待求解',
  };
  statusTitle.textContent = state.trial
    ? '副本已应用 · 待保留/还原'
    : state.result
      ? (titles[state.statusKind] ?? '结果')
      : state.statusKind === 'info'
        ? '待求解'
        : titles[state.statusKind];
  statusDetail.textContent = state.statusText;

  solveState.className = `run-state${state.solving ? ' busy' : ''}`;
  solveState.textContent = state.solving
    ? '● 求解中…'
    : state.lastSolveMs !== null
      ? `就绪 · 上次求解 ${state.lastSolveMs.toFixed(0)} ms`
      : '就绪';
  compareBtn.disabled = state.comparisonBusy;
  $('btn-solve').toggleAttribute('disabled', state.solving);
  labBusy.textContent = state.comparisonBusy
    ? '路线对比计算中：各跑一次 G1 与 C1 求解并解析复检…'
    : state.labRunMs !== null
      ? `路线对比完成 · 耗时 ${state.labRunMs.toFixed(0)} ms（阈值随模型尺度缩放）`
      : '';

  // Solve stats
  statsList.innerHTML = '';
  const r = state.result?.report;
  const rows: Array<[string, string]> = [];
  if (r) {
    rows.push(['状态', r.status === 'ok' ? '成功' : r.status === 'conflict' ? '冲突' : '退化']);
    rows.push(['条件方程', `${r.positionRows} 位置 + ${r.tangentRows} 切向`]);
    rows.push(['变量 / 秩', `${r.variables} / ${r.rank}`]);
    rows.push(['动控制点', `${r.movedCps}（最大位移 ${r.maxControlMove.toPrecision(3)}）`]);
    rows.push(['变形行数', String(r.deformationRows)]);
    rows.push(['LS 残差', r.residual.toExponential(2)]);
  } else {
    rows.push(['状态', '尚未求解']);
  }
  for (const [k, v] of rows) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${k}</span><span>${v}</span>`;
    statsList.appendChild(li);
  }

  // Metrics
  renderMetrics(state);
  renderAnomalies(state);
  renderComparison(state);
  renderEdgeLab(state);
  renderTrialBar(state);

  // Chart
  drawChart(state);
}

const levelLabel: Record<string, string> = {
  blocked: '连接受阻',
  exclusive: '不可兼得',
  costly: '代价过高',
};

function renderAnomalies(state: AppState) {
  anomalyList.innerHTML = '';
  if (!state.metrics) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = '尚无接缝数据。';
    anomalyList.appendChild(li);
    return;
  }
  if (!state.anomalies.length) {
    const li = document.createElement('li');
    li.className = 'cluster-item good';
    li.textContent = '当前接缝在阈值内未标出连接/连续异常。';
    anomalyList.appendChild(li);
    return;
  }
  for (const c of state.anomalies) {
    const li = document.createElement('li');
    li.className = `cluster-item ${c.level}`;
    li.dataset.anomalyId = String(c.id);
    li.innerHTML = `
      <div class="cluster-head"><span class="cluster-badge ${c.level}">${levelLabel[c.level] ?? c.level}</span>
      <span class="cluster-range">ξ ${c.xi0.toFixed(2)}–${c.xi1.toFixed(2)} · ${c.count} 点</span></div>
      <div class="cluster-meta">间隙 ${fmtSci(c.maxGap)} · 切平面 ${c.maxTangentPlaneDeg.toFixed(2)}°${
        state.continuity === 'C1' ? ` · C1 ${fmtSci(c.maxC1Mismatch)}` : ''
      }</div>
      <div class="cluster-locate">点击三维定位 →</div>`;
    anomalyList.appendChild(li);
  }
}

function renderComparison(state: AppState) {
  const cmp = state.comparison;
  if (!cmp) {
    recBox.className = 'rec-box info';
    recBox.textContent = state.comparisonBusy ? '正在实测两条路线…' : '尚未运行路线对比。';
    dofList.innerHTML = '';
    clusterList.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = '点击左栏“实测 G1 / C1 路线对比”，将据两次真实求解自动标出不可兼得位置。';
    clusterList.appendChild(li);
    return;
  }
  recBox.className = `rec-box rec-${cmp.recommendation.toLowerCase()}`;
  recBox.innerHTML = `<strong>实测推荐：优先 ${cmp.recommendation}</strong>
    <ul class="rec-reasons">${cmp.recommendationReasons.map((r) => `<li>${r}</li>`).join('')}</ul>`;

  const rows: Array<[string, string]> = [
    [
      'G1',
      `变量 ${cmp.g1.dof.variables} · 约束秩 ${cmp.g1.dof.constraintRank} · 零空间 ${cmp.g1.dof.nullity} · 最大位移 ${fmtSci(cmp.g1.move.max)} · 切平面 ${cmp.g1.metrics.maxTangentPlaneDeg.toExponential(1)}°`,
    ],
    [
      'C1',
      `变量 ${cmp.c1.dof.variables} · 约束秩 ${cmp.c1.dof.constraintRank} · 零空间 ${cmp.c1.dof.nullity} · 最大位移 ${fmtSci(cmp.c1.move.max)} · C1 失配 ${cmp.c1.metrics.maxC1Mismatch.toExponential(1)}`,
    ],
    ['让步预算', `最大控制点位移 ≤ ${cmp.thresholds.moveBudget.toFixed(4)}（${Math.round(state.moveBudgetFrac * 100)}% 模型尺度）`],
  ];
  dofList.innerHTML = '';
  for (const [k, v] of rows) {
    const div = document.createElement('div');
    div.className = 'dof-row';
    div.innerHTML = `<span class="dof-mode">${k}</span><span class="dof-val">${v}</span>`;
    dofList.appendChild(div);
  }

  clusterList.innerHTML = '';
  if (!cmp.g1.clusters.length) {
    const li = document.createElement('li');
    li.className = 'cluster-item good';
    li.textContent = '两条路线在当前阈值与预算内没有冲突段：C1 可达且代价在预算内（故推荐 C1）。';
    clusterList.appendChild(li);
    return;
  }
  for (const c of cmp.g1.clusters) {
    const li = document.createElement('li');
    li.className = `cluster-item ${c.level}${state.selectedClusterId === c.id ? ' selected' : ''}`;
    li.dataset.clusterId = String(c.id);
    li.innerHTML = `
      <div class="cluster-head"><span class="cluster-badge ${c.level}">${levelLabel[c.level] ?? c.level}</span>
      <span class="cluster-range">#${c.id} ξ ${c.xi0.toFixed(2)}–${c.xi1.toFixed(2)} · ${c.count} 点</span></div>
      <div class="cluster-meta">间隙 ${fmtSci(c.maxGap)} · 切平面 ${c.maxTangentPlaneDeg.toFixed(2)}° · C1 ${fmtSci(c.maxC1Mismatch)} · C1 局部位移 ${fmtSci(c.maxLocalMoveC1)}</div>
      <div class="cluster-locate">点击在三维视窗定位 →</div>`;
    clusterList.appendChild(li);
  }
}

const EDGE_NAMES: Record<'opposite' | 'side0' | 'side1', string> = {
  opposite: '对侧边 opposite（远排）',
  side0: '起点侧边 side0',
  side1: '终点侧边 side1',
};

function renderEdgeLab(state: AppState) {
  edgeList.innerHTML = '';
  (['opposite', 'side0', 'side1'] as const).forEach((edge) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `edge-row${state.selectedLockEdge === edge ? ' selected' : ''}${state.edgeLocks[edge] ? ' locked' : ''}`;
    row.dataset.edge = edge;
    const lockTag = state.edgeLocks[edge] ? '🔒 已锁定' : '未锁定';
    row.innerHTML = `<span class="edge-name">${EDGE_NAMES[edge]}</span><span class="edge-lock-tag">${lockTag}</span>`;
    edgeList.appendChild(row);
  });

  const edge = state.selectedLockEdge;
  const pv = state.edgePreview;
  if (!edge) {
    edgePreviewText.innerHTML =
      '<p class="hint">选择一根边：已锁定的边会直接做“锁定 vs 仅松开”两次求解预演；未锁定的边会先为你勾选锁定。</p>';
    edgeTrialBtn.hidden = true;
    return;
  }
  if (!state.edgeLocks[edge]) {
    edgePreviewText.innerHTML = `<p class="hint">${EDGE_NAMES[edge]} 当前未锁定。点击上方边条即可锁定并预演“松开它”的效果。</p>`;
    edgeTrialBtn.hidden = true;
    return;
  }
  if (state.previewBusy || !pv) {
    edgePreviewText.innerHTML = `<p class="hint busy-line">正在对 ${EDGE_NAMES[edge]} 做两次求解与解析复检…</p>`;
    edgeTrialBtn.hidden = true;
    return;
  }

  const rangeLine = (label: string, ranges: typeof pv.healed, cls: string) =>
    ranges.length
      ? `<div class="heal-line ${cls}"><b>${label} ${ranges.length} 段：</b>` +
        ranges
          .map(
            (r) =>
              `ξ ${r.xi0.toFixed(2)}–${r.xi1.toFixed(2)}（角 ${r.tanBeforeMax.toFixed(2)}°→${r.tanAfterMax.toExponential(1)}°，缓解 ${(r.relief * 100).toFixed(0)}%）`,
          )
          .join('；') +
        '</div>'
      : '';

  edgePreviewText.innerHTML = `
    <div class="pv-grid">
      <div><span>最大让步位移</span><b>${fmtSci(pv.maxConcession)}</b></div>
      <div><span>该边是否参与约束</span><b>${pv.edgeParticipates ? '是' : '否（位移≈0，松开无可测影响）'}</b></div>
      <div><span>最大间隙 锁→松</span><b>${fmtSci(pv.before.maxGap)} → ${fmtSci(pv.after.maxGap)}</b></div>
      <div><span>切平面° 锁→松</span><b>${pv.before.maxTangentPlaneDeg.toFixed(3)} → ${pv.after.maxTangentPlaneDeg.toExponential(2)}</b></div>
      <div><span>C1 失配 锁→松</span><b>${fmtSci(pv.before.maxC1Mismatch)} → ${fmtSci(pv.after.maxC1Mismatch)}</b></div>
      <div><span>锁解超差占比 / 被消除占超差</span><b>${(pv.badFractionBefore * 100).toFixed(0)}% / ${(pv.healedFraction * 100).toFixed(0)}%</b></div>
    </div>
    ${rangeLine('消除', pv.healed, 'healed')}
    ${rangeLine('缓解', pv.relieved, 'relieved')}
    ${rangeLine('显著压低', pv.improved, 'improved')}
    ${
      !pv.healed.length && !pv.relieved.length && !pv.improved.length
        ? '<p class="hint">两次求解的误差折线没有可标记的消除/缓解段：这根锁不是当前误差的主要来源（或预算阈值内本就合格）。</p>'
        : ''
    }`;
  edgeTrialBtn.hidden = !pv.edgeParticipates;
  edgeTrialBtn.textContent = `在副本上松开 ${edge} 并重新量测（让步 ${fmtSci(pv.maxConcession)}）`;
}

function renderTrialBar(state: AppState) {
  if (!state.trial) {
    trialBar.hidden = true;
    return;
  }
  trialBar.hidden = false;
  trialText.textContent = `试验副本中：已松开 ${state.trial.edge}，接缝已按副本结果重新量测。保留后将以该结果作为后续求解基准，或还原到应用前。`;
}

function fmtSci(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (Math.abs(n) < 1e-3 || Math.abs(n) >= 1e4) return n.toExponential(2);
  return n.toFixed(4);
}

function renderMetrics(state: AppState) {
  metricGrid.innerHTML = '';
  const m = state.metrics;
  if (!m) {
    metricExplainer.textContent = '尚无有效接缝数据。';
    return;
  }
  const cards: Array<{ label: string; value: string; unit: string; cls: string }> = [];
  const gapCls = m.maxGap < 1e-5 ? 'ok' : m.maxGap < 1e-3 ? 'warn' : 'bad';
  cards.push({ label: '最大位置间隙', value: fmtSci(m.maxGap), unit: '', cls: gapCls });
  const tCls = m.maxTangentPlaneDeg < 0.1 ? 'ok' : m.maxTangentPlaneDeg < 1 ? 'warn' : 'bad';
  cards.push({ label: '切平面偏差', value: m.maxTangentPlaneDeg.toFixed(3), unit: '°', cls: tCls });
  const nCls = m.maxNormalAngleDeg < 0.1 ? 'ok' : m.maxNormalAngleDeg < 1 ? 'warn' : 'bad';
  cards.push({ label: '法线夹角', value: m.maxNormalAngleDeg.toFixed(3), unit: '°', cls: nCls });
  const speedSpread = Math.max(m.maxSpeedRatio - m.minSpeedRatio, 0);
  const sCls = speedSpread < 0.01 ? 'ok' : m.maxSpeedRatio / (m.minSpeedRatio || 1) < 1.2 ? 'warn' : 'bad';
  cards.push({
    label: '参数速度比',
    value: `${m.minSpeedRatio.toFixed(2)}–${m.maxSpeedRatio.toFixed(2)}`,
    unit: '',
    cls: sCls,
  });
  const cCls = m.maxC1Mismatch < 1e-2 ? 'ok' : m.maxC1Mismatch < 0.2 ? 'warn' : 'bad';
  cards.push({ label: 'C1 失配 |∂A+∂B|/|∂A|', value: fmtSci(m.maxC1Mismatch), unit: '', cls: cCls });
  cards.push({
    label: '沿边切向偏差',
    value: m.maxAlongMismatchDeg.toFixed(3),
    unit: '°',
    cls: m.maxAlongMismatchDeg < 0.1 ? 'ok' : 'warn',
  });

  for (const c of cards) {
    const div = document.createElement('div');
    div.className = `metric-card ${c.cls}`;
    div.innerHTML = `<span class="label">${c.label}</span><span class="value">${c.value}<span class="unit">${c.unit}</span></span>`;
    metricGrid.appendChild(div);
  }

  const speed = m.minSpeedRatio;
  const message: string[] = [];
  if (Math.abs(speed - 1) > 0.05) {
    message.push(
      `两侧参数速度不等（约 ${speed.toFixed(2)} 倍）。此时切平面可以连续，但参数导数不相等；G1 与 C1 会给出不同调整。`,
    );
  }
  if (m.maxC1Mismatch > 0.05 && m.maxTangentPlaneDeg < 0.5) {
    message.push('切平面已对齐而 C1 失配较大——这正是几何连续与参数连续的区别。');
  }
  if (m.facingOpposed) message.push('注意：两侧法向朝向相反。');
  metricExplainer.textContent = message.join(' ');
}

function drawChart(state: AppState) {
  const ctx = errorChart.getContext('2d');
  if (!ctx) return;
  const W = errorChart.width;
  const H = errorChart.height;
  ctx.clearRect(0, 0, W, H);
  const m = state.metrics;
  const padL = 44;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const css = getComputedStyle(document.documentElement);
  const dim = css.getPropertyValue('--text-dim').trim() || '#8b9bb1';
  const line = css.getPropertyValue('--line').trim() || '#2a3444';

  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  if (!m || m.samples.length < 2) {
    ctx.fillStyle = dim;
    ctx.font = '12px sans-serif';
    ctx.fillText('暂无数据', padL + 8, padT + plotH / 2);
    return;
  }
  const gaps = m.samples.map((s) => s.gap);
  const maxG = Math.max(...gaps, 1e-12);
  // choose a scale
  const scale = niceCeil(maxG);

  // gridlines + y labels
  ctx.fillStyle = dim;
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (i / 4) * plotH;
    const val = (scale * i) / 4;
    ctx.strokeStyle = '#1c2532';
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = dim;
    ctx.fillText(formatTick(val), padL - 6, y);
  }

  // gap curve
  ctx.beginPath();
  m.samples.forEach((s, i) => {
    const x = padL + (i / (m.samples.length - 1)) * plotW;
    const y = padT + plotH - (s.gap / scale) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#8fe3ff';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // normal-angle curve (scaled to its own max, drawn in orange)
  const maxN = Math.max(...m.samples.map((s) => s.normalAngleDeg), 1e-6);
  ctx.beginPath();
  m.samples.forEach((s, i) => {
    const x = padL + (i / (m.samples.length - 1)) * plotW;
    const y = padT + plotH - (s.normalAngleDeg / maxN) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = 'rgba(255,180,100,0.8)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // max marker
  if (m.worstGapAt) {
    const idx = m.samples.findIndex((s) => s.tA === m.worstGapAt!.tA && s.tB === m.worstGapAt!.tB);
    if (idx >= 0) {
      const x = padL + (idx / (m.samples.length - 1)) * plotW;
      const y = padT + plotH - (m.samples[idx].gap / scale) * plotH;
      ctx.fillStyle = '#ff5a5a';
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // legend
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#8fe3ff';
  ctx.fillText('— 位置间隙', padL + 4, padT + 2);
  ctx.fillStyle = 'rgba(255,180,100,0.9)';
  ctx.fillText('— 法线夹角（独立缩放）', padL + 80, padT + 2);
  ctx.fillStyle = dim;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('沿接缝归一化位置', padL + plotW / 2, padT + plotH + 8);
}

function niceCeil(v: number): number {
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const f = v / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

function formatTick(v: number): string {
  if (v === 0) return '0';
  if (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e4) return v.toExponential(0);
  return v.toPrecision(2);
}

// ---------- wire events ----------
sceneSelect.addEventListener('change', () => {
  store.loadScene(sceneSelect.value);
});
$('side-a').addEventListener('change', (e) => store.setSide('A', (e.target as HTMLSelectElement).value as Side));
$('side-b').addEventListener('change', (e) => store.setSide('B', (e.target as HTMLSelectElement).value as Side));
directionSel.addEventListener('change', () => store.setDirection(Number(directionSel.value) as 1 | -1));
corrModeSel.addEventListener('change', () =>
  store.setCorrespondenceMode(corrModeSel.value as 'arclength' | 'parameter'),
);
fixedSel.addEventListener('change', () => store.setFixed(fixedSel.value as 'A' | 'B'));
deformInput.addEventListener('input', () => {
  store.setDeformRows(Number(deformInput.value));
  deformOut.textContent = deformInput.value;
});
stiffnessInput.addEventListener('input', () => {
  const s = sliderToStiffness(Number(stiffnessInput.value));
  store.setStiffness(s);
  stiffnessOut.textContent = s.toFixed(3);
});
biasInput.addEventListener('input', () => {
  const v = Number(biasInput.value) / 100;
  store.setShapeBias(v * 3);
  biasOut.textContent = (v * 3).toFixed(1);
});
samplesInput.addEventListener('input', () => {
  store.setSamples(Number(samplesInput.value));
  samplesOut.textContent = samplesInput.value;
});
for (const btn of document.querySelectorAll<HTMLButtonElement>('#continuity-seg button')) {
  btn.addEventListener('click', () => store.setContinuity(btn.dataset.mode as 'G0' | 'G1' | 'C1'));
}
$('flip-a').addEventListener('click', () => store.flipOrientation('A'));
$('flip-b').addEventListener('click', () => store.flipOrientation('B'));
$('btn-solve').addEventListener('click', () => void store.runSolve());
$('btn-reset').addEventListener('click', () => store.resetGeometry());
$('btn-focus').addEventListener('click', () => viewport.focusSeam());
compareBtn.addEventListener('click', () => void store.runComparison());

(Object.keys(lockInputs) as Array<'opposite' | 'side0' | 'side1'>).forEach((edge) => {
  lockInputs[edge].addEventListener('change', () => store.toggleLock(edge, lockInputs[edge].checked));
});
budgetInput.addEventListener('input', () => {
  const pct = Number(budgetInput.value);
  budgetOut.textContent = `${pct}%`;
  store.setMoveBudgetFrac(pct / 100);
  store.recomputeMetrics();
});
$('arrow-gain').addEventListener('change', (e) =>
  store.setArrowExaggeration((e.target as HTMLInputElement).checked ? 8 : 1),
);

clusterList.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-cluster-id]');
  if (!li?.dataset.clusterId) return;
  store.selectCluster(Number(li.dataset.clusterId));
});
anomalyList.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-anomaly-id]');
  if (!li?.dataset.anomalyId) return;
  store.selectAnomaly(Number(li.dataset.anomalyId));
});
edgeList.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-edge]');
  const edge = row?.dataset.edge as 'opposite' | 'side0' | 'side1' | undefined;
  if (!edge) return;
  if (!store.state.edgeLocks[edge]) store.toggleLock(edge, true);
  void store.selectLockEdge(edge);
});
edgeTrialBtn.addEventListener('click', () => store.applyTrial());
$('btn-trial-keep').addEventListener('click', () => store.keepTrial());
$('btn-trial-discard').addEventListener('click', () => store.discardTrial());
$('show-reflect').addEventListener('change', (e) =>
  viewport.setVisualOptions({ stripes: (e.target as HTMLInputElement).checked }),
);
$('show-gap').addEventListener('change', (e) =>
  viewport.setVisualOptions({ gapComb: (e.target as HTMLInputElement).checked }),
);
$('show-net').addEventListener('change', (e) =>
  viewport.setVisualOptions({ controlNet: (e.target as HTMLInputElement).checked }),
);
$('btn-help').addEventListener('click', () => ($<HTMLDialogElement>('help-dialog') as HTMLDialogElement).showModal());

// ---------- exports ----------
function download(name: string, content: string | Blob, type = 'text/plain') {
  const blob = typeof content === 'string' ? new Blob([content], { type }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function currentBundle() {
  const st = store.state;
  const m = st.metrics;
  if (!m) throw new Error('尚无接缝数据，请先求解或加载场景。');
  return exportBundle(
    st.a,
    st.b,
    st.sideA,
    st.sideB,
    m,
    { resolution: Number(exportRes.value), includeSeam: true },
    {
      mode: st.continuity,
      correspondence: st.correspondenceMode === 'arclength' ? 'arc-length' : 'parameter',
      fixed: st.fixed,
      movedCps: st.result?.report.movedCps ?? 0,
      maxControlMove: st.result?.report.maxControlMove ?? 0,
    },
  );
}

$('export-json').addEventListener('click', () => {
  try {
    download('stitched-surfaces.json', currentBundle().json, 'application/json');
  } catch (e) {
    alert((e as Error).message);
  }
});
$('export-obj').addEventListener('click', () => {
  try {
    download('stitched-surfaces.obj', currentBundle().obj, 'text/plain');
  } catch (e) {
    alert((e as Error).message);
  }
});
$('export-csv').addEventListener('click', () => {
  try {
    download('seam-errors.csv', currentBundle().csv, 'text/csv');
  } catch (e) {
    alert((e as Error).message);
  }
});
$('export-txt').addEventListener('click', () => {
  try {
    download('stitch-report.txt', currentBundle().metricsText, 'text/plain');
  } catch (e) {
    alert((e as Error).message);
  }
});
$('export-png').addEventListener('click', () => {
  try {
    const url = viewport.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stitch-viewport.png';
    a.click();
  } catch (e) {
    alert((e as Error).message);
  }
});

// ---------- wire up ----------
store.subscribe((state) => {
  viewport.applyState(state);
  render(state);
});
viewport.applyState(store.state);
render(store.state);

// Launch straight into the lock/conflict lab with real solved evidence on screen.
void store.runSolve();
void store.runComparison();
void store.selectLockEdge('side1');
