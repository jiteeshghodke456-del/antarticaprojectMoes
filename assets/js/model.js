// Decision logic for the bridge demo, ported from the Python in
// sih26059-antarctic-navigation. Each block names the file it follows.
// Nothing here is tuned for the demo: thresholds and tables are copied.

// ---------------------------------------------------------------------------
// Vessel model  (isih/sim/router.py: VesselModel)
// ---------------------------------------------------------------------------
export const VESSEL = {
  name: "MV Vasiliy Golovnin",
  imo: "8723426",
  maxSpeedKn: 16.4,   // service speed, verified against four registries (isih/ice_meshes.py)
  minSpeedKn: 2.0,
  beamM: 22.4,
};

export function speedKn(sic, iceLimit, hs = 0) {
  // sic and iceLimit in 0..1. Ice derates slightly faster than linear;
  // sea state is not in the CMEMS harvest, so hs is 0 and the sea factor is 1.
  if (sic > iceLimit) return 0;
  const frac = Math.min(1, Math.max(0, sic / Math.max(iceLimit, 1e-6)));
  const vIce = VESSEL.maxSpeedKn * (1 - 0.92 * Math.pow(frac, 1.35));
  const sea = 1 - 0.45 * Math.min(1, Math.max(0, (hs - 4) / 5));
  return Math.max(vIce * sea, VESSEL.minSpeedKn);
}

export function fuelTPerKm(speed, sic, hs = 0) {
  // Relative only: the hull's real performance curve is not public.
  const calm = 0.00012 * speed * speed;
  const ice = 0.02 * Math.pow(Math.min(1, Math.max(0, sic)), 1.5);
  const wave = 0.00035 * Math.pow(Math.min(18, Math.max(0, hs)), 2);
  return calm + ice + wave;
}

const R = 6371;
export function haversineKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = p2 - p1, dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// Time-aware router  (isih/sim/router.py: Router)
// The cost of entering a cell uses the ice forecast for the hour the ship
// gets there, not the ice at departure.
// ---------------------------------------------------------------------------
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v; const topV = v[0], topK = k[0];
    const lk = k.pop(), lv = v.pop(); const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return [topK, topV];
  }
}

const NB = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

export class Router {
  // field: { g: {ny,nx,lat0,dlat,lon0,dlon}, sic(lead) -> Uint8Array, leads }
  constructor(field) {
    this.f = field;
    const g = field.g;
    this.lat = (i) => g.lat0 + g.dlat * i;
    this.lon = (j) => g.lon0 + g.dlon * j;
    // pre-compute edge lengths per row (depends only on latitude and direction)
    this.edgeKm = [];
    for (let i = 0; i < g.ny; i++) {
      this.edgeKm.push(NB.map(([di, dj]) => haversineKm(this.lat(i), 0, this.lat(i + di), g.dlon * dj)));
    }
  }

  cellOf(lat, lon) {
    const g = this.f.g;
    return [Math.round((lat - g.lat0) / g.dlat), Math.round((lon - g.lon0) / g.dlon)];
  }

  isLand(idx) { return this.f.sic(0)[idx] === 255; }

  nearestOcean(lat, lon) {
    const g = this.f.g; const [i0, j0] = this.cellOf(lat, lon);
    let best = null, bd = Infinity;
    for (let r = 0; r < 40 && !best; r++) {
      for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) {
        if (i < 0 || j < 0 || i >= g.ny || j >= g.nx) continue;
        const idx = i * g.nx + j; if (this.isLand(idx)) continue;
        const d = haversineKm(lat, lon, this.lat(i), this.lon(j));
        if (d < bd) { bd = d; best = { i, j, idx, km: d }; }
      }
    }
    return best;
  }

  leadAt(hours) { return Math.min(this.f.leads - 1, Math.max(0, Math.floor(hours / 24))); }

  sicAt(idx, hours) { return this.f.sic(this.leadAt(hours))[idx] / 100; }

  // mode: "forecast" uses ice at arrival; "static" freezes the departure lead.
  // objective: "time" | "fuel". penalise: allow cells over the limit at a huge cost
  // (used only to show where a blocked route would have to go).
  solve({ start, goal, iceLimit, departHours = 0, mode = "forecast", objective = "time", penalise = false }) {
    const g = this.f.g, N = g.ny * g.nx;
    const cost = new Float64Array(N).fill(Infinity);
    const time = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const done = new Uint8Array(N);
    const s = start.idx, t = goal.idx;
    cost[s] = 0; time[s] = departHours;
    const h = new Heap(); h.push(0, s);
    const lim = iceLimit;
    while (h.size) {
      const [c, u] = h.pop();
      if (done[u]) continue; done[u] = 1;
      if (u === t) break;
      const ui = (u / g.nx) | 0, uj = u - ui * g.nx;
      const tu = time[u];
      const leadHours = mode === "static" ? departHours : tu;
      const lead = this.leadAt(leadHours);
      const S = this.f.sic(lead);
      const su = S[u] / 100;
      for (let k = 0; k < 8; k++) {
        const vi = ui + NB[k][0], vj = uj + NB[k][1];
        if (vi < 0 || vj < 0 || vi >= g.ny || vj >= g.nx) continue;
        const v = vi * g.nx + vj; if (done[v]) continue;
        const sv8 = S[v]; if (sv8 === 255) continue;
        const sic = Math.max(su, sv8 / 100);
        let spd, over = 0;
        if (sic > lim) { if (!penalise) continue; spd = VESSEL.minSpeedKn; over = 1; }
        else spd = speedKn(sic, lim);
        const km = this.edgeKm[ui][k];
        const hrs = km / (spd * 1.852);
        let step = objective === "fuel" ? fuelTPerKm(spd, sic) * km : hrs;
        if (over) step += 1e4 * km; // a blocked cell is only taken if nothing else connects
        const nc = c + step;
        if (nc < cost[v]) { cost[v] = nc; time[v] = tu + hrs; prev[v] = u; h.push(nc, v); }
      }
    }
    if (!isFinite(cost[t])) return null;
    const path = []; for (let u = t; u !== -1; u = prev[u]) path.push(u);
    path.reverse();
    return this.replay(path, departHours, lim);
  }

  // Sail a fixed path against the forecast: arrival time, ice met, fuel, and
  // where (if anywhere) the ice is over the working limit when the ship gets there.
  replay(path, departHours, lim) {
    const g = this.f.g;
    let t = departHours, km = 0, fuel = 0, worst = 0, worstAt = 0, overKm = 0, firstOver = null;
    const legs = [];
    for (let n = 0; n < path.length; n++) {
      const u = path[n]; const ui = (u / g.nx) | 0, uj = u - ui * g.nx;
      const sicHere = this.sicAt(u, t);
      if (sicHere > worst) { worst = sicHere; worstAt = n; }
      legs.push({ idx: u, lat: this.lat(ui), lon: this.lon(uj), hours: t - departHours, sic: sicHere, lead: this.leadAt(t) });
      if (n === path.length - 1) break;
      const v = path[n + 1]; const vi = (v / g.nx) | 0, vj = v - vi * g.nx;
      const sic = Math.max(sicHere, this.sicAt(v, t));
      const d = haversineKm(this.lat(ui), this.lon(uj), this.lat(vi), this.lon(vj));
      let spd = speedKn(sic, lim);
      if (sic > lim) { spd = VESSEL.minSpeedKn; overKm += d; if (firstOver === null) firstOver = t - departHours; }
      fuel += fuelTPerKm(spd, sic) * d; km += d; t += d / (spd * 1.852);
    }
    return { path, legs, hours: t - departHours, km, fuel, worst, worstAt, overKm, firstOverHours: firstOver };
  }
}

// ---------------------------------------------------------------------------
// POLARIS  (isih/polaris.py, MSC.1/Circ.1519 Table 1.3, standard ice)
// ---------------------------------------------------------------------------
export const STAGES = ["Ice-free", "New", "Grey", "Grey-White", "Thin FY 1st", "Thin FY 2nd",
  "Med FY <1 m", "Med FY", "Thick FY", "Second Year", "Light MY <2.5 m", "Heavy MY"];
export const CLASSES = ["PC1", "PC2", "PC3", "PC4", "PC5", "PC6", "PC7", "IA Super", "IA", "IB", "IC", "Not ice strengthened"];
const RIV_ROWS = {
  "PC1": [3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 1, 1],
  "PC2": [3, 3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 0],
  "PC3": [3, 3, 3, 3, 2, 2, 2, 2, 2, 1, 0, -1],
  "PC4": [3, 3, 3, 3, 2, 2, 2, 2, 1, 0, -1, -2],
  "PC5": [3, 3, 3, 3, 2, 2, 1, 1, 0, -1, -2, -2],
  "PC6": [3, 2, 2, 2, 2, 1, 1, 0, -1, -2, -3, -3],
  "PC7": [3, 2, 2, 2, 1, 1, 0, -1, -2, -3, -3, -3],
  "IA Super": [3, 2, 2, 2, 2, 1, 0, -1, -2, -3, -4, -4],
  "IA": [3, 2, 2, 2, 1, 0, -1, -2, -3, -4, -5, -5],
  "IB": [3, 2, 2, 1, 0, -1, -2, -3, -4, -5, -6, -6],
  "IC": [3, 2, 1, 0, -1, -2, -3, -4, -5, -6, -7, -8],
  "Not ice strengthened": [3, 1, 0, -1, -2, -3, -4, -5, -6, -7, -8, -8],
};
const riv = (cls, stage) => RIV_ROWS[cls][STAGES.indexOf(stage)];

export function tier(rio, cls) {
  if (rio >= 0) return "NORMAL";
  if (cls.startsWith("PC")) return rio >= -10 ? "ELEVATED" : "SPECIAL";
  return "SPECIAL";
}
export function speedLimitKn(cls) {
  if (["PC3", "PC4", "PC5"].includes(cls)) return 5;
  if (["PC6", "PC7", "IA Super", "IA", "IB", "IC", "Not ice strengthened"].includes(cls)) return 3;
  return null;
}
export function rioSingleStage(sic, stage, cls) {
  // RIO = C x RIV[stage] + (10 - C) x RIV[ice-free]. Not the IMO RIO: a single-stage reduction.
  const c = Math.round(Math.max(0, Math.min(1, sic)) * 10);
  return c * riv(cls, stage) + (10 - c) * riv(cls, "Ice-free");
}
export function band(sic, stage, clsLo = "IA", clsHi = "PC4") {
  const a = CLASSES.indexOf(clsHi), b = CLASSES.indexOf(clsLo);
  const rows = CLASSES.slice(Math.min(a, b), Math.max(a, b) + 1);
  const vals = Object.fromEntries(rows.map((c) => [c, rioSingleStage(sic, stage, c)]));
  const tiers = Object.fromEntries(rows.map((c) => [c, tier(vals[c], c)]));
  const uniq = new Set(Object.values(tiers));
  const state = uniq.size === 1 && uniq.has("NORMAL") ? "stable-normal" : uniq.size === 1 ? "stable-nonnormal" : "flips";
  const lo = Math.min(...Object.values(vals)), hi = Math.max(...Object.values(vals));
  const speeds = rows.filter((c) => tiers[c] !== "NORMAL").map(speedLimitKn).filter(Boolean);
  return { rio_lo: lo, rio_hi: hi, state, rows, tiers, vals, speed_kn: speeds.length ? [Math.min(...speeds), Math.max(...speeds)] : null };
}

// ---------------------------------------------------------------------------
// Nine decision gates and route health  (isih/gates.py, isih/decision.py)
// ---------------------------------------------------------------------------
export const MARGINAL_BAND_PCT = 7.4; // one median CDR retrieval std-dev across 70-90% ice
export const BLOCKED_ON = {
  capability: "Polar Ship Certificate and PWOM for IMO 8723426",
  chart: "IHO ENC / GEBCO bathymetry loaded into the routing grid",
  weather: "ERA5 or CMEMS wind, wave and visibility fields over the corridor",
  traffic: "AIS feed or terrestrial/satellite traffic picture",
  communications: "GMDSS / satcom coverage and link-budget model for the corridor",
  execution: "live bridge sensor feed (GPS, radar, ice observation)",
};
export const GATE_ORDER = ["capability", "chart", "ice", "weather", "traffic", "logistics", "communications", "contingency", "execution"];

export function evaluateGates({ route, iceLimitPct, destName, destReachable, nAlternatives }) {
  const G = {};
  for (const k of ["capability", "chart", "weather", "traffic", "communications", "execution"]) {
    G[k] = { state: "UNKNOWN", reason: `No evidence held. Needs ${BLOCKED_ON[k]}.` };
  }
  G.capability.reason = `Ice limit and hull strength are not certificated for this ship. Needs ${BLOCKED_ON.capability}.`;
  G.chart.reason = `No bathymetry in the routing grid, so the 20 m minimum-depth rule has nothing to act on. Needs ${BLOCKED_ON.chart}.`;

  if (!route) {
    G.ice = { state: "FAIL", reason: `No route keeps under the ${iceLimitPct}% working limit for this departure.` };
  } else {
    const worst = route.worst * 100, margin = iceLimitPct - worst;
    if (route.overKm > 0) G.ice = { state: "FAIL", reason: `Forecast ice on arrival is above ${iceLimitPct}% for ${route.overKm.toFixed(0)} km of this track.`, failsInHours: route.firstOverHours };
    else if (margin <= MARGINAL_BAND_PCT) G.ice = { state: "MARGINAL", reason: `Ice reaches ${worst.toFixed(0)}%, within ${margin.toFixed(0)} points of the ${iceLimitPct}% limit. That is inside the retrieval's own uncertainty, and the limit itself is an assumption.` };
    else G.ice = { state: "PASS", reason: `Ice peaks at ${worst.toFixed(0)}%, ${margin.toFixed(0)} points below the working limit.` };
  }
  G.logistics = destReachable
    ? { state: "PASS", reason: `${destName} is reachable on this forecast.` }
    : { state: "FAIL", reason: `${destName} is not reachable for this ship on this forecast.` };
  G.contingency = nAlternatives >= 2 ? { state: "PASS", reason: `${nAlternatives} fallback corridors solve at tighter ice limits.` }
    : nAlternatives === 1 ? { state: "MARGINAL", reason: "Only one fallback corridor solves. Thin cover if the primary closes." }
    : { state: "FAIL", reason: "No fallback corridor solves at a tighter ice limit." };

  const rank = { VALID: 0, DEGRADED: 1, CRITICAL: 2, INVALID: 3 };
  let health = "VALID", binding = null;
  const levelOf = (g) => g.state === "FAIL" ? ((g.failsInHours || 0) > 0 ? "CRITICAL" : "INVALID")
    : (g.state === "MARGINAL" || g.state === "UNKNOWN") ? "DEGRADED" : "VALID";
  const order = { FAIL: 0, MARGINAL: 1, UNKNOWN: 2, PASS: 3 };
  for (const k of GATE_ORDER) {
    const l = levelOf(G[k]);
    if (rank[l] > rank[health]) health = l;
    if (!binding || order[G[k].state] < order[G[binding].state]) binding = k;
  }
  return { gates: G, health, binding };
}
