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

const store = new AppStore('tilt');
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
  statusTitle.textContent = state.result ? titles[state.statusKind] ?? '结果' : '待求解';
  statusDetail.textContent = state.statusText;

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

  // Chart
  drawChart(state);
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
$('btn-solve').addEventListener('click', () => store.runSolve());
$('btn-reset').addEventListener('click', () => store.resetGeometry());
$('btn-focus').addEventListener('click', () => viewport.focusSeam());
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
