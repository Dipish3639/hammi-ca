// Hammi 24 front end: the broadcast graphics over the 3D view, timing, car data, and the team drawer.
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

let track = null;
let phase = null;      // { phase, nextStart, entries, last, scale, ... }
let snap = null;       // latest race snapshot
let snapAt = 0;        // performance.now() when it arrived
let me = null;         // my sign-in and team
let selected = null;   // car id shown in the car panel
let thoughts = {};     // car id -> recent thoughts
let clockSkew = 0;     // server ms - local ms
let view3d = null;     // the 3D view, when WebGL is available

const TYRE_LETTER = { soft: 'S', medium: 'M', hard: 'H', inter: 'I', wet: 'W' };

function hms(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
const raceTime = (t) => hms(t).replace(/^0/, '');
function lapTime(t) { if (!t) return '-'; const m = Math.floor(t / 60); return m + ':' + (t - m * 60).toFixed(1).padStart(4, '0'); }
function textColor(hex) { const n = parseInt(hex.slice(1), 16); const l = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); return l > 140 ? '#111' : '#fff'; }
function numBadge(c, cls = 'num') { const b = el('span', cls, String(c.number)); b.style.background = c.color; b.style.color = textColor(c.color); return b; }

async function api(method, path, body) {
  if (method !== 'GET' && !body) body = {}; // the server only accepts JSON posts
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data.error || 'error'), { status: res.status });
  return data;
}

// ---- track map ------------------------------------------------------------------
const map = $('map');
const ctx = map.getContext('2d');
let view = { s: 1, ox: 0, oy: 0 };
function sizeMap() {
  const r = map.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  map.width = Math.round(r.width * dpr); map.height = Math.round(r.height * dpr);
  const s = Math.min(map.width / 1000, map.height / 660);
  view = { s, ox: (map.width - 1000 * s) / 2, oy: (map.height - 640 * s) / 2 + 10 * s, dpr };
  if (!track) return;
}
window.addEventListener('resize', sizeMap);

function pointAt(s, offset = 0) {
  const P = track.points, n = P.length;
  const f = (((s % track.length) + track.length) % track.length) / track.step;
  const i = Math.floor(f) % n, j = (i + 1) % n, k = f - Math.floor(f);
  const x = P[i][0] + (P[j][0] - P[i][0]) * k, y = P[i][1] + (P[j][1] - P[i][1]) * k;
  if (!offset) return [x, y];
  const dx = P[j][0] - P[i][0], dy = P[j][1] - P[i][1], L = Math.hypot(dx, dy) || 1;
  return [x - (dy / L) * offset, y + (dx / L) * offset];
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function drawMap() {
  requestAnimationFrame(drawMap);
  if (!track) return;
  const { s: k, ox, oy } = view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, map.width, map.height);
  ctx.setTransform(k, 0, 0, k, ox, oy);
  const P = track.points;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // pit lane, drawn inside the main straight
  ctx.strokeStyle = css('--line'); ctx.lineWidth = 5;
  ctx.beginPath();
  for (let s = track.pitIn; s <= track.length + track.pitOut; s += 20) { const [x, y] = pointAt(s, 16); s === track.pitIn ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.stroke();
  // the circuit
  ctx.strokeStyle = css('--kerb'); ctx.lineWidth = 20;
  ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
  const wet = snap ? snap.wet : 0;
  ctx.strokeStyle = wet > 0.05 ? mix(css('--track'), '#3d6fb6', Math.min(0.7, wet)) : css('--track'); ctx.lineWidth = 15;
  ctx.stroke();
  // start/finish line
  const [ax, ay] = pointAt(0, -9), [bx, by] = pointAt(0, 9);
  ctx.strokeStyle = css('--ink'); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  // corner names
  ctx.fillStyle = css('--muted'); ctx.font = '600 15px Bricolage, sans-serif'; ctx.textAlign = 'center';
  if (map.width > 700) for (const c of track.corners) { const [x, y] = pointAt(c.at + 60, -30); ctx.fillText(c.name, x, y); }

  if (!snap) return;
  const dt = Math.min(4, (performance.now() - snapAt) / 1000) * (phase ? phase.scale : 1); // keep moving through a late update
  // draw back to front so the leader sits on top
  for (const c of snap.cars.slice().reverse()) {
    if (c.state === 'retired') continue;
    let s = c.s, off = 0;
    if (c.state === 'stopped' || c.state === 'garage') { s = 0; off = 16; }
    else { s = c.s + c.v * dt; if (c.state === 'pitlane') off = 16; }
    const [x, y] = pointAt(s, off);
    const r = c.id === selected ? 13 : 10;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = c.color; ctx.fill();
    ctx.lineWidth = c.id === selected || (me && me.team && me.team.id === c.id) ? 3 : 1.5;
    ctx.strokeStyle = c.id === selected ? css('--accent') : css('--bg'); ctx.stroke();
    ctx.fillStyle = textColor(c.color); ctx.font = `700 ${c.number > 9 ? 10 : 12}px ui-monospace, monospace`; ctx.textBaseline = 'middle';
    ctx.fillText(String(c.number), x, y + 0.5);
  }
}
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (!/^#[0-9a-f]{6}$/i.test(a)) return a;
  const A = p(a), B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
map.addEventListener('click', (e) => {
  if (!snap || !track) return;
  const r = map.getBoundingClientRect();
  const mx = ((e.clientX - r.left) * view.dpr - view.ox) / view.s, my = ((e.clientY - r.top) * view.dpr - view.oy) / view.s;
  let best = null, bd = 30;
  for (const c of snap.cars) { const [x, y] = pointAt(c.state === 'stopped' ? 0 : c.s, c.state === 'track' ? 0 : 16); const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = c; } }
  if (best) select(best.id);
});

// ---- top bar: flag, clock, conditions ----------------------------------------------------
function setFlag(kind, text) {
  const f = $('flag');
  f.className = 'flag ' + kind;
  $('flagText').textContent = text;
}
function renderHeader() {
  if (phase && phase.phase === 'break') {
    $('hour').textContent = 'BREAK';
    $('elapsed').textContent = '-:--:--'; $('left').textContent = 'between races';
    $('tod').textContent = '15:00'; $('dayNight').textContent = 'start 3 pm';
    $('weather').textContent = '-'; $('forecast').textContent = '';
    setFlag('chequered', 'BREAK');
    $('fcy').hidden = true;
    return;
  }
  if (!snap) return;
  const done = snap.status !== 'running';
  $('hour').textContent = done ? 'FINISH' : `HOUR ${Math.min(Math.floor(snap.duration / 3600), Math.floor(snap.t / 3600) + 1)}`;
  $('elapsed').textContent = raceTime(snap.t);
  $('left').textContent = done ? 'race over' : raceTime(snap.duration - snap.t) + ' to go';
  const h = Math.floor(snap.clock / 3600), m = Math.floor(snap.clock / 60) % 60;
  $('tod').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  $('dayNight').textContent = snap.night ? 'night' : 'day';
  const w = snap.wet;
  $('weather').textContent = snap.rain > 0.5 ? 'Heavy rain' : snap.rain > 0.02 ? 'Rain' : w > 0.5 ? 'Wet' : w > 0.1 ? 'Damp' : 'Dry';
  const f = snap.forecast;
  $('forecast').textContent = `track ${Math.round(w * 100)}% wet` + (f && snap.rain <= 0.02 ? ` · rain ~${f.rainIn} min` : '');
  if (done) setFlag('chequered', 'FINISH');
  else if (snap.fcy) setFlag('yellow', 'FCY');
  else setFlag(snap.night ? 'green night' : 'green', 'GREEN');
  $('fcy').hidden = !snap.fcy;
  if (snap.fcy) $('fcyWhy').textContent = `· ${snap.fcy.why}`;
  const lead = snap.cars[0];
  $('lapNo').textContent = lead ? `LAP ${lead.lap + 1}` : 'LAP -';
}

// ---- timing tower (on the picture) and the full timing table ------------------------------
let towerMode = 'gap';
let towerAll = false;
const moved = new Map(); // car id -> { pos, dir, until }
const gapText = (c) => (c.pos === 1 ? 'LEADER' : c.gapLaps > 0 ? `+${c.gapLaps} LAP${c.gapLaps > 1 ? 'S' : ''}` : '+' + c.gap.toFixed(1));
function intervalText(c, ahead) {
  if (!ahead) return 'LEADER';
  if (c.gapLaps !== ahead.gapLaps) { const d = c.gapLaps - ahead.gapLaps; return d > 0 ? `+${d} LAP${d > 1 ? 'S' : ''}` : '+' + Math.max(0, c.gap - ahead.gap).toFixed(1); }
  return '+' + Math.max(0, c.gap - ahead.gap).toFixed(1);
}
function statusBadge(c) {
  if (c.state === 'pitlane' || c.state === 'stopped' || c.state === 'garage') return el('span', 'badge pit', 'PIT');
  if (c.state === 'retired') return el('span', 'badge out', 'OUT');
  if (c.state === 'finished') return el('span', 'badge fin', 'F');
  if (c.limp) return el('span', 'badge out', 'SLOW');
  return null;
}
function tyreDot(c) { const b = el('span', 'tyre t-' + c.tyre, TYRE_LETTER[c.tyre]); b.title = `${c.tyre}, ${c.wear}% worn`; return b; }
function noteMoves() {
  const now = performance.now();
  for (const c of snap.cars) {
    const m = moved.get(c.id);
    if (m && m.pos !== c.pos) moved.set(c.id, { pos: c.pos, dir: c.pos < m.pos ? 'up' : 'down', until: now + 8000 });
    else if (!m) moved.set(c.id, { pos: c.pos, dir: null, until: 0 });
  }
}
function renderTower() {
  const ol = $('towerRows');
  if (!snap || !phase || phase.phase !== 'race') { ol.textContent = ''; return; }
  const mine = me && me.team ? me.team.id : null;
  const cars = snap.cars;
  const TOP = window.innerWidth < 760 ? 5 : 12;
  let show = towerAll ? cars.map((c, i) => i) : cars.map((c, i) => i).filter((i) => i < TOP);
  if (!towerAll) {
    for (const id of [selected, mine]) { const i = cars.findIndex((c) => c.id === id); if (i >= TOP && !show.includes(i)) show.push(i); }
    show.sort((a, b) => a - b);
  }
  const now = performance.now();
  const frag = document.createDocumentFragment();
  let prev = -1;
  for (const i of show) {
    if (prev >= 0 && i > prev + 1) frag.append(el('li', 'gap'));
    prev = i;
    const c = cars[i];
    const li = el('li');
    const m = moved.get(c.id);
    if (m && m.until > now) li.classList.add(m.dir);
    if (c.id === selected) li.classList.add('sel');
    if (c.id === mine) li.classList.add('mine');
    li.style.setProperty('--c', c.color);
    li.addEventListener('click', () => select(c.id));
    const v = el('span', 'v');
    const badge = statusBadge(c);
    if (badge && towerMode !== 'tyre') v.append(badge);
    else if (towerMode === 'gap') v.textContent = gapText(c);
    else if (towerMode === 'int') v.textContent = intervalText(c, cars[i - 1]);
    else if (towerMode === 'last') v.textContent = lapTime(c.last);
    else { v.append(tyreDot(c), document.createTextNode(c.wear + '%')); }
    li.append(el('span', 'p', String(c.pos)), el('span', 'bar'), el('span', 'n', String(c.number)), el('span', 't', c.name), v);
    frag.append(li);
  }
  ol.replaceChildren(frag);
  $('towerMore').textContent = towerAll ? 'TOP ' + TOP : 'ALL ' + cars.length + ' CARS';
}
for (const b of document.querySelectorAll('.modes button')) {
  b.addEventListener('click', () => {
    towerMode = b.dataset.mode;
    for (const x of document.querySelectorAll('.modes button')) x.setAttribute('aria-pressed', String(x === b));
    renderTower();
  });
}
$('towerMore').addEventListener('click', () => { towerAll = !towerAll; renderTower(); });

function renderRows() {
  const body = $('rows');
  if (!snap || phase.phase !== 'race') { body.textContent = ''; return; }
  noteMoves();
  renderTower();
  $('carCount').textContent = `${snap.cars.filter((c) => c.state !== 'retired').length} of ${snap.cars.length} running`;
  const mine = me && me.team ? me.team.id : null;
  let fastest = Infinity;
  for (const c of snap.cars) if (c.best && c.best < fastest) fastest = c.best;
  const frag = document.createDocumentFragment();
  snap.cars.forEach((c, i) => {
    const tr = el('tr');
    if (c.id === selected) tr.classList.add('sel');
    if (c.id === mine) tr.classList.add('mine');
    tr.addEventListener('click', () => select(c.id));
    tr.append(el('td', 'pos', String(c.pos)));
    const tdTeam = el('td', 'tl');
    const t = el('span', 'team');
    t.append(numBadge(c), el('span', '', c.name));
    const badge = statusBadge(c);
    if (badge) { badge.className = badge.className.replace('badge', 'tag'); t.append(badge); }
    tdTeam.append(t);
    tr.append(tdTeam, el('td', 'tl drv', c.driver || ''));
    tr.append(el('td', '', String(c.lap)));
    tr.append(el('td', '', c.pos === 1 ? 'LEADER' : gapText(c)));
    tr.append(el('td', '', intervalText(c, snap.cars[i - 1])));
    tr.append(el('td', c.last && c.last === c.best ? 'green' : '', lapTime(c.last)));
    tr.append(el('td', c.best && c.best === fastest ? 'purple' : '', lapTime(c.best)));
    const ty = el('td'); ty.append(tyreDot(c), document.createTextNode(' ' + c.wear + '%'));
    tr.append(ty);
    tr.append(el('td', '', c.fuel + 'L'));
    tr.append(el('td', '', String(c.pits)));
    frag.append(tr);
  });
  body.replaceChildren(frag);
}

// ---- break screen -------------------------------------------------------------------
function renderBreak() {
  const isBreak = phase && phase.phase === 'break';
  $('breakView').hidden = !isBreak;
  $('entryList').hidden = !isBreak;
  for (const sel of ['.carcard', '.tablewrap', '#tower', '#lower', '#labels', '.timing .ph']) document.querySelector(sel).hidden = isBreak;
  if (!isBreak) return;
  $('carCount').textContent = '';
  $('breakNote').textContent = `${phase.entries.length} of ${phase.grid} places taken by real teams. Bot teams fill the rest. Only teams entered before the start will race.`;
  const t = me && me.team;
  $('enterCta').hidden = !!(t && t.entered);
  $('enterCta').textContent = !me || !me.signedIn ? 'Sign in to enter a team' : !t ? 'Create a team' : 'Enter my team';
  const list = $('entryList');
  list.textContent = '';
  list.append(el('h2', '', 'Entered for the next race'));
  if (!phase.entries.length) list.append(el('p', 'note', 'No teams yet. Be the first.'));
  const ul = el('ul');
  for (const e of phase.entries) { const li = el('li'); li.append(numBadge(e), el('span', '', e.name), el('span', 'k', e.owner)); ul.append(li); }
  list.append(ul);
  if (phase.last) {
    list.append(el('h2', 'gap', `Race ${phase.last.number} results`));
    const ol = el('ul');
    for (const r of phase.last.results.slice(0, 10)) { const li = el('li'); li.append(el('span', 'k', 'P' + r.pos), numBadge(r), el('span', '', r.name), el('span', 'k', r.retired ? 'retired' : `${r.laps} laps`)); ol.append(li); }
    list.append(ol);
  }
}
function tickCountdown() {
  if (phase && phase.phase === 'break') $('countdown').textContent = hms((phase.nextStart - (Date.now() + clockSkew)) / 1000).replace(/^00:/, '');
}
setInterval(tickCountdown, 500);

// ---- selected car -------------------------------------------------------------------
async function select(id) {
  selected = id;
  if (view3d && view3d.mode === 'orbit') view3d.setMode('orbit');
  $('radio').hidden = true;
  renderRows(); renderCar();
  try {
    const d = await api('GET', '/api/car/' + encodeURIComponent(id)); thoughts[id] = d.thoughts; renderThoughts();
    const last = d.thoughts && d.thoughts[d.thoughts.length - 1];
    if (last && snap && snap.t - last.t < 600 && id === selected) showRadio(last.text);
  } catch {}
}
function renderCar() {
  if (!snap) return;
  const c = snap.cars.find((x) => x.id === selected) || snap.cars[0];
  if (!c) return;
  if (!selected) selected = c.id;
  // lower third on the picture
  const lower = $('lower');
  lower.style.setProperty('--c', c.color); lower.style.setProperty('--tc', textColor(c.color));
  $('l3Pos').textContent = 'P' + c.pos;
  $('l3Num').textContent = String(c.number);
  $('l3Team').textContent = c.name;
  $('l3Driver').textContent = `${c.driver || ''} · stint ${Math.floor(c.stint / 3600)}:${String(Math.floor(c.stint / 60) % 60).padStart(2, '0')}`;
  const ld = $('l3Data');
  const cell = (k, v, cls) => { const d = el('div'); const b = el('b', cls || ''); typeof v === 'string' ? (b.textContent = v) : b.append(...v); d.append(el('span', 'k', k), b); return d; };
  const meter = (pct, warnHigh) => { const m = el('span', 'meter'); const i = el('i'); i.style.width = Math.max(0, Math.min(100, pct)) + '%'; const bad = warnHigh ? pct : 100 - pct; if (bad > 60) i.className = bad > 85 ? 'hi' : 'mid'; m.append(i); return m; };
  let fastest = Infinity; for (const x of snap.cars) if (x.best && x.best < fastest) fastest = x.best;
  const badge = statusBadge(c);
  ld.replaceChildren(
    c.pos === 1 && snap.cars[1] ? cell('Lead', '+' + (snap.cars[1].gapLaps ? snap.cars[1].gapLaps + ' LAP' : snap.cars[1].gap.toFixed(1))) : cell('Gap', gapText(c)),
    cell('Speed', badge && c.state !== 'finished' ? [badge] : [document.createTextNode(Math.round(c.v * 3.6) + ' km/h')]),
    cell('Last lap', lapTime(c.last)),
    cell('Best lap', lapTime(c.best), c.best && c.best === fastest ? 'purple' : ''),
    cell('Tyre', [tyreDot(c), document.createTextNode(c.wear + '%')]),
    cell('Fuel', [meter(c.fuel / 90 * 100, false), document.createTextNode(c.fuel + 'L')]),
  );

  // car data panel
  $('carSub').textContent = `${c.personality} AI${c.bot ? ' · bot team' : ''}`;
  const head = $('carHead');
  head.textContent = '';
  const box = el('div');
  box.append(el('h2', '', c.name), el('div', 'k', `P${c.pos} · lap ${c.lap}${c.plan ? ' · boxing: ' + c.plan.join(', ') : ''}`));
  head.append(numBadge(c), box);
  const st = $('carStats');
  st.textContent = '';
  const stat = (k, v, bar) => {
    const d = el('div', 'stat'); d.append(el('span', 'k', k), el('b', '', v));
    if (bar !== undefined) { const b = el('div', 'bar'); const i = el('i'); i.style.width = Math.min(100, bar) + '%'; if (bar > 60) i.className = bar > 85 ? 'hi' : 'mid'; b.append(i); d.append(b); }
    st.append(d);
  };
  stat('Tyres', `${c.tyre} ${c.wear}%`, c.wear);
  stat('Fuel', `${c.fuel} L`, 100 - c.fuel / 90 * 100);
  stat('Damage', `${c.damage}%`, c.damage);
  stat('Last lap', lapTime(c.last));
  stat('Best lap', lapTime(c.best));
  stat('Speed', c.state === 'stopped' ? 'In pits' : Math.round(c.v * 3.6) + ' km/h');
  const crew = el('div', 'crew');
  for (const d of c.crew || []) {
    const row = el('div', d.name === c.driver ? 'on' : '');
    const b = el('div', 'bar'); const i = el('i'); i.style.width = d.tired + '%'; if (d.tired > 40) i.className = d.tired > 70 ? 'hi' : 'mid'; b.append(i);
    row.append(el('span', '', (d.name === c.driver ? '▶ ' : '') + d.name + (d.name === c.driver ? ` · ${Math.floor(c.stint / 60)} min` : '')), b, el('span', 'k', d.tired + '%'));
    crew.append(row);
  }
  const cw = el('div', 'stat'); cw.style.gridColumn = '1 / -1'; cw.append(el('span', 'k', 'Drivers and tiredness'), crew); st.append(cw);
}

// ---- team radio bubble and race control banner on the picture ---------------------------------
let radioTimer = null;
function showRadio(text) {
  const r = $('radio');
  $('radioText').textContent = text;
  r.hidden = false;
  r.style.animation = 'none'; void r.offsetWidth; r.style.animation = '';
  clearTimeout(radioTimer);
  radioTimer = setTimeout(() => { r.hidden = true; }, 9000);
}
const rcQueue = [];
let rcBusy = false;
function showRc(e) {
  if (e.kind === 'radio') return; // the car's own words go in the team radio bubble
  rcQueue.push(e);
  if (rcQueue.length > 4) rcQueue.shift();
  if (!rcBusy) nextRc();
}
function nextRc() {
  const e = rcQueue.shift();
  const b = $('rcBanner');
  if (!e) { rcBusy = false; b.hidden = true; return; }
  rcBusy = true;
  b.className = 'rcbanner ' + (e.kind || '');
  $('rcText').textContent = e.text;
  b.hidden = false;
  b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
  setTimeout(nextRc, 6000);
}
function renderThoughts() {
  const ol = $('thoughts');
  ol.textContent = '';
  const list = (thoughts[selected] || []).slice().reverse();
  if (!list.length) ol.append(el('li', '', 'Nothing yet.'));
  const c = snap && snap.cars.find((x) => x.id === selected);
  if (c) ol.style.setProperty('--c', c.color);
  for (const t of list) { const li = el('li'); li.append(el('time', '', raceTime(t.t)), document.createTextNode(t.text)); ol.append(li); }
}

// ---- race control feed ---------------------------------------------------------------
function addFeed(e, top = true) {
  const li = el('li', e.kind);
  li.append(el('time', '', raceTime(e.t)), document.createTextNode(e.text));
  const ol = $('feed');
  top ? ol.prepend(li) : ol.append(li);
  while (ol.children.length > 120) ol.lastChild.remove();
}

// ---- live stream ---------------------------------------------------------------------
async function loadRace() {
  const d = await api('GET', '/api/race');
  clockSkew = d.now - Date.now();
  phase = d;
  snap = d.race; snapAt = performance.now();
  thoughts = d.thoughts || {};
  $('feed').textContent = '';
  for (const e of (d.feed || []).slice().reverse()) addFeed(e, false);
  renderAll();
  if (snap) select(selected && snap.cars.some((c) => c.id === selected) ? selected : (me && me.team && snap.cars.some((c) => c.id === me.team.id) ? me.team.id : snap.cars[0].id));
}
function renderAll() { renderHeader(); renderRows(); renderBreak(); renderCar(); renderThoughts(); }

function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('phase', (m) => {
    const d = JSON.parse(m.data);
    const changed = !phase || phase.phase !== d.phase;
    phase = { ...phase, ...d };
    clockSkew = d.now - Date.now();
    if (changed) loadRace().then(loadMe); else renderAll();
  });
  es.addEventListener('snap', (m) => { snap = JSON.parse(m.data); snapAt = performance.now(); if (view3d) view3d.noteSnap(); if (phase && phase.phase !== 'race') { loadRace(); return; } renderHeader(); renderRows(); renderCar(); });
  es.addEventListener('tick', (m) => { const d = JSON.parse(m.data); clockSkew = d.now - Date.now(); if (phase) phase.nextStart = d.nextStart; });
  es.addEventListener('voice', (m) => { if (window.Commentary) Commentary.onVoice(JSON.parse(m.data)); });
  es.addEventListener('feed', (m) => { const e = JSON.parse(m.data); addFeed(e); showRc(e); });
  es.addEventListener('thought', (m) => {
    const d = JSON.parse(m.data);
    (thoughts[d.car] = thoughts[d.car] || []).push({ t: d.t, text: d.text });
    if (thoughts[d.car].length > 40) thoughts[d.car].shift();
    if (d.car === selected) { renderThoughts(); showRadio(d.text); }
  });
}

// ---- my team drawer ---------------------------------------------------------------------
function openDrawer(open) {
  $('drawer').hidden = !open; $('scrim').hidden = !open;
  $('teamBtn').setAttribute('aria-expanded', String(open));
  if (open) loadMe();
}
$('teamBtn').addEventListener('click', () => openDrawer(true));
$('closeDrawer').addEventListener('click', () => openDrawer(false));
$('scrim').addEventListener('click', () => openDrawer(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('drawer').hidden) openDrawer(false); });
$('enterCta').addEventListener('click', async () => {
  if (me && me.team) { await api('POST', '/api/team/enter', { in: true }).then((d) => { me = d; renderMe(); renderBreak(); }).catch(() => {}); return; }
  openDrawer(true);
});

async function loadMe() { try { me = await api('GET', '/api/me'); renderMe(); renderBreak(); } catch {} }

let loginTimer = null;
function renderMe() {
  if (!me) return;
  const t = me.team;
  $('signedOut').hidden = me.signedIn;
  $('noTeam').hidden = !me.signedIn || !!t;
  $('hasTeam').hidden = !t;
  $('teamBtn').textContent = t ? t.name : 'My team';
  if (me.signedIn) { clearInterval(loginTimer); loginTimer = null; $('loginNote').hidden = true; }
  $('hello').textContent = `Signed in as ${me.user}. Your team will be called "${me.user}" to start with.`;
  if (!t) return;
  // entry box
  const eb = $('entryBox'); eb.textContent = '';
  const box = el('div', 'entry');
  if (phase && phase.phase === 'break') {
    box.append(el('h2', '', 'Next race'));
    box.append(el('p', 'state' + (t.entered ? ' yes' : ''), t.entered ? 'Your team is entered.' : 'Not entered yet.'));
    box.append(el('p', 'note', 'Enter during the break before each race. Teams that are not entered sit that race out.'));
    const b = el('button', t.entered ? 'ghost small' : 'primary', t.entered ? 'Withdraw' : 'Enter the next race');
    b.addEventListener('click', async () => { try { me = await api('POST', '/api/team/enter', { in: !t.entered }); renderMe(); } catch (e) { b.textContent = e.message === 'grid_full' ? 'The grid is full' : 'Try again'; } });
    box.append(b);
  } else {
    box.append(el('h2', '', 'This race'));
    box.append(el('p', 'state' + (t.racing ? ' yes' : ''), t.racing ? 'Your car is racing. Strategy changes apply right away.' : 'Your team is not in this race. You can enter in the hour after it finishes.'));
  }
  eb.append(box);
  $('boxBtn').hidden = !t.racing;
  $('ownerStart').hidden = !me.owner;
  $('ownerStart').textContent = phase && phase.phase === 'race' ? 'Restart the race now (owner)' : 'Start the race now (owner)';

  if (!document.activeElement || !$('teamForm').contains(document.activeElement)) {
    $('tName').value = t.name; $('tNumber').value = t.number;
    t.drivers.forEach((d, i) => { if ($('d' + i)) $('d' + i).value = d; });
    const sw = $('swatches'); sw.textContent = '';
    for (const c of me.colors) {
      const b = el('button'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', 'Colour ' + c); b.setAttribute('aria-pressed', String(c === t.color));
      b.addEventListener('click', () => { for (const x of sw.children) x.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-pressed', 'true'); sw.dataset.color = c; });
      sw.append(b);
    }
    sw.dataset.color = t.color;
  }
  if (!$('stratForm').contains(document.activeElement)) fillStrategy(t.strategy, t.personality);
  $('stats').textContent = `${t.stats.races} races · ${t.stats.wins} wins · ${t.stats.podiums} podiums${t.stats.best ? ' · best P' + t.stats.best : ''}`;
  $('whoami').textContent = `Signed in with Velora as ${me.user}.`;
}

function fillStrategy(s, pers) {
  $('sStint').value = String(s.stintHours);
  $('sWear').value = s.tyreChangeAt; $('sDouble').checked = s.doubleStint;
  $('sTyre').value = s.dryTyre; $('sRes').value = s.fuelReserve; $('sLoad').value = s.fuelLoad;
  $('sAgg').value = s.aggression; $('sNight').value = String(s.nightAggression);
  $('sRain').value = s.rainCall; $('sTraffic').value = s.traffic;
  $('sYellow').checked = s.pitUnderYellow; $('sPush').checked = s.finalPush; $('sPers').value = pers;
  outputs();
}
function outputs() {
  $('oWear').textContent = $('sWear').value + '%';
  $('oRes').textContent = $('sRes').value + ($('sRes').value === '1' ? ' lap' : ' laps');
  $('oAgg').textContent = $('sAgg').value;
}
for (const id of ['sWear', 'sRes', 'sAgg']) $(id).addEventListener('input', outputs);

const ERR = { name_taken: 'That name is taken.', bad_name: 'Names can use letters, numbers, spaces and . _ - \' &, up to 24 characters.', number_taken: 'That number is taken.', bad_number: 'Pick a number from 1 to 99.', bad_driver_name: 'Driver names: letters, spaces and . \' - only, up to 20 characters.', slow_down: 'Too many changes, wait a moment.', signed_out: 'Please sign in again.' };

$('teamForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('teamMsg').textContent = 'Saving…';
  try {
    me = await api('POST', '/api/team', { name: $('tName').value, number: Number($('tNumber').value), color: $('swatches').dataset.color, drivers: [0, 1, 2].map((i) => $('d' + i).value) });
    $('teamMsg').textContent = 'Saved.';
    document.activeElement.blur(); renderMe();
  } catch (err) { $('teamMsg').textContent = ERR[err.message] || 'Could not save: ' + err.message; }
});
$('stratForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('stratMsg').textContent = 'Sending to the car…';
  const s = {
    stintHours: Number($('sStint').value), tyreChangeAt: Number($('sWear').value), doubleStint: $('sDouble').checked,
    dryTyre: $('sTyre').value, fuelReserve: Number($('sRes').value), fuelLoad: $('sLoad').value,
    aggression: Number($('sAgg').value), nightAggression: Number($('sNight').value), rainCall: $('sRain').value,
    traffic: $('sTraffic').value, pitUnderYellow: $('sYellow').checked, finalPush: $('sPush').checked,
  };
  try {
    await api('POST', '/api/team', { personality: $('sPers').value });
    me = await api('POST', '/api/team/strategy', s);
    $('stratMsg').textContent = me.team.racing ? 'Saved. The car has the new plan.' : 'Saved.';
    document.activeElement.blur(); renderMe();
  } catch (err) { $('stratMsg').textContent = ERR[err.message] || 'Could not save: ' + err.message; }
});
$('boxBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/team/box'); $('boxBtn').textContent = 'Boxing this lap'; setTimeout(() => { $('boxBtn').textContent = 'Box this lap'; }, 8000); } catch { $('boxBtn').textContent = 'Not racing'; }
});
$('createBtn').addEventListener('click', async () => { try { me = await api('POST', '/api/team', {}); renderMe(); renderBreak(); } catch (e) { $('hello').textContent = 'Could not create the team: ' + e.message; } });
$('logoutBtn').addEventListener('click', async () => { me = await api('POST', '/api/logout'); renderMe(); });
$('ownerStart').addEventListener('click', async () => {
  const restart = phase && phase.phase === 'race';
  if (restart && !confirm('Throw away this race and start a fresh one? Every team in it, and yours, goes back on the grid.')) return;
  try { await api('POST', restart ? '/api/owner/restart' : '/api/owner/start'); openDrawer(false); await loadRace(); await loadMe(); }
  catch (e) { $('ownerStart').textContent = 'Could not start: ' + e.message; }
});

$('loginBtn').addEventListener('click', async () => {
  const w = window.open('about:blank', '_blank');
  try {
    const { loginUrl } = await api('POST', '/api/login');
    if (w) { w.opener = null; w.location = loginUrl; } else window.open(loginUrl, '_blank', 'noopener');
    $('loginLink').href = loginUrl; $('loginNote').hidden = false;
    clearInterval(loginTimer);
    let n = 0;
    loginTimer = setInterval(async () => { if (++n > 200) { clearInterval(loginTimer); return; } await loadMe(); }, 2000);
  } catch (e) { if (w) w.close(); $('loginNote').hidden = false; $('loginNote').textContent = e.message === 'slow_down' ? 'Too many sign-in attempts. Wait a few minutes and try again.' : e.message === 'bad_origin' ? 'Sign-in was blocked (origin check). Reload the page and try again.' : 'Velora sign-in failed (' + (e.status || '') + ' ' + e.message + '). Try again in a minute.'; }
});

// ---- commentary booth ----------------------------------------------------------------------------
(function setupCommentary() {
  const C = window.Commentary, btn = $('voiceBtn');
  if (!C) { btn.hidden = true; return; }
  let capTimer = null;
  C.setHooks({
    getMine: () => (me && me.team ? me.team.id : null),
    onLine: (who, text, dur) => {
      clearTimeout(capTimer);
      if (!who) { $('caption').hidden = true; return; }
      $('capWho').textContent = who; $('capText').textContent = text; $('caption').hidden = false;
      capTimer = setTimeout(() => { $('caption').hidden = true; }, ((dur || text.length * 0.065) + 1.5) * 1000);
    },
  });
  btn.addEventListener('click', () => {
    const v = !C.on;
    C.setOn(v);
    btn.setAttribute('aria-pressed', String(v));
  });
})();

// ---- start --------------------------------------------------------------------------------
(async () => {
  sizeMap();
  track = await api('GET', '/api/track');
  start3d();
  await loadMe();
  await loadRace();
  connect();
  drawMap();
})();

// ---- 3D view ----------------------------------------------------------------------------------
function start3d() {
  const scene = $('scene');
  let ok = false;
  try { ok = !!window.Race3D && !!document.createElement('canvas').getContext('webgl2'); } catch {}
  if (!ok) { document.body.classList.add('no3d'); sizeMap(); return; }
  try {
    view3d = window.Race3D.createView({
      canvas: scene, track, labels: $('labels'),
      getSnap: () => (phase && phase.phase === 'race' ? snap : null),
      getScale: () => (phase ? phase.scale : 1),
      getSelected: () => selected,
      onSelect: (id) => select(id),
    });
    $('cams').hidden = false;
    for (const b of $('cams').querySelectorAll('button')) {
      b.addEventListener('click', () => {
        view3d.setMode(b.dataset.cam);
        for (const x of $('cams').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
      });
    }
  } catch (e) { console.error(e); document.body.classList.add('no3d'); }
  sizeMap();
}
