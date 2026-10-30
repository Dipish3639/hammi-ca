// Hammi 24 in 3D. Built with three.js and bundled into public/view3d.js (see build.sh).
// Everything is made in code: sculpted hypercar bodies with team liveries, the circuit, kerbs,
// gravel traps, grandstand, pit building, trees, a sky that follows the race clock, rain and
// a wet track, headlights at night, and broadcast-style cameras.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createAudio } from './audio.js';

const TRACK_W = 14;          // metres
const PIT_OFF = 24;          // pit lane centre, metres from the track centre line
const ni = (g) => (g.index ? g.toNonIndexed() : g);
const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (() => { let s = 1234567; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();

// ---- the circuit as a smooth curve -------------------------------------------------
class Circuit {
  constructor(track) {
    this.length = track.length;
    this.step = track.step;
    this.pitIn = track.pitIn; this.pitOut = track.pitOut;
    const P = track.points;
    let d = 0;
    for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; d += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    const k = this.length / d; // metres per sheet unit
    let cx = 0, cz = 0;
    for (const p of P) { cx += p[0]; cz += p[1]; }
    cx /= P.length; cz /= P.length;
    this.pts = P.map(([x, y]) => [(x - cx) * k, (y - cz) * k]);
    // which side is the inside of the loop (pits go there)
    let area = 0;
    for (let i = 0; i < this.pts.length; i++) { const a = this.pts[i], b = this.pts[(i + 1) % this.pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
    this.inside = area > 0 ? 1 : -1; // multiplier for the left normal
    this.corners = track.corners;
  }
  // position and unit tangent at distance s (Catmull-Rom through the 10 m points)
  at(s, out = {}) {
    const n = this.pts.length;
    const f = ((((s % this.length) + this.length) % this.length) / this.step);
    const i = Math.floor(f), t = f - i;
    const p0 = this.pts[(i - 1 + n) % n], p1 = this.pts[i % n], p2 = this.pts[(i + 1) % n], p3 = this.pts[(i + 2) % n];
    const t2 = t * t, t3 = t2 * t;
    const c = (k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
    const dd = (k) => 0.5 * ((-p0[k] + p2[k]) + 2 * (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t + 3 * (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t2);
    const tx = dd(0), tz = dd(1), L = Math.hypot(tx, tz) || 1;
    out.x = c(0); out.z = c(1); out.tx = tx / L; out.tz = tz / L;
    out.nx = -out.tz; out.nz = out.tx; // left normal
    return out;
  }
  // The racing line, as an offset from the centre line every `step` metres: a string pulled tight
  // inside the track edges, so it runs wide into a corner, clips the apex and drifts out on exit.
  buildLine(halfWidth) {
    const n = this.pts.length, cen = [], nor = [];
    for (let i = 0; i < n; i++) { const p = this.at(i * this.step); cen.push([p.x, p.z]); nor.push([p.nx, p.nz]); }
    const o = new Float32Array(n);
    const px = (i) => { const j = ((i % n) + n) % n; return cen[j][0] + nor[j][0] * o[j]; };
    const pz = (i) => { const j = ((i % n) + n) % n; return cen[j][1] + nor[j][1] * o[j]; };
    for (const k of [12, 8, 5, 3, 2, 1]) {
      for (let it = 0; it < 80; it++) {
        for (let i = 0; i < n; i++) {
          const mx = (px(i - k) + px(i + k)) / 2, mz = (pz(i - k) + pz(i + k)) / 2;
          const want = (mx - cen[i][0]) * nor[i][0] + (mz - cen[i][1]) * nor[i][1];
          o[i] = Math.max(-halfWidth, Math.min(halfWidth, o[i] + (want - o[i]) * 0.5));
        }
      }
    }
    // a light final smoothing so steering never snaps
    for (let it = 0; it < 4; it++) { const c = o.slice(); for (let i = 0; i < n; i++) o[i] = (c[(i - 1 + n) % n] + 2 * c[i] + c[(i + 1) % n]) / 4; }
    this.line = o;
  }
  lineAt(s) {
    const n = this.line.length, f = ((((s % this.length) + this.length) % this.length) / this.step);
    const i = Math.floor(f), t = f - i;
    const p0 = this.line[(i - 1 + n) % n], p1 = this.line[i % n], p2 = this.line[(i + 1) % n], p3 = this.line[(i + 2) % n];
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  }
  lineSlope(s) { return (this.lineAt(s + 2) - this.lineAt(s - 2)) / 4; } // metres sideways per metre along
  curvature(s) {
    const a = this.at(s - 8), b = this.at(s + 8);
    let dh = Math.atan2(b.tz, b.tx) - Math.atan2(a.tz, a.tx);
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    return dh / 16; // 1/m, signed (positive turns left)
  }
  // how far into the pit lane a car is, 0..1
  pitBlend(s) {
    const L = this.length, P = L - this.pitIn + this.pitOut;
    const d = (((s - this.pitIn) % L) + L) % L;
    if (d > P) return 0;
    return smooth(d / 140) * smooth((P - d) / 140);
  }
}

// ---- textures painted on canvases --------------------------------------------------
function canvasTex(w, h, draw, { repeat = true, srgb = true } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function noise(g, w, h, base, spread, n, size = 1.5) {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = (rand() - 0.5) * spread;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    g.fillRect(rand() * w, rand() * h, size * (0.5 + rand()), size * (0.5 + rand()));
  }
}
const asphaltTex = () => canvasTex(512, 512, (g, w, h) => {
  noise(g, w, h, '#3a3c40', 0.22, 60000, 1.6);
  // rubbered-in racing line
  const grd = g.createLinearGradient(0, 0, w, 0);
  grd.addColorStop(0.25, 'rgba(0,0,0,0)'); grd.addColorStop(0.5, 'rgba(10,10,12,0.28)'); grd.addColorStop(0.75, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
  g.fillStyle = '#e9e9e4'; g.fillRect(w * 0.025, 0, w * 0.018, h); g.fillRect(w * 0.957, 0, w * 0.018, h);
});
const grassTex = () => canvasTex(1024, 1024, (g, w, h) => {
  noise(g, w, h, '#557a3c', 0.14, 160000, 2.4);
  for (let i = 0; i < 60; i++) { const r = g.createRadialGradient(0, 0, 0, 0, 0, 1); const x = rand() * w, y = rand() * h, rr = 60 + rand() * 180; g.save(); g.translate(x, y); g.scale(rr, rr); r.addColorStop(0, rand() < 0.5 ? 'rgba(120,140,60,0.22)' : 'rgba(30,70,30,0.22)'); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(-1, -1, 2, 2); g.restore(); }
  for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(${rand() < 0.5 ? '110,150,60' : '40,80,30'},0.35)`; g.fillRect(rand() * w, rand() * h, 1, 3 + rand() * 3); }
});
const gravelTex = () => canvasTex(256, 256, (g, w, h) => noise(g, w, h, '#a8916b', 0.4, 30000, 1.8));
const kerbTex = () => canvasTex(64, 128, (g, w, h) => {
  g.fillStyle = '#d42a24'; g.fillRect(0, 0, w, h / 2); g.fillStyle = '#f4f4f0'; g.fillRect(0, h / 2, w, h / 2);
  g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, 0, w * 0.15, h);
});
const crowdTex = () => canvasTex(512, 128, (g, w, h) => {
  g.fillStyle = '#5b6170'; g.fillRect(0, 0, w, h);
  const cols = ['#e74c3c', '#f1c40f', '#ecf0f1', '#3498db', '#2ecc71', '#e67e22', '#9b59b6', '#1abc9c', '#222'];
  for (let y = 4; y < h; y += 9) for (let x = 2; x < w; x += 5) if (rand() < 0.82) { g.fillStyle = cols[Math.floor(rand() * cols.length)]; g.beginPath(); g.arc(x + rand() * 2, y + rand() * 2, 2, 0, 7); g.fill(); }
});
function boardTex(text, bg, fg) {
  return canvasTex(512, 64, (g, w, h) => {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.fillStyle = fg; g.font = '800 40px Bricolage, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 2);
  }, { repeat: false });
}
function glowTex() {
  return canvasTex(128, 128, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, 'rgba(255,245,220,1)'); r.addColorStop(0.4, 'rgba(255,235,200,0.35)'); r.addColorStop(1, 'rgba(255,230,200,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  }, { repeat: false });
}

// ---- ribbons along the track -----------------------------------------------------------
// Builds a strip between two offsets from the centre line, for a range of s, with UVs
// (u across, v along in metres / vScale).
function ribbon(C, { from = 0, to = C.length, inner, outer, y = 0, step = 2.5, vScale = 10, offsetFn = null }) {
  const pos = [], uv = [], idx = [];
  const p = {};
  let n = 0;
  for (let s = from; s <= to + 1e-6; s += step) {
    C.at(s, p);
    const o = offsetFn ? offsetFn(s) : 0;
    const a = typeof inner === 'function' ? inner(s) : inner, b = typeof outer === 'function' ? outer(s) : outer;
    pos.push(p.x + p.nx * (a + o), y, p.z + p.nz * (a + o), p.x + p.nx * (b + o), y, p.z + p.nz * (b + o));
    uv.push(0, (s - from) / vScale, 1, (s - from) / vScale);
    if (n > 0) { const i = 2 * n; idx.push(i - 2, i, i - 1, i - 1, i, i + 1); }
    n++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure the strip faces up whichever way round the offsets were
  const nrm = g.getAttribute('normal');
  if (nrm.getY(0) < 0) { g.setIndex(idx.map((v, i) => (i % 3 === 1 ? idx[i + 1] : i % 3 === 2 ? idx[i - 1] : v))); g.computeVertexNormals(); }
  return g;
}
// a vertical wall along the track (barriers, pit wall)
function wall(C, { from, to, offset, height, step = 4, y0 = 0, offsetFn = null }) {
  const pos = [], uv = [], idx = [];
  const p = {};
  let n = 0;
  for (let s = from; s <= to + 1e-6; s += step) {
    C.at(s, p);
    const o = offset + (offsetFn ? offsetFn(s) : 0);
    pos.push(p.x + p.nx * o, y0, p.z + p.nz * o, p.x + p.nx * o, y0 + height, p.z + p.nz * o);
    uv.push((s - from) / 4, 0, (s - from) / 4, 1);
    if (n > 0) { const i = 2 * n; idx.push(i - 2, i, i - 1, i - 1, i, i + 1); }
    n++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---- the car ------------------------------------------------------------------------------
// A Le Mans hypercar shape lofted from cross-sections: low nose, tall front and rear fenders
// with wheel arches cut into them, a teardrop canopy, shark fin and a big rear wing.
const CAR = { L: 4.9, HW: 1.0, WB_F: 1.48, WB_R: -1.42, TYRE_R: 0.355, TRACK: 0.8 };

function keyInterp(keys, x) {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) { const [x0, y0] = keys[i - 1], [x1, y1] = keys[i]; const t = (x - x0) / (x1 - x0); return lerp(y0, y1, (1 - Math.cos(Math.PI * t)) / 2); }
  }
  return keys[keys.length - 1][1];
}
// Profiles along the car (x = metres from the middle, nose at +x). Each one is a height or
// width that the cross-section uses at that station.
const P_HW = [[-2.45, 0.9], [-2.3, 0.98], [-1.9, 1.0], [1.9, 1.0], [2.2, 0.97], [2.45, 0.9]];       // half width
const P_FENDER = [[-2.45, 0.8], [-2.0, 0.88], [-1.42, 0.91], [-0.85, 0.84], [-0.4, 0.66], [0.55, 0.64], [1.0, 0.8], [1.48, 0.87], [1.95, 0.8], [2.3, 0.62], [2.45, 0.46]]; // crest over the wheels, sidepod top between
const P_FZ = [[-2.45, 0.74], [-1.42, 0.78], [-0.6, 0.76], [0.0, 0.7], [0.7, 0.72], [1.48, 0.78], [2.45, 0.74]]; // crest position across
const P_DECK = [[-2.45, 0.7], [-1.6, 0.74], [-0.7, 0.66], [0.2, 0.52], [1.0, 0.48], [1.8, 0.42], [2.45, 0.3]]; // between fender and middle
const P_CENTER = [[-2.45, 0.68], [-1.8, 0.78], [-0.8, 0.8], [-0.4, 0.66], [0.6, 0.6], [1.2, 0.52], [1.9, 0.4], [2.45, 0.28]]; // spine (engine cover, nose)
const P_BOT = [[-2.45, 0.16], [-1.9, 0.09], [1.9, 0.09], [2.45, 0.14]];

function archTop(x) {
  for (const xw of [CAR.WB_F, CAR.WB_R]) {
    const t = (x - xw) / 0.52;
    if (Math.abs(t) < 1) return 0.4 + 0.37 * Math.sqrt(1 - t * t);
  }
  return 0;
}

// Half cross-section (right side, z >= 0) from the bottom centre round to the top centre.
// Every station returns the same number of points so the skin can be stitched together.
const SEG = [1, 1, 1, 1, 3, 4, 4, 4, 4, 5]; // samples per segment (1 = straight edge)
const PROFILE_N = SEG.reduce((a, b) => a + b, 0) + 1;
function section(x) {
  const hw = keyInterp(P_HW, x), B = keyInterp(P_BOT, x);
  const F = keyInterp(P_FENDER, x), FZ = Math.min(keyInterp(P_FZ, x), hw - 0.12);
  const D = keyInterp(P_DECK, x), Ct = keyInterp(P_CENTER, x);
  const arch = archTop(x);
  const A = arch ? Math.max(B, arch) : B;
  const S = F - (arch ? 0.1 : 0.05);
  const P = [
    [0, B], [0.5, B], [0.52, A], [hw - 0.05, A], [hw, A + 0.04],
    [hw, Math.max(A + 0.05, S)], [FZ + 0.14, F - 0.025], [FZ, F], [FZ - 0.2, Math.max(D, F - 0.12)],
    [Math.min(0.42, FZ - 0.28), D], [0, Ct],
  ];
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const n = SEG[i];
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      if (n === 1) { out.push(p1); continue; }
      const t2 = t * t, t3 = t2 * t;
      const c = (j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
      out.push([c(0), c(1)]);
    }
  }
  out.push(P[P.length - 1]);
  return out;
}

function bodyGeometry() {
  const NX = 160;
  const H = PROFILE_N, ring = 2 * H - 1; // right half up, then left half back down (shared top point)
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= NX; i++) {
    const u = i / NX;
    const x = -CAR.L / 2 + u * CAR.L;
    const half = section(x);
    // pinch the very ends so the skin closes cleanly
    const endF = Math.min(1, (CAR.L / 2 - Math.abs(x)) / 0.06);
    const pts = [...half, ...half.slice(0, -1).reverse().map(([z, y]) => [-z, y])];
    pts.forEach(([z, y], j) => {
      pos.push(x, lerp(0.42, y, endF), z * endF);
      uv.push(u, j / (ring - 1));
    });
  }
  for (let i = 0; i < NX; i++) for (let j = 0; j < ring - 1; j++) {
    const a = i * ring + j, b = a + ring;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// v ranges of the profile regions, for painting the livery
const PV = (() => {
  const ring = 2 * PROFILE_N - 1; let k = 0; const at = [];
  for (const n of SEG) { at.push(k); k += n; }
  at.push(k);
  const v = (i) => i / (ring - 1);
  return { lowerR: v(at[4]), sideTopR: v(at[5]), crestR: v(at[7]), deckR: v(at[9]), top: v(at[10]), mirror: (x) => 1 - x };
})();

function airfoil(chord, thick) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(chord * 0.15, thick * 1.1, chord * 0.6, thick * 0.8, chord, thick * 0.15);
  s.lineTo(chord, 0);
  s.bezierCurveTo(chord * 0.6, -thick * 0.15, chord * 0.2, -thick * 0.35, 0, 0);
  return s;
}

function wheelGeometries() {
  // tyre: a lathe of a rounded profile, axis along Z
  const r = CAR.TYRE_R, w = 0.32, ri = 0.24;
  const prof = [];
  prof.push(new THREE.Vector2(ri, -w / 2));
  for (let i = 0; i <= 10; i++) { const a = -Math.PI / 2 + (i / 10) * Math.PI / 2; prof.push(new THREE.Vector2(r - 0.03 + Math.cos(a) * 0.03, -w / 2 + 0.03 + Math.sin(a) * 0.03)); }
  for (let i = 0; i <= 10; i++) { const a = (i / 10) * Math.PI / 2; prof.push(new THREE.Vector2(r - 0.03 + Math.cos(a) * 0.03, w / 2 - 0.03 + Math.sin(a) * 0.03)); }
  prof.push(new THREE.Vector2(ri, w / 2));
  const tyre = new THREE.LatheGeometry(prof, 40);
  tyre.rotateX(Math.PI / 2);
  // rim: dish plus five twin spokes
  const parts = [];
  const dish = new THREE.CylinderGeometry(ri, ri, 0.04, 36, 1, false);
  dish.rotateX(Math.PI / 2); dish.translate(0, 0, -0.08); parts.push(dish);
  const lip = new THREE.TorusGeometry(ri - 0.005, 0.012, 8, 36); lip.translate(0, 0, w / 2 - 0.02); parts.push(lip);
  for (let k = 0; k < 10; k++) {
    const sp = new THREE.CylinderGeometry(0.013, 0.02, ri - 0.04, 6);
    sp.translate(0, (ri - 0.04) / 2 + 0.03, 0);
    sp.rotateX(-0.35);
    sp.rotateZ((k / 10) * Math.PI * 2 + (k % 2 ? 0.12 : -0.12));
    sp.translate(0, 0, w / 2 - 0.08);
    parts.push(sp);
  }
  const hub = new THREE.CylinderGeometry(0.05, 0.06, 0.08, 16); hub.rotateX(Math.PI / 2); hub.translate(0, 0, w / 2 - 0.06); parts.push(hub);
  const rim = mergeGeometries(parts.map(ni));
  const disc = new THREE.CylinderGeometry(0.19, 0.19, 0.03, 32); disc.rotateX(Math.PI / 2);
  return { tyre, rim, disc };
}

// Paint scheme painted in profile space: v runs round the car (0 = bottom right, .5 = spine,
// 1 = bottom left), u runs nose-to-tail. Numbers and names go on separate decals.
function liveryTexture(color) {
  return canvasTex(512, 512, (g, w, h) => {
    const col = new THREE.Color(color);
    const hsl = {}; col.getHSL(hsl);
    const accent = hsl.l > 0.62 ? '#14161b' : '#f3f4f6';
    const deep = col.clone().offsetHSL(0, 0.05, -0.18).getStyle();
    const Y = (v) => h * (1 - v); // canvas y for a v value
    g.fillStyle = color; g.fillRect(0, 0, w, h);
    // carbon lower edges and floor
    g.fillStyle = '#17191e';
    g.fillRect(0, Y(PV.lowerR), w, h - Y(PV.lowerR));
    g.fillRect(0, 0, w, Y(PV.mirror(PV.lowerR)));
    // darker tone on the side walls below the shoulder
    g.fillStyle = deep;
    g.fillRect(0, Y(PV.sideTopR) , w, Y(PV.lowerR) - Y(PV.sideTopR));
    g.fillRect(0, Y(PV.mirror(PV.lowerR)), w, Y(PV.mirror(PV.sideTopR)) - Y(PV.mirror(PV.lowerR)));
    // a pinstripe along each fender crest and one down the spine
    g.fillStyle = accent;
    for (const v of [PV.crestR, PV.mirror(PV.crestR)]) g.fillRect(0, Y(v) - 3, w, 6);
    g.fillRect(0, Y(PV.top) - 5, w, 10);
    // nose tip in the accent colour (u near 1)
    g.fillRect(w * 0.975, 0, w * 0.01, h);
  }, { repeat: false });
}

function decalTexture(number, name, color) {
  return canvasTex(512, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#f7f7f5';
    g.beginPath(); g.ellipse(w * 0.3, h * 0.5, 110, 100, 0, 0, 7); g.fill();
    g.fillStyle = '#121212'; g.font = '800 130px Bricolage, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(number), w * 0.3, h * 0.53);
    g.fillStyle = '#ffffff'; g.font = '800 40px Bricolage, system-ui, sans-serif'; g.textAlign = 'left';
    g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 6;
    const nm = name.toUpperCase().slice(0, 24);
    let fs = 40; g.font = `800 ${fs}px Bricolage, system-ui, sans-serif`;
    while (fs > 18 && g.measureText(nm).width > w * 0.43) { fs -= 2; g.font = `800 ${fs}px Bricolage, system-ui, sans-serif`; }
    g.fillText(nm, w * 0.55, h * 0.4);
    g.font = '700 26px Bricolage, system-ui, sans-serif'; g.fillStyle = '#ffcf3f';
    g.fillText('HAMMI 24', w * 0.55, h * 0.64);
  }, { repeat: false });
}

function buildCarKit() {
  const body = bodyGeometry();
  // canopy
  const canopy = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  {
    const p = canopy.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const xs = x > 0 ? x * 0.85 : x * 1.3;
      p.setXYZ(i, xs + 0.18, y * 0.45 + 0.58, z * 0.44 * (x < 0 ? 1 + 0.3 * x : 1));
    }
    canopy.computeVertexNormals();
  }
  // number boards on both sides of the sidepods, and a small one on the nose
  const decal = new THREE.PlaneGeometry(1.2, 0.6);
  const nose = new THREE.PlaneGeometry(0.5, 0.25);
  // shark fin
  const fs = new THREE.Shape();
  fs.moveTo(-0.6, 0.72); fs.bezierCurveTo(-1.0, 1.0, -1.6, 1.08, -2.3, 1.1); fs.lineTo(-2.35, 0.95); fs.lineTo(-2.0, 0.72); fs.lineTo(-0.6, 0.72);
  const fin = new THREE.ExtrudeGeometry(fs, { depth: 0.025, bevelEnabled: false }); fin.translate(0, 0, -0.0125);
  // rear wing: main plane, flap, endplates, swan-neck pylons
  // airfoils extruded across the car, leading edge forward (+x), trailing edge up
  const foil = (chord, thick, segs) => { const g = new THREE.ExtrudeGeometry(airfoil(chord, thick), { depth: 1.86, bevelEnabled: false, curveSegments: segs }); g.rotateY(Math.PI); g.translate(0, 0, 0.93); return g; };
  const mainPlane = foil(0.38, 0.06, 16); mainPlane.rotateZ(-0.14); mainPlane.translate(-2.06, 1.06, 0);
  const flap = foil(0.17, 0.035, 12); flap.rotateZ(-0.62); flap.translate(-2.4, 1.13, 0);
  const ep = new THREE.Shape(); ep.moveTo(-0.05, -0.32); ep.quadraticCurveTo(0.45, -0.3, 0.5, 0.05); ep.lineTo(0.4, 0.22); ep.quadraticCurveTo(0.1, 0.25, -0.05, 0.12); ep.lineTo(-0.05, -0.32);
  const endL = new THREE.ExtrudeGeometry(ep, { depth: 0.02, bevelEnabled: false }); endL.translate(-2.5, 1.08, 0.93);
  const endR = endL.clone(); endR.translate(0, 0, -1.88);
  const pyl = new THREE.Shape(); pyl.moveTo(0, 0); pyl.quadraticCurveTo(0.1, 0.25, -0.05, 0.42); pyl.lineTo(0.05, 0.44); pyl.quadraticCurveTo(0.22, 0.22, 0.12, 0); pyl.lineTo(0, 0);
  const pylL = new THREE.ExtrudeGeometry(pyl, { depth: 0.02, bevelEnabled: false }); pylL.translate(-2.3, 0.7, 0.25);
  const pylR = pylL.clone(); pylR.translate(0, 0, -0.52);
  const wing = mergeGeometries([mainPlane, flap, endL, endR, pylL, pylR].map(ni));
  // splitter and diffuser
  const splitter = new THREE.ExtrudeGeometry((() => { const s = new THREE.Shape(); s.moveTo(1.4, -0.95); s.lineTo(2.35, -0.88); s.quadraticCurveTo(2.62, 0, 2.35, 0.88); s.lineTo(1.4, 0.95); s.lineTo(1.4, -0.95); return s; })(), { depth: 0.025, bevelEnabled: false });
  splitter.rotateX(Math.PI / 2); splitter.translate(0, 0.07, 0);
  const diff = new THREE.ExtrudeGeometry((() => { const s = new THREE.Shape(); s.moveTo(-1.7, 0.08); s.lineTo(-2.5, 0.32); s.lineTo(-2.5, 0.12); s.lineTo(-1.7, 0.06); return s; })(), { depth: 1.5, bevelEnabled: false });
  diff.translate(0, 0, -0.75);
  const carbon = mergeGeometries([splitter, diff].map(ni));
  // mirrors
  const mirror = new THREE.SphereGeometry(1, 16, 10); mirror.scale(0.12, 0.06, 0.09);
  const mL = mirror.clone(); mL.translate(0.75, 0.86, 0.72);
  const mR = mirror.clone(); mR.translate(0.75, 0.86, -0.72);
  const mirrors = mergeGeometries([mL, mR].map(ni));
  // lights: thin LED strips on the front fenders and a full-width light bar at the back
  const strip = new THREE.CapsuleGeometry(0.025, 0.42, 4, 8); strip.rotateZ(Math.PI / 2 - 0.25);
  const hl = mergeGeometries([strip.clone().translate(2.02, 0.66, 0.68), strip.clone().translate(2.02, 0.66, -0.68)].map(ni));
  const bar = new THREE.CapsuleGeometry(0.022, 1.7, 4, 8); bar.rotateX(Math.PI / 2); bar.translate(-2.44, 0.64, 0);
  const wheels = wheelGeometries();
  return { body, canopy, decal, nose, fin, wing, carbon, mirrors, hl, bar, wheels };
}

// ---- trees ---------------------------------------------------------------------------------
function treeGeometries() {
  const pine = [];
  const trunk = new THREE.CylinderGeometry(0.18, 0.28, 3, 7); trunk.translate(0, 1.5, 0);
  pine.push({ g: trunk, c: '#5b4130' });
  for (let i = 0; i < 4; i++) { const c = new THREE.ConeGeometry(2.6 - i * 0.5, 3.4, 9); c.translate(0, 3.2 + i * 1.7, 0); pine.push({ g: c, c: i % 2 ? '#2f5a2c' : '#2a5028' }); }
  const round = [];
  const t2 = new THREE.CylinderGeometry(0.2, 0.32, 3.4, 7); t2.translate(0, 1.7, 0); round.push({ g: t2, c: '#634733' });
  for (let i = 0; i < 4; i++) {
    const b = new THREE.IcosahedronGeometry(1.9 - i * 0.2, 1);
    const p = b.getAttribute('position');
    for (let k = 0; k < p.count; k++) { const f = 1 + (rand() - 0.5) * 0.25; p.setXYZ(k, p.getX(k) * f, p.getY(k) * f, p.getZ(k) * f); }
    b.translate((rand() - 0.5) * 1.6, 4.2 + i * 0.7 + rand() * 0.6, (rand() - 0.5) * 1.6);
    round.push({ g: b, c: ['#4f7d32', '#5c8a38', '#466f2c', '#55823a'][i] });
  }
  const bake = (list) => mergeGeometries(list.map(({ g, c }) => {
    const n = ni(g); const col = new THREE.Color(c); const arr = [];
    for (let i = 0; i < n.getAttribute('position').count; i++) arr.push(col.r, col.g, col.b);
    n.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3)); n.deleteAttribute('uv'); n.computeVertexNormals(); return n;
  }));
  return [bake(pine), bake(round)];
}

// ---- main view -------------------------------------------------------------------------------
export function createView(opts) {
  const { canvas, track, getSnap, getScale, getSelected, onSelect, labels } = opts;
  const C = new Circuit(track);
  C.buildLine(TRACK_W / 2 - 1.6);
  const audio = createAudio();
  const mobile = Math.min(window.innerWidth, window.innerHeight) < 700;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.9;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.3, 6000);

  // sky and sun
  const sky = new Sky();
  sky.scale.setScalar(10000);
  const su = sky.material.uniforms;
  su.turbidity.value = 2.5; su.rayleigh.value = 2.2; su.mieCoefficient.value = 0.003; su.mieDirectionalG.value = 0.82;
  scene.add(sky);
  const skyScene = new THREE.Scene(); const skyClone = new Sky(); skyClone.scale.setScalar(10000); skyScene.add(skyClone);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;

  const sun = new THREE.DirectionalLight(0xfff1dc, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  sun.shadow.camera.left = -70; sun.shadow.camera.right = 70; sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 600; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a5a3a, 0.7);
  scene.add(hemi);
  scene.fog = new THREE.Fog(0xa9bfd9, 700, 5200);

  // stars for the night
  const starGeo = new THREE.BufferGeometry();
  const sp = [];
  for (let i = 0; i < 2500; i++) { const th = rand() * Math.PI * 2, ph = rand() * Math.PI * 0.45; sp.push(Math.cos(th) * Math.sin(ph) * 4000, Math.cos(ph) * 4000, Math.sin(th) * Math.sin(ph) * 4000); }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  scene.add(stars);

  // ground
  const grass = grassTex(); grass.repeat.set(160, 160);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000, 120, 120), new THREE.MeshStandardMaterial({ map: grass, roughness: 0.95, color: 0xa9b894, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.12; ground.receiveShadow = true;
  scene.add(ground);

  // tarmac, kerbs and gravel
  const asphalt = asphaltTex(); asphalt.repeat.set(1, 1);
  const trackMat = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.82, metalness: 0.0, color: 0xffffff });
  const road = new THREE.Mesh(ribbon(C, { inner: -TRACK_W / 2, outer: TRACK_W / 2, y: 0.03, step: 2, vScale: 14 }), trackMat);
  road.receiveShadow = true; scene.add(road);
  // a pale verge of run-off tarmac on both sides
  const verge = new THREE.MeshStandardMaterial({ color: 0x6f7378, roughness: 0.9, map: asphaltTex() });
  verge.map.repeat.set(1, 1);
  for (const side of [-1, 1]) { const m = new THREE.Mesh(ribbon(C, { inner: side * TRACK_W / 2, outer: side * (TRACK_W / 2 + 3), y: 0.02, step: 3, vScale: 6 }), verge); m.receiveShadow = true; scene.add(m); }

  const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex(), roughness: 0.6 });
  const gravelMat = new THREE.MeshStandardMaterial({ map: gravelTex(), roughness: 1, color: 0xffffff });
  gravelMat.map.repeat.set(4, 1);
  // find the bends
  const bends = [];
  let inB = null;
  for (let s = 0; s < C.length; s += 5) {
    const k = C.curvature(s);
    if (Math.abs(k) > 0.0045) { if (!inB) inB = { from: s, sign: Math.sign(k) }; inB.to = s; }
    else if (inB) { bends.push(inB); inB = null; }
  }
  if (inB) bends.push(inB);
  for (const b of bends) {
    const from = b.from - 25, to = b.to + 25;
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(ribbon(C, { from, to, inner: side * (TRACK_W / 2 - 0.2), outer: side * (TRACK_W / 2 + 1.3), y: 0.045, step: 1, vScale: 2 }), kerbMat);
      m.receiveShadow = true; scene.add(m);
    }
    // gravel trap on the outside of the bend
    const out = -b.sign;
    const g = new THREE.Mesh(ribbon(C, { from: from - 20, to: to + 30, inner: out * (TRACK_W / 2 + 3), outer: (s) => out * (TRACK_W / 2 + 3 + 16 * smooth((s - from + 20) / 40) * smooth((to + 30 - s) / 40)), y: 0.025, step: 3, vScale: 8 }), gravelMat);
    g.receiveShadow = true; scene.add(g);
  }

  // pit lane, pit wall and the pit building on the inside of the main straight
  const pin = C.inside;
  const pitFrom = C.pitIn - C.length, pitTo = C.pitOut;
  const pitRoad = new THREE.Mesh(ribbon(C, { from: pitFrom, to: pitTo, inner: (s) => pin * (PIT_OFF * C.pitBlend(s) - 5), outer: (s) => pin * (PIT_OFF * C.pitBlend(s) + 5), y: 0.028, step: 2, vScale: 14 }), trackMat);
  pitRoad.receiveShadow = true; scene.add(pitRoad);
  const concrete = new THREE.MeshStandardMaterial({ color: 0xd9dbe0, roughness: 0.8 });
  const pitWall = new THREE.Mesh(wall(C, { from: pitFrom + 160, to: pitTo - 160, offset: pin * (TRACK_W / 2 + 6), height: 1.1 }), concrete);
  pitWall.material.side = THREE.DoubleSide; pitWall.castShadow = true; scene.add(pitWall);

  const p0 = C.at(0);
  const heading = Math.atan2(-p0.tz, p0.tx);
  const straight = new THREE.Group();
  straight.position.set(p0.x, 0, p0.z); straight.rotation.y = heading;
  scene.add(straight);
  // local frame: +x along the track, +z = left of travel. Pits on the inside.
  const L = (v) => v * -pin; // three.js local z points right of +x after rotation; flip to put things on the inside
  {
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x1b2a3a, roughness: 0.08, metalness: 0.2, clearcoat: 1 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xeef0f3, roughness: 0.5 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.6 });
    const len = 320;
    // garage block
    const garage = new THREE.Mesh(new THREE.BoxGeometry(len, 7, 14), whiteMat); garage.position.set(-20, 3.5, L(-(PIT_OFF + 13))); garage.castShadow = true; garage.receiveShadow = true; straight.add(garage);
    // garage doors (dark openings with lit interiors)
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, emissive: 0xfff2d8, emissiveIntensity: 0.05, roughness: 0.6 });
    for (let i = 0; i < 30; i++) { const d = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 4.6), doorMat); d.position.set(-20 - len / 2 + 8 + i * 10.4, 2.3, L(-(PIT_OFF + 5.95))); d.rotation.y = pin > 0 ? Math.PI : 0; straight.add(d); }
    // upper floor glass and a cantilever roof
    const glass = new THREE.Mesh(new THREE.BoxGeometry(len, 4, 12), glassMat); glass.position.set(-20, 9, L(-(PIT_OFF + 13))); straight.add(glass);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 6, 0.5, 22), whiteMat); roof.position.set(-20, 11.3, L(-(PIT_OFF + 10))); roof.castShadow = true; straight.add(roof);
    // grandstand on the outside: stepped seating with a crowd, and a roof on thin columns
    const steps = new THREE.Shape();
    steps.moveTo(0, 0);
    for (let i = 0; i < 12; i++) { steps.lineTo(i * 1.3, i * 0.85 + 0.85); steps.lineTo((i + 1) * 1.3, i * 0.85 + 0.85); }
    steps.lineTo(12 * 1.3, 0); steps.lineTo(0, 0);
    const standGeo = new THREE.ExtrudeGeometry(steps, { depth: 260, bevelEnabled: false });
    standGeo.rotateY(Math.PI / 2);
    const crowd = crowdTex(); crowd.repeat.set(26, 1);
    const stand = new THREE.Mesh(standGeo, [new THREE.MeshStandardMaterial({ color: 0x9aa0ab, roughness: 0.9, side: THREE.DoubleSide }), new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.9, side: THREE.DoubleSide })]);
    stand.position.set(-150, 0.4, L(TRACK_W / 2 + 18)); if (pin < 0) { stand.scale.z = -1; }
    stand.castShadow = true; stand.receiveShadow = true; straight.add(stand);
    const sroof = new THREE.Mesh(new THREE.BoxGeometry(270, 0.4, 20), whiteMat); sroof.position.set(-20, 15.5, L(TRACK_W / 2 + 26)); sroof.rotation.x = 0.06 * pin; sroof.castShadow = true; straight.add(sroof);
    for (let i = 0; i < 10; i++) { const col = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 15.5, 8), darkMat); col.position.set(-150 + i * 29, 7.75, L(TRACK_W / 2 + 34)); straight.add(col); }
    // start/finish gantry with start lights
    for (const side of [-1, 1]) { const pole = new THREE.Mesh(new THREE.BoxGeometry(0.6, 9, 0.6), darkMat); pole.position.set(0, 4.5, side * (TRACK_W / 2 + 2)); pole.castShadow = true; straight.add(pole); }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.6, TRACK_W + 5), darkMat); beam.position.set(0, 8.6, 0); beam.castShadow = true; straight.add(beam);
    const boardMat = new THREE.MeshStandardMaterial({ map: boardTex('HAMMI 24', '#ffcf3f', '#141414'), emissive: 0xffffff, emissiveIntensity: 0.15, emissiveMap: null });
    for (const sx of [-0.61, 0.61]) { const b = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W + 4, 1.4), boardMat); b.position.set(sx, 8.6, 0); b.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2; straight.add(b); }
    // chequered line
    const cq = canvasTex(64, 8, (g, w, h) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x * 4, y * 4, 4, 4); } }, { repeat: false });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W, 1.2), new THREE.MeshStandardMaterial({ map: cq, roughness: 0.7 }));
    line.rotation.x = -Math.PI / 2; line.rotation.z = Math.PI / 2; line.position.set(0, 0.05, 0); line.receiveShadow = true; straight.add(line);
  }

  // armco barriers with advertising boards along the straights
  const armco = new THREE.MeshStandardMaterial({ color: 0xc7ccd4, metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    const off = side * (TRACK_W / 2 + 3.4);
    const segs = [];
    let a = null;
    for (let s = 0; s <= C.length; s += 10) {
      const inPits = side === pin && C.pitBlend(s) > 0;
      const gravel = bends.some((b) => s > b.from - 45 && s < b.to + 55 && -b.sign === side);
      if (!inPits && !gravel) { if (a === null) a = s; } else if (a !== null) { segs.push([a, s - 10]); a = null; }
    }
    if (a !== null) segs.push([a, C.length]);
    for (const [f, t] of segs) if (t - f > 20) { const m = new THREE.Mesh(wall(C, { from: f, to: t, offset: off, height: 0.75, y0: 0.2 }), armco); m.castShadow = true; scene.add(m); }
  }
  // trackside advertising: boards on the barriers and big billboards behind them. The brands are
  // the hammi.ca family; teams made with Velora sign-in and the top Pixel Wall painters get boards
  // too, and one billboard shows the Pixel Wall itself. Both refresh once per race (/api/trackside).
  const BRANDS = [['hammi.ca', '#141821', '#ffcf3f'], ['VELORA', '#2f7de1', '#ffffff'], ['HAMMI 24', '#ffcf3f', '#141821'], ['PIXEL WALL', '#e8443a', '#ffffff'],
    ['HOUSE EDGE', '#0f5132', '#f4e3a1'], ['LOWHORN', '#5b5ff0', '#ffffff'], ['race.hammi.ca', '#f08a24', '#141821'], ['IKELENE', '#20b8c4', '#0b1a1f']];
  const SPONSOR_COLS = [['#141821', '#ffffff'], ['#2f7de1', '#ffffff'], ['#f4f4f4', '#141821'], ['#a45ee5', '#ffffff'], ['#2fb36d', '#0b1a12'], ['#e8443a', '#ffffff']];
  function sponsorTex(name, sub, bg, fg, w = 512, h = 64) {
    return canvasTex(w, h, (g) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
      let fs = Math.round(h * (sub ? 0.5 : 0.62)); g.font = `800 ${fs}px Bricolage, system-ui, sans-serif`;
      while (fs > 12 && g.measureText(name).width > w * 0.9) { fs -= 2; g.font = `800 ${fs}px Bricolage, system-ui, sans-serif`; }
      g.fillText(name, w / 2, sub ? h * 0.4 : h / 2 + 2);
      if (sub) { g.globalAlpha = 0.75; g.font = `700 ${Math.round(h * 0.22)}px Bricolage, system-ui, sans-serif`; g.fillText(sub, w / 2, h * 0.8); g.globalAlpha = 1; }
    }, { repeat: false });
  }
  const brandMats = BRANDS.map(([t, b, f]) => new THREE.MeshStandardMaterial({ map: sponsorTex(t, '', b, f), roughness: 0.6 }));
  // is this spot clear of every other part of the circuit?
  const clearOf = (x, z, s0, r) => { for (let k = 0; k < C.pts.length; k += 2) { const ds = Math.abs(k * C.step - s0); if (Math.min(ds, C.length - ds) < 80) continue; if ((C.pts[k][0] - x) ** 2 + (C.pts[k][1] - z) ** 2 < r * r) return false; } return true; };
  const boards = []; // barrier boards, some of which carry sponsor names
  const boardGeo = new THREE.PlaneGeometry(8, 1);
  for (let s = 30, i = 0; s < C.length; s += 32) {
    if (Math.abs(C.curvature(s)) > 0.004) continue;
    for (const side of [-1, 1]) {
      if (side === pin && C.pitBlend(s) > 0) continue;
      if (bends.some((b) => s > b.from - 45 && s < b.to + 55 && -b.sign === side)) continue; // gravel there, no barrier
      const p = C.at(s + (side > 0 ? 16 : 0));
      const off = side * (TRACK_W / 2 + 3.3);
      const m = new THREE.Mesh(boardGeo, brandMats[i % brandMats.length]);
      m.position.set(p.x + p.nx * off, 0.6, p.z + p.nz * off);
      m.lookAt(p.x, 0.6, p.z);
      scene.add(m);
      boards.push({ m, i: i++ });
    }
  }
  // big billboards on legs, set back from the barriers where the view is open
  const billboards = [];
  {
    const legMat = new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.6, roughness: 0.5 });
    const backMat = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.8 });
    const legGeo = new THREE.BoxGeometry(0.35, 1, 0.35); legGeo.translate(0, 0.5, 0);
    const want = mobile ? 6 : 9;
    for (let k = 0, placed = 0; k < 160 && placed < want; k++) {
      const s = ((k * 0.618034) % 1) * C.length;
      if (Math.abs(C.curvature(s)) > 0.004 || C.pitBlend(s) > 0) continue;
      if (billboards.some((b) => Math.min(Math.abs(b.s - s), C.length - Math.abs(b.s - s)) < C.length / (want * 1.6))) continue;
      const big = placed < 2; // the first two show the Pixel Wall
      const W = big ? 18 : 15, H = big ? 9 : 5, up = big ? 3.5 : 3;
      let side = 0;
      for (const sd of [-pin, pin]) {
        const p = C.at(s), off = sd * (TRACK_W / 2 + 26);
        if (bends.some((b) => s > b.from - 40 && s < b.to + 40 && -b.sign === sd)) continue;
        if (clearOf(p.x + p.nx * off, p.z + p.nz * off, s, 40)) { side = sd; break; }
      }
      if (!side) continue;
      const p = C.at(s), off = side * (TRACK_W / 2 + 26);
      const g = new THREE.Group();
      g.position.set(p.x + p.nx * off, 0, p.z + p.nz * off);
      g.lookAt(p.x - p.tx * 60, 0, p.z - p.tz * 60); // angled a little towards oncoming cars
      const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: brandMats[placed % brandMats.length].map, roughness: 0.55, emissive: 0xffffff, emissiveIntensity: 0.08 }));
      face.position.set(0, up + H / 2, 0.16);
      const back = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, H + 0.6, 0.3), backMat);
      back.position.set(0, up + H / 2, 0); back.castShadow = true;
      g.add(face, back);
      for (const lx of [-W / 3, W / 3]) { const leg = new THREE.Mesh(legGeo, legMat); leg.scale.y = up; leg.position.x = lx; leg.castShadow = true; g.add(leg); }
      if (big) {
        const cap = new THREE.Mesh(new THREE.PlaneGeometry(W, 1.3), new THREE.MeshStandardMaterial({ map: sponsorTex('PIXEL WALL', 'wall.hammi.ca', '#141821', '#ffcf3f', 512, 40), roughness: 0.6 }));
        cap.position.set(0, up - 0.35, 0.16); g.add(cap);
      }
      scene.add(g);
      billboards.push({ s, face, big, n: placed++ });
    }
  }
  function wallTexture(w) {
    const bytes = Uint8Array.from(atob(w.data), (c) => c.charCodeAt(0));
    const rgb = w.palette.map((h) => { const n = parseInt(String(h).replace('#', ''), 16) || 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; });
    const px = new Uint8Array(w.w * w.h * 4);
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
      const c = rgb[bytes[y * w.w + x]] || [0, 0, 0], o = ((w.h - 1 - y) * w.w + x) * 4; // texture rows run bottom up
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
    const t = new THREE.DataTexture(px, w.w, w.h, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  }
  const madeTex = [];
  function applyTrackside(d) {
    if (!d) return;
    for (const t of madeTex.splice(0)) t.dispose();
    const keep = (t) => { madeTex.push(t); return t; };
    if (d.wall && d.wall.w && d.wall.h) {
      try { const t = keep(wallTexture(d.wall)); for (const b of billboards) if (b.big) { b.face.material.map = t; b.face.material.needsUpdate = true; } } catch { /* keep the old picture */ }
    }
    // names: Velora teams first, then the top painters on the wall
    const names = [...(d.teams || []).map((n) => [n, 'VELORA TEAM']), ...(d.painters || []).map((n) => [n, 'PIXEL WALL PAINTER'])].slice(0, 16);
    if (!names.length) return;
    const mats = names.map(([n, sub], k) => { const [bg, fg] = SPONSOR_COLS[k % SPONSOR_COLS.length]; return new THREE.MeshStandardMaterial({ map: keep(sponsorTex(String(n).toUpperCase(), sub, bg, fg)), roughness: 0.6 }); });
    // every third barrier board, and the smaller billboards in turn
    for (const b of boards) b.m.material = b.i % 3 === 1 ? mats[Math.floor(b.i / 3) % mats.length] : brandMats[b.i % brandMats.length];
    for (const b of billboards) if (!b.big && b.n % 2 === 1) { b.face.material.map = mats[b.n % mats.length].map; b.face.material.needsUpdate = true; }
  }
  if (window.__testHooks) window.__testHooks.C = C;
  if (window.__testHooks) window.__testHooks.billboards = billboards.map((b) => { const v = new THREE.Vector3(); b.face.getWorldPosition(v); return { big: b.big, x: v.x, y: v.y, z: v.z }; });
  const loadTrackside = () => fetch('/api/trackside').then((r) => (r.ok ? r.json() : null)).then(applyTrackside).catch(() => {});
  loadTrackside();
  const tracksideTimer = setInterval(loadTrackside, 10 * 60 * 1000);

  // floodlight towers (they matter at night)
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x8a9099, metalness: 0.6, roughness: 0.4 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xfff4e0, emissiveIntensity: 0 });
  const towerGeo = new THREE.CylinderGeometry(0.25, 0.4, 18, 8); towerGeo.translate(0, 9, 0);
  const lampGeo = new THREE.BoxGeometry(2.2, 1, 0.6); lampGeo.translate(0, 18.3, 0);
  const lamps = [];
  for (let s = 0; s < C.length; s += 110) {
    const p = C.at(s); const side = (Math.floor(s / 110) % 2 ? 1 : -1);
    if (side === pin && C.pitBlend(s) > 0) continue;
    const off = side * (TRACK_W / 2 + 7);
    const t = new THREE.Mesh(towerGeo, towerMat); t.position.set(p.x + p.nx * off, 0, p.z + p.nz * off); scene.add(t);
    const l = new THREE.Mesh(lampGeo, lampMat); l.position.copy(t.position); l.lookAt(p.x, 0, p.z); l.rotation.x = 0; scene.add(l);
    lamps.push(t.position.clone());
  }
  // light pools on the tarmac below each tower at night
  const poolMat = new THREE.MeshBasicMaterial({ map: glowTex(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffe6c0 });
  for (const lp of lamps) {
    const nearest = C.at(nearestS(lp.x, lp.z));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(46, 46), poolMat);
    m.rotation.x = -Math.PI / 2; m.position.set(nearest.x, 0.06, nearest.z); scene.add(m);
  }
  function nearestS(x, z) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < C.pts.length; i++) { const d = (C.pts[i][0] - x) ** 2 + (C.pts[i][1] - z) ** 2; if (d < bd) { bd = d; best = i; } }
    return best * C.step;
  }

  // trees, kept clear of the circuit
  {
    const [pineG, roundG] = treeGeometries();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    const bounds = C.pts.reduce((b, p) => [Math.min(b[0], p[0]), Math.max(b[1], p[0]), Math.min(b[2], p[1]), Math.max(b[3], p[1])], [1e9, -1e9, 1e9, -1e9]);
    const count = mobile ? 900 : 1800;
    const mats = [[], []];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
    let tries = 0;
    while (mats[0].length + mats[1].length < count && tries++ < count * 10) {
      const x = lerp(bounds[0] - 500, bounds[1] + 500, rand()), z = lerp(bounds[2] - 500, bounds[3] + 500, rand());
      let near = Infinity;
      for (let i = 0; i < C.pts.length; i += 2) { const d = (C.pts[i][0] - x) ** 2 + (C.pts[i][1] - z) ** 2; if (d < near) near = d; }
      near = Math.sqrt(near);
      if (near < 48) continue;
      // keep the main straight's buildings clear
      if (Math.hypot(x - p0.x, z - p0.z) < 220) continue;
      // denser woods further out, a few lone trees closer in
      if (near < 110 && rand() < 0.6) continue;
      const f = 0.8 + rand() * 0.7;
      sc.set(f, f * (0.85 + rand() * 0.4), f); q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * 6.28); ps.set(x, 0, z);
      m4.compose(ps, q, sc);
      mats[rand() < 0.45 ? 0 : 1].push(m4.clone());
    }
    [pineG, roundG].forEach((g, k) => {
      const inst = new THREE.InstancedMesh(g, mat, mats[k].length);
      mats[k].forEach((m, i) => inst.setMatrixAt(i, m));
      inst.castShadow = true; inst.receiveShadow = true;
      scene.add(inst);
    });
  }

  // rain
  const RAIN_N = mobile ? 2500 : 6000;
  const rainPos = new Float32Array(RAIN_N * 6);
  for (let i = 0; i < RAIN_N; i++) { const x = (rand() - 0.5) * 120, y = rand() * 50, z = (rand() - 0.5) * 120; rainPos.set([x, y, z, x + 0.05, y + 0.9, z], i * 6); }
  const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xaab8cc, transparent: true, opacity: 0, depthWrite: false }));
  rain.frustumCulled = false; scene.add(rain);

  // ---- cars ----
  const kit = buildCarKit();
  const carbonMat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.45, metalness: 0.3 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0e14, roughness: 0.04, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 });
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x18181a, roughness: 0.85 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x2c2f35, metalness: 0.9, roughness: 0.28 });
  const discMat = new THREE.MeshStandardMaterial({ color: 0x777b82, metalness: 0.8, roughness: 0.45, emissive: 0xff4a10, emissiveIntensity: 0 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf2ff, emissiveIntensity: 2.5 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a1a, emissiveIntensity: 1.2 });
  // headlight pool on the road: narrow and bright by the car (canvas bottom), wide and faint far ahead
  const beamTex = canvasTex(128, 256, (g, w, h) => {
    for (let y = 0; y < h; y++) {
      const t = 1 - y / h; // 0 at the car, 1 far away
      const half = w * (0.12 + 0.36 * Math.pow(t, 0.7));
      const a = Math.pow(1 - t, 1.6) * Math.min(1, t * 8);
      const grd = g.createLinearGradient(w / 2 - half, 0, w / 2 + half, 0);
      grd.addColorStop(0, 'rgba(255,248,230,0)'); grd.addColorStop(0.5, `rgba(255,248,230,${a})`); grd.addColorStop(1, 'rgba(255,248,230,0)');
      g.fillStyle = grd; g.fillRect(w / 2 - half, y, half * 2, 1);
    }
  }, { repeat: false });
  const beamMat = new THREE.MeshBasicMaterial({ map: beamTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const beamGeo = new THREE.PlaneGeometry(9, 28); beamGeo.rotateX(-Math.PI / 2); beamGeo.rotateY(-Math.PI / 2); beamGeo.translate(16, 0.07, 0);

  const cars = new Map();
  function makeCar(c) {
    const g = new THREE.Group();
    const body = new THREE.Group(); g.add(body);
    const paint = new THREE.MeshPhysicalMaterial({ map: liveryTexture(c.color), metalness: 0.05, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.12, envMapIntensity: 0.55 });
    const add = (geo, mat, parent = body) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
    add(kit.body, paint);
    add(kit.canopy, glassMat);
    const decalMat = new THREE.MeshStandardMaterial({ map: decalTexture(c.number, c.name, c.color), transparent: true, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -2 });
    for (const side of [1, -1]) {
      const d = new THREE.Mesh(kit.decal, decalMat);
      d.position.set(0.15, 0.36, side * 1.012); d.rotation.y = side > 0 ? 0 : Math.PI; body.add(d);
    }
    add(kit.fin, paint);
    add(kit.wing, carbonMat);
    add(kit.carbon, carbonMat);
    add(kit.mirrors, carbonMat);
    add(kit.hl, headMat).castShadow = false;
    add(kit.bar, tailMat).castShadow = false;
    const wheels = [];
    for (const [x, side] of [[CAR.WB_F, 1], [CAR.WB_F, -1], [CAR.WB_R, 1], [CAR.WB_R, -1]]) {
      const w = new THREE.Group(); w.position.set(x, CAR.TYRE_R, side * CAR.TRACK); g.add(w);
      const spin = new THREE.Group(); w.add(spin);
      add(kit.wheels.tyre, tyreMat, spin);
      const rim = add(kit.wheels.rim, rimMat, spin); if (side < 0) rim.rotation.y = Math.PI;
      const disc = add(kit.wheels.disc, discMat, w); disc.position.z = -side * 0.05;
      wheels.push({ w, spin, front: x > 0 });
    }
    const beam = new THREE.Mesh(beamGeo, beamMat); g.add(beam);
    // contact shadow so cars sit on the road even outside the sun's shadow range
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 2.6), new THREE.MeshBasicMaterial({ map: glowTex(), color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }));
    blob.rotation.x = -Math.PI / 2; blob.position.y = 0.06; g.add(blob);
    g.traverse((o) => { o.userData.carId = c.id; });
    scene.add(g);
    return { g, body, wheels, paint, key: c.color + c.number + c.name, s: null, lat: 0, dev: 0, devV: 0, latV: 0, yaw: 0, spin: 0, speed: 0, visible: true };
  }
  const SIDE_GAP = 3.2; // centre to centre when two cars run side by side
  const clampLat = (v, edge) => Math.max(-edge, Math.min(edge, v));
  // pushes each pair of cars within `reach` metres of each other at least SIDE_GAP apart on `key`;
  // when the track edge leaves no room and `hard` is set, the car behind is moved back instead
  function separate(list, key, reach, edge, fwd, racing, hard = false) {
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (!racing(a)) continue;
      for (let k = 1; k < Math.min(5, n); k++) {
        const b = list[(i + k) % n];
        const gap = fwd(a, b); // b is this far ahead of a
        if (gap > reach) break;
        if (!racing(b)) continue;
        const d = b[key] - a[key];
        const need = SIDE_GAP - Math.abs(d);
        if (need <= 0) continue;
        const dir = d > 0 || (d === 0 && (a.passSide || 1) < 0) ? 1 : -1; // b ends up on this side of a
        // the car behind gives most of the room, as it would in a real race
        a[key] = clampLat(a[key] - dir * need * 0.7, edge);
        b[key] = clampLat(b[key] + dir * need * 0.3, edge);
        const left = SIDE_GAP - Math.abs(b[key] - a[key]);
        if (left > 0.05) {
          const other = clampLat(b[key] - dir * SIDE_GAP, edge);
          if (Math.abs(other - b[key]) >= SIDE_GAP - 0.05) a[key] = other;
          else if (hard && gap < CAR.L + 0.6) a.s = (a.s - (CAR.L + 0.6 - gap) + C.length) % C.length;
        }
      }
    }
  }

  // ---- cameras ----
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 4; controls.maxDistance = 2600;
  controls.enabled = false;
  let mode = 'tv';
  const tvCams = [];
  for (let s = 0; s < C.length; s += 260) {
    const p = C.at(s); const k = C.curvature(s + 60); const side = k > 0 ? -1 : 1;
    const off = side * (TRACK_W / 2 + 22 + rand() * 18);
    tvCams.push({ s, pos: new THREE.Vector3(p.x + p.nx * off, 5 + rand() * 9, p.z + p.nz * off) });
  }
  let tvIdx = -1;
  const orbitLast = new THREE.Vector3();
  let chaseYaw = null;
  const camPos = new THREE.Vector3(0, 400, 600), camLook = new THREE.Vector3(), lookTmp = new THREE.Vector3();
  camera.position.copy(camPos);
  function setMode(m) {
    mode = m;
    controls.enabled = m === 'orbit';
    if (m === 'orbit') {
      const sel = cars.get(getSelected());
      const t = sel ? sel.g.position : new THREE.Vector3();
      controls.target.copy(t);
      const yaw = sel ? sel.g.rotation.y : 0;
      camera.position.set(t.x + Math.cos(yaw + 0.9) * 8, 2.6, t.z - Math.sin(yaw + 0.9) * 8);
      camera.fov = 40; camera.updateProjectionMatrix();
      orbitLast.copy(t);
    }
  }

  // ---- composer ----
  const size = new THREE.Vector2();
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: mobile ? 2 : 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.25, 0.5, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.getSize(size);
    if (size.x === w && size.y === h) return;
    renderer.setSize(w, h, false); composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  // ---- environment that follows the clock ----
  let lastSunKey = null;
  const sunDir = new THREE.Vector3();
  function updateSky(clock, wet, rainAmt) {
    const h = clock / 3600;
    // sunrise ~6:00, sunset ~21:00, highest at 13:30
    let elev = h >= 6 && h <= 21 ? 58 * Math.sin(Math.PI * (h - 6) / 15) : -14 - 10 * Math.sin(Math.PI * ((h + 3) % 24) / 9);
    const az = 90 + (h - 6) / 15 * 180;
    const phi = THREE.MathUtils.degToRad(90 - elev), theta = THREE.MathUtils.degToRad(az);
    sunDir.setFromSphericalCoords(1, phi, theta);
    const day = smooth((elev + 4) / 14);
    const overcast = Math.min(1, rainAmt * 1.4 + wet * 0.3);
    su.sunPosition.value.copy(sunDir);
    su.turbidity.value = 2.5 + overcast * 14; su.rayleigh.value = lerp(2.2, 0.6, overcast);
    renderer.toneMappingExposure = lerp(0.55, 0.95, day) * lerp(1, 0.75, overcast);
    const lightDir = elev > 0 ? sunDir : sunDir.clone().set(-sunDir.x, 0.6, -sunDir.z).normalize(); // moonlight when the sun is down
    sun.userData.dir = lightDir;
    sun.intensity = elev > 0 ? lerp(0.6, 3.2, smooth(elev / 25)) * (1 - overcast * 0.75) : 0.6;
    sun.color.set(elev > 0 ? (elev < 12 ? 0xffc98f : 0xfff1dc) : 0x9fb5ff);
    hemi.intensity = lerp(0.2, 0.5, day) * (1 - overcast * 0.2);
    hemi.color.set(day > 0.5 ? 0xcfe3ff : 0x5d6f99);
    stars.material.opacity = (1 - day) * (1 - overcast);
    scene.fog.color.set(day > 0.3 ? (overcast > 0.3 ? 0x8f99a6 : 0xa9bfd9) : 0x0d1220).lerp(new THREE.Color(0x0d1220), 1 - day);
    scene.fog.near = lerp(700, 150, overcast); scene.fog.far = lerp(5200, 1300, overcast);
    const night = 1 - day;
    lampMat.emissiveIntensity = night * 4;
    poolMat.opacity = night * 0.45;
    beamMat.opacity = night * 0.75;
    headMat.emissiveIntensity = 1.5 + night * 4;
    tailMat.emissiveIntensity = 1 + night * 2.5 + overcast * 1.5;
    bloom.strength = 0.18 + night * 0.7;
    // wet tarmac is darker and shinier
    trackMat.roughness = lerp(0.82, 0.18, wet); trackMat.color.setScalar(lerp(1, 0.55, wet)); trackMat.metalness = lerp(0, 0.25, wet);
    rain.material.opacity = Math.min(0.55, rainAmt * 0.8);
    // re-render the sky into the environment map when the light changes noticeably
    const key = Math.round(elev / 2) + ':' + Math.round(overcast * 5);
    if (key !== lastSunKey) {
      lastSunKey = key;
      const cu = skyClone.material.uniforms;
      for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) cu[k].value = su[k].value;
      cu.sunPosition.value.copy(sunDir);
      if (envRT) envRT.dispose();
      envRT = pmrem.fromScene(skyScene);
      scene.environment = envRT.texture;
      scene.environmentIntensity = lerp(0.08, 0.35, day);
    }
  }

  // ---- per-frame update ----
  const tmp = {};
  const clock = new THREE.Clock();
  let raf = 0;
  let idleT = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    resize();
    const realDt = Math.min(1, clock.getDelta());
    const dt = Math.min(0.1, realDt);
    const snap = getSnap();
    const scale = getScale();
    if (snap) {
      const o = window.__sky; // testing hook: { clock, wet, rain }
      updateSky(o ? o.clock : snap.clock, o ? o.wet : snap.wet, o ? o.rain : snap.rain);
      // playback runs a little behind the newest snapshot, so a late update never makes cars stop
      const wall = performance.now() / 1000 * scale;
      if (!buffer.length || buffer[buffer.length - 1].t !== snap.t) {
        pushSnap(snap);
        // a smoothed estimate of server race time, so network jitter and the 0.5 s update steps
        // don't make the playback clock speed up and slow down
        const sample = snap.t - wall;
        clockOffset = clockOffset === null || Math.abs(sample - clockOffset) > 20 * scale ? sample : clockOffset + (sample - clockOffset) * 0.08;
      }
      const target = wall + clockOffset - DELAY * scale;
      if (playT === null || Math.abs(target - playT) > 20 * scale) playT = target;
      playT += realDt * scale;
      playT += (target - playT) * Math.min(1, realDt * 0.3); // drift gently back to the target delay
      const live = new Set();
      const sorted = [];
      for (const c of snap.cars) {
        live.add(c.id);
        let car = cars.get(c.id);
        if (car && car.key !== c.color + c.number + c.name) { scene.remove(car.g); car = null; }
        if (!car) { car = makeCar(c); cars.set(c.id, car); }
        car.data = c;
        car.g.visible = c.state !== 'retired';
        // where the car is at the playback time, from the buffered snapshots
        const d = distanceAt(c.id, playT);
        if (d !== null) car.s = ((d % C.length) + C.length) % C.length;
        else if (car.s === null) car.s = ((c.s % C.length) + C.length) % C.length;
        car.speed = c.state === 'stopped' || c.state === 'garage' ? 0 : c.v;
        // speed as it looks on screen, for the engine sound
        if (car.prevS !== undefined && dt > 0) {
          let ds = car.s - car.prevS; if (ds < -C.length / 2) ds += C.length; if (ds > C.length / 2) ds -= C.length;
          const v = Math.max(0, Math.min(110, ds / dt));
          const prevV = car.visSpeed || 0;
          car.visSpeed = prevV + (v - prevV) * Math.min(1, dt * 8);
          car.visAccel = (car.visAccel || 0) + (((car.visSpeed - prevV) / dt) - (car.visAccel || 0)) * Math.min(1, dt * 6);
          car.visLat = Math.abs(C.curvature(car.s)) * car.visSpeed * car.visSpeed;
        }
        car.prevS = car.s;
        if (c.state === 'stopped' && car.prevState === 'pitlane') audio.hit('pitgun', car.audioDist);
        car.prevState = c.state;
        sorted.push(car);
      }
      for (const [id, car] of cars) if (!live.has(id)) { scene.remove(car.g); cars.delete(id); }
      // lateral placement: every car follows the racing line, single file, and only leaves it to
      // overtake (while the race says it's passing) or to keep clear of a car alongside
      sorted.sort((a, b) => a.s - b.s);
      const n = sorted.length;
      const fwd = (a, b) => { let g = b.s - a.s; if (g < 0) g += C.length; return g; }; // metres b is ahead of a
      const racing = (car) => car.g.visible && (car.data.state === 'track' || car.data.state === 'finished' || (car.data.state === 'pitlane' && C.pitBlend(car.s) < 0.5));
      const edge = TRACK_W / 2 - 1.4;
      const byId = new Map(sorted.map((c) => [c.data.id, c]));
      for (const car of sorted) {
        car.base = C.lineAt(car.s);
        let want = car.base;
        const o = car.data.pass && byId.get(car.data.pass);
        if (o && racing(o) && fwd(o, car) < 12 && fwd(car, o) < 40) {
          // pick the inside of the next corner once, and keep it for the whole move
          if (car.passWith !== o.data.id) { car.passWith = o.data.id; const k = C.curvature(car.s + 90); car.passSide = Math.abs(k) > 0.002 ? Math.sign(k) : (car.base > o.lat ? 1 : -1); }
          want = o.lat + car.passSide * SIDE_GAP;
        } else car.passWith = null;
        car.want = clampLat(want, edge);
      }
      // keep wanted lanes apart for cars that are, or are about to be, alongside
      for (let it = 0; it < 3; it++) separate(sorted, 'want', CAR.L + 8, edge, fwd, racing);
      const w0 = 1.8; // steering response, rad/s: critically damped, so no overshoot or weave
      for (const car of sorted) {
        const pb = car.data.state === 'track' || car.data.state === 'finished' ? 0 : C.pitBlend(car.s);
        // the line itself is followed exactly; only the step off it is smoothed
        const acc = THREE.MathUtils.clamp(w0 * w0 * (car.want - car.base - car.dev) - 2 * w0 * car.devV, -7, 7);
        car.devV = THREE.MathUtils.clamp(car.devV + acc * dt, -4, 4);
        car.dev += car.devV * dt;
        const onTrack = car.base + car.dev;
        car.lat = lerp(onTrack, pin * PIT_OFF, pb);
        const vs = Math.max(car.visSpeed || car.speed || 0, 5);
        // sideways metres per metre travelled, for the car's heading
        car.slope = pb > 0 && pb < 1 ? (C.pitBlend(car.s + 2) - C.pitBlend(car.s - 2)) / 4 * (pin * PIT_OFF - onTrack) + (1 - pb) * (C.lineSlope(car.s) + car.devV / vs) : pb >= 1 ? 0 : C.lineSlope(car.s) + car.devV / vs;
      }
      // last word: cars that would still touch are pushed apart sideways, or the one behind drops back
      for (let it = 0; it < 3; it++) separate(sorted, 'lat', CAR.L + 0.6, edge, fwd, racing, true);
      for (const car of sorted) if (car.data.state === 'track' || car.data.state === 'finished') car.dev = car.lat - car.base; // keep pushes, without a jump back
      if (window.__probe) window.__probe(sorted, { fwd, racing, L: CAR.L }); // testing hook
      for (const car of cars.values()) {
        const p = C.at(car.s, tmp);
        const x = p.x + p.nx * car.lat, z = p.z + p.nz * car.lat;
        car.g.position.set(x, 0, z);
        // point the car along its own path; ease the heading so a snapshot step never twitches it
        const yaw = Math.atan2(-p.tz, p.tx) - Math.atan(THREE.MathUtils.clamp(car.slope || 0, -0.5, 0.5));
        let dy = yaw - car.g.rotation.y; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
        car.g.rotation.y += dy * Math.min(1, dt * 12);
        // lean and squat a touch with cornering
        const lat = C.curvature(car.s) * car.speed * car.speed;
        car.body.rotation.x = THREE.MathUtils.clamp(-lat * 0.004, -0.03, 0.03);
        car.body.rotation.z = THREE.MathUtils.clamp((car.visAccel || 0) * 0.0015, -0.022, 0.012); // nose dips under braking, squats on the power
        car.spin -= car.speed * dt / CAR.TYRE_R;
        for (const w of car.wheels) { w.spin.rotation.z = car.spin; if (w.front) w.w.rotation.y = THREE.MathUtils.clamp(C.curvature(car.s + 6) * 2.7, -0.3, 0.3); }
      }
      updateCamera(dt);
      if (window.__cam) { camera.position.set(...window.__cam.pos); camera.lookAt(...window.__cam.at); } // testing hook
      updateLabels();
      audio.update(dt, { camera, cars, selected: getSelected(), mode, snap });
    } else {
      // between races: a slow fly-around of the empty circuit at 3 pm
      updateSky(15 * 3600, 0, 0);
      idleT += dt * 0.03;
      camera.position.set(Math.cos(idleT) * 900, 320, Math.sin(idleT) * 900);
      camLook.set(0, 0, 0); camera.fov = 45; camera.updateProjectionMatrix(); camera.lookAt(camLook);
      for (const car of cars.values()) scene.remove(car.g);
      cars.clear();
      audio.update(dt, { camera, cars, selected: null, mode, snap: null });
    }
    // rain follows the camera
    if (rain.material.opacity > 0) {
      const a = rain.geometry.getAttribute('position');
      for (let i = 0; i < RAIN_N; i++) {
        let y = a.array[i * 6 + 1] - 40 * dt;
        if (y < 0) y += 50;
        a.array[i * 6 + 1] = y; a.array[i * 6 + 4] = y + 0.9;
      }
      a.needsUpdate = true;
      rain.position.set(camera.position.x, 0, camera.position.z);
    }
    // the sun's shadow box follows what the camera is looking at
    const dir = sun.userData.dir || sunDir;
    sun.target.position.copy(camLook);
    sun.position.copy(camLook).addScaledVector(dir, 300);
    composer.render(dt);
  }

  // ---- snapshot buffer for smooth playback ----
  const DELAY = 2.2; // seconds of race time the view stays behind the server
  const buffer = []; // [{ t, cars: Map(id -> { d, v }) }] oldest first
  let playT = null;
  let clockOffset = null;
  function pushSnap(snap) {
    if (buffer.length && snap.t < buffer[buffer.length - 1].t) buffer.length = 0; // a new race
    const m = new Map();
    for (const c of snap.cars) m.set(c.id, { d: c.lap * C.length + c.s, v: c.state === 'stopped' || c.state === 'garage' ? 0 : c.v });
    buffer.push({ t: snap.t, cars: m });
    while (buffer.length > 12) buffer.shift();
  }
  function distanceAt(id, t) {
    let a = null, b = null;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].t <= t) { a = buffer[i]; b = buffer[i + 1] || null; break; }
    }
    if (!a) { const f = buffer[0]; const c = f && f.cars.get(id); return c ? c.d + c.v * Math.max(-6, t - f.t) : null; }
    const ca = a.cars.get(id);
    if (!ca) return null;
    if (!b || !b.cars.get(id)) return ca.d + ca.v * Math.min(6, t - a.t); // past the newest: keep rolling at its speed
    const cb = b.cars.get(id);
    const span = b.t - a.t || 1, k = (t - a.t) / span;
    if (Math.abs(cb.d - ca.d) > 400) return k < 0.5 ? ca.d : cb.d; // a jump (spin, pit stop): don't slide through it
    // cubic Hermite with speeds taken from the positions either side (Catmull-Rom), so speed
    // flows smoothly from one update to the next instead of pulsing with each snapshot
    const ia = buffer.indexOf(a);
    const slope = (i, ci) => {
      const p = buffer[i - 1], n = buffer[i + 1];
      const cp = p && p.cars.get(id), cn = n && n.cars.get(id);
      if (cp && cn && Math.abs(cn.d - cp.d) < 800) return (cn.d - cp.d) / (n.t - p.t || 1);
      return null;
    };
    const avg = (cb.d - ca.d) / span;
    let va = slope(ia, ca), vb = slope(ia + 1, cb);
    if (va === null) va = avg;
    if (vb === null) vb = avg;
    const k2 = k * k, k3 = k2 * k;
    return (2 * k3 - 3 * k2 + 1) * ca.d + (k3 - 2 * k2 + k) * va * span + (-2 * k3 + 3 * k2) * cb.d + (k3 - k2) * vb * span;
  }
  function noteSnap() { const s = getSnap(); if (s) pushSnap(s); }

  function updateCamera(dt) {
    const sel = cars.get(getSelected()) || cars.values().next().value;
    if (!sel) return;
    const p = sel.g.position;
    const fwd = lookTmp.set(Math.cos(sel.g.rotation.y), 0, -Math.sin(sel.g.rotation.y));
    if (mode === 'orbit') {
      camera.position.add(lookTmp.copy(p).sub(orbitLast)); orbitLast.copy(p);
      controls.target.copy(p); controls.update(); camLook.copy(p); return;
    }
    let wantPos, wantLook = p.clone().setY(0.8);
    if (mode === 'chase') {
      // follow a smoothed heading so the camera swings gently round corners but never falls behind
      const yaw = sel.g.rotation.y;
      if (chaseYaw === null) chaseYaw = yaw;
      let dy = yaw - chaseYaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
      chaseYaw += dy * Math.min(1, dt * 3);
      const cf = new THREE.Vector3(Math.cos(chaseYaw), 0, -Math.sin(chaseYaw));
      camera.position.copy(p).addScaledVector(cf, -10).setY(3.1);
      wantLook = p.clone().addScaledVector(cf, 9).setY(1.1);
      camera.fov = 55;
      camLook.copy(wantLook);
    } else if (mode === 'onboard') {
      wantPos = p.clone().addScaledVector(fwd, -0.35).setY(1.12);
      wantLook = p.clone().addScaledVector(fwd, 30).setY(0.9);
      camera.position.copy(wantPos); camera.fov = 70;
    } else if (mode === 'heli') {
      wantPos = p.clone().addScaledVector(fwd, -60).setY(70);
      camPos.lerp(wantPos, Math.min(1, dt * 1.5)); camera.position.copy(camPos);
      camera.fov = lerp(camera.fov, 38, dt * 2);
    } else { // tv: nearest trackside camera with a long lens
      let best = 0, bd = Infinity;
      for (let i = 0; i < tvCams.length; i++) { const d = tvCams[i].pos.distanceToSquared(p); if (d < bd) { bd = d; best = i; } }
      if (best !== tvIdx) { tvIdx = best; camPos.copy(tvCams[best].pos); }
      camera.position.copy(camPos);
      const dist = camPos.distanceTo(p);
      camera.fov = THREE.MathUtils.clamp(2 * THREE.MathUtils.radToDeg(Math.atan(9 / dist)), 6, 60);
    }
    camLook.lerp(wantLook, mode === 'onboard' ? 1 : Math.min(1, dt * 6));
    camera.lookAt(camLook);
    camera.updateProjectionMatrix();
  }

  // ---- name tags over nearby cars ----
  const tagEls = new Map();
  const v3 = new THREE.Vector3();
  function updateLabels() {
    if (!labels) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const seen = new Set();
    const placed = []; // screen spots already labelled, so tags in a bunch don't pile on top of each other
    const sel = getSelected();
    const order = [...cars].sort((a, b) => (a[0] === sel ? -1 : b[0] === sel ? 1 : (a[1].data.pos || 99) - (b[1].data.pos || 99)));
    for (const [id, car] of order) {
      if (!car.g.visible) continue;
      v3.copy(car.g.position).setY(1.9).project(camera);
      const d = car.g.position.distanceTo(camera.position);
      let show = v3.z < 1 && Math.abs(v3.x) < 1.05 && Math.abs(v3.y) < 1.05 && (d < 260 || id === sel) && mode !== 'onboard';
      if (show) {
        const sx = ((v3.x + 1) / 2) * w, sy = ((1 - v3.y) / 2) * h;
        if (placed.some(([x, y]) => Math.abs(x - sx) < 130 && Math.abs(y - sy) < 22)) show = false;
        else placed.push([sx, sy]);
      }
      if (!show) continue;
      seen.add(id);
      let el = tagEls.get(id);
      if (!el) {
        el = document.createElement('div'); el.className = 'tag3d';
        for (const cls of ['p', 'n', 't']) { const s = document.createElement('span'); s.className = cls; el.append(s); }
        labels.append(el); tagEls.set(id, el); el.addEventListener('click', () => onSelect(id));
      }
      const [pe, ne, te] = el.children;
      const pos = String(car.data.pos || ''), num = String(car.data.number), name = car.data.name.toUpperCase();
      if (pe.textContent !== pos) pe.textContent = pos;
      if (ne.textContent !== num) ne.textContent = num;
      if (te.textContent !== name) te.textContent = name;
      if (el.dataset.c !== car.data.color) {
        el.dataset.c = car.data.color;
        const n = parseInt(car.data.color.slice(1), 16);
        el.style.setProperty('--c', car.data.color);
        el.style.setProperty('--tc', 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 140 ? '#111' : '#fff');
      }
      el.classList.toggle('sel', id === getSelected());
      el.style.transform = `translate(${((v3.x + 1) / 2) * w}px, ${((1 - v3.y) / 2) * h}px) translate(-50%, -100%)`;
    }
    for (const [id, el] of tagEls) if (!seen.has(id)) { el.remove(); tagEls.delete(id); }
  }

  // click a car to select it
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
    const r = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects([...cars.values()].map((c) => c.g), true)[0];
    if (hit && hit.object.userData.carId) onSelect(hit.object.userData.carId);
  });

  frame();
  const sound = {
    get on() { return audio.on; },
    setOn: (v) => audio.setOn(v),
    duck: (v) => audio.duck(v),
    hit(kind, id) { const car = id && cars.get(id); if (car && car.g.visible) audio.hit(kind, car.g.position.distanceTo(camera.position)); },
  };
  return { setMode, noteSnap, sound, _debug: { camera, cars, C, scene, buffer, get playT() { return playT; } }, get mode() { return mode; }, dispose() { cancelAnimationFrame(raf); clearInterval(tracksideTimer); renderer.dispose(); } };
}

window.Race3D = { createView };
