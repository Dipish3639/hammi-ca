/* hammi.ca PCB: the editor (state, input, panels, actions). */
(function (P) {
  'use strict';
  const M = P.model, G = P.geom, D = P.draw, DEFS = P.lib.DEFS;
  const $ = id => document.getElementById(id);
  const STORE = 'hammi-pcb-project';

  /* ---------- state ---------- */
  let pr = null, mode = 'sch';
  const vk = () => mode === 'sch' ? 'sch' : 'brd', isB = () => mode === 'brd' || mode === 'bld';
  const views = { sch: { ox: 0, oy: 0, s: 16 }, brd: { ox: 0, oy: 0, s: 10 } };
  const st = { sel: null, selWire: null, selTrace: null, hiNet: null, hoverPin: null, wireFrom: null, mouse: null, drc: null, drcHot: null, layers: { top: true, bot: true, silk: true, rats: true, real: false }, rats: null, silk: null, realImg: null, nets: null, info: null };
  const undo = [], redo = [];
  let flags = { exported: false };

  const cv = $('cv'), ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  function snapshot() { return JSON.stringify(pr); }
  function commit(fn, keepRoutes) {
    undo.push(snapshot()); if (undo.length > 120) undo.shift(); redo.length = 0;
    fn();
    changed(keepRoutes);
  }
  function changed() {
    st.drc = null; st.drcHot = null; flags.exported = false;
    refresh(); save();
  }
  function refresh() {
    st.nets = M.computeNets(pr);
    st.info = M.boardPads(pr, st.nets);
    st.rats = M.ratsnest(pr, st.info);
    st.silk = M.silkSegments(pr, st.info);
    st.realImg = null;
    if (st.sel != null && !pr.parts.some(p => p.id === st.sel)) st.sel = null;
    if (st.selWire != null && !pr.wires[st.selWire]) st.selWire = null;
    if (st.selTrace != null && !pr.traces[st.selTrace]) st.selTrace = null;
    $('sp-size').textContent = pr.board.w + ' × ' + pr.board.h + ' mm';
    $('sp-parts').textContent = pr.parts.filter(p => !DEFS[p.type].power).length;
    $('sp-nets').textContent = [...st.nets.nets.values()].filter(v => v.length >= 2).length;
    syncBoardForm(); inspector(); leds(); hint(); blockCounts(); $('fw-step').hidden = !pr.firmware; render();
    if (mode === '3d' && P.view3d) P.view3d.update(pr);
  }
  let saveT = 0;
  function save() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(STORE, JSON.stringify(pr)); } catch (e) {} }, 300); }

  function load(p, fit) {
    pr = M.normalize(p); undo.length = 0; redo.length = 0;
    st.sel = st.selWire = st.selTrace = st.wireFrom = null; st.drc = null;
    refresh(); if (fit !== false) { fitView('sch'); fitView('brd'); }
    log([{ cls: 'dim', t: 'Loaded “' + pr.name + '”: ' + pr.parts.length + ' parts.' }], '—');
  }

  /* ---------- canvas ---------- */
  function resize() {
    const r = cv.getBoundingClientRect(); dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const big = W && (Math.abs(r.width - W) / W > .3 || Math.abs(r.height - H) / H > .3);
    W = r.width; H = r.height; if (big) { fitView('sch'); fitView('brd'); }
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); render();
  }
  let raf = 0;
  function render() { if (!raf) raf = requestAnimationFrame(draw); }
  function draw() {
    raf = 0; if (mode === '3d') return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#0b0b0c'; ctx.fillRect(0, 0, W, H);
    if (mode === 'sch') D.drawSchematic(ctx, views.sch, pr, st, W, H);
    else {
      if (st.layers.real && !st.realImg) st.realImg = D.renderReal(pr, 'top', Math.min(40, Math.max(8, views.brd.s * dpr)), st.info);
      D.drawBoard(ctx, views.brd, pr, st, W, H, st.info);
    }
  }
  function fitView(which) {
    which = which || vk(); const v = views[which]; if (!v) return;
    let bb;
    if (which === 'sch') bb = D.schBounds(pr);
    else {
      bb = [0, 0, pr.board.w, pr.board.h];
      for (const p of pr.parts) { const b = M.partBox(p, 1); if (b) { bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]); bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]); } }
      bb = [bb[0] - 3, bb[1] - 4, bb[2] + 4, bb[3] + 3];
    }
    const w = W || 800, h = H || 500, pad = 40;
    v.s = Math.min((w - pad * 2) / (bb[2] - bb[0]), (h - pad * 2) / (bb[3] - bb[1]));
    v.s = Math.max(which === 'sch' ? 6 : 2, Math.min(v.s, which === 'sch' ? 40 : 60));
    v.ox = w / 2 - (bb[0] + bb[2]) / 2 * v.s; v.oy = h / 2 - (bb[1] + bb[3]) / 2 * v.s;
    render();
  }
  function zoomAt(f, sx, sy) {
    const v = views[vk()]; if (!v) return;
    const ns = Math.max(1.5, Math.min(200, v.s * f)); f = ns / v.s;
    v.ox = sx - (sx - v.ox) * f; v.oy = sy - (sy - v.oy) * f; v.s = ns; st.realImg = null; render();
  }
  const toWorld = (sx, sy) => { const v = views[vk()]; return { x: (sx - v.ox) / v.s, y: (sy - v.oy) / v.s }; };

  /* ---------- hit testing ---------- */
  function pinAt(w) {
    let best = null, bd = 0.7;
    for (const p of pr.parts) for (const pin of M.symPins(p)) { const d = Math.hypot(pin.x - w.x, pin.y - w.y); if (d < bd) { bd = d; best = { p: p.id, n: pin.n, pin, part: p }; } }
    return best;
  }
  function symAt(w) {
    let best = null, ba = 1e9;
    for (const p of pr.parts) {
      const b = M.symbolOf(p).box, pts = [[b[0], b[1]], [b[2], b[3]]].map(([x, y]) => G.rotPt(x, y, p.srot || 0));
      const x0 = Math.min(pts[0][0], pts[1][0]) + p.sx - .3, x1 = Math.max(pts[0][0], pts[1][0]) + p.sx + .3, y0 = Math.min(pts[0][1], pts[1][1]) + p.sy - .3, y1 = Math.max(pts[0][1], pts[1][1]) + p.sy + .3;
      if (w.x >= x0 && w.x <= x1 && w.y >= y0 && w.y <= y1) { const a = (x1 - x0) * (y1 - y0); if (a < ba) { ba = a; best = p; } }
    }
    return best;
  }
  function wireAt(w) {
    const pos = new Map(); for (const p of pr.parts) for (const pin of M.symPins(p)) pos.set(p.id + ':' + pin.n, pin);
    let best = null, bd = .45; const boxes = D.symBoxes(pr);
    pr.wires.forEach((wr, i) => {
      const a = pos.get(wr.a.p + ':' + wr.a.n), b = pos.get(wr.b.p + ':' + wr.b.n); if (!a || !b) return;
      const pts = D.wirePath(a, b, boxes);
      for (let k = 1; k < pts.length; k++) { const d = G.distPtSeg(w.x, w.y, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]); if (d < bd) { bd = d; best = i; } }
    });
    return best;
  }
  function partAt(w) {
    let best = null, ba = 1e9;
    for (const p of pr.parts) { const b = M.partBox(p, .3); if (!b) continue; if (w.x >= b[0] && w.x <= b[2] && w.y >= b[1] && w.y <= b[3]) { const a = (b[2] - b[0]) * (b[3] - b[1]); if (a < ba) { ba = a; best = p; } } }
    return best;
  }
  function padAt(w) { for (const p of st.info.pads) if (G.ptShapeDist(w.x, w.y, G.padShape(p)) < .1) return p; return null; }
  function traceAt(w) {
    let best = null, bd = 1e9;
    pr.traces.forEach((t, i) => {
      if ((t.layer === 0 && !st.layers.top) || (t.layer === 1 && !st.layers.bot)) return;
      for (let k = 1; k < t.pts.length; k++) { const d = G.distPtSeg(w.x, w.y, t.pts[k - 1][0], t.pts[k - 1][1], t.pts[k][0], t.pts[k][1]) - (t.w || pr.rules.trace) / 2; if (d < .25 && d < bd) { bd = d; best = i; } }
    });
    return best;
  }

  /* ---------- pointer input ---------- */
  const ptrs = new Map(); let drag = null;
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    ptrs.set(e.pointerId, { x: sx, y: sy });
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; drag = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; return; }
    const w = toWorld(sx, sy);
    if (e.button === 1 || e.button === 2 || spaceDown) { drag = { kind: 'pan', sx, sy, ox: views[vk()].ox, oy: views[vk()].oy }; return; }
    if (mode === 'sch') {
      const pin = pinAt(w);
      if (pin) {
        const key = pin.p + ':' + pin.n;
        if (st.wireFrom && st.wireFrom !== key) {
          const [ap, an] = st.wireFrom.split(':').map(Number);
          const dup = pr.wires.some(x => (x.a.p === ap && x.a.n === an && x.b.p === pin.p && x.b.n === pin.n) || (x.b.p === ap && x.b.n === an && x.a.p === pin.p && x.a.n === pin.n));
          if (!dup) commit(() => pr.wires.push({ a: { p: ap, n: an }, b: { p: pin.p, n: pin.n } }));
          st.wireFrom = e.shiftKey ? key : null; hint(); render(); return;
        }
        st.wireFrom = key; st.sel = null; st.selWire = null; inspector(); hint(); render(); return;
      }
      if (st.wireFrom) { st.wireFrom = null; hint(); render(); return; }
      const part = symAt(w);
      if (part) { select(part.id); drag = { kind: 'part', part, w0: w, x0: part.sx, y0: part.sy, snap: snapshot(), moved: false }; return; }
      const wi = wireAt(w);
      if (wi != null) { st.sel = null; st.selTrace = null; st.selWire = wi; inspector(); render(); return; }
    } else {
      const part = partAt(w);
      if (part) { select(part.id); drag = { kind: 'part', part, w0: w, x0: part.bx, y0: part.by, snap: snapshot(), moved: false }; return; }
      const ti = traceAt(w);
      if (ti != null) { st.sel = null; st.selWire = null; st.selTrace = ti; st.hiNet = pr.traces[ti].net; inspector(); render(); return; }
    }
    select(null); st.selWire = null; st.selTrace = null; inspector();
    drag = { kind: 'pan', sx, sy, ox: views[vk()].ox, oy: views[vk()].oy };
  });
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: sx, y: sy });
    const w = toWorld(sx, sy);
    if (drag && drag.kind === 'pinch' && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const v = views[vk()]; v.ox += cx - drag.cx; v.oy += cy - drag.cy; zoomAt(d / drag.d, cx, cy); drag.d = d; drag.cx = cx; drag.cy = cy; return;
    }
    if (drag && drag.kind === 'pan') { const v = views[vk()]; v.ox = drag.ox + sx - drag.sx; v.oy = drag.oy + sy - drag.sy; render(); return; }
    if (drag && drag.kind === 'part') {
      const p = drag.part, dx = w.x - drag.w0.x, dy = w.y - drag.w0.y;
      if (mode === 'sch') { const nx = Math.round(drag.x0 + dx), ny = Math.round(drag.y0 + dy); if (nx !== p.sx || ny !== p.sy) { p.sx = nx; p.sy = ny; drag.moved = true; render(); } }
      else {
        const g = e.shiftKey ? .254 : 1.27, nx = +(Math.round((drag.x0 + dx) / g) * g).toFixed(3), ny = +(Math.round((drag.y0 + dy) / g) * g).toFixed(3);
        if (nx !== p.bx || ny !== p.by) { p.bx = nx; p.by = ny; drag.moved = true; st.info = M.boardPads(pr, st.nets); st.silk = M.silkSegments(pr, st.info); st.rats = M.ratsnest(pr, st.info); st.realImg = null; render(); }
      }
      return;
    }
    // hover
    st.mouse = w;
    if (mode === 'sch') {
      const pin = pinAt(w); const key = pin ? pin.p + ':' + pin.n : null;
      if (key !== st.hoverPin) { st.hoverPin = key; st.hiNet = key ? st.nets.byKey.get(key) || null : null; hint(pin); }
      if (st.wireFrom || key !== st.hoverPin) render(); else if (st.wireFrom) render();
      cv.style.cursor = pin ? 'crosshair' : symAt(w) ? 'move' : 'default';
      if (st.wireFrom) render();
    } else {
      const pad = padAt(w), net = pad ? pad.net : (st.selTrace != null ? pr.traces[st.selTrace].net : null);
      if (net !== st.hiNet || (pad && pad !== st.hoverPad)) { st.hiNet = net; st.hoverPad = pad; hint(null, pad); render(); }
      cv.style.cursor = partAt(w) ? 'move' : 'default';
    }
  });
  const up = e => {
    ptrs.delete(e.pointerId);
    if (drag && drag.kind === 'part' && drag.moved) {
      undo.push(drag.snap); redo.length = 0;
      if (isB()) ripUp(drag.part);
      changed();
    }
    if (ptrs.size < 2 && drag && drag.kind === 'pinch') drag = null;
    if (!ptrs.size) drag = null;
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', e => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0018)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });

  function ripUp(part) {
    const nets = new Set(st.info.pads.filter(p => p.pid === part.id && p.net).map(p => p.net));
    if (!nets.size) return;
    const before = pr.traces.length;
    pr.traces = pr.traces.filter(t => !nets.has(t.net)); pr.vias = pr.vias.filter(v => !nets.has(v.net));
    if (before !== pr.traces.length) log([{ cls: 'dim', t: 'Moved ' + part.ref + ': removed its traces. Press Autoroute again.' }]);
  }

  let spaceDown = false;
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); doRedo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveFile(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === ' ') { spaceDown = true; e.preventDefault(); }
    else if (k === 'r') rotateSel();
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); }
    else if (k === 'escape' && !$('code').hidden) $('code').hidden = true;
    else if (k === 'escape') { st.wireFrom = null; select(null); st.selWire = st.selTrace = null; inspector(); hint(); render(); }
    else if (k === 'f') fitView();
    else if (k === '1') setMode('bld'); else if (k === '2') setMode('sch'); else if (k === '3') setMode('brd'); else if (k === '4') setMode('3d');
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });

  function doUndo() { if (!undo.length) return; redo.push(snapshot()); pr = JSON.parse(undo.pop()); changed(); }
  function doRedo() { if (!redo.length) return; undo.push(snapshot()); pr = JSON.parse(redo.pop()); changed(); }

  function select(id) { st.sel = id; if (id != null) { st.selWire = null; st.selTrace = null; } inspector(); render(); }
  function selPart() { return pr.parts.find(p => p.id === st.sel); }
  function rotateSel() {
    const p = selPart(); if (!p) return;
    commit(() => { if (mode === 'sch') p.srot = ((p.srot || 0) + 90) % 360; else { p.brot = ((p.brot || 0) + 90) % 360; ripUp(p); } });
  }
  function deleteSel() {
    const p = selPart();
    if (p) { commit(() => { pr.wires = pr.wires.filter(w => w.a.p !== p.id && w.b.p !== p.id); ripUp(p); pr.parts = pr.parts.filter(x => x !== p); }); st.sel = null; return; }
    if (st.selWire != null) { const i = st.selWire; commit(() => pr.wires.splice(i, 1)); st.selWire = null; return; }
    if (st.selTrace != null) { const i = st.selTrace; commit(() => pr.traces.splice(i, 1)); st.selTrace = null; }
  }

  /* ---------- hint line ---------- */
  function hint(pin, pad) {
    const h = $('hint');
    if (mode === 'sch') {
      if (pin) { const net = st.nets.byKey.get(pin.p + ':' + pin.n); h.innerHTML = '<b>' + esc(pin.part.ref) + '</b> pin ' + pin.n + (pin.pin.name && pin.pin.name !== String(pin.n) ? ' ' + esc(pin.pin.name) : '') + ' · ' + (net ? 'net <b>' + esc(net) + '</b>' : 'not connected') + (st.wireFrom ? ' · click to finish the wire' : ' · click to start a wire'); return; }
      h.innerHTML = st.wireFrom ? 'Wiring: click another pin to connect · <b>Shift</b>+click to keep going · <b>Esc</b> to stop' : 'Click a pin, then another pin to wire them · drag parts · <b>R</b> rotate · <b>Del</b> delete · scroll to zoom, drag empty space to pan';
    } else if (isB()) {
      if (pad) { h.innerHTML = '<b>' + esc(pad.ref) + '</b> pad ' + esc(pad.n) + ' · ' + (pad.net ? 'net <b>' + esc(pad.net) + '</b>' : 'no net') + ' · ' + (pad.drill ? 'through-hole, ' + pad.drill + ' mm drill' : 'SMD, top'); return; }
      if (mode === 'bld' && !pr.firmware) { h.innerHTML = 'Click a block on the left, drag it where you want it on the board, then press <b>Connect &amp; make it work</b>'; return; }
      const open = st.rats ? st.rats.open : 0;
      h.innerHTML = (open ? '<b>' + open + '</b> connection' + (open > 1 ? 's' : '') + ' still to route · ' : (pr.traces.length ? 'All connections routed · ' : '')) + 'Drag parts (<b>Shift</b> for fine steps) · <b>R</b> rotate · click a trace and <b>Del</b> to remove it';
    } else h.innerHTML = 'Drag to turn the board · scroll to zoom · right-drag to move';
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- parts library ---------- */
  function buildLib() {
    const groups = {}; for (const [t, d] of Object.entries(DEFS)) (groups[d.group] = groups[d.group] || []).push([t, d]);
    const host = $('lib'); host.innerHTML = '';
    for (const [g, list] of Object.entries(groups)) {
      const div = document.createElement('div'); div.className = 'libgrp'; div.innerHTML = '<h4>' + g + '</h4>';
      for (const [t, d] of list) {
        const b = document.createElement('button'); b.className = 'libbtn'; b.title = 'Add ' + d.name;
        const c = document.createElement('canvas'); b.appendChild(c);
        const s = document.createElement('span'); s.innerHTML = esc(d.name) + '<small>' + esc(d.label ? 'joins pins by name' : d.power ? 'VCC · GND · +5V' : d.fps ? d.fps[d.fp][0] : '') + '</small>'; b.appendChild(s);
        b.addEventListener('click', () => addPart(t));
        div.appendChild(b); requestAnimationFrame(() => D.libIcon(c, t));
      }
      host.appendChild(div);
    }
  }
  function addPart(type) {
    let p;
    commit(() => {
      const v = views.sch, cx = Math.round(((W || 800) / 2 - v.ox) / v.s), cy = Math.round(((H || 500) / 2 - v.oy) / v.s);
      p = M.addPart(pr, type, {});
      if (type === 'PWR') p.ref = M.nextRef(pr, '#PWR');
      // find a free spot in the schematic near the middle of the view
      const box = q => { const b = M.symbolOf(q).box, pts = [[b[0], b[1]], [b[2], b[3]]].map(([x, y]) => G.rotPt(x, y, q.srot || 0)); return [Math.min(pts[0][0], pts[1][0]) + q.sx - 1, Math.min(pts[0][1], pts[1][1]) + q.sy - 1, Math.max(pts[0][0], pts[1][0]) + q.sx + 1, Math.max(pts[0][1], pts[1][1]) + q.sy + 1]; };
      outer: for (let r = 0; r < 40; r++) for (let a = 0; a < Math.max(1, r * 4); a++) {
        const ang = a / Math.max(1, r * 4) * Math.PI * 2; p.sx = cx + Math.round(Math.cos(ang) * r * 2); p.sy = cy + Math.round(Math.sin(ang) * r * 2);
        const bp = box(p); if (!pr.parts.some(q => q !== p && (() => { const o = box(q); return bp[0] < o[2] && bp[2] > o[0] && bp[1] < o[3] && bp[3] > o[1]; })())) break outer;
      }
      // park the footprint left of the board until it's placed
      if (M.footprintOf(p)) {
        const staged = pr.parts.filter(q => q !== p && M.footprintOf(q) && q.bx < 0);
        let y = 4; for (const q of staged) { const b = M.partBox(q, 0); y = Math.max(y, b[3] + 4); }
        p.bx = 0; p.by = 0; const bb = M.partBox(p, 0);
        p.bx = +(-6 - bb[2]).toFixed(3); p.by = +(y - bb[1]).toFixed(3);
      }
    });
    select(p.id);
    if (mode === '3d') setMode('sch');
  }

  /* ---------- inspector ---------- */
  function inspector() {
    const body = $('insp-body'), ref = $('insp-ref');
    const p = selPart();
    if (!p) {
      if (st.selWire != null && pr.wires[st.selWire]) {
        const w = pr.wires[st.selWire], a = pr.parts.find(x => x.id === w.a.p), b = pr.parts.find(x => x.id === w.b.p);
        ref.textContent = 'wire';
        body.innerHTML = '<div class="muted">' + esc(a ? a.ref : '?') + ' pin ' + w.a.n + ' → ' + esc(b ? b.ref : '?') + ' pin ' + w.b.n + ' · net ' + esc(st.nets.byKey.get(w.a.p + ':' + w.a.n) || '') + '</div><div class="insp-keys"><button class="k grey sm" id="i-del">Delete wire</button></div>';
        $('i-del').onclick = deleteSel; return;
      }
      if (st.selTrace != null && pr.traces[st.selTrace]) {
        const t = pr.traces[st.selTrace];
        ref.textContent = 'trace';
        body.innerHTML = '<div class="muted">' + (t.layer ? 'Bottom' : 'Top') + ' copper · ' + (t.w || pr.rules.trace) + ' mm · net ' + esc(t.net) + '</div><div class="insp-keys"><button class="k grey sm" id="i-del">Delete</button><button class="k grey sm" id="i-deln">Delete whole net</button></div>';
        $('i-del').onclick = deleteSel;
        $('i-deln').onclick = () => { const n = t.net; commit(() => { pr.traces = pr.traces.filter(x => x.net !== n); pr.vias = pr.vias.filter(x => x.net !== n); }); st.selTrace = null; };
        return;
      }
      ref.textContent = 'nothing';
      body.className = 'muted';
      body.innerHTML = mode === 'sch' ? 'Add parts from the list on the left, then click pin to pin to wire them. <kbd>R</kbd> rotates, <kbd>Del</kbd> deletes, <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes.' : 'Press <b>Generate PCB</b> to place and route everything, or drag parts yourself and press Autoroute.';
      return;
    }
    const d = DEFS[p.type]; ref.textContent = p.ref; body.className = '';
    let valueField;
    if (d.chip) valueField = '<select id="i-val">' + Object.keys(P.lib.CHIPS).map(c => '<option' + (c === p.value ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>';
    else if (d.power) valueField = '<input type="text" id="i-val" list="pwr-list" value="' + esc(p.value) + '"><datalist id="pwr-list">' + d.values.map(v => '<option value="' + v + '">').join('') + '</datalist>';
    else valueField = '<input type="text" id="i-val" value="' + esc(p.value) + '">';
    let html = '<div class="insp-row">';
    html += d.power ? '' : '<label class="field">Name<input type="text" id="i-ref" value="' + esc(p.ref) + '"></label>';
    html += '<label class="field' + (d.power ? ' wide' : '') + '">' + (d.power ? 'Net name' : d.chip ? 'Chip' : 'Value') + valueField + '</label>';
    if (d.fps) html += '<label class="field wide">Footprint<select id="i-fp">' + Object.entries(d.fps).map(([k, v]) => '<option value="' + k + '"' + (k === p.fp ? ' selected' : '') + '>' + esc(v[0]) + '</option>').join('') + '</select></label>';
    if (d.count) { html += '<label class="field">Pins<select id="i-n">'; for (let i = d.count[0]; i <= d.count[1]; i++) html += '<option' + (i === (p.n || d.n) ? ' selected' : '') + '>' + i + '</option>'; html += '</select></label>'; }
    html += '</div><div class="insp-keys"><button class="k grey sm" id="i-rot">Rotate</button>';
    if (d.fps) html += '<label class="chk" title="Auto-place leaves locked parts where they are"><input type="checkbox" id="i-lock"' + (p.locked ? ' checked' : '') + '> lock on board</label>';
    html += '<button class="k grey sm" id="i-del">Delete</button></div>';
    const pins = M.symPins(p);
    if (pins.length && !d.power) html += '<div class="pinlist">' + pins.sort((a, b) => a.n - b.n).map(pn => '<div>' + pn.n + (pn.name !== String(pn.n) ? ' ' + esc(pn.name) : '') + ' → <b>' + esc(st.nets.byKey.get(p.id + ':' + pn.n) || '—') + '</b></div>').join('') + '</div>';
    body.innerHTML = html;
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on('i-ref', 'change', e => { const v = e.target.value.trim().replace(/\s+/g, ''); if (!v) return; if (pr.parts.some(x => x !== p && x.ref === v)) { e.target.value = p.ref; log([{ cls: 'warn', t: v + ' is already used.' }]); return; } commit(() => p.ref = v); });
    on('i-val', 'change', e => { const v = e.target.value.trim(); if (!v) return; commit(() => { p.value = v; if (d.chip) ripUp(p); }); });
    on('i-fp', 'change', e => commit(() => { ripUp(p); p.fp = e.target.value; }));
    on('i-n', 'change', e => commit(() => { ripUp(p); p.n = +e.target.value; pr.wires = pr.wires.filter(w => !((w.a.p === p.id && w.a.n > p.n) || (w.b.p === p.id && w.b.n > p.n))); }));
    on('i-rot', 'click', rotateSel);
    on('i-del', 'click', deleteSel);
    on('i-lock', 'change', e => commit(() => p.locked = e.target.checked));
  }

  /* ---------- board settings and rules ---------- */
  function syncBoardForm() {
    const b = pr.board, set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
    set('bw', b.w); set('bh', b.h); set('br', b.r); set('bname', pr.name); set('blabel', b.label); set('bmask', b.mask); set('bfin', b.finish);
    document.querySelectorAll('[data-rule]').forEach(el => { if (document.activeElement !== el) el.value = String(pr.rules[el.dataset.rule]); });
  }
  function bindForms() {
    const num = (id, key, lo, hi) => $(id).addEventListener('change', e => { const v = Math.max(lo, Math.min(hi, +e.target.value || 0)); commit(() => pr.board[key] = v); });
    num('bw', 'w', 5, 300); num('bh', 'h', 5, 300); num('br', 'r', 0, 20);
    $('bname').addEventListener('change', e => commit(() => pr.name = e.target.value.trim() || 'board'));
    $('blabel').addEventListener('change', e => commit(() => pr.board.label = e.target.value.trim()));
    $('bmask').addEventListener('change', e => commit(() => pr.board.mask = e.target.value));
    $('bfin').addEventListener('change', e => commit(() => pr.board.finish = e.target.value));
    document.querySelectorAll('[data-rule]').forEach(el => el.addEventListener('change', () => {
      const v = +el.value; if (!(v > 0)) return;
      commit(() => { pr.rules[el.dataset.rule] = v; if (el.dataset.rule === 'trace') for (const t of pr.traces) t.w = v; });
    }));
    document.querySelectorAll('[data-layer]').forEach(el => el.addEventListener('change', () => { st.layers[el.dataset.layer] = el.checked; st.realImg = null; render(); }));
  }

  /* ---------- report panel ---------- */
  function log(items, status) {
    const ol = $('log-l'); ol.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li'); li.className = it.cls || ''; li.textContent = it.t;
      if (it.d) li.addEventListener('click', () => { setMode('brd'); const v = views.brd; v.s = Math.max(v.s, 18); v.ox = W / 2 - it.d.x * v.s; v.oy = H / 2 - it.d.y * v.s; st.drcHot = it.d; render(); });
      ol.appendChild(li);
    }
    if (status != null) $('log-s').textContent = status;
    ol.scrollTop = 0;
  }
  function leds() {
    const fp = pr.parts.filter(p => M.footprintOf(p));
    const placed = fp.length && fp.every(p => { const b = M.partBox(p, 0); return b[0] >= 0 && b[1] >= 0 && b[2] <= pr.board.w && b[3] <= pr.board.h; });
    const L = (id, cls) => { const el = $(id); el.className = 'led' + (cls ? ' ' + cls : ''); };
    L('l-place', placed ? 'on' : '');
    L('l-route', !pr.traces.length ? '' : st.rats.open ? 'bad' : 'on');
    L('l-drc', !st.drc ? '' : st.drc.errors ? 'bad' : 'on');
    L('l-exp', flags.exported ? 'on' : '');
  }

  /* ---------- actions ---------- */
  function busy(on, text) { $('busy').hidden = !on; if (text) $('busy-t').textContent = text; document.querySelectorAll('#b-gen, #b-place, #b-route, #b-drc, #b-export').forEach(b => b.disabled = on); }
  const tick = () => new Promise(r => setTimeout(r, 30));

  function hasParts() {
    if (!pr.parts.some(p => M.footprintOf(p))) { log([{ cls: 'warn', t: 'Add some parts first, or load an example from the Examples menu.' }], '—'); return false; }
    return true;
  }
  function doPlace() {
    if (!hasParts()) return false;
    let r;
    commit(() => { pr.traces = []; pr.vias = []; r = P.place.autoplace(pr, { resize: $('c-resize').checked }); });
    if (!r.ok) { log([{ cls: 'err', t: r.msg }], 'place failed'); return false; }
    log([{ cls: 'ok', t: 'Placed ' + pr.parts.filter(p => M.footprintOf(p)).length + ' parts on a ' + pr.board.w + ' × ' + pr.board.h + ' mm board.' }], 'placed');
    if (isB()) fitView('brd');
    return true;
  }
  async function doRoute() {
    if (!hasParts()) return null;
    const fp = pr.parts.filter(p => M.footprintOf(p));
    if (fp.some(p => p.bx < 0)) { log([{ cls: 'warn', t: 'Some parts are still off the board. Press Auto-place first, or drag them on.' }], '—'); return null; }
    busy(true, 'Routing');
    await tick();
    let r;
    try {
      r = await P.router.autoroute(pr, { onProgress: (p, n, f) => { $('busy-t').textContent = 'Routing · pass ' + p + (f != null ? ' · ' + f + ' left' : ''); } });
    } catch (e) { busy(false); log([{ cls: 'err', t: 'Router crashed: ' + e.message }], 'error'); throw e; }
    busy(false);
    commit(() => { pr.traces = r.traces; pr.vias = r.vias; }, true);
    const items = [];
    if (r.fails) items.push({ cls: 'err', t: r.fails + ' of ' + r.connections + ' connections could not be routed (' + r.failed.join(', ') + '). Make the board bigger, move parts apart, or narrow the trace/clearance rules, then route again.' });
    else items.push({ cls: 'ok', t: 'Routed all ' + r.connections + ' connections in ' + (r.ms / 1000).toFixed(1) + ' s (' + r.passes + ' pass' + (r.passes > 1 ? 'es' : '') + ').' });
    items.push({ cls: 'dim', t: r.traces.length + ' traces, ' + r.vias.length + ' vias, ' + Math.round(r.length) + ' mm of copper.' });
    log(items, r.fails ? 'incomplete' : 'routed');
    return r;
  }
  function doDrc(quiet) {
    const r = P.drc.run(pr); st.drc = r; st.drcHot = null; leds(); render();
    const items = [];
    if (!r.errors && !r.warnings) items.push({ cls: 'ok', t: 'No problems found. ' + r.nets + ' nets all connected, clearances ≥ ' + pr.rules.clearance + ' mm.' });
    for (const d of r.list.slice(0, 200)) items.push({ cls: d.sev === 'error' ? 'err' : 'warn', t: d.msg, d });
    if (!quiet || r.errors || r.warnings) log(items, r.errors ? r.errors + ' error' + (r.errors > 1 ? 's' : '') : r.warnings ? r.warnings + ' warning' + (r.warnings > 1 ? 's' : '') : 'pass');
    return r;
  }
  async function generate() {
    let conn = null;
    if (mode === 'bld') {
      if (!pr.parts.some(p => p.block && p.type !== 'NANO')) { log([{ cls: 'warn', t: 'Add some blocks first: a screen, a dial, buttons, LEDs…' }], '—'); return; }
      commit(() => { conn = P.build.connect(pr); });
      fitView('sch');
    }
    if (!hasParts()) return;
    if (!doPlace()) return;
    setMode('brd'); fitView('brd'); await tick();
    const r = await doRoute(); if (!r) return;
    const d = doDrc(true);
    const items = [];
    items.push({ cls: 'ok', t: 'Board ' + pr.board.w + ' × ' + pr.board.h + ' mm, ' + pr.parts.filter(p => M.footprintOf(p)).length + ' parts.' });
    if (r.fails) items.push({ cls: 'err', t: r.fails + ' connection' + (r.fails > 1 ? 's' : '') + ' could not be routed: ' + r.failed.join(', ') + '. Try a bigger board or drag parts apart and press Autoroute.' });
    else items.push({ cls: 'ok', t: 'Routed ' + r.connections + ' connections: ' + r.traces.length + ' traces, ' + r.vias.length + ' vias.' });
    if (!d.errors && !d.warnings) items.push({ cls: 'ok', t: 'Design-rule check passed. Ready to export.' });
    for (const x of d.list.slice(0, 200)) items.push({ cls: x.sev === 'error' ? 'err' : 'warn', t: x.msg, d: x });
    if (conn) {
      items.unshift({ cls: 'ok', t: 'Wired ' + conn.map.length + ' blocks to the Arduino Nano. Firmware written (step 5).' });
      for (const m of conn.msgs) items.splice(1, 0, { cls: /No room/.test(m) ? 'warn' : 'dim', t: m });
      items.push({ cls: 'dim', t: 'Pins: ' + conn.map.map(m => m.part.ref + ' ' + (m.role === 'screen' ? 'A4/A5 (I2C)' : m.role === 'dial' ? 'D2 D3 D4' : (typeof m.pin === 'number' ? 'D' : '') + m.pin)).join(' · ') });
    }
    log(items, d.errors ? d.errors + ' error' + (d.errors > 1 ? 's' : '') : 'ready');
  }
  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function doExport() {
    if (!hasParts()) return;
    const d = doDrc(true);
    if (d.errors && !confirm('The design-rule check found ' + d.errors + ' error' + (d.errors > 1 ? 's' : '') + ' (see the report). A fab will make exactly what is in the files, so the board may not work.\n\nExport anyway?')) return;
    const out = P.exporter.buildFiles(pr);
    download(out.base + '-gerbers.zip', new Blob([P.exporter.zip(out.files)], { type: 'application/zip' }));
    flags.exported = true; leds();
    log([{ cls: 'ok', t: 'Saved ' + out.base + '-gerbers.zip (' + out.files.length + ' files: Gerbers, drill, BOM, pick-and-place, project).' }, { cls: 'dim', t: 'Upload the zip to a PCB maker and check their preview before ordering.' }].concat(d.list.slice(0, 50).map(x => ({ cls: x.sev === 'error' ? 'err' : 'warn', t: x.msg, d: x }))), 'exported');
  }
  function saveFile() { download((pr.name || 'board').replace(/[^a-z0-9_-]+/gi, '-') + '.pcb.json', JSON.stringify(pr, null, 1), 'application/json'); }

  /* ---------- build blocks ---------- */
  function buildBlocks() {
    const host = $('blocks'); host.innerHTML = '';
    for (const [t, name, sub] of P.build.BLOCKS) {
      const b = document.createElement('button'); b.className = 'k ' + (t === 'NANO' ? 'black' : 'grey') + ' blk'; b.dataset.type = t;
      b.innerHTML = '<span><b>' + esc(name) + '</b><small>' + esc(sub) + '</small></span><span class="cnt"></span>';
      b.addEventListener('click', () => addBlock(t));
      host.appendChild(b);
    }
  }
  function blockCounts() {
    document.querySelectorAll('.blk').forEach(b => { const n = pr.parts.filter(p => p.block && p.type === b.dataset.type).length; b.querySelector('.cnt').textContent = n ? '×' + n : ''; });
  }
  function addBlock(type) {
    if (type === 'NANO' && pr.parts.some(p => p.type === 'NANO')) { log([{ cls: 'dim', t: 'There is already a Nano on the board. Drag it where you want it.' }]); return; }
    let p;
    commit(() => {
      p = M.addPart(pr, type, { block: true, locked: true });
      // first free spot on the board, scanning from the top left
      const fits = (x, y) => { p.bx = x; p.by = y; const b = M.partBox(p, .8); if (b[0] < 1 || b[1] < 1 || b[2] > pr.board.w - 1 || b[3] > pr.board.h - 1) return false; return !pr.parts.some(q => q !== p && (() => { const o = M.partBox(q, .8); return o && b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]; })()); };
      let ok = false;
      for (let tries = 0; tries < 6 && !ok; tries++) {
        outer: for (let y = 2.54; y < pr.board.h; y += 1.27) for (let x = 2.54; x < pr.board.w; x += 1.27) if (fits(x, y)) { ok = true; break outer; }
        if (!ok) { pr.board.w += 15; pr.board.h += 10; }
      }
      p.sx = 40 + (pr.parts.length % 5) * 14; p.sy = 30 + Math.floor(pr.parts.length / 5) * 10;
    });
    select(p.id);
    if (mode !== 'bld') setMode('bld');
    fitView('brd');
  }
  function showCode() {
    if (!pr.firmware) return;
    $('code-t').textContent = (pr.name || 'board') + ' firmware · Arduino Nano';
    $('code-p').textContent = pr.firmware; $('code').hidden = false;
  }
  const fwName = () => (pr.name || 'board').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') + '-firmware';
  $('b-fw').onclick = () => download(fwName() + '.ino', pr.firmware || '', 'text/plain');
  $('b-fwv').onclick = showCode;
  $('code-x').onclick = () => { $('code').hidden = true; };
  $('code-copy').onclick = async () => { try { await navigator.clipboard.writeText(pr.firmware || ''); $('code-copy').textContent = 'Copied'; setTimeout(() => $('code-copy').textContent = 'Copy', 1500); } catch (e) {} };

  /* ---------- modes ---------- */
  function setMode(m) {
    mode = m;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.view === m));
    $('layers').hidden = !isB();
    $('blocks-wrap').hidden = m !== 'bld'; $('lib-wrap').hidden = m === 'bld';
    $('gen-t').textContent = m === 'bld' ? 'Connect & make it work' : 'Generate PCB';
    $('gen-s').textContent = m === 'bld' ? 'wire · place · route · code' : 'place · route · check';
    $('v3d').hidden = m !== '3d'; cv.hidden = m === '3d';
    document.querySelector('.ovl.br').hidden = m === '3d';
    if (m === '3d') {
      if (pr.parts.some(p => M.footprintOf(p) && p.bx < 0) && !pr.traces.length) log([{ cls: 'dim', t: 'Tip: press Generate PCB first so the 3D view has a finished board to show.' }]);
      P.view3d.show($('v3d'), pr).catch(e => { $('v3d').innerHTML = '<p style="padding:20px;font:400 12px var(--mono);color:#8d8d8a">3D needs three.js from cdnjs.cloudflare.com and it did not load (' + esc(e.message) + ').</p>'; });
    } else if (P.view3d) P.view3d.hide();
    st.wireFrom = null; st.hiNet = null; inspector(); hint(); render();
    try { localStorage.setItem('hammi-pcb-mode', m); } catch (e) {}
  }

  /* ---------- wiring up ---------- */
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.view)));
  $('b-fit').onclick = () => fitView();
  $('b-zin').onclick = () => zoomAt(1.25, W / 2, H / 2);
  $('b-zout').onclick = () => zoomAt(0.8, W / 2, H / 2);
  $('b-undo').onclick = doUndo; $('b-redo').onclick = doRedo;
  $('b-gen').onclick = generate;
  $('b-place').onclick = () => { if (doPlace()) { setMode('brd'); fitView('brd'); } };
  $('b-route').onclick = () => { setMode('brd'); doRoute(); };
  $('b-unroute').onclick = () => commit(() => { pr.traces = []; pr.vias = []; });
  $('b-drc').onclick = () => { setMode('brd'); doDrc(); };
  $('b-export').onclick = doExport;
  $('b-save').onclick = saveFile;
  $('b-open').onclick = () => $('f-open').click();
  $('f-open').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const j = JSON.parse(await f.text()); if (j.app !== 'hammi-pcb') throw new Error('not a hammi.ca PCB project'); undo.push(snapshot()); load(j); } catch (err) { log([{ cls: 'err', t: 'Could not open ' + f.name + ': ' + err.message }], 'error'); }
  });
  $('b-new').onclick = () => { if (pr.parts.length && !confirm('Start a new empty board? (Undo can bring this one back.)')) return; const old = snapshot(); load(M.newProject()); undo.push(old); };
  const menu = $('m-ex');
  for (const [k, ex] of Object.entries(P.examples)) {
    const b = document.createElement('button'); b.innerHTML = esc(ex.title) + '<small>' + (ex.sub || '') + '</small>';
    b.onclick = () => { menu.hidden = true; const old = pr.parts.length ? snapshot() : null; load(ex.make()); if (old) undo.push(old); setMode(ex.build ? 'bld' : 'sch'); fitView('brd'); log([{ cls: 'dim', t: 'Loaded the ' + ex.title + ' example. Press ' + (ex.build ? 'Connect & make it work' : 'Generate PCB') + ' to turn it into a board.' }], '—'); };
    menu.appendChild(b);
  }
  $('b-ex').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
  $('b-theme').onclick = () => {
    const root = document.documentElement, dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark'; try { localStorage.setItem('hammi-theme', root.dataset.theme); } catch (e) {}
    buildLib();
  };
  new ResizeObserver(resize).observe($('screen'));
  bindForms(); buildLib(); buildBlocks();

  let saved = null; try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) {}
  resize();
  if (saved && saved.parts && saved.parts.length) { load(saved); log([{ cls: 'dim', t: 'Picked up where you left off. Examples menu has ready-made circuits.' }], '—'); }
  else { load(P.examples.gadget.make()); log([{ cls: 'dim', t: 'A screen, a dial, two buttons, two LEDs and a buzzer are on the board. Press Connect & make it work, or drag them around first.' }], '—'); }
  let m0 = saved && saved.parts && saved.parts.length ? 'sch' : 'bld'; try { m0 = localStorage.getItem('hammi-pcb-mode') || m0; } catch (e) {}
  setMode(m0 === '3d' ? 'brd' : m0);
  requestAnimationFrame(() => { fitView('sch'); fitView('brd'); });
  P.app = { get project() { return pr; }, views, generate, doDrc, setMode, fitView };
})(globalThis.PCB = globalThis.PCB || {});
