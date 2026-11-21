import { Projection, setupCanvas, drawGraticule, drawLand, drawLine, drawMarker, wmoColour } from "./map.js";

const $ = (s) => document.querySelector(s);
const fmt = (n, d = 1) => Number(n).toFixed(d);

const [meta, stat] = await Promise.all([fetch("data/meta.json").then((r) => r.json()), fetch("data/static.json").then((r) => r.json())]);

// ---------------------------------------------------------------- forecast drift
{
  const rows = meta.skill.by_lead;
  const W = 560, H = 300, p = { l: 56, r: 56, t: 16, b: 40 };
  const maxI = Math.max(...rows.map((r) => r.iiee_p90_km2)) / 1000;
  const maxM = Math.ceil(Math.max(...rows.map((r) => r.mae_ice)) + 1);
  const x = (k) => p.l + ((k - 1) / (rows.length - 1)) * (W - p.l - p.r);
  const yI = (v) => p.t + (1 - v / maxI) * (H - p.t - p.b);
  const yM = (v) => p.t + (1 - v / maxM) * (H - p.t - p.b);
  const bars = rows.map((r) => `<rect x="${x(r.lead) - 14}" width="28" y="${yI(r.iiee_km2 / 1000)}" height="${H - p.b - yI(r.iiee_km2 / 1000)}" fill="#9fb6c9"/>
      <line x1="${x(r.lead)}" x2="${x(r.lead)}" y1="${yI(r.iiee_km2 / 1000)}" y2="${yI(r.iiee_p90_km2 / 1000)}" stroke="#4f6476"/>
      <text x="${x(r.lead)}" y="${H - p.b + 16}" text-anchor="middle">${r.lead}</text>`).join("");
  const line = rows.map((r, i) => `${i ? "L" : "M"}${x(r.lead)},${yM(r.mae_ice)}`).join("");
  const ticksI = [0, 100, 200].filter((v) => v <= maxI).map((v) => `<text x="${p.l - 8}" y="${yI(v) + 4}" text-anchor="end">${v}k</text><line x1="${p.l}" x2="${W - p.r}" y1="${yI(v)}" y2="${yI(v)}" stroke="#e3e8eb"/>`).join("");
  const ticksM = [0, 2, 4, 6].filter((v) => v <= maxM).map((v) => `<text x="${W - p.r + 8}" y="${yM(v) + 4}">${v}%</text>`).join("");
  $("#skillChart").innerHTML = `${ticksI}${bars}${ticksM}
    <path d="${line}" fill="none" stroke="#a3156f" stroke-width="2.5"/>
    ${rows.map((r) => `<circle cx="${x(r.lead)}" cy="${yM(r.mae_ice)}" r="3.5" fill="#a3156f"/>`).join("")}
    <text x="${(p.l + W - p.r) / 2}" y="${H - 4}" text-anchor="middle">Days ahead</text>
    <text x="12" y="${p.t + 4}" font-size="12">Edge error, km²</text>
    <text x="${W - 8}" y="${p.t + 4}" text-anchor="end" font-size="12" fill="#a3156f">Mean error, ice cells</text>`;
  const r1 = rows[0], r7 = rows.find((r) => r.lead === 7);
  $("#skillCap").textContent = `Bars: mean integrated ice-edge error (whiskers to the 90th percentile) over ${r1.n} forecast cycles, ${meta.cycles[0].cycle} to ${meta.cycles.at(-1).cycle}. Line: mean absolute concentration error where either field has ice. Day 1: ${Math.round(r1.iiee_km2 / 1000)}k km², day 7: ${Math.round(r7.iiee_km2 / 1000)}k km².`;
  $("#driftText").textContent = `The edge error (the area where the forecast and the later analysis disagree about whether there is more than 15% ice) grows by roughly the same amount every day ahead: about ${Math.round(r1.iiee_km2 / 1000)},000 km² on day 1 and ${Math.round(r7.iiee_km2 / 1000)},000 km² by day 7. That growth is the reason the project corrects the forecast with a learned model instead of using it raw.`;
}

const pct = (a, b) => Math.round(100 * (b - a) / b);          // how much lower a is than b, in percent
const missingNote = (key) => `<p class="small muted">Not built: ${(stat.missing || []).find((m) => m.layer.startsWith(key))?.reason ?? key + " is missing from static.json"}.</p>`;
const leadName = (k) => `${k.replace("lead_", "")} day${k === "lead_1" ? "" : "s"}`;

// ---------------------------------------------------------------- real forecast vs satellite truth
{
  const H = stat.hindcast_real;
  if (!H) $("#truthText").innerHTML = missingNote("realforecast_hindcast");
  else {
    const L = Object.entries(H.leads);
    $("#truthTable").innerHTML = `<thead><tr><th>Lead</th><th class="num">Cycles</th><th class="num">RMSE CMEMS</th><th class="num">RMSE persistence</th><th class="num">Edge error CMEMS</th><th class="num">Edge error persistence</th></tr></thead><tbody>${L.map(([k, r]) =>
      `<tr><td>${leadName(k)}</td><td class="num">${r.n_cycles}</td><td class="num ${r.rmse.cmems < r.rmse.persistence ? "best" : ""}">${r.rmse.cmems.toFixed(4)}</td><td class="num ${r.rmse.persistence < r.rmse.cmems ? "best" : ""}">${r.rmse.persistence.toFixed(4)}</td><td class="num ${r.iiee_km2_mean.cmems < r.iiee_km2_mean.persistence ? "best" : ""}">${Math.round(r.iiee_km2_mean.cmems / 1000)}k km²</td><td class="num ${r.iiee_km2_mean.persistence < r.iiee_km2_mean.cmems ? "best" : ""}">${Math.round(r.iiee_km2_mean.persistence / 1000)}k km²</td></tr>`).join("")}</tbody>`;
    const first = L[0][1], last = L[L.length - 1];
    $("#truthCap").textContent = `Truth: ${H.truth}. Forecast: ${H.forecast}, ${first.first_cycle} to ${last[1].last_cycle}. Scoring: ${H.scoring}. Bold marks the lower error. Source: ${H.provenance}.`;
    const edgeLosers = L.filter(([, r]) => r.iiee_km2_mean.persistence < r.iiee_km2_mean.cmems).map(([k]) => leadName(k));
    $("#truthText").innerHTML = `<p>Each archived forecast was scored against what the satellite later measured. On concentration error the raw CMEMS forecast beats "tomorrow looks like today" at every lead, by ${pct(first.rmse.cmems, first.rmse.persistence)}% at ${leadName(L[0][0])} and ${pct(last[1].rmse.cmems, last[1].rmse.persistence)}% at ${leadName(last[0])}.</p>
      <p>${edgeLosers.length ? `The ice edge is the exception: at ${edgeLosers.join(" and ")} persistence puts the 15% edge in the right place more often than the forecast does. Beyond that the forecast wins, because persistence cannot move the edge at all.` : "It also places the 15% ice edge better than persistence at every lead."}</p>
      <p class="small muted">${H.caveats.join(". ")}.${H.model === null ? " No learned correction is scored here yet: this is the raw forecast." : ""}</p>`;
  }
}

// ---------------------------------------------------------------- U-Net prototype
{
  const P = stat.prototype_results;
  if (!P) $("#unetTable").outerHTML = missingNote("prototype_results");
  else {
    $("#unetTable").innerHTML = `<thead><tr><th>Lead</th><th class="num">U-Net</th><th class="num">Persistence</th><th class="num">Raw GLORYS12</th><th class="num">Gain vs persistence</th></tr></thead><tbody>${P.rows.map((r) =>
      `<tr><td>${r.lead} day${r.lead > 1 ? "s" : ""}</td><td class="num best">${r.model.toFixed(4)}</td><td class="num">${r.persistence.toFixed(4)}</td><td class="num">${r.raw_glorys12.toFixed(4)}</td><td class="num">${r.gain_vs_persistence}</td></tr>`).join("")}</tbody>`;
    $("#unetCap").textContent = `RMSE of sea-ice concentration (0 to 1) on the held-out test slice, scored once. Source: ${P.provenance}.`;
  }
}

// ---------------------------------------------------------------- resolution (F1, F3)
{
  const F = stat.resolution;
  if (!F) $("#resText").innerHTML = missingNote("resolution_study");
  else {
    const res = Object.keys(F.resolutions), leads = Object.keys(F.resolutions[res[0]]);
    $("#resQuestion").textContent = `Method: ${F.method}.`;
    const cell = (v, row, f) => { const best = Math.min(...row); return `<td class="num ${v === best ? "best" : ""}">${f(v)}</td>`; };
    const k = (x) => (x / 1000).toFixed(1);
    $("#resTable").innerHTML = `<thead><tr><th rowspan="2">Lead</th><th class="num" colspan="${res.length}">RMSE</th><th class="num" colspan="${res.length}">Edge error, 10³ km²</th></tr>
      <tr>${res.map((r) => `<th class="num">${r}</th>`).join("")}${res.map((r) => `<th class="num">${r}</th>`).join("")}</tr></thead><tbody>${leads.map((l) => {
        const rm = res.map((r) => F.resolutions[r][l].rmse.cmems), ie = res.map((r) => F.resolutions[r][l].iiee_km2_mean.cmems);
        return `<tr><td>${leadName(l)}</td>${rm.map((v) => cell(v, rm, (x) => x.toFixed(4))).join("")}${ie.map((v) => cell(v, ie, k)).join("")}</tr>`; }).join("")}</tbody>`;
    $("#resCap").textContent = `Raw CMEMS forecast block-averaged to each resolution and scored on the same cells against the same satellite truth. Bold: lowest error in the row. Source: ${F.provenance}.`;
    const fine = res[0], coarse = res[res.length - 1], l7 = leads[leads.length - 1];
    const ie7 = (r) => F.resolutions[r][l7].iiee_km2_mean.cmems;
    $("#resText").innerHTML = `<p>Point-by-point error (RMSE) cannot see resolution: the smoothed ${res[1]} field scores as well as ${fine} or slightly better, because a sharp forecast that misplaces a feature pays twice and a blurred one pays once. The ice edge can see it: at ${leadName(l7)} the ${coarse} forecast misplaces ${k(ie7(coarse) - ie7(fine))} thousand km² more edge than ${fine}. Between ${fine} and ${res[1]} the two metrics find no difference in this corridor and season, a null result reported as one.</p>
      <p class="small muted">${F.caveat}.</p>`;
  }
  const B = stat.berg_resolution;
  if (!B) $("#bergResText").innerHTML = missingNote("berg_resolution");
  else {
    const R = Object.entries(B.resolutions);
    $("#bergResTable").innerHTML = `<thead><tr><th>Currents at</th><th class="num">Scored</th><th class="num">Median error</th><th class="num">Moving bergs only</th></tr></thead><tbody>${R.map(([r, v]) =>
      `<tr><td>${r}</td><td class="num">${v.n_ok} of ${v.n_segments}</td><td class="num">${v.median_error_km_per_day} km/day</td><td class="num">${v.moving_median_error_km_per_day} km/day</td></tr>`).join("")}</tbody>`;
    $("#bergResCap").textContent = `${B.method}. Source: ${B.provenance}.`;
    $("#bergResText").innerHTML = `<p>${B.question[0].toUpperCase() + B.question.slice(1)} On this sample, no: coarser currents give a smaller drift error, not a larger one. That says more about the sample than about eddies, as the next panel shows.</p><p class="muted">${B.caveats.join(". ")}.</p>`;
  }
}

// ---------------------------------------------------------------- iceberg hindcast
{
  const H = stat.berg_hindcast;
  if (!H) $("#bergText").innerHTML = missingNote("berg_hindcast");
  else {
    const sp = H.split;
    $("#bergNums").innerHTML = `
      <div><div class="bignum">${H.median_error_km_per_day.model} km/day</div><span>Drift model, median error over ${H.n_ok} scored segments</span></div>
      <div><div class="bignum" style="color:var(--route)">${H.median_error_km_per_day.persistence} km/day</div><span>Persistence: the berg stays where it was last seen</span></div>
      <div><div class="bignum">${sp.stationary_segments} of ${sp.stationary_segments + sp.moving_segments}</div><span>Segments where the berg did not move</span></div>`;
    $("#bergTable").innerHTML = `<thead><tr><th>Sample</th><th class="num">Drift model</th><th class="num">Persistence</th></tr></thead><tbody>
      <tr><td>All scored segments (${H.n_ok})</td><td class="num">${H.median_error_km_per_day.model}</td><td class="num best">${H.median_error_km_per_day.persistence}</td></tr>
      <tr><td>Moving bergs only (${sp.moving_segments})</td><td class="num">${sp.moving_median_km_per_day.model}</td><td class="num best">${sp.moving_median_km_per_day.persistence}</td></tr>
      <tr><td>Stationary bergs (${sp.stationary_segments})</td><td class="num">${sp.stationary_model_median_km_per_day}</td><td class="num best">0, by definition</td></tr></tbody>`;
    $("#bergCap").textContent = `Median position error per day between weekly USNIC fixes, km/day; bold is lower. Currents: ${H.currents}. Wind: ${H.wind}. ${H.n_segments - H.n_ok} grounded-or-unknown segments are excluded from the medians. Source: ${H.provenance}.`;
    $("#bergText").innerHTML = `<p>The drift model was run between every pair of weekly USNIC fixes for the giant bergs in the corridor and compared with where the berg was next seen. It lost to the simplest possible forecast, that the berg has not moved. ${sp.finding[0].toUpperCase() + sp.finding.slice(1)}.</p>
      <p>What it implies for the bridge: for these giants the honest forecast is the last fix plus a growing circle of doubt, which is what the Bridge draws, at the model's measured ${H.uncertainty_radius_km_per_day} km a day. A drift model earns its place only once it can tell a grounded berg from a free one, and only when fixes are more frequent than weekly.</p>
      <p class="small muted">${H.caveats.join(". ")}.</p>`;
  }
}

// ---------------------------------------------------------------- QA finding
{
  const a = stat.qa_audit, d0 = stat.window2019.daily[0], d3 = stat.window2019.daily[3];
  $("#qaText").textContent = `The NOAA/NSIDC satellite record writes 0.0% at coastal pixels where its land-spillover filter fired. Zero is a valid value, so any naive reader takes it as open water. On ${d0.date} the cell beside Bharati read ${d0.Bharati.sic_qa_off.toFixed(1)}% while its quality flag said not to trust it. With flagged cells removed, the same spot reads ${d0.Bharati.sic_qa_on.toFixed(1)}%. On ${d3.date} it read ${d3.Bharati.sic_qa_on.toFixed(0)}%: the ice never left, the retrieval did.`;
  $("#qaNums").innerHTML = `
    <div><div class="bignum">${d0.Bharati.sic_qa_off.toFixed(1)}%</div><span>Bharati cell, ${d0.date}, raw</span></div>
    <div><div class="bignum" style="color:var(--route)">${d0.Bharati.sic_qa_on.toFixed(1)}%</div><span>Same cell, flagged pixels removed</span></div>
    <div><div class="bignum">${a.station_approaches.Bharati.pct_of_days_affected}%</div><span>Days with suspect cells near Bharati, ${a.archive.first.slice(0, 4)}–${a.archive.last.slice(0, 4)}</span></div>
    <div><div class="bignum">${Math.round(a.land_spillover.mean_cells_per_day)}</div><span>Spillover cells per day, every day of ${a.archive.files}</span></div>`;
  $("#qaAudit").textContent = `Audit over ${a.archive.files} daily files (${a.archive.first}–${a.archive.last}). Source: dakshin/figures/ice_quality_audit.json, produced by dakshin/audit_ice_quality.py. The fix (dakshin/ice_quality.py) marks flagged cells unknown instead of open water, so the router inherits the surrounding ice and becomes more cautious, not less.`;
}

// ---------------------------------------------------------------- destination window
{
  const w = stat.window2019, d = w.daily;
  const W = 1080, H = 260, p = { l: 44, r: 16, t: 14, b: 36 };
  const bw = (W - p.l - p.r) / d.length;
  const y = (v) => p.t + (1 - v / 100) * (H - p.t - p.b);
  const st = "Bharati", ap = "Bharati approach (100 km N)";
  let s = [0, 25, 50, 75, 100].map((v) => `<line x1="${p.l}" x2="${W - p.r}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e8eb"/><text x="${p.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`).join("");
  d.forEach((row, i) => {
    const x0 = p.l + i * bw;
    const v = row[st].sic_qa_on ?? 0, raw = row[st].sic_qa_off ?? 0;
    s += `<rect x="${x0 + 3}" width="${bw - 6}" y="${y(v)}" height="${H - p.b - y(v)}" fill="${row[st].passable ? "#8fc6a1" : "#e2775f"}"><title>${row.date}: ${v}% (raw ${raw}%) ${row[st].passable ? "open" : "closed"}</title></rect>`;
    if (raw === 0 && v > 0) s += `<rect x="${x0 + 3}" width="${bw - 6}" y="${y(2)}" height="${H - p.b - y(2)}" fill="#12304d"/>`;
    if (i % 5 === 0) s += `<text x="${x0 + bw / 2}" y="${H - p.b + 16}" text-anchor="middle">${row.date.slice(8)} Dec</text>`;
  });
  const apLine = d.map((row, i) => `${i ? "L" : "M"}${p.l + i * bw + bw / 2},${y(row[ap].sic_qa_on)}`).join("");
  s += `<path d="${apLine}" fill="none" stroke="#a3156f" stroke-width="2.5"/>`;
  s += `<line x1="${p.l}" x2="${W - p.r}" y1="${y(w.ice_limit_pct)}" y2="${y(w.ice_limit_pct)}" stroke="#b3261e" stroke-dasharray="5 4"/><text x="${W - p.r}" y="${y(w.ice_limit_pct) - 5}" text-anchor="end" fill="#b3261e">${w.ice_limit_pct}% working limit</text>`;
  $("#windowChart").innerHTML = s;
  const sm = w.summary[st];
  $("#windowCap").innerHTML = `Bars: Bharati's own cell each day, green if the vessel-performance mesh let ${w.vessel} in, red if not. Closed on <b>${sm.days_closed} of ${sm.days_observed}</b> days. A navy stub marks days the raw product read exactly 0.0% while the quality-checked value was higher. Magenta line: the approach 100 km north, open on ${w.summary[ap].days_observed - w.summary[ap].days_closed} of ${w.summary[ap].days_observed}. Maitri is left out: it is about 100 km inland and its ship offload point is not sourced, so it was never scored. Source: dakshin/figures/destination_window.json.`;
}

// ---------------------------------------------------------------- 2019 mesh map
{
  const c = $("#meshMap"); const { ctx, w, h } = setupCanvas(c);
  const P = new Projection(48); const box = { lat0: -71, lat1: -32, lon0: 14, lon1: 82 };
  P.fit(box, w, h, 18);
  ctx.fillStyle = "#dbe8f2"; ctx.fillRect(0, 0, w, h);
  for (const cb of stat.mesh2019) {
    const ring = [[cb.cy - cb.dcy, cb.cx - cb.dcx], [cb.cy - cb.dcy, cb.cx + cb.dcx], [cb.cy + cb.dcy, cb.cx + cb.dcx], [cb.cy + cb.dcy, cb.cx - cb.dcx]];
    ctx.beginPath();
    const steps = 8;
    for (let e = 0; e < 4; e++) {
      const [a, b] = [ring[e], ring[(e + 1) % 4]];
      for (let k = 0; k <= steps; k++) { const t = k / steps; const [x, y] = P.fwd(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t); e === 0 && k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    }
    ctx.closePath();
    const col = cb.land ? [231, 220, 184] : wmoColour(cb.SIC ?? 0);
    ctx.fillStyle = `rgb(${col})`; ctx.fill();
    ctx.strokeStyle = "rgba(18,48,77,0.35)"; ctx.lineWidth = 0.6; ctx.stroke();
    if (cb.inaccessible && !cb.land) {
      ctx.save(); ctx.clip(); ctx.strokeStyle = "rgba(18,48,77,0.45)"; ctx.lineWidth = 1;
      for (let k = -h; k < w + h; k += 7) { ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k - h, h); ctx.stroke(); }
      ctx.restore();
    }
  }
  drawLand(ctx, P, stat.coast.land);
  drawGraticule(ctx, P, box);
  const pts = stat.route2019.coords.map(([lo, la]) => [la, lo]);
  drawLine(ctx, P, pts, { colour: "#a3156f", width: 3.5 });
  drawMarker(ctx, P, -33.9, 18.4, "Cape Town");
  drawMarker(ctx, P, -69.40683, 76.19533, "Bharati", { shape: "square", align: "left" });
  const A = stat.alternatives2019.corridors[0];
  $("#routeStats").innerHTML = `Run on NOAA/NSIDC satellite ice of ${stat.alternatives2019.date}, Cape Town to Bharati for ${stat.alternatives2019.vessel}: <b>${fmt(A.traveltime_days, 2)} days</b> steaming, ${A.legs} legs, heaviest ice sampled on the line ${A.worst_ice_pct}%. ${stat.mesh2019.length} mesh boxes.`;
}

// ---------------------------------------------------------------- corridors
{
  const a = stat.alternatives2019;
  $("#altTable").innerHTML = `<thead><tr><th>Corridor</th><th class="num">Ice limit</th><th class="num">Steaming</th><th class="num">Legs</th><th class="num">Worst ice on line</th><th>Reading</th></tr></thead><tbody>${a.corridors.map((c) =>
    `<tr><td><b>${c.label}</b> ${c.name}</td><td class="num">${c.ice_limit_pct}%</td><td class="num">${c.solved ? fmt(c.traveltime_days, 2) + " d" : "<b style='color:var(--fail)'>no route</b>"}</td><td class="num">${c.legs ?? "–"}</td><td class="num">${c.worst_ice_pct != null ? c.worst_ice_pct + "%" : "–"}</td><td class="small">${c.rationale}</td></tr>`).join("")}</tbody>`;
  $("#altFindings").innerHTML = a.findings.map((f) => `<li><b>${f.finding}</b> ${f.why} ${f.consequence}</li>`).join("") + `<li class="muted">${a.caveat}</li>`;
}

// ---------------------------------------------------------------- regret + vessels
{
  const r = stat.regret2019;
  $("#regretTable").innerHTML = `<thead><tr><th>Planner</th><th class="num">Planned</th><th class="num">Actual</th><th class="num">Blocked</th><th class="num">Max ice met</th></tr></thead><tbody>${r.results.map((x) =>
    `<tr><td><b>${x.planner}</b><br><span class="small muted">${r.arms[x.planner]}</span></td><td class="num">${x.planned_days != null ? fmt(x.planned_days, 2) + " d" : "–"}</td><td class="num">${fmt(x.actual_days, 2)} d</td><td class="num">${x.blocked_hours} h</td><td class="num">${x.max_sic_encountered}%</td></tr>`).join("")}</tbody>`;
  $("#regretCap").textContent = `${r.experiment}. ${r.route}, departing ${r.depart}, on observed daily ice (${r.ice_source}). On this one departure the plans barely differ, so the repo explicitly says not to claim that daily re-planning beats static planning. One voyage is an anecdote, not a result. Source: dakshin/figures/route_regret.json.`;
  const v = stat.vessels2019;
  const runs = Object.values(v.runs);
  $("#vesselText").innerHTML = `<h3 style="margin-bottom:6px">Same ice, two ships</h3>
    <p>${runs.map((x) => `${x.vessel}: ${fmt(x.traveltime_days, 2)} days, fuel index ${fmt(x.fuel, 0)}`).join(". ")}. The track is ${v.track_identical ? "identical" : "different"}.</p>
    <p>${v.verdict}</p><p class="small muted">${v.note}</p>`;
}
