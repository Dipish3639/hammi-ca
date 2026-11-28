/* hammi.ca PCB: project model, nets, absolute pads, silkscreen, stroke font,
   copper connectivity and ratsnest. No DOM in here so it runs in Node too. */
(function (P) {
  'use strict';
  const G = P.geom, DEFS = P.lib.DEFS;

  const RULES = { trace: 0.25, clearance: 0.2, via: 0.6, viaDrill: 0.3, edge: 0.5, grid: 0.254, mask: 0.05, silk: 0.15, text: 1.0, minDrill: 0.3, ring: 0.13 };

  function newProject() {
    return {
      app: 'hammi-pcb', version: 1, name: 'untitled board',
      board: { w: 50, h: 40, r: 1, label: '', mask: 'green', finish: 'hasl', thick: 1.6 },
      rules: Object.assign({}, RULES), parts: [], wires: [], traces: [], vias: [], nextId: 1
    };
  }

  function normalize(pr) {
    const p = Object.assign(newProject(), pr || {});
    p.board = Object.assign(newProject().board, p.board || {});
    p.rules = Object.assign({}, RULES, p.rules || {});
    p.parts = (p.parts || []).filter(x => DEFS[x.type]);
    p.wires = p.wires || []; p.traces = p.traces || []; p.vias = p.vias || [];
    let mx = 0; for (const x of p.parts) mx = Math.max(mx, x.id || 0);
    p.nextId = Math.max(p.nextId || 1, mx + 1);
    return p;
  }

  function nextRef(pr, prefix) {
    const used = new Set(pr.parts.map(x => x.ref));
    for (let i = 1; ; i++) if (!used.has(prefix + i)) return prefix + i;
  }

  function addPart(pr, type, at) {
    const d = DEFS[type];
    const part = { id: pr.nextId++, type, ref: nextRef(pr, d.prefix), value: d.value, fp: d.fp || null, sx: 0, sy: 0, srot: 0, bx: -20, by: 10, brot: 0 };
    if (d.count) part.n = d.n;
    Object.assign(part, at || {});
    pr.parts.push(part);
    return part;
  }

  /* ---------- symbols and footprints ---------- */
  const fpCache = new Map();
  function footprintOf(part) {
    const d = DEFS[part.type];
    if (!d || !d.fps) return null;
    const key = part.type + '|' + part.fp + '|' + part.value + '|' + (part.n || '');
    if (fpCache.has(key)) return fpCache.get(key);
    const f = (d.fps[part.fp] || d.fps[d.fp])[1](part);
    f.holes = f.holes || [];
    fpCache.set(key, f);
    return f;
  }
  function symbolOf(part) { return DEFS[part.type].sym(part); }

  function symPins(part) {
    const s = symbolOf(part);
    const b = s.box;
    return s.pins.map(pn => {
      const [x, y] = G.rotPt(pn.x, pn.y, part.srot || 0);
      let dx = pn.x <= b[0] + 1e-6 ? -1 : pn.x >= b[2] - 1e-6 ? 1 : 0, dy = dx ? 0 : pn.y <= b[1] + 1e-6 ? -1 : pn.y >= b[3] - 1e-6 ? 1 : 0;
      if (DEFS[part.type].label) { dx = -1; dy = 0; }
      const [ex, ey] = G.rotPt(dx, dy, part.srot || 0);
      return { n: pn.n, name: pn.name, x: part.sx + x, y: part.sy + y, dx: Math.round(ex), dy: Math.round(ey), pid: part.id };
    });
  }

  /* ---------- nets ---------- */
  function UF() { const p = new Map(); const f = k => { let r = k; while (p.has(r) && p.get(r) !== r) r = p.get(r); let c = k; while (c !== r) { const n = p.get(c); p.set(c, r); c = n; } if (!p.has(r)) p.set(r, r); return r; }; return { f, u: (a, b) => { const x = f(a), y = f(b); if (x !== y) p.set(x, y); } }; }

  function computeNets(pr) {
    const uf = UF(), byPart = new Map(pr.parts.map(x => [x.id, x]));
    const keyOk = k => { const [id, n] = k.split(':'); const pt = byPart.get(+id); return pt && symbolOf(pt).pins.some(q => String(q.n) === n); };
    for (const w of pr.wires) { const a = w.a.p + ':' + w.a.n, b = w.b.p + ':' + w.b.n; if (keyOk(a) && keyOk(b)) uf.u(a, b); }
    for (const pt of pr.parts) if (DEFS[pt.type].power) uf.u(pt.id + ':1', 'pwr:' + (pt.value || 'VCC'));
    const groups = new Map();
    const touched = new Set();
    for (const w of pr.wires) { touched.add(w.a.p + ':' + w.a.n); touched.add(w.b.p + ':' + w.b.n); }
    for (const pt of pr.parts) if (DEFS[pt.type].power) touched.add(pt.id + ':1');
    for (const k of touched) { if (!keyOk(k)) continue; const r = uf.f(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(k); }
    for (const pt of pr.parts) if (DEFS[pt.type].power) { const r = uf.f('pwr:' + (pt.value || 'VCC')); if (groups.has(r) && !groups.get(r).pwr) groups.get(r).pwr = []; if (groups.has(r)) groups.get(r).pwr.push(pt.value || 'VCC'); }
    const byKey = new Map(), nets = new Map();
    for (const [, keys] of groups) {
      const real = keys.filter(k => !DEFS[byPart.get(+k.split(':')[0]).type].power);
      let name;
      if (keys.pwr) name = [...new Set(keys.pwr)].sort((a, b) => (/gnd/i.test(a) ? -1 : 0) - (/gnd/i.test(b) ? -1 : 0) || a.localeCompare(b))[0];
      else {
        const lab = real.map(k => { const [id, n] = k.split(':'); const pt = byPart.get(+id); const pin = symbolOf(pt).pins.find(q => String(q.n) === n); return pt.ref + '.' + (pin && pin.name && pin.name !== n ? pin.name : n); });
        lab.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        name = 'N-' + (lab[0] || 'x');
      }
      if (nets.has(name)) { let i = 2; while (nets.has(name + '_' + i)) i++; name = name + '_' + i; }
      nets.set(name, real);
      for (const k of keys) byKey.set(k, name);
    }
    return { byKey, nets };
  }

  /* ---------- absolute board geometry ---------- */
  function xf(part, x, y) { const [a, b] = G.rotPt(x, y, part.brot || 0); return [part.bx + a, part.by + b]; }

  function boardPads(pr, nets) {
    nets = nets || computeNets(pr);
    const pads = [], holes = [];
    for (const part of pr.parts) {
      const f = footprintOf(part); if (!f) continue;
      const sw = (part.brot || 0) % 180 !== 0;
      for (const pd of f.pads) {
        const [x, y] = xf(part, pd.x, pd.y);
        const net = nets.byKey.get(part.id + ':' + pd.pin) || null;
        pads.push({ pid: part.id, ref: part.ref, pin: pd.pin, n: pd.n, x, y, w: sw ? pd.h : pd.w, h: sw ? pd.w : pd.h, shape: pd.shape, drill: pd.drill, net, layers: pd.drill ? [0, 1] : [0] });
      }
      for (const h of f.holes) { const [x, y] = xf(part, h.x, h.y); holes.push({ pid: part.id, ref: part.ref, x, y, d: h.d }); }
    }
    return { pads, holes };
  }

  function arcPts(cx, cy, r, a0, a1, n) {
    const pts = []; n = n || Math.max(6, Math.ceil(Math.abs(a1 - a0) / 12));
    for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return pts;
  }

  /* outline of a footprint's own drawing, as segments in footprint coords */
  function fpSegments(f) {
    const segs = [];
    const poly = pts => { for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]); };
    for (const s of f.silk) {
      if (s[0] === 'l') segs.push([s[1], s[2], s[3], s[4]]);
      else if (s[0] === 'c') poly(arcPts(s[1], s[2], s[3], 0, 360, 32));
      else if (s[0] === 'a') poly(arcPts(s[1], s[2], s[3], s[4], s[5]));
    }
    return segs;
  }

  function partBox(part, grow) {
    const f = footprintOf(part); if (!f) return null;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const add = (x, y) => { const [a, b] = G.rotPt(x, y, part.brot || 0); x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b); };
    for (const p of f.pads) { add(p.x - p.w / 2, p.y - p.h / 2); add(p.x + p.w / 2, p.y + p.h / 2); }
    for (const h of f.holes) { add(h.x - h.d / 2, h.y - h.d / 2); add(h.x + h.d / 2, h.y + h.d / 2); }
    for (const s of fpSegments(f)) { add(s[0], s[1]); add(s[2], s[3]); }
    const g = grow || 0;
    return [part.bx + x0 - g, part.by + y0 - g, part.bx + x1 + g, part.by + y1 + g];
  }

  /* ---------- stroke font for silkscreen (4 x 6 grid) ---------- */
  const O = [[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]], Pp = [[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]];
  const FONT = {
    A: [[[0, 6], [0, 2], [2, 0], [4, 2], [4, 6]], [[0, 4], [4, 4]]], B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[0, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
    C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]], D: [[[0, 0], [0, 6], [2, 6], [4, 4], [4, 2], [2, 0], [0, 0]]],
    E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]], F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
    G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3], [2, 3]]], H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
    I: [[[1, 0], [3, 0]], [[2, 0], [2, 6]], [[1, 6], [3, 6]]], J: [[[4, 0], [4, 5], [3, 6], [1, 6], [0, 5]]],
    K: [[[0, 0], [0, 6]], [[4, 0], [0, 4]], [[1, 3], [4, 6]]], L: [[[0, 0], [0, 6], [4, 6]]],
    M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]], N: [[[0, 6], [0, 0], [4, 6], [4, 0]]], O: [O], P: [Pp],
    Q: [O, [[2, 4], [4, 6]]], R: [Pp, [[2, 3], [4, 6]]], S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
    T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]], U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]], V: [[[0, 0], [2, 6], [4, 0]]],
    W: [[[0, 0], [1, 6], [2, 3], [3, 6], [4, 0]]], X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]], Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]], Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
    0: [O, [[4, 1], [0, 5]]], 1: [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]], 2: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
    3: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]], [[1, 3], [3, 3]]], 4: [[[3, 6], [3, 0], [0, 4], [4, 4]]],
    5: [[[4, 0], [0, 0], [0, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]], 6: [[[3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]],
    7: [[[0, 0], [4, 0], [1, 6]]], 8: [[[1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0]], [[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3]]],
    9: [[[4, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6]]],
    '-': [[[0, 3], [4, 3]]], '+': [[[0, 3], [4, 3]], [[2, 1], [2, 5]]], '.': [[[1.7, 6], [2.3, 6]]], '/': [[[0, 6], [4, 0]]], '_': [[[0, 6], [4, 6]]],
    ':': [[[2, 1.6], [2, 2.2]], [[2, 4.8], [2, 5.4]]], '(': [[[3, 0], [2, 1], [2, 5], [3, 6]]], ')': [[[1, 0], [2, 1], [2, 5], [1, 6]]], '#': [[[1, 0], [1, 6]], [[3, 0], [3, 6]], [[0, 2], [4, 2]], [[0, 4], [4, 4]]],
    "'": [[[2, 0], [2, 1.5]]], '!': [[[2, 0], [2, 4]], [[2, 5.6], [2, 6]]], '=': [[[0, 2], [4, 2]], [[0, 4], [4, 4]]], '*': [[[0, 1], [4, 5]], [[4, 1], [0, 5]], [[2, 0], [2, 6]]], '&': [[[4, 6], [0, 2], [0, 1], [1, 0], [2, 1], [0, 4], [0, 5], [1, 6], [2, 6], [4, 3]]], ',': [[[2, 5], [1.5, 7]]]
  };
  function textWidth(str, h) { return str.length ? (str.length * 6 - 2) * h / 6 : 0; }
  function textStrokes(str, x, y, h, align) {
    str = String(str).toUpperCase();
    const s = h / 6, w = textWidth(str, h);
    let ox = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x;
    const oy = y - h / 2, out = [];
    for (const ch of str) {
      for (const st of (FONT[ch] || [])) out.push(st.map(([a, b]) => [ox + a * s, oy + b * s]));
      ox += 6 * s;
    }
    return out;
  }

  /* silkscreen as clipped segments [x1,y1,x2,y2] in board mm */
  function silkSegments(pr, padsInfo) {
    const R = pr.rules, segs = [];
    const poly = pts => { for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]); };
    for (const part of pr.parts) {
      const f = footprintOf(part); if (!f) continue;
      for (const s of fpSegments(f)) { const a = xf(part, s[0], s[1]), b = xf(part, s[2], s[3]); segs.push([a[0], a[1], b[0], b[1]]); }
      if (part.type === 'MH') continue;
      const bb = partBox(part, 0), h = R.text;
      let ty = bb[1] - .5 - h / 2;
      if (ty - h / 2 < .6) ty = bb[3] + .5 + h / 2;
      let tx = (bb[0] + bb[2]) / 2;
      const tw = textWidth(part.ref, h);
      tx = G.clamp(tx, tw / 2 + .8, pr.board.w - tw / 2 - .8);
      for (const st of textStrokes(part.ref, tx, ty, h, 'c')) poly(st);
    }
    if (pr.board.label) for (const st of textStrokes(pr.board.label, pr.board.w / 2, pr.board.h - 1.4 - R.text * 0.6, R.text * 1.2, 'c')) poly(st);
    // clip silk away from pads and holes so the fab doesn't print on copper
    const { pads, holes } = padsInfo || boardPads(pr);
    const keep = pads.map(p => G.padShape(p, R.mask + R.silk / 2 + .05)).concat(holes.map(h => G.cap(h.x, h.y, h.x, h.y, h.d / 2 + R.silk / 2 + .1)));
    const out = [];
    for (const s of segs) {
      const L = Math.hypot(s[2] - s[0], s[3] - s[1]);
      const box = [Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3])];
      const hits = keep.filter(k => { const b = G.shapeBox(k); return b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1]; });
      if (!hits.length || L < 1e-6) { out.push(s); continue; }
      const n = Math.max(2, Math.ceil(L / 0.04));
      let run = null;
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = s[0] + (s[2] - s[0]) * t, y = s[1] + (s[3] - s[1]) * t;
        const inside = hits.some(k => G.ptShapeDist(x, y, k) < 0);
        if (!inside) { if (!run) run = [x, y, x, y]; else { run[2] = x; run[3] = y; } }
        else if (run) { if (Math.hypot(run[2] - run[0], run[3] - run[1]) > .05) out.push(run); run = null; }
      }
      if (run && Math.hypot(run[2] - run[0], run[3] - run[1]) > .05) out.push(run);
    }
    return out;
  }

  /* ---------- copper connectivity ---------- */
  function copperItems(pr, padsInfo) {
    const R = pr.rules, items = [];
    for (const p of padsInfo.pads) items.push({ t: 'pad', ref: p, net: p.net, layers: p.layers, s: G.padShape(p) });
    pr.traces.forEach((t, ti) => { for (let i = 1; i < t.pts.length; i++) { const a = t.pts[i - 1], b = t.pts[i]; items.push({ t: 'seg', ref: t, ti, net: t.net, layers: [t.layer], s: G.cap(a[0], a[1], b[0], b[1], (t.w || R.trace) / 2) }); } });
    pr.vias.forEach((v, vi) => items.push({ t: 'via', ref: v, vi, net: v.net, layers: [0, 1], s: G.cap(v.x, v.y, v.x, v.y, (v.d || R.via) / 2) }));
    for (const it of items) it.box = G.shapeBox(it.s);
    return items;
  }

  /* calls fn(i, j) for item pairs whose boxes are within `pad` mm */
  function nearPairs(items, pad, fn) {
    const cell = 3, grid = new Map();
    items.forEach((it, i) => {
      const x0 = Math.floor((it.box[0] - pad) / cell), x1 = Math.floor((it.box[2] + pad) / cell), y0 = Math.floor((it.box[1] - pad) / cell), y1 = Math.floor((it.box[3] + pad) / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + ',' + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
    });
    const seen = new Set();
    for (const [, list] of grid) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const i = list[a], j = list[b], key = i < j ? i * 1e6 + j : j * 1e6 + i;
      if (seen.has(key)) continue; seen.add(key);
      const A = items[i].box, B = items[j].box;
      if (A[0] - pad > B[2] || B[0] - pad > A[2] || A[1] - pad > B[3] || B[1] - pad > A[3]) continue;
      fn(i, j);
    }
  }

  function connectivity(pr, padsInfo) {
    const items = copperItems(pr, padsInfo);
    const par = items.map((_, i) => i);
    const f = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const u = (a, b) => { a = f(a); b = f(b); if (a !== b) par[a] = b; };
    nearPairs(items, 0.001, (i, j) => {
      const A = items[i], B = items[j];
      if (!A.layers.some(l => B.layers.includes(l))) return;
      if (G.shapeDist(A.s, B.s) <= 1e-4) u(i, j);
    });
    // pads of the same pin on the same part are tied inside the part
    const pinIdx = new Map();
    items.forEach((it, i) => { if (it.t !== 'pad') return; const k = it.ref.pid + ':' + it.ref.pin; if (pinIdx.has(k)) u(i, pinIdx.get(k)); else pinIdx.set(k, i); });
    return { items, comp: items.map((_, i) => f(i)) };
  }

  function ratsnest(pr, padsInfo, conn) {
    conn = conn || connectivity(pr, padsInfo);
    const lines = [], byNet = new Map();
    conn.items.forEach((it, i) => { if (it.t === 'pad' && it.net) { if (!byNet.has(it.net)) byNet.set(it.net, []); byNet.get(it.net).push(i); } });
    let open = 0;
    for (const [net, idx] of byNet) {
      // group pads by copper component, then join the components with a minimum spanning tree
      const comps = new Map();
      for (const i of idx) { const c = conn.comp[i]; if (!comps.has(c)) comps.set(c, []); comps.get(c).push(conn.items[i].ref); }
      const cl = [...comps.values()]; if (cl.length < 2) continue;
      const inT = [true], best = cl.map(() => [1e18, null, null]);
      const relax = k => { for (let j = 0; j < cl.length; j++) if (!inT[j]) for (const a of cl[k]) for (const b of cl[j]) { const d = Math.hypot(a.x - b.x, a.y - b.y); if (d < best[j][0]) best[j] = [d, a, b]; } };
      relax(0);
      for (let s = 1; s < cl.length; s++) {
        let bj = -1; for (let j = 0; j < cl.length; j++) if (!inT[j] && (bj < 0 || best[j][0] < best[bj][0])) bj = j;
        inT[bj] = true; lines.push({ net, a: best[bj][1], b: best[bj][2] }); open++; relax(bj);
      }
    }
    return { lines, open };
  }

  P.model = { RULES, newProject, normalize, addPart, nextRef, footprintOf, symbolOf, symPins, computeNets, boardPads, xf, partBox, fpSegments, arcPts, textStrokes, textWidth, silkSegments, copperItems, nearPairs, connectivity, ratsnest };
})(globalThis.PCB = globalThis.PCB || {});
