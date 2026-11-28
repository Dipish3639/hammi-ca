/* Songbook music theory: note spelling, scales, chords, roman numerals,
   a small synth for playback, and the piano / fretboard / circle drawings. */
(function () {
  'use strict';
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const mod = (n, m) => ((n % m) + m) % m;

  /* "b3" -> {deg:3, acc:-1} */
  function parseDeg(s) {
    const m = String(s).match(/^(bb|b|##|#)?(\d+)$/);
    const acc = { bb: -2, b: -1, '': 0, '#': 1, '##': 2 }[m[1] || ''];
    return { deg: +m[2], acc };
  }
  function accStr(a) { return a === 0 ? '' : a > 0 ? '#'.repeat(a) : 'b'.repeat(-a); }
  /* spell a degree above a root given as {letter index, pc} */
  function spell(root, degStr) {
    const { deg, acc } = parseDeg(degStr);
    const step = deg - 1;
    const letter = mod(root.l + step, 7);
    const pc = mod(root.pc + MAJOR[mod(step, 7)] + acc, 12);
    const a = mod(pc - LETTER_PC[letter] + 6, 12) - 6;
    return { l: letter, pc, name: LETTERS[letter] + accStr(a), acc: a };
  }
  function rootFromName(n) {
    const l = LETTERS.indexOf(n[0]);
    let a = 0; for (const c of n.slice(1)) a += c === '#' ? 1 : c === 'b' ? -1 : 0;
    return { l, pc: mod(LETTER_PC[l] + a, 12), name: n, acc: a };
  }
  /* both spellings of a pitch class, natural first */
  function spellings(pc) {
    const out = [];
    for (let l = 0; l < 7; l++) { const a = mod(pc - LETTER_PC[l] + 6, 12) - 6; if (Math.abs(a) <= 1) out.push({ l, pc, name: LETTERS[l] + accStr(a), acc: a }); }
    return out.sort((x, y) => Math.abs(x.acc) - Math.abs(y.acc));
  }

  const SCALES = [
    { id: 'major', name: 'major', degs: ['1', '2', '3', '4', '5', '6', '7'], desc: 'Bright and settled. The home base for most pop, rock and folk songs.' },
    { id: 'minor', name: 'minor', degs: ['1', '2', 'b3', '4', '5', 'b6', 'b7'], desc: 'Natural minor. Darker, sad or serious, but still singable and simple.' },
    { id: 'harm', name: 'harmonic minor', degs: ['1', '2', 'b3', '4', '5', 'b6', '7'], desc: 'Minor with a raised 7th. Gives a strong pull back home and a dramatic, old-world sound.' },
    { id: 'mel', name: 'melodic minor', degs: ['1', '2', 'b3', '4', '5', '6', '7'], desc: 'Minor with a raised 6th and 7th. Smooth and a bit jazzy.' },
    { id: 'dorian', name: 'dorian', degs: ['1', '2', 'b3', '4', '5', '6', 'b7'], desc: 'Minor with a brighter 6th. Cool and soulful, common in funk and folk.' },
    { id: 'phryg', name: 'phrygian', degs: ['1', 'b2', 'b3', '4', '5', 'b6', 'b7'], desc: 'Minor with a flat 2nd. Tense and dark, heard in metal and flamenco.' },
    { id: 'lydian', name: 'lydian', degs: ['1', '2', '3', '#4', '5', '6', '7'], desc: 'Major with a raised 4th. Floating and dreamy, a film score favourite.' },
    { id: 'mixo', name: 'mixolydian', degs: ['1', '2', '3', '4', '5', '6', 'b7'], desc: 'Major with a flat 7th. Bluesy and loose, classic rock.' },
    { id: 'locrian', name: 'locrian', degs: ['1', 'b2', 'b3', '4', 'b5', 'b6', 'b7'], desc: 'The most unstable mode, with a flat 5th. Rare as a home key.' },
    { id: 'pmaj', name: 'major pentatonic', degs: ['1', '2', '3', '5', '6'], parent: 'major', desc: 'Five notes, no clashes. Almost any order sounds good over the major key.' },
    { id: 'pmin', name: 'minor pentatonic', degs: ['1', 'b3', '4', '5', 'b7'], parent: 'minor', desc: 'The go-to scale for riffs and solos in rock and blues.' },
    { id: 'blues', name: 'blues', degs: ['1', 'b3', '4', 'b5', '5', 'b7'], parent: 'minor', desc: 'Minor pentatonic plus the "blue note" flat 5th.' }
  ];
  const scaleById = id => SCALES.find(s => s.id === id) || SCALES[0];

  /* pick the root spelling that gives the fewest sharps/flats */
  function bestRoot(pc, scale) {
    const degs = scale.degs.length === 7 ? scale.degs : scaleById(scale.parent).degs;
    let best = null, bestScore = 1e9;
    for (const r of spellings(pc)) {
      const notes = degs.map(d => spell(r, d));
      let score = notes.reduce((s, n) => s + Math.abs(n.acc) * (Math.abs(n.acc) > 1 ? 4 : 1), 0);
      if (notes.some(n => n.acc > 0) && notes.some(n => n.acc < 0)) score += 6;
      if (score < bestScore || (score === bestScore && r.acc < 0 && pc !== 6)) { best = r; bestScore = score; }
    }
    return best;
  }
  function scaleNotes(root, scale) {
    return scale.degs.map(d => { const n = spell(root, d); if (Math.abs(n.acc) < 2) return n; const alt = spellings(n.pc)[0]; return alt || n; });
  }
  function keySignature(root, scale) {
    const degs = scale.degs.length === 7 ? scale.degs : scaleById(scale.parent).degs;
    const n = degs.map(d => spell(root, d));
    const s = n.filter(x => x.acc > 0).length, f = n.filter(x => x.acc < 0).length;
    if (scale.id !== 'harm' && scale.id !== 'mel') return s ? s + ' sharp' + (s > 1 ? 's' : '') : f ? f + ' flat' + (f > 1 ? 's' : '') : 'no sharps or flats';
    return '';
  }

  /* chords: formula in degrees */
  const CHORDS = [
    { id: 'maj', sym: '', name: 'major', degs: ['1', '3', '5'], desc: 'Bright, stable, the default chord.' },
    { id: 'm', sym: 'm', name: 'minor', degs: ['1', 'b3', '5'], desc: 'Darker and softer than major.' },
    { id: '7', sym: '7', name: 'dominant 7th', degs: ['1', '3', '5', 'b7'], desc: 'Wants to move. Pulls strongly to the chord a 5th below. The blues chord.' },
    { id: 'maj7', sym: 'maj7', name: 'major 7th', degs: ['1', '3', '5', '7'], desc: 'Warm and dreamy. Common in soul, jazz and lo-fi.' },
    { id: 'm7', sym: 'm7', name: 'minor 7th', degs: ['1', 'b3', '5', 'b7'], desc: 'Mellow minor. Smooth in R&B and jazz.' },
    { id: 'sus2', sym: 'sus2', name: 'suspended 2nd', degs: ['1', '2', '5'], desc: 'Open and airy, neither major nor minor.' },
    { id: 'sus4', sym: 'sus4', name: 'suspended 4th', degs: ['1', '4', '5'], desc: 'Tense in a gentle way. Often resolves to the major chord.' },
    { id: 'add9', sym: 'add9', name: 'added 9th', degs: ['1', '3', '5', '9'], desc: 'A major chord with sparkle on top.' },
    { id: '6', sym: '6', name: 'major 6th', degs: ['1', '3', '5', '6'], desc: 'Sweet and a little vintage.' },
    { id: 'm6', sym: 'm6', name: 'minor 6th', degs: ['1', 'b3', '5', '6'], desc: 'Minor with a mysterious, spy-film colour.' },
    { id: '9', sym: '9', name: 'dominant 9th', degs: ['1', '3', '5', 'b7', '9'], desc: 'Funky dominant with extra colour.' },
    { id: 'm9', sym: 'm9', name: 'minor 9th', degs: ['1', 'b3', '5', 'b7', '9'], desc: 'Lush minor, neo-soul territory.' },
    { id: 'dim', sym: '°', name: 'diminished', degs: ['1', 'b3', 'b5'], desc: 'Tense and unstable. Good as a passing chord.' },
    { id: 'dim7', sym: '°7', name: 'diminished 7th', degs: ['1', 'b3', 'b5', 'bb7'], desc: 'Very tense, suspense and drama.' },
    { id: 'm7b5', sym: 'm7b5', name: 'half-diminished', degs: ['1', 'b3', 'b5', 'b7'], desc: 'The ii chord of a minor key. Moody and searching.' },
    { id: 'aug', sym: '+', name: 'augmented', degs: ['1', '3', '#5'], desc: 'Strange and stretched. Great as a step between two chords.' },
    { id: '5', sym: '5', name: 'power chord', degs: ['1', '5'], desc: 'Just root and 5th. Neither major nor minor, perfect with distortion.' }
  ];
  const chordById = id => CHORDS.find(c => c.id === id);
  const INTERVAL_NAMES = { '1': 'root', 'b2': 'minor 2nd', '2': 'major 2nd', 'b3': 'minor 3rd', '3': 'major 3rd', '4': 'perfect 4th', '#4': 'augmented 4th', 'b5': 'flat 5th', '5': 'perfect 5th', '#5': 'sharp 5th', 'b6': 'minor 6th', '6': 'major 6th', 'bb7': 'diminished 7th', 'b7': 'minor 7th', '7': 'major 7th', '9': '9th' };

  function chordNotes(root, q) { return chordById(q).degs.map(d => spell(root, d)); }

  /* identify a stacked chord from pitch classes above its root */
  function qualityOf(pcs) {
    const iv = pcs.map(p => mod(p - pcs[0], 12)).slice(1).join(',');
    return { '4,7': 'maj', '3,7': 'm', '3,6': 'dim', '4,8': 'aug', '4,7,10': '7', '4,7,11': 'maj7', '3,7,10': 'm7', '3,6,10': 'm7b5', '3,6,9': 'dim7', '3,7,11': 'mMaj7', '4,8,11': 'augMaj7' }[iv] || 'maj';
  }
  const EXTRA_SYM = { mMaj7: 'm(maj7)', augMaj7: '+maj7' };
  const symOf = q => (chordById(q) ? chordById(q).sym : EXTRA_SYM[q] || '');
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  function romanFor(degIdx, acc, q) {
    let r = ROMAN[degIdx];
    if (['m', 'm7', 'dim', 'dim7', 'm7b5', 'mMaj7', 'm6', 'm9'].includes(q)) r = r.toLowerCase();
    const suf = { dim: '°', dim7: '°7', m7b5: 'ø7', aug: '+', '7': '7', maj7: 'maj7', m7: '7', mMaj7: '(maj7)', augMaj7: '+maj7' }[q] || '';
    return accStr(acc) + r + suf;
  }
  const FUNCTIONS = { major: ['home', 'away', 'home', 'lift', 'tension', 'home', 'tension'], minor: ['home', 'tension', 'home', 'lift', 'tension', 'lift', 'away'] };

  /* chords built from a 7-note scale */
  function diatonic(root, scale, size) {
    const sc = scale.degs.length === 7 ? scale : scaleById(scale.parent);
    const notes = scaleNotes(root, sc);
    return notes.map((n, i) => {
      const tones = [0, 2, 4, 6].slice(0, size).map(k => notes[(i + k) % 7]);
      const q = qualityOf(tones.map(t => t.pc));
      const majPc = mod(root.pc + MAJOR[i], 12);
      const acc = mod(n.pc - majPc + 6, 12) - 6;
      return { root: n, q, name: n.name + symOf(q), roman: romanFor(i, acc, q), tones, fn: (FUNCTIONS[sc.id === 'major' || sc.id === 'lydian' || sc.id === 'mixo' ? 'major' : 'minor'] || [])[i] };
    });
  }

  /* roman numeral -> chord in key */
  function parseRoman(rn, root) {
    const m = rn.match(/^(b|#)?(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(°|\+|ø)?(maj7|7|sus4|sus2|add9|9|6)?$/);
    if (!m) return null;
    const acc = m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0;
    const up = m[2] === m[2].toUpperCase();
    const idx = ROMAN.indexOf(m[2].toUpperCase());
    let q = up ? 'maj' : 'm';
    if (m[3] === '°') q = m[4] === '7' ? 'dim7' : 'dim';
    else if (m[3] === 'ø') q = 'm7b5';
    else if (m[3] === '+') q = 'aug';
    else if (m[4] === '7') q = up ? '7' : 'm7';
    else if (m[4] === 'maj7') q = up ? 'maj7' : 'mMaj7';
    else if (m[4]) q = m[4] === '9' && !up ? 'm9' : m[4] === '6' && !up ? 'm6' : m[4];
    const r = spell(root, accStr(acc) + (idx + 1));
    return { root: r, q, name: r.name + symOf(q), roman: rn };
  }
  /* tones of a chord as {name, pc} with the right letters */
  function tonesOf(ch) {
    if (ch.tones) return ch.tones;
    if (chordById(ch.q)) return chordNotes(ch.root, ch.q);
    const f = { mMaj7: ['1', 'b3', '5', '7'], augMaj7: ['1', '3', '#5', '7'] }[ch.q] || ['1', '3', '5'];
    return f.map(d => spell(ch.root, d));
  }
  /* midi voicing: bass note + close voicing around middle C */
  function voice(ch) {
    const t = tonesOf(ch), r = t[0].pc;
    const bass = 36 + r + (r > 7 ? 0 : 12);
    const out = [bass];
    let prev = 52;
    for (const n of t) { let m = 48 + n.pc; while (m <= prev) m += 12; if (m > 76) m -= 12; out.push(m); prev = m; }
    return out;
  }

  const PROGS = [
    { name: 'The four chords', tag: 'major · pop', rn: ['I', 'V', 'vi', 'IV'], desc: 'Probably the most used progression in modern pop. Hopeful and singable.' },
    { name: 'Sad four', tag: 'major · pop', rn: ['vi', 'IV', 'I', 'V'], desc: 'Same chords, started on the minor one. Instantly more emotional.' },
    { name: '50s doo-wop', tag: 'major · oldies', rn: ['I', 'vi', 'IV', 'V'], desc: 'Sweet and nostalgic, the sound of slow dances.' },
    { name: 'Three chord song', tag: 'major · rock, folk', rn: ['I', 'IV', 'V', 'IV'], desc: 'All you need for a thousand campfire and punk songs.' },
    { name: 'Two-five-one', tag: 'major · jazz', rn: ['ii7', 'V7', 'Imaj7', 'Imaj7'], desc: 'The core move of jazz. Smooth tension and release.' },
    { name: 'Royal road', tag: 'major · j-pop', rn: ['IVmaj7', 'V7', 'iii7', 'vi'], desc: 'Bittersweet and climbing, loved in anime and city pop.' },
    { name: 'Pachelbel', tag: 'major · classical', rn: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], desc: 'The canon. Long, stately and very familiar.' },
    { name: 'Borrowed minor four', tag: 'major · ballad', rn: ['I', 'IV', 'iv', 'I'], desc: 'The minor iv chord adds a lump-in-the-throat moment.' },
    { name: 'Mixolydian rock', tag: 'major · classic rock', rn: ['I', 'bVII', 'IV', 'I'], desc: 'The flat seven chord gives an open, anthem feel.' },
    { name: 'Dream float', tag: 'major · lo-fi', rn: ['Imaj7', 'IVmaj7', 'Imaj7', 'IVmaj7'], desc: 'Two soft chords rocking back and forth. Great for chill beats.' },
    { name: '12-bar blues', tag: 'major · blues', rn: ['I7', 'I7', 'I7', 'I7', 'IV7', 'IV7', 'I7', 'I7', 'V7', 'IV7', 'I7', 'V7'], desc: 'Twelve bars, three chords, the base of blues and early rock.' },
    { name: 'Minor epic', tag: 'minor · film, pop', rn: ['i', 'bVI', 'bIII', 'bVII'], desc: 'Big and cinematic. Works for driving, dramatic choruses.' },
    { name: 'Andalusian', tag: 'minor · flamenco', rn: ['i', 'bVII', 'bVI', 'V'], desc: 'Walks down step by step, ending on a tense major V.' },
    { name: 'Minor drive', tag: 'minor · rock', rn: ['i', 'bVII', 'bVI', 'bVII'], desc: 'Restless and moving, good under a strong riff.' },
    { name: 'Minor soul', tag: 'minor · r&b', rn: ['i7', 'iv7', 'i7', 'v7'], desc: 'Laid-back minor 7th groove.' },
    { name: 'Dark turn', tag: 'minor · ballad', rn: ['i', 'iv', 'V', 'i'], desc: 'A classic minor cadence with a strong pull home.' }
  ];

  /* ---------- sound: a small soft electric-piano-ish synth ---------- */
  let ctx = null, master = null, volume = 0.8;
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4;
      master = ctx.createGain(); master.gain.value = volume;
      master.connect(comp); comp.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function setVolume(v) { volume = v; if (master) master.gain.value = v; }
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  function note(m, t, dur, vel) {
    const c = audio(); if (!c || volume === 0) return;
    t = t == null ? c.currentTime : t; vel = vel == null ? 0.22 : vel;
    const g = c.createGain(), f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.setValueAtTime(Math.min(5200, hz(m) * 7), t); f.frequency.exponentialRampToValueAtTime(Math.max(500, hz(m) * 2), t + dur);
    const o1 = c.createOscillator(), o2 = c.createOscillator(), g2 = c.createGain();
    o1.type = 'triangle'; o1.frequency.value = hz(m);
    o2.type = 'sine'; o2.frequency.value = hz(m) * 2; g2.gain.value = 0.25;
    o1.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(master);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(vel * 0.45, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur + 0.35);
    o1.start(t); o2.start(t); o1.stop(t + dur + 0.4); o2.stop(t + dur + 0.4);
  }
  function chord(midis, t, dur) { const c = audio(); if (!c) return; t = t == null ? c.currentTime + 0.02 : t; midis.forEach((m, i) => note(m, t + i * 0.012, dur, i === 0 ? 0.2 : 0.13)); }
  const now = () => (audio() ? ctx.currentTime : 0);

  /* ---------- drawings ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  /* piano, two octaves from C3 (midi 48). marks: Map pc -> {label, root} */
  function drawKeyboard(svg, marks, onKey) {
    svg.textContent = '';
    const W = 42, H = 120, BW = 26, BH = 74, start = 48;
    const acc = css('--orange') || '#ff5a1f';
    let x = 0; const blacks = [];
    for (let i = 0; i < 14; i++) {
      const pc = LETTER_PC[i % 7], m = start + Math.floor(i / 7) * 12 + pc;
      const mk = marks.get(pc);
      const r = el('rect', { x: x + 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 3, fill: '#efeeea', stroke: '#8f8f8b', 'stroke-width': 1, 'data-m': m }, svg);
      if (mk) {
        el('circle', { cx: x + W / 2, cy: H - 20, r: 9, fill: mk.root ? acc : '#2b2b2a' }, svg);
        const t = el('text', { x: x + W / 2, y: H - 16.5, 'text-anchor': 'middle', 'font-size': 9.5, fill: '#fff' }, svg); t.textContent = mk.label;
      }
      r.addEventListener('pointerdown', e => { e.preventDefault(); onKey && onKey(m, r); });
      if ([0, 1, 3, 4, 5].includes(i % 7)) blacks.push({ x: x + W - BW / 2, m: m + 1 });
      x += W;
    }
    for (const b of blacks) {
      const pc = b.m % 12, mk = marks.get(pc);
      const r = el('rect', { x: b.x, y: 0, width: BW, height: BH, rx: 2, fill: '#1d1d1e', stroke: '#000', 'data-m': b.m }, svg);
      if (mk) {
        el('circle', { cx: b.x + BW / 2, cy: BH - 14, r: 8.5, fill: mk.root ? acc : '#dcdcd9' }, svg);
        const t = el('text', { x: b.x + BW / 2, y: BH - 10.5, 'text-anchor': 'middle', 'font-size': 8.5, fill: mk.root ? '#fff' : '#111' }, svg); t.textContent = mk.label;
      }
      r.addEventListener('pointerdown', e => { e.preventDefault(); onKey && onKey(b.m, r); });
    }
  }
  function flashKey(rect) { if (!rect) return; const f = rect.getAttribute('fill'); rect.setAttribute('fill', css('--orange') || '#ff5a1f'); setTimeout(() => rect.setAttribute('fill', f), 160); }

  /* guitar fretboard 0..12, strings high e on top */
  function drawFret(svg, marks) {
    svg.textContent = '';
    const acc = css('--orange') || '#ff5a1f';
    const tuning = [64, 59, 55, 50, 45, 40], x0 = 34, fw = 48, y0 = 16, sh = 22;
    const fx = f => f === 0 ? x0 - 16 : x0 + (f - 0.5) * fw;
    for (const f of [3, 5, 7, 9]) el('circle', { cx: x0 + (f - 0.5) * fw, cy: y0 + sh * 2.5, r: 4, fill: '#232325' }, svg);
    el('circle', { cx: x0 + 11.5 * fw, cy: y0 + sh * 1.5, r: 4, fill: '#232325' }, svg);
    el('circle', { cx: x0 + 11.5 * fw, cy: y0 + sh * 3.5, r: 4, fill: '#232325' }, svg);
    for (let f = 0; f <= 12; f++) el('line', { x1: x0 + f * fw, x2: x0 + f * fw, y1: y0, y2: y0 + sh * 5, stroke: f === 0 ? '#8d8d8a' : '#3a3a3c', 'stroke-width': f === 0 ? 3 : 1 }, svg);
    tuning.forEach((open, s) => {
      el('line', { x1: x0, x2: x0 + 12 * fw, y1: y0 + s * sh, y2: y0 + s * sh, stroke: '#6a6a68', 'stroke-width': 0.8 + s * 0.25 }, svg);
      for (let f = 0; f <= 12; f++) {
        const mk = marks.get((open + f) % 12); if (!mk) continue;
        el('circle', { cx: fx(f), cy: y0 + s * sh, r: 8.5, fill: mk.root ? acc : '#e9e9e6' }, svg);
        const t = el('text', { x: fx(f), y: y0 + s * sh + 3.2, 'text-anchor': 'middle', 'font-size': 8.5, fill: mk.root ? '#fff' : '#111' }, svg); t.textContent = mk.label;
      }
    });
    for (let f = 1; f <= 12; f++) { const t = el('text', { x: x0 + (f - 0.5) * fw, y: y0 + sh * 5 + 20, 'text-anchor': 'middle', 'font-size': 9, fill: '#5a5a58' }, svg); t.textContent = f; }
  }

  /* circle of fifths. current = {pc, minor}, onPick(pc, minor) */
  const CIRCLE_MAJ = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'];
  const CIRCLE_MIN = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm'];
  const CIRCLE_SIG = ['0', '1♯', '2♯', '3♯', '4♯', '5♯', '6♯/6♭', '5♭', '4♭', '3♭', '2♭', '1♭'];
  function drawCircle(svg, current, onPick) {
    svg.textContent = '';
    const acc = css('--orange') || '#ff5a1f';
    const cx = 200, cy = 200, R1 = 192, R2 = 132, R3 = 84;
    const pos = current.minor ? mod((current.pc - 9) * 7, 12) : mod(current.pc * 7, 12);
    const near = new Set([pos, mod(pos + 1, 12), mod(pos - 1, 12)]);
    const arc = (r1, r2, a0, a1) => {
      const p = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
      const [x1, y1] = p(r1, a0), [x2, y2] = p(r1, a1), [x3, y3] = p(r2, a1), [x4, y4] = p(r2, a0);
      return `M${x1},${y1} A${r1},${r1} 0 0 1 ${x2},${y2} L${x3},${y3} A${r2},${r2} 0 0 0 ${x4},${y4}Z`;
    };
    for (let i = 0; i < 12; i++) {
      const a0 = (i - 0.5) * Math.PI / 6 + 0.006, a1 = (i + 0.5) * Math.PI / 6 - 0.006, am = i * Math.PI / 6;
      const majOn = !current.minor && i === pos, minOn = current.minor && i === pos;
      const outer = el('path', { d: arc(R1, R2 + 2, a0, a1), class: 'seg', fill: majOn ? acc : near.has(i) ? '#262628' : '#151516', stroke: '#0b0b0c' }, svg);
      const inner = el('path', { d: arc(R2 - 2, R3, a0, a1), class: 'seg', fill: minOn ? acc : near.has(i) ? '#202022' : '#121213', stroke: '#0b0b0c' }, svg);
      const tp = (r) => [cx + r * Math.sin(am), cy - r * Math.cos(am)];
      let [x, y] = tp(170); let t = el('text', { x, y: y + 6, 'text-anchor': 'middle', 'font-size': 17, fill: majOn ? '#fff' : near.has(i) ? '#e9e9e6' : '#9a9a97' }, svg); t.textContent = CIRCLE_MAJ[i];
      [x, y] = tp(146); t = el('text', { x, y: y + 3, 'text-anchor': 'middle', 'font-size': 8.5, fill: majOn ? '#fff' : '#5a5a58' }, svg); t.textContent = CIRCLE_SIG[i];
      [x, y] = tp(108); t = el('text', { x, y: y + 4.5, 'text-anchor': 'middle', 'font-size': 12.5, fill: minOn ? '#fff' : near.has(i) ? '#c9c9c5' : '#6f6f6c' }, svg); t.textContent = CIRCLE_MIN[i];
      outer.addEventListener('click', () => onPick(rootFromName(CIRCLE_MAJ[i]).pc, false, CIRCLE_MAJ[i]));
      inner.addEventListener('click', () => onPick(rootFromName(CIRCLE_MIN[i].replace('m', '')).pc, true, CIRCLE_MIN[i].replace('m', '')));
    }
    el('circle', { cx, cy, r: R3 - 6, fill: 'none', stroke: '#1e1e1f' }, svg);
    let t = el('text', { x: cx, y: cy - 6, 'text-anchor': 'middle', 'font-size': 10, fill: '#5a5a58', 'letter-spacing': '1.5' }, svg); t.textContent = 'MAJOR OUT';
    t = el('text', { x: cx, y: cy + 12, 'text-anchor': 'middle', 'font-size': 10, fill: '#5a5a58', 'letter-spacing': '1.5' }, svg); t.textContent = 'MINOR IN';
  }

  window.Theory = { LETTERS, spell, rootFromName, spellings, SCALES, scaleById, bestRoot, scaleNotes, keySignature, CHORDS, chordById, chordNotes, INTERVAL_NAMES, diatonic, parseRoman, tonesOf, voice, PROGS, symOf, note, chord, now, audio, setVolume, drawKeyboard, flashKey, drawFret, drawCircle, mod };
})();
