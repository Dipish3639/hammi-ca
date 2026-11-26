/* Hammi Chat: a small chat client for Ember servers, made for hammi.ca, written from scratch.
 * Talks to Nookara (sign-in, the saved server list, DMs) and straight to each Ember server (instance) the
 * account is in: REST at <instance>/api/v1, live events on <instance>/gateway. Nothing goes through hammi.ca. */
(() => {
'use strict';

const NOOKARA = 'https://nookara.cc';
const NOOKARA_WS = 'wss://nookara.cc';
const APP_ID = 'app_8df4644bb50d66f71773'; // the Nookara app this client signs in with (My Account > Apps on nookara.cc)
const CLIENT = { name: 'Hammi Chat', version: '0.1.1' };
const LS = { token: 'hammichat_token', user: 'hammichat_user', sessions: 'hammichat_sessions', last: 'hammichat_last', extra: 'hammichat_extra_instances' };

// ───────────────────────── small helpers ─────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const COLORS = ['#ff2e88', '#2ee6ff', '#9b5cff', '#ffa8d6', '#ff5fb0', '#7fd8ff', '#c9a2ff'];
const nameColor = n => COLORS[[...String(n || '?').toLowerCase()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const hostOf = o => { try { return new URL(o).host; } catch { return String(o); } };
const normOrigin = u => {
  let s = String(u || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const x = new URL(s); return x.protocol === 'https:' || /^(localhost|127\.)/.test(x.hostname) ? x.origin : null; } catch { return null; }
};
const toMs = t => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t) || Date.now());
const hhmm = t => { const d = new Date(toMs(t)); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };
const dayOf = t => new Date(toMs(t)).toDateString();
const nonce = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = n => Math.min(30000, 1000 * 2 ** Math.min(n, 5)) + Math.random() * 1000;

// ───────────────────────── state ─────────────────────────
const S = {
  token: store.get(LS.token), me: store.get(LS.user), demo: false,
  insts: new Map(),          // origin -> { origin, info, session, user, ws, status, servers: [], retry, timer, acks: Map }
  detail: {},                // skey -> { server, categories, channels }
  members: {},               // skey -> [member]
  msgs: {},                  // vkey -> { list, hasMore, loading, loaded }
  unread: {}, mentions: {},  // vkey -> bool / count
  dms: [],                   // [{ username, unread, last_message }]
  typing: {},                // vkey -> { name: until }
  view: { kind: 'home' },
  replyTo: null,             // { id, who, text }
  editing: null,             // { id, vkey }
  home: { ws: null, status: 'closed', retry: 0 },
  lastSent: {},              // vkey -> message id (for ↑ edit)
  presence: {},              // username -> { status, ... } from Nookara
  emojiUrls: {},             // eid -> url
  session: null,             // GET /bonfire/session
  sigs: {},                  // message key -> 'ok' | 'bad'
};
const HC = window.HammiCrypto;
const skey = (origin, sid) => origin + '|' + sid;
const vkeyOf = v => v.kind === 'channel' ? `c|${v.origin}|${v.cid}` : v.kind === 'dm' ? `d|${String(v.user).toLowerCase()}` : 'home';

// ───────────────────────── Nookara REST ─────────────────────────
async function nk(path, opts = {}) {
  if (S.demo) throw Object.assign(new Error('demo'), { status: 0 });
  const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}), ...(opts.headers || {}) };
  let res;
  try { res = await fetch(NOOKARA + path, { ...opts, headers }); } catch { throw Object.assign(new Error('nookara_unreachable'), { status: 0 }); }
  HC?.noteClock(res.headers.get('date'));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // only the sign-in check itself ends the session: a 401 from any other route (a permission this app doesn't have,
    // a route apps can't use) is just that request failing
    if (res.status === 401 || res.status === 403) console.warn('Hammi Chat: Nookara refused', path, res.status, data.error);
    throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, data });
  }
  return data;
}

// ───────────────────────── sign-in (Nookara app popup) ─────────────────────────
function bootLine(text, cls = '') { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = text; $('boot-lines').appendChild(d); }
function showLogin(note) {
  $('boot-lines').innerHTML = '';
  bootLine('HAMMI CHAT v' + CLIENT.version);
  bootLine('> an open chat protocol client for hammi.ca');
  if (note) bootLine('! ' + note, 'bad');
  if (!APP_ID) bootLine('! sign-in is not set up yet (no Nookara app id)', 'bad');
  bootLine('> waiting for sign-in_');
  $('signin').disabled = !APP_ID;
  $('login').hidden = false;
  $('signin').focus();
}
async function signIn() {
  if (!APP_ID) return;
  const btn = $('signin');
  btn.disabled = true;
  const win = window.open('about:blank', 'nookara-signin', 'popup=yes,width=480,height=680');
  try {
    bootLine('> asking Nookara for a sign-in code...');
    const { code } = await nk('/auth/ext-code', { method: 'POST', body: JSON.stringify({ app_id: APP_ID }) });
    if (!code) throw new Error('no_code');
    const url = `${NOOKARA}/login?code=${encodeURIComponent(code)}`;
    if (win && !win.closed) win.location.href = url;
    else { bootLine('! pop-up blocked: allow pop-ups for hammi.ca, or use this link', 'bad'); const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'opener'; a.textContent = '> open Nookara sign-in'; $('boot-lines').appendChild(a); }
    bootLine('> approve Hammi Chat in the Nookara window');
    const grant = await waitForGrant(code, win);
    bootLine('> exchanging the grant for a token...');
    const r = await nk('/auth/ext-code/exchange', { method: 'POST', body: JSON.stringify({ code, grant }) });
    if (!r.token) throw new Error('no_token');
    S.token = r.token; store.set(LS.token, r.token);
    bootLine('> signed in', 'ok');
    await start();
  } catch (e) {
    try { win?.close(); } catch { /* fine */ }
    bootLine('! sign-in failed: ' + (e.message === 'declined' ? 'cancelled' : e.message === 'origin_not_authorized' ? 'this site is not an authorized URL of the app' : e.message), 'bad');
    btn.disabled = false;
  }
}
function waitForGrant(code, win) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; removeEventListener('message', onMsg); clearInterval(poll); fn(v); };
    const onMsg = ev => {
      if (ev.origin !== NOOKARA) return;
      const d = ev.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'nookara_app_grant' && d.grant && (!d.code || d.code === code)) finish(resolve, d.grant);
      if (d.type === 'nookara_app_declined' || d.error === 'declined') finish(reject, new Error('declined'));
    };
    addEventListener('message', onMsg);
    // the window was closed without an answer: /auth/ext-code/status says whether it was approved (it never returns the token)
    const poll = setInterval(async () => {
      if (!win || !win.closed) return;
      await sleep(800);
      if (!done) finish(reject, new Error('declined'));
    }, 1000);
  });
}
function signedOut(note) {
  for (const c of S.insts.values()) { try { c.ws?.close(); } catch { /* gone */ } clearTimeout(c.timer); }
  try { S.home.ws?.close(); } catch { /* gone */ }
  S.insts.clear(); S.token = null; S.me = null;
  store.set(LS.token, null); store.set(LS.user, null); store.set(LS.sessions, null);
  render();
  showLogin(note);
}
async function signOut() {
  if (S.demo) { location.href = location.pathname; return; }
  for (const c of S.insts.values()) if (c.session) fetch(`${c.origin}/api/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${c.session}` }, keepalive: true }).catch(() => {});
  if (S.token) await fetch(NOOKARA + '/bonfire/sign-out', { method: 'POST', headers: { Authorization: `Bearer ${S.token}` } }).catch(() => {});
  signedOut('Signed out.');
}

// ───────────────────────── instances ─────────────────────────
const sessions = () => store.get(LS.sessions, {}) || {};
const saveSession = (origin, s) => { const all = sessions(); if (s) all[origin] = s; else delete all[origin]; store.set(LS.sessions, all); };

async function plain(origin, path, body) {
  let res;
  try { res = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw Object.assign(new Error('server_unreachable'), { status: 0 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, data });
  return data;
}
async function api(c, path, opts = {}, retry = true) {
  if (S.demo) return demoApi(c, path, opts);
  if (!c.session) throw Object.assign(new Error('not_connected'), { status: 401 });
  let res;
  try {
    res = await fetch(c.origin + '/api/v1' + path, { ...opts, headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${c.session}`, ...(opts.headers || {}) } });
  } catch { throw Object.assign(new Error('server_unreachable'), { status: 0 }); }
  if (res.status === 401 && retry && await newSession(c).then(() => true, () => false)) return api(c, path, opts, false);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, data });
  return data;
}
async function discover(origin) {
  let res;
  try { res = await fetch(origin + '/.well-known/bonfire', { cache: 'no-store' }); } catch { throw new Error('server_unreachable'); }
  const info = await res.json().catch(() => null);
  if (!res.ok || !info || info.software !== 'bonfire-server') throw new Error('not_an_ember_server');
  return info;
}
async function newSession(c) {
  c.session = null; saveSession(c.origin, null);
  if (c.info?.accounts_mode && c.info.accounts_mode !== 'velora') throw new Error('local_accounts_not_supported');
  const t = await nk('/bonfire/instance-token', { method: 'POST', body: JSON.stringify({ instance: c.origin }) });
  const r = await plain(c.origin, '/api/v1/auth/velora', { token: t.token });
  c.session = r.session; c.user = r.user || c.user; saveSession(c.origin, r.session);
}
function addInstance(origin) {
  let c = S.insts.get(origin);
  if (c) return c;
  c = { origin, info: null, session: sessions()[origin] || null, user: null, ws: null, status: 'connecting', servers: [], retry: 0, timer: null, acks: new Map() };
  S.insts.set(origin, c);
  connect(c);
  return c;
}
async function connect(c) {
  if (S.demo || c.busy) return;
  c.busy = true; clearTimeout(c.timer);
  try {
    setStatus(c, 'connecting');
    if (!c.info) c.info = await discover(c.origin);
    if (!c.session) await newSession(c);
    openGateway(c);
  } catch (e) {
    setStatus(c, 'error', e.message);
    if (e.message !== 'local_accounts_not_supported' && e.message !== 'not_an_ember_server') retryLater(c);
  } finally { c.busy = false; }
}
function retryLater(c, min = 0) {
  clearTimeout(c.timer);
  if (!S.insts.has(c.origin)) return;
  c.timer = setTimeout(() => connect(c), Math.max(min, backoff(c.retry++)));
}
function setStatus(c, status, error = null) { c.status = status; c.error = error; renderLeft(); renderStatus(); }
function openGateway(c) {
  if (c.ws && c.ws.readyState <= 1) return;
  const ws = new WebSocket(c.origin.replace(/^http/, 'ws') + '/gateway');
  c.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', session: c.session, client: CLIENT }));
  ws.onmessage = e => { if (c.ws !== ws || typeof e.data !== 'string') return; let m; try { m = JSON.parse(e.data); } catch { return; } onInstFrame(c, m); };
  ws.onclose = ev => {
    if (c.ws !== ws) return;
    c.ws = null;
    if (!S.insts.has(c.origin)) return;
    if (ev.code === 4003) { setStatus(c, 'banned'); return; }
    if (ev.code === 4001) { newSession(c).then(() => openGateway(c), err => { setStatus(c, 'error', err.message); retryLater(c); }); return; }
    setStatus(c, 'closed');
    retryLater(c, ev.code === 4010 ? 3000 : ev.code === 4008 ? 15000 : 0);
  };
}
const sendInst = (c, obj) => { if (c?.ws?.readyState === 1) { c.ws.send(JSON.stringify(obj)); return true; } return false; };
setInterval(() => { for (const c of S.insts.values()) sendInst(c, { type: 'ping' }); if (S.home.ws?.readyState === 1) S.home.ws.send('{"type":"ping"}'); }, 25000);

async function loadServers(c) {
  const d = await api(c, '/servers');
  c.servers = d.servers || [];
  await Promise.all(c.servers.map(s => loadDetail(c, s.sid).catch(() => null)));
  renderLeft();
  restoreView();
}
async function loadDetail(c, sid) {
  const d = await api(c, `/servers/${encodeURIComponent(sid)}`);
  S.detail[skey(c.origin, sid)] = { server: d.server || c.servers.find(s => s.sid === sid) || { sid }, categories: d.categories || [], channels: d.channels || [] };
  for (const ch of d.channels || []) if (ch.unread) S.unread[`c|${c.origin}|${ch.cid}`] = true;
  return d;
}
async function loadMembers(c, sid) {
  const d = await api(c, `/servers/${encodeURIComponent(sid)}/members`);
  S.members[skey(c.origin, sid)] = d.members || [];
  watchPresence((d.members || []).filter(m => !m.bot && (m.kind === 'velora' || m.velora_id)).slice(0, 400).map(m => m.username));
  renderRight();
}

function onInstFrame(c, m) {
  switch (m.type) {
    case 'pong': return;
    case 'auth_success': c.user = m.user || c.user; c.isAdmin = !!m.instance_admin; sendInst(c, { type: 'chat_hello' }); return;
    case 'chat_ready':
      c.retry = 0; setStatus(c, 'open');
      loadServers(c).then(() => { loadEmojis().then(() => renderLog()); const v = S.view; if (v.kind === 'channel' && v.origin === c.origin) { S.msgs[vkeyOf(v)] = null; loadMessages(v); } }).catch(e => sys('could not load servers on ' + hostOf(c.origin) + ': ' + e.message, 'err'));
      return;
    case 'instance_restarting': sys(hostOf(c.origin) + ' is restarting...'); return;
    case 'account_restricted': setStatus(c, 'restricted', m.message || 'Ember is switched off for this account.'); return;
    case 'chat_message': addMessage(c, m.message); return;
    case 'chat_message_update': updateMessage(`c|${c.origin}|${m.message?.channel}`, m.message?.id, x => ({ ...x, ...m.message, reactions: m.message.reactions || x.reactions })); return;
    case 'chat_message_delete': removeMessage(`c|${c.origin}|${m.channel}`, m.id); return;
    case 'chat_reactions': updateMessage(`c|${c.origin}|${m.channel}`, m.id, x => ({ ...x, reactions: m.reactions })); return;
    case 'chat_typing': setTyping(`c|${c.origin}|${m.channel}`, m.username, m.typing !== false); return;
    case 'chat_ack': settle(c, m.nonce, m.message); return;
    case 'chat_error': {
      const p = c.acks.get(m.nonce);
      if (p && p.resend && SIGN_REFUSED.has(m.error)) { c.acks.delete(m.nonce); p.resend(); return; }
      if (p) { c.acks.delete(m.nonce); updateMessage(p.vkey, p.id, x => ({ ...x, pending: false, failed: m.error || 'failed' })); }
      if (!['chat_typing', 'chat_read'].includes(m.request)) sys(`${hostOf(c.origin)}: ${m.message || m.error}`, 'err');
      return;
    }
    case 'chat_ephemeral': if (m.message) addMessage(c, { ...m.message, ephemeral: true }); return;
    case 'chat_channels_update': {
      const k = skey(c.origin, m.server), d = S.detail[k];
      if (d && m.channels) { S.detail[k] = { ...d, categories: m.categories ?? d.categories, channels: m.channels.map(ch => ({ ...(d.channels.find(x => x.cid === ch.cid) || {}), ...ch })) }; renderLeft(); }
      else if (m.server) loadDetail(c, m.server).then(renderLeft, () => {});
      return;
    }
    case 'chat_server_update': if (m.server) loadDetail(c, m.server.sid || m.server).then(renderLeft, () => {}); return;
    case 'chat_server_added': case 'chat_server_removed': case 'chat_perms_changed': case 'chat_roles_update': loadServers(c).catch(() => {}); return;
    case 'chat_member_update': case 'chat_members_stale': { const v = S.view; if (v.kind === 'channel' && v.origin === c.origin) loadMembers(c, v.sid).catch(() => {}); return; }
    case 'chat_timeout': sys(m.until ? `You are timed out on ${hostOf(c.origin)} until ${new Date(toMs(m.until)).toLocaleTimeString()}.` : 'Your timeout ended.'); return;
    default: return;
  }
}

// ───────────────────────── Nookara home socket (DMs) ─────────────────────────
function openHome() {
  if (S.demo || !S.token || (S.home.ws && S.home.ws.readyState <= 1)) return;
  const ws = new WebSocket(NOOKARA_WS);
  S.home.ws = ws; S.home.status = 'connecting'; renderStatus();
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth_token', token: S.token, client: CLIENT }));
  ws.onmessage = e => { if (typeof e.data !== 'string') return; let m; try { m = JSON.parse(e.data); } catch { return; } onHomeFrame(m); };
  ws.onclose = () => {
    if (S.home.ws !== ws) return;
    S.home.ws = null; S.home.status = 'closed'; renderStatus();
    if (S.token && !S.home.noRetry) setTimeout(openHome, backoff(S.home.retry++));
  };
}
// a raw /im message -> what the log shows. Encrypted ones are opened with this device's keys (e2ee.js)
async function imToMsg(m) {
  const o = m.enc && HC ? await HC.openDm(m) : { state: m.enc ? 'locked' : 'plain' };
  const open = o.state === 'open';
  return {
    id: 'im' + m.id, imId: m.id, raw: m, created_at: toMs(m.sent_at || m.created_at), edited_at: m.edited_at ? toMs(m.edited_at) : null,
    author: m.from_system ? null : { username: m.from }, system: !!m.from_system, reactions: m.reactions,
    body: m.enc ? (open ? o.text : null) : m.body, sealed: m.enc ? o.state : null, encFiles: open ? o.files : [], dmSig: open ? o.signature : null, quote: open ? o.quote : null,
    reply: m.reply ? { author: { username: m.reply.from }, body: m.reply.gone ? 'deleted message' : (open && o.quote?.s) || m.reply.body } : null,
  };
}
function onHomeFrame(m) {
  switch (m.type) {
    case 'auth_success': S.home.retry = 0; S.home.ws?.send(JSON.stringify({ type: 'chat_hello' })); return;
    case 'chat_ready': case 'ready':
      S.home.status = 'open'; S.home.retry = 0;
      if (m.you?.username) { S.me = m.you.username; store.set(LS.user, S.me); if (m.you.presence) S.presence[S.me] = m.you.presence; }
      renderStatus(); loadDMs(); rewatchPresence();
      return;
    case 'presence_bulk': for (const x of m.presences || []) S.presence[x.username] = x.presence; renderRight(); renderLeft(); return;
    case 'presence_update': if (m.username) { S.presence[m.username] = m.presence; renderRight(); renderLeft(); } return;
    case 'e2ee_keys_changed': if (m.username) HC?.forgetBundle(m.username); return;
    case 'e2ee_link_request': sys('A device or app is asking to read your DMs. Approve it in the Ember app (Settings > Privacy) only if you started it.'); return;
    case 'auth_error': case 'auth_failed':
      if (['invalid_token', 'token_expired', 'banned'].includes(m.error)) signedOut('Your Nookara sign-in ended. Sign in again.');
      else if (m.error === 'maintenance') { S.home.retry = 4; } // (closes; tried again with the slow backoff)
      else { console.warn('Hammi Chat: Nookara socket said', m.error); sys('Live DMs are unavailable: ' + (m.message || m.error || 'Nookara refused the connection')); S.home.noRetry = true; }
      return;
    case 'im_received': case 'im_sent': { (async () => {
      const msg = m.message; if (!msg) return;
      const other = m.type === 'im_sent' || msg.from === S.me ? msg.to : msg.from;
      const vk = `d|${String(other).toLowerCase()}`;
      const nm = await imToMsg(msg);
      const n = m.nonce || msg.nonce;
      if (n && settleDm(n, nm)) return;
      pushMsg(vk, nm);
      if (m.type === 'im_received') { setTyping(vk, other, false); if (vkeyOf(S.view) !== vk || document.hidden) { S.unread[vk] = true; notify(other, nm.body || 'sent a message'); } else markDmRead(other); }
      loadDMs();
    })(); return; }
    case 'im_ack': if (m.message) imToMsg(m.message).then(nm => settleDm(m.nonce, nm)); return;
    case 'im_error': { const p = dmAcks.get(m.nonce); if (p) { dmAcks.delete(m.nonce); updateMessage(p.vkey, p.id, x => ({ ...x, pending: false, failed: m.error })); } sys('DM failed: ' + (m.message || m.error), 'err'); return; }
    case 'im_deleted': { const u = String(m.with || '').toLowerCase(); removeMessage(`d|${u}`, 'im' + m.id); return; }
    case 'im_edited': { const u = String(m.with || '').toLowerCase(); if (m.message) imToMsg(m.message).then(nm => updateMessage(`d|${u}`, nm.id, () => nm)); return; }
    case 'dm_typing': setTyping(`d|${String(m.from).toLowerCase()}`, m.from, m.typing !== false); return;
    case 'im_read_sync': if (m.with) { S.unread[`d|${String(m.with).toLowerCase()}`] = false; renderLeft(); } return;
    case 'friend_request': sys(`${m.from || 'Someone'} sent you a friend request. Accept it on nookara.cc.`); return;
    default: return;
  }
}
async function loadDMs() {
  const d = await nk('/im/conversations').catch(() => null);
  if (!d) return;
  S.dms = (d.conversations || []).filter(c => c.username);
  watchPresence(S.dms.map(c => c.username).filter(u => u !== 'System'));
  for (const c of S.dms) if (c.unread && vkeyOf(S.view) !== `d|${c.username.toLowerCase()}`) S.unread[`d|${c.username.toLowerCase()}`] = true;
  renderLeft();
}
let dmReadT = null;
function markDmRead(u) { clearTimeout(dmReadT); dmReadT = setTimeout(() => nk(`/im/with/${encodeURIComponent(u)}/read`, { method: 'POST' }).catch(() => {}), 400); }

// ───────────────────────── messages ─────────────────────────
function bucket(vk) { return (S.msgs[vk] ||= { list: [], hasMore: false, loading: false, loaded: false }); }
function sortList(list) {
  const seen = new Set(), out = [];
  for (const m of list) { if (!m.pending && seen.has(m.id)) continue; seen.add(m.id); out.push(m); }
  const done = out.filter(m => !m.pending && !m.failed).sort((a, b) => toMs(a.created_at) - toMs(b.created_at));
  return [...done, ...out.filter(m => m.pending || m.failed)];
}
function pushMsg(vk, m) {
  const b = S.msgs[vk];
  if (b && b.loaded) b.list = sortList([...b.list, m]);
  if (vk === vkeyOf(S.view)) renderLog(true);
}
function addMessage(c, m) {
  if (!m) return;
  const vk = `c|${c.origin}|${m.channel}`;
  if (m.nonce && settle(c, m.nonce, m)) return;
  pushMsg(vk, m);
  const mine = m.author && c.user && (m.author.id === c.user.id || m.author.username === c.user.username);
  setTyping(vk, m.author?.username, false);
  if (mine) return;
  const here = vk === vkeyOf(S.view) && !document.hidden;
  if (here) { sendInst(c, { type: 'chat_read', channel: m.channel, message_id: m.id }); return; }
  S.unread[vk] = true;
  if (mentionsMe(c, m)) { S.mentions[vk] = (S.mentions[vk] || 0) + 1; notify(`${m.author?.username} in #${chanName(c.origin, m.channel)}`, m.body); }
  renderLeft();
}
function mentionsMe(c, m) {
  const names = [c.user?.username, S.me].filter(Boolean).map(n => n.toLowerCase());
  const b = String(m.body || '').toLowerCase();
  return names.some(n => b.includes('@' + n)) || /@everyone|@here/.test(b) || (m.mentions || []).some(x => names.includes(String(x.username || x).toLowerCase()));
}
function updateMessage(vk, id, fn) {
  const b = S.msgs[vk]; if (!b) return;
  let hit = false;
  b.list = b.list.map(x => (x.id === id ? (hit = true, fn(x)) : x));
  if (hit && vk === vkeyOf(S.view)) renderLog();
}
function removeMessage(vk, id) {
  const b = S.msgs[vk]; if (!b) return;
  b.list = b.list.filter(x => x.id !== id);
  if (vk === vkeyOf(S.view)) renderLog();
}
function settle(c, n, msg) {
  const p = c.acks.get(n); if (!p) return false;
  c.acks.delete(n);
  const b = S.msgs[p.vkey];
  if (b) b.list = sortList(b.list.filter(x => x.id !== p.id && x.id !== msg?.id).concat(msg ? [msg] : []));
  if (msg) S.lastSent[p.vkey] = msg.id;
  if (p.vkey === vkeyOf(S.view)) renderLog(true);
  return true;
}
const dmAcks = new Map();
function settleDm(n, msg) {
  const p = dmAcks.get(n); if (!p) return false;
  dmAcks.delete(n);
  const b = S.msgs[p.vkey];
  if (b) b.list = sortList(b.list.filter(x => x.id !== p.id && x.id !== msg.id).concat([msg]));
  S.lastSent[p.vkey] = msg.id;
  if (p.vkey === vkeyOf(S.view)) renderLog(true);
  return true;
}

async function loadMessages(v, older = false) {
  const vk = vkeyOf(v), b = bucket(vk);
  if (b.loading || (older && !b.hasMore) || (!older && b.loaded)) return;
  b.loading = true;
  try {
    const first = older ? b.list.find(x => !x.pending) : null;
    let list = [], more = false;
    if (v.kind === 'channel') {
      const c = S.insts.get(v.origin);
      const d = await api(c, `/channels/${encodeURIComponent(v.cid)}/messages?limit=50${first ? `&before=${encodeURIComponent(first.id)}` : ''}`);
      list = d.messages || []; more = !!d.has_more;
    } else if (v.kind === 'dm') {
      const d = S.demo ? demoDm(v.user) : await nk(`/im/with/${encodeURIComponent(v.user)}?limit=50${first ? `&before=${encodeURIComponent(first.imId)}` : ''}`);
      list = await Promise.all((d.messages || []).map(imToMsg)); more = !!d.has_more;
    }
    b.list = sortList([...list, ...b.list]); b.hasMore = more; b.loaded = true;
  } catch (e) {
    sys('could not load messages: ' + e.message, 'err');
  } finally { b.loading = false; }
  if (vk === vkeyOf(S.view)) renderLog(!older);
}

async function send(text) {
  const v = S.view;
  const vk = vkeyOf(v);
  if (S.editing) return saveEdit(text);
  const id = 'pending-' + nonce(), n = nonce();
  const reply = S.replyTo;
  const local = { id, nonce: n, pending: true, body: text, created_at: Date.now(), author: { username: v.kind === 'channel' ? (S.insts.get(v.origin)?.user?.username || S.me) : S.me }, reply: reply ? { author: { username: reply.who }, body: reply.text } : null };
  setReply(null);
  const b = bucket(vk); b.list = sortList([...b.list, local]); renderLog(true);
  if (S.demo) { setTimeout(() => updateMessage(vk, id, x => ({ ...x, id: 'demo' + n, pending: false })), 250); return; }
  if (v.kind === 'channel') {
    const c = S.insts.get(v.origin);
    const body = text.replace(/\r\n/g, '\n');
    const signature = await signFor(c, v, body, { reply_to: reply ? reply.id : null });
    const frame = sig => ({ type: 'chat_send', nonce: n, channel: v.cid, message: body, ...(reply ? { reply_to: reply.id } : {}), ...(sig ? { signature: sig } : {}) });
    // the server turned the signature down: once more without it (and say so)
    const resend = signature ? () => { sys('This server did not accept the signature, so the message was sent unsigned.', 'err'); c.acks.set(n, { vkey: vk, id }); sendInst(c, frame(null)); } : null;
    c.acks.set(n, { vkey: vk, id, resend });
    if (!sendInst(c, frame(signature))) {
      const post = sig => api(c, `/channels/${encodeURIComponent(v.cid)}/messages`, { method: 'POST', body: JSON.stringify({ message: body, ...(reply ? { reply_to: reply.id } : {}), ...(sig ? { signature: sig } : {}) }) });
      try { const r = await post(signature).catch(e => (signature && SIGN_REFUSED.has(e.message) ? post(null) : Promise.reject(e))); settle(c, n, r.message || r); }
      catch (e) { c.acks.delete(n); updateMessage(vk, id, x => ({ ...x, pending: false, failed: e.message })); }
    }
  } else if (v.kind === 'dm') {
    dmAcks.set(n, { vkey: vk, id });
    const replyTo = reply ? { reply_to: String(reply.id).replace(/^im/, '') } : {};
    let frame;
    try {
      const quote = reply ? { from: reply.who, s: String(reply.text || '').slice(0, 200) } : null;
      frame = { type: 'im_send', to: v.user, enc: await HC.sealDm(v.user, text, quote), nonce: n, ...replyTo };
    } catch (e) {
      if (e.message === 'no_keys') { frame = { type: 'im_send', to: v.user, message: text, nonce: n, ...replyTo }; sys(`${v.user} hasn't set up encrypted DMs, so this one went unencrypted.`); }
      else {
        dmAcks.delete(n);
        updateMessage(vk, id, x => ({ ...x, pending: false, failed: e.message === 'e2ee_locked' ? 'unlock encrypted DMs first: /unlock' : e.message }));
        if (e.message === 'e2ee_locked') e2eeHint();
        return;
      }
    }
    if (S.home.ws?.readyState === 1) S.home.ws.send(JSON.stringify(frame));
    else { dmAcks.delete(n); updateMessage(vk, id, x => ({ ...x, pending: false, failed: 'offline' })); }
  }
}
const SIGN_REFUSED = new Set(['bad_signature', 'signing_unavailable']);
// a signature for a message to an Ember server, when this account can sign there (null otherwise: it goes unsigned)
async function signFor(c, v, body, { reply_to = null, edit_of = null } = {}) {
  if (!HC?.canSign() || c.info?.accounts_mode !== 'velora' || !c.user?.velora_id) return null;
  try { return await HC.signMessage({ instance: c.origin, community: v.sid, channel: v.cid, author: c.user.velora_id, body, attachments: [], reply_to, edit_of }, c.info); }
  catch { return null; }
}
async function saveEdit(text) {
  const { id, vkey: vk } = S.editing; S.editing = null; setPromptLabel();
  const v = S.view;
  try {
    if (v.kind === 'channel') {
      const c = S.insts.get(v.origin), m = findMsg(id);
      const reply_to = m?.reply_to && typeof m.reply_to === 'object' ? m.reply_to.id : (m?.reply_to ?? m?.reply?.id ?? null);
      const sig = (m?.attachments || []).length ? null : await signFor(c, v, text, { reply_to, edit_of: id });
      const patch = sg => api(c, `/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ message: text, ...(sg ? { signature: sg } : {}) }) });
      await patch(sig).catch(e => (sig && SIGN_REFUSED.has(e.message) ? patch(null) : Promise.reject(e)));
    } else if (v.kind === 'dm') {
      const m = findMsg(id), raw = m?.raw || {};
      const path = `/im/${encodeURIComponent(String(id).replace(/^im/, ''))}/edit`;
      if (!raw.enc) await nk(path, { method: 'PATCH', body: JSON.stringify({ body: text }) });
      else {
        const wire = [text, ...(m.encFiles || [])].filter(Boolean).join('\n');
        await nk(path, { method: 'PATCH', body: JSON.stringify({ enc: await HC.sealEdit({ id: raw.id, from_id: raw.from_id, to_id: raw.to_id, quote: m.quote }, v.user, wire) }) });
      }
    }
    updateMessage(vk, id, x => ({ ...x, body: text, edited_at: Date.now() }));
  } catch (e) { sys('edit failed: ' + e.message, 'err'); }
}
async function deleteMsg(id) {
  const v = S.view;
  if (!confirm('Delete this message?')) return;
  try {
    if (S.demo) { /* nothing to tell */ }
    else if (v.kind === 'channel') await api(S.insts.get(v.origin), `/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
    else if (v.kind === 'dm') await nk(`/im/${encodeURIComponent(String(id).replace(/^im/, ''))}`, { method: 'DELETE' });
    removeMessage(vkeyOf(v), id);
  } catch (e) { sys('delete failed: ' + e.message, 'err'); }
}
async function react(id, emoji) {
  const v = S.view; if (v.kind !== 'channel' || S.demo) return;
  try { await api(S.insts.get(v.origin), `/messages/${encodeURIComponent(id)}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }); }
  catch (e) { sys('reaction failed: ' + e.message, 'err'); }
}

// typing
function setTyping(vk, name, on) {
  if (!name) return;
  const t = (S.typing[vk] ||= {});
  if (on) t[name] = Date.now() + 8000; else delete t[name];
  if (vk === vkeyOf(S.view)) renderTyping();
}
setInterval(renderTyping, 2000);
let typingSentAt = 0;
function sendTyping() {
  const v = S.view, now = Date.now();
  if (now - typingSentAt < 3000 || S.demo) return;
  typingSentAt = now;
  if (v.kind === 'channel') sendInst(S.insts.get(v.origin), { type: 'chat_typing', channel: v.cid, typing: true });
  else if (v.kind === 'dm' && S.home.ws?.readyState === 1) S.home.ws.send(JSON.stringify({ type: 'dm_typing', to: v.user, typing: true }));
}

// ───────────────────────── views ─────────────────────────
function chanName(origin, cid) {
  for (const [k, d] of Object.entries(S.detail)) if (k.startsWith(origin + '|')) { const ch = d.channels.find(x => x.cid === cid); if (ch) return ch.name; }
  return cid;
}
function go(v, { save = true } = {}) {
  S.view = v; S.editing = null; setReply(null);
  const vk = vkeyOf(v);
  S.unread[vk] = false; S.mentions[vk] = 0;
  if (save && v.kind !== 'home') store.set(LS.last, v);
  closeDrawers();
  if (v.kind === 'channel') {
    const c = S.insts.get(v.origin);
    if (c && !S.members[skey(v.origin, v.sid)]) loadMembers(c, v.sid).catch(() => {});
    loadMessages(v).then(() => { const b = S.msgs[vk]; const last = b?.list.filter(x => !x.pending).pop(); if (last) sendInst(c, { type: 'chat_read', channel: v.cid, message_id: last.id }); });
  } else if (v.kind === 'dm') { loadMessages(v); if (!S.demo) { markDmRead(v.user); if (HC.status() !== 'ready' && HC.status() !== 'loading') e2eeHint(); } }
  render();
  $('input').focus({ preventScroll: true });
}
function restoreView() {
  if (S.view.kind !== 'home') return;
  const last = store.get(LS.last);
  if (last?.kind === 'channel' && S.detail[skey(last.origin, last.sid)]?.channels.some(ch => ch.cid === last.cid)) go(last, { save: false });
  else if (last?.kind === 'dm' && !S.demo) go(last, { save: false });
  else {
    const first = [...S.insts.values()].flatMap(c => c.servers.map(s => ({ c, s })))[0];
    const ch = first && textChannels(skey(first.c.origin, first.s.sid))[0];
    if (ch) go({ kind: 'channel', origin: first.c.origin, sid: first.s.sid, cid: ch.cid }, { save: false });
  }
}
const textChannels = k => (S.detail[k]?.channels || []).filter(ch => !ch.type || ch.type === 'text' || ch.type === 'announcement' || ch.type === 'news');
function orderedChannels(d) {
  const cats = ['', ...(d.categories || []).map(c => (typeof c === 'string' ? c : c.name))];
  const groups = cats.map(name => ({ name, list: [] }));
  for (const ch of [...d.channels].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) (groups.find(g => g.name === (ch.category || '')) || groups[0]).list.push(ch);
  return groups.filter(g => g.list.length);
}

// ───────────────────────── rendering ─────────────────────────
function render() { renderStatus(); renderLeft(); renderRight(); renderLog(true); renderTyping(); setPromptLabel(); }

function renderStatus() {
  const v = S.view;
  let server = 'not connected', channel = '', count = '';
  if (v.kind === 'channel') {
    const d = S.detail[skey(v.origin, v.sid)];
    server = d?.server?.name || hostOf(v.origin);
    channel = '#' + (d?.channels.find(c => c.cid === v.cid)?.name || '?');
    const mem = S.members[skey(v.origin, v.sid)];
    if (mem) count = `${mem.filter(m => isOnline(m)).length || mem.length} ${mem.some(isOnline) ? 'online' : 'members'}`;
  } else if (v.kind === 'dm') { server = 'direct messages'; channel = '@' + v.user; }
  else if (S.me) server = 'home';
  $('st-server').textContent = server;
  $('st-channel').textContent = channel;
  $('st-count').textContent = count;
  const anyOpen = [...S.insts.values()].some(c => c.status === 'open') || S.home.status === 'open' || S.demo;
  const me = $('st-me');
  const lock = !S.demo && HC?.status() === 'ready' ? ' 🔒' : '';
  me.textContent = S.me ? `${S.me}${lock} · ${S.demo ? 'demo' : anyOpen ? 'connected' : 'connecting'}` : (S.token ? 'connecting' : 'offline');
  me.classList.toggle('off', !anyOpen);
  document.title = (Object.values(S.unread).some(Boolean) ? '* ' : '') + (channel ? channel + ' · ' : '') + 'Hammi Chat';
}
const presenceOf = name => { const p = S.presence[name]; return p && p.chat === false ? null : p; };
const isOnline = m => m.online === true || ['online', 'idle', 'dnd'].includes(presenceOf(m.username)?.status || m.presence?.status || m.status);
const watched = new Set();
function watchPresence(names) {
  const fresh = [...new Set(names.filter(Boolean))].filter(n => !watched.has(n));
  fresh.forEach(n => watched.add(n));
  if (S.home.ws?.readyState !== 1) return;
  for (let i = 0; i < fresh.length; i += 200) S.home.ws.send(JSON.stringify({ type: 'chat_presence_watch', usernames: fresh.slice(i, i + 200) }));
}
function rewatchPresence() {
  const names = [...watched, ...S.dms.map(d => d.username)].filter(n => n && n !== S.me);
  watched.clear(); watchPresence(names);
}

function renderLeft() {
  const out = [];
  out.push(`<div class="h">SERVERS <button class="add" data-act="add" title="Add an Ember server">+</button></div>`);
  if (!S.insts.size) out.push(`<div class="empty">none yet: /add &lt;address&gt;</div>`);
  for (const c of S.insts.values()) {
    if (c.status !== 'open' && !c.servers.length) {
      const label = { connecting: 'connecting...', closed: 'reconnecting...', error: c.error || 'error', banned: 'banned', restricted: 'restricted' }[c.status] || c.status;
      out.push(`<div class="ln ${c.status === 'error' || c.status === 'banned' ? 'warn' : ''}" title="${esc(c.error || '')}">${esc(c.info?.community?.name || c.info?.name || hostOf(c.origin))} <small>${esc(label)}</small></div>`);
      continue;
    }
    for (const s of c.servers) {
      const k = skey(c.origin, s.sid), d = S.detail[k];
      const here = S.view.kind === 'channel' && S.view.origin === c.origin && S.view.sid === s.sid;
      const un = (d?.channels || []).filter(ch => S.unread[`c|${c.origin}|${ch.cid}`]).length;
      const men = (d?.channels || []).reduce((a, ch) => a + (S.mentions[`c|${c.origin}|${ch.cid}`] || 0), 0);
      out.push(`<button class="ln ${here ? 'hot' : un ? 'hot' : ''}" data-act="server" data-o="${esc(c.origin)}" data-s="${esc(s.sid)}">${here ? '▾' : '▸'} ${esc(d?.server?.name || s.name || s.sid)}${men ? ` <span class="n">[@${men}]</span>` : un ? ` <span class="n">[${un}]</span>` : ''}${c.status !== 'open' ? ' <small>~</small>' : ''}</button>`);
      if (!here || !d) continue;
      for (const g of orderedChannels(d)) {
        if (g.name) out.push(`<div class="ln sub"><small>${esc(g.name.toUpperCase())}</small></div>`);
        for (const ch of g.list) {
          const vk = `c|${c.origin}|${ch.cid}`, on = vkeyOf(S.view) === vk;
          const voice = ch.type === 'voice', link = ch.type === 'link';
          const icon = voice ? '♪' : link ? '↗' : '#';
          if (voice || link) { out.push(`<div class="ln sub" title="${voice ? 'Voice channels need the full Ember app' : esc(ch.config?.url || '')}"><small>${icon}${esc(ch.name)}</small></div>`); continue; }
          out.push(`<button class="ln sub ${on ? 'on' : S.unread[vk] ? 'hot' : ''}" data-act="channel" data-o="${esc(c.origin)}" data-s="${esc(s.sid)}" data-c="${esc(ch.cid)}">${icon}${esc(ch.name)}${S.mentions[vk] ? ` <span class="n">@${S.mentions[vk]}</span>` : ''}</button>`);
        }
      }
    }
  }
  out.push(`<div class="h">DIRECT <button class="add" data-act="newdm" title="Message someone">+</button></div>`);
  if (!S.dms.length) out.push(`<div class="empty">no DMs yet: /dm &lt;name&gt;</div>`);
  for (const d of S.dms.slice(0, 40)) {
    const vk = `d|${d.username.toLowerCase()}`, on = vkeyOf(S.view) === vk;
    out.push(`<button class="ln ${on ? 'on' : S.unread[vk] ? 'hot' : ''}" data-act="dm" data-u="${esc(d.username)}">${isOnline(d) ? '●' : '○'} ${esc(d.username)}${S.unread[vk] && !on ? ' <span class="n">*</span>' : ''}</button>`);
  }
  $('left').innerHTML = out.join('');
  renderStatus();
}

function renderRight() {
  const v = S.view, out = [];
  if (v.kind === 'channel') {
    const mem = S.members[skey(v.origin, v.sid)];
    if (!mem) out.push('<div class="empty">loading members...</div>');
    else {
      const name = m => m.nick || m.display_name || m.username;
      const mark = m => (m.owner || m.is_owner ? '~' : m.admin || m.is_admin ? '&amp;' : m.moderator || m.is_mod ? '@' : m.bot ? '+' : '&nbsp;');
      const hasPresence = mem.some(m => 'online' in m || m.presence || m.status);
      const on = hasPresence ? mem.filter(isOnline) : mem, off = hasPresence ? mem.filter(m => !isOnline(m)) : [];
      out.push(`<div class="h">${hasPresence ? 'ONLINE' : 'MEMBERS'} · ${on.length}</div>`);
      for (const m of on.slice(0, 300)) out.push(`<button class="ln" data-act="dm" data-u="${esc(m.username)}" style="color:${nameColor(m.username)}" title="Message ${esc(m.username)}">${mark(m)}${esc(name(m))}${m.bot ? ' <small>bot</small>' : ''}</button>`);
      if (off.length) { out.push(`<div class="h">OFFLINE · ${off.length}</div>`); for (const m of off.slice(0, 300)) out.push(`<button class="ln" data-act="dm" data-u="${esc(m.username)}">${mark(m)}${esc(name(m))}</button>`); }
    }
  } else if (v.kind === 'dm') {
    out.push(`<div class="h">TALKING TO</div><div class="ln" style="color:${nameColor(v.user)}">${esc(v.user)}</div>`);
    const st = HC?.status();
    out.push(`<div class="h">ENCRYPTION</div><div class="empty" style="white-space:normal">${st === 'ready' ? '🔒 DMs are end-to-end encrypted on this device.' : st === 'locked' ? 'Locked here. Type /unlock to read encrypted DMs.' : st === 'none' ? 'Not set up yet. Type /unlock to set up encrypted DMs.' : 'checking...'}</div>`);
  } else out.push('<div class="h">MEMBERS</div><div class="empty">pick a channel</div>');
  $('right').innerHTML = out.join('');
}

// message text: escaped, then links, @mentions and `code`
// UTF-8 file names that were read as Latin-1 somewhere on the way ("â¯" for a narrow space): put them back
const fixName = n => { const t = String(n || ''); if (!/[\u00c2-\u00f4][\u0080-\u00bf]/.test(t)) return t; try { return decodeURIComponent(escape(t)); } catch { return t; } };
const emojiSrc = (eid, animated, origin) => S.emojiUrls[eid] || `${NOOKARA}/uploads/emojis/${eid}.${animated ? 'gif' : 'png'}`;
// who <@v:223> / <@123> is: the server's member list first, then anyone seen in this conversation
function personById(id, ctx) {
  const mem = ctx?.sid ? S.members[skey(ctx.origin, ctx.sid)] : null;
  const u = mem?.find(x => String(x.id) === id || (/^\d+$/.test(id) && String(x.velora_id) === id) || (/^v:\d+$/.test(id) && String(x.velora_id) === id.slice(2)));
  return u ? (u.nick || u.display_name || u.username) : null;
}
function channelByCid(cid, ctx) {
  for (const [k, d] of Object.entries(S.detail)) if (!ctx?.origin || k.startsWith(ctx.origin + '|')) { const ch = d.channels.find(x => x.cid === cid); if (ch) return { ch, sid: k.split('|').pop(), origin: k.slice(0, k.lastIndexOf('|')) }; }
  return null;
}
function stamp(sec, style) {
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  if (style === 'R') { const diff = (d - Date.now()) / 1000, a = Math.abs(diff); const [n, u] = a < 60 ? [diff, 'second'] : a < 3600 ? [diff / 60, 'minute'] : a < 86400 ? [diff / 3600, 'hour'] : [diff / 86400, 'day']; return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(n), u); }
  const o = { t: { timeStyle: 'short' }, T: { timeStyle: 'medium' }, d: { dateStyle: 'short' }, D: { dateStyle: 'long' }, f: { dateStyle: 'long', timeStyle: 'short' }, F: { dateStyle: 'full', timeStyle: 'short' } };
  return new Intl.DateTimeFormat(undefined, o[style] || o.f).format(d);
}
function fmt(body, myNames, ctx) {
  let s = esc(body);
  s = s.replace(/`([^`\n]{1,400})`/g, '<span class="code">$1</span>');
  // custom emoji <:name:eid> / <a:name:eid>: Nookara's copy first, the server's own if that fails
  s = s.replace(/&lt;(a?):([A-Za-z0-9_]{1,32}):(e[0-9a-f]{10})&gt;/g, (all, a, name, eid) => `<img class="emo" src="${esc(emojiSrc(eid, a, ctx?.origin))}" alt=":${name}:" title=":${name}:" data-alt="${ctx?.origin ? esc(`${ctx.origin}/uploads/emojis/${eid}.${a ? 'gif' : 'png'}`) : ''}" onerror="this.dataset.alt?(this.src=this.dataset.alt,this.dataset.alt=''):this.replaceWith(this.alt)">`);
  s = s.replace(/&lt;@!?((?:[vlb]:)?\d{1,20})&gt;/g, (all, id) => { const n = personById(id, ctx); return n ? `<span class="${myNames.includes(n.toLowerCase()) ? 'mention-tx' : 're'}">@${esc(n)}</span>` : '<span class="re">@unknown</span>'; });
  s = s.replace(/&lt;@&amp;(r[0-9a-f]{10})&gt;/g, (all, rid) => { const r = (S.detail[skey(ctx?.origin, ctx?.sid)]?.roles || []).find(x => x.rid === rid); return `<span class="re">@${esc(r?.name || 'role')}</span>`; });
  s = s.replace(/&lt;#(c[0-9a-f]{10})&gt;/g, (all, cid) => { const f = channelByCid(cid, ctx); return f ? `<button class="chlink" data-act="channel" data-o="${esc(f.origin)}" data-s="${esc(f.sid)}" data-c="${esc(cid)}">#${esc(f.ch.name)}</button>` : '<span class="re">#unknown</span>'; });
  s = s.replace(/&lt;t:(-?\d{1,13})(?::([tTdDfFR]))?&gt;/g, (all, t, st) => { const x = stamp(t, st || 'f'); return x ? `<span class="code" title="${esc(new Date(t * 1000).toLocaleString())}">${esc(x)}</span>` : all; });
  s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,:;!?)\]'"]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  s = s.replace(/(^|[\s(])@([A-Za-z0-9_.-]{2,32})/g, (all, pre, n) => `${pre}<span class="${myNames.includes(n.toLowerCase()) ? 'mention-tx' : 're'}">@${n}</span>`);
  return s;
}
const isImage = a => /^image\//.test(a.type || a.content_type || a.mime || '') || /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(a.url || a.name || '');
const size = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n ? n + ' B' : '');
let sysLines = [];
function sys(text, cls = 'sys') { sysLines.push({ id: 'sys' + nonce(), created_at: Date.now(), sysText: text, cls, view: vkeyOf(S.view) }); sysLines = sysLines.slice(-30); renderLog(true); }

function renderLog(stick) {
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const vk = vkeyOf(S.view), b = S.msgs[vk];
  const c = S.view.kind === 'channel' ? S.insts.get(S.view.origin) : null;
  const myNames = [S.me, c?.user?.username].filter(Boolean).map(n => n.toLowerCase());
  const meIds = [c?.user?.id, S.me].filter(Boolean);
  const out = [];
  if (S.view.kind === 'home') {
    out.push(line('sys', `*** Welcome to Hammi Chat${S.me ? ', ' + esc(S.me) : ''}. Pick a channel on the left, or press Ctrl+K.`));
    out.push(line('sys', '*** /help lists the commands. /add &lt;address&gt; adds an Ember server, /join &lt;invite&gt; joins one.'));
  } else if (b?.hasMore) out.push(`<button class="more" data-act="older">load older messages</button>`);
  else if (b?.loaded) out.push(line('sys', S.view.kind === 'dm' ? `*** start of your messages with ${esc(S.view.user)}` : `*** start of #${esc(chanName(S.view.origin, S.view.cid))}`));
  if (b?.loading && !b.list.length) out.push(line('sys', '*** loading...'));
  const all = [...(b?.list || []), ...sysLines.filter(x => x.view === vk)].sort((x, y) => (x.pending || x.failed ? 1 : 0) - (y.pending || y.failed ? 1 : 0) || toMs(x.created_at) - toMs(y.created_at));
  let lastDay = null;
  for (const m of all) {
    const day = dayOf(m.created_at);
    if (lastDay && day !== lastDay) out.push(`<div class="day">─── ${esc(new Date(toMs(m.created_at)).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))} ───</div>`);
    lastDay = day;
    if (m.sysText) { out.push(line(m.cls, '*** ' + esc(m.sysText), m.created_at)); continue; }
    if (m.system) { out.push(line('sys', '*** ' + esc(m.body || ''), m.created_at)); continue; }
    const who = m.alias?.name || m.author?.nick || m.author?.display_name || m.author?.username || 'unknown';
    const mine = (m.author && (meIds.includes(m.author.id) || myNames.includes(String(m.author.username || '').toLowerCase())));
    const mention = !mine && m.body && myNames.some(n => String(m.body).toLowerCase().includes('@' + n));
    let tx = '';
    const rp = m.reply || (m.reply_to && typeof m.reply_to === 'object' ? m.reply_to : null);
    if (rp) tx += `<span class="rp">↱ ${esc(rp.author?.username || rp.username || '?')}: ${esc(String(rp.body || rp.message || '').slice(0, 140))}</span>`;
    const ctx = S.view.kind === 'channel' ? { origin: S.view.origin, sid: S.view.sid } : null;
    if (m.sealed === 'locked') tx += '<span class="rx">[locked: an encrypted DM. Type /unlock to read your DMs here]</span>';
    else if (m.sealed === 'failed') tx += '<span class="rx">[encrypted for a key this device doesn\'t have]</span>';
    else tx += fmt(m.body || '', myNames, ctx);
    for (const link of m.encFiles || []) {
      const f = HC.parseFileLink(link); if (!f) continue;
      const img = /^image\//.test(f.mime || '');
      tx += `<button class="att efile" data-act="efile" data-link="${esc(link)}" data-img="${img ? 1 : ''}">[${img ? 'image' : 'file'}, encrypted] ${esc(fixName(f.name))}</button>`;
    }
    if (m.dmSig === 'valid') tx += ' <span class="sig ok" title="Encrypted, and signed by their key">🔒</span>';
    else if (m.dmSig === 'invalid') tx += ' <span class="sig bad" title="The signature on this encrypted message does not match the sender\'s key">[signature mismatch]</span>';
    else if (m.sealed === 'open') tx += ' <span class="sig" title="Encrypted">🔒</span>';
    if (m.signature && S.view.kind === 'channel') {
      const sk = `${S.view.origin}|${m.id}|${m.signature.sig}`, vd = S.sigs[sk];
      if (vd === 'ok') tx += ' <span class="sig ok" title="Signed: it really came from this Nookara account">✓</span>';
      else if (vd === 'bad') tx += ' <span class="sig bad" title="This message\'s signature does not check out. It may have been changed or faked.">[bad signature]</span>';
      else if (vd === undefined) { S.sigs[sk] = null; const c = S.insts.get(S.view.origin); HC.checkMessage({ ...m, origin: S.view.origin }, c?.info).then(r => { S.sigs[sk] = r || 'none'; if (r) renderLog(); }); }
    }
    if (m.edited_at) tx += ' <span class="ed">(edited)</span>';
    for (const a of m.attachments || []) {
      const url = typeof a === 'string' ? a : a.url;
      if (!url || !/^https?:\/\//i.test(url)) continue;
      let name = a.name || a.filename; if (!name) { name = url.split('/').pop().split('?')[0] || 'file'; try { name = decodeURIComponent(name); } catch { /* keep */ } }
      name = fixName(name);
      tx += isImage(a) ? `<a class="att" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(url)}" alt="${esc(name)}" loading="lazy">${esc(name)} ${size(a.size)}</a>` : `<a class="att" href="${esc(url)}" target="_blank" rel="noopener noreferrer">[file] ${esc(name)} ${size(a.size)}</a>`;
    }
    if (m.reactions?.length) tx += ' <span class="rx">' + m.reactions.map(r => `${r.me ? '<b>' : ''}${esc(r.emoji?.name || r.emoji)}${r.count ?? (r.users || []).length}${r.me ? '</b>' : ''}`).join(' ') + '</span>';
    if (m.ephemeral) tx += ' <span class="ed">(only you can see this)</span>';
    if (m.failed) tx += ` <span class="ed">[not sent: ${esc(m.failed)}]</span>`;
    const tag = m.author?.bot ? '<span class="tag">BOT</span>' : m.author?.webhook ? '<span class="tag">HOOK</span>' : '';
    const acts = m.pending || m.failed || m.ephemeral ? '' : `<span class="acts"><button data-act="reply" data-id="${esc(m.id)}" title="Reply">reply</button>${S.view.kind === 'channel' ? `<button data-act="react" data-id="${esc(m.id)}" title="React">+:)</button>` : ''}${mine ? `<button data-act="edit" data-id="${esc(m.id)}">edit</button><button data-act="del" data-id="${esc(m.id)}">del</button>` : ''}</span>`;
    out.push(`<div class="l${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${mention ? ' mention' : ''}" data-id="${esc(m.id)}"><span class="ts">${hhmm(m.created_at)}</span><button class="nk" style="color:${nameColor(m.author?.username || who)}" data-act="dm" data-u="${esc(m.author?.username || '')}" title="${esc(m.author?.username || '')}">${esc(who)}</button><span class="tx">${tag}${tx}</span>${acts}</div>`);
  }
  log.innerHTML = out.join('');
  if (stick || atBottom) log.scrollTop = log.scrollHeight;
}
const line = (cls, html, t = Date.now()) => `<div class="l ${cls}"><span class="ts">${hhmm(t)}</span><span class="tx">${html}</span></div>`;

function renderTyping() {
  const t = S.typing[vkeyOf(S.view)] || {}, now = Date.now();
  const names = Object.entries(t).filter(([, u]) => u > now).map(([n]) => n).filter(n => n !== S.me);
  $('typing').textContent = !names.length ? '' : names.length > 3 ? '... several people are typing' : `... ${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} typing`;
}
function setPromptLabel() {
  const v = S.view;
  const l = S.editing ? '[edit]' : v.kind === 'channel' ? `[#${chanName(v.origin, v.cid)}]` : v.kind === 'dm' ? `[@${v.user}]` : '[hammi]';
  $('prompt-label').textContent = l;
}
function setReply(r) {
  S.replyTo = r;
  const bar = $('replybar');
  bar.hidden = !r;
  if (r) { bar.innerHTML = `<span>↱ replying to ${esc(r.who)}: ${esc(r.text.slice(0, 120))}</span><button type="button" data-act="noreply">[x]</button>`; $('input').focus(); }
}
function findMsg(id) { return S.msgs[vkeyOf(S.view)]?.list.find(x => x.id === id); }

// ───────────────────────── commands ─────────────────────────
const HELP = [
  '/help ................ this list',
  '/add <address> ....... add an Ember server (e.g. /add e-myserver.nookara.cc)',
  '/join <invite link> .. join a server from an invite',
  '/remove <address> .... remove a server from your list',
  '/dm <name> [text] .... message someone',
  '/me <action> ......... say something in third person',
  '/shrug [text] ........ ¯\\_(ツ)_/¯',
  '/reload .............. reload this channel',
  '/unlock .............. read your encrypted DMs on this device',
  '/lock ................ forget your DM keys on this device',
  '/logout .............. sign out of Nookara on this device',
  'Ctrl+K jumps anywhere, Alt+↑/↓ moves between channels, ↑ in an empty box edits your last message, Shift+Enter makes a new line.',
];
async function command(raw) {
  const [cmd, ...rest] = raw.slice(1).split(' ');
  const arg = rest.join(' ').trim();
  switch (cmd.toLowerCase()) {
    case 'help': case '?': HELP.forEach(h => sys(h)); return;
    case 'add': {
      const o = normOrigin(arg);
      if (!o) { sys('usage: /add <server address>', 'err'); return; }
      await addServer(o); return;
    }
    case 'remove': {
      const o = normOrigin(arg);
      if (!o || !S.insts.has(o)) { sys('no such server in your list', 'err'); return; }
      const c = S.insts.get(o); S.insts.delete(o); try { c.ws?.close(); } catch { /* gone */ } clearTimeout(c.timer);
      await saveList(); sys('removed ' + hostOf(o)); renderLeft(); return;
    }
    case 'join': await joinInvite(arg); return;
    case 'dm': case 'msg': case 'query': {
      const [u, ...m] = arg.split(' ');
      if (!u) { sys('usage: /dm <name> [message]', 'err'); return; }
      go({ kind: 'dm', user: u.replace(/^@/, '') });
      if (m.length) send(m.join(' '));
      return;
    }
    case 'me': if (arg) send(`_${arg}_`); return;
    case 'shrug': send(`${arg ? arg + ' ' : ''}¯\\_(ツ)_/¯`); return;
    case 'reload': if (S.view.kind !== 'home') { S.msgs[vkeyOf(S.view)] = null; loadMessages(S.view); } return;
    case 'logout': case 'signout': signOut(); return;
    case 'unlock': case 'e2ee': case 'keys': openKeys(); return;
    case 'lock': await HC.forget(); sys('Encrypted DMs are locked again on this device.'); return;
    case 'clear': sysLines = sysLines.filter(x => x.view !== vkeyOf(S.view)); renderLog(true); return;
    default: sys(`unknown command /${cmd}. Try /help.`, 'err');
  }
}
async function saveList() {
  if (S.demo || !S.token) return;
  await nk('/bonfire/instances', { method: 'PUT', body: JSON.stringify({ instances: [...S.insts.keys()].map(url => ({ url })) }) }).catch(e => sys('could not save your server list on Nookara: ' + e.message, 'err'));
}
async function addServer(origin) {
  if (S.insts.has(origin)) { sys(hostOf(origin) + ' is already in your list'); return S.insts.get(origin); }
  sys('connecting to ' + hostOf(origin) + '...');
  try { await discover(origin); } catch (e) { sys(`${hostOf(origin)}: ${e.message}`, 'err'); return null; }
  const c = addInstance(origin);
  await saveList();
  return c;
}
// invite links: https://<server>/invite/<code>, https://ember.nookara.cc/#/i/<server>/invite/<code>, or "<server> <code>"
async function joinInvite(arg) {
  let origin = null, code = null;
  try {
    const u = new URL(arg);
    const h = /#\/i\/([^/]+)\/invite\/([A-Za-z0-9]{4,32})/.exec(u.hash);
    if (h) { origin = normOrigin(decodeURIComponent(h[1])); code = h[2]; }
    else { const p = /\/invite\/([A-Za-z0-9]{4,32})\/?$/.exec(u.pathname); if (p && !/nookara\.cc$/i.test(u.hostname)) { origin = u.origin; code = p[1]; } }
  } catch { const [a, b] = arg.split(/\s+/); if (b) { origin = normOrigin(a); code = b; } }
  if (!origin || !code) { sys('usage: /join <invite link>  (links on the main Nookara chat need the full Ember app)', 'err'); return; }
  const c = S.insts.get(origin) || await addServer(origin);
  if (!c) return;
  for (let i = 0; i < 20 && !c.session; i++) await sleep(300);
  try { await api(c, `/join/${encodeURIComponent(code)}`, { method: 'POST' }); sys('joined! loading channels...'); await loadServers(c); }
  catch (e) { sys('join failed: ' + (e.data?.message || e.message), 'err'); }
}

// ───────────────────────── encrypted DM keys (/unlock) ─────────────────────────
let hinted = false;
function e2eeHint() {
  if (hinted || S.demo) return; hinted = true;
  const st = HC.status();
  if (st === 'locked') sys('Your encrypted DMs are locked on this device. Type /unlock to read them.');
  else if (st === 'none') sys('You have not set up encrypted DMs yet. Type /unlock to set them up.');
}
let linkReq = null;
function openKeys(note = '') {
  const st = HC.status(), box = $('keys-body');
  const t = HC.passcodeType();
  let html = `<div class="h">ENCRYPTED DMS</div>`;
  if (note) html += `<p class="${/fail|wrong|error|denied|expired/i.test(note) ? 'bad' : 'ok'}">${esc(note)}</p>`;
  if (st === 'ready') html += `<p>Unlocked on this device. Your DMs are end-to-end encrypted: Nookara only ever sees scrambled text.</p><div class="login-actions"><button class="kbtn" data-act="e2ee-close">Done</button></div>`;
  else if (st === 'locked') html += `<p>Your DMs are encrypted. To read them here, unlock with the ${t === 'pin' ? 'PIN' : 'password'} you chose in the Ember app, your recovery code, or approve this browser from another device.</p>
    <label>${t === 'pin' ? 'PIN' : 'Password'}<input id="k-pass" type="password" autocomplete="off" ${t === 'pin' ? 'inputmode="numeric"' : ''}></label>
    <div class="login-actions"><button class="kbtn" data-act="e2ee-pass">Unlock</button></div>
    ${HC.hasRecovery() ? `<label>Recovery code<input id="k-rec" autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX"></label><div class="login-actions"><button class="kbtn alt" data-act="e2ee-rec">Use recovery code</button></div>` : ''}
    <div class="login-actions"><button class="kbtn alt" data-act="e2ee-link">Approve from another device</button><button class="kbtn alt" data-act="e2ee-close">Later</button></div>
    <div id="k-link"></div>`;
  else if (st === 'none') html += `<p>Encrypted DMs are not set up for your account yet. Pick a PIN (6+ digits) or password (10+ characters). It locks a backup of your keys on Nookara, so you can read your DMs on other devices.</p>
    <label>PIN or password<input id="k-new" type="password" autocomplete="new-password"></label><label>Type it again<input id="k-new2" type="password" autocomplete="new-password"></label>
    <div class="login-actions"><button class="kbtn" data-act="e2ee-setup">Set up</button><button class="kbtn alt" data-act="e2ee-close">Later</button></div>`;
  else html += `<p>Still checking your keys with Nookara...</p><div class="login-actions"><button class="kbtn alt" data-act="e2ee-close">Close</button></div>`;
  box.innerHTML = html;
  $('keydlg').hidden = false;
  box.querySelector('input')?.focus();
}
function closeKeys() { linkReq?.cancel(); linkReq = null; $('keydlg').hidden = true; $('input').focus(); }
const E2EE_ERR = { wrong_passcode: 'That PIN or password is wrong.', invalid_auth: 'That did not match.', rate_limited: 'Too many tries. Wait a bit and try again.', locked_out: 'Too many wrong tries. Wait a while, or use your recovery code.', argon2_unreachable: 'Could not load the unlock code. Check your connection.', link_denied: 'The other device said no.', link_expired: 'That request expired. Try again.', link_mismatch: 'Nookara handed back a different key than this browser made, so this was stopped.' };
async function unlockWith(kind) {
  const val = id => ($(id)?.value || '').trim();
  try {
    if (kind === 'pass') { if (!val('k-pass')) return; openKeys('Unlocking... (this takes a few seconds)'); await HC.unlockPasscode($('k-pass')?.value || val('k-pass')); }
    else if (kind === 'rec') { const v = val('k-rec'); if (!v) return; openKeys('Unlocking...'); await HC.unlockRecovery(v); }
    else if (kind === 'setup') {
      const a = $('k-new').value, b2 = $('k-new2').value;
      const type = /^\d+$/.test(a) ? 'pin' : 'password';
      if (a !== b2) { openKeys('Those two did not match.'); return; }
      if (type === 'pin' ? a.length < 6 : a.length < 10) { openKeys('Use a PIN of 6+ digits or a password of 10+ characters.'); return; }
      openKeys('Setting up... (this takes a few seconds)');
      const code = await HC.setup(type, a);
      $('keys-body').innerHTML = `<div class="h">SAVE YOUR RECOVERY CODE</div><p>If you forget your ${type === 'pin' ? 'PIN' : 'password'}, this is the only other way to read your DMs. Write it down somewhere safe. It is shown only once.</p><pre class="code big">${esc(code)}</pre><div class="login-actions"><button class="kbtn" data-act="e2ee-close">I saved it</button></div>`;
      afterUnlock(); return;
    } else if (kind === 'link') {
      linkReq?.cancel();
      linkReq = await HC.startLink('Hammi Chat on ' + (navigator.userAgentData?.platform || navigator.platform || 'a browser'));
      $('k-link').innerHTML = `<p>On a device where your DMs are already unlocked, open the Ember app, go to Settings > Privacy and enter this code:</p><pre class="code big">${esc(linkReq.code)}</pre><p class="fine">Waiting for approval... It expires in 10 minutes.</p>`;
      await linkReq.wait;
    }
    afterUnlock(); openKeys('Unlocked! Your encrypted DMs can be read here now.');
  } catch (e) { openKeys(E2EE_ERR[e.message] || E2EE_ERR[e.data?.error] || 'That did not work: ' + e.message); }
}
function afterUnlock() {
  for (const k of Object.keys(S.msgs)) if (k.startsWith('d|')) S.msgs[k] = null;
  if (S.view.kind === 'dm') loadMessages(S.view);
  loadDMs();
}
$('keydlg').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeKeys();
  if (e.key === 'Enter' && e.target.id === 'k-pass') unlockWith('pass');
  if (e.key === 'Enter' && e.target.id === 'k-rec') unlockWith('rec');
});

// custom emoji: the lists from Nookara and every connected server, for their picture addresses
async function loadEmojis() {
  const lists = await Promise.all([nk('/chat/emojis').catch(() => null), ...[...S.insts.values()].filter(c => c.status === 'open').map(c => api(c, '/emojis').catch(() => null))]);
  for (const d of lists) for (const sv of d?.servers || []) for (const e of sv.emojis || []) if (e.url && !S.emojiUrls[e.eid]) S.emojiUrls[e.eid] = e.url;
}

// ───────────────────────── jump (Ctrl+K) ─────────────────────────
function jumpItems() {
  const items = [];
  for (const c of S.insts.values()) for (const s of c.servers) {
    const d = S.detail[skey(c.origin, s.sid)];
    for (const ch of textChannels(skey(c.origin, s.sid))) items.push({ label: `#${ch.name}`, sub: d?.server?.name || s.name || '', v: { kind: 'channel', origin: c.origin, sid: s.sid, cid: ch.cid } });
  }
  for (const d of S.dms) items.push({ label: `@${d.username}`, sub: 'direct', v: { kind: 'dm', user: d.username } });
  return items;
}
let jumpSel = 0;
function openJump() { $('jump').hidden = false; $('jump-input').value = ''; jumpSel = 0; renderJump(); $('jump-input').focus(); }
function closeJump() { $('jump').hidden = true; $('input').focus(); }
function jumpMatches() {
  const q = $('jump-input').value.trim().toLowerCase().replace(/^[#@]/, '');
  const all = jumpItems();
  if (!q) return all.slice(0, 30);
  return all.filter(x => (x.label + ' ' + x.sub).toLowerCase().includes(q)).slice(0, 30);
}
function renderJump() {
  const list = jumpMatches();
  jumpSel = Math.max(0, Math.min(jumpSel, list.length - 1));
  $('jump-list').innerHTML = list.length ? list.map((x, i) => `<button class="ln ${i === jumpSel ? 'on' : ''}" data-i="${i}">${esc(x.label)} <small>${esc(x.sub)}</small></button>`).join('') : '<div class="empty">nothing found. Type a name and press Enter to DM them.</div>';
}
$('jump-input').addEventListener('input', () => { jumpSel = 0; renderJump(); });
$('jump-input').addEventListener('keydown', e => {
  const list = jumpMatches();
  if (e.key === 'ArrowDown') { jumpSel++; renderJump(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { jumpSel--; renderJump(); e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); const x = list[jumpSel]; const q = $('jump-input').value.trim(); closeJump(); if (x) go(x.v); else if (q) go({ kind: 'dm', user: q.replace(/^@/, '') }); }
  else if (e.key === 'Escape') closeJump();
});
$('jump-list').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; const x = jumpMatches()[+b.dataset.i]; closeJump(); if (x) go(x.v); });
$('jump').addEventListener('click', e => { if (e.target === $('jump')) closeJump(); });

// ───────────────────────── input + clicks ─────────────────────────
const input = $('input');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; }
input.addEventListener('input', () => { autosize(); if (input.value && !input.value.startsWith('/')) sendTyping(); });
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('prompt').requestSubmit(); }
  else if (e.key === 'Escape') { if (S.editing) { S.editing = null; input.value = ''; setPromptLabel(); } setReply(null); }
  else if (e.key === 'ArrowUp' && !input.value) {
    const vk = vkeyOf(S.view), id = S.lastSent[vk];
    const m = id ? findMsg(id) : null;
    if (m && !m.pending) { e.preventDefault(); S.editing = { id: m.id, vkey: vk }; input.value = m.body || ''; setPromptLabel(); autosize(); }
  }
});
$('prompt').addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value.replace(/\s+$/, '');
  if (!text) return;
  input.value = ''; autosize();
  if (text.startsWith('/') && !text.startsWith('//')) { command(text); return; }
  if (S.view.kind === 'home') { sys('pick a channel or DM first (Ctrl+K)', 'err'); return; }
  if (text.length > 4000) { sys('messages can be at most 4000 characters', 'err'); input.value = text; return; }
  send(text.startsWith('//') ? text.slice(1) : text);
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  if (a === 'channel') go({ kind: 'channel', origin: b.dataset.o, sid: b.dataset.s, cid: b.dataset.c });
  else if (a === 'server') {
    const k = skey(b.dataset.o, b.dataset.s);
    const last = store.get('hammichat_lastch:' + k);
    const ch = textChannels(k).find(x => x.cid === last) || textChannels(k)[0];
    if (ch) go({ kind: 'channel', origin: b.dataset.o, sid: b.dataset.s, cid: ch.cid });
  }
  else if (a === 'dm' && b.dataset.u && b.dataset.u !== S.me) go({ kind: 'dm', user: b.dataset.u });
  else if (a === 'add') { const v = prompt('Ember server address (for example e-myserver.nookara.cc):'); const o = normOrigin(v); if (o) addServer(o); }
  else if (a === 'newdm') { const v = prompt('Nookara username to message:'); if (v) go({ kind: 'dm', user: v.trim().replace(/^@/, '') }); }
  else if (a === 'older') loadMessages(S.view, true);
  else if (a === 'noreply') setReply(null);
  else if (a === 'reply') { const m = findMsg(b.dataset.id); if (m) setReply({ id: m.id, who: m.author?.username || '?', text: m.body || '' }); }
  else if (a === 'edit') { const m = findMsg(b.dataset.id); if (m) { S.editing = { id: m.id, vkey: vkeyOf(S.view) }; input.value = m.body || ''; setPromptLabel(); autosize(); input.focus(); } }
  else if (a === 'del') deleteMsg(b.dataset.id);
  else if (a === 'efile') {
    b.disabled = true; b.textContent += ' (opening...)';
    HC.openFile(b.dataset.link).then(url => {
      if (b.dataset.img) { const img = document.createElement('img'); img.src = url; img.alt = ''; b.replaceWith(Object.assign(document.createElement('a'), { href: url, target: '_blank', className: 'att' }), img); img.previousSibling.textContent = 'open full size'; }
      else { window.open(url, '_blank'); b.textContent = b.textContent.replace(' (opening...)', ''); b.disabled = false; }
    }, e => { b.textContent = b.textContent.replace(' (opening...)', ` (${e.message === 'gone' ? 'deleted' : 'could not open'})`); });
  }
  else if (a === 'e2ee-pass') unlockWith('pass');
  else if (a === 'e2ee-rec') unlockWith('rec');
  else if (a === 'e2ee-link') unlockWith('link');
  else if (a === 'e2ee-setup') unlockWith('setup');
  else if (a === 'e2ee-close') closeKeys();
  else if (a === 'react') { const em = prompt('React with which emoji?', '👍'); if (em) react(b.dataset.id, em.trim()); }
});
// remember the last channel per server
addEventListener('beforeunload', () => { const v = S.view; if (v.kind === 'channel') store.set('hammichat_lastch:' + skey(v.origin, v.sid), v.cid); });

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('jump').hidden ? openJump() : closeJump(); }
  else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const list = jumpItems().map(x => x.v);
    const i = list.findIndex(v => vkeyOf(v) === vkeyOf(S.view));
    const next = list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
    if (next) go(next);
  }
});
$('log').addEventListener('scroll', () => { if ($('log').scrollTop < 40 && S.msgs[vkeyOf(S.view)]?.hasMore) loadMessages(S.view, true); });

// phone drawers
function closeDrawers() { $('left').classList.remove('open'); $('right').classList.remove('open'); }
$('btn-left').addEventListener('click', () => { $('right').classList.remove('open'); $('left').classList.toggle('open'); });
$('btn-right').addEventListener('click', () => { $('left').classList.remove('open'); $('right').classList.toggle('open'); });
$('st-me').addEventListener('click', () => { if (!S.me) { showLogin(); return; } if (confirm(`Signed in as ${S.me}. Sign out?`)) signOut(); });
$('log').addEventListener('click', closeDrawers);
$('signin').addEventListener('click', signIn);
$('demo').addEventListener('click', () => { location.search = '?demo'; });

// notifications for mentions and DMs while the tab is in the background
function notify(title, body) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body: String(body || '').slice(0, 140), tag: 'hammi-chat' }); } catch { /* fine */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const v = S.view; S.unread[vkeyOf(v)] = false; renderLeft();
  for (const c of S.insts.values()) if (!c.ws && c.status !== 'banned') { c.retry = 0; connect(c); }
  if (S.token && !S.home.ws) openHome();
});
addEventListener('online', () => { for (const c of S.insts.values()) if (!c.ws) { c.retry = 0; connect(c); } openHome(); });

// ───────────────────────── start ─────────────────────────
async function start() {
  $('login').hidden = true;
  try {
    const d = await nk('/bonfire/session');
    S.session = d;
    S.me = d.username || d.user?.username || d.account?.username || S.me;
  } catch (e) {
    if (!S.token) return;
    // the token is only treated as dead when Nookara rejects it everywhere, not when one route says no
    if (e.status === 401) {
      const a = await nk('/account/me').catch(x => x);
      if (a instanceof Error && a.status === 401) { signedOut(`Your Nookara sign-in ended (${e.message}). Sign in again.`); return; }
      if (!(a instanceof Error)) S.me = a.username || a.account?.username || a.user?.username || S.me;
    }
    // Nookara is down for maintenance (or unreachable): say it once and try the whole start again in a bit
    if (e.message === 'maintenance' || e.status === 503 || e.status === 0) {
      if (!S.waitingNookara) sys(e.message === 'maintenance' ? 'Nookara is down for maintenance right now. Hammi Chat will connect by itself when it is back.' : 'Nookara is not answering. Hammi Chat will keep trying.', 'err');
      S.waitingNookara = true; render();
      setTimeout(start, 30000);
      return;
    }
    sys('Nookara did not answer the session check (' + e.message + '). Some things may not work.', 'err');
  }
  if (S.waitingNookara) { S.waitingNookara = false; sys('Nookara is back. Connecting...'); }
  if (S.started) return; // (a retry after maintenance: the rest already ran... only once)
  S.started = true;
  if (!S.me) { const a = await nk('/account/me').catch(() => null); S.me = a?.username || a?.account?.username || a?.user?.username || S.me; }
  store.set(LS.user, S.me);
  HC.use(nk);
  HC.onChange(st => { renderStatus(); if (st === 'locked' || st === 'none') { if (S.view.kind === 'dm') e2eeHint(); } });
  HC.init().then(st => { if (st === 'ready') afterUnlock(); });
  HC.setupSigning(S.session).then(st => { if (st === 'no_scope' && S.session) sys('Message signing is off: sign out and back in to give Hammi Chat the new "Sign Messages" permission.'); else if (st === 'unsupported') sys('This browser cannot sign messages (no Ed25519). Messages go out unsigned.'); });
  render();
  openHome();
  loadDMs();
  const d = await nk('/bonfire/instances').catch(e => { sys('could not load your server list: ' + e.message, 'err'); return null; });
  const urls = (d?.instances || []).map(x => normOrigin(typeof x === 'string' ? x : x.url)).filter(Boolean);
  for (const o of urls) addInstance(o);
  render();
  if (!urls.length) sys('You are not in any Ember servers yet. Use /add <address> or /join <invite link>.');
  if ('Notification' in window && Notification.permission === 'default') sys('Tip: allow notifications to hear about mentions and DMs while this tab is in the background. Type /notify.');
}

// ───────────────────────── demo mode (no account needed) ─────────────────────────
const DEMO_ORIGIN = 'https://demo.hammichat.invalid';
const demoNames = ['nova', 'pixelfox', 'mothwing', 'starbyte', 'quietcomet', 'lumen'];
function demoData() {
  const t0 = Date.now() - 14 * 60000;
  const mk = (i, who, body, extra = {}) => ({ id: 'd' + i, channel: 'general', created_at: t0 + i * 120000, author: { id: who, username: who }, body, ...extra });
  return {
    servers: [{ sid: 'hc', name: 'hammi.ca hangout' }, { sid: 'px', name: 'Pixel Wall' }, { sid: 'ls', name: 'Loopsprout jams' }],
    channels: {
      hc: [{ cid: 'general', name: 'general' }, { cid: 'whats-new', name: 'whats-new', unread: true }, { cid: 'game-ideas', name: 'game-ideas' }, { cid: 'art', name: 'art-and-sprites', unread: true }, { cid: 'bugs', name: 'bug-reports' }, { cid: 'lounge', name: 'Lounge', type: 'voice', category: 'Voice' }],
      px: [{ cid: 'px-general', name: 'general' }, { cid: 'px-art', name: 'pixel-art' }],
      ls: [{ cid: 'ls-general', name: 'general' }, { cid: 'ls-share', name: 'share-your-loops', unread: true }],
    },
    messages: [
      { id: 'd0', channel: 'general', created_at: t0 - 60000, system: true, body: 'pixelfox joined the server' },
      mk(1, 'nova', 'ok Orbit Climb split-screen is so good, me and my brother played for an hour'),
      mk(2, 'nova', 'the floating rings level is mean though'),
      mk(3, 'Dipish', 'haha yeah that one is on purpose. there is a shortcut on the left side', { reply: { author: { username: 'nova' }, body: 'the floating rings level is mean though' } }),
      mk(4, 'pixelfox', 'made new sprites for Loose Thread, tell me what you think', { attachments: [{ url: 'https://hammi.ca/img/', name: 'sprites.png', size: 43008 }], reactions: [{ emoji: '✨', count: 4 }, { emoji: '🧵', count: 2, me: true }] }),
      mk(5, 'mothwing', 'the moth one is my favourite obviously'),
      mk(6, 'Dipish', 'these are great, I will put them in tonight. also working on a new chat client for this server :)', { reactions: [{ emoji: '👀', count: 3 }] }),
      mk(7, 'starbyte', '@Dipish is it the terminal one? try `/help` in it'),
    ],
  };
}
function demoApi(c, path) {
  const D = demoData();
  if (path === '/servers') return { servers: D.servers };
  let m = /^\/servers\/([^/]+)$/.exec(path);
  if (m) return { server: D.servers.find(s => s.sid === m[1]), categories: ['Voice'], channels: D.channels[m[1]] || [] };
  m = /^\/servers\/([^/]+)\/members$/.exec(path);
  if (m) return { members: [{ username: 'Dipish', owner: true, online: true }, { username: 'nova', moderator: true, online: true }, { username: 'pixelfox', online: true }, { username: 'starbyte', online: true }, { username: 'helperbot', bot: true, online: true }, { username: 'mothwing', online: false }, { username: 'quietcomet', online: false }, { username: 'lumen', online: false }] };
  m = /^\/channels\/([^/?]+)\/messages/.exec(path);
  if (m) return { messages: m[1] === 'general' ? D.messages : [{ id: 'x' + m[1], channel: m[1], created_at: Date.now() - 3600000, author: { username: 'nova' }, body: 'this is a demo channel. sign in with Nookara to see real servers.' }], has_more: false };
  return {};
}
function demoDm(user) {
  const t = Date.now() - 30 * 60000;
  return { messages: [
    { id: 1, from: user, to: 'Dipish', body: `hey! it's ${user}. this is a demo DM`, sent_at: t },
    { id: 2, from: 'Dipish', to: user, body: 'nice, the terminal look is fun', sent_at: t + 60000 },
    { id: 3, from: user, to: 'Dipish', enc: true, sent_at: t + 120000 },
  ] };
}
function startDemo() {
  S.demo = true; S.me = 'Dipish';
  const c = { origin: DEMO_ORIGIN, info: { name: 'demo' }, session: 'demo', user: { id: 'Dipish', username: 'Dipish' }, ws: null, status: 'open', servers: [], retry: 0, acks: new Map() };
  S.insts.set(DEMO_ORIGIN, c);
  S.dms = [{ username: 'nova', online: true }, { username: 'pixelfox', online: true, unread: 1 }, { username: 'mothwing' }];
  S.unread['d|pixelfox'] = true;
  loadServers(c).then(() => {
    go({ kind: 'channel', origin: DEMO_ORIGIN, sid: 'hc', cid: 'general' }, { save: false });
    setTimeout(() => setTyping(`c|${DEMO_ORIGIN}|general`, 'nova', true), 600);
    sys('Demo mode: nothing you type leaves this page. Sign in with Nookara for the real thing.');
  });
}

// /notify asks for notification permission (it has to come from a key press or click)
const _command = command;
command = async raw => { if (/^\/notify\b/i.test(raw)) { if ('Notification' in window) { const p = await Notification.requestPermission(); sys('notifications: ' + p); } return; } return _command(raw); };

render();
if (/[?&]demo\b/.test(location.search)) startDemo();
else if (S.token) start();
else showLogin();
})();
