/* hammi.ca PCB: canvas drawing for the schematic, the board editor and the
   "real look" render that the 3D view also uses as its texture. */
(function (P) {
  'use strict';
  const M = P.model, G = P.geom, DEFS = P.lib.DEFS;

  const C = {
    ink: '#d9d9d5', dim: '#6f6f6c', faint: '#2a2a2c', grid: '#1d1d1f', grid2: '#29292b', orange: '#ff5a1f', sel: '#ff5a1f',
    top: 'rgba(255,106,43,.88)', topPad: '#ff7a3d', bot: 'rgba(91,143,216,.78)', botPad: '#6d9de0', tht: '#c9c9c5', hole: '#0b0b0c',
    silk: 'rgba(233,233,230,.82)', rats: 'rgba(168,216,255,.55)', board: '#141415', edge: '#8d8d8a', err: '#ff4a2a', warn: '#e9c46a'
  };
  const MASK = {
    green: ['#1f5a32', '#2f7a46', '#ffffff'], black: ['#141414', '#262626', '#ffffff'], blue: ['#123f7a', '#2258a6', '#ffffff'],
    red: ['#8a1a1a', '#ad2c28', '#ffffff'], white: ['#ececea', '#dcdcd6', '#111111'], purple: ['#4b2a7a', '#6741a6', '#ffffff']
  };
  P.colors = C; P.MASK = MASK;

  function accent() {
    try { return getComputedStyle(document.documentElement).getPropertyValue('--orange').trim() || C.orange; } catch (e) { return C.orange; }
  }

  /* ---------- schematic ---------- */
  function drawPrims(ctx, prims, s, col, fillCol) {
    ctx.strokeStyle = col; ctx.fillStyle = fillCol || col;
    for (const p of prims) {
      switch (p[0]) {
        case 'l': ctx.beginPath(); ctx.moveTo(p[1], p[2]); ctx.lineTo(p[3], p[4]); ctx.stroke(); break;
        case 'r': ctx.strokeRect(p[1], p[2], p[3], p[4]); break;
        case 'c': ctx.beginPath(); ctx.arc(p[1], p[2], p[3], 0, Math.PI * 2); ctx.stroke(); break;
        case 'a': ctx.beginPath(); ctx.arc(p[1], p[2], p[3], p[4] * Math.PI / 180, p[5] * Math.PI / 180); ctx.stroke(); break;
        case 'p': ctx.beginPath(); p[1].forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); if (p[2]) ctx.fill(); else ctx.stroke(); break;
        case 't': {
          const [, x, y, str, al, size] = p; if (!str) break;
          ctx.save(); ctx.translate(x, y);
          const m = ctx.getTransform(); // keep text upright whatever the rotation
          const ang = Math.atan2(m.b, m.a);
          if (Math.abs(ang) > 1.6) ctx.rotate(Math.PI); else if (Math.abs(ang) > .1) ctx.rotate(-ang);
          ctx.font = '400 ' + size + 'px "IBM Plex Mono", monospace';
          let a = al === 'c' ? 'center' : al === 'r' ? 'right' : 'left';
          if (Math.abs(ang) > 1.6) a = a === 'left' ? 'right' : a === 'right' ? 'left' : a;
          ctx.textAlign = a; ctx.textBaseline = 'middle'; ctx.fillText(str, 0, 0); ctx.restore(); break;
        }
      }
    }
  }

  function drawSymbol(ctx, part, sel, hiPins) {
    const sym = M.symbolOf(part);
    ctx.save(); ctx.translate(part.sx, part.sy); ctx.rotate((part.srot || 0) * Math.PI / 180);
    ctx.lineWidth = 0.13; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    drawPrims(ctx, sym.prims, 1, sel ? accent() : C.ink);
    ctx.restore();
    // labels, always upright
    const d = DEFS[part.type];
    if (!d.power) {
      const bx = sym.box, pts = [[bx[0], bx[1]], [bx[2], bx[1]], [bx[2], bx[3]], [bx[0], bx[3]]].map(([x, y]) => G.rotPt(x, y, part.srot || 0));
      const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
      ctx.font = '500 1.05px Inter, sans-serif'; ctx.fillStyle = sel ? accent() : C.ink; ctx.textBaseline = 'alphabetic';
      const chip = part.type === 'IC', vert = (part.srot || 0) % 180 !== 0 && !chip && part.type !== 'J' && part.type !== 'JT';
      if (vert) { ctx.textAlign = 'left'; ctx.fillText(part.ref, part.sx + x1 + .5, part.sy - .15); ctx.font = '400 .9px "IBM Plex Mono", monospace'; ctx.fillStyle = C.dim; ctx.fillText(part.value, part.sx + x1 + .5, part.sy + 1); }
      else { ctx.textAlign = 'center'; ctx.fillText(part.ref, part.sx + (x0 + x1) / 2, part.sy + y0 - (chip ? 1.4 : .45)); if (part.type !== 'J' && part.type !== 'JT' && part.type !== 'MH') { ctx.font = '400 .9px "IBM Plex Mono", monospace'; ctx.fillStyle = C.dim; ctx.fillText(part.value, part.sx + (x0 + x1) / 2, chip ? part.sy + y0 - .4 : part.sy + y1 + 1.1); } }
    }
    for (const pin of M.symPins(part)) {
      const hi = hiPins && hiPins.has(part.id + ':' + pin.n);
      ctx.beginPath(); ctx.arc(pin.x, pin.y, hi ? .38 : .2, 0, Math.PI * 2);
      ctx.fillStyle = hi ? accent() : C.dim; ctx.fill();
    }
  }

  function symBoxes(pr) {
    return pr.parts.map(p => { const b = M.symbolOf(p).box, q = [[b[0], b[1]], [b[2], b[3]]].map(([x, y]) => G.rotPt(x, y, p.srot || 0));
      return { id: p.id, b: [Math.min(q[0][0], q[1][0]) + p.sx + .15, Math.min(q[0][1], q[1][1]) + p.sy + .15, Math.max(q[0][0], q[1][0]) + p.sx - .15, Math.max(q[0][1], q[1][1]) + p.sy - .15] }; });
  }
  function crossings(pts, boxes) {
    let n = 0;
    for (let i = 1; i < pts.length; i++) for (const bx of boxes) { const b = bx.b; if (b[2] <= b[0] || b[3] <= b[1]) continue;
      const x0 = Math.min(pts[i - 1][0], pts[i][0]), x1 = Math.max(pts[i - 1][0], pts[i][0]), y0 = Math.min(pts[i - 1][1], pts[i][1]), y1 = Math.max(pts[i - 1][1], pts[i][1]);
      if (x1 > b[0] && x0 < b[2] && y1 > b[1] && y0 < b[3]) n++; }
    return n;
  }
  function clean(pts) {
    const o = [];
    for (const p of pts) { if (o.length && o[o.length - 1][0] === p[0] && o[o.length - 1][1] === p[1]) continue; o.push(p); }
    for (let i = o.length - 2; i >= 1; i--) { const a = o[i - 1], b = o[i], c = o[i + 1]; if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) o.splice(i, 1); }
    return o;
  }
  /* schematic wire: short stub out of each pin, then an L, picking the bend that crosses fewest symbols */
  function wirePath(a, b, boxes) {
    const A = [a.x, a.y], B = [b.x, b.y];
    if (!boxes) return clean(a.x === b.x || a.y === b.y ? [A, B] : [A, [b.x, a.y], B]);
    const cands = [];
    if (a.x === b.x || a.y === b.y) cands.push([A, B]);
    for (const s of [0, 1]) {
      const a1 = s ? [a.x + (a.dx || 0), a.y + (a.dy || 0)] : A, b1 = s ? [b.x + (b.dx || 0), b.y + (b.dy || 0)] : B;
      cands.push([A, a1, [b1[0], a1[1]], b1, B], [A, a1, [a1[0], b1[1]], b1, B]);
    }
    let best = null, bc = 1e9;
    cands.forEach((c, i) => { const pts = clean(c); const sc = crossings(pts, boxes) * 100 + pts.length + i * .01; if (sc < bc) { bc = sc; best = pts; } });
    return best;
  }

  function drawGrid(ctx, view, W, H, step, col, dots) {
    const s = view.s; if (step * s < 7) return;
    const x0 = Math.floor(-view.ox / s / step) * step, y0 = Math.floor(-view.oy / s / step) * step;
    ctx.fillStyle = col;
    const r = dots / s;
    for (let x = x0; x < (W - view.ox) / s; x += step) for (let y = y0; y < (H - view.oy) / s; y += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
  }

  function drawSchematic(ctx, view, pr, st, W, H) {
    ctx.save(); ctx.translate(view.ox, view.oy); ctx.scale(view.s, view.s);
    drawGrid(ctx, view, W, H, 1, C.grid, 1.2); drawGrid(ctx, view, W, H, 5, C.grid2, 2);
    const pinPos = new Map();
    for (const p of pr.parts) for (const pin of M.symPins(p)) pinPos.set(p.id + ':' + pin.n, pin);
    const count = new Map(), boxes = symBoxes(pr);
    // wires
    ctx.lineWidth = 0.13; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    pr.wires.forEach((w, i) => {
      const a = pinPos.get(w.a.p + ':' + w.a.n), b = pinPos.get(w.b.p + ':' + w.b.n); if (!a || !b) return;
      for (const k of [w.a.p + ':' + w.a.n, w.b.p + ':' + w.b.n]) count.set(k, (count.get(k) || 0) + 1);
      const net = st.nets && st.nets.byKey.get(w.a.p + ':' + w.a.n);
      const hot = st.selWire === i || (st.hiNet && net === st.hiNet);
      ctx.strokeStyle = hot ? accent() : '#9a9a96'; ctx.lineWidth = st.selWire === i ? .22 : .13;
      ctx.beginPath(); wirePath(a, b, boxes).forEach(([x, y], j) => j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
    });
    const hiPins = new Set();
    if (st.hiNet && st.nets) for (const [k, n] of st.nets.byKey) if (n === st.hiNet) hiPins.add(k);
    if (st.hoverPin) hiPins.add(st.hoverPin);
    if (st.wireFrom) hiPins.add(st.wireFrom);
    for (const p of pr.parts) drawSymbol(ctx, p, st.sel === p.id, hiPins);
    // junction dots where 3+ things meet
    ctx.fillStyle = '#9a9a96';
    for (const [k, c] of count) if (c >= 2) { const p = pinPos.get(k); if (p) { ctx.beginPath(); ctx.arc(p.x, p.y, .32, 0, Math.PI * 2); ctx.fill(); } }
    // rubber band
    if (st.wireFrom && st.mouse) {
      const a = pinPos.get(st.wireFrom);
      if (a) { ctx.setLineDash([.4, .3]); ctx.strokeStyle = accent(); ctx.lineWidth = .15; ctx.beginPath(); wirePath(a, { x: Math.round(st.mouse.x), y: Math.round(st.mouse.y) }).forEach(([x, y], j) => j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke(); ctx.setLineDash([]); }
    }
    if (st.box) { ctx.strokeStyle = accent(); ctx.lineWidth = 1 / view.s; ctx.setLineDash([4 / view.s, 3 / view.s]); ctx.strokeRect(st.box[0], st.box[1], st.box[2] - st.box[0], st.box[3] - st.box[1]); ctx.setLineDash([]); }
    ctx.restore();
    return pinPos;
  }

  function schBounds(pr) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of pr.parts) {
      const b = M.symbolOf(p).box; const pts = [[b[0], b[1]], [b[2], b[3]]].map(([x, y]) => G.rotPt(x, y, p.srot || 0));
      for (const [x, y] of pts) { x0 = Math.min(x0, p.sx + x); x1 = Math.max(x1, p.sx + x); y0 = Math.min(y0, p.sy + y - 2); y1 = Math.max(y1, p.sy + y + 2); }
    }
    return x0 > x1 ? [-20, -15, 20, 15] : [x0, y0, x1, y1];
  }

  /* ---------- board editor ---------- */
  function padPath(ctx, p, grow) {
    const s = G.padShape(p, grow || 0);
    ctx.beginPath();
    if (s.k === 'rect') ctx.rect(s.cx - s.hw, s.cy - s.hh, 2 * s.hw, 2 * s.hh);
    else if (s.ax === s.bx && s.ay === s.by) ctx.arc(s.ax, s.ay, s.r, 0, Math.PI * 2);
    else { const ang = Math.atan2(s.by - s.ay, s.bx - s.ax); ctx.arc(s.ax, s.ay, s.r, ang + Math.PI / 2, ang + 3 * Math.PI / 2); ctx.arc(s.bx, s.by, s.r, ang - Math.PI / 2, ang + Math.PI / 2); ctx.closePath(); }
  }
  function outlinePath(ctx, b) { const pts = G.boardOutline(b, 10); ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); }

  function drawTraces(ctx, pr, layer, col, st) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    pr.traces.forEach((t, i) => {
      if (t.layer !== layer) return;
      const hot = st.selTrace === i || (st.hiNet && t.net === st.hiNet);
      ctx.strokeStyle = hot ? (layer ? '#a9c8f5' : '#ffc2a3') : col; ctx.lineWidth = t.w || pr.rules.trace;
      ctx.beginPath(); t.pts.forEach(([x, y], j) => j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
    });
  }

  function drawBoard(ctx, view, pr, st, W, H, info) {
    const b = pr.board, R = pr.rules, L = st.layers;
    ctx.save(); ctx.translate(view.ox, view.oy); ctx.scale(view.s, view.s);
    drawGrid(ctx, view, W, H, 1.27, C.grid, 1.2); drawGrid(ctx, view, W, H, 12.7, C.grid2, 2);
    // staging area
    const staged = pr.parts.filter(p => M.footprintOf(p) && p.bx < 0);
    if (staged.length) { ctx.fillStyle = C.dim; ctx.font = '400 1.4px "IBM Plex Mono", monospace'; ctx.textAlign = 'right'; ctx.fillText('NOT PLACED YET', -4, 2); }
    if (L.real && st.realImg) {
      ctx.drawImage(st.realImg, 0, 0, b.w, b.h);
      outlinePath(ctx, b); ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 1 / view.s; ctx.stroke();
    } else {
      outlinePath(ctx, b); ctx.fillStyle = C.board; ctx.fill(); ctx.strokeStyle = C.edge; ctx.lineWidth = Math.max(.1, 1 / view.s); ctx.stroke();
    }
    if (!L.real) {
      if (L.bot) {
        drawTraces(ctx, pr, 1, C.bot, st);
        for (const p of info.pads) if (p.drill) { ctx.fillStyle = C.botPad; padPath(ctx, p); ctx.fill(); }
      }
      if (L.top) {
        drawTraces(ctx, pr, 0, C.top, st);
        for (const p of info.pads) { ctx.fillStyle = p.drill ? C.tht : C.topPad; padPath(ctx, p); ctx.fill(); }
      }
      if (!L.top && !L.bot) for (const p of info.pads) { ctx.strokeStyle = C.dim; ctx.lineWidth = .08; padPath(ctx, p); ctx.stroke(); }
      for (const v of pr.vias) { ctx.fillStyle = '#d0d0cb'; ctx.beginPath(); ctx.arc(v.x, v.y, (v.d || R.via) / 2, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = C.hole; ctx.beginPath(); ctx.arc(v.x, v.y, (v.drill || R.viaDrill) / 2, 0, Math.PI * 2); ctx.fill(); }
      for (const p of info.pads) if (p.drill) { ctx.fillStyle = C.hole; ctx.beginPath(); ctx.arc(p.x, p.y, p.drill / 2, 0, Math.PI * 2); ctx.fill(); }
      for (const h of info.holes) { ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(h.x, h.y, h.d / 2, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = C.dim; ctx.lineWidth = .08; ctx.stroke(); }
      if (L.silk && st.silk) { ctx.strokeStyle = C.silk; ctx.lineWidth = R.silk; ctx.lineCap = 'round'; ctx.beginPath(); for (const s of st.silk) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); } ctx.stroke(); }
      // pad numbers when zoomed in
      if (view.s > 14) {
        ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const p of info.pads) { ctx.font = '500 ' + Math.min(p.w, p.h) * .45 + 'px "IBM Plex Mono", monospace'; ctx.fillText(p.n, p.x, p.y); }
      }
    }
    // hover net highlight on pads
    if (st.hiNet) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / view.s; for (const p of info.pads) if (p.net === st.hiNet) { padPath(ctx, p, .12); ctx.stroke(); } }
    // ratsnest
    if (L.rats && st.rats) { ctx.strokeStyle = C.rats; ctx.lineWidth = 1.2 / view.s; ctx.beginPath(); for (const l of st.rats.lines) { ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); } ctx.stroke(); }
    // selection
    for (const p of pr.parts) {
      if (st.sel !== p.id && !(st.multi && st.multi.has(p.id))) continue;
      const bb = M.partBox(p, .4); if (!bb) continue;
      ctx.strokeStyle = accent(); ctx.lineWidth = 1.5 / view.s; ctx.setLineDash([5 / view.s, 3 / view.s]); ctx.strokeRect(bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]); ctx.setLineDash([]);
    }
    if (staged.length || view.s > 6) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const p of staged) { const bb = M.partBox(p, 0); ctx.fillStyle = C.ink; ctx.font = '500 1.2px Inter, sans-serif'; ctx.fillText(p.ref, (bb[0] + bb[2]) / 2, bb[1] - 1); }
    }
    // DRC markers
    if (st.drc) for (const d of st.drc.list) {
      if (d.x == null) continue;
      const r = Math.max(.8, 7 / view.s), hot = st.drcHot === d;
      ctx.strokeStyle = d.sev === 'error' ? C.err : C.warn; ctx.lineWidth = (hot ? 3 : 1.6) / view.s;
      ctx.beginPath(); ctx.arc(d.x, d.y, hot ? r * 1.6 : r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(d.x - r * .5, d.y - r * .5); ctx.lineTo(d.x + r * .5, d.y + r * .5); ctx.moveTo(d.x + r * .5, d.y - r * .5); ctx.lineTo(d.x - r * .5, d.y + r * .5); ctx.stroke();
    }
    if (st.box) { ctx.strokeStyle = accent(); ctx.lineWidth = 1 / view.s; ctx.setLineDash([4 / view.s, 3 / view.s]); ctx.strokeRect(st.box[0], st.box[1], st.box[2] - st.box[0], st.box[3] - st.box[1]); ctx.setLineDash([]); }
    // dimensions
    if (!L.real) {
      ctx.fillStyle = C.dim; ctx.font = '400 ' + (11 / view.s) + 'px "IBM Plex Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(b.w + ' MM', b.w / 2, -6 / view.s);
      ctx.save(); ctx.translate(b.w + 6 / view.s, b.h / 2); ctx.rotate(Math.PI / 2); ctx.fillText(b.h + ' MM', 0, 0); ctx.restore();
    }
    ctx.restore();
  }

  /* ---------- photo-ish render (top or bottom) ---------- */
  function renderReal(pr, side, ppm, info) {
    const b = pr.board, R = pr.rules, bottom = side === 'bottom';
    info = info || M.boardPads(pr);
    const cv = (typeof OffscreenCanvas !== 'undefined' && false) ? null : document.createElement('canvas');
    cv.width = Math.max(2, Math.round(b.w * ppm)); cv.height = Math.max(2, Math.round(b.h * ppm));
    const ctx = cv.getContext('2d');
    ctx.scale(ppm, ppm);
    if (bottom) { ctx.translate(b.w, 0); ctx.scale(-1, 1); }
    const [mask, cuMask, silkCol] = MASK[b.mask] || MASK.green;
    const finish = b.finish === 'enig' ? ['#e8c766', '#b8902e'] : ['#e4e4e0', '#a9a9a4'];
    outlinePath(ctx, b); ctx.save(); ctx.clip();
    ctx.fillStyle = mask; ctx.fillRect(0, 0, b.w, b.h);
    // a little texture so it doesn't look flat
    const grad = ctx.createLinearGradient(0, 0, b.w, b.h); grad.addColorStop(0, 'rgba(255,255,255,.06)'); grad.addColorStop(1, 'rgba(0,0,0,.08)'); ctx.fillStyle = grad; ctx.fillRect(0, 0, b.w, b.h);
    const layer = bottom ? 1 : 0;
    ctx.strokeStyle = cuMask; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const t of pr.traces) if (t.layer === layer) { ctx.lineWidth = t.w || R.trace; ctx.beginPath(); t.pts.forEach(([x, y], j) => j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke(); }
    ctx.fillStyle = cuMask; for (const v of pr.vias) { ctx.beginPath(); ctx.arc(v.x, v.y, (v.d || R.via) / 2, 0, Math.PI * 2); ctx.fill(); }
    for (const p of info.pads) {
      if (!p.layers.includes(layer)) continue;
      const g = ctx.createRadialGradient(p.x - p.w * .2, p.y - p.h * .2, 0, p.x, p.y, Math.max(p.w, p.h) * .7);
      g.addColorStop(0, finish[0]); g.addColorStop(1, finish[1]); ctx.fillStyle = g; padPath(ctx, p); ctx.fill();
    }
    if (!bottom) { ctx.strokeStyle = silkCol; ctx.lineWidth = R.silk; ctx.lineCap = 'round'; ctx.beginPath(); for (const s of M.silkSegments(pr, info)) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); } ctx.stroke(); }
    ctx.restore();
    // drill holes go right through
    ctx.globalCompositeOperation = 'destination-out';
    for (const p of info.pads) if (p.drill) { ctx.beginPath(); ctx.arc(p.x, p.y, p.drill / 2, 0, Math.PI * 2); ctx.fill(); }
    for (const v of pr.vias) { ctx.beginPath(); ctx.arc(v.x, v.y, (v.drill || R.viaDrill) / 2, 0, Math.PI * 2); ctx.fill(); }
    for (const h of info.holes) { ctx.beginPath(); ctx.arc(h.x, h.y, h.d / 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalCompositeOperation = 'source-over';
    return cv;
  }

  /* ---------- little icons for the parts list ---------- */
  function libIcon(cv, type) {
    const d = DEFS[type], dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = 34 * dpr; cv.height = 22 * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    const fake = { type, value: d.value, n: d.n || (type === 'J' ? 3 : 2), srot: 0, sx: 0, sy: 0, id: 0 };
    if (type === 'IC') fake.value = 'DIP-8 generic';
    const sym = M.symbolOf(fake), bx = sym.box;
    const s = Math.min(30 / (bx[2] - bx[0] + .5), 19 / (bx[3] - bx[1] + .5));
    ctx.translate(17 - (bx[0] + bx[2]) / 2 * s, 11 - (bx[1] + bx[3]) / 2 * s); ctx.scale(s, s);
    ctx.lineWidth = 1.1 / s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const col = getComputedStyle(document.body).color;
    drawPrims(ctx, sym.prims.filter(p => p[0] !== 't'), s, col);
  }

  P.draw = { symBoxes, drawSchematic, drawBoard, renderReal, libIcon, schBounds, wirePath, padPath, outlinePath };
})(globalThis.PCB = globalThis.PCB || {});
