/* hammi.ca PCB: automatic placement.
   Greedy cluster growth (most connected part first, then whichever part
   has the most links to parts already down), tried at every grid spot and
   all four rotations, then two clean-up passes. Connectors prefer the board
   edge and mounting holes go in the corners. Optionally sizes the board. */
(function (P) {
  'use strict';
  const M = P.model, G = P.geom;

  function autoplace(pr, opt) {
    opt = opt || {};
    const b = pr.board, R = pr.rules, step = 1.27, gap = opt.gap != null ? opt.gap : 1.0;
    const nets = M.computeNets(pr);
    const parts = pr.parts.filter(p => M.footprintOf(p));
    const holes = parts.filter(p => p.type === 'MH' && !p.locked);
    const movers = parts.filter(p => p.type !== 'MH' && !p.locked);
    const fixed = parts.filter(p => p.locked);
    const edgeM = Math.max(R.edge + .6, 1.2);

    // local geometry per rotation
    const geo = new Map();
    for (const p of parts) {
      const f = M.footprintOf(p), rots = {};
      for (const rot of [0, 90, 180, 270]) {
        const tmp = Object.assign({}, p, { bx: 0, by: 0, brot: rot });
        const bb = M.partBox(tmp, 0);
        if (p.type !== 'MH') bb[1] -= R.text + 0.6;
        const pins = f.pads.map(pd => { const [x, y] = G.rotPt(pd.x, pd.y, rot); return { net: nets.byKey.get(p.id + ':' + pd.pin) || null, x, y }; });
        rots[rot] = { bb, pins };
      }
      geo.set(p.id, rots);
    }
    const degree = p => geo.get(p.id)[0].pins.filter(q => q.net).length;
    const isConn = p => p.type === 'J' || p.type === 'JT';

    function attempt(W, H) {
      const placed = []; // {p, x, y, rot, box}
      const netPts = new Map();
      const addNet = (pl) => { for (const q of geo.get(pl.p.id)[pl.rot].pins) if (q.net) { if (!netPts.has(q.net)) netPts.set(q.net, []); netPts.get(q.net).push([pl.x + q.x, pl.y + q.y, pl.p.id]); } };
      const rmNet = (pl) => { for (const [, list] of netPts) for (let i = list.length - 1; i >= 0; i--) if (list[i][2] === pl.p.id) list.splice(i, 1); };
      for (const p of fixed) { const box = M.partBox(p, gap / 2); const pl = { p, x: p.bx, y: p.by, rot: p.brot || 0, box }; placed.push(pl); addNet(pl); }
      const holeIn = holes.length ? Math.max(3.5, ...holes.map(h => (M.footprintOf(h).holes[0].d / 2) + 2)) : 0;
      const corners = [[holeIn, holeIn], [W - holeIn, holeIn], [W - holeIn, H - holeIn], [holeIn, H - holeIn]];
      holes.forEach((p, i) => { const [x, y] = corners[i % 4]; const pl = { p, x, y, rot: 0, box: null }; pl.box = boxAt(p, x, y, 0); placed.push(pl); });

      function boxAt(p, x, y, rot) { const bb = geo.get(p.id)[rot].bb; return [x + bb[0] - gap / 2, y + bb[1] - gap / 2, x + bb[2] + gap / 2, y + bb[3] + gap / 2]; }
      function fits(box, self) {
        if (box[0] < edgeM - gap / 2 || box[1] < edgeM - gap / 2 || box[2] > W - edgeM + gap / 2 || box[3] > H - edgeM + gap / 2) return false;
        for (const q of placed) { if (q === self) continue; const o = q.box; if (box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1]) return false; }
        return true;
      }
      function cost(p, x, y, rot) {
        let c = 0, any = false;
        for (const q of geo.get(p.id)[rot].pins) {
          if (!q.net) continue; const list = netPts.get(q.net); if (!list) continue;
          let bd = 1e9; const px = x + q.x, py = y + q.y;
          for (const t of list) if (t[2] !== p.id) { const d = Math.abs(t[0] - px) + Math.abs(t[1] - py); if (d < bd) bd = d; }
          if (bd < 1e9) { c += bd; any = true; }
        }
        c += 0.04 * (Math.abs(x - W / 2) + Math.abs(y - H / 2));
        if (isConn(p)) { const bx = boxAt(p, x, y, rot); c += 0.9 * Math.min(bx[0], bx[1], W - bx[2], H - bx[3]); }
        if (p.type === 'NANO') { const [ux, uy] = G.rotPt(0, 22.6, rot); c += 1.5 * Math.min(Math.abs(x + ux), Math.abs(y + uy), Math.abs(W - x - ux), Math.abs(H - y - uy)); }
        return c;
      }
      function best(p, self) {
        let bc = 1e18, bp = null;
        for (const rot of [0, 90, 180, 270]) {
          for (let y = Math.ceil(edgeM / step) * step; y <= H - edgeM + 1e-9; y += step) for (let x = Math.ceil(edgeM / step) * step; x <= W - edgeM + 1e-9; x += step) {
            const box = boxAt(p, x, y, rot); if (!fits(box, self)) continue;
            const c = cost(p, x, y, rot) + (rot ? 0.05 : 0);
            if (c < bc) { bc = c; bp = { x, y, rot, box }; }
          }
        }
        return bp;
      }

      // greedy growth
      const todo = movers.slice();
      while (todo.length) {
        let bi = 0, bs = -1;
        todo.forEach((p, i) => {
          let s = 0; for (const q of geo.get(p.id)[0].pins) if (q.net && netPts.has(q.net) && netPts.get(q.net).length) s += 10;
          s += degree(p) * 0.5 + (isConn(p) ? 0 : 0.1);
          if (s > bs) { bs = s; bi = i; }
        });
        const p = todo.splice(bi, 1)[0];
        const pos = best(p, null);
        if (!pos) return null;
        const pl = { p, x: pos.x, y: pos.y, rot: pos.rot, box: pos.box }; placed.push(pl); addNet(pl);
      }
      // clean-up passes with everyone down
      for (let it = 0; it < 2; it++) for (const pl of placed) {
        if (pl.p.locked || pl.p.type === 'MH') continue;
        rmNet(pl); const pos = best(pl.p, pl);
        if (pos && cost(pl.p, pos.x, pos.y, pos.rot) < cost(pl.p, pl.x, pl.y, pl.rot) - 1e-6) Object.assign(pl, pos);
        addNet(pl);
      }
      return placed;
    }

    let W = b.w, H = b.h, placed = null;
    if (opt.resize && !fixed.length) {
      // start from a board big enough to hold everything loosely
      let area = 0; for (const p of movers) { const bb = geo.get(p.id)[0].bb; area += (bb[2] - bb[0] + gap + 1.5) * (bb[3] - bb[1] + gap + 1.5); }
      const side = Math.sqrt(area * 2.2) + 2 * edgeM + (holes.length ? 10 : 0);
      W = Math.max(W, Math.ceil(side * 1.2)); H = Math.max(H, Math.ceil(side * 0.9));
    }
    for (let tries = 0; tries < 8 && !placed; tries++) {
      placed = attempt(W, H);
      if (!placed) { if (!opt.resize && tries > 0) break; W = Math.ceil(W * 1.2); H = Math.ceil(H * 1.2); }
    }
    if (!placed) return { ok: false, msg: 'Parts do not fit on the board. Make the board bigger or tick "size board to fit".' };

    for (const pl of placed) { pl.p.bx = +pl.x.toFixed(3); pl.p.by = +pl.y.toFixed(3); pl.p.brot = pl.rot; }

    if (opt.resize && !fixed.length) {
      // shrink the board around what was placed
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const pl of placed) { if (pl.p.type === 'MH') continue; const bb = M.partBox(pl.p, 0); x0 = Math.min(x0, bb[0]); y0 = Math.min(y0, bb[1]); x1 = Math.max(x1, bb[2]); y1 = Math.max(y1, bb[3]); }
      // leave room for reference text above parts and for the corner holes
      const hm = holes.length ? Math.max(...holes.map(h => M.footprintOf(h).holes[0].d)) + 3.2 : 0;
      const mx = Math.max(edgeM + .6, hm), myTop = Math.max(edgeM + R.text + 1.0, hm), myBot = Math.max(edgeM + (b.label ? R.text * 1.2 + 1.6 : .6), hm);
      // snap the shift to the placement grid so pins stay on the routing grid
      const sx = Math.round((mx - x0) / step) * step, sy = Math.round((myTop - y0) / step) * step;
      for (const pl of placed) if (pl.p.type !== 'MH') { pl.p.bx = +(pl.p.bx + sx).toFixed(3); pl.p.by = +(pl.p.by + sy).toFixed(3); }
      b.w = Math.ceil(x1 + sx + mx); b.h = Math.ceil(y1 + sy + myBot);
      const ins = holes.length ? hm / 2 : 0;
      const cs = [[ins, ins], [b.w - ins, ins], [b.w - ins, b.h - ins], [ins, b.h - ins]];
      holes.forEach((h, i) => { h.bx = +cs[i % 4][0].toFixed(3); h.by = +cs[i % 4][1].toFixed(3); h.brot = 0; });
    } else { b.w = W; b.h = H; }
    return { ok: true, w: b.w, h: b.h };
  }

  P.place = { autoplace };
})(globalThis.PCB = globalThis.PCB || {});
