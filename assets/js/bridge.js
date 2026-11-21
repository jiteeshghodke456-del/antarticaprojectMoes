import { Router, VESSEL, STAGES, band, evaluateGates, haversineKm, GATE_ORDER } from "./model.js";
import { Projection, setupCanvas, wmoColour, WMO, drawGraticule, drawLand, drawLine, drawMarker, drawBerg, drawArrows,
  waveBins, waveColour, WAVE_ICE, LAND, OUTSIDE, drawShallow, drawIsobaths, drawRing, drawBergChain, dayColour } from "./map.js";
import { loadBin, loadJSON, gridField, bilinear, ramp, rampCSS, pixelMap, pixelXY, paintField,
  drawArrowField, drawBearingField, drawStreaklines, drawBarbs, drawPolylines, drawHatchedQuads } from "./research.js";
import { createView } from "./view.js";
import { stereo3412 as stereoXY } from "./research.js";

const $ = (s) => document.querySelector(s);
const fmtDate = (iso, opt = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { ...opt, timeZone: "UTC" });

const BOX = { lat0: -78, lat1: -54, lon0: 0, lon1: 80 };
const DESTS = {
  approach: { name: "Bharati approach", lat: -68.5, lon: 76.2, note: "100 km north of the station, the point the source project scores" },
  station: { name: "Bharati station edge", lat: -69.40683, lon: 76.19533, note: "nearest open-ocean grid cell to the station" },
};
const SEA = [219, 232, 242];     // WMO "ice free"
// Streaklines integrate the (frozen) daily-mean current for this long at 1x zoom,
// divided by the zoom so their on-screen length stays about constant.
const STREAK_S = 7 * 86400;
const SUSPECT = [196, 200, 204];  // satellite cell the QA flag says not to trust

const S = {
  meta: null, stat: null, lay: null, rules: null, cache: new Map(), wx: null, depth: null,
  cycle: null, lead: 0, depart: 0, limit: 80, obj: "time", dest: "approach",
  start: { lat: -55.0, lon: 40.0 }, field: "sic", sicMode: "wmo", windStep: 2,
  layers: { idrift: false, currents: false, wavedir: false, wind: false, depth: false, edges: false,
    bergs: true, static: true, ref2019: false, protected: false },
  picking: false, result: null, proj: new Projection(46), samp: {}, hits: [],
};

async function loadCycle(c) {
  if (S.cache.has(c.cycle)) return S.cache.get(c.cycle);
  const r = await fetch(`data/cycles/${c.cycle}.bin`);
  if (!r.ok) throw new Error(`cycle ${c.cycle}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const g = S.meta.grids, L = c.leads;
  const n = g.sic.ny * g.sic.nx, n2 = g.thk.ny * g.thk.nx, n3 = g.drift.ny * g.drift.nx;
  const f = {
    cycle: c, leads: L, g: g.sic,
    sic: (l) => new Uint8Array(buf, l * n, n),
    thk: (l) => new Uint8Array(buf, L * n + l * n2, n2),
    U: new Int8Array(buf, L * (n + n2), L * n3),
    V: new Int8Array(buf, L * (n + n2 + n3), L * n3),
  };
  f.wx = c.cycle === S.lay.cycle ? S.wx : null;   // waves and wind exist for the latest clean cycle only
  S.cache.set(c.cycle, f);
  return f;
}

const bin = (path) => fetch(path).then((r) => { if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.arrayBuffer(); });
async function loadLayers() {
  const L = S.lay, wx = {};
  if (L.waves) {
    const b = await bin(`data/${L.waves.file}`), n = L.waves.grid.ny * L.waves.grid.nx;
    wx.wav = (l) => new Uint8Array(b, l * n, n);
  }
  if (L.wind) {
    const b = await bin(`data/${L.wind.file}`), n = L.wind.grid.ny * L.wind.grid.nx * L.wind.leads;
    wx.U = new Int8Array(b, 0, n); wx.V = new Int8Array(b, n, n);
  }
  S.wx = (wx.wav || wx.U) ? wx : null;
  if (L.depth) S.depth = new Int16Array(await bin(`data/${L.depth.file}`));
}

// Weather along a route at arrival time, as dakshin/real_world.py samples it:
// day = round(hours since the cycle). Where the wave model has no value, ice
// over 15% means damped (0 m) and open water means the day's worst case.
function weatherAlong(f, route, departHours) {
  const wx = f.wx; if (!route || !wx) return { hs: null, wind: null, hsMeasured: null, filled: 0 };
  const W = S.lay.waves, V = S.lay.wind;
  let hs = null, wind = null, hsMeasured = null, filled = 0;
  for (const l of route.legs) {
    if (wx.wav) {
      const day = Math.min(W.leads - 1, Math.max(0, Math.round((l.hours + departHours) / 24)));
      const v = wx.wav(day)[l.idx]; let h;
      if (v !== 255) { h = v / 10; hsMeasured = Math.max(hsMeasured ?? 0, h); }
      else if (f.sic(Math.min(f.leads - 1, day))[l.idx] / 100 > 0.15) h = 0;
      else { h = W.day_max_m[day]; filled++; }
      hs = hs === null ? h : Math.max(hs, h);
    }
    if (wx.U) {
      const day = Math.min(V.leads - 1, Math.max(0, Math.round((l.hours + departHours) / 24)));
      const g = V.grid, i = Math.round((l.lat - g.lat0) / g.dlat), j = Math.round((l.lon - g.lon0) / g.dlon);
      if (i < 0 || j < 0 || i >= g.ny || j >= g.nx) continue;
      const k = day * g.ny * g.nx + i * g.nx + j;
      const sp = Math.hypot(wx.U[k], wx.V[k]) * 0.25;
      wind = wind === null ? sp : Math.max(wind, sp);
    }
  }
  return { hs, wind, hsMeasured, filled };
}

// IBCSO depth (m, positive down) under each leg; null outside the subset.
function depthsAlong(route) {
  if (!route || !S.depth) return null;
  const g = S.lay.depth.grid;
  return route.legs.map((l) => {
    const i = Math.round((l.lat - g.lat0) / g.dlat), j = Math.round((l.lon - g.lon0) / g.dlon);
    if (i < 0 || j < 0 || i >= g.ny || j >= g.nx) return null;
    const e = S.depth[i * g.nx + j];
    return e === 32767 ? 0 : -e;   // a mostly-dry block counts as 0 m
  });
}

function bergRadiusKm(b, isoDay) {
  const rate = S.lay.bergs?.uncertainty_km_per_day; if (rate == null) return null;
  const days = (Date.parse(isoDay) - Date.parse(b.observed)) / 864e5;
  return days < 0 ? null : rate * days;
}

// ------------------------------------------------------------------ compute
function compute(f) {
  const r = new Router(f);
  const start = r.nearestOcean(S.start.lat, S.start.lon);
  const d = DESTS[S.dest];
  const goal = r.nearestOcean(d.lat, d.lon);
  const lim = S.limit / 100, departHours = S.depart * 24;
  const base = { start, goal, iceLimit: lim, departHours, objective: S.obj };
  const forecast = r.solve({ ...base, mode: "forecast" });
  const statik = r.solve({ ...base, mode: "static" });
  const blocked = forecast ? null : r.solve({ ...base, mode: "forecast", penalise: true });
  const alts = [S.limit - 10, S.limit - 20].filter((x) => x >= 30).map((pct) => ({ pct, res: r.solve({ ...base, iceLimit: pct / 100, mode: "forecast" }) }));
  const nAlt = alts.filter((a) => a.res).length;
  const wx = weatherAlong(f, forecast, departHours);
  const decision = evaluateGates({ R: S.rules, route: forecast, iceLimitPct: S.limit, destName: d.name, destReachable: !!forecast,
    nAlternatives: nAlt, legDepths: depthsAlong(forecast), worstHs: wx.hs, worstWind: wx.wind });
  return { r, start, goal, forecast, statik, blocked, alts, decision, wx };
}

// ------------------------------------------------------------------ research data (lazy)
// Each file loads the first time a layer needs it; when it lands the chart repaints.
const RD = {}, pending = new Set();
function need(key, loader) {
  if (key in RD) return RD[key];
  if (!pending.has(key)) {
    pending.add(key);
    loader().then((v) => { RD[key] = v; pending.delete(key); if (current) { baseKey = ""; drawChart(current); renderLegend(); renderLayerControls(); } })
      .catch((e) => { pending.delete(key); showError(e); });
  }
  return null;
}
const RES = () => S.lay.research;
const resHere = (f) => !!RES()?.fields && f?.cycle.cycle === RES().cycle;
const fieldData = (name) => { const m = RES()?.fields?.[name]; return m ? need(name, async () => gridField(m, await loadBin(`data/research/${m.file}`))) : null; };
const bathyData = () => { const m = RES()?.bathy; return m ? need("bathy", async () => gridField({ ...m, leads: 1 }, await loadBin(`data/research/${m.file}`))) : null; };
const isobaths = () => (RES()?.bathy ? need("isobaths", () => loadJSON(`data/research/${RES().bathy.isobaths.file}`)) : null);
const VF = () => RES()?.verif;
const truthData = () => (VF() ? need("truth", async () => {
  const buf = await loadBin(`data/research/${VF().truth.file}`), g = VF().grid, n = g.nx * g.ny, D = VF().dates.length;
  return { conc: (d) => new Uint8Array(buf, d * n, n), qa: (d) => new Uint8Array(buf, (D + d) * n, n) };
}) : null);
const truthExtra = () => (VF() ? need("truthExtra", () => loadJSON(`data/research/${VF().truth.extra}`)) : null);
const modelData = (cy) => { const c = VF()?.model.cycles[cy]; return c ? need(`model:${cy}`, async () => { const buf = await loadBin(`data/research/${c.file}`), g = VF().grid, n = g.nx * g.ny; return (li) => new Uint8Array(buf, li * n, n); }) : null; };
const modelEdges = (cy) => { const c = VF()?.model.cycles[cy]; return c ? need(`edges:${cy}`, () => loadJSON(`data/research/${c.edges}`)) : null; };

// Is (cycle, lead) verifiable against a satellite day?
function verifAt(f) {
  const V = VF(); if (!V || !f) return null;
  const c = V.model.cycles[f.cycle.cycle]; if (!c) return null;
  const li = c.leads.indexOf(S.lead); if (li < 0) return null;
  const date = f.cycle.valid[S.lead], di = V.dates.indexOf(date);
  return di < 0 ? null : { V, c, li, di, date };
}
const verifOn = () => S.layers.edges || S.field === "innov";
const inGrid = (g, la, lo) => { const fi = (la - g.lat0) / g.dlat, fj = (lo - g.lon0) / g.dlon; return fi >= -0.5 && fj >= -0.5 && fi <= g.ny - 0.5 && fj <= g.nx - 0.5; };
const windIndex = (W) => { const h = S.lead * 24 + S.windStep * 6; const k = W.meta.step_hours.indexOf(h); return k < 0 ? Math.min(W.steps - 1, S.lead * 4 + S.windStep) : k; };

// Samplers for the cycle and day shown: each returns a value in physical units, or NaN/null outside coverage.
function samplers(f) {
  const L = S.lead, out = { res: resHere(f) }, g = S.meta.grids;
  const one = (d, comp = 0, step = L) => { const a = d.slice(comp, Math.min(step, d.steps - 1)); return (la, lo) => bilinear(d.g, a, d.nodata, d.scale[comp], la, lo); };
  const two = (d, step = L) => { const u = one(d, 0, step), v = one(d, 1, step); return (la, lo) => { const a = u(la, lo), b = v(la, lo); return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null; }; };
  if (out.res) {
    const sic = fieldData("sic"); if (sic) { out.sic = one(sic); out.sicG = sic.g; }
    const thk = fieldData("thk"); if (thk) out.thk = one(thk);
    const dr = fieldData("idrift"); if (dr) out.idrift = two(dr);
    const cur = fieldData("cur"); if (cur) out.cur = two(cur);
    const sst = fieldData("sst"); if (sst) out.sst = one(sst);
    const wav = fieldData("wav"); if (wav) { out.hs = one(wav, 0); out.wdir = one(wav, 1); }
    if (S.layers.wind) { const w = fieldData("wind"); if (w) { const k = windIndex(w); out.wind = two(w, k); out.windAt = w.meta.valid_utc[k]; } }
  } else {
    out.sic = (la, lo) => bilinear(g.sic, f.sic(L), 255, 1, la, lo); out.sicG = g.sic;
    out.thk = (la, lo) => bilinear(g.thk, f.thk(L), 255, 0.1, la, lo);
  }
  const bd = bathyData(); if (bd) { const a = bd.slice(0, 0); out.elev = (la, lo) => bilinear(bd.g, a, bd.nodata, 1, la, lo); }
  const v = verifOn() ? verifAt(f) : null;
  if (v) {
    const T = truthData(), M = modelData(f.cycle.cycle);
    if (T && M) {
      const gv = { ny: v.V.grid.ny, nx: v.V.grid.nx, lat0: v.V.grid.y0, dlat: v.V.grid.dy, lon0: v.V.grid.x0, dlon: v.V.grid.dx };
      const tc = T.conc(v.di), tq = T.qa(v.di), mc = M(v.li), bits = v.V.truth.suspect_bits;
      const suspect = (x, y) => { const i = Math.round((y - gv.lat0) / gv.dlat), j = Math.round((x - gv.lon0) / gv.dlon); return i >= 0 && j >= 0 && i < gv.ny && j < gv.nx && (tq[i * gv.nx + j] & bits) !== 0; };
      out.verif = { v, gv, sat: (x, y) => bilinear(gv, tc, 255, 1, y, x), mod: (x, y) => bilinear(gv, mc, 255, 1, y, x), suspect };
    }
  }
  return out;
}

// What shows where the selected field has no value: land, a depth tint, or the dark surround.
function background(s, la, lo) {
  if (s.sicG && inGrid(s.sicG, la, lo) && Number.isNaN(s.sic?.(la, lo))) return LAND;
  if (s.elev) {
    const e = s.elev(la, lo);
    if (e >= 0) return LAND;
    if (S.layers.depth && e < 0) return ramp("depth", -e / 5000);
  }
  return null;
}

function colourFn(s) {
  const bins = waveBinsNow();
  const bg = (la, lo) => background(s, la, lo);
  switch (S.field) {
    case "thk": return s.thk && ((k, la, lo) => { const v = s.thk(la, lo); return Number.isNaN(v) ? bg(la, lo) : v < 0.01 ? SEA : ramp("dense", v / 4); });
    case "sst": return s.sst && ((k, la, lo) => { const v = s.sst(la, lo); return Number.isNaN(v) ? bg(la, lo) : ramp("thermal", (v + 2) / 10); });
    case "cur": return s.cur && ((k, la, lo) => { const v = s.cur(la, lo); return v ? ramp("speed", Math.hypot(v[0], v[1]) / 0.8) : bg(la, lo); });
    case "wav": return s.hs && ((k, la, lo) => { const v = s.hs(la, lo); if (!Number.isNaN(v)) return waveColour(bins, v); return s.sic && s.sic(la, lo) > 15 ? WAVE_ICE : bg(la, lo); });
    case "innov": {
      if (!s.verif) return null;
      const xy = pixelXY(S.pm, VF().projection), { sat, mod, suspect } = s.verif;
      return (k, la, lo) => {
        const x = xy.x[k], y = xy.y[k];
        if (suspect(x, y)) return SUSPECT;
        const t = sat(x, y), m = mod(x, y);
        return Number.isNaN(t) || Number.isNaN(m) ? bg(la, lo) : ramp("balance", (m - t + 50) / 100);
      };
    }
    default: return s.sic && ((k, la, lo) => { const v = s.sic(la, lo); return Number.isNaN(v) ? bg(la, lo) : S.sicMode === "cont" ? ramp("ice", v / 100) : wmoColour(v); });
  }
}

// ------------------------------------------------------------------ chart
// One wrapper (#stack) holds both canvases. During a gesture view.js moves the
// wrapper by CSS transform only; on settle drawChart repaints both canvases
// at the new view in the same task, so raster and lines never separate.
let baseKey = "", baseSize = "", baseB = null, view = null;
function drawChart(f) {
  const base = $("#base"), wrap = $("#chartwrap");
  // Canvases are measured with getBoundingClientRect, which sees the gesture
  // transform; drop it first (same task as the repaint, so no frame shows it).
  $("#stack").style.transform = "";
  const w = wrap.clientWidth, h = wrap.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
  if (`${w}x${h}@${dpr}` !== baseSize) { baseB = setupCanvas(base); baseSize = `${w}x${h}@${dpr}`; baseKey = ""; }
  const b = baseB, ins = insets();
  S.proj.fit(BOX, b.w, b.h, 24, ins);
  view.setFit(b.w, b.h);
  const vkey = [b.w, b.h, ins.l, ins.r, ins.t, ins.b, view.key()].join("|");
  S.samp = samplers(f);
  const key = [f.cycle.cycle, S.lead, S.field, S.sicMode, S.layers.depth, verifOn(), Object.keys(RD).length, vkey].join("|");
  if (key !== baseKey) {
    S.pm = pixelMap(S.proj, b.w, b.h, vkey);
    b.ctx.save(); b.ctx.fillStyle = `rgb(${OUTSIDE})`; b.ctx.fillRect(0, 0, b.w, b.h); b.ctx.restore();
    const colour = colourFn(S.samp);
    if (colour) paintField(b.ctx, S.pm, colour);
    drawLand(b.ctx, S.proj, S.stat.coast.land, { fill: null, stroke: "rgba(70,55,25,0.95)" });
    drawGraticule(b.ctx, S.proj, BOX, { w: b.w, h: b.h, z: view.z });
    baseKey = key;
  }
  drawOverlay(f);
  view.markPainted();   // clears the wrapper transform in the same task as the repaint
}

// Wind is drawn over the sea only: the IFS field covers the continent too.
const overLand = (s) => (la, lo) => (s.sicG && inGrid(s.sicG, la, lo) && Number.isNaN(s.sic?.(la, lo))) || (s.elev && s.elev(la, lo) >= 0);
const waveBinsNow = () => waveBins(S.rules.MAX_WAVE_M, S.rules.WAVE_MARGINAL_BAND_M);

// The chart fills the window; on desktop the panels float over it, so fit the
// fan into the space they leave free. On phone layouts the map stands alone.
const DESKTOP = "(min-width: 981px)";
function insets() {
  const z = { l: 0, r: 0, t: 0, b: 0 };
  if (!matchMedia(DESKTOP).matches) return z;
  const W = innerWidth, gap = 12;
  const L = $("#leftpanel").getBoundingClientRect(), Rr = $("#rightpanel").getBoundingClientRect();
  const top = Math.max($(".brandbar").getBoundingClientRect().bottom, $("#finding").hidden ? 0 : $("#finding").getBoundingClientRect().bottom);
  z.l = Math.round(L.right + gap); z.r = Math.round(W - Rr.left + gap); z.t = Math.round(top + gap); z.b = 36;
  if (W - z.l - z.r < 320) { z.l = 0; z.r = 0; }   // too narrow to dodge both: let the panels overlap
  // Height floor: a grown ribbon (e.g. its open details) must shrink the
  // chart, never collapse it to zero height.
  if (innerHeight - z.t - z.b < 280) z.t = Math.max(0, innerHeight - 280 - z.b);
  return z;
}

function thkColour(dm) {
  if (dm < 1) return [219, 232, 242];
  const t = Math.min(1, dm / 30); // 0..3 m
  const a = [210, 228, 245], z = [26, 54, 120];
  return a.map((v, i) => Math.round(v + (z[i] - v) * t));
}

function drawOverlay(f) {
  const c = $("#overlay"); const { ctx, w, h } = setupCanvas(c); const P = S.proj; const R = S.result, s = S.samp, z = view.z;
  S.hits = [];
  if (S.layers.protected) {
    for (const a of S.stat.protected.areas) drawLand(ctx, P, a.rings, { fill: "rgba(46,125,79,0.25)", stroke: "rgba(46,125,79,0.9)" });
  }
  if (S.layers.depth) {
    if (S.depth) drawShallow(ctx, P, S.lay.depth.grid, S.depth, S.lay.depth.min_depth_m);
    const iso = isobaths();
    if (iso) drawPolylines(ctx, P, iso.lines, { colour: "rgba(24,52,84,0.75)", widthOf: (L) => (L.m >= 1000 ? 1.1 : 0.7), dash: null });
    else if (S.lay.depth) drawIsobaths(ctx, P, S.lay.depth.contours.lines, S.lay.depth.contours.levels_m);
  }
  if (S.layers.currents && s.cur) drawStreaklines(ctx, P, w, h, s.cur, { seconds: STREAK_S / z, step: 18,
    colourBy: S.field === "cur" ? null : (sp) => ramp("speed", 0.35 + 0.65 * Math.min(1, sp / 0.8)) });
  if (S.layers.idrift) {
    if (s.idrift) drawArrowField(ctx, P, w, h, s.idrift, { step: 30, pxPerMs: 80 });
    else if (!s.res) drawArrows(ctx, P, S.meta.grids.drift, f.U, f.V, S.lead, z);
  }
  if (S.layers.wavedir && s.wdir) drawBearingField(ctx, P, w, h, (la, lo) => (Number.isNaN(s.hs(la, lo)) ? NaN : (s.wdir(la, lo) + 180) % 360), { step: 42 });
  if (S.layers.wind && s.wind) drawBarbs(ctx, P, w, h, s.wind, { step: 48, skip: overLand(s) });
  const v = verifOn() ? verifAt(f) : null;
  if (v) {
    const X = truthExtra(), E = modelEdges(f.cycle.cycle);
    if (X?.suspect_quads[v.date]?.length) drawHatchedQuads(ctx, P, X.suspect_quads[v.date]);
    if (S.layers.edges) {
      if (E?.[String(S.lead)]) drawPolylines(ctx, P, E[String(S.lead)], { colour: "#18b4dc", width: 2, dash: [7, 4], halo: "rgba(8,16,28,0.85)" });
      if (X?.edges[v.date]) drawPolylines(ctx, P, X.edges[v.date], { colour: "#ff9a1f", width: 2.2, halo: "rgba(8,16,28,0.85)" });
    }
  }
  if (S.layers.ref2019) {
    const pts = S.stat.route2019.coords.map(([lo, la]) => [la, lo]);
    drawLine(ctx, P, pts, { colour: "#12304d", width: 2, dash: [2, 5], halo: true });
  }
  const toLL = (res) => res.legs.map((l) => [l.lat, l.lon]);
  if (S.layers.static && R.statik) drawLine(ctx, P, toLL(R.statik), { colour: "#12304d", width: 2.5, dash: [9, 6] });
  if (R.forecast) drawLine(ctx, P, toLL(R.forecast), { colour: "#a3156f", width: 3.5 });
  else if (R.blocked) drawLine(ctx, P, toLL(R.blocked), { colour: "#b3261e", width: 2.5, dash: [3, 4] });
  if (S.layers.bergs && S.lay.bergs) {
    const day = f.cycle.valid[S.lead];
    const items = bergsInBox();
    for (const b of items) drawRing(ctx, P, b.lat, b.lon, bergRadiusKm(b, day));
    const T = tracksHere(f);
    if (T) for (const t of T.tracks) { try { drawBergChain(ctx, P, t, S.hits); } catch (e) { console.warn("berg chain", t.berg, e); } }
    for (const b of items) drawBerg(ctx, P, b, nearTrack(b, day));
  }
  for (const st of S.stat.stations) {
    if (st.role === "approach") continue;
    drawMarker(ctx, P, st.lat, st.lon, st.name + (st.role === "not-scored" ? " (not scored)" : ""), { shape: "square", colour: st.role === "not-scored" ? "#6b7884" : "#12304d" });
  }
  const d = DESTS[S.dest];
  drawMarker(ctx, P, d.lat, d.lon, S.dest === "approach" ? "Approach point" : "", { colour: "#a3156f", align: "left" });
  const shipAt = shipPosition();
  drawMarker(ctx, P, shipAt.lat, shipAt.lon, shipAt.label, { shape: "ship", colour: "#a3156f" });
}

function shipPosition() {
  const R = S.result, tHours = S.lead * 24 - S.depart * 24;
  if (!R.forecast || tHours <= 0) return { ...S.start, label: tHours < 0 ? "Ship (in port)" : "Ship" };
  const legs = R.forecast.legs;
  for (let k = 1; k < legs.length; k++) if (legs[k].hours >= tHours) return { lat: legs[k].lat, lon: legs[k].lon, label: `Ship, day ${S.lead - S.depart}` };
  const last = legs[legs.length - 1]; return { lat: last.lat, lon: last.lon, label: "Arrived" };
}

// Drift tracks belong to one forecast cycle; on other cycles they are not drawn.
const tracksHere = (f) => (S.lay.berg_tracks && f?.cycle.cycle === S.lay.berg_tracks.cycle ? S.lay.berg_tracks : null);
const trackDays = (T) => {
  const d = T.tracks.filter((t) => t.daily_positions?.length).map((t) => t.daily_positions.at(-1).day);
  return d.length ? Math.max(...d) : 9;
};

// Berg under the cursor: a forecast day dot, a held marker, or the USNIC fix.
function bergAt(x, y) {
  let best = null, bd = 9;
  for (const hpt of S.hits) { const d = Math.hypot(hpt.x - x, hpt.y - y); if (d < bd) { bd = d; best = hpt; } }
  const T = current && tracksHere(current);
  for (const b of bergsInBox()) {
    const [px, py] = S.proj.fwd(b.lat, b.lon), d = Math.hypot(px - x, py - y);
    if (d < Math.max(bd, 10)) { bd = d; best = { berg: b.name, day: 0 }; }
  }
  if (!best) return null;
  const b = bergsInBox().find((q) => q.name === best.berg);
  return b ? { b, t: T?.tracks.find((q) => q.berg === b.name), hit: best } : null;
}
function bergInfo({ b, t, hit }) {
  const day = current.cycle.valid[S.lead], r = bergRadiusKm(b, day);
  const rows = [`<b class="pos">Iceberg ${b.name}</b>`];
  if (hit.held) rows.push(`<b>Held: model stops this berg here</b>`);
  else if (hit.day) rows.push(`<b>Forecast day ${hit.day}</b> (${fmtDate(addDays(t ? S.lay.berg_tracks.cycle : day, hit.day), { day: "numeric", month: "short" })}): ${(-hit.lat).toFixed(2)}°S ${hit.lon.toFixed(2)}°E${hit.k > 1 ? `, chain drawn ×${hit.k}` : ""}`);
  else rows.push(`USNIC fix ${fmtDate(b.observed, { day: "numeric", month: "short" })} (day 0)`);
  rows.push(`Area <b>${t?.area_km2 ?? b.area_km2} km²</b>, ${b.len_nm}×${b.wid_nm} nm${r ? `, uncertainty ±${r.toFixed(0)} km` : ""}`);
  if (!t) rows.push(`<span class="muted">No drift forecast for this berg on this cycle</span>`);
  else {
    rows.push(`Drift <b>${t.net_drift_km_per_day} km/day</b>, bearing <b>${t.bearing_deg}°</b> (net ${t.net_drift_km} km)`);
    rows.push(`Status <b>${t.status}</b>, wind forcing R = ${t.wind_forcing_R}`);
    if (t.status !== "ok") rows.push(`<b>Model holds this berg (grounded or unknown)</b>`);
    rows.push(`<span class="muted">Advisory: ${S.lay.berg_tracks.validation.replace(/^see berg_hindcast\.json\s*[—-]\s*/, "")}</span>`);
  }
  return rows.join("<br>");
}
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const bergsInBox = () => (S.lay.bergs?.items ?? []).filter((b) => b.lon >= BOX.lon0 && b.lon <= BOX.lon1 && b.lat <= BOX.lat1);
// Near = the uncertainty circle comes within 50 nm (92.6 km) of the forecast-aware track.
function nearTrack(b, day) {
  const R = S.result; if (!R || !R.forecast) return false;
  return minDistKm(b, R.forecast.legs) - (bergRadiusKm(b, day) ?? 0) < 92.6;
}
function minDistKm(b, legs) { let m = Infinity; for (const l of legs) m = Math.min(m, haversineKm(b.lat, b.lon, l.lat, l.lon)); return m; }

// ------------------------------------------------------------------ rail
const days = (h) => (h / 24).toFixed(1) + " d";
function renderCompare() {
  const R = S.result, F = R.forecast, T = R.statik;
  const row = (cls, name, res, note) => res
    ? `<tr class="${cls}"><td>${name}</td><td class="num">${days(res.hours)}</td><td class="num">${res.km.toFixed(0)} km</td><td class="num">${(res.worst * 100).toFixed(0)}%</td><td class="num">${res.overKm > 0 ? `<span class="bad">${res.overKm.toFixed(0)} km</span>` : "none"}</td></tr>`
    : `<tr class="${cls}"><td>${name}</td><td colspan="4"><span class="bad">No route</span> ${note}</td></tr>`;
  $("#compare").innerHTML = `<tr><th></th><th class="num">ETA</th><th class="num">Distance</th><th class="num">Worst ice</th><th class="num">Over limit</th></tr>`
    + row("primary", "Forecast-aware", F, `under ${S.limit}% on this forecast`)
    + row("static", "Today's ice only", T, `under ${S.limit}% on day-${S.depart} ice`);
  let note = "";
  if (F && !T) note = `<div class="callout">Planned on the ice of the day you leave, there is no route under ${S.limit}%. Planned on the ice forecast for the hour the ship gets to each cell, there is one. This is the core idea of the project: the router asks what the ice will be like on arrival, not what it is now.</div>`;
  else if (F && T && T.overKm > 0) note = `<div class="callout">The plan made on today's ice runs into ice over ${S.limit}% for ${T.overKm.toFixed(0)} km by the time the ship gets there. The forecast-aware plan avoids it.</div>`;
  else if (F && T) note = `<div class="callout">Both plans stay under the limit for this departure. The forecast-aware one is ${Math.abs((T.hours - F.hours) / 24).toFixed(1)} days ${T.hours >= F.hours ? "faster" : "slower"}.</div>`;
  else if (!F) note = `<div class="callout warn">No track stays under ${S.limit}% on this forecast. The red dashed line is the least-bad way through, shown only to point at where it is blocked (${R.blocked ? R.blocked.overKm.toFixed(0) + " km over the limit" : "no connection at all"}). Try a later departure or a later forecast.</div>`;
  const alt = R.alts.map((a) => `${a.pct}%: ${a.res ? days(a.res.hours) : "no route"}`).join(" · ");
  note += `<p class="xsmall muted" style="margin-top:8px">Fallback corridors at tighter limits: ${alt || "none tested"}. Beyond the ${S.result.r.f.leads}-day forecast the last forecast day is held. The browser router applies no wave penalty and does not avoid shallow water, so ETAs are a lower bound; waves, wind and depth enter through the weather and chart gates below.</p>`;
  $("#planNote").innerHTML = note;
}

function renderGates() {
  const { gates, health, binding } = S.result.decision;
  $("#healthState").textContent = health; $("#healthState").className = "state state-" + health;
  $("#healthWhy").textContent = `set by the ${binding} gate`;
  const wx = S.result.wx, extra = {};
  if (wx.filled) extra.weather = [`${wx.filled} leg${wx.filled > 1 ? "s" : ""} in open water with no wave value took the day's box-wide max (the source rule); measured worst on the track <b>${wx.hsMeasured?.toFixed(1) ?? "none"} m</b>`];
  if (!current.wx) extra.weather = [`no wave or wind file for this cycle; archived for ${fmtDate(S.lay.cycle, { day: "numeric", month: "short" })} only`];
  $("#gates").innerHTML = GATE_ORDER.map((k) => {
    const g = gates[k];
    const chips = [...(g.unassessed || []).map((u) => `<span class="chip unassessed">unassessed: <b>${u}</b></span>`),
      ...(g.chips || []).map((c) => `<span class="chip">${c}</span>`)];
    const notes = (extra[k] || []).map((c) => `<span class="gnote">${c}</span>`).join("");
    return `<li><span class="gname">${k}</span><span class="pill ${g.state}">${g.state}</span><span class="reason">${g.reason}</span>${chips.length ? `<span class="chips">${chips.join("")}</span>` : ""}${notes}</li>`;
  }).join("");
}

function renderPolaris() {
  const stage = $("#stage").value; const F = S.result.forecast; const el = $("#polaris");
  if (!stage) { el.innerHTML = `<p class="small">Declare the ice stage to see the band. There is no default on purpose: this system knows concentration, not stage of development, and a default would be an invented observation.</p>`; return; }
  if (!F) { el.innerHTML = `<p class="small">No route to score.</p>`; return; }
  const legs = F.legs.filter((_, k) => k % 4 === 0 || k === F.legs.length - 1);
  const bands = legs.map((l) => ({ ...band(l.sic, stage), l }));
  const count = (s) => bands.filter((b) => b.state === s).length;
  const worst = bands.reduce((a, b) => (b.rio_lo < a.rio_lo ? b : a), bands[0]);
  const speeds = bands.filter((b) => b.speed_kn).map((b) => b.speed_kn[0]);
  el.innerHTML = `<div class="strip" title="Along the track, departure on the left">${bands.map((b) => `<span class="st-${b.state}"></span>`).join("")}</div>
    <p class="small muted">Departure on the left, arrival on the right. Green: normal operation whatever the ship's class. Amber: the answer depends on the class (PC4 to IA). Red: caution whatever the class.</p>
    <p class="small">Normal for ${Math.round(100 * count("stable-normal") / bands.length)}% of the track. Class decides the tier on ${Math.round(100 * count("flips") / bands.length)}%. Worst point: RIO ${worst.rio_lo} to ${worst.rio_hi} at ${(worst.l.sic * 100).toFixed(0)}% ice${speeds.length ? `, where Table 1.2 limits speed to ${Math.min(...speeds)}–${Math.max(...speeds)} kn` : ""}.</p>
    <p class="small muted">Single-stage reduction, not the IMO RIO. The ship's pre-1999 Russian ice notation has no row in Table 1.3, so the band across PC4 to IA is shown instead of one number. Compression, ridging and glacial ice are not scored.</p>`;
}

function renderBergs() {
  const B = S.lay.bergs;
  if (!B) { $("#bergsrc").textContent = ""; $("#bergs").innerHTML = `<li class="note">${reasonFor("bergs")}</li>`; return; }
  const items = bergsInBox(), F = S.result.forecast, day = current.cycle.valid[S.lead];
  const rows = items.map((b) => ({ b, d: F ? minDistKm(b, F.legs) : null, r: bergRadiusKm(b, day) })).sort((a, z) => (a.d ?? 1e9) - (z.d ?? 1e9));
  $("#bergsrc").textContent = `USNIC fix of ${fmtDate(B.items[0]?.observed ?? day, { day: "numeric", month: "short", year: "numeric" })}`;
  $("#bergs").innerHTML = rows.map(({ b, d, r }) => `<li class="${nearTrack(b, day) ? "near" : ""}"><span>${b.name}, ${b.len_nm}×${b.wid_nm} nm</span><span>${d === null ? "–" : (d / 1.852).toFixed(0) + " nm from track"}${r ? `, ±${r.toFixed(0)} km` : ""}</span></li>`).join("")
    + `<li class="note">Circles are centred on the last USNIC fix and grow ${B.uncertainty_km_per_day} km a day after it: the drift model's median error in the berg hindcast (${S.stat.berg_hindcast?.n_ok ?? "?"} scored segments), where staying put, the persistence forecast, beat the model. Red: circle within 50 nm of the forecast-aware track on the day shown. USNIC tracks only bergs over about 10 nm; growlers and bergy bits are in no satellite product.</li>`;
}

function renderSpark() {
  const s = S.meta.season, key = "Bharati approach (100 km N)";
  const pts = s.series.map((r) => ({ d: r.date, v: r[key], fc: false })).concat(s.outlook.slice(1).map((r) => ({ d: r.date, v: r[key], fc: true })));
  const W = 360, H = 120, pad = { l: 28, r: 6, t: 8, b: 18 };
  const x = (i) => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);
  const line = (arr) => arr.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const idx = pts.map((p, i) => ({ ...p, i })).filter((p) => p.v !== null);
  const obs = idx.filter((p) => !p.fc), fc = [obs[obs.length - 1], ...idx.filter((p) => p.fc)];
  const svg = $("#spark"); svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const yl = y(S.limit);
  svg.innerHTML = `
    ${[0, 50, 100].map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--rule)"/><text x="${pad.l - 4}" y="${y(v) + 4}" text-anchor="end" font-size="12" style="fill:var(--ink-2)">${v}%</text>`).join("")}
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${yl}" y2="${yl}" style="stroke:var(--fail)" stroke-dasharray="4 3"/>
    <text x="${W - pad.r}" y="${yl - 4}" text-anchor="end" font-size="12" style="fill:var(--fail)">${S.limit}% limit</text>
    <path d="${line(obs)}" fill="none" style="stroke:var(--ink)" stroke-width="1.6"/>
    <path d="${line(fc)}" fill="none" style="stroke:var(--route)" stroke-width="2" stroke-dasharray="5 3"/>
    <text x="${pad.l}" y="${H - 4}" font-size="12" style="fill:var(--ink-2)">${fmtDate(pts[0].d, { day: "numeric", month: "short" })}</text>
    <text x="${W - pad.r}" y="${H - 4}" text-anchor="end" font-size="12" style="fill:var(--ink-2)">${fmtDate(pts[pts.length - 1].d, { day: "numeric", month: "short" })}</text>`;
  const lastObs = obs[obs.length - 1], lastFc = fc[fc.length - 1];
  $("#sparknote").textContent = `Mean concentration in a box around the approach point. Solid line: each day's CMEMS analysis since ${fmtDate(pts[0].d, { day: "numeric", month: "short" })}. Dashed: the ${s.outlook_cycle} forecast, ${lastObs.v}% today falling to ${lastFc.v}% by ${fmtDate(lastFc.d, { day: "numeric", month: "short" })}.`;
}

function renderLegend() {
  const f = current, s = S.samp, cards = [];
  const scale = (title, sub, gradient, ticks, note = "") => `<div class="card"><div class="ttl">${title} <span class="muted">${sub}</span></div>
    <div class="ramp" style="background:${gradient}"></div><div class="ticks">${ticks.map((t) => `<span style="left:${t[0]}%">${t[1]}</span>`).join("")}</div>${note}</div>`;
  const res = f && resHere(f), resTxt = res ? "1/12°" : "0.25° archive";
  if (S.field === "wav" && s.hs) {
    const bins = waveBinsNow();
    cards.push(`<div class="card"><div class="ttl">Wave height, daily max <span class="muted">CMEMS, m; tick = assumed ${Number.isInteger(S.rules.MAX_WAVE_M) ? S.rules.MAX_WAVE_M.toFixed(1) : S.rules.MAX_WAVE_M} m limit</span></div>
      <div class="scale">${bins.map((b) => `<span class="${b.dark ? "dark" : ""} ${b.limit ? "limit" : ""}" style="background:rgb(${b.rgb})">${b.label}</span>`).join("")}<span style="background:rgb(${WAVE_ICE})">Ice</span></div></div>`);
  } else if (S.field === "thk") cards.push(scale("Ice thickness", `CMEMS sithick, m, ${resTxt}`, rampCSS("dense"), [[0, "0"], [25, "1"], [50, "2"], [75, "3"], [100, "4+"]]));
  else if (S.field === "sst") cards.push(scale("Sea-surface temperature", "CMEMS thetao, °C", rampCSS("thermal"), [[0, "−2"], [1, ""], [20, "0"], [40, "2"], [60, "4"], [80, "6"], [100, "8+"]],
    `<div class="mark" style="left:${(100 * (RES().fields.sst.freezing_point_c + 2) / 10).toFixed(1)}%"></div><p class="xsmall muted">Mark: ${RES().fields.sst.freezing_point_c} °C, ${RES().fields.sst.freezing_point_note}.</p>`));
  else if (S.field === "cur") cards.push(scale("Surface current speed", "CMEMS uo/vo, m/s", rampCSS("speed"), [[0, "0"], [25, "0.2"], [50, "0.4"], [75, "0.6"], [100, "0.8+"]]));
  else if (S.field === "innov") cards.push(scale("Innovation, model − satellite", "ice concentration, points", rampCSS("balance", 9), [[0, "−50"], [25, "−25"], [50, "0"], [75, "+25"], [100, "+50"]],
    `<p class="xsmall muted">Red: the model has more ice than the satellite saw. Blue: less. Grey hatch: satellite cells its QA flag marks untrustworthy (not scored).</p>`));
  else if (S.sicMode === "cont") cards.push(scale("Ice concentration", `CMEMS, %, ${resTxt}`, rampCSS("ice"), [[0, "0"], [25, "25"], [50, "50"], [75, "75"], [100, "100"]]));
  else cards.push(`<div class="card"><div class="ttl">Ice concentration <span class="muted">WMO colour code, ${resTxt}</span></div>
      <div class="scale">${WMO.map((c) => `<span style="background:rgb(${c.rgb})">${c.label}</span>`).join("")}<span style="background:rgb(${LAND})">Land</span></div></div>`);

  const T = S.layers.bergs && f && tracksHere(f);
  if (T) {
    const n = trackDays(T), dots = Array.from({ length: n + 1 }, (_, k) => k === 0
      ? `<span class="dd"><i class="d0"></i>0</span>` : `<span class="dd"><i style="background:rgb(${dayColour(k, Math.max(n, 9))})"></i>${k}</span>`).join("");
    cards.push(`<div class="card"><div class="ttl">Iceberg drift forecast <span class="muted">from ${fmtDate(T.cycle, { day: "numeric", month: "short" })}</span></div>
      <div class="days">${dots}</div><p class="muted">Dot n: forecast position after n days; ◆ day 0 is the USNIC fix. <i class="swatch-held"></i> held (grounded or unknown). ×k: short chain magnified. Ring: ±${S.lay.bergs.uncertainty_km_per_day} km/day. Advisory only.</p></div>`);
  }
  const keys = [`<span><i class="swatch-line"></i>Forecast-aware route</span>`];
  if (S.layers.static) keys.push(`<span><i class="swatch-line dash"></i>Plan on today's ice</span>`);
  if (S.layers.ref2019) keys.push(`<span><i class="swatch-line ref"></i>PolarRoute 2019</span>`);
  if (S.layers.currents && s.cur) keys.push(`<span><i class="swatch-stream"></i>Streakline: ${(STREAK_S / 86400 / view.z).toFixed(1)} days of flow in the day's mean current, tail to head</span>`);
  if (S.layers.idrift) keys.push(`<span><i class="swatch-arrow"></i>Ice drift, ${s.res ? "8 px per 10 cm/s" : "0.25° archive"}</span>`);
  if (S.layers.wavedir && s.wdir) keys.push(`<span><i class="swatch-arrow wave"></i>Peak waves travel this way (VMDR + 180°)</span>`);
  if (S.layers.wind && s.wind) keys.push(`<span><i class="swatch-barb"></i>Wind barb, kt: half 5, full 10, pennant 50; ${s.windAt.slice(11)} UTC; SH feathers</span>`);
  if (S.layers.depth) keys.push(`<span><i class="swatch-hatch"></i>Under ${S.lay.depth?.min_depth_m} m</span>`, `<span><i class="swatch-line iso"></i>${RES()?.bathy?.isobaths.levels_m.join(", ") ?? ""} m isobaths</span>`);
  if (S.layers.edges && f && verifAt(f)) keys.push(`<span><i class="swatch-line edge-sat"></i>Satellite 15% edge</span>`, `<span><i class="swatch-line edge-mod"></i>Model 15% edge</span>`);
  cards.push(`<div class="card keys">${keys.join("")}</div>`);
  $("#legend").innerHTML = cards.join("");
}

const reasonFor = (layer) => (S.lay.missing.find((m) => m.layer === layer)?.reason) ?? "not built";

// Enable or disable layer rows for the cycle and day shown, with the reason in words.
function renderLayerControls() {
  const f = current, res = resHere(f), cyc = RES() ? fmtDate(RES().cycle, { day: "numeric", month: "short" }) : "";
  const only = `Full resolution exists for the ${cyc} forecast only`;
  const set = (sel, ok, hint) => {
    const el = document.querySelector(sel); if (!el) return; el.disabled = !ok;
    const h = el.closest("label").querySelector(".hint"); if (h) h.textContent = ok ? "" : hint;
  };
  for (const [sel, key] of [['input[name="field"][value="cur"]', "cur"], ['[data-layer="currents"]', "cur"], ['input[name="field"][value="sst"]', "sst"],
    ['input[name="field"][value="wav"]', "wav"], ['[data-layer="wavedir"]', "wav"], ['[data-layer="wind"]', "wind"]])
    set(sel, res && !!RES().fields[key], RES()?.fields?.[key] ? only : reasonFor(`research.${key}`));
  set('[data-layer="depth"]', !!S.lay.depth || !!RES()?.bathy, reasonFor("depth"));
  set('[data-layer="bergs"]', !!S.lay.bergs, reasonFor("bergs"));
  $("#sub-sic").textContent = res ? "CMEMS siconc, 1/12°" : "CMEMS, 0.25° archive on this forecast";
  $("#resnote").textContent = res ? `Full 1/12° fields for this forecast.` : `0.25° archive. ${only}.`;
  if (document.querySelector(`input[name="field"][value="${S.field}"]`)?.disabled) { S.field = "sic"; document.querySelector('input[name="field"][value="sic"]').checked = true; }
  // verification: reason + jump on unverifiable days
  const V = VF(), note = $("#verifnote");
  if (!V) { set('[data-layer="edges"]', false, reasonFor("verification")); set('input[name="field"][value="innov"]', false, reasonFor("verification")); note.hidden = true; }
  else {
    const ok = !!verifAt(f);
    note.hidden = !(verifOn() && !ok);
    if (!ok) $("#verifwhy").textContent = `No satellite truth for ${fmtDate(f.cycle.valid[S.lead], { day: "numeric", month: "short", year: "numeric" })}: the NSIDC near-real-time record here runs ${fmtDate(V.first, { day: "numeric", month: "short" })} to ${fmtDate(V.last, { day: "numeric", month: "short", year: "numeric" })}. The latest forecast with every day verifiable was issued ${fmtDate(V.latest_full_cycle, { day: "numeric", month: "short" })}.`;
  }
  // wind steps for the day shown
  const W = RES()?.fields?.wind, ws = $("#windsteps");
  ws.hidden = !(S.layers.wind && res && W);
  if (W) ws.innerHTML = [0, 1, 2, 3].map((k) => { const hh = S.lead * 24 + k * 6, i = W.step_hours.indexOf(hh);
    return `<button data-wstep="${k}" aria-pressed="${k === S.windStep}" ${i < 0 ? "disabled" : ""}>${String(k * 6).padStart(2, "0")} UTC</button>`; }).join("");
}

// The source project's own router on the latest real forecast (scripts/real_route_run.py).
function renderFinding() {
  const el = $("#finding"), R = S.stat.real_route;
  el.hidden = false;
  if (!R) {
    el.className = "ribbon neutral";
    el.innerHTML = `<div class="verdict">No route finding</div><p>${S.stat.missing.find((m) => m.layer === "real_route.json")?.reason ?? "real_route.json was not built"}.</p>`;
    return;
  }
  const closed = R.approach_closed_at_ice_limit, g = R.weather_gate, d = (x) => fmtDate(x, { day: "numeric", month: "long", year: "numeric" });
  el.className = "ribbon" + (closed || g.state === "FAIL" ? "" : " neutral");
  const gs = g.state === "FAIL" ? "INVALID" : g.state === "MARGINAL" ? "DEGRADED" : "VALID";
  el.innerHTML = `
    <div class="verdict">${closed ? "Approach closed" : "Approach open"}<small>${d(R.cycle)} forecast</small></div>
    <div>
      <p>${closed
        ? `Spring ice over the ${S.rules.vessel.max_ice_conc_pct}% working limit closes the Bharati approach. The project's router gets no closer than <b>${R.closest_approach_km} km</b> from the station.`
        : `The project's router reaches Bharati on this forecast.`}</p>
      <div class="facts">
        <span>Weather gate <b class="state-${gs}">${g.state}</b></span>
        <span>Worst waves <b>${R.worst_hs_m} m</b></span>
        <span>Worst wind <b>${R.worst_wind_ms} m/s</b></span>
        <span>Worst ice <b>${Math.round(R.worst_ice * 100)}%</b></span>
        <span><b>${R.eta_days} days</b> from ${(-R.start[0]).toFixed(1)}°S ${R.start[1].toFixed(1)}°E</span>
        ${g.unassessed.map((u) => `<span class="chip unassessed">unassessed: <b>${u}</b></span>`).join("")}
      </div>
    </div>
    <details class="src"><summary>Source and limits</summary>${R.provenance}. Weather gate: ${g.reason}. ${R.segment_note[0].toUpperCase() + R.segment_note.slice(1)}. The browser route below has its own start and grid, so its numbers differ.</details>`;
}

function setPanel(side, open) {
  const btn = document.querySelector(`.collapse[data-panel="${side}"]`);
  btn.setAttribute("aria-expanded", String(open));
  btn.querySelector(".visually-hidden").textContent = `${open ? "Collapse" : "Expand"} ${side === "left" ? "chart controls" : "decision support"}`;
  $(`#${side}body`).hidden = !open;
  document.body.classList.toggle(`${side}-closed`, !open);
  if (current) { baseKey = ""; drawChart(current); }
}

function renderCredits() {
  const L = S.lay, st = S.stat, parts = [
    `Ice: ${S.meta.source}.`,
    L.waves && `Waves: ${L.waves.source}.`,
    L.wind && `Wind: ${L.wind.licence}.`,
    L.depth && `Depth: ${L.depth.citation} Licence ${L.depth.licence}. ${L.depth.caveat}`,
    L.bergs && `Icebergs: ${L.bergs.source}.`,
    `Coast: ${st.coast.source} (${st.coast.licence}). Protected areas: ${st.protected.source}.`,
  ].filter(Boolean);
  const short = [S.lay.waves?.source.split(";")[0] || S.meta.source.split(",")[0], "NOAA/NSIDC",
    L.wind && L.wind.licence.split(", http")[0],
    L.depth && (() => { const m = L.depth.citation.match(/(Dorschel, B\.)[^(]*\((\d{4})\)/); return `IBCSO v2${m ? `, Dorschel et al. ${m[2]}` : ""} (${L.depth.licence.match(/CC-BY-[\d.]+/)?.[0] ?? "see credits"})`; })(),
    L.bergs && "US National Ice Center", "Natural Earth"].filter(Boolean);
  $("#attribution").innerHTML = `<a href="#credits">Credits</a> | ` + short.join(" | ");
  $("#attribution").title = short.join(" | ");
  $("#credits").innerHTML = `<h3>Data and credits</h3>${parts.map((t) => `<p>${t}</p>`).join("")}
    <p>Routing, POLARIS and the gates run in your browser, ported from the project's Python. Nothing on this page is simulated. Advisory only: not for navigation.</p>`;
}

function renderTimeline(f) {
  const c = f.cycle;
  $("#leadLabel").textContent = fmtDate(c.valid[S.lead], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  $("#leadSub").textContent = `D+${S.lead} of ${c.leads - 1}. ` + (S.lead === 0 ? "Analysis, the best estimate for the issue day." : `Forecast, ${S.lead} day${S.lead > 1 ? "s" : ""} ahead.`);
  $("#leadPrev").disabled = S.lead === 0; $("#leadNext").disabled = S.lead >= c.leads - 1;
  $("#depart").innerHTML = c.valid.slice(0, Math.min(5, c.leads)).map((d, k) => `<option value="${k}" ${k === S.depart ? "selected" : ""}>${k === 0 ? "Now" : "In " + k + " day" + (k > 1 ? "s" : "")} (${fmtDate(d)})</option>`).join("");
}

function renderStart() {
  $("#startpos").textContent = `${(-S.start.lat).toFixed(1)}°S ${S.start.lon.toFixed(1)}°E`;
}

// ------------------------------------------------------------------ orchestration
let current = null;
let refreshSeq = 0;
async function refresh({ recompute = true } = {}) {
 try {
  const seq = ++refreshSeq;
  const f = await loadCycle(S.cycle);
  if (seq !== refreshSeq) return;   // a newer click superseded this load
  current = f;
  if (S.lead >= f.leads) S.lead = f.leads - 1;
  if (recompute) S.result = compute(f);
  renderTimeline(f); renderStart(); renderLayerControls(); renderLegend();
  drawChart(f);
  if (recompute) { renderCompare(); renderGates(); renderPolaris(); renderBergs(); renderSpark(); }
 } catch (e) { showError(e); }
}

function showError(e) {
  const el = $("#finding"); el.hidden = false; el.className = "ribbon";
  el.innerHTML = `<div class="verdict">Something failed</div><p>${e.message}</p>`;
  console.error(e);
}

function bindPressed(selector, attr, onPick) {
  document.querySelectorAll(selector).forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(selector).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    onPick(b.dataset[attr]);
  }));
}

// Degrees-minutes-seconds plus decimal, like a chart plotter.
function coordText(lat, lon) {
  const dms = (v) => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 60); return `${String(d).padStart(2, "0")}° ${String(m).padStart(2, "0")}′ ${String(s).padStart(2, "0")}″`; };
  return `<b>${lat < 0 ? "S" : "N"}</b> ${dms(lat)}, <b>${lon < 0 ? "W" : "E"}</b> ${dms(lon)} <span class="muted">(${lat.toFixed(3)}, ${lon.toFixed(3)})</span>`;
}

// Every active layer's value at the cursor.
function inspect(f, lat, lon) {
  const s = S.samp, rows = [], dirTo = (u, v) => ((Math.atan2(u, v) * 180 / Math.PI + 360) % 360).toFixed(0);
  const sic = s.sic?.(lat, lon);
  if (s.sicG && !inGrid(s.sicG, lat, lon)) rows.push(`<span class="muted">Outside the ${s.res ? "1/12°" : "0.25°"} forecast box</span>`);
  else if (Number.isNaN(sic)) rows.push("Land or ice shelf");
  else if (sic !== undefined) rows.push(`Ice <b>${sic.toFixed(0)}%</b>${s.res ? "" : " (0.25°)"}`);
  const thk = s.thk?.(lat, lon); if (Number.isFinite(thk)) rows.push(`Thickness <b>${thk.toFixed(2)} m</b>`);
  const dr = s.idrift?.(lat, lon); if (dr && S.layers.idrift) rows.push(`Ice drift <b>${(Math.hypot(dr[0], dr[1]) * 100).toFixed(1)} cm/s</b> toward ${dirTo(dr[0], dr[1])}°`);
  const cu = s.cur?.(lat, lon); if (cu && (S.layers.currents || S.field === "cur")) rows.push(`Current <b>${(Math.hypot(cu[0], cu[1]) * 100).toFixed(1)} cm/s</b> toward ${dirTo(cu[0], cu[1])}°`);
  const t = s.sst?.(lat, lon); if (Number.isFinite(t) && S.field === "sst") rows.push(`SST <b>${t.toFixed(2)} °C</b>`);
  const hs = s.hs?.(lat, lon); if (Number.isFinite(hs) && (S.field === "wav" || S.layers.wavedir)) rows.push(`Waves <b>${hs.toFixed(2)} m</b> from ${s.wdir(lat, lon).toFixed(0)}°`);
  const w = s.wind?.(lat, lon); if (w) rows.push(`Wind <b>${(Math.hypot(w[0], w[1]) * 1.943844).toFixed(0)} kt</b> from ${dirTo(-w[0], -w[1])}° <span class="muted">${s.windAt.slice(5).replace("T", " ")} UTC</span>`);
  const e = s.elev?.(lat, lon); if (Number.isFinite(e) && S.layers.depth) rows.push(e < 0 ? `Depth <b>${(-e).toFixed(0)} m</b> (box mean)` : `Elevation ${e.toFixed(0)} m`);
  if (s.verif && S.pm) {
    const V = VF().projection, [x, y] = stereoXY(lat, lon, V);
    const sat = s.verif.sat(x, y), mod = s.verif.mod(x, y);
    if (s.verif.suspect(x, y)) rows.push(`Satellite: <b>QA-suspect cell</b>, not scored`);
    else if (Number.isFinite(sat)) rows.push(`Satellite <b>${sat.toFixed(0)}%</b>, model ${Number.isFinite(mod) ? `${mod.toFixed(0)}%` : "–"}${Number.isFinite(mod) ? `, innovation <b>${(mod - sat) >= 0 ? "+" : ""}${(mod - sat).toFixed(0)}</b>` : ""}`);
  }
  return rows.join("<br>") || "–";
}

async function main() {
  const json = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); });
  [S.meta, S.stat, S.lay] = await Promise.all([json("data/meta.json"), json("data/static.json"), json("data/layers.json")]);
  S.rules = { ...S.stat.gate_rules, depth: !!S.lay.depth };
  S.limit = S.rules.vessel.max_ice_conc_pct;
  $("#limit").value = S.limit; $("#limitval").textContent = S.limit + "%";
  $("#limitnote").textContent = `The ${S.limit}% default is the source project's working stand-in (dakshin/ice_meshes.py). No ice class is defined by concentration, so treat it as a setting, not a certificate.`;
  await loadLayers();
  if (!matchMedia(DESKTOP).matches) setPanel("left", false);   // phone: the chart controls start as a closed sheet
  document.querySelectorAll(".collapse").forEach((b) => b.addEventListener("click", () => setPanel(b.dataset.panel, b.getAttribute("aria-expanded") !== "true")));
  $("#scalenote").textContent = `South polar stereographic, centred on ${S.proj.lon0}°E. Scroll or pinch to zoom (1× to 8×), drag to pan, double-click to zoom in; keys + − 0. The graticule tightens as you zoom.`;
  renderFinding(); renderCredits();
  $("#bergadv").textContent = S.lay.berg_tracks ? `Advisory: ${S.lay.berg_tracks.validation.replace(/^see berg_hindcast\.json\s*[—-]\s*/, "")}.` : "";
  view = createView({
    proj: S.proj, surface: $("#chartwrap"), stack: $("#stack"),
    onSettle: () => current && drawChart(current),           // both canvases repaint together once the gesture stops
    onChange: (z) => { $("#zoomLvl").textContent = `${z.toFixed(1)}×`; $("#zoomOut").disabled = z <= 1; $("#zoomIn").disabled = z >= 8; $("#zoomReset").disabled = z <= 1; },
  });
  const cycles = S.meta.cycles;
  S.cycle = cycles[cycles.length - 1];
  $("#vesselname").textContent = `${VESSEL.name}, IMO ${VESSEL.imo}`;
  $("#cycle").innerHTML = cycles.slice().reverse().map((c) => `<option value="${c.cycle}">${fmtDate(c.cycle, { day: "numeric", month: "short", year: "numeric" })}</option>`).join("");
  $("#stage").innerHTML += STAGES.slice(1).map((s) => `<option>${s}</option>`).join("");

  const setCycle = (iso) => { S.cycle = cycles.find((c) => c.cycle === iso); $("#cycle").value = iso; refresh(); };
  $("#cycle").addEventListener("change", (e) => setCycle(e.target.value));
  $("#cyclePrev").addEventListener("click", () => { const i = cycles.indexOf(S.cycle); if (i > 0) setCycle(cycles[i - 1].cycle); });
  $("#cycleNext").addEventListener("click", () => { const i = cycles.indexOf(S.cycle); if (i < cycles.length - 1) setCycle(cycles[i + 1].cycle); });
  $("#leadPrev").addEventListener("click", () => { if (S.lead > 0) { S.lead--; refresh({ recompute: false }); } });
  $("#leadNext").addEventListener("click", () => { if (S.lead < current.leads - 1) { S.lead++; refresh({ recompute: false }); } });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select")) return;
    if (e.key === "ArrowRight" && S.lead < current.leads - 1) { S.lead++; refresh({ recompute: false }); }
    if (e.key === "ArrowLeft" && S.lead > 0) { S.lead--; refresh({ recompute: false }); }
    if (e.key === "+" || e.key === "=") view.zoomCentre(1.6);
    if (e.key === "-") view.zoomCentre(1 / 1.6);
    if (e.key === "0") view.reset();
  });
  $("#depart").addEventListener("change", (e) => { S.depart = +e.target.value; refresh(); });
  $("#limit").addEventListener("input", (e) => { $("#limitval").textContent = e.target.value + "%"; });
  $("#limit").addEventListener("change", (e) => { S.limit = +e.target.value; refresh(); });
  $("#stage").addEventListener("change", renderPolaris);
  bindPressed("[data-obj]", "obj", (v) => { S.obj = v; refresh(); });
  bindPressed("[data-dest]", "dest", (v) => { S.dest = v; refresh(); });
  // Verification defaults to the latest fully verifiable forecast: switching it on
  // from a day with no satellite truth jumps there (the reason stays on screen).
  const jumpToVerifiable = () => {
    const V = VF(); if (!V?.latest_full_cycle) return;
    stopPlay(); S.lead = Math.min(S.lead, 9); setCycle(V.latest_full_cycle);
  };
  const maybeJump = () => { if (verifOn() && current && !verifAt(current)) jumpToVerifiable(); };
  document.querySelectorAll('input[name="field"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) { S.field = r.value; maybeJump(); refresh({ recompute: false }); } }));
  document.querySelectorAll("[data-layer]").forEach((cb) => {
    cb.checked = S.layers[cb.dataset.layer];
    cb.addEventListener("change", () => { S.layers[cb.dataset.layer] = cb.checked; maybeJump(); refresh({ recompute: false }); });
  });
  $("#verifJump").addEventListener("click", jumpToVerifiable);
  document.querySelectorAll("[data-sicmode]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("[data-sicmode]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    S.sicMode = b.dataset.sicmode; refresh({ recompute: false });
  }));
  $("#windsteps").addEventListener("click", (e) => { const b = e.target.closest("[data-wstep]"); if (!b || b.disabled) return; S.windStep = +b.dataset.wstep; refresh({ recompute: false }); });
  // Play: step the forecast day every 1.5 s, animating whatever layers are on.
  let playT = 0;
  const stopPlay = () => { clearInterval(playT); playT = 0; $("#play").setAttribute("aria-pressed", "false"); $("#play").setAttribute("aria-label", "Play the forecast days"); };
  $("#play").addEventListener("click", () => {
    if (playT) return stopPlay();
    $("#play").setAttribute("aria-pressed", "true"); $("#play").setAttribute("aria-label", "Pause");
    playT = setInterval(() => { if (!current) return; S.lead = (S.lead + 1) % current.leads; refresh({ recompute: false }); }, 1500);
  });
  for (const id of ["#leadPrev", "#leadNext", "#cyclePrev", "#cycleNext", "#cycle"]) $(id).addEventListener("pointerdown", stopPlay);
  $("#pickstart").addEventListener("click", () => {
    S.picking = !S.picking; $("#pickstart").setAttribute("aria-pressed", String(S.picking));
    $("#pickstart").textContent = S.picking ? "Click the chart" : "Move ship";
  });

  const over = $("#chartwrap");
  over.addEventListener("mousemove", (e) => {
    const r = over.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const [lat, lon] = S.proj.inv(x, y);
    const f = current; if (!f) return;
    $("#coordbar").innerHTML = coordText(lat, lon);
    const hit = S.layers.bergs && S.lay.bergs ? bergAt(x, y) : null;
    $("#readout").innerHTML = hit ? bergInfo(hit) : inspect(f, lat, lon);
  });
  over.addEventListener("click", (e) => {
    if (!S.picking) return;
    const r = over.getBoundingClientRect();
    const [lat, lon] = S.proj.inv(e.clientX - r.left, e.clientY - r.top);
    if (lat > BOX.lat1 + 0.5 || lat < BOX.lat0 || lon < BOX.lon0 || lon > BOX.lon1) return;
    S.start = { lat, lon }; S.picking = false;
    $("#pickstart").setAttribute("aria-pressed", "false"); $("#pickstart").textContent = "Move ship";
    refresh();
  });
  let t; window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (current) { baseKey = ""; drawChart(current); } }, 150); });
  $("#zoomIn").addEventListener("click", () => view.zoomCentre(1.6));
  $("#zoomOut").addEventListener("click", () => view.zoomCentre(1 / 1.6));
  $("#zoomReset").addEventListener("click", () => view.reset());
  document.addEventListener("toggle", () => { if (current) { baseKey = ""; drawChart(current); } }, true);
  await refresh();
}
main().catch((e) => {
  const el = $("#finding"); el.hidden = false; el.className = "ribbon";
  el.innerHTML = `<div class="verdict">Data did not load</div><p>${e.message}. Serve the folder over HTTP (python -m http.server) rather than opening the file directly.</p>`;
  console.error(e);
});
