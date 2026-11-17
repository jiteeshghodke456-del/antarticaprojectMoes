import { Router, VESSEL, STAGES, band, evaluateGates, haversineKm, GATE_ORDER } from "./model.js";
import { Projection, setupCanvas, paintRaster, gridSampler, wmoColour, WMO, drawGraticule, drawLand, drawLine, drawMarker, drawBerg, drawArrows } from "./map.js";

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
  meta: null, stat: null, cache: new Map(),
  cycle: null, lead: 0, depart: 0, limit: 80, obj: "time", dest: "approach",
  start: { lat: -55.0, lon: 40.0 }, field: "sic",
  layers: { drift: false, static: true, ref2019: false, bergs: true, protected: false },
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
  S.cache.set(c.cycle, f);
  return f;
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
  const decision = evaluateGates({ route: forecast, iceLimitPct: S.limit, destName: d.name, destReachable: !!forecast, nAlternatives: nAlt });
  return { r, start, goal, forecast, statik, blocked, alts, decision };
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
    const sampler = S.field === "sic"
      ? gridSampler(g.sic, f.sic(S.lead), (v) => wmoColour(v))
      : gridSampler(g.thk, f.thk(S.lead), thkColour);
    paintRaster(b.ctx, S.proj, b.w, b.h, b.dpr, sampler);
    drawLand(b.ctx, S.proj, S.stat.coast.land, { fill: null, stroke: "rgba(90,70,30,0.8)" });
    drawGraticule(b.ctx, S.proj, BOX);
    baseKey = key;
  }
  drawOverlay(f);
}

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
  if (S.layers.drift) drawArrows(ctx, P, S.meta.grids.drift, f.U, f.V, S.lead);
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
  if (S.layers.bergs) for (const b of S.stat.bergs.items) if (b.lon >= BOX.lon0 && b.lon <= BOX.lon1 && b.lat <= BOX.lat1) drawBerg(ctx, P, b, nearTrack(b));
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

function nearTrack(b) {
  const R = S.result; if (!R || !R.forecast) return false;
  return minDistKm(b, R.forecast.legs) < 92.6;
}
function minDistKm(b, legs) { let m = Infinity; for (const l of legs) m = Math.min(m, haversineKm(b.lat, b.lon, l.lat, l.lon)); return m; }

// ------------------------------------------------------------------ rail
const days = (h) => (h / 24).toFixed(1) + " d";
function renderCompare() {
  const R = S.result, F = R.forecast, T = R.statik;
  const row = (cls, name, res, note) => res
    ? `<tr class="${cls}"><td>${name}</td><td class="num">${days(res.hours)}</td><td class="num">${res.km.toFixed(0)} km</td><td class="num">${(res.worst * 100).toFixed(0)}%</td><td class="num">${res.overKm > 0 ? `<b style="color:var(--fail)">${res.overKm.toFixed(0)} km</b>` : "none"}</td></tr>`
    : `<tr class="${cls}"><td>${name}</td><td colspan="4"><b style="color:var(--fail)">No route</b> ${note}</td></tr>`;
  $("#compare").innerHTML = `<tr><th></th><th class="num">ETA</th><th class="num">Distance</th><th class="num">Worst ice</th><th class="num">Over limit</th></tr>`
    + row("primary", "Forecast-aware", F, `under ${S.limit}% on this forecast`)
    + row("static", "Today's ice only", T, `under ${S.limit}% on day-${S.depart} ice`);
  let note = "";
  if (F && !T) note = `<div class="callout">Planned on the ice of the day you leave, there is no route under ${S.limit}%. Planned on the ice forecast for the hour the ship gets to each cell, there is one. This is the core idea of the project: the router asks what the ice will be like on arrival, not what it is now.</div>`;
  else if (F && T && T.overKm > 0) note = `<div class="callout">The plan made on today's ice runs into ice over ${S.limit}% for ${T.overKm.toFixed(0)} km by the time the ship gets there. The forecast-aware plan avoids it.</div>`;
  else if (F && T) note = `<div class="callout">Both plans stay under the limit for this departure. The forecast-aware one is ${Math.abs((T.hours - F.hours) / 24).toFixed(1)} days ${T.hours >= F.hours ? "faster" : "slower"}.</div>`;
  else if (!F) note = `<div class="callout warn">No track stays under ${S.limit}% on this forecast. The red dashed line is the least-bad way through, shown only to point at where it is blocked (${R.blocked ? R.blocked.overKm.toFixed(0) + " km over the limit" : "no connection at all"}). Try a later departure or a later forecast.</div>`;
  const alt = R.alts.map((a) => `${a.pct}%: ${a.res ? days(a.res.hours) : "no route"}`).join(" · ");
  note += `<p class="small muted" style="margin-top:8px">Fallback corridors at tighter limits: ${alt || "none tested"}. Beyond the ${S.result.r.f.leads}-day forecast the last forecast day is held. Sea state is not in the harvest, so no wave penalty is applied and ETAs are a lower bound.</p>`;
  $("#planNote").innerHTML = note;
}

function renderGates() {
  const { gates, health, binding } = S.result.decision;
  $("#healthState").textContent = health; $("#healthState").className = "state state-" + health;
  $("#healthWhy").textContent = `set by the ${binding} gate`;
  $("#gates").innerHTML = GATE_ORDER.map((k) => `<li><span class="gname">${k}</span><span class="pill ${gates[k].state}">${gates[k].state}</span><span class="reason">${gates[k].reason}</span></li>`).join("");
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
  const items = S.stat.bergs.items.filter((b) => b.lon >= BOX.lon0 && b.lon <= BOX.lon1 && b.lat <= BOX.lat1);
  const F = S.result.forecast;
  const rows = items.map((b) => ({ b, d: F ? minDistKm(b, F.legs) : null })).sort((a, z) => (a.d ?? 1e9) - (z.d ?? 1e9));
  $("#bergsrc").textContent = `positions of ${items[0]?.updated ?? ""}`;
  $("#bergs").innerHTML = rows.map(({ b, d }) => `<li class="${d !== null && d < 92.6 ? "near" : ""}"><span>${b.name} · ${b.len_nm}×${b.wid_nm} nm</span><span>${d === null ? "–" : (d / 1.852).toFixed(0) + " nm from track"}</span></li>`).join("")
    + `<li class="small muted" style="display:block">Red: within 50 nm of the forecast-aware track. USNIC tracks only bergs longer than about 10 nm; smaller bergs and growlers are not in this list, and drift is not forecast here. Big tabular bergs mostly move with the surface current (Wagner et al., 2017), which the harvest does not yet pull.</li>`;
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
  if (S.field === "sic") {
    $("#legend").innerHTML = `<b>Total ice concentration</b> <span class="muted">(WMO colour code)</span>
      <div class="scale">${WMO.map((c) => `<span style="background:rgb(${c.rgb})">${c.label}</span>`).join("")}<span style="background:rgb(231,220,184)">Land / shelf</span></div>
      <div class="keys"><span><i class="swatch-line"></i>Forecast-aware route</span><span><i class="swatch-line dash"></i>Plan on today's ice</span><span><i class="swatch-line ref"></i>PolarRoute 2019</span><span>◆ Iceberg</span></div>`;
  } else {
    $("#legend").innerHTML = `<b>Ice thickness</b> <span class="muted">(CMEMS sithick, 0.5° cells)</span>
      <div class="scale"><span style="background:rgb(${thkColour(0)})">0</span><span style="background:rgb(${thkColour(5)})">0.5 m</span><span style="background:rgb(${thkColour(10)})">1 m</span><span style="background:rgb(${thkColour(20)});color:#fff">2 m</span><span style="background:rgb(${thkColour(30)});color:#fff">3 m+</span></div>
      <div class="keys"><span>Model thickness is a hint for declaring the POLARIS stage, not an observation of it.</span></div>`;
  }
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
  renderTimeline(f); renderStart(); renderLegend();
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
  [S.meta, S.stat] = await Promise.all([fetch("data/meta.json").then((r) => r.json()), fetch("data/static.json").then((r) => r.json())]);
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
  bindPressed("[data-field]", "field", (v) => { S.field = v; refresh({ recompute: false }); });
  document.querySelectorAll("[data-layer]").forEach((cb) => {
    cb.checked = S.layers[cb.dataset.layer];
    cb.addEventListener("change", () => { S.layers[cb.dataset.layer] = cb.checked; drawOverlay(current); });
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
    else txt = `${pos}<br>Concentration <b>${sic}%</b>${thk !== null && thk !== 255 ? ` · thickness <b>${(thk / 10).toFixed(1)} m</b>` : ""}${u !== null && u !== -128 ? `<br>Drift ${Math.hypot(u, v).toFixed(0)} cm/s toward ${((Math.atan2(u, v) * 180 / Math.PI + 360) % 360).toFixed(0)}°` : ""}`;
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
main();
