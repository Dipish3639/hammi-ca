/* hammi.ca PCB: two-layer grid autorouter.
   A* maze router on a fine grid (0.254 mm by default) with vias, a
   preferred direction per layer (top runs across, bottom runs down) and
   rip-up-and-retry passes that move failed nets to the front of the queue.
   Clearances are baked into the grid, then the DRC checks the real
   geometry afterwards, so the router never has to be trusted blindly. */
(function (P) {
  'use strict';
  const G = P.geom, M = P.model;

  function Heap() { this.f = []; this.s = []; }
  Heap.prototype.push = function (f, s) {
    const F = this.f, S = this.s; let i = F.length; F.push(f); S.push(s);
    while (i > 0) { const p = (i - 1) >> 1; if (F[p] <= f) break; F[i] = F[p]; S[i] = S[p]; i = p; }
    F[i] = f; S[i] = s;
  };
  Heap.prototype.pop = function () {
    const F = this.f, S = this.s, top = S[0], lf = F.pop(), ls = S.pop(), n = F.length;
    if (n) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && F[c + 1] < F[c]) c++; if (F[c] >= lf) break; F[i] = F[c]; S[i] = S[c]; i = c; }
      F[i] = lf; S[i] = ls;
    }
    return top;
  };

  async function autoroute(pr, opt) {
    opt = opt || {};
    const t0 = Date.now();
    const R = pr.rules, b = pr.board, g = R.grid, tw = R.trace, clr = R.clearance, vr = R.via / 2, m = 0.012;
    const viaCost = opt.viaCost != null ? opt.viaCost : 2.5;
    const passes = opt.passes || 10;
    const nets = M.computeNets(pr), info = M.boardPads(pr, nets);
    const nx = Math.floor(b.w / g) + 1, ny = Math.floor(b.h / g) + 1, N = nx * ny;
    const netId = new Map(); let k = 1;
    for (const p of info.pads) if (p.net && !netId.has(p.net)) netId.set(p.net, k++);

    function mark(map, s, rad, id) {
      const bx = G.shapeBox(s);
      const i0 = Math.max(0, Math.floor((bx[0] - rad) / g)), i1 = Math.min(nx - 1, Math.ceil((bx[2] + rad) / g));
      const j0 = Math.max(0, Math.floor((bx[1] - rad) / g)), j1 = Math.min(ny - 1, Math.ceil((bx[3] + rad) / g));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (G.ptShapeDist(i * g, j * g, s) >= rad) continue;
        const c = j * nx + i, cur = map[c];
        if (id < 0) map[c] = -1; else if (cur === 0) map[c] = id; else if (cur !== id) map[c] = -1;
      }
    }

    /* ---- base obstacle maps ---- */
    const T0 = new Int32Array(N), T1 = new Int32Array(N), V = new Int32Array(N);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const sd = G.sdBoard(i * g, j * g, b), c = j * nx + i;
      if (sd > -(R.edge + tw / 2 + m)) T0[c] = T1[c] = -1;
      if (sd > -(R.edge + vr + m)) V[c] = -1;
    }
    const padCells = [];
    info.pads.forEach((p, pi) => {
      const id = p.net ? netId.get(p.net) : -1, s = G.padShape(p);
      for (const l of p.layers) mark(l ? T1 : T0, s, clr + tw / 2 + m, id);
      mark(V, s, clr + vr + m, id);
      if (!p.drill) mark(V, s, clr, -1); // no vias in SMD pads
    });
    for (const h of info.holes) { const s = G.cap(h.x, h.y, h.x, h.y, h.d / 2); mark(T0, s, clr + tw / 2 + m, -1); mark(T1, s, clr + tw / 2 + m, -1); mark(V, s, clr + vr + m, -1); }
    info.pads.forEach((p, pi) => {
      const s = G.padShape(p), cells = [], bx = G.shapeBox(s), id = p.net ? netId.get(p.net) : -1;
      for (let j = Math.max(0, Math.floor(bx[1] / g)); j <= Math.min(ny - 1, Math.ceil(bx[3] / g)); j++)
        for (let i = Math.max(0, Math.floor(bx[0] / g)); i <= Math.min(nx - 1, Math.ceil(bx[2] / g)); i++) {
          const d = G.ptShapeDist(i * g, j * g, s);
          if (d < -Math.min(tw / 2, 0.08) || (d < 0 && cells.length === 0)) for (const l of p.layers) cells.push(l * N + j * nx + i);
        }
      if (!cells.length) { const i = Math.round(p.x / g), j = Math.round(p.y / g); if (i >= 0 && j >= 0 && i < nx && j < ny) for (const l of p.layers) cells.push(l * N + j * nx + i); }
      if (id > 0) for (const st of cells) { const l = st >= N ? 1 : 0; (l ? T1 : T0)[st - l * N] = id; }
      padCells[pi] = cells;
    });

    /* ---- connections per net (Prim order) ---- */
    const jobs = [];
    for (const [name, id] of netId) {
      const pads = []; info.pads.forEach((p, i) => { if (p.net === name) pads.push(i); });
      // pads of one pin on one part are already tied, keep one of them as the target
      const seen = new Set(), list = [];
      for (const i of pads) { const p = info.pads[i], kk = p.pid + ':' + p.pin; if (seen.has(kk)) continue; seen.add(kk); list.push(i); }
      if (list.length < 2) continue;
      const inT = [list[0]], rest = list.slice(1), order = []; let len = 0;
      while (rest.length) {
        let bi = 0, bd = 1e18, bf = 0;
        rest.forEach((ri, x) => { const a = info.pads[ri]; for (const ti of inT) { const t = info.pads[ti], d = Math.hypot(a.x - t.x, a.y - t.y); if (d < bd) { bd = d; bi = x; bf = ti; } } });
        const ri = rest.splice(bi, 1)[0]; order.push(ri); inT.push(ri); len += bd;
      }
      jobs.push({ name, id, first: list[0], order, len, allPads: pads });
    }

    /* ---- A* ---- */
    const S2 = 2 * N, gA = new Float64Array(S2), stamp = new Int32Array(S2), came = new Int32Array(S2), closed = new Int32Array(S2), tgt = new Int32Array(S2);
    let cur = 0;
    const SQ2 = Math.SQRT2;
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];

    function astar(T, Vm, sources, targets, id, tx, ty, onlyTop) {
      cur++;
      const H = new Heap();
      for (const st of targets) tgt[st] = cur;
      const hfun = (c, l) => {
        const x = c % nx, y = (c / nx) | 0, dx = Math.abs(x - tx), dy = Math.abs(y - ty);
        return g * (Math.max(dx, dy) + (SQ2 - 1) * Math.min(dx, dy)) * 1.15 + (onlyTop && l ? viaCost : 0);
      };
      for (const st of sources) { stamp[st] = cur; gA[st] = 0; came[st] = -1; const l = st >= N ? 1 : 0; H.push(hfun(st - l * N, l), st); }
      let iter = 0;
      while (H.f.length) {
        const st = H.pop();
        if (closed[st] === cur) continue; closed[st] = cur;
        if (tgt[st] === cur) { const path = []; let s = st; while (s !== -1) { path.push(s); s = came[s]; } return path.reverse(); }
        if (++iter > 4e5) return null;
        const l = st >= N ? 1 : 0, c = st - l * N, x = c % nx, y = (c / nx) | 0, Tl = T[l], base = gA[st];
        for (let d = 0; d < 8; d++) {
          const x2 = x + DX[d], y2 = y + DY[d];
          if (x2 < 0 || y2 < 0 || x2 >= nx || y2 >= ny) continue;
          const c2 = y2 * nx + x2, v = Tl[c2];
          if (v !== 0 && v !== id) continue;
          let cost;
          if (d < 4) {
            const horiz = d < 2;
            cost = g * ((l === 0) === horiz ? 1 : 1.7);
          } else {
            const a = Tl[y * nx + x2], bq = Tl[y2 * nx + x];
            if ((a !== 0 && a !== id) || (bq !== 0 && bq !== id)) continue;
            cost = g * SQ2 * 1.2;
          }
          const s2 = l * N + c2, ng = base + cost;
          if (stamp[s2] === cur && gA[s2] <= ng) continue;
          stamp[s2] = cur; gA[s2] = ng; came[s2] = st; H.push(ng + hfun(c2, l), s2);
        }
        // layer change through a via
        const vv = Vm[c];
        if (vv === 0 || vv === id) {
          const o = T[1 - l][c];
          if (o === 0 || o === id) {
            const s2 = (1 - l) * N + c, ng = base + viaCost;
            if (!(stamp[s2] === cur && gA[s2] <= ng)) { stamp[s2] = cur; gA[s2] = ng; came[s2] = st; H.push(ng + hfun(c, 1 - l), s2); }
          }
        }
      }
      return null;
    }

    function pathGeometry(path, name) {
      const traces = [], vias = [];
      let run = [];
      const flush = (l) => {
        if (run.length >= 2) {
          const pts = [];
          for (const c of run) {
            const p = [(c % nx) * g, ((c / nx) | 0) * g];
            if (pts.length >= 2) {
              const a = pts[pts.length - 2], bq = pts[pts.length - 1];
              const cr = (bq[0] - a[0]) * (p[1] - bq[1]) - (bq[1] - a[1]) * (p[0] - bq[0]);
              if (Math.abs(cr) < 1e-9) { pts[pts.length - 1] = p; continue; }
            }
            pts.push(p);
          }
          traces.push({ net: name, layer: l, w: tw, pts: pts.map(q => [+q[0].toFixed(4), +q[1].toFixed(4)]) });
        }
        run = [];
      };
      let lastL = path[0] >= N ? 1 : 0;
      for (const st of path) {
        const l = st >= N ? 1 : 0, c = st - l * N;
        if (l !== lastL) { flush(lastL); vias.push({ net: name, x: +((c % nx) * g).toFixed(4), y: +(((c / nx) | 0) * g).toFixed(4), d: R.via, drill: R.viaDrill }); lastL = l; }
        run.push(c);
      }
      flush(lastL);
      return { traces, vias };
    }

    /* straighten stair-steps into clean 0/45/90 degree runs (one layer at a time) */
    function legCells(x, y, tx, ty, Tl, id, out) {
      const sx = Math.sign(tx - x), sy = Math.sign(ty - y), ok = v => v === 0 || v === id;
      while (x !== tx || y !== ty) {
        const nxx = x + sx, nyy = y + sy;
        if (sx && sy && (!ok(Tl[y * nx + nxx]) || !ok(Tl[nyy * nx + x]))) return false;
        x = nxx; y = nyy;
        if (!ok(Tl[y * nx + x])) return false;
        out.push(y * nx + x);
      }
      return true;
    }
    function dogleg(a, b, Tl, id) {
      const ax = a % nx, ay = (a / nx) | 0, bx = b % nx, by = (b / nx) | 0, dx = bx - ax, dy = by - ay;
      const d = Math.min(Math.abs(dx), Math.abs(dy)), mx1 = ax + Math.sign(dx) * d, my1 = ay + Math.sign(dy) * d;
      const mx2 = bx - Math.sign(dx) * d, my2 = by - Math.sign(dy) * d;
      for (const [mx, my] of [[mx1, my1], [mx2, my2]]) {
        const out = [];
        if (legCells(ax, ay, mx, my, Tl, id, out) && legCells(mx, my, bx, by, Tl, id, out)) return out;
      }
      return null;
    }
    function smoothRun(cells, Tl, id) {
      const res = [cells[0]]; let i = 0;
      while (i < cells.length - 1) {
        let done = false;
        for (let j = Math.min(cells.length - 1, i + 400); j > i + 1; j--) {
          const leg = dogleg(cells[i], cells[j], Tl, id);
          if (leg) { res.push(...leg); i = j; done = true; break; }
        }
        if (!done) { res.push(cells[i + 1]); i++; }
      }
      return res;
    }
    function smoothPath(path, T, id) {
      const out = []; let run = [], rl = path[0] >= N ? 1 : 0;
      const flush = () => { if (run.length) { const sm = run.length > 2 ? smoothRun(run, T[rl], id) : run; for (const c of sm) out.push(rl * N + c); } run = []; };
      for (const st of path) { const l = st >= N ? 1 : 0; if (l !== rl) { flush(); rl = l; } run.push(st - l * N); }
      flush();
      path.length = 0; path.push(...out);
    }

    function runPass(order) {
      const T = [T0.slice(), T1.slice()], Vm = V.slice();
      const traces = [], vias = [], failed = new Map();
      let fails = 0;
      for (const job of order) {
        const tree = new Set();
        for (const st of padCells[job.first]) tree.add(st);
        for (const i of job.allPads) { const p = info.pads[i], f = info.pads[job.first]; if (p.pid === f.pid && p.pin === f.pin) for (const st of padCells[i]) tree.add(st); }
        for (const pi of job.order) {
          const p = info.pads[pi];
          const targets = [];
          for (const i of job.allPads) { const q = info.pads[i]; if (q.pid === p.pid && q.pin === p.pin) targets.push(...padCells[i]); }
          if (targets.some(st => tree.has(st))) continue;
          const path = astar(T, Vm, tree, targets, job.id, Math.round(p.x / g), Math.round(p.y / g), !p.drill);
          if (!path) { fails++; failed.set(job.name, (failed.get(job.name) || 0) + 1); continue; }
          smoothPath(path, T, job.id);
          const geo = pathGeometry(path, job.name);
          for (const t of geo.traces) {
            for (let i = 1; i < t.pts.length; i++) {
              const s = G.cap(t.pts[i - 1][0], t.pts[i - 1][1], t.pts[i][0], t.pts[i][1], tw / 2);
              mark(T[t.layer], s, clr + tw / 2 + m, job.id); mark(Vm, s, clr + vr + m, job.id);
            }
            traces.push(t);
          }
          for (const v of geo.vias) {
            const s = G.cap(v.x, v.y, v.x, v.y, vr);
            mark(T[0], s, clr + tw / 2 + m, job.id); mark(T[1], s, clr + tw / 2 + m, job.id); mark(Vm, s, clr + vr + m, job.id);
            vias.push(v);
          }
          for (const st of path) { tree.add(st); const l = st >= N ? 1 : 0; }
          for (const v of geo.vias) { const c = Math.round(v.y / g) * nx + Math.round(v.x / g); tree.add(c); tree.add(N + c); }
          for (const i of job.allPads) { const q = info.pads[i]; if (q.pid === p.pid && q.pin === p.pin) for (const st of padCells[i]) tree.add(st); }
        }
      }
      let len = 0; for (const t of traces) for (let i = 1; i < t.pts.length; i++) len += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]);
      return { traces, vias, fails, failed, len };
    }

    let order = jobs.slice().sort((a, b) => a.len - b.len);
    let best = null, pass = 0;
    for (pass = 1; pass <= passes; pass++) {
      if (opt.onProgress) { opt.onProgress(pass, passes, best ? best.fails : null); await new Promise(r => setTimeout(r, 0)); }
      const r = runPass(order);
      if (!best || r.fails < best.fails || (r.fails === best.fails && r.len + r.vias.length * 3 < best.len + best.vias.length * 3)) best = r;
      if (r.fails === 0) break;
      const failedJobs = order.filter(j => r.failed.has(j.name)), ok = order.filter(j => !r.failed.has(j.name));
      order = failedJobs.concat(ok);
      if (pass > 3) { // shake the rest of the queue a little so we don't loop on the same order
        for (let i = failedJobs.length; i < order.length - 1; i++) if (Math.random() < 0.3) { const t = order[i]; order[i] = order[i + 1]; order[i + 1] = t; }
      }
    }
    return {
      traces: best ? best.traces : [], vias: best ? best.vias : [],
      failed: best ? [...best.failed.keys()] : [], fails: best ? best.fails : 0,
      connections: jobs.reduce((s, j) => s + j.order.length, 0), nets: jobs.length,
      passes: Math.min(pass, passes), ms: Date.now() - t0, length: best ? best.len : 0
    };
  }

  P.router = { autoroute };
})(globalThis.PCB = globalThis.PCB || {});
