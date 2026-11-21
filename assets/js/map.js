// South polar stereographic chart drawn on a canvas. No tiles, no CDN:
// everything on the chart comes from files in /data.

// WMO total-concentration colour code (WMO/TD-No. 1215, JCOMM TR-24).
export const WMO = [
  { max: 0.5, rgb: [219, 232, 242], label: "Ice free" },
  { max: 10, rgb: [150, 200, 255], label: "<1/10" },
  { max: 35, rgb: [140, 255, 160], label: "1–3/10" },
  { max: 65, rgb: [255, 255, 0], label: "4–6/10" },
  { max: 85, rgb: [255, 125, 7], label: "7–8/10" },
  { max: 101, rgb: [255, 0, 0], label: "9–10/10" },
];
const LAND = [231, 220, 184];
const OUTSIDE = [236, 241, 244];
export function wmoColour(pct) { for (const c of WMO) if (pct < c.max) return c.rgb; return WMO[WMO.length - 1].rgb; }

export class Projection {
  constructor(lon0 = 45) { this.lon0 = lon0; this.s = 1; this.cx = 0; this.cy = 0; }
  raw(lat, lon) {
    const r = Math.tan((90 + lat) * Math.PI / 360);
    const t = (lon - this.lon0) * Math.PI / 180;
    return [r * Math.sin(t), r * Math.cos(t)];
  }
  fwd(lat, lon) { const [X, Y] = this.raw(lat, lon); return [this.cx + this.s * X, this.cy - this.s * Y]; }
  inv(x, y) {
    const X = (x - this.cx) / this.s, Y = (this.cy - y) / this.s;
    const r = Math.hypot(X, Y);
    return [2 * Math.atan(r) * 180 / Math.PI - 90, this.lon0 + Math.atan2(X, Y) * 180 / Math.PI];
  }
  fit(box, w, h, pad = 24) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let la = box.lat0; la <= box.lat1 + 1e-9; la += (box.lat1 - box.lat0) / 20)
      for (let lo = box.lon0; lo <= box.lon1 + 1e-9; lo += (box.lon1 - box.lon0) / 20) {
        const [X, Y] = this.raw(la, lo);
        x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
      }
    this.s = Math.min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0));
    this.cx = w / 2 - this.s * (x0 + x1) / 2;
    this.cy = h / 2 + this.s * (y0 + y1) / 2;
  }
}

export function setupCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height, dpr };
}

// Paint a gridded field. sample(lat, lon) returns [r,g,b] or null (outside grid).
export function paintRaster(ctx, proj, w, h, dpr, sample) {
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  const img = ctx.createImageData(W, H); const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [lat, lon] = proj.inv(x / dpr, y / dpr);
      const c = sample(lat, lon) || OUTSIDE;
      const k = (y * W + x) * 4; d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = 255;
    }
  }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.putImageData(img, 0, 0); ctx.restore();
}

export function gridSampler(g, values, colour, landColour = LAND) {
  return (lat, lon) => {
    const i = Math.round((lat - g.lat0) / g.dlat), j = Math.round((lon - g.lon0) / g.dlon);
    if (i < 0 || j < 0 || i >= g.ny || j >= g.nx) return null;
    const k = i * g.nx + j, v = values[k];
    return v === 255 ? landColour : colour(v, k);
  };
}

export function drawGraticule(ctx, proj, box) {
  ctx.save(); ctx.strokeStyle = "rgba(18,48,77,0.22)"; ctx.lineWidth = 0.7; ctx.fillStyle = "rgba(18,48,77,0.6)"; ctx.font = "11px 'Atkinson Hyperlegible', sans-serif";
  for (let la = Math.ceil(box.lat0 / 5) * 5; la <= box.lat1; la += 5) {
    ctx.beginPath();
    for (let lo = box.lon0; lo <= box.lon1; lo += 1) { const [x, y] = proj.fwd(la, lo); lo === box.lon0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
    const [x, y] = proj.fwd(la, box.lon0); ctx.fillText(`${-la}°S`, x + 4, y - 3);
  }
  for (let lo = Math.ceil(box.lon0 / 10) * 10; lo <= box.lon1; lo += 10) {
    ctx.beginPath();
    for (let la = box.lat0; la <= box.lat1; la += 0.5) { const [x, y] = proj.fwd(la, lo); la === box.lat0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
    const [x, y] = proj.fwd(box.lat1, lo); ctx.fillText(`${lo}°E`, x - 12, y - 5);
  }
  ctx.restore();
}

export function drawLand(ctx, proj, rings, { fill = "rgb(231,220,184)", stroke = "rgba(90,70,30,0.7)" } = {}) {
  ctx.save(); ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 0.8;
  for (const ring of rings) {
    ctx.beginPath();
    ring.forEach(([lon, lat], k) => { const [x, y] = proj.fwd(lat, lon); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath(); if (fill) ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

export function drawLine(ctx, proj, latlons, { colour = "#a3156f", width = 3, dash = null, halo = true } = {}) {
  if (!latlons || latlons.length < 2) return;
  const pts = latlons.map(([la, lo]) => proj.fwd(la, lo));
  const path = () => { ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
  ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (halo) { path(); ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = width + 3; ctx.setLineDash(dash || []); ctx.stroke(); }
  path(); ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.stroke();
  ctx.restore();
}

export function drawMarker(ctx, proj, lat, lon, label, { shape = "dot", colour = "#12304d", align = "right" } = {}) {
  const [x, y] = proj.fwd(lat, lon);
  ctx.save(); ctx.fillStyle = colour; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
  ctx.beginPath();
  if (shape === "ship") { ctx.moveTo(x, y - 8); ctx.lineTo(x + 6, y + 6); ctx.lineTo(x, y + 3); ctx.lineTo(x - 6, y + 6); ctx.closePath(); }
  else if (shape === "square") ctx.rect(x - 5, y - 5, 10, 10);
  else ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.stroke(); ctx.fill();
  if (label) {
    ctx.font = "700 12.5px 'Atkinson Hyperlegible', sans-serif"; ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(255,255,255,0.95)";
    const tx = align === "left" ? x - 9 - ctx.measureText(label).width : x + 9;
    ctx.strokeText(label, tx, y + 4); ctx.fillStyle = "#12304d"; ctx.fillText(label, tx, y + 4);
  }
  ctx.restore();
}

export function drawBerg(ctx, proj, b, near) {
  const [x, y] = proj.fwd(b.lat, b.lon);
  const r = Math.max(3, Math.min(9, 2 + b.len_nm / 4));  // marker size from USNIC long axis, nm
  ctx.save(); ctx.fillStyle = near ? "#b3261e" : "#ffffff"; ctx.strokeStyle = "#12304d"; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.font = "11.5px 'Atkinson Hyperlegible', sans-serif"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.strokeText(b.name, x + r + 3, y + 4); ctx.fillStyle = "#12304d"; ctx.fillText(b.name, x + r + 3, y + 4);
  ctx.restore();
}

export function drawArrows(ctx, proj, g, U, V, lead) {
  const n = g.ny * g.nx, off = lead * n;
  ctx.save(); ctx.strokeStyle = "rgba(18,48,77,0.75)"; ctx.lineWidth = 1.1;
  for (let i = 0; i < g.ny; i++) for (let j = 0; j < g.nx; j += 1) {
    const u = U[off + i * g.nx + j], v = V[off + i * g.nx + j];
    if (u === -128 || v === -128) continue;
    const sp = Math.hypot(u, v); if (sp < 2) continue;
    const lat = g.lat0 + g.dlat * i, lon = g.lon0 + g.dlon * j;
    const [x0, y0] = proj.fwd(lat, lon);
    // displacement in degrees for a fixed visual length scaled by speed (cm/s)
    const k = 0.035 * Math.min(sp, 40) / sp;
    const [x1, y1] = proj.fwd(lat + v * k, lon + (u * k) / Math.cos(lat * Math.PI / 180));
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - 4 * Math.cos(a - 0.5), y1 - 4 * Math.sin(a - 0.5));
    ctx.moveTo(x1, y1); ctx.lineTo(x1 - 4 * Math.cos(a + 0.5), y1 - 4 * Math.sin(a + 0.5)); ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- weather and depth layers
// Wave ramp. Bins are tied to the weather gate so the chart and the gate say
// the same thing: blues below the marginal band, amber inside it, reds above
// the assumed limit. limit and band come from data/static.json gate_rules.
export function waveBins(limit, band) {
  return [
    { max: 1, rgb: [214, 230, 244], label: "<1 m" },
    { max: 2, rgb: [150, 190, 228], label: "1–2" },
    { max: limit - band, rgb: [84, 132, 196], label: `2–${limit - band}`, dark: true },
    { max: limit, rgb: [232, 176, 72], label: `${limit - band}–${limit}` },
    { max: limit + 1, rgb: [206, 84, 62], label: `${limit}–${limit + 1}`, dark: true, limit: true },
    { max: limit + 2, rgb: [158, 40, 40], label: `${limit + 1}–${limit + 2}`, dark: true },
    { max: Infinity, rgb: [96, 20, 34], label: `>${limit + 2} m`, dark: true },
  ];
}
export const WAVE_ICE = [241, 244, 246];   // under ice the wave model writes no value
export function waveColour(bins, m) { for (const b of bins) if (m <= b.max) return b.rgb; return bins[bins.length - 1].rgb; }

// Arrows from a regular lat/lon grid of int8 components. scale: units per value (m/s per step).
export function drawVectors(ctx, proj, g, U, V, lead, { scale = 1, stride = 1, colour = "rgba(90,42,130,0.85)", minSpeed = 0, lenPerUnit = 0.035, cap = 40, nan = -128, skip = null } = {}) {
  const n = g.ny * g.nx, off = lead * n;
  ctx.save(); ctx.strokeStyle = colour; ctx.lineWidth = 1.2; ctx.lineCap = "round";
  for (let i = 0; i < g.ny; i += stride) for (let j = 0; j < g.nx; j += stride) {
    const a = U[off + i * g.nx + j], b = V[off + i * g.nx + j];
    if (a === nan || b === nan) continue;
    const u = a * scale, v = b * scale, sp = Math.hypot(u, v); if (sp < minSpeed || sp === 0) continue;
    const lat = g.lat0 + g.dlat * i, lon = g.lon0 + g.dlon * j;
    if (skip && skip(lat, lon)) continue;
    const [x0, y0] = proj.fwd(lat, lon);
    const k = lenPerUnit * Math.min(sp, cap) / sp;
    const [x1, y1] = proj.fwd(lat + v * k, lon + (u * k) / Math.cos(lat * Math.PI / 180));
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const t = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath(); ctx.moveTo(x1 - 4.5 * Math.cos(t - 0.5), y1 - 4.5 * Math.sin(t - 0.5)); ctx.lineTo(x1, y1);
    ctx.lineTo(x1 - 4.5 * Math.cos(t + 0.5), y1 - 4.5 * Math.sin(t + 0.5)); ctx.stroke();
  }
  ctx.restore();
}

let hatchPattern = null;
function hatch(ctx) {
  if (hatchPattern) return hatchPattern;
  const c = document.createElement("canvas"); c.width = c.height = 6;
  const h = c.getContext("2d"); h.strokeStyle = "rgba(91,70,48,0.85)"; h.lineWidth = 1.2;
  h.beginPath(); h.moveTo(0, 6); h.lineTo(6, 0); h.moveTo(-1, 1); h.lineTo(1, -1); h.moveTo(5, 7); h.lineTo(7, 5); h.stroke();
  return (hatchPattern = ctx.createPattern(c, "repeat"));
}
// Hatch every depth block whose shallowest point is under minDepth (land blocks skipped: the coast is drawn already).
export function drawShallow(ctx, proj, g, D, minDepth, LAND = 32767) {
  ctx.save(); ctx.fillStyle = hatch(ctx); ctx.beginPath();
  const hy = g.dlat / 2, hx = g.dlon / 2;
  for (let i = 0; i < g.ny; i++) for (let j = 0; j < g.nx; j++) {
    const e = D[i * g.nx + j]; if (e === LAND || e <= -minDepth) continue;
    const la = g.lat0 + g.dlat * i, lo = g.lon0 + g.dlon * j;
    const p = [[la - hy, lo - hx], [la - hy, lo + hx], [la + hy, lo + hx], [la + hy, lo - hx]].map(([a, b]) => proj.fwd(a, b));
    ctx.moveTo(p[0][0], p[0][1]); for (let k = 1; k < 4; k++) ctx.lineTo(p[k][0], p[k][1]); ctx.closePath();
  }
  ctx.fill(); ctx.restore();
}
export function drawIsobaths(ctx, proj, lines, levels) {
  ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const pass of ["halo", "line"]) for (const L of lines) {
    const w = L.m === levels[0] ? 1.6 : L.m === levels[1] ? 1.3 : 1;
    ctx.setLineDash(L.m === levels[levels.length - 1] ? [5, 4] : []);
    ctx.lineWidth = pass === "halo" ? w + 2 : w;
    ctx.strokeStyle = pass === "halo" ? "rgba(255,255,255,0.55)" : "rgba(18,48,77,0.9)";
    ctx.beginPath();
    L.c.forEach(([lon, lat], k) => { const [x, y] = proj.fwd(lat, lon); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.restore();
}

// A circle of radiusKm around a point, as a ring of lat/lon points so the
// projection bends it correctly.
export function drawRing(ctx, proj, lat, lon, radiusKm, { stroke = "rgba(18,48,77,0.85)", fill = "rgba(18,48,77,0.07)" } = {}) {
  if (!(radiusKm > 0)) return;
  const dLat = radiusKm / 111.32, dLon = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
  ctx.save(); ctx.beginPath();
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * Math.PI * 2; const [x, y] = proj.fwd(lat + dLat * Math.cos(a), lon + dLon * Math.sin(a));
    k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.setLineDash([4, 3]); ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.restore();
}
