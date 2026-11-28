/* Songbook UI: settings, tabs, the lyric notebook, the rhyme dictionary and the theory tools. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = document.documentElement;
  const T = window.Theory;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
  const put = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
  $('year').textContent = new Date().getFullYear();

  let toastT = 0;
  function toast(html) { const t = $('toast'); t.innerHTML = html; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 1600); }
  async function copyText(s) {
    try { await navigator.clipboard.writeText(s); return true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e2) {} ta.remove(); return ok;
    }
  }

  /* ---------------- settings ---------------- */
  const VOLS = { 0: 0, 1: 0.35, 2: 0.8 };
  const S = { theme: get('hammi-theme', 'auto'), accent: get('hammi-accent', 'orange'), vol: get('sb-vol', '2') };
  function applySettings() {
    if (S.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = S.theme;
    root.classList.toggle('accent-blue', S.accent === 'blue');
    T.setVolume(VOLS[S.vol] ?? 0.8);
    document.querySelectorAll('[data-set]').forEach(g => g.querySelectorAll('.sk').forEach(el =>
      el.querySelector('.led').classList.toggle('on', el.querySelector('button').dataset.v === S[g.dataset.set])));
  }
  applySettings();
  $('sheet').addEventListener('click', e => {
    const b = e.target.closest('button'), g = b && b.closest('[data-set]'); if (!g) return;
    const k = g.dataset.set; S[k] = b.dataset.v;
    if (k === 'theme') put('hammi-theme', b.dataset.v === 'auto' ? null : b.dataset.v);
    else if (k === 'accent') put('hammi-accent', b.dataset.v);
    else put('sb-vol', b.dataset.v);
    applySettings(); if (current === 'theory') drawTheory();
  });
  const toggleSheet = open => { $('sheet').hidden = !open; $('settings').classList.toggle('on', open); $('set-led').classList.toggle('on', open); $('settings').setAttribute('aria-expanded', open); };
  $('settings').addEventListener('click', () => toggleSheet($('sheet').hidden));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) toggleSheet(false); });
  document.addEventListener('click', e => { if (!$('sheet').hidden && !e.target.closest('#sheet, #settings')) toggleSheet(false); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (current === 'theory') drawTheory(); });

  /* ---------------- tabs ---------------- */
  let current = 'write';
  function showTab(name) {
    if (!['write', 'rhymes', 'theory'].includes(name)) name = 'write';
    current = name;
    document.querySelectorAll('.tab').forEach(t => { t.hidden = t.dataset.name !== name; });
    document.querySelectorAll('[data-tab]').forEach(k => k.classList.toggle('on', k.dataset.tab === name));
    document.querySelectorAll('[data-led]').forEach(l => l.classList.toggle('on', l.dataset.led === name));
    if (name === 'theory') drawTheory();
    if (name === 'write') layout();
    if (name === 'rhymes') setTimeout(() => $('rh-in').focus({ preventScroll: true }), 30);
  }
  document.querySelectorAll('[data-tab]').forEach(k => k.addEventListener('click', e => { e.preventDefault(); history.replaceState(null, '', '#' + k.dataset.tab); showTab(k.dataset.tab); }));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  /* =================================================================
     Words: CMU pronunciations, compact. Each line: word, space, commonness 0-4, then one char per sound.
     ================================================================= */
  const V1 = 'ABCDEFGHIJKLMNO', V2 = 'PQRSTUVWXYZ#$%&', V0 = '0123456789*+-/=', CC = 'bcdfghjklmnpqrstvwxyz_~^';
  const VN = ['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW'];
  const CN = ['B', 'CH', 'D', 'DH', 'F', 'G', 'HH', 'JH', 'K', 'L', 'M', 'N', 'NG', 'P', 'R', 'S', 'SH', 'T', 'TH', 'V', 'W', 'Y', 'Z', 'ZH'];
  /* consonant families for near-rhyme scoring */
  const FAM = { b: 'stop', d: 'stop', g: 'stop', p: 'stopv', t: 'stopv', k: 'stopv', m: 'nas', n: 'nas', NG: 'nas', f: 'fric', v: 'fric', TH: 'fric', DH: 'fric', s: 'sib', z: 'sib', SH: 'sib', ZH: 'sib', CH: 'sib', JH: 'sib', l: 'liq', r: 'liq', HH: 'h', w: 'glide', y: 'glide' };
  const vIdx = ch => { let i = V1.indexOf(ch); if (i >= 0) return [i, 1]; i = V2.indexOf(ch); if (i >= 0) return [i, 2]; i = V0.indexOf(ch); if (i >= 0) return [i, 0]; return null; };
  const isV = ch => vIdx(ch) !== null;
  const famOf = ch => { const n = CN[CC.indexOf(ch)] || ''; return FAM[n.length === 1 ? n.toLowerCase() : n] || n; };

  const W = { ready: false, words: [], tier: [], code: [], byWord: new Map(), perfect: new Map(), vowels: new Map(), shape: new Map(), tail: new Map() };
  /* rhyme part: from the last stressed vowel to the end, vowels without stress */
  function rhymeStart(code) {
    let at = -1;
    for (let i = code.length - 1; i >= 0; i--) { const v = vIdx(code[i]); if (v && v[1] === 1) { at = i; break; } }
    if (at < 0) for (let i = code.length - 1; i >= 0; i--) { const v = vIdx(code[i]); if (v && v[1] === 2) { at = i; break; } }
    if (at < 0) for (let i = code.length - 1; i >= 0; i--) if (isV(code[i])) { at = i; break; }
    return Math.max(0, at);
  }
  const norm = s => [...s].map(c => { const v = vIdx(c); return v ? V1[v[0]] : c; }).join('');
  const perfectKey = code => norm(code.slice(rhymeStart(code)));
  const RCH = CC[CN.indexOf('R')];
  const vowelKey = code => { const p = code.slice(rhymeStart(code)); let k = ''; for (let i = 0; i < p.length; i++) if (isV(p[i])) k += V1[vIdx(p[i])[0]] + (p[i + 1] === RCH ? 'r' : ''); return k; };
  /* consonants after the stressed vowel, for consonance (heart / hurt / short) */
  const tailKey = code => { const at = rhymeStart(code), p = code.slice(at + 1); if ([...p].some(isV)) return null; return (vIdx(code[at]) && VN[vIdx(code[at])[0]] === 'ER' ? RCH : '') + p || null; };
  const sylOf = code => [...code].filter(isV).length;
  const stressOf = code => [...code].filter(isV).map(c => vIdx(c)[1]);
  const shapeKey = code => stressOf(code).map(s => (s === 1 ? '1' : '0')).join('');

  const wordsReady = fetch('words.txt').then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }).then(txt => {
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i]; const sp = L.indexOf(' '); if (sp < 1) continue;
      const w = L.slice(0, sp), t = +L[sp + 1], c = L.slice(sp + 2);
      const id = W.words.length; W.words.push(w); W.tier.push(t); W.code.push(c); W.byWord.set(w, id);
      const pk = perfectKey(c), vk = vowelKey(c), sk = shapeKey(c);
      (W.perfect.get(pk) || W.perfect.set(pk, []).get(pk)).push(id);
      (W.vowels.get(vk) || W.vowels.set(vk, []).get(vk)).push(id);
      if (t <= 2) (W.shape.get(sk) || W.shape.set(sk, []).get(sk)).push(id);
      const tk = tailKey(c); if (tk && t <= 3) (W.tail.get(tk) || W.tail.set(tk, []).get(tk)).push(id);
    }
    W.ready = true;
    $('rh-count').textContent = W.words.length.toLocaleString() + ' words';
    layout(); updateRhymePanel(true);
  }).catch(() => { $('rh-count').textContent = 'word list did not load'; });

  /* find a word, trying common spellings used in lyrics */
  function lookup(raw) {
    const w = raw.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z']/g, '');
    if (!w) return null;
    const tries = [w, w.replace(/^'+/, '').replace(/'+$/, '')];
    if (/in'?$/.test(w)) tries.push(w.replace(/in'?$/, 'ing'));
    if (/'s$/.test(w)) tries.push(w.slice(0, -2));
    if (/s'$/.test(w)) tries.push(w.slice(0, -1));
    for (const t of tries) if (W.byWord.has(t)) return { id: W.byWord.get(t), word: t, code: W.code[W.byWord.get(t)] };
    return null;
  }
  /* syllables of an unknown word, by spelling */
  function guessSyl(w) {
    w = w.toLowerCase().replace(/[^a-z]/g, ''); if (!w) return 0; if (w.length <= 3) return 1;
    w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
    const m = w.match(/[aeiouy]{1,2}/g); return Math.max(1, m ? m.length : 1);
  }
  function wordSyl(w) { const f = lookup(w); return f ? sylOf(f.code) : guessSyl(w); }
  /* spelling fallback key for words not in the list */
  const spellKey = w => { const m = w.toLowerCase().replace(/[^a-z]/g, '').match(/[aeiouy]+[^aeiouy]*$/); return m ? '~' + m[0] : '~' + w; };

  function consScore(a, b) {
    const ca = [...a].filter(c => !isV(c)), cb = [...b].filter(c => !isV(c));
    const n = Math.max(ca.length, cb.length); let s = 0;
    for (let i = 1; i <= n; i++) {
      const x = ca[ca.length - i], y = cb[cb.length - i];
      if (x === y) s += 2; else if (x && y && famOf(x) === famOf(y)) s += 1.2; else if (!x || !y) s += 0.4; else s -= 0.5;
    }
    return s / Math.max(1, n);
  }

  function findRhymes(word, limit) {
    const f = lookup(word); if (!f) return null;
    const pk = perfectKey(f.code), vk = vowelKey(f.code), rp = f.code.slice(rhymeStart(f.code));
    const perfectIds = (W.perfect.get(pk) || []).filter(id => W.words[id] !== f.word);
    const pset = new Set(perfectIds);
    const near = (W.vowels.get(vk) || []).filter(id => !pset.has(id) && W.words[id] !== f.word)
      .map(id => ({ id, s: consScore(rp, W.code[id].slice(rhymeStart(W.code[id]))) - W.tier[id] * 0.35 }))
      .filter(x => x.s > 0.2).sort((a, b) => b.s - a.s).slice(0, limit || 80).map(x => x.id);
    const byTier = (a, b) => W.tier[a] - W.tier[b] || W.words[a].length - W.words[b].length;
    const sk = shapeKey(f.code);
    const shape = (W.shape.get(sk) || []).filter(id => W.words[id] !== f.word && W.tier[id] <= 1);
    const tk = tailKey(f.code), nset = new Set(near);
    const cons = tk ? (W.tail.get(tk) || []).filter(id => !pset.has(id) && !nset.has(id) && W.words[id] !== f.word).sort(byTier).slice(0, 80) : [];
    return { f, perfect: perfectIds.sort(byTier), near, shape, cons };
  }
  function readable(code) {
    return [...code].map(c => { const v = vIdx(c); if (v) { const n = VN[v[0]].toLowerCase(); return v[1] === 1 ? '<b>' + n + '</b>' : n; } return CN[CC.indexOf(c)].toLowerCase(); }).join(' ');
  }
  const stressDots = code => stressOf(code).map(s => (s === 1 ? '●' : s === 2 ? '◐' : '○')).join(' ');

  /* =================================================================
     Lyric notebook
     ================================================================= */
  const ta = $('ta'), mirror = $('mirror'), gl = $('gut-l'), gr = $('gut-r');
  const HEADER = /^\s*(\[[^\]]*\]|\(?(verse|chorus|pre-?chorus|bridge|intro|outro|hook|refrain|tag|interlude|solo|post-?chorus)\b[^a-z]*\)?\s*:?\s*\d*\s*:?)\s*$/i;
  const STARTER = { id: 0, title: 'First song', text: '[Verse 1]\nWrite your first line here\nAnd then another one below\n\n[Chorus]\nThis is where the title goes\n', updated: Date.now() };
  let songs;
  try { songs = JSON.parse(get('sb-songs', 'null')); } catch (e) { songs = null; }
  if (!Array.isArray(songs) || !songs.length) songs = [{ ...STARTER, id: Date.now() }];
  let cur = Math.min(+get('sb-cur', 0) || 0, songs.length - 1);
  let saveT = 0;
  function save() {
    $('saved').innerHTML = '<span class="led"></span>saving';
    clearTimeout(saveT);
    saveT = setTimeout(() => { put('sb-songs', JSON.stringify(songs)); put('sb-cur', String(cur)); $('saved').innerHTML = '<span class="led on"></span>saved'; }, 350);
  }
  function renderSongs() {
    $('song-list').innerHTML = songs.map((s, i) => `<li class="${i === cur ? 'on' : ''}"><button data-i="${i}"><span class="led"></span><span>${esc(s.title || 'Untitled song')}</span></button></li>`).join('');
    $('song-count').textContent = String(songs.length).padStart(2, '0');
  }
  function openSong(i) {
    cur = i; ta.value = songs[i].text; $('song-title').value = songs[i].title; renderSongs(); layout(); updateRhymePanel(true); save();
  }
  $('song-list').addEventListener('click', e => { const b = e.target.closest('button'); if (b) openSong(+b.dataset.i); });
  $('song-new').addEventListener('click', () => { songs.unshift({ id: Date.now(), title: '', text: '', updated: Date.now() }); openSong(0); $('song-title').focus(); });
  $('song-title').addEventListener('input', () => { songs[cur].title = $('song-title').value; songs[cur].updated = Date.now(); renderSongs(); save(); });
  ta.addEventListener('input', () => { songs[cur].text = ta.value; songs[cur].updated = Date.now(); layout(); save(); });
  $('act-copy').addEventListener('click', async () => { toast((await copyText(fullText())) ? '<b>●</b> copied song' : 'could not copy'); });
  $('act-export').addEventListener('click', () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([fullText()], { type: 'text/plain' }));
    a.download = (songs[cur].title || 'song').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('act-delete').addEventListener('click', () => {
    const s = songs[cur]; if ((s.text.trim() || s.title.trim()) && !confirm('Delete "' + (s.title || 'Untitled song') + '"? This cannot be undone.')) return;
    songs.splice(cur, 1); if (!songs.length) songs.push({ id: Date.now(), title: '', text: '', updated: Date.now() });
    openSong(Math.min(cur, songs.length - 1));
  });
  const fullText = () => (songs[cur].title ? songs[cur].title + '\n\n' : '') + songs[cur].text;

  /* line analysis: syllables and rhyme letters per section */
  function analyse(lines) {
    const out = lines.map(l => ({ text: l, head: HEADER.test(l), blank: !l.trim(), syl: 0, letter: '', kind: '' }));
    let group = [];
    const flush = () => {
      const keys = [];
      for (const ln of group) {
        const ws = ln.text.match(/[A-Za-z’'][A-Za-z’'-]*/g); if (!ws) continue;
        const last = ws[ws.length - 1].replace(/-/g, '');
        const f = W.ready ? lookup(last) : null;
        ln.pk = f ? perfectKey(f.code) : spellKey(last);
        ln.vk = f ? vowelKey(f.code) : null;
        keys.push(ln);
      }
      let next = 0; const letters = [];
      for (const ln of keys) {
        let hit = letters.find(x => x.pk === ln.pk);
        let kind = 'rh';
        if (!hit && ln.vk) { hit = letters.find(x => x.vk && x.vk === ln.vk && x.vk.length); kind = 'near'; }
        if (hit) { ln.letter = hit.letter; ln.kind = kind; hit.count++; }
        else { const L = String.fromCharCode(65 + (next++ % 26)); letters.push({ pk: ln.pk, vk: ln.vk, letter: L, count: 1, first: ln }); ln.letter = L; ln.kind = 'first'; }
      }
      for (const x of letters) { if (x.count > 1) x.first.kind = 'rh'; else x.first.kind = 'solo'; }
      group = [];
    };
    for (const ln of out) {
      if (ln.head || ln.blank) { flush(); continue; }
      const ws = ln.text.match(/[A-Za-z’'][A-Za-z’'-]*/g) || [];
      ln.syl = ws.reduce((s, w) => s + w.split('-').reduce((a, p) => a + (p ? wordSyl(p) : 0), 0), 0);
      group.push(ln);
    }
    flush();
    return out;
  }

  let rafL = 0;
  function layout() {
    cancelAnimationFrame(rafL);
    rafL = requestAnimationFrame(() => {
      if ($('tab-write').hidden) return;
      ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight, 0) + 'px';
      const lines = ta.value.split('\n');
      mirror.style.width = ta.clientWidth + 'px';
      mirror.innerHTML = lines.map(l => '<div>' + (esc(l) || '&#8203;') + '</div>').join('');
      const kids = mirror.children, info = analyse(lines);
      let L = '', R = '', words = 0, syls = 0, lyricLines = 0;
      for (let i = 0; i < lines.length; i++) {
        const h = kids[i].getBoundingClientRect().height, a = info[i];
        const st = `style="height:${h}px"`;
        if (a.head) { L += `<div ${st} class="hd">§</div>`; R += `<div ${st}></div>`; continue; }
        if (a.blank) { L += `<div ${st}></div>`; R += `<div ${st}></div>`; continue; }
        lyricLines++; syls += a.syl; words += (a.text.match(/[A-Za-z’'][A-Za-z’'-]*/g) || []).length;
        L += `<div ${st} class="${a.syl > 14 ? 'long' : ''}">${a.syl}</div>`;
        R += `<div ${st} class="${a.kind}" title="${a.kind === 'near' ? 'near rhyme' : a.kind === 'rh' ? 'rhyme' : 'no rhyme yet'}">${a.letter}${a.kind === 'near' ? '~' : ''}</div>`;
      }
      gl.innerHTML = L; gr.innerHTML = R;
      $('stats').textContent = `${lyricLines} line${lyricLines === 1 ? '' : 's'} · ${words} word${words === 1 ? '' : 's'} · ${lyricLines ? (syls / lyricLines).toFixed(1) : 0} syl per line` + (W.ready ? '' : ' · loading words');
    });
  }
  window.addEventListener('resize', layout);
  document.fonts && document.fonts.ready.then(layout);

  /* rhymes for the word at the cursor */
  let lastSel = { s: 0, e: 0 }, rpWord = '';
  function wordAtCursor() {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    if (e > s) { const sel = v.slice(s, e).trim(); if (/^[A-Za-z’'-]+$/.test(sel)) return sel; }
    const ls = v.lastIndexOf('\n', s - 1) + 1, le = v.indexOf('\n', s) < 0 ? v.length : v.indexOf('\n', s);
    const line = v.slice(ls, le);
    if (HEADER.test(line)) return '';
    const re = /[A-Za-z’'][A-Za-z’'-]*/g; let m, best = '';
    while ((m = re.exec(line))) { if (ls + m.index <= s && s <= ls + m.index + m[0].length) return m[0]; if (ls + m.index < s) best = m[0]; }
    if (s === le) return best;
    return best;
  }
  function wl(ids, cls) { return `<div class="wl ${cls || ''}">` + ids.map(id => `<button class="c${W.tier[id]}" data-w="${esc(W.words[id])}">${esc(W.words[id])}</button>`).join('') + '</div>'; }
  function updateRhymePanel(force) {
    if (!W.ready) return;
    const w = wordAtCursor().replace(/[’]/g, "'").replace(/-/g, '');
    if (!force && w === rpWord) return;
    rpWord = w;
    $('rp-word').textContent = w ? w.toLowerCase() : '—';
    if (!w) { $('rp-syl').textContent = ''; $('rp-body').innerHTML = '<p class="g-mute">Click a word in your lyrics, or put the cursor at the end of a line.</p>'; return; }
    const r = findRhymes(w, 24);
    if (!r) { $('rp-syl').textContent = guessSyl(w) + ' syl?'; $('rp-body').innerHTML = '<p class="g-mute">This word is not in the word list, so there are no rhymes for it. The syllable count is a guess.</p>'; return; }
    $('rp-syl').textContent = sylOf(r.f.code) + ' syl · ' + stressDots(r.f.code);
    const p = r.perfect.slice(0, 40), n = r.near.slice(0, 24);
    $('rp-body').innerHTML = (p.length ? `<div class="rp-group"><h5>rhymes · tap to insert</h5>${wl(p)}</div>` : '') +
      (n.length ? `<div class="rp-group"><h5>near rhymes</h5>${wl(n)}</div>` : '') +
      (!p.length && !n.length ? '<p class="g-mute">Nothing rhymes well with this one. Try a different word at the end of the line.</p>' : '') +
      `<div class="rp-group"><button class="more" data-full="${esc(w)}">open in rhyme dictionary</button></div>`;
  }
  ['keyup', 'click', 'select'].forEach(ev => ta.addEventListener(ev, () => { lastSel = { s: ta.selectionStart, e: ta.selectionEnd }; updateRhymePanel(); }));
  ta.addEventListener('blur', () => { lastSel = { s: ta.selectionStart, e: ta.selectionEnd }; });
  $('rp-body').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  $('rp-body').addEventListener('click', e => {
    const full = e.target.closest('[data-full]');
    if (full) { $('rh-in').value = full.dataset.full; history.replaceState(null, '', '#rhymes'); showTab('rhymes'); runSearch(); return; }
    const b = e.target.closest('[data-w]'); if (!b) return;
    insertAtCursor(b.dataset.w, true);
  });
  function insertAtCursor(text, asWord) {
    const v = ta.value; let { s, e } = document.activeElement === ta ? { s: ta.selectionStart, e: ta.selectionEnd } : lastSel;
    if (asWord) {
      const before = v.slice(0, s);
      if (before && !/[\s(\["'-]$/.test(before)) text = ' ' + text;
      if (e > s && /^[A-Za-z’'-]+$/.test(v.slice(s, e))) text = text.trimStart(); /* replacing a selected word */
    }
    ta.focus(); ta.setSelectionRange(s, e);
    if (!document.execCommand || !document.execCommand('insertText', false, text)) { ta.setRangeText(text, s, e, 'end'); ta.dispatchEvent(new Event('input')); }
    lastSel = { s: ta.selectionStart, e: ta.selectionEnd };
  }
  function appendBlock(block) {
    const v = ta.value.replace(/\s+$/, '');
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const add = (v ? (ta.value.endsWith('\n\n') ? '' : ta.value.endsWith('\n') ? '\n' : '\n\n') : '') + block;
    if (!document.execCommand || !document.execCommand('insertText', false, add)) { ta.value += add; ta.dispatchEvent(new Event('input')); }
    layout();
  }

  /* structures and sections */
  const STRUCTS = [
    { id: 'vc', name: 'Verse / chorus', parts: ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Chorus'], tip: 'The most common shape. Verses tell the story, the chorus repeats the main idea. A bridge near the end gives a fresh angle before the last chorus.' },
    { id: 'vpc', name: 'With pre-chorus', parts: ['Verse 1', 'Pre-chorus', 'Chorus', 'Verse 2', 'Pre-chorus', 'Chorus', 'Bridge', 'Chorus'], tip: 'A short pre-chorus builds tension so the chorus lands harder. Keep its lines shorter and let it rise.' },
    { id: 'hook', name: 'Hook first', parts: ['Chorus', 'Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Outro'], tip: 'Start with the chorus so the hook is the first thing people hear. Good for short, catchy songs.' },
    { id: 'aaba', name: 'AABA', parts: ['A1', 'A2', 'B', 'A3'], tip: 'Classic 32-bar form. Each A section ends on the title line, and B (the middle eight) changes the view before the last A.' },
    { id: 'folk', name: 'Verse / refrain', parts: ['Verse 1', 'Verse 2', 'Verse 3', 'Verse 4'], tip: 'Storytelling form. No chorus: instead each verse ends with the same line, the refrain, which is usually the title.' },
    { id: 'blues', name: '12-bar blues', parts: ['Verse 1', 'Verse 2', 'Verse 3'], lines: ['I woke up this morning, ...', 'I woke up this morning, ...', 'and then the answer line rhymes back'], tip: 'Each verse is three lines (AAB): say a line, say it again, then answer it with a line that rhymes. Matches the 12-bar chords in Theory.' }
  ];
  const SECTIONS = [
    ['Verse', 'Tells the story with detail: who, where, what happened. Lower energy than the chorus. Each verse should move the story on.'],
    ['Pre-chorus', 'Two to four short lines that build up to the chorus. Raise the melody or speed up the words.'],
    ['Chorus', 'The big idea in simple words, with the title in the first or last line. It repeats, so it has to feel true every time.'],
    ['Post-chorus', 'A short chant or hook after the chorus, often one repeated word or sound.'],
    ['Bridge', 'Happens once. A new angle, a twist or a confession, with different chords and melody. Then back to the chorus.'],
    ['Intro', 'Often no words. Sets the mood and tempo.'],
    ['Outro', 'How it ends: repeat the hook, fade out, or one last line that changes the meaning.'],
    ['Hook', 'The line or melody people remember. Short, repeatable, usually the title.']
  ];
  $('structs').innerHTML = STRUCTS.map(s => `<button class="k grey" data-s="${s.id}">${esc(s.name)}</button>`).join('');
  $('sections').innerHTML = SECTIONS.map(([n]) => `<button class="k grey" data-sec="${esc(n)}">${esc(n)}</button>`).join('');
  $('structs').addEventListener('click', e => {
    const b = e.target.closest('[data-s]'); if (!b) return; const s = STRUCTS.find(x => x.id === b.dataset.s);
    $('struct-tip').innerHTML = `<b>${esc(s.name)}:</b> ${esc(s.tip)} <button class="more" data-ins="${s.id}">insert into song</button>`;
    document.querySelectorAll('#structs .k').forEach(k => k.classList.toggle('sel', k === b));
  });
  $('struct-tip').addEventListener('click', e => {
    const b = e.target.closest('[data-ins]'); if (!b) return; const s = STRUCTS.find(x => x.id === b.dataset.ins);
    appendBlock(s.parts.map(p => `[${p}]\n` + (s.lines ? s.lines.join('\n') + '\n' : '\n')).join('\n'));
    toast('<b>●</b> added ' + s.parts.length + ' sections');
  });
  $('sections').addEventListener('click', e => {
    const b = e.target.closest('[data-sec]'); if (!b) return; const s = SECTIONS.find(x => x[0] === b.dataset.sec);
    $('section-tip').innerHTML = `<b>${esc(s[0])}:</b> ${esc(s[1])} <button class="more" data-addsec="${esc(s[0])}">add to song</button>`;
    document.querySelectorAll('#sections .k').forEach(k => k.classList.toggle('sel', k === b));
  });
  $('section-tip').addEventListener('click', e => { const b = e.target.closest('[data-addsec]'); if (b) appendBlock(`[${b.dataset.addsec}]\n`); });

  /* prompts */
  const P = {
    about: ['leaving the town you grew up in', 'a second chance you did not expect', 'the last week of summer', 'an old friend you lost touch with', 'being underestimated', 'not being able to sleep', 'a long drive at night', 'missing someone you never really met', 'starting over at thirty', 'the first snow of the year', 'a promise you broke', 'a city that never learned your name', 'slowly growing apart', 'falling for the wrong person', 'advice a parent gave you', 'staying when you should have gone', 'the night before a big change', 'your childhood home being sold', 'getting better, slowly', 'a secret kept too long', 'winning something that did not matter', 'a song on a stranger’s car radio', 'the ocean at night', 'being proud of yourself for once', 'forgetting what someone’s voice sounded like', 'a fight you are glad you lost', 'two people in different time zones', 'a birthday on your own', 'the friend who always picks up', 'quitting something you loved'],
    image: ['a cracked phone screen', 'a porch light left on', 'a parking lot at 3 a.m.', 'a jacket that still smells like them', 'rain on a train window', 'a half-written letter', 'neon reflected in a puddle', 'a watch that stopped', 'salt on the windshield', 'an empty swimming pool', 'a fading polaroid', 'a ceiling fan turning', 'the last bus of the night', 'a hotel key card', 'a streetlight that keeps flickering', 'airport carpet', 'a borrowed guitar', 'a sunburn that will not fade', 'a lighthouse far away', 'frost on the inside of the glass', 'a pile of unopened mail', 'headlights through the blinds', 'a ferris wheel at closing time', 'a voicemail you never deleted', 'two coffee cups, one untouched', 'a map with a circle on it'],
    feel: ['restless', 'relieved', 'jealous', 'homesick', 'hopeful', 'numb', 'brave', 'nostalgic', 'guilty', 'giddy', 'lonely but okay', 'quietly angry', 'grateful', 'unsure', 'free', 'tired of waiting', 'in love for the first time', 'bittersweet', 'proud', 'reckless'],
    first: ['I kept the ...', 'Nobody told me ...', 'If the night had a name ...', 'There is a version of me who ...', 'We were never ...', 'Tell me again how ...', 'Somewhere past the ...', 'I used to think ...', 'The last time I saw you ...', 'Don’t wake me if ...', 'Every road out of this town ...', 'I’m not the one who ...', 'It was only ...', 'Call it what you want ...', 'Half past ...', 'You left the ...', 'All I wanted was ...', 'Before the lights come up ...', 'Maybe I was ...', 'Here is the thing about ...'],
    rule: ['Use only one-syllable words in the chorus.', 'Put the title in the first and last line of the chorus.', 'No rhymes in the verses, only in the chorus.', 'Mention a colour in every verse.', 'Start every chorus line with the same word.', 'Write it as a letter to one person.', 'Use only near rhymes, no perfect ones.', 'Keep every verse line at 8 syllables.', 'Make the title a question.', 'Tell it all in the present tense.', 'Name a specific time of day.', 'Make the bridge argue with the chorus.', 'Use the same rhyme sound for all of verse 2.', 'The title has three words or fewer.', 'One chorus line is a single word.', 'Write the chorus first.', 'Every verse has one thing you can touch, see and hear.', 'Do not use the words love, heart or forever.']
  };
  const pick = a => a[Math.floor(Math.random() * a.length)];
  let prompt = null;
  function spin() {
    prompt = { about: pick(P.about), image: pick(P.image), feel: pick(P.feel), first: pick(P.first), rule: pick(P.rule) };
    $('prompt').innerHTML = `<dl><dt>write about</dt><dd>${esc(prompt.about)}</dd><dt>feeling</dt><dd>${esc(prompt.feel)}</dd><dt>include</dt><dd>${esc(prompt.image)}</dd><dt>first line</dt><dd class="first">${esc(prompt.first)}</dd><dt>rule</dt><dd>${esc(prompt.rule)}</dd></dl>`;
  }
  spin();
  $('prompt-spin').addEventListener('click', spin);
  $('prompt-add').addEventListener('click', () => {
    appendBlock(`[Prompt]\n(${prompt.about} · ${prompt.feel} · include ${prompt.image} · ${prompt.rule})\n${prompt.first.replace(/ \.\.\.$/, '')}`);
  });

  /* =================================================================
     Rhyme dictionary tab
     ================================================================= */
  function runSearch() {
    const w = $('rh-in').value.trim().split(/\s+/).pop() || '';
    const out = $('rh-results');
    if (!w) { $('rh-read').innerHTML = ''; out.innerHTML = ''; return; }
    if (!W.ready) { $('rh-read').textContent = 'loading the word list…'; wordsReady.then(runSearch); return; }
    const r = findRhymes(w, 120);
    if (!r) {
      $('rh-read').innerHTML = `<b>${esc(w)}</b> · not in the word list · about ${guessSyl(w)} syllable${guessSyl(w) === 1 ? '' : 's'}`;
      const end = w.toLowerCase().replace(/[^a-z]/g, '').slice(-3);
      const ids = end.length >= 2 ? W.words.map((x, i) => i).filter(i => W.words[i].endsWith(end) && W.tier[i] <= 2).slice(0, 60) : [];
      out.innerHTML = `<div class="rh-col"><h3 class="legend"><span>same spelling at the end</span><span class="ln"></span></h3>${ids.length ? wl(ids, 'light') : '<p class="empty">Nothing found. Check the spelling, or try a simpler form of the word.</p>'}</div>`;
      return;
    }
    $('rh-read').innerHTML = `<b>${esc(r.f.word)}</b> · ${sylOf(r.f.code)} syllable${sylOf(r.f.code) === 1 ? '' : 's'} · ${stressDots(r.f.code)} · ${readable(r.f.code)}`;
    const groups = {}; for (const id of r.perfect) { const n = Math.min(sylOf(W.code[id]), 4); (groups[n] = groups[n] || []).push(id); }
    const pHTML = Object.keys(groups).sort().map(n => `<div class="grp"><h4>${n == 4 ? '4+ syllables' : n + ' syllable' + (n == 1 ? '' : 's')} · ${groups[n].length}</h4>${wl(groups[n].slice(0, 90), 'light')}</div>`).join('');
    const sh = sylOf(r.f.code) > 1 ? r.shape.slice().sort(() => Math.random() - 0.5).slice(0, 40) : [];
    out.innerHTML =
      `<div class="rh-col"><h3 class="legend"><span>rhymes</span><span class="ln"></span><span class="dim">${r.perfect.length}</span></h3>${pHTML || '<p class="empty">No perfect rhymes. Try the near rhymes, real songs use them all the time.</p>'}</div>` +
      `<div class="rh-col"><h3 class="legend"><span>near rhymes</span><span class="ln"></span><span class="dim">${r.near.length}</span></h3><p class="empty" style="margin-bottom:12px">Same vowel sounds, different consonants.</p>${r.near.length ? wl(r.near, 'light') : '<p class="empty">No near rhymes found.</p>'}</div>` +
      `<div class="rh-col"><h3 class="legend"><span>same ending</span><span class="ln"></span><span class="dim">${r.cons.length}</span></h3><p class="empty" style="margin-bottom:12px">Different vowel, same last consonants. A softer echo, like heart and hurt.</p>${r.cons.length ? wl(r.cons, 'light') : '<p class="empty">None found.</p>'}` +
      (sh.length ? `<div class="grp" style="margin-top:28px"><h3 class="legend"><span>same rhythm</span><span class="ln"></span><span class="dim">${stressDots(r.f.code)}</span></h3><p class="empty" style="margin:12px 0">Common words with the same syllables and stress, for swapping a word without breaking the beat.</p>${wl(sh, 'light')}<button class="more" id="sh-more">shuffle</button></div>` : '') + '</div>';
  }
  $('rh-form').addEventListener('submit', e => { e.preventDefault(); runSearch(); });
  let rhT = 0; $('rh-in').addEventListener('input', () => { clearTimeout(rhT); rhT = setTimeout(runSearch, 260); });
  $('rh-results').addEventListener('click', async e => {
    if (e.target.id === 'sh-more') { runSearch(); return; }
    const b = e.target.closest('[data-w]'); if (!b) return;
    toast((await copyText(b.dataset.w)) ? `<b>●</b> copied “${esc(b.dataset.w)}”` : 'could not copy');
  });

  /* =================================================================
     Theory
     ================================================================= */
  const K = { pc: 0, scale: 'major', size: 3 };
  try { Object.assign(K, JSON.parse(get('sb-key', '{}'))); } catch (e) {}
  const CF = { pc: 0, q: 'maj' };
  const ROOT_LABEL = ['C', 'C#/Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const shortLabel = pc => ROOT_LABEL[pc].includes('/') ? ROOT_LABEL[pc].split('/')[0] : ROOT_LABEL[pc];
  const MINORISH = ['minor', 'harm', 'mel', 'dorian', 'phryg', 'locrian', 'pmin', 'blues'];
  let mine = []; try { mine = JSON.parse(get('sb-mine', '[]')) || []; } catch (e) {}

  function rootLabels(el, sel, active) {
    el.innerHTML = Array.from({ length: 12 }, (_, pc) => `<button class="k ${pc === active ? 'sel' : [1, 3, 6, 8, 10].includes(pc) ? 'black' : 'grey'}" data-pc="${pc}">${sel(pc)}</button>`).join('');
  }
  function keyRoot() { return T.bestRoot(K.pc, T.scaleById(K.scale)); }
  function keyName() { return keyRoot().name + ' ' + T.scaleById(K.scale).name; }
  const marksFor = (notes, rootPc) => new Map(notes.map(n => [n.pc, { label: n.name, root: n.pc === rootPc }]));
  let kbMode = 'scale', kbChord = null;

  function drawTheory() {
    const sc = T.scaleById(K.scale), r = keyRoot(), notes = T.scaleNotes(r, sc);
    put('sb-key', JSON.stringify(K));
    rootLabels($('roots'), pc => esc(T.bestRoot(pc, sc).name), K.pc);
    $('scales').innerHTML = T.SCALES.map(s => `<button class="k ${s.id === K.scale ? 'sel' : 'grey'}" data-sc="${s.id}">${esc(s.name)}</button>`).join('');
    $('key-name').textContent = keyName();
    $('sc-name').textContent = keyName();
    $('sc-sig').textContent = T.keySignature(r, sc);
    $('sc-notes').innerHTML = notes.map((n, i) => `<span class="${i === 0 ? 'root' : ''}">${esc(n.name)}</span>`).join('');
    $('sc-degs').innerHTML = sc.degs.map(d => `<span>${esc(d)}</span>`).join('');
    $('sc-desc').textContent = sc.desc;
    const minor = MINORISH.includes(K.scale);
    T.drawCircle($('circle'), { pc: K.pc, minor }, (pc, isMinor) => {
      K.pc = pc; if (MINORISH.includes(K.scale) !== isMinor) K.scale = isMinor ? 'minor' : 'major';
      kbMode = 'scale'; drawTheory(); playScale(true);
    });
    const rel = minor ? T.bestRoot(T.mod(K.pc + 3, 12), T.scaleById('major')).name + ' major' : T.bestRoot(T.mod(K.pc + 9, 12), T.scaleById('minor')).name + ' minor';
    const iv = T.spell(r, '4').name, v = T.spell(r, '5').name;
    $('circle-note').innerHTML = `Neighbours on the circle share most notes, so they mix well. ${esc(r.name)}: the ${minor ? 'iv' : 'IV'} is <b style="font-weight:400;color:var(--g-ink)">${esc(iv + (minor ? 'm' : ''))}</b>, the ${minor ? 'v' : 'V'} is <b style="font-weight:400;color:var(--g-ink)">${esc(v + (minor ? 'm' : ''))}</b>, and the relative ${minor ? 'major' : 'minor'} is <b style="font-weight:400;color:var(--g-ink)">${esc(rel)}</b>.`;
    drawKb();
    /* chords in key */
    const dia = T.diatonic(r, sc, K.size);
    $('ckeys').innerHTML = dia.map((c, i) => `<button class="k black" data-ci="${i}"><span class="fn">${esc(c.fn || '')}</span><b>${esc(c.name)}</b><small>${esc(c.roman)}</small></button>`).join('');
    document.querySelectorAll('#ck-size .k').forEach(b => b.classList.toggle('sel', +b.dataset.v === K.size));
    $('ck-note').textContent = sc.degs.length < 7 ? `A ${sc.name} scale has ${sc.degs.length} notes, so these are the chords of ${r.name} ${sc.parent}, which it sits inside. ` : 'Home chords feel settled, lift chords move away a little, tension chords want to go back home. Tap one to hear it and add it to your own progression.';
    /* progressions */
    $('prog-key').textContent = 'in ' + progRoot(false).name + ' and ' + progRoot(true).name + 'm';
    $('progs').innerHTML = T.PROGS.map((p, i) => {
      const pr = progRoot(p.tag.startsWith('minor')), ch = p.rn.map(x => T.parseRoman(x, pr));
      return `<li data-p="${i}"><div class="pn">${esc(p.name)}<small>${esc(p.tag.replace(/^(major|minor)/, '$1 · in ' + pr.name + (p.tag.startsWith('minor') ? 'm' : '')))}</small></div><div class="pc">${ch.map((c, j) => `<span class="chord-chip" data-j="${j}"><b>${esc(c.name)}</b><small>${esc(c.roman)}</small></span>`).join('')}</div><p class="pd">${esc(p.desc)}</p><div class="pp"><button class="k orange" data-play="${i}">Play</button><button class="k grey" data-use="${i}">Use</button></div></li>`;
    }).join('');
    renderMine();
    drawCf();
  }
  function drawKb() {
    const sc = T.scaleById(K.scale), r = keyRoot();
    if (kbMode === 'chord' && kbChord) {
      const t = T.tonesOf(kbChord);
      T.drawKeyboard($('kb'), marksFor(t, t[0].pc), playKey);
      T.drawFret($('fret'), marksFor(t, t[0].pc));
      $('kb-label').textContent = 'showing ' + kbChord.name + ' · tap play scale to go back';
      $('fret-label').textContent = kbChord.name + ' chord tones';
    } else {
      const n = T.scaleNotes(r, sc);
      T.drawKeyboard($('kb'), marksFor(n, r.pc), playKey);
      T.drawFret($('fret'), marksFor(n, r.pc));
      $('kb-label').textContent = 'keyboard shows the scale · tap keys to play';
      $('fret-label').textContent = keyName();
    }
  }
  function playKey(m, rect) { T.note(m, null, 0.6); T.flashKey(rect); }
  let seqId = 0;
  function playScale(quiet) {
    const sc = T.scaleById(K.scale), r = keyRoot(); kbMode = 'scale'; drawKb();
    if (quiet === true) return;
    const id = ++seqId, base = 48 + r.pc + (r.pc > 6 ? -12 : 0) + 12;
    const ms = T.scaleNotes(r, sc).map(n => base + T.mod(n.pc - r.pc, 12)); ms.push(base + 12);
    const t0 = T.now() + 0.05, step = 60 / (+$('bpm').value) / 2;
    ms.forEach((m, i) => T.note(m, t0 + i * step, step * 1.1));
    ms.forEach((m, i) => setTimeout(() => { if (id !== seqId) return; const rect = $('kb').querySelector(`[data-m="${m}"]`); T.flashKey(rect); }, (i * step + 0.05) * 1000));
  }
  $('sc-play').addEventListener('click', () => playScale());
  $('roots').addEventListener('click', e => { const b = e.target.closest('[data-pc]'); if (!b) return; K.pc = +b.dataset.pc; kbMode = 'scale'; drawTheory(); });
  $('scales').addEventListener('click', e => { const b = e.target.closest('[data-sc]'); if (!b) return; K.scale = b.dataset.sc; kbMode = 'scale'; drawTheory(); });
  $('ck-size').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; K.size = +b.dataset.v; drawTheory(); });
  $('ckeys').addEventListener('click', e => {
    const b = e.target.closest('[data-ci]'); if (!b) return;
    const sc = T.scaleById(K.scale), c = T.diatonic(keyRoot(), sc, K.size)[+b.dataset.ci];
    T.chord(T.voice(c), null, 1.1); kbMode = 'chord'; kbChord = c; drawKb();
    if (mine.length < 16) { mine.push({ name: c.name, roman: c.roman, root: c.root.name, q: c.q }); renderMine(); }
  });

  /* progression playback */
  let playing = null;
  function stopPlay() { if (playing) { playing.stop = true; if (playing.btn) playing.btn.textContent = 'Play'; clearTimeout(playing.t); document.querySelectorAll('.chord-chip.now').forEach(x => x.classList.remove('now')); playing = null; } }
  function playChords(list, chips, btn) {
    const was = playing && playing.btn === btn; stopPlay(); if (was || !list.length) return;
    const p = { stop: false, btn, i: 0 }; playing = p;
    if (btn) btn.textContent = 'Stop';
    const beat = () => 60 / (+$('bpm').value);
    const step = () => {
      if (p.stop) return;
      if (p.i >= list.length) { if ($('loop').checked) p.i = 0; else { done(); return; } }
      const c = list[p.i], bar = beat() * (list.length > 8 ? 2 : 4);
      chips.forEach((x, j) => x.classList.toggle('now', j === p.i));
      const v = T.voice(c), t = T.now() + 0.02;
      T.chord(v, t, bar * 0.9);
      if (list.length <= 8) T.note(v[0], t + beat() * 2, beat() * 1.5, 0.15);
      p.i++; p.t = setTimeout(step, bar * 1000);
    };
    const done = () => { chips.forEach(x => x.classList.remove('now')); if (btn) btn.textContent = 'Play'; if (playing === p) playing = null; };
    step();
  }
  /* major progressions use the major key (or the relative major of a minor key), minor ones the minor key */
  function progRoot(wantMinor) {
    const minor = MINORISH.includes(K.scale);
    const pc = wantMinor === minor ? K.pc : wantMinor ? T.mod(K.pc + 9, 12) : T.mod(K.pc + 3, 12);
    return T.rootFromName(T.bestRoot(pc, T.scaleById(wantMinor ? 'minor' : 'major')).name);
  }
  $('progs').addEventListener('click', e => {
    const pb = e.target.closest('[data-play]'), ub = e.target.closest('[data-use]');
    const pp = (pb || ub) && T.PROGS[+(pb || ub).dataset[pb ? 'play' : 'use']], pr = pp && progRoot(pp.tag.startsWith('minor'));
    if (pb) { const p = T.PROGS[+pb.dataset.play]; playChords(p.rn.map(x => T.parseRoman(x, pr)), [...pb.closest('li').querySelectorAll('.chord-chip')], pb); }
    if (ub) { const p = T.PROGS[+ub.dataset.use]; mine = p.rn.map(x => T.parseRoman(x, pr)).map(c => ({ name: c.name, roman: c.roman, root: c.root.name, q: c.q })).slice(0, 16); renderMine(); $('mine-msg').textContent = 'copied ' + p.name.toLowerCase() + ' into your progression'; }
  });
  const mineChord = m => ({ root: T.rootFromName(m.root), q: m.q, name: m.name });
  function renderMine() {
    put('sb-mine', JSON.stringify(mine));
    $('mine').innerHTML = mine.length ? mine.map((m, j) => `<span class="chord-chip" data-j="${j}"><b>${esc(m.name)}</b><small>${esc(m.roman || '')}</small></span>`).join('') : '<span class="g-dim">empty · tap a chord in “chords in this key”</span>';
  }
  $('mine-play').addEventListener('click', e => playChords(mine.map(mineChord), [...$('mine').querySelectorAll('.chord-chip')], e.currentTarget));
  $('mine-undo').addEventListener('click', () => { stopPlay(); mine.pop(); renderMine(); });
  $('mine-clear').addEventListener('click', () => { stopPlay(); mine = []; renderMine(); $('mine-msg').textContent = ''; });
  $('mine-song').addEventListener('click', () => {
    if (!mine.length) { $('mine-msg').textContent = 'add some chords first'; return; }
    const line = `[Chords · ${keyName()}]\n${mine.map(m => m.name).join('  ')}\n`;
    songs[cur].text = songs[cur].text.replace(/\s*$/, '') + (songs[cur].text.trim() ? '\n\n' : '') + line;
    ta.value = songs[cur].text; save();
    $('mine-msg').textContent = 'added to “' + (songs[cur].title || 'Untitled song') + '”';
  });
  $('bpm').addEventListener('input', () => { $('bpm-v').textContent = $('bpm').value; });

  /* chord finder */
  function drawCf() {
    const r = T.bestRoot(CF.pc, T.scaleById(CF.q === 'm' || CF.q === 'm7' || CF.q === 'm6' || CF.q === 'm9' || CF.q === 'dim' || CF.q === 'm7b5' || CF.q === 'dim7' ? 'minor' : 'major'));
    const c = T.chordById(CF.q), notes = T.chordNotes(r, CF.q);
    rootLabels($('cf-roots'), pc => esc(shortLabel(pc) === 'C#' ? 'C#' : shortLabel(pc)), CF.pc);
    $('cf-quals').innerHTML = T.CHORDS.map(q => `<button class="k ${q.id === CF.q ? 'sel' : 'grey'}" data-q="${q.id}">${esc({ maj: 'maj', dim: 'dim', dim7: 'dim7', aug: 'aug' }[q.id] || q.sym)}</button>`).join('');
    $('cf-name').textContent = r.name + c.sym;
    $('cf-full').textContent = r.name + ' ' + c.name;
    $('cf-int').textContent = c.degs.join(' · ');
    $('cf-notes').innerHTML = notes.map((n, i) => `<span class="${i === 0 ? 'root' : ''}">${esc(n.name)}</span>`).join('');
    $('cf-desc').innerHTML = esc(c.desc) + '<br><span class="mono" style="font-size:11px;letter-spacing:.04em">' + c.degs.map(d => esc(T.INTERVAL_NAMES[d] || d)).join(' · ') + '</span>';
    T.drawKeyboard($('cf-kb'), marksFor(notes, r.pc), playKey);
    CF.chord = { root: r, q: CF.q, name: r.name + c.sym };
  }
  $('cf-roots').addEventListener('click', e => { const b = e.target.closest('[data-pc]'); if (!b) return; CF.pc = +b.dataset.pc; drawCf(); T.chord(T.voice(CF.chord), null, 1); });
  $('cf-quals').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (!b) return; CF.q = b.dataset.q; drawCf(); T.chord(T.voice(CF.chord), null, 1); });
  $('cf-play').addEventListener('click', () => T.chord(T.voice(CF.chord), null, 1.4));
  $('cf-arp').addEventListener('click', () => { const v = T.voice(CF.chord).slice(1), t = T.now() + 0.03; v.concat([v[0] + 12]).forEach((m, i) => T.note(m, t + i * 0.18, 0.5)); });
  $('cf-add').addEventListener('click', () => {
    if (mine.length >= 16) { toast('your progression is full (16)'); return; }
    mine.push({ name: CF.chord.name, roman: '', root: CF.chord.root.name, q: CF.q }); renderMine(); toast(`<b>●</b> added ${esc(CF.chord.name)}`);
  });

  /* tap tempo */
  let taps = [];
  $('tap').addEventListener('pointerdown', () => {
    const t = performance.now(); if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
    taps.push(t); if (taps.length > 8) taps.shift();
    T.note(84, null, 0.05, 0.08);
    if (taps.length >= 2) { const bpm = Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1))); $('tap-bpm').textContent = bpm; if (bpm >= 50 && bpm <= 160) { $('bpm').value = bpm; $('bpm-v').textContent = bpm; } }
  });

  /* ---------------- start ---------------- */
  renderSongs();
  ta.value = songs[cur].text; $('song-title').value = songs[cur].title;
  showTab(location.hash.slice(1) || 'write');
})();
