/* Hammi Chat: end-to-end encrypted Nookara DMs (the "nke1" format) and Ember message signatures.
 * Written for Hammi Chat. It speaks the same formats as other Ember / Nookara apps so both sides can read each other:
 *   nke1 DM      P-256 account keys (ECDH + ECDSA). Each message has its own 32-byte key K: AES-256-GCM over a JSON
 *                payload with "nke1|from|to" as additional data, K sealed to every reader key (ephemeral ECDH + HKDF + AES-GCM),
 *                a commit HMAC(K, "nke1 commit") and an ECDSA signature over "nke1 sig|from|to|edit_of|iv|ct|commit".
 *   unlocking    the account keys live on Nookara only as locked backups: a passcode (Argon2id) or a recovery code (HKDF),
 *                or another of your devices hands them over (link code).
 *   signing      Ember messages are signed with the account's Ed25519 key: "bonfire-msg-v1\n" + canonical JSON.
 * Exposes window.HammiCrypto. Needs a nk(path, opts) function for Nookara requests (set with HammiCrypto.use). */
(() => {
'use strict';
const subtle = crypto.subtle;
const te = new TextEncoder(), td = new TextDecoder();
let nk = null;

// ───────── bytes ─────────
const b64 = bytes => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const sha = async b => new Uint8Array(await subtle.digest('SHA-256', b));
const P256 = { ECDH: { name: 'ECDH', namedCurve: 'P-256' }, ECDSA: { name: 'ECDSA', namedCurve: 'P-256' } };
const SIGALG = { name: 'ECDSA', hash: 'SHA-256' };
const kidOf = async encPub => b64(await sha(unb64(encPub))).slice(0, 22);
const fingerprint = async (encPub, sigPub) => b64(await sha(new Uint8Array([...unb64(encPub), ...unb64(sigPub)])));

// ───────── sealing a secret to a public key ─────────
async function wrapKey(priv, pub, ephRaw, kid) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const base = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: ephRaw, info: te.encode(`nke1 wrap|${kid}`) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(secret, encPub, kid) {
  const eph = await subtle.generateKey(P256.ECDH, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const pub = await subtle.importKey('raw', unb64(encPub), P256.ECDH, false, []);
  const key = await wrapKey(eph.privateKey, pub, ephRaw, kid);
  const iv = rnd(12);
  return { e: b64(ephRaw), i: b64(iv), w: b64(await subtle.encrypt({ name: 'AES-GCM', iv }, key, secret)) };
}
async function unseal(w, encPriv, kid) {
  const ephRaw = unb64(w.e);
  const key = await wrapKey(encPriv, await subtle.importKey('raw', ephRaw, P256.ECDH, false, []), ephRaw, kid);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.i) }, key, unb64(w.w)));
}
async function commitOf(k) {
  const h = await subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await subtle.sign('HMAC', h, te.encode('nke1 commit')));
}
const aad = (from, to) => te.encode(`nke1|${from}|${to}`);
const sigText = (from, to, editOf, iv, ct, commit) => te.encode(`nke1 sig|${from}|${to}|${editOf || 0}|${iv}|${ct}|${commit}`);

// ───────── locked backups ─────────
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const cleanCode = s => String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
const newRecoveryCode = () => Array.from(rnd(26), x => CROCKFORD[x & 31]).join('').replace(/(.{4})(?=.)/g, '$1-');
async function splitSecret(bytes) { // 64 bytes -> AES key for the blob + what Nookara is shown to hand the blob over
  return { wrap: await subtle.importKey('raw', bytes.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']), auth: b64(bytes.slice(32, 64)) };
}
async function stretchRecovery(code, salt) {
  const base = await subtle.importKey('raw', te.encode(cleanCode(code)), 'HKDF', false, ['deriveBits']);
  return splitSecret(new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: unb64(salt), info: te.encode('nke1 recovery') }, base, 512)));
}
const ARGON = { m: 65536, t: 3, p: 1 };
let argonLoading = null;
function loadArgon() {
  return (argonLoading ||= new Promise((ok, no) => {
    if (window.hashwasm?.argon2id) { ok(window.hashwasm); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/dist/argon2.umd.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = () => (window.hashwasm?.argon2id ? ok(window.hashwasm) : no(new Error('argon2_missing')));
    s.onerror = () => { argonLoading = null; no(new Error('argon2_unreachable')); };
    document.head.appendChild(s);
  }));
}
async function stretchPasscode(pass, salt, params = ARGON) {
  const { argon2id } = await loadArgon();
  const out = await argon2id({ password: pass, salt: unb64(salt), parallelism: params.p, iterations: params.t, memorySize: params.m, hashLength: 64, outputType: 'binary' });
  return splitSecret(out);
}
async function lockBlob(obj, wrap) {
  const iv = rnd(12);
  return { iv: b64(iv), ct: b64(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode('nke1 backup') }, wrap, te.encode(JSON.stringify(obj)))) };
}
async function openBlob(blob, wrap) {
  return JSON.parse(td.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv), additionalData: te.encode('nke1 backup') }, wrap, unb64(blob.ct))));
}
const linkCodeOf = async encPub => { const h = await sha(unb64(encPub)); const c = Array.from(h.slice(0, 10), x => CROCKFORD[x & 31]).join(''); return `${c.slice(0, 5)}-${c.slice(5)}`; };
const clientsText = (uid, kid, doc) => `nke1 clients|${uid}|${kid}|${doc.seq}|${(doc.list || []).map(c => [c.kid, c.enc_pub, c.sig_pub, encodeURIComponent(c.label || ''), c.app || '', c.added_at || 0, c.revoked_at || 0].join(',')).join(';')}`;
async function verifyClients(uid, kid, doc, sig, sigPub) {
  try { return await subtle.verify(SIGALG, await subtle.importKey('raw', unb64(sigPub), P256.ECDSA, false, ['verify']), unb64(sig), te.encode(clientsText(uid, kid, doc))); } catch { return false; }
}

// ───────── this device's copy of the keys (IndexedDB, private keys non-extractable) ─────────
const DBNAME = 'hammi-chat-keys';
let dbp = null;
const db = () => (dbp ||= new Promise((ok, no) => {
  const r = indexedDB.open(DBNAME, 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('keys', { keyPath: 'uid' }); r.result.createObjectStore('pins', { keyPath: 'id' }); };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => { dbp = null; no(r.error); };
}));
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((ok, no) => { const t = d.transaction(store, mode); const q = fn(t.objectStore(store)); t.oncomplete = () => ok(q?.result); t.onerror = t.onabort = () => no(t.error); });
}

// ───────── state ─────────
let me = null;     // { id, username }
let info = null;   // GET /im/keys/me
let keys = null;   // { uid, kid, enc_pub, sig_pub, encPriv, sigPriv, deviceKey, sealed }
const subs = new Set();
const status = () => (!info ? 'loading' : keys ? 'ready' : info.has ? 'locked' : 'none');
const changed = () => subs.forEach(f => { try { f(status()); } catch { /* fine */ } });

async function init() {
  info = await nk('/im/keys/me').catch(() => null);
  if (!info) { changed(); return status(); }
  me = { id: String(info.user_id), username: info.username };
  const local = await idb('keys', 'readonly', s => s.get(me.id)).catch(() => null);
  keys = local && info.has && local.kid === info.kid ? local : null;
  changed();
  return status();
}
async function holdKeys(secret) {
  const deviceKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keys = {
    uid: me.id, kid: secret.kid, enc_pub: secret.enc_pub, sig_pub: secret.sig_pub,
    encPriv: await subtle.importKey('jwk', secret.enc_priv, P256.ECDH, false, ['deriveBits']),
    sigPriv: await subtle.importKey('jwk', secret.sig_priv, P256.ECDSA, false, ['sign']),
    deviceKey, sealed: await lockBlob(secret, deviceKey),
  };
  await idb('keys', 'readwrite', s => s.put(keys)).catch(() => {});
  info = await nk('/im/keys/me').catch(() => info);
  bundles.clear();
  changed();
}
async function forget() { if (me) await idb('keys', 'readwrite', s => s.delete(me.id)).catch(() => {}); keys = null; changed(); }

// first time: new account keys, locked with a passcode and a recovery code -> the recovery code (shown once)
async function setup(type, passcode, { replace = false } = {}) {
  const [enc, sig] = await Promise.all([subtle.generateKey(P256.ECDH, true, ['deriveBits']), subtle.generateKey(P256.ECDSA, true, ['sign', 'verify'])]);
  const enc_pub = b64(await subtle.exportKey('raw', enc.publicKey)), sig_pub = b64(await subtle.exportKey('raw', sig.publicKey));
  const secret = { enc_pub, sig_pub, kid: await kidOf(enc_pub), enc_priv: await subtle.exportKey('jwk', enc.privateKey), sig_priv: await subtle.exportKey('jwk', sig.privateKey) };
  const recovery = newRecoveryCode();
  const pSalt = b64(rnd(16)), rSalt = b64(rnd(16));
  const p = await stretchPasscode(passcode, pSalt), r = await stretchRecovery(recovery, rSalt);
  await nk('/im/keys', { method: 'POST', body: JSON.stringify({
    enc_pub, sig_pub, replace,
    passcode: { type, salt: pSalt, params: ARGON, ...(await lockBlob(secret, p.wrap)), auth: p.auth },
    recovery: { salt: rSalt, ...(await lockBlob(secret, r.wrap)), auth: r.auth },
  }) });
  await holdKeys(secret);
  return recovery;
}
async function unlockPasscode(pass) {
  const p = info?.passcode;
  if (!p) throw new Error('no_passcode_backup');
  const s = await stretchPasscode(pass, p.salt, p.params || ARGON);
  try { await holdKeys(await openBlob(await nk('/im/keys/unlock', { method: 'POST', body: JSON.stringify({ kind: 'passcode', auth: s.auth }) }), s.wrap)); }
  catch (e) { info = await nk('/im/keys/me').catch(() => info); throw e; }
}
async function unlockRecovery(code) {
  const r = info?.recovery;
  if (!r) throw new Error('no_recovery_backup');
  const s = await stretchRecovery(code, r.salt);
  await holdKeys(await openBlob(await nk('/im/keys/unlock', { method: 'POST', body: JSON.stringify({ kind: 'recovery', auth: s.auth }) }), s.wrap));
}
// ask another of your devices: -> { code, wait (promise: true once approved), cancel }
async function startLink(label) {
  const k = await subtle.generateKey(P256.ECDH, true, ['deriveBits']);
  const enc_pub = b64(await subtle.exportKey('raw', k.publicKey)), kid = await kidOf(enc_pub);
  const r = await nk('/im/keys/link', { method: 'POST', body: JSON.stringify({ enc_pub, label }) });
  const code = await linkCodeOf(enc_pub);
  if (r.code && r.code.replace('-', '') !== code.replace('-', '')) throw new Error('link_mismatch'); // Nookara swapped the key: refuse
  let stop = false;
  const wait = (async () => {
    while (!stop) {
      await new Promise(ok => setTimeout(ok, 2500));
      if (stop) return false;
      const s = await nk(`/im/keys/link/${encodeURIComponent(code)}`).catch(e => { if (e.message === 'link_not_found') throw new Error('link_expired'); return null; });
      if (s?.state === 'denied') throw new Error('link_denied');
      if (s?.state === 'approved' && s.sealed) { await holdKeys(JSON.parse(td.decode(await unseal(s.sealed, k.privateKey, kid)))); return true; }
    }
    return false;
  })();
  return { code, wait, cancel: () => { stop = true; } };
}

// ───────── other people's keys ─────────
const bundles = new Map(); // username lower -> { at, b } | { at, none } | { at, err }
const inflight = new Map();
function bundleFor(username, fresh = false) {
  const k = String(username).toLowerCase(), hit = bundles.get(k);
  const ttl = hit?.b ? 3600e3 : hit?.none ? 300e3 : 60e3;
  if (hit && Date.now() - hit.at < (fresh ? 3000 : ttl)) return hit.err ? Promise.reject(hit.err) : Promise.resolve(hit);
  if (!inflight.has(k)) inflight.set(k, fetchBundle(username, k).finally(() => inflight.delete(k)));
  return inflight.get(k);
}
async function fetchBundle(username, k) {
  let b;
  try { b = await nk(`/im/keys/user/${encodeURIComponent(username)}`); }
  catch (e) { if (e.message === 'no_keys' || e.status === 404 && e.data?.error === 'no_keys') { const v = { at: Date.now(), none: true }; bundles.set(k, v); return v; } bundles.set(k, { at: Date.now(), err: e }); throw e; }
  const doc = b.clients || { seq: 0, list: [] };
  if (doc.list?.length && !(await verifyClients(b.user_id, b.kid, doc, b.clients_sig, b.sig_pub))) { const e = new Error('bad_key_list'); bundles.set(k, { at: Date.now(), err: e }); throw e; }
  const fp = await fingerprint(b.enc_pub, b.sig_pub);
  let changedKey = false;
  if (me && String(b.user_id) !== me.id) {
    const id = `${me.id}:${b.user_id}`;
    const pin = await idb('pins', 'readonly', s => s.get(id)).catch(() => null);
    if (pin && pin.fp === fp && pin.seq > Number(doc.seq || 0)) { const e = new Error('bad_key_list'); bundles.set(k, { at: Date.now(), err: e }); throw e; } // an older list than one already seen
    changedKey = !!pin && pin.fp !== fp;
    await idb('pins', 'readwrite', s => s.put({ id, fp, seq: Number(doc.seq || 0) })).catch(() => {});
  }
  const v = { at: Date.now(), b: { ...b, fp }, changedKey };
  bundles.set(k, v);
  return v;
}
const forgetBundle = u => { bundles.delete(String(u).toLowerCase()); };
const readers = b => [{ kid: b.kid, enc_pub: b.enc_pub }, ...(b.clients?.list || []).filter(c => !c.revoked_at).map(c => ({ kid: c.kid, enc_pub: c.enc_pub }))];

// ───────── sealing and opening DMs ─────────
async function encryptFor(fromId, toId, recipients, payload, editOf = 0) {
  const k = rnd(32), iv = rnd(12);
  const key = await subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']);
  const ct = b64(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(fromId, toId) }, key, te.encode(JSON.stringify({ ...payload, n: b64(rnd(8)) }))));
  const ivS = b64(iv), commit = await commitOf(k);
  const wraps = {};
  for (const r of recipients) wraps[r.kid] = await seal(k, r.enc_pub, r.kid);
  const sig = b64(await subtle.sign(SIGALG, keys.sigPriv, sigText(fromId, toId, editOf, ivS, ct, commit)));
  return { v: 1, ct, iv: ivS, commit, sig, signer: keys.kid, wraps };
}
// -> enc, or throws no_keys (they haven't set up encrypted DMs) / e2ee_locked
async function sealDm(username, text, quote = null) {
  if (!keys) throw new Error('e2ee_locked');
  const to = await bundleFor(username, true);
  if (to.none) throw new Error('no_keys');
  const mine = await bundleFor(me.username, true);
  if (mine.none) throw new Error('e2ee_locked');
  return encryptFor(me.id, String(to.b.user_id), [...readers(to.b), ...readers(mine.b)], { t: text, ...(quote ? { r: quote } : {}) });
}
async function sealEdit(m, peer, text) {
  if (!keys) throw new Error('e2ee_locked');
  const p = await bundleFor(peer, true);
  if (p.none) throw new Error('no_keys');
  const mine = await bundleFor(me.username, true);
  return encryptFor(String(m.from_id), String(m.to_id), [...readers(p.b), ...readers(mine.b)], { t: text, ...(m.quote ? { r: m.quote } : {}) }, m.id);
}
const LINK = /^https?:\/\/\S+#nke=\S+$/;
const openedCache = new Map();
// a raw /im message -> { state: 'plain' | 'open' | 'locked' | 'failed', text, files, quote, signature }
async function openDm(m) {
  if (!m?.enc) return { state: 'plain' };
  if (!keys) return { state: 'locked' };
  const ck = `${m.id}:${String(m.enc.ct).slice(0, 44)}`;
  if (openedCache.has(ck)) return openedCache.get(ck);
  let out;
  try {
    const w = m.enc.wraps?.[keys.kid];
    const k = w ? await unseal(w, keys.encPriv, keys.kid).catch(() => null) : null;
    if (!k || (await commitOf(k)) !== m.enc.commit) out = { state: 'failed' };
    else {
      const key = await subtle.importKey('raw', k, 'AES-GCM', false, ['decrypt']);
      const p = JSON.parse(td.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.enc.iv), additionalData: aad(m.from_id, m.to_id) }, key, unb64(m.enc.ct))));
      const lines = String(p.t ?? '').split('\n');
      out = {
        state: 'open', text: lines.filter(l => !LINK.test(l.trim())).join('\n').trimEnd(), files: lines.filter(l => LINK.test(l.trim())).map(l => l.trim()),
        quote: p.r || null, signature: m.enc.converted ? 'none' : await dmSignature(m),
      };
    }
  } catch { out = { state: 'failed' }; }
  if (out.state === 'open') { openedCache.set(ck, out); if (openedCache.size > 4000) openedCache.delete(openedCache.keys().next().value); }
  return out;
}
async function dmSignature(m) {
  const e = m.enc;
  if (!e.sig) return 'none';
  const sender = String(m.from_id) === me.id ? me.username : m.from;
  const check = async v => {
    const b = v?.b; if (!b) return 'unknown';
    const pub = b.kid === e.signer ? b.sig_pub : (b.clients?.list || []).find(c => c.kid === e.signer)?.sig_pub || (b.past || []).find(p => p.kid === e.signer)?.sig_pub;
    if (!pub) return 'unknown';
    try { return (await subtle.verify(SIGALG, await subtle.importKey('raw', unb64(pub), P256.ECDSA, false, ['verify']), unb64(e.sig), sigText(m.from_id, m.to_id, m.edited_at ? m.id : 0, e.iv, e.ct, e.commit))) ? 'valid' : 'invalid'; } catch { return 'invalid'; }
  };
  let r = await check(await bundleFor(sender).catch(() => null));
  if (r !== 'valid') r = await check(await bundleFor(sender, true).catch(() => null)); // they may have linked something since
  return r;
}
// a file -> its encrypted copy to upload, plus the key that travels inside the encrypted message (same format as the reference client)
async function sealFile(file) {
  const k = rnd(32), iv = rnd(12);
  const key = await subtle.importKey('raw', k, 'AES-GCM', false, ['encrypt']);
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode('nke1 file') }, key, await file.arrayBuffer()));
  return { upload: new File([data], 'file.bin', { type: 'application/octet-stream' }), key: b64(k), iv: b64(iv) };
}
const encPart = s => encodeURIComponent(s).replace(/[!'()*.]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const fileLink = (url, { key, iv, name, mime }) => `${url.split('#')[0]}#nke=${key}.${iv}.${encPart(name || 'file')}.${encPart(mime || 'application/octet-stream')}`;
// an encrypted file link -> object URL of the opened file
const fileCache = new Map();
function parseFileLink(link) {
  const m = /^(https?:\/\/[^\s#]+)#nke=([\w-]+)\.([\w-]+)\.([^.\s]*)\.([^.\s]*)$/.exec(String(link || ''));
  if (!m) return null;
  try { return { url: m[1], key: m[2], iv: m[3], name: decodeURIComponent(m[4]), mime: decodeURIComponent(m[5]) }; } catch { return null; }
}
function openFile(link) {
  if (fileCache.has(link)) return fileCache.get(link);
  const f = parseFileLink(link);
  if (!f) return Promise.reject(new Error('bad_link'));
  const p = (async () => {
    const r = await fetch(f.url, { credentials: 'omit' });
    if (!r.ok) throw new Error(r.status === 404 || r.status === 410 ? 'gone' : 'fetch_failed');
    const key = await subtle.importKey('raw', unb64(f.key), 'AES-GCM', false, ['decrypt']);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv), additionalData: te.encode('nke1 file') }, key, await r.arrayBuffer());
    return URL.createObjectURL(new Blob([plain], { type: f.mime || 'application/octet-stream' }));
  })();
  fileCache.set(link, p);
  p.catch(() => fileCache.delete(link));
  return p;
}

// ───────── Ember message signatures (Ed25519) ─────────
const SIGN_BIT = 32768;
let signer = null; // { kid, priv, at }
let signState = 'off';
const canonical = v => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(Math.trunc(v));
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
};
const payloadOf = f => ({
  v: 1, iss: f.iss, instance: f.instance, community: String(f.community), channel: String(f.channel), author: String(f.author), ts: Number(f.ts), nonce: String(f.nonce), body: String(f.body),
  attachments: (f.attachments || []).map(String), reply_to: f.reply_to == null ? null : String(f.reply_to), edit_of: f.edit_of == null ? null : String(f.edit_of),
  ...(f.sticker == null || f.sticker === '' ? {} : { sticker: String(f.sticker) }),
});
const signedBytes = p => te.encode(`bonfire-msg-v1\n${canonical(p)}`);
const issuerFor = inf => { const l = inf?.velora?.signing_issuers; if (Array.isArray(l) && l.length) return String(l[0]); try { return new URL(inf?.velora?.issuer).origin; } catch { return 'https://velora.ikelene.net'; } };
let skew = 0;
const noteClock = date => { const at = Date.parse(date || ''); if (!Number.isNaN(at)) { const off = at - Date.now(); skew = Math.abs(off) > 30000 ? off : 0; } };
async function ed25519Ok() { try { await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']); return true; } catch { return false; } }
async function fetchSigner() {
  const d = await nk('/bonfire/signing-key');
  if (!d?.kid || !d.private_key) throw new Error('invalid_key');
  signer = { kid: d.kid, priv: await subtle.importKey('pkcs8', unb64(d.private_key), { name: 'Ed25519' }, false, ['sign']), at: Date.now() };
}
async function setupSigning(session) {
  signer = null;
  if (((Number(session?.effective ?? session?.scopes) || 0) & SIGN_BIT) !== SIGN_BIT) { signState = 'no_scope'; return signState; }
  if (!(await ed25519Ok())) { signState = 'unsupported'; return signState; }
  try { await fetchSigner(); signState = 'ready'; } catch (e) { signState = 'error'; }
  return signState;
}
// fields: { instance, community, channel, author, body, attachments, reply_to, edit_of }, info = the server's /.well-known/bonfire
async function signMessage(fields, inf) {
  if (!signer) throw new Error('no_key');
  if (Date.now() - signer.at > 30000) await fetchSigner().catch(() => {});
  const go = async () => {
    const ts = Date.now() + skew, nonce = b64(rnd(16));
    const sig = await subtle.sign({ name: 'Ed25519' }, signer.priv, signedBytes(payloadOf({ iss: issuerFor(inf), ...fields, ts, nonce })));
    return { kid: signer.kid, sig: b64(sig), ts, nonce };
  };
  try { return await go(); } catch { await fetchSigner(); return go(); }
}
const pubKeys = new Map(); // kid -> promise of { key info } | null
function keyInfo(kid) {
  const hit = pubKeys.get(kid);
  if (hit && Date.now() - hit.at < 600e3) return hit.p;
  const p = fetch(`https://nookara.cc/bonfire/keys/kid/${encodeURIComponent(kid)}`).then(r => (r.status === 404 ? null : r.ok ? r.json() : Promise.reject(new Error('key_lookup'))));
  pubKeys.set(kid, { at: Date.now(), p });
  p.catch(() => pubKeys.delete(kid));
  return p;
}
const attRefs = atts => (atts || []).map(a => {
  if (/^[0-9a-f]{64}$/.test(String(a.sha256 || ''))) return a.sha256;
  if (/^https:\/\/([a-z0-9-]+\.)*klipy\.com\//i.test(a.url || '')) return `url:${String(a.url).slice(0, 512)}`;
  throw new Error('missing_attachment_hash');
});
const verdicts = new Map();
// a received Ember message (m.origin = the server it came from) -> 'ok' | 'bad' | null (unsigned / can't tell)
function checkMessage(m, inf, previousUrls = []) {
  const sig = m?.signature;
  if (!sig || !m.author) return Promise.resolve(null);
  const id = `${m.origin}|${m.id}|${sig.sig}`;
  if (!verdicts.has(id)) verdicts.set(id, (async () => {
    try {
      const k = await keyInfo(sig.kid);
      if (!k || !m.author.velora_id || String(k.user_id) !== String(m.author.velora_id)) return 'bad';
      if (k.revoked_at != null && Number(k.revoked_at) < Number(sig.ts)) return 'bad';
      const pub = await subtle.importKey('raw', unb64(k.public_key), { name: 'Ed25519' }, false, ['verify']);
      const reply = m.reply_to && typeof m.reply_to === 'object' ? m.reply_to.id : (m.reply_to ?? m.reply?.id ?? null);
      const base = { community: m.server, channel: m.channel, author: m.author.velora_id, ts: sig.ts, nonce: sig.nonce, body: m.body ?? '', attachments: attRefs(m.attachments), reply_to: reply, edit_of: m.edited_at ? m.id : null, sticker: m.sticker?.tid ?? null };
      const issuers = [...new Set([issuerFor(inf), 'https://nookara.cc', 'https://velora.ikelene.net', 'https://ember.nookara.cc'])];
      for (const iss of issuers) for (const instance of [m.origin, ...previousUrls]) {
        if (await subtle.verify({ name: 'Ed25519' }, pub, unb64(sig.sig), signedBytes(payloadOf({ ...base, iss, instance })))) return 'ok';
      }
      return 'bad';
    } catch (e) { verdicts.delete(id); return e?.name === 'NotSupportedError' || e?.message === 'key_lookup' || e instanceof TypeError ? null : 'bad'; }
  })());
  return verdicts.get(id);
}

window.HammiCrypto = {
  use: fn => { nk = fn; },
  onChange: fn => { subs.add(fn); return () => subs.delete(fn); },
  status, init, forget, setup, unlockPasscode, unlockRecovery, startLink, passcodeType: () => info?.passcode?.type || null, hasRecovery: () => !!info?.recovery,
  bundleFor, forgetBundle, sealDm, sealEdit, openDm, openFile, parseFileLink, sealFile, fileLink, myId: () => me?.id,
  setupSigning, signMessage, canSign: () => !!signer, signState: () => signState, checkMessage, noteClock,
  _test: { setKeys: (k, m) => { keys = k; me = m; }, canonical, payloadOf, signedBytes, encryptFor, seal, unseal, commitOf, linkCodeOf, stretchRecovery, lockBlob, openBlob, b64, unb64, kidOf },
};
})();
