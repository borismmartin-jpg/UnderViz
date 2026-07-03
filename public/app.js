// UnderViz client — fetches merged forecast series from the server, runs the
// shared physics pipeline in the browser (so the depth slider recomputes
// instantly), and renders the UI.

import { MODEL, PHYS } from '/lib/config.js';
import { runPipeline } from '/lib/physics.js';
import { SEED_SITES, BOTTOM_PRESETS, DEFAULT_FETCH } from '/lib/sites.js';

const LS_CUSTOM = 'underviz.customSites';
const LS_DEPTHS = 'underviz.depthOverrides';
const LS_LASTVIS = 'underviz.lastVis';

const $ = (sel) => document.querySelector(sel);
const DAY_MS = 86400e3;
const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const state = {
  sites: [],
  siteId: null,
  payload: null,   // server response { source, stale, hours, warnings }
  results: null,   // runPipeline output
  selTs: null,     // selected timestamp on the timeline
};

// ---------- persistence helpers ----------
const loadJson = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const saveJson = (k, v) => localStorage.setItem(k, JSON.stringify(v));

function allSites() {
  return [...SEED_SITES, ...loadJson(LS_CUSTOM, [])];
}

function depthFor(site) {
  const o = loadJson(LS_DEPTHS, {});
  return o[site.id] ?? site.depth_default;
}

function setDepth(siteId, depth) {
  const o = loadJson(LS_DEPTHS, {});
  if (depth == null) delete o[siteId]; else o[siteId] = depth;
  saveJson(LS_DEPTHS, o);
}

// ---------- formatting ----------
const fmtVis = (v) => (v >= 10 ? Math.round(v) : v.toFixed(1));
const visColor = (v) => (v >= 10 ? 'var(--good)' : v >= 5 ? 'var(--ok)' : 'var(--bad)');
const degToCompass = (d) => (d == null ? '–' : SECTORS[Math.round((((d % 360) + 360) % 360) / 45) % 8]);
const dirArrow = (d) =>
  d == null ? '' : `<span class="dir-arrow" style="transform:rotate(${(d + 180) % 360}deg);display:inline-block">↑</span>`;
const fmtTime = (ts) =>
  new Date(ts).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

// ---------- rendering: site list ----------
function renderSiteList() {
  const lastVis = loadJson(LS_LASTVIS, {});
  const ul = $('#siteList');
  ul.innerHTML = '';
  for (const site of state.sites) {
    const li = document.createElement('li');
    li.className = site.id === state.siteId ? 'active' : '';
    const lv = lastVis[site.id];
    const badge = lv != null
      ? `<span class="vis-badge" style="color:${visColor(lv)}">${fmtVis(lv)} m</span>`
      : '<span class="vis-badge muted">–</span>';
    li.innerHTML = `<div class="site-name">${site.name} ${badge}</div>
      <div class="site-notes">${site.notes ?? ''}</div>`;
    li.onclick = () => selectSite(site.id);
    ul.appendChild(li);
  }
}

// ---------- data & model ----------
async function selectSite(id) {
  state.siteId = id;
  state.payload = null;
  state.results = null;
  renderSiteList();
  const site = state.sites.find((s) => s.id === id);
  $('#heroSite').textContent = site.name;
  $('#heroVis').textContent = '…';
  setBanner(null);
  try {
    const res = await fetch(`/api/forecast?lat=${site.lat}&lon=${site.lon}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    state.payload = await res.json();
    state.selTs = null;
    recompute();
  } catch (err) {
    $('#heroVis').textContent = '–';
    setBanner(`Could not load forecast: ${err.message}`, true);
  }
}

function recompute() {
  const site = state.sites.find((s) => s.id === state.siteId);
  if (!site || !state.payload) return;
  const depth = depthFor(site);
  state.results = runPipeline(state.payload.hours, site, depth);
  renderDepth(site, depth);
  renderAll();
}

function nearestResult(ts) {
  const rs = state.results;
  if (!rs?.length) return null;
  let best = rs[0];
  for (const r of rs) if (Math.abs(r.ts - ts) < Math.abs(best.ts - ts)) best = r;
  return best;
}

// ---------- rendering: main panels ----------
function renderAll() {
  const now = Date.now();
  const current = nearestResult(now);
  if (!current) return;

  // hero + list badge cache
  $('#heroVis').textContent = fmtVis(current.vis);
  $('#heroVis').style.color = visColor(current.vis);
  $('#heroWhen').textContent = 'now';
  const lastVis = loadJson(LS_LASTVIS, {});
  lastVis[state.siteId] = current.vis;
  saveJson(LS_LASTVIS, lastVis);
  renderSiteList();

  renderBestWindow(now);
  renderSourceTag();
  renderChart(now);
  const sel = nearestResult(state.selTs ?? now);
  renderConditions(sel);
  renderExplain(sel);
  renderWarnings();
}

function renderWarnings() {
  const p = state.payload;
  if (p?.stale) {
    setBanner(`⚠ Upstream forecast sources are unreachable — showing the last good forecast from ${new Date(p.staleSince).toLocaleString()}.`, true);
  } else if (p?.generatedAt && Date.now() - p.generatedAt > 2 * 3600e3) {
    // Served from the service-worker cache (likely offline).
    setBanner(`Showing a cached forecast from ${new Date(p.generatedAt).toLocaleString()} — you may be offline.`);
  } else if (p?.warnings?.length) {
    setBanner(p.warnings.join(' · '));
  } else {
    setBanner(null);
  }
}

function setBanner(msg, isError = false) {
  const el = $('#banner');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('error', isError);
}

function renderSourceTag() {
  const p = state.payload;
  const el = $('#sourceTag');
  el.innerHTML = p.stale
    ? `<span class="stale">STALE</span> cached ${p.source}`
    : `source: ${p.source}`;
}

function renderDepth(site, depth) {
  const slider = $('#depthSlider');
  slider.value = depth;
  $('#depthVal').textContent = `${depth} m${depth === site.depth_default ? ' (auto)' : ''}`;
}

function renderBestWindow(now) {
  const horizon = now + MODEL.FORECAST_DAYS * DAY_MS;
  let best = null;
  for (const r of state.results) {
    if (r.ts < now || r.ts > horizon) continue;
    const h = new Date(r.ts).getHours();
    if (h < MODEL.DAYLIGHT_START_H || h >= MODEL.DAYLIGHT_END_H) continue;
    if (!best || r.vis > best.vis) best = r;
  }
  const el = $('#bestWindow');
  if (!best) { el.innerHTML = ''; return; }
  const d = new Date(best.ts);
  const day = d.toLocaleDateString([], { weekday: 'short' });
  const part = d.getHours() < 12 ? 'morning' : d.getHours() < 16 ? 'afternoon' : 'late arvo';
  el.innerHTML = `<div class="bw-label">best window</div>
    <div class="bw-value" style="color:${visColor(best.vis)}">${day} ${part} ~${fmtVis(best.vis)} m</div>
    <div class="muted">${d.toLocaleString([], { weekday: 'long', hour: 'numeric' })}</div>`;
}

// ---------- chart ----------
const CH = { w: 720, h: 240, padL: 34, padR: 10, padT: 12, padB: 26 };

function renderChart(now) {
  const from = now - MODEL.DISPLAY_PAST_DAYS * DAY_MS;
  const to = now + MODEL.FORECAST_DAYS * DAY_MS;
  const rows = state.results.filter((r) => r.ts >= from && r.ts <= to);
  if (!rows.length) { $('#chartWrap').innerHTML = '<p class="muted">no data in window</p>'; return; }

  const tMin = rows[0].ts, tMax = rows[rows.length - 1].ts;
  const vMax = Math.max(10, Math.ceil(Math.max(...rows.map((r) => r.vis)) / 5) * 5);
  const X = (t) => CH.padL + ((t - tMin) / (tMax - tMin)) * (CH.w - CH.padL - CH.padR);
  const Y = (v) => CH.padT + (1 - v / vMax) * (CH.h - CH.padT - CH.padB);

  let path = '';
  rows.forEach((r, i) => { path += `${i ? 'L' : 'M'}${X(r.ts).toFixed(1)},${Y(r.vis).toFixed(1)}`; });

  // day gridlines at local midnight
  let ticks = '';
  const d0 = new Date(tMin); d0.setHours(24, 0, 0, 0);
  for (let d = d0.getTime(); d < tMax; d += DAY_MS) {
    const x = X(d);
    ticks += `<line x1="${x}" y1="${CH.padT}" x2="${x}" y2="${CH.h - CH.padB}" stroke="var(--line)" stroke-width="1"/>`;
    ticks += `<text x="${x + 3}" y="${CH.h - 8}" fill="var(--muted)" font-size="10">${new Date(d).toLocaleDateString([], { weekday: 'short' })}</text>`;
  }
  // y labels
  let ylab = '';
  for (let v = 0; v <= vMax; v += vMax <= 15 ? 5 : 10) {
    ylab += `<text x="4" y="${Y(v) + 3}" fill="var(--muted)" font-size="10">${v}m</text>
      <line x1="${CH.padL}" y1="${Y(v)}" x2="${CH.w - CH.padR}" y2="${Y(v)}" stroke="var(--line)" stroke-width="0.5" opacity="0.6"/>`;
  }

  const xNow = X(Math.min(Math.max(now, tMin), tMax));
  const selTs = state.selTs ?? now;
  const xSel = X(Math.min(Math.max(selTs, tMin), tMax));

  const svg = `<svg viewBox="0 0 ${CH.w} ${CH.h}" xmlns="http://www.w3.org/2000/svg" id="chartSvg">
    ${ylab}${ticks}
    <rect x="${CH.padL}" y="${CH.padT}" width="${Math.max(0, xNow - CH.padL)}" height="${CH.h - CH.padT - CH.padB}"
      fill="var(--grey)" opacity="0.15"/>
    <line x1="${xNow}" y1="${CH.padT}" x2="${xNow}" y2="${CH.h - CH.padB}" stroke="var(--muted)" stroke-dasharray="3,3"/>
    <text x="${xNow + 3}" y="${CH.padT + 9}" fill="var(--muted)" font-size="10">now</text>
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    <line x1="${xSel}" y1="${CH.padT}" x2="${xSel}" y2="${CH.h - CH.padB}" stroke="var(--ok)" stroke-width="1.5" opacity="0.9"/>
  </svg>`;
  $('#chartWrap').innerHTML = svg;

  const el = $('#chartSvg');
  const pick = (ev) => {
    const rect = el.getBoundingClientRect();
    const fx = ((ev.clientX - rect.left) / rect.width) * CH.w;
    const t = tMin + ((fx - CH.padL) / (CH.w - CH.padL - CH.padR)) * (tMax - tMin);
    state.selTs = Math.min(Math.max(t, tMin), tMax);
    renderChart(now);
    const sel = nearestResult(state.selTs);
    renderConditions(sel);
    renderExplain(sel);
  };
  el.addEventListener('click', pick);
}

// ---------- conditions strip ----------
function renderConditions(r) {
  if (!r) return;
  $('#condWhen').textContent = `@ ${fmtTime(r.ts)}`;
  const sw = (s) =>
    s && s.height > 0.05
      ? `${s.height.toFixed(1)} m <small>@ ${s.period?.toFixed(0) ?? '–'} s</small> ${dirArrow(s.direction)} <small>${degToCompass(s.direction)}</small>`
      : '<small>–</small>';
  const kn = (r.wind.speed * 1.94384).toFixed(0);
  $('#conditions').innerHTML = `
    <div class="cond"><div class="k">swell 1</div><div class="v">${sw(r.swell1)}</div></div>
    <div class="cond"><div class="k">swell 2</div><div class="v">${sw(r.swell2)}</div></div>
    <div class="cond"><div class="k">wind</div><div class="v">${r.wind.speed.toFixed(1)} m/s <small>(${kn} kn)</small> ${dirArrow(r.wind.dir)} <small>${degToCompass(r.wind.dir)}</small></div></div>
    <div class="cond"><div class="k">rain</div><div class="v">${r.rain.toFixed(1)} <small>mm/h</small></div></div>
    <div class="cond"><div class="k">est. visibility</div><div class="v" style="color:${visColor(r.vis)}">${fmtVis(r.vis)} m</div></div>`;
}

// ---------- explainer ----------
function renderExplain(r) {
  if (!r) return;
  const compRow = (c) => {
    const name = c.label === 'windsea' ? 'wind sea (computed)' : c.label;
    return `<tr><td>${name}</td><td>${c.H.toFixed(2)} m</td><td>${c.T.toFixed(1)} s</td><td>${c.ub.toFixed(3)} m/s</td></tr>`;
  };
  const pct = (x) => ((x / r.attenuation) * 100).toFixed(0);
  $('#explain').innerHTML = `
    <div class="section-label">1 · Wave forcing → bed orbital velocity (depth ${r.depth.toFixed(1)} m, fetch ${r.fetchKm.toFixed(0)} km)</div>
    <table>
      <tr><th>component</th><th>H</th><th>T</th><th>u_b at bed</th></tr>
      ${r.comps.map(compRow).join('')}
      <tr class="total-row"><td>combined √Σu²</td><td></td><td></td><td>${r.ubTotal.toFixed(3)} m/s</td></tr>
      <tr><td class="muted">critical u_crit</td><td></td><td></td><td class="muted">${r.uCrit.toFixed(2)} m/s ${r.ubTotal > r.uCrit ? '— <b>stirring</b>' : '— settled'}</td></tr>
    </table>
    <div class="section-label">2 · Sediment &amp; runoff state</div>
    <table>
      <tr><td>suspended sediment index C</td><td>${r.C.toFixed(2)}</td></tr>
      <tr><td>runoff turbidity index C_r</td><td>${r.Cr.toFixed(2)}</td></tr>
    </table>
    <div class="section-label">3 · Optics: attenuation c = c₀ + k_sed·C + k_run·C_r</div>
    <table>
      <tr><th>term</th><th>value [m⁻¹]</th><th>share</th></tr>
      <tr><td>baseline c₀</td><td>${r.c0.toFixed(3)}</td><td>${pct(r.c0)}%</td></tr>
      <tr><td>sediment ${PHYS.K_SED}·C</td><td>${r.cSed.toFixed(3)}</td><td>${pct(r.cSed)}%</td></tr>
      <tr><td>runoff ${PHYS.K_RUN}·C_r</td><td>${r.cRun.toFixed(3)}</td><td>${pct(r.cRun)}%</td></tr>
      <tr class="total-row"><td>total c</td><td>${r.attenuation.toFixed(3)}</td><td></td></tr>
    </table>
    <div class="section-label">4 · Visibility = ${PHYS.SECCHI_COEFF} / c → <b style="color:${visColor(r.vis)}">${fmtVis(r.vis)} m</b> <span class="muted">(clamped ${PHYS.VIS_MIN_M}–${PHYS.VIS_MAX_M} m)</span></div>`;
}

// ---------- depth slider ----------
$('#depthSlider').addEventListener('input', (e) => {
  setDepth(state.siteId, Number(e.target.value));
  recompute();
});
$('#depthReset').addEventListener('click', () => {
  setDepth(state.siteId, null);
  recompute();
});

// ---------- custom sites ----------
function initDialog() {
  const dlg = $('#siteDialog');
  const fi = $('#fetchInputs');
  fi.innerHTML = SECTORS.map(
    (s) => `<label>${s}<input name="fetch_${s}" type="number" min="0" max="500" value="${DEFAULT_FETCH[s]}" /></label>`,
  ).join('');
  $('#addSiteBtn').onclick = () => dlg.showModal();
  $('#siteCancel').onclick = () => dlg.close();
  $('#siteForm').addEventListener('submit', (e) => {
    const fd = new FormData(e.target);
    const preset = BOTTOM_PRESETS[fd.get('bottom')] ?? BOTTOM_PRESETS.sand;
    const fetchTable = {};
    for (const s of SECTORS) fetchTable[s] = Number(fd.get(`fetch_${s}`)) || 0;
    const site = {
      id: `custom-${Date.now()}`,
      name: String(fd.get('name')).trim(),
      lat: Number(fd.get('lat')),
      lon: Number(fd.get('lon')),
      depth_default: Number(fd.get('depth')),
      c0: Number(fd.get('c0')),
      u_crit: preset.u_crit,
      E: preset.E,
      w_s: preset.w_s,
      fetch: fetchTable,
      runoff_r: Number(fd.get('runoff')),
      notes: `Custom site (${preset.label.split(' ')[0].toLowerCase()} bottom)`,
      custom: true,
    };
    const customs = loadJson(LS_CUSTOM, []);
    customs.push(site);
    saveJson(LS_CUSTOM, customs);
    state.sites = allSites();
    e.target.reset();
    selectSite(site.id);
  });
}

// ---------- PWA: service worker + install prompt ----------
function initPwa() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ });
  }
  let deferredPrompt = null;
  const btn = $('#installBtn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // suppress the mini-infobar; we offer our own button
    deferredPrompt = e;
    btn.classList.remove('hidden');
  });
  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btn.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => btn.classList.add('hidden'));
}

// ---------- boot ----------
function init() {
  state.sites = allSites();
  initDialog();
  initPwa();
  renderSiteList();
  selectSite(state.sites[0].id);
}
init();
