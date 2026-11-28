/* hammi.ca PCB: geometry helpers shared by the router, DRC and exporters.
   All board units are millimetres, y grows downward (screen style). */
(function (P) {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function distPtSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = clamp(t, 0, 1);
    const x = ax + t * dx - px, y = ay + t * dy - py;
    return Math.sqrt(x * x + y * y);
  }

  function orient(ax, ay, bx, by, cx, cy) { return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); }
  function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = orient(cx, cy, dx, dy, ax, ay), d2 = orient(cx, cy, dx, dy, bx, by);
    const d3 = orient(ax, ay, bx, by, cx, cy), d4 = orient(ax, ay, bx, by, dx, dy);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function distSegSeg(ax, ay, bx, by, cx, cy, dx, dy) {
    if (segsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
    return Math.min(distPtSeg(ax, ay, cx, cy, dx, dy), distPtSeg(bx, by, cx, cy, dx, dy),
      distPtSeg(cx, cy, ax, ay, bx, by), distPtSeg(dx, dy, ax, ay, bx, by));
  }

  function distPtRect(px, py, cx, cy, hw, hh) {
    const dx = Math.abs(px - cx) - hw, dy = Math.abs(py - cy) - hh;
    if (dx <= 0 && dy <= 0) return Math.max(dx, dy); // negative inside
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  }
  function segHitsRect(ax, ay, bx, by, cx, cy, hw, hh) {
    // Liang-Barsky clip
    let t0 = 0, t1 = 1; const dx = bx - ax, dy = by - ay;
    const p = [-dx, dx, -dy, dy], q = [ax - (cx - hw), (cx + hw) - ax, ay - (cy - hh), (cy + hh) - ay];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return false; }
      else { const r = q[i] / p[i]; if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } }
    }
    return true;
  }
  function distSegRect(ax, ay, bx, by, cx, cy, hw, hh) {
    if (segHitsRect(ax, ay, bx, by, cx, cy, hw, hh)) return 0;
    const x0 = cx - hw, x1 = cx + hw, y0 = cy - hh, y1 = cy + hh;
    return Math.min(
      Math.max(0, distPtRect(ax, ay, cx, cy, hw, hh)), Math.max(0, distPtRect(bx, by, cx, cy, hw, hh)),
      distPtSeg(x0, y0, ax, ay, bx, by), distPtSeg(x1, y0, ax, ay, bx, by),
      distPtSeg(x0, y1, ax, ay, bx, by), distPtSeg(x1, y1, ax, ay, bx, by));
  }

  /* Shapes: {k:'cap', ax,ay,bx,by,r} (circle, oval, trace, via) or {k:'rect', cx,cy,hw,hh} */
  function cap(ax, ay, bx, by, r) { return { k: 'cap', ax, ay, bx, by, r }; }
  function rect(cx, cy, hw, hh) { return { k: 'rect', cx, cy, hw, hh }; }

  function ptShapeDist(px, py, s) {
    if (s.k === 'cap') return distPtSeg(px, py, s.ax, s.ay, s.bx, s.by) - s.r;
    return distPtRect(px, py, s.cx, s.cy, s.hw, s.hh);
  }
  function shapeDist(a, b) {
    if (a.k === 'cap' && b.k === 'cap') return distSegSeg(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by) - a.r - b.r;
    if (a.k === 'rect' && b.k === 'rect') {
      const dx = Math.abs(a.cx - b.cx) - a.hw - b.hw, dy = Math.abs(a.cy - b.cy) - a.hh - b.hh;
      if (dx <= 0 && dy <= 0) return Math.max(dx, dy);
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    }
    const c = a.k === 'cap' ? a : b, r = a.k === 'cap' ? b : a;
    return distSegRect(c.ax, c.ay, c.bx, c.by, r.cx, r.cy, r.hw, r.hh) - c.r;
  }
  function shapeBox(s) {
    if (s.k === 'cap') return [Math.min(s.ax, s.bx) - s.r, Math.min(s.ay, s.by) - s.r, Math.max(s.ax, s.bx) + s.r, Math.max(s.ay, s.by) + s.r];
    return [s.cx - s.hw, s.cy - s.hh, s.cx + s.hw, s.cy + s.hh];
  }

  /* Pad (absolute, already rotated: w is x size, h is y size) to shape */
  function padShape(p, grow) {
    grow = grow || 0;
    const w = p.w + 2 * grow, h = p.h + 2 * grow;
    if (p.shape === 'rect') return rect(p.x, p.y, w / 2, h / 2);
    if (p.shape === 'circle' || Math.abs(w - h) < 1e-9) return cap(p.x, p.y, p.x, p.y, Math.min(w, h) / 2);
    if (w > h) return cap(p.x - (w - h) / 2, p.y, p.x + (w - h) / 2, p.y, h / 2);
    return cap(p.x, p.y - (h - w) / 2, p.x, p.y + (h - w) / 2, w / 2);
  }

  /* Rounded-rectangle board: signed distance, negative inside */
  function sdBoard(px, py, b) {
    const r = Math.min(b.r || 0, b.w / 2, b.h / 2);
    const qx = Math.abs(px - b.w / 2) - (b.w / 2 - r), qy = Math.abs(py - b.h / 2) - (b.h / 2 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }
  function boardOutline(b, segsPerCorner) {
    const r = Math.min(b.r || 0, b.w / 2, b.h / 2), n = r > 0 ? (segsPerCorner || 12) : 0, pts = [];
    const corners = [[b.w - r, r, -90], [b.w - r, b.h - r, 0], [r, b.h - r, 90], [r, r, 180]];
    for (const [cx, cy, a0] of corners) {
      if (!n) { pts.push([cx, cy]); continue; }
      for (let i = 0; i <= n; i++) { const a = (a0 + 90 * i / n) * Math.PI / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    }
    pts.push(pts[0].slice());
    return pts;
  }

  function rotPt(x, y, rot) {
    switch (((rot % 360) + 360) % 360) {
      case 90: return [-y, x];
      case 180: return [-x, -y];
      case 270: return [y, -x];
      default: return [x, y];
    }
  }

  P.geom = { clamp, distPtSeg, distSegSeg, distPtRect, distSegRect, cap, rect, ptShapeDist, shapeDist, shapeBox, padShape, sdBoard, boardOutline, rotPt };
})(globalThis.PCB = globalThis.PCB || {});
