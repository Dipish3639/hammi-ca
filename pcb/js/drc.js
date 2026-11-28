/* hammi.ca PCB: design-rule check on the real geometry (not the router grid). */
(function (P) {
  'use strict';
  const M = P.model, G = P.geom;

  function drc(pr) {
    const R = pr.rules, b = pr.board, out = [];
    const add = (sev, code, msg, x, y) => out.push({ sev, code, msg, x, y });
    const nets = M.computeNets(pr), info = M.boardPads(pr, nets);
    const conn = M.connectivity(pr, info), items = conn.items;
    const label = it => it.t === 'pad' ? it.ref.ref + ' pad ' + it.ref.n : it.t === 'via' ? 'via (' + it.net + ')' : 'trace (' + it.net + ')';
    const mid = (a, b) => { const A = G.shapeBox(a.s), B = G.shapeBox(b.s); return [(Math.max(A[0], B[0]) + Math.min(A[2], B[2])) / 2, (Math.max(A[1], B[1]) + Math.min(A[3], B[3])) / 2]; };

    // 1. copper to copper
    let pairs = 0;
    M.nearPairs(items, R.clearance, (i, j) => {
      const A = items[i], B = items[j];
      if (!A.layers.some(l => B.layers.includes(l))) return;
      if (A.net && A.net === B.net) return;
      if (A.t === 'pad' && B.t === 'pad' && A.ref.pid === B.ref.pid && A.ref.pin === B.ref.pin) return;
      pairs++;
      const d = G.shapeDist(A.s, B.s);
      if (d < R.clearance - 1e-3) {
        const [x, y] = mid(A, B);
        if (d <= 1e-4) add('error', 'short', 'Short: ' + label(A) + ' touches ' + label(B), x, y);
        else add('error', 'clearance', 'Clearance ' + d.toFixed(3) + ' mm < ' + R.clearance + ' mm: ' + label(A) + ' / ' + label(B), x, y);
      }
    });

    // 2. copper to board edge
    for (const it of items) {
      const s = it.s; let worst = -1e9, wx = 0, wy = 0;
      const test = (x, y, r) => { const v = G.sdBoard(x, y, b) + r; if (v > worst) { worst = v; wx = x; wy = y; } };
      if (s.k === 'cap') { const L = Math.hypot(s.bx - s.ax, s.by - s.ay), n = Math.max(1, Math.ceil(L / .2)); for (let i = 0; i <= n; i++) test(s.ax + (s.bx - s.ax) * i / n, s.ay + (s.by - s.ay) * i / n, s.r); }
      else for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) test(s.cx + dx * s.hw, s.cy + dy * s.hh, 0);
      if (worst > -R.edge + 1e-3) add('error', 'edge', (worst > 0 ? 'Off the board: ' : 'Too close to the board edge: ') + label(it), wx, wy);
    }

    // 3. drills
    const drills = [];
    for (const p of info.pads) if (p.drill) {
      drills.push({ x: p.x, y: p.y, d: p.drill, what: p.ref + ' pad ' + p.n });
      const ring = (Math.min(p.w, p.h) - p.drill) / 2;
      if (ring < R.ring - 1e-6) add('warn', 'ring', 'Thin annular ring ' + ring.toFixed(2) + ' mm on ' + p.ref + ' pad ' + p.n, p.x, p.y);
    }
    for (const v of pr.vias) { drills.push({ x: v.x, y: v.y, d: v.drill || R.viaDrill, what: 'via' }); if (((v.d || R.via) - (v.drill || R.viaDrill)) / 2 < R.ring - 1e-6) add('warn', 'ring', 'Thin via ring', v.x, v.y); }
    for (const h of info.holes) {
      drills.push({ x: h.x, y: h.y, d: h.d, what: h.ref + ' hole', np: true });
      const s = G.cap(h.x, h.y, h.x, h.y, h.d / 2);
      for (const it of items) if (G.shapeDist(s, it.s) < R.clearance - 1e-3) add('error', 'hole', 'Copper too close to ' + h.ref + ' hole: ' + label(it), h.x, h.y);
      if (G.sdBoard(h.x, h.y, b) + h.d / 2 > -R.edge) add('error', 'edge', h.ref + ' hole too close to the board edge', h.x, h.y);
    }
    for (const d of drills) if (d.d < R.minDrill - 1e-6) add('error', 'drill', 'Drill ' + d.d + ' mm is below the ' + R.minDrill + ' mm minimum (' + d.what + ')', d.x, d.y);
    for (let i = 0; i < drills.length; i++) for (let j = i + 1; j < drills.length; j++) {
      const a = drills[i], c = drills[j], gapd = Math.hypot(a.x - c.x, a.y - c.y) - a.d / 2 - c.d / 2;
      if (gapd < 0.25 && !(gapd < -a.d && a.what === c.what)) add('error', 'drill', 'Holes too close (' + gapd.toFixed(2) + ' mm): ' + a.what + ' / ' + c.what, (a.x + c.x) / 2, (a.y + c.y) / 2);
    }

    // 4. traces
    for (const t of pr.traces) if ((t.w || R.trace) < 0.127) add('error', 'width', 'Trace narrower than 0.127 mm', t.pts[0][0], t.pts[0][1]);

    // 5. parts on the board and not on top of each other
    const boxes = [];
    for (const p of pr.parts) {
      const bb = M.partBox(p, 0); if (!bb) continue;
      const inside = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].every(([x, y]) => G.sdBoard(x, y, b) <= 0);
      if (!inside) add('error', 'outside', p.ref + ' is not fully on the board', (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2);
      boxes.push([p, bb]);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i][1], B = boxes[j][1], ov = Math.min(A[2], B[2]) - Math.max(A[0], B[0]), oh = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
      if (ov > 0.2 && oh > 0.2) add('warn', 'overlap', boxes[i][0].ref + ' and ' + boxes[j][0].ref + ' overlap', (Math.max(A[0], B[0]) + Math.min(A[2], B[2])) / 2, (Math.max(A[1], B[1]) + Math.min(A[3], B[3])) / 2);
    }

    // 6. everything connected?
    const rats = M.ratsnest(pr, info, conn);
    const openByNet = new Map(); for (const l of rats.lines) { if (!openByNet.has(l.net)) openByNet.set(l.net, l); }
    for (const [net, l] of openByNet) {
      const n = rats.lines.filter(x => x.net === net).length;
      add('error', 'unrouted', 'Not connected: net ' + net + ' (' + n + ' link' + (n > 1 ? 's' : '') + ' missing)', (l.a.x + l.b.x) / 2, (l.a.y + l.b.y) / 2);
    }

    // 7. dangling copper that belongs to no pad
    const compHasPad = new Set(); conn.items.forEach((it, i) => { if (it.t === 'pad') compHasPad.add(conn.comp[i]); });
    const dang = new Set(); conn.items.forEach((it, i) => { if (it.t !== 'pad' && !compHasPad.has(conn.comp[i]) && !dang.has(conn.comp[i])) { dang.add(conn.comp[i]); add('warn', 'dangling', 'Loose copper not attached to any pad (' + it.net + ')', it.s.ax, it.s.ay); } });

    const nNets = [...nets.nets.values()].filter(v => v.length >= 2).length;
    return { list: out, errors: out.filter(x => x.sev === 'error').length, warnings: out.filter(x => x.sev === 'warn').length, open: rats.open, nets: nNets, pairs };
  }

  P.drc = { run: drc };
})(globalThis.PCB = globalThis.PCB || {});
