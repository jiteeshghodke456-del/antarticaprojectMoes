// Zoom and pan for the canvas chart.
//
// The chart is fitted to the free space first (Projection.fit); the view is a
// screen-space scale and translate applied on top of that fit:
//   screen = fitted * z + (tx, ty),  z in [1, ZMAX]
// so z = 1, t = 0 is exactly the fit-to-space state that "Reset view" returns to.
// Every drawing call goes through Projection.fwd/inv, so applying the view to
// the projection moves the ice field, overlays, routes, bergs, labels and the
// cursor readout together.
//
// Repainting the raster is the slow part, so during a gesture the last
// painted bitmap is moved with a CSS transform (exact for a scale+translate)
// and the vector overlay is redrawn every frame; the raster is repainted once
// the gesture settles.

export const ZMAX = 8;

export function createView({ proj, surface, base, onFrame, onSettle, onChange }) {
  const V = { z: 1, tx: 0, ty: 0 };
  let fit = null, painted = null, w = 0, h = 0, raf = 0, settle = 0;

  const clamp = () => {
    V.z = Math.min(ZMAX, Math.max(1, V.z));
    // The fitted frame [0,w]x[0,h] always covers the screen: no dragging the chart away.
    V.tx = Math.min(0, Math.max(w - w * V.z, V.tx));
    V.ty = Math.min(0, Math.max(h - h * V.z, V.ty));
  };
  const apply = () => {
    if (!fit) return;
    proj.s = fit.s * V.z; proj.cx = fit.cx * V.z + V.tx; proj.cy = fit.cy * V.z + V.ty;
  };
  const changed = () => {
    clamp(); apply();
    if (painted) {
      const k = V.z / painted.z;
      base.style.transform = `translate(${V.tx - painted.tx * k}px, ${V.ty - painted.ty * k}px) scale(${k})`;
    }
    cancelAnimationFrame(raf); raf = requestAnimationFrame(onFrame);
    clearTimeout(settle); settle = setTimeout(onSettle, 160);
    onChange?.(V.z);
  };

  const api = {
    get z() { return V.z; },
    key: () => `${V.z.toFixed(4)},${V.tx.toFixed(1)},${V.ty.toFixed(1)}`,
    // Called by drawChart after Projection.fit: remember the fit, re-apply the view.
    setFit(width, height) { w = width; h = height; fit = { s: proj.s, cx: proj.cx, cy: proj.cy }; clamp(); apply(); },
    markPainted() { painted = { ...V }; base.style.transform = ""; },
    zoomAt(px, py, factor) {
      const z1 = Math.min(ZMAX, Math.max(1, V.z * factor));
      const fx = (px - V.tx) / V.z, fy = (py - V.ty) / V.z;   // fitted coords under the cursor stay put
      V.z = z1; V.tx = px - fx * z1; V.ty = py - fy * z1; changed();
    },
    zoomCentre(factor) { api.zoomAt(w / 2, h / 2, factor); },
    panBy(dx, dy) { V.tx += dx; V.ty += dy; changed(); },
    reset() { V.z = 1; V.tx = 0; V.ty = 0; changed(); },
  };

  // ---- input: wheel, drag, double-click, pinch (pointer events cover mouse, pen and touch)
  const pt = (e) => { const r = surface.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  surface.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [x, y] = pt(e);
    api.zoomAt(x, y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)));
  }, { passive: false });
  surface.addEventListener("dblclick", (e) => { const [x, y] = pt(e); api.zoomAt(x, y, 2); });

  const ptrs = new Map(); let moved = 0, pinch = null;
  surface.addEventListener("pointerdown", (e) => {
    surface.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, pt(e)); moved = 0;
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; }
    surface.classList.add("grabbing");
  });
  surface.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId), now = pt(e); ptrs.set(e.pointerId, now);
    if (ptrs.size === 1) {
      moved += Math.abs(now[0] - prev[0]) + Math.abs(now[1] - prev[1]);
      if (moved > 3) api.panBy(now[0] - prev[0], now[1] - prev[1]);
    } else if (ptrs.size === 2 && pinch) {
      moved = 99;
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      V.tx += m[0] - pinch.m[0]; V.ty += m[1] - pinch.m[1];
      api.zoomAt(m[0], m[1], d / Math.max(1, pinch.d));
      pinch = { d, m };
    }
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) surface.classList.remove("grabbing"); };
  surface.addEventListener("pointerup", up);
  surface.addEventListener("pointercancel", up);
  // A click that ended a drag is not a click on the chart.
  surface.addEventListener("click", (e) => { if (moved > 3) e.stopImmediatePropagation(); }, true);

  return api;
}
