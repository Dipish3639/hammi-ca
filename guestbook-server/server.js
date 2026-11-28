// Hammi guest book: the API behind https://hammi.ca/guestbook/.
// Anyone can sign with a name and a short message. Nookara sign-in is optional; the owner (OWNER,
// checked with Nookara) can reply to, hide and delete entries from the page itself.
// No dependencies: needs Node 18 or newer.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- config ------------------------------------------------------------------
const die = (m) => { console.error(m); process.exit(1); };
const PORT = Number(process.env.PORT || 3200);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const OWNER = (process.env.OWNER || 'Dipish').trim();           // Nookara username that can moderate
const ADMIN_KEY = process.env.ADMIN_KEY || '';                     // optional: curl moderation
const COOKIE_SECURE = process.env.COOKIE_SECURE !== '0';           // 0 only for local http tests
// The guest book page. Its origin may call the API, and Nookara sends visitors back to it after sign-in.
const PAGE_URL = (process.env.PAGE_URL || 'https://hammi.ca/guestbook/').trim();
const PAGE_ORIGIN = new URL(PAGE_URL).origin;
const ORIGINS = new Set([PAGE_ORIGIN, ...(process.env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
const NOOKARA = (process.env.NOOKARA_URL || 'https://nookara.cc').replace(/\/+$/, '');
const APP_ID = (process.env.NOOKARA_APP_ID || '').trim();          // empty = no Nookara sign-in
// HOLD=all keeps every new entry hidden until the owner approves it. HOLD=off (default) publishes straight away.
const HOLD = (process.env.HOLD || 'off').trim().toLowerCase();
const MAX_ENTRIES = Number(process.env.MAX_ENTRIES || 20000);
if (APP_ID && !/^app_[A-Za-z0-9]{4,64}$/.test(APP_ID)) die('NOOKARA_APP_ID should look like app_0123abcd.');
if (!['off', 'all'].includes(HOLD)) die('HOLD must be off or all.');

const LIMITS = {
  name: 24, from: 32, message: 500, lines: 10, reply: 500,
};

// ---- state -------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const FILE = path.join(DATA_DIR, 'guestbook.json');
let db = { next: 1, entries: [], blocked: [], secret: crypto.randomBytes(32).toString('hex') };
if (fs.existsSync(FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
// entry: { id, name, from, message, at, nookara (username or null), hidden, held, reply: {text, at} | null, ip (hashed) }

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function saveSoon() { if (!saveTimer) saveTimer = setTimeout(() => { try { saveNow(); } catch (e) { console.error('save failed', e.message); } }, 800); }
if (!fs.existsSync(FILE)) saveNow();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { saveNow(); } catch {} process.exit(0); });

const byId = (id) => db.entries.find((e) => e.id === id);
const ipHash = (ip) => crypto.createHmac('sha256', db.secret).update('ip:' + ip).digest('base64url').slice(0, 16);

// Sessions only matter for Nookara sign-in. Tokens stay in memory and are never written to disk.
const sessions = new Map();
function newSession() {
  const sid = crypto.randomBytes(24).toString('base64url');
  const s = { sid, token: null, user: null, login: null, seen: Date.now() };
  sessions.set(sid, s);
  return s;
}

const rate = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) if (now - s.seen > 30 * 24 * 3600 * 1000) sessions.delete(sid);
  for (const [k, r] of rate) if (now > r.reset) rate.delete(k);
}, 60 * 1000).unref();
// true when over the limit. Counts the attempt.
function limited(key, max, windowMs) {
  const now = Date.now();
  let r = rate.get(key);
  if (!r || now > r.reset) { r = { n: 0, reset: now + windowMs }; rate.set(key, r); }
  r.n += 1;
  return r.n > max;
}
function peek(key, max) { const r = rate.get(key); return !!r && Date.now() <= r.reset && r.n >= max; }

// ---- Nookara -------------------------------------------------------------------
// App tokens only work from the app's authorized URLs, which Nookara checks with Origin.
async function nookara(method, route, { token, body } = {}) {
  const headers = { Accept: 'application/json', Origin: PAGE_ORIGIN };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(NOOKARA + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, ok: res.ok, data };
}
const fail = (msg, code = 400) => Object.assign(new Error(msg), { code });
const LOGIN_TTL = 10 * 60 * 1000;
const GRANT_RE = /^[A-Za-z0-9_.~-]{4,512}$/;

async function startLogin(s) {
  const r = await nookara('POST', '/auth/ext-code', { body: { app_id: APP_ID, redirect_uri: PAGE_URL } });
  if (!r.ok || !r.data || typeof r.data.code !== 'string') { console.error('nookara ext-code failed', r.status); throw fail('nookara_unavailable', 502); }
  s.login = { code: r.data.code, started: Date.now() };
  return `${NOOKARA}/login?code=${encodeURIComponent(r.data.code)}`;
}
async function finishLogin(s, code, grant) {
  if (!GRANT_RE.test(code || '') || !GRANT_RE.test(grant || '')) throw fail('login_failed');
  // Only finish a sign-in this browser started, so nobody can sign you in to their account with a link.
  if (!s.login || s.login.code !== code || Date.now() - s.login.started > LOGIN_TTL) { s.login = null; throw fail('login_expired'); }
  s.login = null;
  const r = await nookara('POST', '/auth/ext-code/exchange', { body: { code, grant } });
  if (!r.ok || !r.data || typeof r.data.token !== 'string' || !r.data.token) { console.error('nookara exchange failed', r.status); throw fail('login_failed', r.status >= 500 ? 502 : 400); }
  if (r.data.app_id && r.data.app_id !== APP_ID) throw fail('login_failed');
  const v = await nookara('POST', '/auth/validate', { token: r.data.token, body: {} });
  const u = v.ok && v.data && v.data.valid && v.data.user && v.data.user.username;
  if (typeof u !== 'string' || !/^[A-Za-z0-9_.-]{1,32}$/.test(u)) throw fail('login_failed', 502);
  s.token = r.data.token; s.user = u;
}
const isOwner = (s) => !!s.token && !!s.user && s.user.toLowerCase() === OWNER.toLowerCase();

// ---- text checks -----------------------------------------------------------------
// Plain text only. The page always shows entries as text, never as HTML.
function clean(v, max, multiline) {
  if (typeof v !== 'string') return '';
  let t = v.normalize('NFC').replace(/\r\n?/g, '\n');
  t = t.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, ''); // control + bidi tricks
  if (!multiline) t = t.replace(/\s+/g, ' ');
  else t = t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n');
  t = t.trim();
  return [...t].length > max ? null : t; // null = too long
}
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|ru|cn|xyz|top|io|info|biz|shop|site|online|click|link|gg|me|co)\b)/i;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._'’-]*$/u;
const normal = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function blockedWord(text) {
  const n = ' ' + text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';
  return db.blocked.find((w) => n.includes(' ' + w + ' '));
}

// Form tokens: issued when the page loads, must be at least 3 seconds old. Stops the simplest bots.
const formToken = () => { const t = Date.now().toString(36); return t + '.' + crypto.createHmac('sha256', db.secret).update('form:' + t).digest('base64url').slice(0, 22); };
function formOk(tok) {
  if (typeof tok !== 'string') return false;
  const [t, mac] = tok.split('.');
  if (!t || !mac) return false;
  const want = crypto.createHmac('sha256', db.secret).update('form:' + t).digest('base64url').slice(0, 22);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  const age = Date.now() - parseInt(t, 36);
  return age >= 3000 && age <= 24 * 3600 * 1000;
}

// ---- http helpers ------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
function getSession(req, res, create) {
  const sid = parseCookies(req).gb;
  let s = sid && sessions.get(sid);
  if (!s && create) {
    s = newSession();
    const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + 30 * 24 * 3600];
    if (COOKIE_SECURE) flags.push('Secure');
    res.setHeader('Set-Cookie', `gb=${s.sid}; ${flags.join('; ')}`);
  }
  if (s) s.seen = Date.now();
  return s || null;
}
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
function readJson(req, limit = 6 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(fail('too_large', 413)); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { reject(fail('bad_json')); }
    });
    req.on('error', reject);
  });
}
function adminOk(req) {
  if (!ADMIN_KEY) return false;
  const given = Buffer.from(String(req.headers['x-admin-key'] || '')), want = Buffer.from(ADMIN_KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function view(e, owner) {
  const v = { id: e.id, name: e.name, from: e.from, message: e.message, at: e.at, nookara: !!e.nookara, reply: e.reply || null };
  if (owner) { v.hidden = !!e.hidden; v.held = !!e.held; }
  return v;
}
const visible = (e) => !e.hidden && !e.held;
function state(s) {
  return { signedIn: !!(s && s.token), user: s && s.token ? s.user : null, owner: !!s && isOwner(s), login: !!APP_ID, hold: HOLD, limits: LIMITS, owner_name: OWNER };
}

// ---- API -------------------------------------------------------------------------
async function api(req, res, url) {
  const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?'); // behind the tunnel the real address is here
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    if (!origin || !ORIGINS.has(origin)) { res.writeHead(403); return res.end(); }
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  if (limited('all:' + ip, 300, 60 * 1000)) return send(res, 429, { error: 'slow_down' });

  const admin = url.pathname.startsWith('/api/admin/');
  if (req.method === 'POST' && !admin) {
    // Browser posts must come from the guest book page. Scripts without an Origin are refused too.
    if (!origin || !ORIGINS.has(origin)) return send(res, 403, { error: 'bad_origin' });
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json_only' });
  }

  try {
    const s = getSession(req, res, false);
    const owner = !!s && isOwner(s);

    if (req.method === 'GET' && url.pathname === '/api/entries') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const before = Number(url.searchParams.get('before')) || Infinity;
      const list = db.entries.filter((e) => (owner || visible(e)) && e.id < before);
      const page = list.slice(-limit).reverse();
      const total = db.entries.filter(visible).length;
      const out = { entries: page.map((e) => view(e, owner)), more: list.length > limit, total, form: formToken(), state: state(s) };
      if (owner) out.waiting = db.entries.filter((e) => e.held && !e.hidden).length;
      return send(res, 200, out);
    }

    if (req.method === 'POST' && url.pathname === '/api/sign') {
      const b = await readJson(req);
      if (typeof b.website === 'string' && b.website.trim()) return send(res, 200, { ok: true, held: true }); // honeypot: pretend it worked
      if (!formOk(b.form)) return send(res, 400, { error: 'form_expired' });
      const signedName = s && s.token ? s.user : null;
      const name = signedName || clean(b.name, LIMITS.name, false);
      const from = clean(b.from || '', LIMITS.from, false);
      const message = clean(b.message, LIMITS.message, true);
      if (name === null || !name) return send(res, 400, { error: 'bad_name' });
      if (!signedName && !NAME_RE.test(name)) return send(res, 400, { error: 'bad_name' });
      if (!signedName && name.toLowerCase() === OWNER.toLowerCase()) return send(res, 400, { error: 'name_reserved' });
      if (from === null) return send(res, 400, { error: 'bad_from' });
      if (message === null) return send(res, 400, { error: 'too_long' });
      if ([...message].length < 2) return send(res, 400, { error: 'too_short' });
      if (message.split('\n').length > LIMITS.lines) return send(res, 400, { error: 'too_many_lines' });
      if (!signedName && (LINK_RE.test(message) || LINK_RE.test(name) || LINK_RE.test(from))) return send(res, 400, { error: 'no_links' });
      if (blockedWord(name + ' ' + from + ' ' + message)) return send(res, 400, { error: 'not_allowed' });
      const n = normal(message);
      if (n.length >= 8 && db.entries.slice(-300).some((e) => normal(e.message) === n)) return send(res, 409, { error: 'duplicate' });
      // One entry a minute, five an hour and ten a day per address. Everyone together: 60 an hour.
      const h = ipHash(ip);
      if (peek('s1:' + h, 1) || peek('s2:' + h, 5) || peek('s3:' + h, 10)) return send(res, 429, { error: 'slow_down' });
      if (peek('global', 60)) return send(res, 429, { error: 'busy' });
      limited('s1:' + h, 1, 60 * 1000); limited('s2:' + h, 5, 3600 * 1000); limited('s3:' + h, 10, 24 * 3600 * 1000); limited('global', 60, 3600 * 1000);
      const e = { id: db.next++, name, from, message, at: Date.now(), nookara: signedName, hidden: false, held: HOLD === 'all' && !signedName, reply: null, ip: h };
      db.entries.push(e);
      if (db.entries.length > MAX_ENTRIES) db.entries.splice(0, db.entries.length - MAX_ENTRIES);
      saveSoon();
      console.log(`entry ${e.id} from ${JSON.stringify(name)}${e.held ? ' (held)' : ''}`);
      return send(res, 200, { ok: true, held: e.held, entry: view(e, owner) });
    }

    // ---- Nookara sign-in ----
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!APP_ID) return send(res, 404, { error: 'not_found' });
      if (limited('login:' + ip, 10, 10 * 60 * 1000)) return send(res, 429, { error: 'slow_down' });
      const ss = getSession(req, res, true);
      return send(res, 200, { url: await startLogin(ss) });
    }
    if (req.method === 'POST' && url.pathname === '/api/login/finish') {
      if (!APP_ID || !s) return send(res, 400, { error: 'login_expired' });
      if (limited('login:' + ip, 20, 10 * 60 * 1000)) return send(res, 429, { error: 'slow_down' });
      const b = await readJson(req);
      await finishLogin(s, String(b.code || ''), String(b.grant || ''));
      return send(res, 200, { state: state(s) });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      if (s) { s.token = null; s.user = null; s.login = null; }
      return send(res, 200, { state: state(s) });
    }

    // ---- moderation: the owner signed in with Nookara, or the admin key ----
    const ownerPath = url.pathname.match(/^\/api\/(owner|admin)\/(reply|hide|approve|delete|block)$/);
    if (req.method === 'POST' && ownerPath) {
      if (ownerPath[1] === 'owner' ? !owner : !adminOk(req)) return send(res, 403, { error: 'forbidden' });
      const b = await readJson(req);
      const act = ownerPath[2];
      if (act === 'block') {
        const w = clean(b.word, 40, false);
        if (!w) return send(res, 400, { error: 'bad_word' });
        const low = w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (b.remove) db.blocked = db.blocked.filter((x) => x !== low); else if (!db.blocked.includes(low)) db.blocked.push(low);
        saveSoon();
        return send(res, 200, { blocked: db.blocked });
      }
      if (!isInt(b.id, 1, 1e9)) return send(res, 400, { error: 'bad_id' });
      const e = byId(b.id);
      if (!e) return send(res, 404, { error: 'not_found' });
      if (act === 'reply') {
        const t = clean(b.text || '', LIMITS.reply, true);
        if (t === null) return send(res, 400, { error: 'too_long' });
        e.reply = t ? { text: t, at: Date.now() } : null;
      } else if (act === 'hide') e.hidden = b.hidden !== false;
      else if (act === 'approve') e.held = false;
      else if (act === 'delete') db.entries.splice(db.entries.indexOf(e), 1);
      saveSoon();
      console.log(`${ownerPath[1]} ${act} entry ${e.id}`);
      return send(res, 200, { ok: true, entry: act === 'delete' ? null : view(e, true) });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/list') {
      if (!adminOk(req)) return send(res, 403, { error: 'forbidden' });
      return send(res, 200, { entries: db.entries.slice(-200).map((e) => view(e, true)), blocked: db.blocked });
    }

    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    const code = Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error('error', req.method, url.pathname, e.message);
    return send(res, code, { error: code === 500 ? 'server_error' : e.message });
  }
}

http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith('/api/')) return void api(req, res, url);
  if (url.pathname === '/' && req.method === 'GET') { res.writeHead(302, { Location: PAGE_URL }); return res.end(); }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`guest book API on http://127.0.0.1:${PORT} for ${PAGE_URL}; owner ${OWNER}; Nookara sign-in ${APP_ID || 'off'}; hold ${HOLD}; ${db.entries.length} entries`);
});
