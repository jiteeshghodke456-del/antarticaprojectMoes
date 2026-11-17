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
    const v = values[i * g.nx + j];
    return v === 255 ? landColour : colour(v);
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
  const r = Math.max(3, Math.min(9, 2 + b.len_nm / 4));
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
