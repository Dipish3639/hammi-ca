// Loose Thread: a top-down game about tying things up with thread instead of fighting.
(function () {
  'use strict';
  const W = 480, H = 272, T = 16;
  const cv = document.getElementById('game'), ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // ---------- art: every sprite is its own PNG in art/. Missing files fall back to placeholder shapes. ----------
  const ASSETS = {
    player:  { fw: 16, fh: 16, frames: 4, rows: 4 },  // rows: down, left, right, up. cols: walk cycle
    snipper: { fw: 16, fh: 16, frames: 4, rows: 1 },
    dasher:  { fw: 16, fh: 16, frames: 6, rows: 1 },  // 0-1 idle, 2 wind-up, 3-4 charge, 5 tired
    cocoon:  { fw: 16, fh: 16, frames: 2, rows: 1 },
    lantern: { fw: 16, fh: 16, frames: 3, rows: 1 },  // 0 unlit, 1-2 lit flicker
    floor:   { fw: 16, fh: 16, frames: 4, rows: 1 },
    wall:    { fw: 16, fh: 16, frames: 2, rows: 1 },
    exit:    { fw: 16, fh: 16, frames: 2, rows: 1 },  // 0 closed, 1 open
    heart:   { fw: 8,  fh: 8,  frames: 2, rows: 1 },  // 0 full, 1 empty
  };
  const IMG = {};
  for (const k in ASSETS) { const im = new Image(); im.onload = () => IMG[k] = im; im.src = (window.LT_ART && window.LT_ART[k]) || 'art/' + k + '.png'; }
  function spr(name, frame, row, x, y, flip) {
    const a = ASSETS[name], im = IMG[name];
    if (im) {
      ctx.save(); if (flip) { ctx.translate(Math.round(x) + a.fw, Math.round(y)); ctx.scale(-1, 1); x = 0; y = 0; }
      ctx.drawImage(im, (frame % a.frames) * a.fw, (row || 0) * a.fh, a.fw, a.fh, Math.round(x), Math.round(y), a.fw, a.fh); ctx.restore();
      return;
    }
    PH[name](frame, row || 0, Math.round(x), Math.round(y));
  }
  const PH = { // placeholder art
    player(f, r, x, y) { const b = f % 2; ctx.fillStyle = '#3b6fd6'; ctx.fillRect(x + 4, y + 6 + b, 8, 8); ctx.fillStyle = '#ffd9a8'; ctx.fillRect(x + 4, y + 1 + b, 8, 6);
      ctx.fillStyle = '#222'; if (r === 0) { ctx.fillRect(x + 6, y + 4 + b, 1, 1); ctx.fillRect(x + 9, y + 4 + b, 1, 1); } else if (r === 1) ctx.fillRect(x + 5, y + 4 + b, 1, 1); else if (r === 2) ctx.fillRect(x + 10, y + 4 + b, 1, 1);
      ctx.fillStyle = '#e84a8a'; ctx.fillRect(x + 11, y + 9 + b, 3, 3); },
    snipper(f, r, x, y) { ctx.fillStyle = '#7bd65a'; ctx.fillRect(x + 3, y + 5, 10, 7); ctx.fillStyle = '#2e6b1f'; const o = f % 2; ctx.fillRect(x + 1, y + 6 + o, 2, 2); ctx.fillRect(x + 13, y + 6 + o, 2, 2); ctx.fillRect(x + 1, y + 10 - o, 2, 2); ctx.fillRect(x + 13, y + 10 - o, 2, 2);
      ctx.fillStyle = '#fff'; ctx.fillRect(x + 5, y + 3, 2, 3); ctx.fillRect(x + 9, y + 3, 2, 3); },
    dasher(f, r, x, y) { const c = f === 2 ? '#ffb347' : f >= 3 && f <= 4 ? '#ff5a3c' : f === 5 ? '#a0603c' : '#d6643c'; ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x + 8, y + 1); ctx.lineTo(x + 15, y + 14); ctx.lineTo(x + 1, y + 14); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillRect(x + 6, y + 8, 2, 2); ctx.fillRect(x + 9, y + 8, 2, 2); },
    cocoon(f, r, x, y) { ctx.fillStyle = '#f2e6c9'; ctx.fillRect(x + 4 + (f ? 1 : 0), y + 3, 8, 11); ctx.fillStyle = '#e84a8a'; for (let i = 0; i < 4; i++) ctx.fillRect(x + 4 + (f ? 1 : 0), y + 4 + i * 3, 8, 1); },
    lantern(f, r, x, y) { ctx.fillStyle = '#5a4630'; ctx.fillRect(x + 5, y + 2, 6, 2); ctx.fillRect(x + 5, y + 13, 6, 2); ctx.fillStyle = f ? (f === 1 ? '#ffe27a' : '#ffd040') : '#3a3a48'; ctx.fillRect(x + 4, y + 4, 8, 9); },
    floor(f, r, x, y) { ctx.fillStyle = ['#2a2438', '#2c2639', '#29233a', '#2b2537'][f]; ctx.fillRect(x, y, 16, 16); if (f === 3) { ctx.fillStyle = '#332c44'; ctx.fillRect(x + 5, y + 7, 2, 1); } },
    wall(f, r, x, y) { ctx.fillStyle = '#4d4166'; ctx.fillRect(x, y, 16, 16); ctx.fillStyle = '#5f5180'; ctx.fillRect(x, y, 16, 4); ctx.fillStyle = '#3d3352'; if (f) ctx.fillRect(x + 3, y + 9, 5, 2); },
    exit(f, r, x, y) { ctx.fillStyle = f ? '#7ff0c8' : '#6b4f2e'; ctx.fillRect(x + 1, y + 1, 14, 14); if (!f) { ctx.fillStyle = '#3e2c18'; ctx.fillRect(x + 7, y + 1, 2, 14); } },
    heart(f, r, x, y) { ctx.fillStyle = f ? '#4a3a52' : '#ff4f7a'; ctx.fillRect(x + 1, y + 1, 2, 2); ctx.fillRect(x + 5, y + 1, 2, 2); ctx.fillRect(x, y + 2, 8, 2); ctx.fillRect(x + 1, y + 4, 6, 2); ctx.fillRect(x + 3, y + 6, 2, 1); },
  };

  // ---------- input ----------
  const keys = {};
  addEventListener('keydown', e => { keys[e.code] = true; if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault(); if (e.code === 'Enter' || e.code === 'Space') pressStart(); if (e.code === 'KeyM') toggleMute(); });
  addEventListener('keyup', e => { keys[e.code] = false; });
  const touch = { id: null, sx: 0, sy: 0, dx: 0, dy: 0, thread: false };
  const tb = document.getElementById('thread-btn');
  tb.addEventListener('pointerdown', e => { e.preventDefault(); touch.thread = true; pressStart(); });
  const upT = () => touch.thread = false; tb.addEventListener('pointerup', upT); tb.addEventListener('pointercancel', upT); tb.addEventListener('pointerleave', upT);
  cv.addEventListener('pointerdown', e => { pressStart(); if (e.pointerType === 'mouse') return; touch.id = e.pointerId; touch.sx = e.clientX; touch.sy = e.clientY; touch.dx = touch.dy = 0; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => { if (e.pointerId !== touch.id) return; touch.dx = e.clientX - touch.sx; touch.dy = e.clientY - touch.sy; });
  const endTouch = e => { if (e.pointerId === touch.id) { touch.id = null; touch.dx = touch.dy = 0; } };
  cv.addEventListener('pointerup', endTouch); cv.addEventListener('pointercancel', endTouch);
  function inputDir() {
    let x = 0, y = 0;
    if (keys.ArrowLeft || keys.KeyA) x -= 1; if (keys.ArrowRight || keys.KeyD) x += 1;
    if (keys.ArrowUp || keys.KeyW) y -= 1; if (keys.ArrowDown || keys.KeyS) y += 1;
    if (touch.id != null) { const m = Math.hypot(touch.dx, touch.dy); if (m > 8) { x = touch.dx / Math.max(m, 40); y = touch.dy / Math.max(m, 40); } }
    const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    return [x, y];
  }
  const threadHeld = () => keys.Space || keys.ShiftLeft || keys.KeyJ || touch.thread;

  // ---------- sound ----------
  let AC = null, muted = false;
  try { muted = localStorage.getItem('loosethread.muted') === '1'; } catch (e) {}
  function ac() { if (!AC) try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} if (AC && AC.state === 'suspended') AC.resume(); return AC; }
  function tone(f1, f2, dur, type, vol, delay) {
    const a = ac(); if (!a || muted) return; const t = a.currentTime + (delay || 0);
    const o = a.createOscillator(), g = a.createGain(); o.type = type || 'square';
    o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(vol || 0.06, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  const SFX = {
    cinch: (n) => { tone(300, 900, 0.18, 'triangle', 0.08); for (let i = 0; i < n; i++) tone(600 + i * 150, 1200 + i * 150, 0.12, 'square', 0.04, 0.1 + i * 0.07); },
    snip: () => tone(1400, 300, 0.1, 'sawtooth', 0.05),
    hurt: () => tone(200, 60, 0.25, 'square', 0.09),
    door: () => { tone(400, 400, 0.1, 'square', 0.05); tone(600, 600, 0.1, 'square', 0.05, 0.1); tone(800, 800, 0.2, 'square', 0.05, 0.2); },
    charge: () => tone(150, 500, 0.3, 'sawtooth', 0.04),
  };
  function toggleMute() { muted = !muted; try { localStorage.setItem('loosethread.muted', muted ? '1' : '0'); } catch (e) {} document.getElementById('mute').textContent = muted ? 'Sound off' : 'Sound on'; }
  document.getElementById('mute').onclick = () => { ac(); toggleMute(); };
  document.getElementById('mute').textContent = muted ? 'Sound off' : 'Sound on';

  // ---------- world ----------
  const S = { mode: 'title', room: 0, score: 0, hearts: 3, maxHearts: 3, t: 0, roomT: 0 };
  const SPOOL = 420;  // thread length in pixels
  let map, player, mobs, lanterns, exit, trail, cinches, fx, threadOn;
  function solid(tx, ty) { if (tx < 0 || ty < 0 || tx >= 30 || ty >= 17) return true; const c = map[ty][tx]; return c === '#' || (c === 'E' && !exit.open); }
  function hitsWall(x, y, r) {
    for (let ty = Math.floor((y - r) / T); ty <= Math.floor((y + r) / T); ty++)
      for (let tx = Math.floor((x - r) / T); tx <= Math.floor((x + r) / T); tx++) if (solid(tx, ty)) return true;
    return false;
  }
  function move(o, dx, dy) {
    if (!hitsWall(o.x + dx, o.y, o.r)) o.x += dx; else o.hitX = true;
    if (!hitsWall(o.x, o.y + dy, o.r)) o.y += dy; else o.hitY = true;
  }
  function loadRoom(i) {
    const R = ROOMS[i]; map = R.map.map(r => r); mobs = []; lanterns = []; trail = []; cinches = []; fx = []; threadOn = false; exit = { open: false };
    for (let y = 0; y < 17; y++) for (let x = 0; x < 30; x++) {
      const c = map[y][x], cx = x * T + 8, cy = y * T + 8;
      if (c === 'P') player = { x: cx, y: cy, r: 5, dir: 0, anim: 0, inv: 0, kx: 0, ky: 0 };
      else if (c === 'L') lanterns.push({ x: cx, y: cy, lit: false, t: 0 });
      else if (c === 's') mobs.push({ kind: 'snipper', x: cx, y: cy, r: 5, vx: 0, vy: 0, t: Math.random() * 2, anim: 0 });
      else if (c === 'd') mobs.push({ kind: 'dasher', x: cx, y: cy, r: 6, vx: 0, vy: 0, state: 'idle', t: 1 + Math.random(), anim: 0 });
      else if (c === 'E') { exit.x = x; exit.y = y; }
      if ('PLsd'.includes(c)) map[y] = map[y].slice(0, x) + '.' + map[y].slice(x + 1);
    }
    S.room = i; S.roomT = 0;
    showHint(R.hint);
  }
  let hintT = 0;
  function showHint(h) { const el = document.getElementById('hint'); el.textContent = h; el.hidden = false; hintT = 9; }

  // ---------- thread geometry ----------
  function segInt(a, b, c, d) {
    const r = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x); if (Math.abs(r) < 1e-9) return null;
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / r, u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / r;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null; return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  }
  function inPoly(x, y, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { if ((P[i].y > y) !== (P[j].y > y) && x < (P[j].x - P[i].x) * (y - P[i].y) / (P[j].y - P[i].y) + P[i].x) c = !c; } return c; }
  function distSeg(px, py, a, b) { const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy; let t = l ? ((px - a.x) * dx + (py - a.y) * dy) / l : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - a.x - t * dx, py - a.y - t * dy); }
  function trailLen() { let s = 0; for (let i = 1; i < trail.length; i++) s += Math.hypot(trail[i].x - trail[i - 1].x, trail[i].y - trail[i - 1].y); return s; }
  function addPoint(x, y) {
    const last = trail[trail.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 3) return;
    const np = { x, y };
    if (last) {
      for (let i = 0; i < trail.length - 4; i++) {
        const p = segInt(trail[i], trail[i + 1], last, np);
        if (p) { closeLoop([p, ...trail.slice(i + 1), p]); trail = trail.slice(0, i + 1).concat([p]); break; }
      }
    }
    trail.push(np);
    // the spool runs out: the oldest thread slips away
    let len = trailLen();
    while (len > SPOOL && trail.length > 2) { len -= Math.hypot(trail[1].x - trail[0].x, trail[1].y - trail[0].y); trail.shift(); }
  }
  function closeLoop(poly) {
    let area = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    if (Math.abs(area) / 2 < 60) return;
    const caught = [];
    for (const m of mobs) if (!m.bound && inPoly(m.x, m.y, poly)) { m.bound = true; m.t = 0; caught.push(m); }
    let lit = 0; for (const l of lanterns) if (!l.lit && inPoly(l.x, l.y, poly)) { l.lit = true; l.t = 0; lit++; }
    let cx = 0, cy = 0; poly.forEach(p => { cx += p.x; cy += p.y; }); cx /= poly.length; cy /= poly.length;
    cinches.push({ poly, cx, cy, t: 0 });
    const n = caught.length + lit;
    S.score += caught.length * 100 * Math.max(1, caught.length) + lit * 50;
    if (n) { SFX.cinch(n); if (caught.length > 1) popText(cx, cy, caught.length + 'x COMBO'); else if (caught.length) popText(cx, cy, 'TIED'); else popText(cx, cy, 'LIT'); }
    else SFX.cinch(0);
    if (lanterns.every(l => l.lit) && !exit.open) { exit.open = true; SFX.door(); showHint('All four lanterns are lit. The door is open.'); }
  }
  function popText(x, y, s) { fx.push({ kind: 'text', x, y, s, t: 0 }); }
  function snipAt(idx) {
    // everything older than the cut falls away
    const gone = trail.slice(0, idx + 1);
    for (let i = 0; i < gone.length; i += 3) fx.push({ kind: 'fray', x: gone[i].x, y: gone[i].y, t: 0, vx: (Math.random() - .5) * 20, vy: (Math.random() - .5) * 20 });
    trail = trail.slice(idx + 1); SFX.snip();
  }

  // ---------- update ----------
  function update(dt) {
    S.t += dt; S.roomT += dt; if (hintT > 0) { hintT -= dt; if (hintT <= 0) document.getElementById('hint').hidden = true; }
    if (S.mode !== 'play') return;
    // player
    const [ix, iy] = inputDir(); const sp = threadHeld() ? 78 : 92;
    player.hitX = player.hitY = false;
    move(player, (ix * sp + player.kx) * dt, (iy * sp + player.ky) * dt);
    player.kx *= Math.pow(0.002, dt); player.ky *= Math.pow(0.002, dt);
    if (ix || iy) { player.anim += dt * 8; if (Math.abs(ix) > Math.abs(iy)) player.dir = ix < 0 ? 1 : 2; else player.dir = iy < 0 ? 3 : 0; }
    if (player.inv > 0) player.inv -= dt;
    // thread
    if (threadHeld()) { if (!threadOn) { trail = []; threadOn = true; } addPoint(player.x, player.y); }
    else if (threadOn) { threadOn = false; for (let i = 0; i < trail.length; i += 4) fx.push({ kind: 'fray', x: trail[i].x, y: trail[i].y, t: 0, vx: 0, vy: 6 }); trail = []; }
    // mobs
    for (const m of mobs) {
      m.anim += dt * 8;
      if (m.bound) { m.t += dt; continue; }
      if (m.kind === 'snipper') {
        m.t -= dt;
        if (m.t <= 0) {
          m.t = 0.8 + Math.random() * 1.2;
          // sometimes they sniff out the nearest thread
          let tx = null, ty = null, best = 120;
          for (let i = 0; i < trail.length; i += 4) { const d = Math.hypot(trail[i].x - m.x, trail[i].y - m.y); if (d < best) { best = d; tx = trail[i].x; ty = trail[i].y; } }
          const a = tx != null && Math.random() < 0.7 ? Math.atan2(ty - m.y, tx - m.x) : Math.random() * Math.PI * 2;
          const v = 34 + S.room * 3; m.vx = Math.cos(a) * v; m.vy = Math.sin(a) * v;
        }
        m.hitX = m.hitY = false; move(m, m.vx * dt, m.vy * dt); if (m.hitX) m.vx *= -1; if (m.hitY) m.vy *= -1;
        for (let i = 0; i < trail.length - 1; i++) if (distSeg(m.x, m.y, trail[i], trail[i + 1]) < m.r + 1) { snipAt(i); break; }
      } else {
        const d = Math.hypot(player.x - m.x, player.y - m.y);
        m.t -= dt;
        if (m.state === 'idle') { if (d < 90 && m.t <= 0) { m.state = 'wind'; m.t = 0.55; m.ax = player.x; m.ay = player.y; } }
        else if (m.state === 'wind') { if (m.t <= 0) { m.state = 'charge'; m.t = 0.7; const a = Math.atan2(m.ay - m.y, m.ax - m.x); m.vx = Math.cos(a) * 190; m.vy = Math.sin(a) * 190; SFX.charge(); } }
        else if (m.state === 'charge') { m.hitX = m.hitY = false; move(m, m.vx * dt, m.vy * dt); if (m.hitX || m.hitY || m.t <= 0) { m.state = 'tired'; m.t = 1.6; } }
        else if (m.state === 'tired') { if (m.t <= 0) { m.state = 'idle'; m.t = 0.4; } }
        if (m.state === 'charge') for (let i = 0; i < trail.length - 1; i++) if (distSeg(m.x, m.y, trail[i], trail[i + 1]) < m.r) { snipAt(i); break; }
        if (d < m.r + player.r && player.inv <= 0 && m.state === 'charge') hurt(m);
      }
      if (m.kind === 'snipper' && Math.hypot(player.x - m.x, player.y - m.y) < m.r + player.r) { const a = Math.atan2(m.y - player.y, m.x - player.x); m.vx = Math.cos(a) * 40; m.vy = Math.sin(a) * 40; }
    }
    // lantern / cinch / fx timers
    lanterns.forEach(l => l.t += dt); cinches.forEach(c => c.t += dt); cinches = cinches.filter(c => c.t < 0.5);
    fx.forEach(f => { f.t += dt; if (f.vx != null) { f.x += f.vx * dt; f.y += f.vy * dt; } }); fx = fx.filter(f => f.t < (f.kind === 'text' ? 1 : 0.6));
    // exit
    if (exit.open) {
      const ex = exit.x * T + 8, ey = exit.y * T + 8;
      if (Math.hypot(player.x - ex, player.y - ey) < 12) {
        S.score += Math.max(0, Math.round(600 - S.roomT * 5));
        if (S.room + 1 >= ROOMS.length) { S.mode = 'won'; saveBest(); overlay('won'); }
        else { S.mode = 'between'; overlay('between'); }
      }
    }
  }
  function hurt(m) {
    S.hearts--; player.inv = 1.2; SFX.hurt();
    const a = Math.atan2(player.y - m.y, player.x - m.x); player.kx = Math.cos(a) * 260; player.ky = Math.sin(a) * 260;
    m.state = 'tired'; m.t = 1.6;
    if (S.hearts <= 0) { S.mode = 'over'; saveBest(); overlay('over'); }
  }
  function saveBest() { try { const b = +localStorage.getItem('loosethread.best') || 0; if (S.score > b) localStorage.setItem('loosethread.best', S.score); } catch (e) {} }
  function best() { try { return +localStorage.getItem('loosethread.best') || 0; } catch (e) { return 0; } }

  // ---------- draw ----------
  function draw() {
    ctx.fillStyle = '#16121f'; ctx.fillRect(0, 0, W, H);
    if (!map) return;
    for (let y = 0; y < 17; y++) for (let x = 0; x < 30; x++) {
      const c = map[y][x], h = (x * 7 + y * 13 + x * y) % 23;
      if (c === '#') spr('wall', h === 0 ? 1 : 0, 0, x * T, y * T);
      else if (c === 'E') spr('exit', exit.open ? 1 : 0, 0, x * T, y * T);
      else spr('floor', h < 15 ? 0 : h < 19 ? 1 : h < 22 ? 2 : 3, 0, x * T, y * T);
    }
    // dusk: the room darkens as the afternoon goes on
    const dusk = Math.min(0.45, S.room * 0.07 + S.roomT * 0.0015);
    // lanterns
    for (const l of lanterns) {
      if (l.lit) { const g = ctx.createRadialGradient(l.x, l.y, 2, l.x, l.y, 40); g.addColorStop(0, 'rgba(255,220,120,0.35)'); g.addColorStop(1, 'rgba(255,220,120,0)'); ctx.fillStyle = g; ctx.fillRect(l.x - 40, l.y - 40, 80, 80); }
      spr('lantern', l.lit ? 1 + (Math.floor(S.t * 6 + l.x) % 2) : 0, 0, l.x - 8, l.y - 9);
    }
    // cinching loops shrink toward their middle
    for (const c of cinches) {
      const k = 1 - c.t / 0.5; ctx.strokeStyle = `rgba(255,90,150,${k})`; ctx.lineWidth = 2; ctx.beginPath();
      c.poly.forEach((p, i) => { const x = c.cx + (p.x - c.cx) * k, y = c.cy + (p.y - c.cy) * k; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.stroke();
      ctx.fillStyle = `rgba(255,90,150,${0.15 * k})`; ctx.fill();
    }
    // thread
    if (trail.length > 1) {
      const left = 1 - trailLen() / SPOOL;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,90,150,0.35)'; ctx.lineWidth = 4; ctx.beginPath(); trail.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
      ctx.strokeStyle = left < 0.2 ? '#ffd040' : '#ff5a96'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    // mobs + player, sorted by y
    const list = mobs.map(m => ({ y: m.y, m })).concat([{ y: player.y, p: true }]).sort((a, b) => a.y - b.y);
    for (const it of list) {
      if (it.p) {
        if (player.inv > 0 && Math.floor(S.t * 20) % 2) continue;
        const f = Math.hypot(...inputDir()) ? Math.floor(player.anim) % 4 : 0;
        spr('player', f, player.dir, player.x - 8, player.y - 11);
      } else {
        const m = it.m;
        if (m.bound) spr('cocoon', Math.floor(m.t * 3) % 2, 0, m.x - 8, m.y - 10);
        else if (m.kind === 'snipper') spr('snipper', Math.floor(m.anim) % 4, 0, m.x - 8, m.y - 10, m.vx < 0);
        else { const f = m.state === 'wind' ? 2 : m.state === 'charge' ? 3 + (Math.floor(m.anim) % 2) : m.state === 'tired' ? 5 : Math.floor(m.anim / 3) % 2; spr('dasher', f, 0, m.x - 8 + (m.state === 'wind' ? Math.sin(S.t * 60) : 0), m.y - 10, (m.state === 'charge' || m.state === 'wind' ? (m.ax ?? m.x) < m.x : player.x < m.x)); }
      }
    }
    if (dusk > 0) { ctx.fillStyle = `rgba(40,10,60,${dusk})`; ctx.fillRect(0, 0, W, H); }
    for (const f of fx) {
      if (f.kind === 'fray') { ctx.fillStyle = `rgba(255,90,150,${1 - f.t / 0.6})`; ctx.fillRect(f.x, f.y, 1, 1); }
      else { ctx.fillStyle = `rgba(255,255,255,${1 - f.t})`; ctx.font = '8px "Press Start 2P", monospace'; ctx.textAlign = 'center'; ctx.fillText(f.s, f.x, f.y - 10 - f.t * 14); }
    }
    // HUD
    for (let i = 0; i < S.maxHearts; i++) spr('heart', i < S.hearts ? 0 : 1, 0, 6 + i * 10, 5);
    const lit = lanterns.filter(l => l.lit).length;
    ctx.font = '8px "Press Start 2P", monospace'; ctx.textAlign = 'left'; ctx.fillStyle = '#fff';
    ctx.fillText(`LIGHTS ${lit}/4`, 44, 12);
    ctx.textAlign = 'right'; ctx.fillText(String(S.score).padStart(6, '0'), W - 6, 12);
    ctx.textAlign = 'left'; ctx.fillText(ROOMS[S.room].name.toUpperCase(), 6, H - 5);
    // spool meter
    const left = threadOn ? 1 - trailLen() / SPOOL : 1;
    ctx.fillStyle = '#000a'; ctx.fillRect(W / 2 - 40, H - 9, 80, 4); ctx.fillStyle = left < 0.2 ? '#ffd040' : '#ff5a96'; ctx.fillRect(W / 2 - 40, H - 9, 80 * left, 4);
  }

  // ---------- screens ----------
  const ov = document.getElementById('overlay');
  function overlay(kind) {
    ov.hidden = false;
    const b = best();
    if (kind === 'title') ov.innerHTML = `<h1>Loose<br>Thread</h1><p>Hold <b>SPACE</b> to lay thread. Cross your own thread to pull the loop tight around whatever is inside.</p><p>Light four lanterns to open the door. Tie up anything in your way. You have no weapons.</p><p class="go">Press SPACE or tap to start</p>${b ? `<p class="small">Best ${b}</p>` : ''}`;
    if (kind === 'between') ov.innerHTML = `<h2>${ROOMS[S.room].name}: done</h2><p>Score ${S.score}</p><p class="go">Press SPACE for ${ROOMS[S.room + 1].name}</p>`;
    if (kind === 'over') ov.innerHTML = `<h2>Out of hearts</h2><p>You made it to ${ROOMS[S.room].name}. Score ${S.score}.</p><p class="go">Press SPACE to try again</p>`;
    if (kind === 'won') ov.innerHTML = `<h2>The afternoon is over</h2><p>Every lantern lit, nothing harmed. Score ${S.score}${S.score >= b ? ' (new best)' : ''}.</p><p class="go">Press SPACE to play again</p>`;
    S.wait = 0.4;
  }
  function pressStart() {
    ac();
    if (S.mode === 'play' || (S.wait && S.wait > 0)) return;
    keys.Space = false; touch.thread = false;
    if (S.mode === 'title' || S.mode === 'over' || S.mode === 'won') { S.score = 0; S.hearts = 3; loadRoom(0); }
    else if (S.mode === 'between') loadRoom(S.room + 1);
    S.mode = 'play'; ov.hidden = true;
  }

  // ---------- loop ----------
  let last = performance.now(), acc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now; acc += dt;
    if (S.wait > 0) S.wait -= dt;
    while (acc >= 1 / 60) { update(1 / 60); acc -= 1 / 60; }
    draw(); requestAnimationFrame(frame);
  }
  function fit() {
    const box = document.getElementById('stage'), s = Math.max(1, Math.floor(Math.min(box.clientWidth / W, (innerHeight - 140) / H) * 2) / 2);
    cv.style.width = W * s + 'px'; cv.style.height = H * s + 'px';
  }
  addEventListener('resize', fit); fit();
  loadRoom(0); S.mode = 'title'; overlay('title');
  requestAnimationFrame(frame);
  window.__LT = { S, get trail() { return trail; }, get player() { return player; }, get mobs() { return mobs; }, get lanterns() { return lanterns; }, keys, loadRoom, PH, ASSETS, ctx };
})();
