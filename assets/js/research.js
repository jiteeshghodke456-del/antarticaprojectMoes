// Research-grade field rendering for the Bridge chart.
//
// Renderer choices:
// - Colour fields are sampled per screen pixel through a cached pixel ->
//   (lat, lon) map (rebuilt only when the view changes), with NaN-aware
//   bilinear interpolation: a pixel whose nearest grid cell has no value
//   stays empty, so no layer is ever extended beyond its coverage.
// - Ramps are perceptual (cmocean-like stops, interpolated in RGB); the WMO
//   ice code classifies the interpolated concentration.
// - Vectors are seeded on a screen-space grid so their density is the same at
//   every zoom; streaklines integrate the current field (RK2) for a fixed
//   time that shrinks with zoom so their on-screen length stays constant.
// - Wind barbs follow the WMO convention in knots; feathers on the
//   Southern-Hemisphere side (counter-clockwise of the shaft).

// ------------------------------------------------------------------ data access
const cache = new Map();
export function loadBin(url) {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.arrayBuffer(); }));
  return cache.get(url);
}
export function loadJSON(url) {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }));
  return cache.get(url);
}
const TYPED = { uint8: Uint8Array, uint16: Uint16Array, int16: Int16Array, int8: Int8Array };

// A gridded variable: comp(k, lead) -> typed view of one 2-D slice.
export function gridField(meta, buf) {
  const T = TYPED[meta.dtype], g = meta.grid, n = g.ny * g.nx;
  const steps = meta.leads ?? meta.steps ?? 1, comps = meta.components ?? 1;
  const scale = Array.isArray(meta.scale) ? meta.scale : Array(comps).fill(meta.scale);
  return {
    g, steps, scale, nodata: meta.nodata, meta,
    slice: (comp, step) => new T(buf, (comp * steps + step) * n * T.BYTES_PER_ELEMENT, n),
  };
}

// NaN-aware bilinear sample of one slice. Returns NaN outside coverage or
// where the nearest cell has no value.
export function bilinear(g, a, nodata, scale, lat, lon) {
  const fi = (lat - g.lat0) / g.dlat, fj = (lon - g.lon0) / g.dlon;
  if (fi < -0.5 || fj < -0.5 || fi > g.ny - 0.5 || fj > g.nx - 0.5) return NaN;
  const ni = Math.min(g.ny - 1, Math.max(0, Math.round(fi))), nj = Math.min(g.nx - 1, Math.max(0, Math.round(fj)));
  if (a[ni * g.nx + nj] === nodata) return NaN;
  const i0 = Math.max(0, Math.min(g.ny - 2, Math.floor(fi))), j0 = Math.max(0, Math.min(g.nx - 2, Math.floor(fj)));
  const ti = Math.min(1, Math.max(0, fi - i0)), tj = Math.min(1, Math.max(0, fj - j0));
  let s = 0, w = 0;
  const add = (i, j, wt) => { const v = a[i * g.nx + j]; if (v !== nodata && wt > 0) { s += v * wt; w += wt; } };
  add(i0, j0, (1 - ti) * (1 - tj)); add(i0, j0 + 1, (1 - ti) * tj); add(i0 + 1, j0, ti * (1 - tj)); add(i0 + 1, j0 + 1, ti * tj);
  return w > 0 ? (s / w) * scale : NaN;
}

// ------------------------------------------------------------------ NSIDC EPSG:3412 (ellipsoidal polar stereographic, south)
// Snyder (1987) eq. 21-33/21-34 with the south-pole sign flip; Hughes 1980 ellipsoid, true scale at 70 S.
export function stereo3412(lat, lon, { a = 6378273, b = 6356889.449, lat_ts = -70, lon0 = 0 } = {}) {
  const e = Math.sqrt(1 - (b * b) / (a * a)), rad = Math.PI / 180;
  const p = -lat * rad, l = -(lon - lon0) * rad, pc = -lat_ts * rad;
  const t = (q) => Math.tan(Math.PI / 4 - q / 2) / Math.pow((1 - e * Math.sin(q)) / (1 + e * Math.sin(q)), e / 2);
  const mc = Math.cos(pc) / Math.sqrt(1 - e * e * Math.sin(pc) ** 2);
  const rho = (a * mc * t(p)) / t(pc);
  return [-(rho * Math.sin(l)), -(-rho * Math.cos(l))];
}

// ------------------------------------------------------------------ colour ramps
const RAMP = {
  // cmocean-like stops
  ice: [[4, 6, 19], [40, 46, 98], [58, 92, 158], [86, 148, 192], [148, 206, 220], [234, 253, 253]],
  dense: [[230, 241, 241], [160, 207, 224], [108, 157, 224], [104, 96, 207], [96, 45, 150], [54, 14, 36]],
  thermal: [[4, 35, 51], [23, 51, 122], [85, 59, 157], [129, 79, 143], [175, 95, 130], [222, 112, 100], [246, 149, 69], [251, 201, 63], [232, 250, 91]],
  speed: [[255, 253, 205], [210, 220, 140], [140, 190, 90], [72, 150, 70], [30, 100, 60], [23, 50, 35]],
  balance: [[24, 28, 67], [43, 77, 166], [96, 145, 196], [198, 219, 232], [241, 236, 235], [230, 182, 164], [201, 96, 70], [148, 26, 34], [60, 9, 18]],
  depth: [[214, 228, 238], [176, 200, 220], [140, 170, 200], [108, 140, 178], [84, 112, 152]],
};
export function ramp(name, t) {
  const s = RAMP[name], x = Math.min(1, Math.max(0, t)) * (s.length - 1), i = Math.min(s.length - 2, Math.floor(x)), f = x - i;
  return [0, 1, 2].map((c) => Math.round(s[i][c] + (s[i + 1][c] - s[i][c]) * f));
}
export const rampCSS = (name, n = 8) => `linear-gradient(90deg, ${Array.from({ length: n }, (_, k) => `rgb(${ramp(name, k / (n - 1))}) ${(100 * k / (n - 1)).toFixed(0)}%`).join(", ")})`;

// ------------------------------------------------------------------ pixel map and raster painting
let pm = null;
export function pixelMap(proj, w, h, key) {
  if (pm && pm.key === key) return pm;
  const W = Math.ceil(w), H = Math.ceil(h), lat = new Float32Array(W * H), lon = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [la, lo] = proj.inv(x + 0.5, y + 0.5); lat[y * W + x] = la; lon[y * W + x] = lo;
  }
  pm = { key, W, H, lat, lon, xy: null };
  return pm;
}
// Lazily add EPSG:3412 x/y per pixel (only the verification layers need it).
export function pixelXY(p, params) {
  if (p.xy) return p.xy;
  const n = p.W * p.H, x = new Float32Array(n), y = new Float32Array(n);
  for (let k = 0; k < n; k++) { const [a, b] = stereo3412(p.lat[k], p.lon[k], params); x[k] = a; y[k] = b; }
  return (p.xy = { x, y });
}

// colourAt(k, lat, lon) -> [r,g,b] or null (left transparent). Painted at
// CSS-pixel resolution then scaled to the device canvas with smoothing.
export function paintField(ctx, p, colourAt) {
  const img = new ImageData(p.W, p.H), d = img.data;
  for (let k = 0, n = p.W * p.H; k < n; k++) {
    const c = colourAt(k, p.lat[k], p.lon[k]);
    if (!c) continue;
    const o = k * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3] ?? 255;
  }
  const off = new OffscreenCanvas(p.W, p.H); off.getContext("2d").putImageData(img, 0, 0);
  ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(off, 0, 0, p.W, p.H); ctx.restore();
}

// ------------------------------------------------------------------ vector layers
const seeds = (w, h, step, jitter = 0) => {
  const out = [];
  for (let y = step / 2, r = 0; y < h; y += step, r++) for (let x = step / 2 + (r % 2) * step / 2, c = 0; x < w; x += step, c++) {
    if (!jitter) { out.push([x, y]); continue; }
    const hsh = Math.sin(r * 127.1 + c * 311.7) * 43758.5453; const fr = hsh - Math.floor(hsh);
    const hsh2 = Math.sin(r * 269.5 + c * 183.3) * 43758.5453; const fr2 = hsh2 - Math.floor(hsh2);
    out.push([x + (fr - 0.5) * step * jitter, y + (fr2 - 0.5) * step * jitter]);
  }
  return out;
};
// Screen direction of a geographic vector (east, north components) at a point.
function screenDir(proj, lat, lon, ue, vn) {
  const k = 0.01 / Math.max(1e-9, Math.hypot(ue, vn));
  const [x0, y0] = proj.fwd(lat, lon), [x1, y1] = proj.fwd(lat + vn * k, lon + (ue * k) / Math.cos(lat * Math.PI / 180));
  const L = Math.hypot(x1 - x0, y1 - y0) || 1;
  return [(x1 - x0) / L, (y1 - y0) / L, x0, y0];
}
function arrow(ctx, x0, y0, dx, dy, L, head = 4.5) {
  const x1 = x0 + dx * L, y1 = y0 + dy * L, a = Math.atan2(dy, dx);
  ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
  ctx.moveTo(x1 - head * Math.cos(a - 0.45), y1 - head * Math.sin(a - 0.45)); ctx.lineTo(x1, y1); ctx.lineTo(x1 - head * Math.cos(a + 0.45), y1 - head * Math.sin(a + 0.45));
}

// sample(lat, lon) -> [ue, vn] (m/s) or null. Length px = pxPerMs * speed, clamped.
export function drawArrowField(ctx, proj, w, h, sample, { step = 30, pxPerMs = 80, min = 5, max = 30, colour = "#0b2a45", halo = "rgba(255,255,255,0.85)", minSpeed = 0.01 } = {}) {
  const segs = [];
  for (const [x, y] of seeds(w, h, step)) {
    const [lat, lon] = proj.inv(x, y), s = sample(lat, lon); if (!s) continue;
    const sp = Math.hypot(s[0], s[1]); if (!(sp >= minSpeed)) continue;
    const [dx, dy] = screenDir(proj, lat, lon, s[0], s[1]);
    segs.push([x, y, dx, dy, Math.min(max, Math.max(min, sp * pxPerMs))]);
  }
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const [col, wd] of [[halo, 3.2], [colour, 1.3]]) {
    ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.beginPath();
    for (const [x, y, dx, dy, L] of segs) arrow(ctx, x - dx * L / 2, y - dy * L / 2, dx, dy, L);
    ctx.stroke();
  }
  ctx.restore();
}

// Direction-only arrows (bearing in degrees, direction of travel).
export function drawBearingField(ctx, proj, w, h, bearingAt, { step = 44, L = 16, colour = "#ffffff", halo = "rgba(10,20,40,0.8)" } = {}) {
  const segs = [];
  for (const [x, y] of seeds(w, h, step)) {
    const [lat, lon] = proj.inv(x, y), b = bearingAt(lat, lon); if (!Number.isFinite(b)) continue;
    const r = b * Math.PI / 180, [dx, dy] = screenDir(proj, lat, lon, Math.sin(r), Math.cos(r));
    segs.push([x, y, dx, dy]);
  }
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const [col, wd] of [[halo, 3.4], [colour, 1.5]]) {
    ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.beginPath();
    for (const [x, y, dx, dy] of segs) arrow(ctx, x - dx * L / 2, y - dy * L / 2, dx, dy, L, 5);
    ctx.stroke();
  }
  ctx.restore();
}

// Streaklines: RK2 in lat/lon over `seconds`, from jittered screen seeds.
export function drawStreaklines(ctx, proj, w, h, sample, { seconds, step = 20, n = 14, colourBy = null, mono = "rgba(12,26,44,0.75)" } = {}) {
  const dt = seconds / n, M = 111320;
  const vel = (lat, lon) => { const s = sample(lat, lon); return s && Number.isFinite(s[0]) ? s : null; };
  ctx.save(); ctx.lineCap = "round";
  for (const [x, y] of seeds(w, h, step, 0.9)) {
    let [lat, lon] = proj.inv(x, y);
    const s0 = vel(lat, lon); if (!s0) continue;
    const sp0 = Math.hypot(s0[0], s0[1]); if (sp0 < 0.005) continue;
    const pts = [proj.fwd(lat, lon)];
    for (let k = 0; k < n; k++) {
      const a = vel(lat, lon); if (!a) break;
      const cl = Math.cos(lat * Math.PI / 180);
      const mlat = lat + (a[1] * dt / 2) / M, mlon = lon + (a[0] * dt / 2) / (M * cl);
      const b = vel(mlat, mlon); if (!b) break;
      lat += (b[1] * dt) / M; lon += (b[0] * dt) / (M * Math.cos(mlat * Math.PI / 180));
      pts.push(proj.fwd(lat, lon));
    }
    if (pts.length < 3) continue;
    const col = colourBy ? colourBy(sp0) : null;
    for (let k = 1; k < pts.length; k++) {
      const t = k / (pts.length - 1);
      ctx.globalAlpha = 0.15 + 0.85 * t;
      ctx.strokeStyle = col ? `rgb(${col})` : mono; ctx.lineWidth = 0.8 + 1.0 * t;
      ctx.beginPath(); ctx.moveTo(pts[k - 1][0], pts[k - 1][1]); ctx.lineTo(pts[k][0], pts[k][1]); ctx.stroke();
    }
  }
  ctx.restore();
}

// WMO wind barbs, knots, rounded to 5 kt. Southern Hemisphere feathers.
export function drawBarbs(ctx, proj, w, h, sample, { step = 46, L = 24, colour = "#10151f", halo = "rgba(255,255,255,0.85)", skip = null } = {}) {
  const items = [];
  for (const [x, y] of seeds(w, h, step)) {
    const [lat, lon] = proj.inv(x, y); if (skip && skip(lat, lon)) continue;
    const s = sample(lat, lon); if (!s) continue;
    const kt = Math.round((Math.hypot(s[0], s[1]) * 1.943844) / 5) * 5;
    // shaft points to where the wind comes FROM
    const [dx, dy] = screenDir(proj, lat, lon, -s[0], -s[1]);
    items.push([x, y, dx, dy, kt]);
  }
  const draw = () => {
    ctx.beginPath();
    for (const [x, y, dx, dy, kt] of items) {
      if (kt < 5) { ctx.moveTo(x + 4, y); ctx.arc(x, y, 4, 0, Math.PI * 2); continue; }
      const tx = x + dx * L, ty = y + dy * L;
      ctx.moveTo(x, y); ctx.lineTo(tx, ty);
      const fx = dy, fy = -dx;                           // SH: counter-clockwise of the shaft
      let rest = kt, pos = 0;
      const at = (p) => [tx - dx * p, ty - dy * p];
      while (rest >= 50) { const [ax, ay] = at(pos), [bx, by] = at(pos + 6); ctx.moveTo(ax, ay); ctx.lineTo(ax + fx * 10 - dx * 3, ay + fy * 10 - dy * 3); ctx.lineTo(bx, by); pos += 7; rest -= 50; }
      while (rest >= 10) { const [ax, ay] = at(pos); ctx.moveTo(ax, ay); ctx.lineTo(ax + fx * 10 + dx * 3, ay + fy * 10 + dy * 3); pos += 4; rest -= 10; }
      if (rest >= 5) { if (pos === 0) pos = 4; const [ax, ay] = at(pos); ctx.moveTo(ax, ay); ctx.lineTo(ax + fx * 5 + dx * 1.5, ay + fy * 5 + dy * 1.5); }
    }
  };
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.strokeStyle = halo; ctx.lineWidth = 3; draw(); ctx.stroke();
  ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = 1.3; draw(); ctx.stroke();
  ctx.restore();
}

// Polylines given as [[lon, lat], ...].
export function drawPolylines(ctx, proj, lines, { colour, width = 1.5, dash = null, halo = null, widthOf = null } = {}) {
  ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
  const pass = (col, extra) => {
    for (const L of lines) {
      ctx.strokeStyle = col; ctx.lineWidth = (widthOf ? widthOf(L) : width) + extra; ctx.setLineDash(dash || []);
      ctx.beginPath(); L.c.forEach(([lo, la], k) => { const [x, y] = proj.fwd(la, lo); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
    }
  };
  if (halo) pass(halo, 2.2);
  pass(colour, 0);
  ctx.restore();
}

let hatchPat = null;
export function drawHatchedQuads(ctx, proj, quads, colour = "rgba(20,20,20,0.75)") {
  if (!hatchPat) {
    const c = new OffscreenCanvas(7, 7), h = c.getContext("2d"); h.strokeStyle = colour; h.lineWidth = 1.2;
    h.beginPath(); h.moveTo(0, 7); h.lineTo(7, 0); h.moveTo(-1, 1); h.lineTo(1, -1); h.moveTo(6, 8); h.lineTo(8, 6); h.stroke();
    hatchPat = ctx.createPattern(c, "repeat");
  }
  ctx.save(); ctx.fillStyle = hatchPat; ctx.strokeStyle = "rgba(20,20,20,0.6)"; ctx.lineWidth = 0.8; ctx.beginPath();
  for (const q of quads) { q.forEach(([la, lo], k) => { const [x, y] = proj.fwd(la, lo); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); }
  ctx.fill(); ctx.stroke(); ctx.restore();
}
