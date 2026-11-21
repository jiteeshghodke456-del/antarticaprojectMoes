import { Router, VESSEL, STAGES, band, evaluateGates, haversineKm, GATE_ORDER } from "./model.js";
import { Projection, setupCanvas, paintRaster, gridSampler, wmoColour, WMO, drawGraticule, drawLand, drawLine, drawMarker, drawBerg, drawArrows,
  waveBins, waveColour, WAVE_ICE, drawVectors, drawShallow, drawIsobaths, drawRing } from "./map.js";

const $ = (s) => document.querySelector(s);
const fmtDate = (iso, opt = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { ...opt, timeZone: "UTC" });
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const BOX = { lat0: -78, lat1: -54, lon0: 0, lon1: 80 };
const DESTS = {
  approach: { name: "Bharati approach", lat: -68.5, lon: 76.2, note: "100 km north of the station, the point the source project scores" },
  station: { name: "Bharati station edge", lat: -69.40683, lon: 76.19533, note: "nearest open-ocean grid cell to the station" },
};

const S = {
  meta: null, stat: null, lay: null, rules: null, cache: new Map(), wx: null, depth: null,
  cycle: null, lead: 0, depart: 0, limit: 80, obj: "time", dest: "approach",
  start: { lat: -55.0, lon: 40.0 }, field: "sic",
  layers: { wind: false, drift: false, depth: false, bergs: true, static: true, ref2019: false, protected: false },
  picking: false, result: null, proj: new Projection(46),
};

async function loadCycle(c) {
  if (S.cache.has(c.cycle)) return S.cache.get(c.cycle);
  const buf = await (await fetch(`data/cycles/${c.cycle}.bin`)).arrayBuffer();
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

// ------------------------------------------------------------------ chart
let baseKey = "";
function drawChart(f) {
  const base = $("#base"), over = $("#overlay");
  const b = setupCanvas(base); setupCanvas(over);
  S.proj.fit(BOX, b.w, b.h, 30);
  const key = [f.cycle.cycle, S.lead, S.field, b.w, b.h].join("|");
  if (key !== baseKey) {
    const g = S.meta.grids;
    let sampler;
    if (S.field === "wav" && f.wx?.wav) {
      const bins = waveBinsNow(), W = f.wx.wav(Math.min(S.lead, S.lay.waves.leads - 1)), I = f.sic(S.lead);
      sampler = gridSampler(g.sic, I, (v, k) => (W[k] === 255 ? WAVE_ICE : waveColour(bins, W[k] / 10)));
    } else sampler = S.field === "thk"
      ? gridSampler(g.thk, f.thk(S.lead), thkColour)
      : gridSampler(g.sic, f.sic(S.lead), (v) => wmoColour(v));
    paintRaster(b.ctx, S.proj, b.w, b.h, b.dpr, sampler);
    drawLand(b.ctx, S.proj, S.stat.coast.land, { fill: null, stroke: "rgba(90,70,30,0.8)" });
    drawGraticule(b.ctx, S.proj, BOX);
    baseKey = key;
  }
  drawOverlay(f);
}

// Wind is drawn over the sea only: the IFS field covers the continent too.
const onLand = (f) => { const g = S.meta.grids.sic, I = f.sic(0); return (lat, lon) => {
  const i = Math.round((lat - g.lat0) / g.dlat), j = Math.round((lon - g.lon0) / g.dlon);
  return i >= 0 && j >= 0 && i < g.ny && j < g.nx && I[i * g.nx + j] === 255; }; };
const waveBinsNow = () => waveBins(S.rules.MAX_WAVE_M, S.rules.WAVE_MARGINAL_BAND_M);

function thkColour(dm) {
  if (dm < 1) return [219, 232, 242];
  const t = Math.min(1, dm / 30); // 0..3 m
  const a = [210, 228, 245], z = [26, 54, 120];
  return a.map((v, i) => Math.round(v + (z[i] - v) * t));
}

function drawOverlay(f) {
  const c = $("#overlay"); const { ctx } = setupCanvas(c); const P = S.proj; const R = S.result;
  if (S.layers.protected) {
    for (const a of S.stat.protected.areas) drawLand(ctx, P, a.rings, { fill: "rgba(46,125,79,0.25)", stroke: "rgba(46,125,79,0.9)" });
  }
  if (S.layers.depth && S.depth) {
    drawShallow(ctx, P, S.lay.depth.grid, S.depth, S.lay.depth.min_depth_m);
    drawIsobaths(ctx, P, S.lay.depth.contours.lines, S.lay.depth.contours.levels_m);
  }
  if (S.layers.drift) drawArrows(ctx, P, S.meta.grids.drift, f.U, f.V, S.lead);
  if (S.layers.wind && f.wx?.U) drawVectors(ctx, P, S.lay.wind.grid, f.wx.U, f.wx.V, Math.min(S.lead, S.lay.wind.leads - 1),
    { scale: 0.25, stride: 3, lenPerUnit: 0.05, cap: 30, colour: "rgba(90,42,130,0.85)", skip: onLand(f) });
  if (S.layers.ref2019) {
    const pts = S.stat.route2019.coords.map(([lo, la]) => [la, lo]);
    drawLine(ctx, P, pts, { colour: "#12304d", width: 2, dash: [2, 5], halo: true });
  }
  const toLL = (res) => res.legs.map((l) => [l.lat, l.lon]);
  if (S.layers.static && R.statik) drawLine(ctx, P, toLL(R.statik), { colour: "#12304d", width: 2.5, dash: [9, 6] });
  if (R.forecast) drawLine(ctx, P, toLL(R.forecast), { colour: "#a3156f", width: 3.5 });
  else if (R.blocked) {
    drawLine(ctx, P, toLL(R.blocked), { colour: "#b3261e", width: 2.5, dash: [3, 4] });
  }
  if (S.layers.bergs && S.lay.bergs) {
    const day = f.cycle.valid[S.lead];
    const items = bergsInBox();
    for (const b of items) drawRing(ctx, P, b.lat, b.lon, bergRadiusKm(b, day));
    for (const b of items) drawBerg(ctx, P, b, nearTrack(b, day));
  }
  for (const st of S.stat.stations) {
    if (st.role === "approach") continue;
    drawMarker(ctx, P, st.lat, st.lon, st.name + (st.role === "not-scored" ? " (not scored)" : ""), { shape: "square", colour: st.role === "not-scored" ? "#6b7884" : "#12304d" });
  }
  const d = DESTS[S.dest];
  drawMarker(ctx, P, d.lat, d.lon, S.dest === "approach" ? "Approach point" : "", { colour: "#a3156f", align: "left" });
  // ship: at its position on the forecast track for the valid time shown
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
    ${[0, 50, 100].map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e1e7eb"/><text x="${pad.l - 4}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="#4f6476">${v}%</text>`).join("")}
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${yl}" y2="${yl}" stroke="#b3261e" stroke-dasharray="4 3"/>
    <text x="${W - pad.r}" y="${yl - 4}" text-anchor="end" font-size="10" fill="#b3261e">${S.limit}% limit</text>
    <path d="${line(obs)}" fill="none" stroke="#12304d" stroke-width="1.6"/>
    <path d="${line(fc)}" fill="none" stroke="#a3156f" stroke-width="2" stroke-dasharray="5 3"/>
    <text x="${pad.l}" y="${H - 4}" font-size="10" fill="#4f6476">${fmtDate(pts[0].d, { day: "numeric", month: "short" })}</text>
    <text x="${W - pad.r}" y="${H - 4}" text-anchor="end" font-size="10" fill="#4f6476">${fmtDate(pts[pts.length - 1].d, { day: "numeric", month: "short" })}</text>`;
  const lastObs = obs[obs.length - 1], lastFc = fc[fc.length - 1];
  $("#sparknote").textContent = `Mean concentration in a box around the approach point. Navy: each day's CMEMS analysis since ${fmtDate(pts[0].d, { day: "numeric", month: "short" })}. Magenta: the ${s.outlook_cycle} forecast, ${lastObs.v}% today falling to ${lastFc.v}% by ${fmtDate(lastFc.d, { day: "numeric", month: "short" })}.`;
}

function renderLegend() {
  let head;
  if (S.field === "wav" && current?.wx?.wav) {
    const bins = waveBinsNow();
    head = `<span class="ttl">Significant wave height, daily max</span> <span class="muted">CMEMS; black tick marks the assumed ${Number.isInteger(S.rules.MAX_WAVE_M) ? S.rules.MAX_WAVE_M.toFixed(1) : S.rules.MAX_WAVE_M} m limit</span>
      <div class="scale">${bins.map((b) => `<span class="${b.dark ? "dark" : ""} ${b.limit ? "limit" : ""}" style="background:rgb(${b.rgb})">${b.label}</span>`).join("")}<span style="background:rgb(${WAVE_ICE})">Sea ice</span></div>`;
  } else if (S.field === "thk") {
    head = `<span class="ttl">Ice thickness</span> <span class="muted">CMEMS sithick, 0.5° cells</span>
      <div class="scale"><span style="background:rgb(${thkColour(0)})">0</span><span style="background:rgb(${thkColour(5)})">0.5 m</span><span style="background:rgb(${thkColour(10)})">1 m</span><span class="dark" style="background:rgb(${thkColour(20)})">2 m</span><span class="dark" style="background:rgb(${thkColour(30)})">3 m+</span></div>`;
  } else {
    head = `<span class="ttl">Total ice concentration</span> <span class="muted">WMO colour code</span>
      <div class="scale">${WMO.map((c) => `<span style="background:rgb(${c.rgb})">${c.label}</span>`).join("")}<span style="background:rgb(231,220,184)">Land</span></div>`;
  }
  const keys = [`<span><i class="swatch-line"></i>Forecast-aware route</span>`];
  if (S.layers.static) keys.push(`<span><i class="swatch-line dash"></i>Plan on today's ice</span>`);
  if (S.layers.ref2019) keys.push(`<span><i class="swatch-line ref"></i>PolarRoute 2019</span>`);
  if (S.layers.wind && current?.wx?.U) keys.push(`<span><i class="swatch-arrow wind"></i>Wind, ECMWF ${S.lay.wind.valid_utc[Math.min(S.lead, S.lay.wind.leads - 1)].slice(11)} UTC</span>`);
  if (S.layers.drift) keys.push(`<span><i class="swatch-arrow"></i>Ice drift</span>`);
  if (S.layers.depth && S.depth) keys.push(`<span><i class="swatch-hatch"></i>Under ${S.lay.depth.min_depth_m} m (IBCSO, not a chart)</span>`, `<span><i class="swatch-line iso"></i>${S.lay.depth.contours.levels_m.join(", ")} m isobaths</span>`);
  if (S.layers.bergs && S.lay.bergs) keys.push(`<span>◆ Iceberg</span><span><i class="swatch-ring"></i>Position uncertainty</span>`);
  if (S.field === "thk") keys.push(`<span>Model thickness hints at the POLARIS stage; it does not observe it.</span>`);
  $("#legend").innerHTML = head + `<div class="keys">${keys.join("")}</div>`;
}

const reasonFor = (layer) => (S.lay.missing.find((m) => m.layer === layer)?.reason) ?? "not built";

// Enable or disable layer controls for the cycle shown, with the reason in words.
function renderLayerControls() {
  const here = !!current?.wx, cyc = fmtDate(S.lay.cycle, { day: "numeric", month: "short" });
  const set = (sel, ok, hint) => {
    const el = document.querySelector(sel); el.disabled = !ok;
    const h = el.closest("label").querySelector(".hint"); if (h) h.textContent = ok ? "" : hint;
  };
  set('input[name="field"][value="wav"]', here && !!S.lay.waves, S.lay.waves ? `Archived for the ${cyc} forecast only` : reasonFor("waves"));
  set('[data-layer="wind"]', here && !!S.lay.wind, S.lay.wind ? `Archived for the ${cyc} forecast only` : reasonFor("wind"));
  set('[data-layer="depth"]', !!S.depth, reasonFor("depth"));
  set('[data-layer="bergs"]', !!S.lay.bergs, reasonFor("bergs"));
  if (S.field === "wav" && !(here && S.lay.waves)) { S.field = "sic"; document.querySelector('input[name="field"][value="sic"]').checked = true; }
}

// The source project's own router on the latest real forecast (scripts/real_route_run.py).
function renderFinding() {
  const el = $("#finding"), R = S.stat.real_route;
  el.hidden = false;
  if (!R) {
    el.className = "finding neutral";
    el.innerHTML = `<div class="verdict">No route finding</div><p>${S.stat.missing.find((m) => m.layer === "real_route.json")?.reason ?? "real_route.json was not built"}.</p>`;
    return;
  }
  const closed = R.approach_closed_at_ice_limit, g = R.weather_gate, d = (x) => fmtDate(x, { day: "numeric", month: "long", year: "numeric" });
  el.className = "finding" + (closed || g.state === "FAIL" ? "" : " neutral");
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

function renderCredits() {
  const L = S.lay, st = S.stat, parts = [
    `Ice: ${S.meta.source}.`,
    L.waves && `Waves: ${L.waves.source}.`,
    L.wind && `Wind: ${L.wind.licence}.`,
    L.depth && `Depth: ${L.depth.citation} Licence ${L.depth.licence}. ${L.depth.caveat}`,
    L.bergs && `Icebergs: ${L.bergs.source}.`,
    `Coast: ${st.coast.source} (${st.coast.licence}). Protected areas: ${st.protected.source}.`,
  ].filter(Boolean);
  $("#credits").innerHTML = `<h2>Data and credits</h2>${parts.map((t) => `<p>${t}</p>`).join("")}
    <p>Routing, POLARIS and the gates run in your browser, ported from the project's Python. Nothing on this page is simulated. Advisory only: not for navigation.</p>`;
}

function renderTimeline(f) {
  const c = f.cycle;
  $("#leads").innerHTML = c.valid.map((d, k) => `<button data-lead="${k}" aria-pressed="${k === S.lead}" class="${k === 0 ? "analysis" : ""}"><b>${k === 0 ? "D+0" : "D+" + k}</b>${fmtDate(d)}</button>`).join("");
  $("#validtime").innerHTML = `<b>${fmtDate(c.valid[S.lead], { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</b>${S.lead === 0 ? "Analysis (best estimate for the issue day)" : `Forecast, ${S.lead} day${S.lead > 1 ? "s" : ""} ahead`}`;
  $("#depart").innerHTML = c.valid.slice(0, Math.min(5, c.leads)).map((d, k) => `<option value="${k}" ${k === S.depart ? "selected" : ""}>${k === 0 ? "Now" : "In " + k + " day" + (k > 1 ? "s" : "")} (${fmtDate(d)})</option>`).join("");
}

function renderStart() {
  $("#startpos").textContent = `${(-S.start.lat).toFixed(1)}°S ${S.start.lon.toFixed(1)}°E`;
}

// ------------------------------------------------------------------ orchestration
let current = null;
async function refresh({ recompute = true } = {}) {
  const f = await loadCycle(S.cycle);
  current = f;
  if (S.lead >= f.leads) S.lead = f.leads - 1;
  if (recompute) S.result = compute(f);
  renderTimeline(f); renderStart(); renderLayerControls(); renderLegend();
  drawChart(f);
  if (recompute) { renderCompare(); renderGates(); renderPolaris(); renderBergs(); renderSpark(); }
}

function bindPressed(selector, attr, onPick) {
  document.querySelectorAll(selector).forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(selector).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    onPick(b.dataset[attr]);
  }));
}

async function main() {
  const json = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); });
  [S.meta, S.stat, S.lay] = await Promise.all([json("data/meta.json"), json("data/static.json"), json("data/layers.json")]);
  S.rules = { ...S.stat.gate_rules, depth: !!S.lay.depth };
  S.limit = S.rules.vessel.max_ice_conc_pct;
  $("#limit").value = S.limit; $("#limitval").textContent = S.limit + "%";
  $("#limitnote").textContent = `The ${S.limit}% default is the source project's working stand-in (dakshin/ice_meshes.py). No ice class is defined by concentration, so treat it as a setting, not a certificate.`;
  await loadLayers();
  if (matchMedia("(max-width: 640px)").matches) $("#layerpanel").open = false;
  renderFinding(); renderCredits();
  const cycles = S.meta.cycles;
  S.cycle = cycles[cycles.length - 1];
  $("#vesselname").textContent = `${VESSEL.name}, IMO ${VESSEL.imo}`;
  $("#cycle").innerHTML = cycles.slice().reverse().map((c) => `<option value="${c.cycle}">${fmtDate(c.cycle, { day: "numeric", month: "short", year: "numeric" })}</option>`).join("");
  $("#stage").innerHTML += STAGES.slice(1).map((s) => `<option>${s}</option>`).join("");

  const setCycle = (iso) => { S.cycle = cycles.find((c) => c.cycle === iso); $("#cycle").value = iso; refresh(); };
  $("#cycle").addEventListener("change", (e) => setCycle(e.target.value));
  $("#cyclePrev").addEventListener("click", () => { const i = cycles.indexOf(S.cycle); if (i > 0) setCycle(cycles[i - 1].cycle); });
  $("#cycleNext").addEventListener("click", () => { const i = cycles.indexOf(S.cycle); if (i < cycles.length - 1) setCycle(cycles[i + 1].cycle); });
  $("#leads").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.lead = +b.dataset.lead; refresh({ recompute: false }); });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select")) return;
    if (e.key === "ArrowRight" && S.lead < current.leads - 1) { S.lead++; refresh({ recompute: false }); }
    if (e.key === "ArrowLeft" && S.lead > 0) { S.lead--; refresh({ recompute: false }); }
  });
  $("#depart").addEventListener("change", (e) => { S.depart = +e.target.value; refresh(); });
  $("#limit").addEventListener("input", (e) => { $("#limitval").textContent = e.target.value + "%"; });
  $("#limit").addEventListener("change", (e) => { S.limit = +e.target.value; refresh(); });
  $("#stage").addEventListener("change", renderPolaris);
  bindPressed("[data-obj]", "obj", (v) => { S.obj = v; refresh(); });
  bindPressed("[data-dest]", "dest", (v) => { S.dest = v; refresh(); });
  document.querySelectorAll('input[name="field"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) { S.field = r.value; refresh({ recompute: false }); } }));
  document.querySelectorAll("[data-layer]").forEach((cb) => {
    cb.checked = S.layers[cb.dataset.layer];
    cb.addEventListener("change", () => { S.layers[cb.dataset.layer] = cb.checked; drawOverlay(current); renderLegend(); });
  });
  $("#pickstart").addEventListener("click", () => {
    S.picking = !S.picking; $("#pickstart").setAttribute("aria-pressed", String(S.picking));
    $("#pickstart").textContent = S.picking ? "Click the chart" : "Move ship";
  });

  const over = $("#overlay");
  over.addEventListener("mousemove", (e) => {
    const r = over.getBoundingClientRect();
    const [lat, lon] = S.proj.inv(e.clientX - r.left, e.clientY - r.top);
    const g = S.meta.grids; const f = current; if (!f) return;
    const cell = (gg, arr) => { const i = Math.round((lat - gg.lat0) / gg.dlat), j = Math.round((lon - gg.lon0) / gg.dlon); return i < 0 || j < 0 || i >= gg.ny || j >= gg.nx ? null : arr[i * gg.nx + j]; };
    const sic = cell(g.sic, f.sic(S.lead));
    const thk = cell(g.thk, f.thk(S.lead));
    const dn = g.drift.ny * g.drift.nx;
    const u = cell(g.drift, f.U.subarray(S.lead * dn, (S.lead + 1) * dn)), v = cell(g.drift, f.V.subarray(S.lead * dn, (S.lead + 1) * dn));
    const pos = `${(-lat).toFixed(2)}°S ${lon.toFixed(2)}°E`;
    let txt;
    if (sic === null) txt = `${pos}<br><span class="muted">Outside the forecast box</span>`;
    else if (sic === 255) txt = `${pos}<br>Land or ice shelf`;
    else {
      const dir = (a, b) => ((Math.atan2(a, b) * 180 / Math.PI + 360) % 360).toFixed(0);
      const rows = [`Ice <b>${sic}%</b>${thk !== null && thk !== 255 ? `, <b>${(thk / 10).toFixed(1)} m</b> thick` : ""}`];
      if (u !== null && u !== -128) rows.push(`Ice drift ${Math.hypot(u, v).toFixed(0)} cm/s toward ${dir(u, v)}°`);
      if (f.wx?.wav) { const w = cell(g.sic, f.wx.wav(Math.min(S.lead, S.lay.waves.leads - 1))); rows.push(w === 255 || w === null ? "Waves: no value (ice or coast)" : `Waves up to <b>${(w / 10).toFixed(1)} m</b>`); }
      if (f.wx?.U) {
        const G = S.lay.wind.grid, n = G.ny * G.nx, l = Math.min(S.lead, S.lay.wind.leads - 1);
        const a = cell(G, f.wx.U.subarray(l * n, (l + 1) * n)), b = cell(G, f.wx.V.subarray(l * n, (l + 1) * n));
        if (a !== null) rows.push(`Wind <b>${(Math.hypot(a, b) * 0.25).toFixed(1)} m/s</b> from ${dir(-a, -b)}°`);
      }
      if (S.depth) { const e = cell(S.lay.depth.grid, S.depth); if (e !== null) rows.push(e === 32767 ? "Depth: mostly dry block" : `Depth at least <b>${Math.max(0, -e)} m</b> (shallowest in block)`); }
      txt = `${pos}<br>${rows.join("<br>")}`;
    }
    $("#readout").innerHTML = txt;
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
  let t; window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { baseKey = ""; drawChart(current); }, 150); });
  await refresh();
}
main().catch((e) => {
  const el = $("#finding"); el.hidden = false; el.className = "finding";
  el.innerHTML = `<div class="verdict">Data did not load</div><p>${e.message}. Serve the folder over HTTP (python -m http.server) rather than opening the file directly.</p>`;
  console.error(e);
});
