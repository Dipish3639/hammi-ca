// Hammi 24: a daily endurance race on race.hammi.ca.
// Sign in with Velora, make a team, enter it during the one-hour break between races, and set its
// strategy. The cars' AIs drive, decide and talk. Empty grid slots are filled with bot teams.
// No dependencies: needs Node 18 or newer.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./sim');
const { createBooth } = require('./booth');
const { fork } = require('child_process');

// ---- config ------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3200);
const VELORA = (process.env.VELORA_URL || 'https://velora.ikelene.net').replace(/\/+$/, '');
const PROJECT_NAME = process.env.PROJECT_NAME || 'Hammi 24';
const RACE_HOURS = Number(process.env.RACE_HOURS || 12);
// Races start every day at START_AT in RACE_TZ, and the track clock shows that same local time.
// START_AT= (empty) goes back to starting BREAK_MINUTES after each finish.
const START_AT = process.env.START_AT ?? '09:00';
const RACE_TZ = process.env.RACE_TZ || 'America/Edmonton';
const BREAK_MINUTES = Number(process.env.BREAK_MINUTES || 60);
const GRID = Number(process.env.GRID || 30);
const TIME_SCALE = Number(process.env.TIME_SCALE || 1); // 1 = real time. Only change it for testing.
const OWNER = (process.env.OWNER || '').toLowerCase();  // Velora username that may start races early
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE !== '0';
// Profile (1) only: the race is free, so it never asks to spend credits. Sent in the high half like Pixel Wall.
const PERMISSIONS = Number(process.env.VELORA_PERMISSIONS || 1 * 65536);
// Commentary voices (Kokoro). TTS=0 turns the neural voices off; viewers then hear their browser's voices.
const TTS = process.env.TTS !== '0';
const BOOTH_VOICES = (process.env.BOOTH_VOICES || 'bm_george,af_heart').split(',');
const TTS_MAX_MB = Number(process.env.TTS_MAX_MB || 680); // the voice process is stopped if it grows past this

function die(m) { console.error(m); process.exit(1); }
if (!(RACE_HOURS > 0 && RACE_HOURS <= 48)) die('RACE_HOURS must be between 0 and 48.');
if (!(BREAK_MINUTES >= 1 && BREAK_MINUTES <= 1440)) die('BREAK_MINUTES must be 1 to 1440.');
if (START_AT && !/^([01]\d|2[0-3]):[0-5]\d$/.test(START_AT)) die('START_AT must look like 09:00, or be empty.');
try { new Intl.DateTimeFormat('en', { timeZone: RACE_TZ }); } catch { die('RACE_TZ is not a known time zone.'); }
const DAILY = !!START_AT && TIME_SCALE === 1;

// ---- daily schedule ----------------------------------------------------------
// local wall-clock time in RACE_TZ, as if it were UTC (so Date.UTC arithmetic works on it)
function wallOf(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: RACE_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
// the next time the local clock reads hh:mm (DST-safe: the offset is checked at the target too)
function nextLocal(hhmm, from = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const wall = wallOf(from);
  const d = new Date(wall);
  let target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
  if (target <= wall) target += 86400000;
  let ms = target - (wall - from);
  ms = target - (wallOf(ms) - ms);
  return ms;
}
const localSecondsOfDay = (ms = Date.now()) => Math.floor((wallOf(ms) % 86400000) / 1000);
function scheduleNext() {
  return DAILY ? nextLocal(START_AT) : Date.now() + BREAK_MINUTES * 60 * 1000 / Math.min(TIME_SCALE, 60);
}
if (!Number.isInteger(GRID) || GRID < 2 || GRID > 60) die('GRID must be a whole number from 2 to 60.');
if (!(TIME_SCALE > 0 && TIME_SCALE <= 2000)) die('TIME_SCALE must be above 0 and at most 2000.');

const COLORS = ['#e8443a', '#f08a24', '#f2c230', '#8fd14f', '#2fb36d', '#20b8c4', '#2f7de1', '#5b5ff0', '#a45ee5', '#e05fae', '#f4f4f4', '#9aa3b5', '#c9a36b', '#3c4a63'];
const BOT_NAMES = [
  'Vortex Racing', 'Apex Motorsport', 'Redline Works', 'Nightjar GT', 'Kestrel Endurance', 'Blue Comet', 'Iron Lynx', 'Sundown Racing',
  'Halcyon Motors', 'Polar Star', 'Copperhead', 'Magpie Racing', 'Saltflat Speed', 'Orion Team', 'Granite GT', 'Tidewater', 'Falcon Ridge',
  'Lantern Racing', 'Cinder Works', 'Northwind', 'Pebble Bay', 'Thunder Valley', 'Quicksilver', 'Mosswood', 'Harbour Lights', 'Black Swan',
  'Sable Racing', 'Riverbend', 'Aurora Endurance', 'Zephyr Works', 'Old Oak GT', 'Marlin Motors', 'Ember Racing', 'Glasshouse', 'Highline',
];
const FIRST = ['Ana', 'Ben', 'Chen', 'Dara', 'Eli', 'Femi', 'Gus', 'Hana', 'Ivo', 'Jade', 'Kai', 'Lea', 'Milo', 'Nia', 'Oskar', 'Pia', 'Quinn', 'Rafa', 'Sana', 'Tomas', 'Uma', 'Vik', 'Wren', 'Yara', 'Zed'];
const LAST = ['Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Silva', 'Novak', 'Haddad', 'Kowalski', 'Byrne', 'Rossi', 'Petrov', 'Nakamura', 'Duarte', 'Fischer', 'Kaur', 'Mensah', 'Larsen', 'Ito'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const driverName = () => pick(FIRST) + ' ' + pick(LAST);

// ---- state -------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const RACE_FILE = path.join(DATA_DIR, 'race.json');

const teams = new Map();     // id -> team
const sessions = new Map();  // sid -> { sid, user, token, login, seen }
let entries = [];            // team ids entered for the next race, in entry order
let history = [];            // finished race results, newest first
let race = null;             // the race on track, or null during the break
let nextStart = 0;           // ms timestamp the next race starts (during the break)
let raceCount = 0;

try {
  const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  for (const t of st.teams || []) teams.set(t.id, { ...t, strategy: S.sanitizeStrategy(t.strategy) });
  for (const [sid, v] of Object.entries(st.sessions || {})) sessions.set(sid, { sid, user: v.user, token: null, login: null, seen: v.seen });
  entries = (st.entries || []).filter((id) => teams.has(id));
  history = st.history || [];
  nextStart = st.nextStart || 0;
  raceCount = st.raceCount || 0;
} catch { /* first run */ }
try { race = JSON.parse(fs.readFileSync(RACE_FILE, 'utf8')); race.events = []; } catch { race = null; }
if (race && race.status !== 'running') race = null;
if (!race && !nextStart) nextStart = scheduleNext();
// a waiting start from the old break schedule moves to the daily slot
if (DAILY && !race && nextStart > Date.now() && Math.abs(nextStart - nextLocal(START_AT)) > 60000) nextStart = nextLocal(START_AT);

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function saveNow() {
  const sess = {};
  for (const [sid, s] of sessions) if (s.user) sess[sid] = { user: s.user, seen: s.seen }; // never the Velora token
  atomicWrite(STATE_FILE, JSON.stringify({ teams: [...teams.values()], sessions: sess, entries, history: history.slice(0, 30), nextStart, raceCount }));
  if (race) { const { events, ...rest } = race; void events; atomicWrite(RACE_FILE, JSON.stringify(rest)); }
  else { try { fs.unlinkSync(RACE_FILE); } catch {} }
}
let saveTimer = null;
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; try { saveNow(); } catch (e) { console.error('save failed', e.message); } }, 2000); }
setInterval(() => { try { saveNow(); } catch (e) { console.error('save failed', e.message); } }, 30 * 1000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { saveNow(); } catch {} process.exit(0); });

// ---- teams -------------------------------------------------------------------
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'&-]{0,23}$/;
const DRIVER_RE = /^[A-Za-z][A-Za-z .'-]{0,19}$/;

function teamOf(user) {
  if (!user) return null;
  const low = user.toLowerCase();
  for (const t of teams.values()) if (t.owner === low) return t;
  return null;
}
function nameTaken(name, exceptId) {
  const low = name.toLowerCase();
  for (const t of teams.values()) if (t.id !== exceptId && t.name.toLowerCase() === low) return true;
  if (BOT_NAMES.some((b) => b.toLowerCase() === low)) return true;
  return false;
}
function freeNumber() {
  const used = new Set([...teams.values()].map((t) => t.number));
  for (let n = 2; n < 100; n++) if (!used.has(n)) return n;
  return 1 + Math.floor(Math.random() * 99);
}
function createTeam(user) {
  let name = user.replace(/[^A-Za-z0-9 _.'&-]/g, '').slice(0, 24) || 'Team';
  if (!/^[A-Za-z0-9]/.test(name)) name = 'Team ' + name;
  let n = 2, base = name;
  while (nameTaken(name)) name = (base.slice(0, 20) + ' ' + n++).trim();
  const t = {
    id: crypto.randomBytes(6).toString('hex'), owner: user.toLowerCase(), ownerName: user, name,
    color: pick(COLORS), number: freeNumber(), drivers: [user.slice(0, 20), driverName(), driverName()],
    personality: 'calculated', strategy: S.sanitizeStrategy({}), created: Date.now(),
    stats: { races: 0, wins: 0, podiums: 0, best: 0 },
  };
  teams.set(t.id, t);
  saveSoon();
  return t;
}

// Bot teams exist only inside a race, so their strategy is rolled fresh each time.
const botStrategies = new Map();
function strategyOf(id) {
  const t = teams.get(id);
  return t ? t.strategy : (botStrategies.get(id) || S.DEFAULT_STRATEGY);
}

// ---- race lifecycle ----------------------------------------------------------
function startRace() {
  booth.reset();
  raceCount += 1;
  race = S.newRace({ duration: RACE_HOURS * 3600, number: raceCount, startClock: DAILY ? localSecondsOfDay() : undefined });
  race.events = [];
  botStrategies.clear();
  const field = entries.map((id) => teams.get(id)).filter(Boolean).slice(0, GRID);
  const used = new Set(field.map((t) => t.name.toLowerCase()));
  const bots = BOT_NAMES.filter((n) => !used.has(n.toLowerCase())).sort(() => Math.random() - 0.5);
  const numbers = new Set(field.map((t) => t.number));
  while (field.length < GRID && bots.length) {
    let num; do { num = 2 + Math.floor(Math.random() * 98); } while (numbers.has(num)); numbers.add(num);
    const bot = { id: 'bot-' + crypto.randomBytes(4).toString('hex'), name: bots.pop(), color: pick(COLORS), number: num, bot: true, drivers: [driverName(), driverName(), driverName()], personality: pick(S.PERSONALITIES) };
    botStrategies.set(bot.id, S.randomStrategy());
    field.push(bot);
  }
  field.sort(() => Math.random() - 0.5); // random grid
  field.forEach((t, i) => race.cars.push(S.newCar(t, { start: true, grid: i })));
  race.botStrategies = Object.fromEntries(botStrategies);
  entries = [];
  nextStart = 0;
  S.note(race, `Race ${race.number} is go! ${race.cars.length} cars, ${RACE_HOURS} hours.`, 'flag');
  lastTick = Date.now();
  saveNow();
  console.log(`race ${race.number} started with ${race.cars.length} cars`);
}
if (race && race.botStrategies) for (const [k, v] of Object.entries(race.botStrategies)) botStrategies.set(k, v);

function endRace() {
  const res = { number: race.number, finishedAt: Date.now(), results: race.results };
  history.unshift(res);
  history = history.slice(0, 30);
  for (const r of race.results) {
    const t = teams.get(r.id);
    if (!t) continue;
    t.stats.races += 1;
    if (r.pos === 1) t.stats.wins += 1;
    if (r.pos <= 3) t.stats.podiums += 1;
    if (!t.stats.best || r.pos < t.stats.best) t.stats.best = r.pos;
  }
  broadcast('feed', { t: race.simTime, text: race.feed[race.feed.length - 1]?.text || 'Race over.', kind: 'lead' });
  race = null;
  nextStart = scheduleNext();
  saveNow();
  broadcastPhase();
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (!race) {
    lastTick = now;
    if (now >= nextStart) startRace();
    return;
  }
  let dt = Math.min(5, (now - lastTick) / 1000) * TIME_SCALE; // after a long pause the race just carries on
  lastTick = now;
  while (dt > 0 && race.status === 'running') {
    const d = Math.min(0.5, dt);
    S.step(race, d, strategyOf);
    dt -= d;
  }
  for (const e of race.events) { broadcast(e.type, e); if (e.type === 'feed' && clients.size) booth.onFeed(e, boothSnap); }
  race.events = [];
  if (race.status === 'finished') endRace();
}, 250);

// ---- live updates (Server-Sent Events, works over HTTPS through the tunnel) ----
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
function phaseInfo() {
  return {
    phase: race ? 'race' : 'break', scale: TIME_SCALE, grid: GRID, hours: RACE_HOURS,
    nextStart: race ? null : nextStart, now: Date.now(),
    entries: race ? [] : entries.map((id) => teams.get(id)).filter(Boolean).map(publicTeam),
    last: history[0] || null,
  };
}
function broadcastPhase() { broadcast('phase', phaseInfo()); }
setInterval(() => {
  if (race) { boothSnap = S.snapshot(race); broadcast('snap', boothSnap); if (clients.size) booth.onSnap(boothSnap); }
  else broadcast('tick', { now: Date.now(), nextStart });
}, 500); // twice a second so cars move smoothly between updates
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

// ---- commentary booth: lines from booth.js, voiced by tts-worker.js, sent to every viewer ----
const voiceClips = new Map(); // id -> wav Buffer, the last few lines only
// a short silent clip that phones play inside the "commentary on" tap, to unlock audio
const SILENCE = (() => { const n = 4800, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return b; })();
let tts = null;               // { child, ready, waiting: Map(id -> resolve) }
let ttsRecycles = [];         // times the voice process was restarted for memory, last hour
function startTts() {
  if (!TTS) return;
  try { require.resolve('kokoro-js'); } catch { console.log('commentary: kokoro-js is not installed, viewers will hear browser voices'); return; }
  // few malloc arenas: onnxruntime threads otherwise each keep their own and memory balloons
  const child = fork(path.join(__dirname, 'tts-worker.js'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, MALLOC_ARENA_MAX: '2', MALLOC_TRIM_THRESHOLD_: '131072' } });
  const me = { child, ready: false, waiting: new Map() };
  tts = me;
  try { require('os').setPriority(child.pid, 10); } catch {} // the race comes first
  // memory guard: ikelene is small, so the voices never get to crowd out the race or Pixel Wall
  const guard = setInterval(() => {
    try {
      const kb = Number((fs.readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/) || [])[1]);
      if (kb / 1024 > TTS_MAX_MB) { console.error(`commentary: voice process used ${Math.round(kb / 1024)} MB (limit ${TTS_MAX_MB}), stopping it`); me.overMemory = true; child.kill('SIGKILL'); }
    } catch { /* not on Linux, or already gone */ }
  }, 2000);
  guard.unref();
  child.on('message', (m) => {
    if (m.type === 'ready') { me.ready = true; console.log('commentary: neural voices ready'); }
    else if (m.type === 'failed') console.error('commentary: voice model failed to load:', m.error);
    else if (m.type === 'done') { const w = me.waiting.get(m.id); if (w) { me.waiting.delete(m.id); w(m); } }
  });
  child.on('exit', (code, signal) => {
    clearInterval(guard);
    for (const w of me.waiting.values()) w({ error: 'worker_exit' });
    if (tts === me) tts = null;
    if (me.overMemory) {
      // a fresh process starts small again, so restart it; only give up if it keeps happening
      ttsRecycles = ttsRecycles.filter((t) => Date.now() - t < 3600 * 1000);
      ttsRecycles.push(Date.now());
      if (ttsRecycles.length <= 6) { console.log('commentary: restarting the voice process'); setTimeout(startTts, 5000).unref(); }
      else console.error('commentary: voice process keeps outgrowing its memory, neural voices off until the next restart');
    }
    else if (code || signal) { console.error('commentary: voice worker stopped,', code || signal, '- retrying in 10 minutes'); setTimeout(startTts, 10 * 60 * 1000).unref(); }
  });
}
startTts();
let clipNo = 0;
function voiceLine(line) {
  const estimate = { audio: false, dur: 1.5 + line.text.length * 0.065 };
  if (!tts || !tts.ready || clients.size === 0) return Promise.resolve(estimate);
  const id = Date.now().toString(36) + (clipNo++).toString(36);
  const text = line.text.replace(/\bP(\d+)\b/g, 'P $1');
  return new Promise((resolve) => {
    const timer = setTimeout(() => { tts && tts.waiting.delete(id); resolve(estimate); }, 25000);
    tts.waiting.set(id, (m) => {
      clearTimeout(timer);
      if (m.error || !m.wav) return resolve(estimate);
      voiceClips.set(id, Buffer.from(m.wav, 'base64'));
      while (voiceClips.size > 24) voiceClips.delete(voiceClips.keys().next().value);
      resolve({ audio: true, id, dur: m.dur });
    });
    tts.child.send({ type: 'say', id, text, voice: BOOTH_VOICES[line.who] || BOOTH_VOICES[0], speed: line.prio >= 3 ? 1.08 : 1.0 });
  });
}
const booth = createBooth({
  speak: voiceLine,
  air: (l) => broadcast('voice', { id: l.id, who: l.name, text: l.text, audio: l.audio, dur: Math.round(l.dur * 10) / 10, prio: l.prio }),
});
let boothSnap = null;

// ---- Velora sign-in (same browser approval flow as Pixel Wall) ----------------
async function velora(method, route, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(VELORA + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, data };
}

async function startLogin(s) {
  const r = await velora('POST', '/auth/ext-code', { body: { permissions_integer: PERMISSIONS, project_name: PROJECT_NAME } });
  if (!r.ok || !r.data || !r.data.code) throw Object.assign(new Error('velora_login_unavailable'), { code: 502 });
  const code = r.data.code;
  s.login = { code, started: Date.now() };
  pollLogin(s, code);
  return `${VELORA}/login?code=${encodeURIComponent(code)}&project=${encodeURIComponent(PROJECT_NAME)}&permissions=${PERMISSIONS}`;
}

async function pollLogin(s, code) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline && s.login && s.login.code === code) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const r = await velora('GET', '/auth/ext-code/status?code=' + encodeURIComponent(code));
      if (r.ok && r.data && r.data.ready && r.data.token) {
        const v = await velora('POST', '/auth/validate', { token: r.data.token, body: {} });
        const u = v.ok && v.data && v.data.valid && v.data.user && v.data.user.username;
        if (typeof u === 'string' && u) { s.user = u; s.token = r.data.token; saveSoon(); }
        else console.error('could not read the Velora username, status', v.status);
        s.login = null;
        return;
      }
      if (r.status === 404 || r.status === 410) break;
    } catch { /* transient */ }
  }
  if (s.login && s.login.code === code) s.login = null;
}

// ---- http helpers --------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
function getSession(req, res) {
  const sid = parseCookies(req).sid;
  let s = sid && sessions.get(sid);
  if (!s) {
    s = { sid: crypto.randomBytes(24).toString('base64url'), user: null, token: null, login: null, seen: Date.now() };
    sessions.set(s.sid, s);
    const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + 30 * 24 * 3600];
    if (COOKIE_SECURE) flags.push('Secure');
    res.setHeader('Set-Cookie', `sid=${s.sid}; ${flags.join('; ')}`);
  }
  s.seen = Date.now();
  return s;
}
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.seen > (s.user ? 30 : 1) * 24 * 3600 * 1000) sessions.delete(sid);
  for (const [k, r] of rate) if (now > r.reset) rate.delete(k);
}, 60 * 1000).unref();

const rate = new Map();
function limited(ip, key, max, windowMs) {
  const k = key + ':' + ip, now = Date.now();
  let r = rate.get(k);
  if (!r || now > r.reset) { r = { n: 0, reset: now + windowMs }; rate.set(k, r); }
  return ++r.n > max;
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(Object.assign(new Error('bad_json'), { code: 400 })); } });
    req.on('error', reject);
  });
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function adminOk(req) {
  if (!ADMIN_KEY) return false;
  const given = Buffer.from(String(req.headers['x-admin-key'] || '')), want = Buffer.from(ADMIN_KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function publicTeam(t) { return { id: t.id, name: t.name, color: t.color, number: t.number, owner: t.ownerName, stats: t.stats }; }
function myState(s) {
  const t = teamOf(s.user);
  return {
    signedIn: !!s.user, user: s.user, loggingIn: !!s.login && !s.user,
    owner: !!s.user && !!OWNER && s.user.toLowerCase() === OWNER,
    team: t ? { ...publicTeam(t), drivers: t.drivers, personality: t.personality, strategy: t.strategy, entered: entries.includes(t.id), racing: !!race && race.cars.some((c) => c.id === t.id) } : null,
    colors: COLORS,
  };
}

// ---- routes ------------------------------------------------------------------
async function api(req, res, url) {
  const who = (req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?').toString();
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/track') {
    const T = S.T;
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return send(res, 200, { length: T.LENGTH, step: T.STEP, points: T.points, pitIn: T.PIT_IN, pitOut: T.PIT_OUT, corners: T.corners, lapTime: T.lapTime });
  }
  if (req.method === 'GET' && p === '/api/race') {
    const out = { ...phaseInfo(), race: race ? S.snapshot(race) : null, voices: !!(tts && tts.ready) };
    if (race) {
      out.feed = race.feed.slice(-60);
      out.thoughts = Object.fromEntries(race.cars.map((c) => [c.id, c.thoughts.slice(-4)]));
    }
    return send(res, 200, out);
  }
  if (req.method === 'GET' && p.startsWith('/api/voice/')) {
    const key = p.slice('/api/voice/'.length);
    const clip = key === 'hello' ? SILENCE : voiceClips.get(key);
    if (!clip) return send(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': clip.length, 'Cache-Control': 'public, max-age=600', 'X-Content-Type-Options': 'nosniff' });
    return res.end(clip);
  }
  if (req.method === 'GET' && p.startsWith('/api/car/')) {
    const id = decodeURIComponent(p.slice('/api/car/'.length));
    const c = race && race.cars.find((x) => x.id === id);
    if (!c) return send(res, 404, { error: 'not_found' });
    return send(res, 200, { id, thoughts: c.thoughts, strategy: c.bot ? strategyOf(id) : null });
  }
  if (req.method === 'GET' && p === '/api/history') return send(res, 200, { history: history.slice(0, 10) });
  if (req.method === 'GET' && p === '/api/stream') {
    if (clients.size >= 1000 || limited(who, 'stream', 30, 60 * 1000)) return send(res, 429, { error: 'busy' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    res.write(`event: phase\ndata: ${JSON.stringify(phaseInfo())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const s = getSession(req, res);
  if (req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'bad_origin' });
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json_only' });
    if (limited(who, 'post', 120, 60 * 1000)) return send(res, 429, { error: 'slow_down' });
  }

  try {
    if (req.method === 'GET' && p === '/api/me') return send(res, 200, myState(s));

    if (req.method === 'POST' && p === '/api/login') {
      if (limited(who, 'login', 40, 10 * 60 * 1000)) return send(res, 429, { error: 'slow_down' });
      return send(res, 200, { loginUrl: await startLogin(s) });
    }
    if (req.method === 'POST' && p === '/api/logout') { s.user = null; s.token = null; s.login = null; saveSoon(); return send(res, 200, myState(s)); }

    // starting a race early: the owner account or the admin key
    if (req.method === 'POST' && (p === '/api/owner/start' || p === '/api/admin/start')) {
      const ok = adminOk(req) || (s.user && OWNER && s.user.toLowerCase() === OWNER);
      if (!ok) return send(res, 403, { error: 'forbidden' });
      if (race) return send(res, 409, { error: 'race_running' });
      const own = teamOf(OWNER); // the owner starting early races too, even if they forgot to enter
      if (own && !entries.includes(own.id) && entries.length < GRID) entries.push(own.id);
      startRace(); broadcastPhase();
      return send(res, 200, { ok: true });
    }
    // throw away the running race and start a fresh one with the same real teams (plus the owner's)
    if (req.method === 'POST' && (p === '/api/owner/restart' || p === '/api/admin/restart')) {
      const ok = adminOk(req) || (s.user && OWNER && s.user.toLowerCase() === OWNER);
      if (!ok) return send(res, 403, { error: 'forbidden' });
      if (!race) return send(res, 409, { error: 'no_race' });
      const keep = race.cars.filter((c) => teams.has(c.id)).map((c) => c.id);
      const own = teamOf(OWNER);
      if (own && !keep.includes(own.id)) keep.push(own.id);
      for (const id of entries) if (!keep.includes(id)) keep.push(id);
      entries = keep.slice(0, GRID);
      race = null; raceCount = Math.max(0, raceCount - 1);
      startRace(); broadcastPhase();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/admin/rename') {
      if (!adminOk(req)) return send(res, 403, { error: 'forbidden' });
      const b = await readJson(req);
      const t = teams.get(b.id);
      if (!t || typeof b.name !== 'string' || !NAME_RE.test(b.name.trim())) return send(res, 400, { error: 'bad_request' });
      t.name = b.name.trim(); syncCar(t); saveSoon();
      return send(res, 200, { ok: true });
    }

    if (!s.user) return send(res, 401, { error: 'signed_out' });

    if (req.method === 'POST' && p === '/api/team') {
      const b = await readJson(req);
      let t = teamOf(s.user);
      if (!t) {
        t = createTeam(s.user);
        if (!race && entries.length < GRID) entries.push(t.id); // a new team made during the break is entered straight away
      }
      if (b.name !== undefined) {
        const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
        if (!NAME_RE.test(name)) return send(res, 400, { error: 'bad_name' });
        if (nameTaken(name, t.id)) return send(res, 409, { error: 'name_taken' });
        t.name = name;
      }
      if (b.color !== undefined) { if (!COLORS.includes(b.color)) return send(res, 400, { error: 'bad_color' }); t.color = b.color; }
      if (b.number !== undefined) {
        if (!Number.isInteger(b.number) || b.number < 1 || b.number > 99) return send(res, 400, { error: 'bad_number' });
        for (const o of teams.values()) if (o !== t && o.number === b.number) return send(res, 409, { error: 'number_taken' });
        t.number = b.number;
      }
      if (b.drivers !== undefined) {
        if (!Array.isArray(b.drivers) || b.drivers.length < 1 || b.drivers.length > 4) return send(res, 400, { error: 'bad_drivers' });
        const names = b.drivers.map((d) => (typeof d === 'string' ? d.trim().replace(/\s+/g, ' ') : ''));
        if (names.some((d) => !DRIVER_RE.test(d))) return send(res, 400, { error: 'bad_driver_name' });
        const racing = race && race.cars.find((c) => c.id === t.id && !c.retired);
        if (racing && names.length !== t.drivers.length) return send(res, 409, { error: 'drivers_locked' }); // line-up size is fixed once racing
        t.drivers = names;
      }
      if (b.personality !== undefined) { if (!S.PERSONALITIES.includes(b.personality)) return send(res, 400, { error: 'bad_personality' }); t.personality = b.personality; }
      syncCar(t); saveSoon();
      if (!race) broadcastPhase();
      return send(res, 200, myState(s));
    }

    const t = teamOf(s.user);
    if (!t) return send(res, 404, { error: 'no_team' });

    if (req.method === 'POST' && p === '/api/team/strategy') {
      const b = await readJson(req);
      t.strategy = S.sanitizeStrategy(b, t.strategy);
      saveSoon();
      const c = race && race.cars.find((x) => x.id === t.id);
      if (c && !c.retired) { c.thoughts.push({ t: Math.round(race.simTime), text: 'Radio: new strategy from the team. Copy that.' }); broadcast('thought', { car: c.id, t: Math.round(race.simTime), text: 'Radio: new strategy from the team. Copy that.' }); }
      return send(res, 200, myState(s));
    }
    if (req.method === 'POST' && p === '/api/team/box') {
      const c = race && race.cars.find((x) => x.id === t.id);
      if (!c || c.retired || c.finished) return send(res, 409, { error: 'not_racing' });
      c.box = true;
      const text = 'Radio: box this lap. Understood.';
      c.thoughts.push({ t: Math.round(race.simTime), text }); broadcast('thought', { car: c.id, t: Math.round(race.simTime), text });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/team/enter') {
      const b = await readJson(req);
      if (race) return send(res, 409, { error: 'race_running' });
      const i = entries.indexOf(t.id);
      if (b.in === true && i < 0) { if (entries.length >= GRID) return send(res, 409, { error: 'grid_full' }); entries.push(t.id); }
      if (b.in === false && i >= 0) entries.splice(i, 1);
      saveSoon(); broadcastPhase();
      return send(res, 200, myState(s));
    }

    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    const code = Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error('error', req.method, p, e.message);
    return send(res, code, { error: e.message || 'server_error' });
  }
}

// Name, colour, number and driver names show on the car straight away.
function syncCar(t) {
  const c = race && race.cars.find((x) => x.id === t.id);
  if (!c) return;
  c.name = t.name; c.color = t.color; c.number = t.number;
  if (t.drivers.length === c.drivers.length) c.drivers = t.drivers.slice();
  c.personality = t.personality;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const PUBLIC_DIR = path.join(__dirname, 'public');
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache', // so Cloudflare and browsers pick up new client files right away
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return void api(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`${PROJECT_NAME} on http://127.0.0.1:${PORT}  grid ${GRID}, ${RACE_HOURS}h races, ${DAILY ? 'daily at ' + START_AT + ' ' + RACE_TZ : BREAK_MINUTES + ' min break'}${TIME_SCALE !== 1 ? ', TIME x' + TIME_SCALE : ''}${race ? ', race ' + race.number + ' resumed' : ''}`);
});
