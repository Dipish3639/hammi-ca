/* hammi.ca PCB: 3D preview with three.js (loaded only when the 3D tab opens). */
(function (P) {
  'use strict';
  const M = P.model;
  const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  let loading = null, T = null, ren = null, scene = null, cam = null, root = null, host = null, raf = 0, dirty = true;
  const orbit = { th: -0.6, ph: 0.85, r: 90, tx: 0, ty: 0, tz: 0 };

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (!loading) loading = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = THREE_URL; s.crossOrigin = 'anonymous';
      s.onload = () => window.THREE ? res(window.THREE) : rej(new Error('three.js missing'));
      s.onerror = () => { loading = null; rej(new Error('could not load three.js')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  /* resistor colour bands from the value text */
  function bands(v) {
    const m = String(v).trim().toLowerCase().replace(/ω|ohm/g, '').match(/^(\d+(?:\.\d+)?)([rkm]?)(\d*)$/);
    if (!m) return null;
    let n = parseFloat(m[1] + (m[3] ? '.' + m[3] : '')); n *= m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1;
    if (!(n >= 1)) return null;
    let e = Math.floor(Math.log10(n)) - 1; const d = Math.round(n / Math.pow(10, e));
    const col = ['#111', '#7a4a21', '#c41e1e', '#e8761c', '#e9d21c', '#2f9b3c', '#2554c7', '#7a3ec9', '#888', '#eee'];
    const d1 = Math.floor(d / 10) % 10, d2 = d % 10;
    return [col[d1], col[d2], e >= 0 ? col[Math.min(9, e)] : '#c9a227', '#c9a227'];
  }
  const LEDC = { red: '#ff2a1a', green: '#22e05a', blue: '#2a6bff', yellow: '#ffd21a', white: '#f4f4ff', orange: '#ff7a1a', amber: '#ffb01a', pink: '#ff5ab0', uv: '#8a3cff' };

  function build(pr) {
    const THREE = T, b = pr.board, R = pr.rules, th = b.thick || 1.6;
    if (root) { scene.remove(root); root.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
    root = new THREE.Group(); scene.add(root);
    const info = M.boardPads(pr);
    const ppm = Math.max(8, Math.min(24, Math.floor(2400 / Math.max(b.w, b.h))));
    const tex = s => { const t = new THREE.CanvasTexture(P.draw.renderReal(pr, s, ppm, info)); t.anisotropy = ren.capabilities.getMaxAnisotropy(); t.encoding = THREE.sRGBEncoding; return t; };
    const mask = (P.MASK[b.mask] || P.MASK.green)[0];
    // board as an extruded outline with holes so the edges look right
    const shape = new THREE.Shape(); const pts = P.geom.boardOutline(b, 10);
    pts.forEach(([x, y], i) => i ? shape.lineTo(x - b.w / 2, -(y - b.h / 2)) : shape.moveTo(x - b.w / 2, -(y - b.h / 2)));
    const holes = info.pads.filter(p => p.drill).map(p => [p.x, p.y, p.drill / 2]).concat(pr.vias.map(v => [v.x, v.y, (v.drill || R.viaDrill) / 2]), info.holes.map(h => [h.x, h.y, h.d / 2]));
    if (holes.length < 400) for (const [x, y, r] of holes) { const h = new THREE.Path(); h.absarc(x - b.w / 2, -(y - b.h / 2), r, 0, Math.PI * 2, true); shape.holes.push(h); }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false, curveSegments: 10 });
    geo.rotateX(-Math.PI / 2); // extrude goes up
    // UVs for top and bottom faces from x/z
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + b.w / 2) / b.w, 1 - (pos.getZ(i) + b.h / 2) / b.h);
    // groups: ExtrudeGeometry puts caps in group 0, sides in group 1; split caps by normal using two materials
    const topM = new THREE.MeshStandardMaterial({ map: tex('top'), roughness: .55, metalness: .05, transparent: true, alphaTest: .5 });
    const botTex = tex('bottom'); botTex.wrapS = THREE.RepeatWrapping; botTex.repeat.x = -1; botTex.offset.x = 1;
    const botM = new THREE.MeshStandardMaterial({ map: botTex, roughness: .55, metalness: .05, transparent: true, alphaTest: .5 });
    const sideM = new THREE.MeshStandardMaterial({ color: '#c9b98c', roughness: .85 });
    const g2 = geo.index ? geo.toNonIndexed() : geo;
    const n = g2.attributes.normal; g2.clearGroups();
    let start = 0, curMat = -1;
    for (let f = 0; f < n.count / 3; f++) {
      const ny = n.getY(f * 3), mat = ny > .9 ? 0 : ny < -.9 ? 1 : 2;
      if (mat !== curMat) { if (curMat >= 0) g2.addGroup(start, f * 3 - start, curMat); start = f * 3; curMat = mat; }
    }
    g2.addGroup(start, n.count - start, curMat);
    const board = new THREE.Mesh(g2, [topM, botM, sideM]); board.position.y = -th; root.add(board);
    // plated barrels
    const barrel = new THREE.MeshStandardMaterial({ color: b.finish === 'enig' ? '#d8b24c' : '#c8c8c4', metalness: .9, roughness: .3, side: THREE.DoubleSide });
    for (const p of info.pads) if (p.drill) { const c = new THREE.Mesh(new THREE.CylinderGeometry(p.drill / 2, p.drill / 2, th, 14, 1, true), barrel); c.position.set(p.x - b.w / 2, -th / 2, p.y - b.h / 2); root.add(c); }

    const mat = (c, o) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: .5, metalness: 0 }, o || {}));
    const metal = mat('#d6d6d2', { metalness: .9, roughness: .28 }), gold = mat('#e0b54a', { metalness: .9, roughness: .3 }), blk = mat('#1a1a1a', { roughness: .6 });
    const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    const cyl = (r, h, m, seg) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg || 20), m);

    for (const part of pr.parts) {
      const f = M.footprintOf(part); if (!f || !f.body) continue;
      const B = f.body, g = new THREE.Group(), pads = f.pads;
      const lead = (x0, z0, x1, z1, top, r) => { // a bent wire from pad up to the body
        const a = cyl(r || .3, top, metal, 8); a.position.set(x0, top / 2, z0); g.add(a);
        if (x1 !== x0 || z1 !== z0) { const L = Math.hypot(x1 - x0, z1 - z0), h = cyl(r || .3, L, metal, 8); h.rotation.z = Math.PI / 2; h.rotation.y = -Math.atan2(z1 - z0, x1 - x0); h.position.set((x0 + x1) / 2, top, (z0 + z1) / 2); g.add(h); }
      };
      switch (B.kind) {
        case 'axial': {
          const y = B.d / 2 + .6, body = cyl(B.d / 2, B.l, mat(B.color, { roughness: .6 }), 24); body.rotation.z = Math.PI / 2; body.position.y = y; g.add(body);
          const bc = part.type === 'R' ? bands(part.value) : null;
          if (bc) bc.forEach((c, i) => { const r = cyl(B.d / 2 + .03, .45, mat(c), 24); r.rotation.z = Math.PI / 2; r.position.set(-B.l / 2 + .9 + i * (i === 3 ? 1.3 : 1.0), y, 0); g.add(r); });
          if (B.band) { const r = cyl(B.d / 2 + .03, .5, mat(B.color === '#222' ? '#ccc' : '#111'), 24); r.rotation.z = Math.PI / 2; r.position.set(-B.l / 2 + .7, y, 0); g.add(r); }
          lead(pads[0].x, 0, -B.l / 2, 0, y, .25); lead(pads[1].x, 0, B.l / 2, 0, y, .25);
          break;
        }
        case 'chip': {
          const body = box(B.l * .8, B.h, B.w, mat(B.color)); body.position.y = B.h / 2; g.add(body);
          if (part.type === 'R' || part.type === 'C') for (const s of [-1, 1]) { const e = box(B.l * .1, B.h, B.w, metal); e.position.set(s * B.l * .45, B.h / 2, 0); g.add(e); }
          if (part.type === 'LED') { const l = box(B.l * .35, .12, B.w * .5, mat(LEDC[String(part.value).toLowerCase()] || '#ffd21a', { emissive: LEDC[String(part.value).toLowerCase()] || '#ffd21a', emissiveIntensity: .25 })); l.position.y = B.h + .06; g.add(l); }
          if (part.type === 'D' || part.type === 'LED') { const s = box(B.l * .12, .02, B.w, mat('#ddd')); s.position.set(-B.l * .3, B.h + .01, 0); g.add(s); }
          if (part.type === 'QN' || part.type === 'QP') for (const p of pads) { const l = box(.4, .2, .7, metal); l.position.set(p.x, .1, p.y * .75); g.add(l); }
          break;
        }
        case 'disc': { const d = cyl(2.5, 2.2, mat(B.color, { roughness: .7 }), 24); d.rotation.x = Math.PI / 2; d.position.y = 4.2; g.add(d); lead(pads[0].x, 0, -1, 0, 2.2, .25); lead(pads[1].x, 0, 1, 0, 2.2, .25); break; }
        case 'can': {
          const c = cyl(B.d / 2, B.h, mat(B.color, { roughness: .35, metalness: .3 }), 32); c.position.y = B.h / 2 + .3; g.add(c);
          const top = cyl(B.d / 2 - .25, .1, metal, 32); top.position.y = B.h + .32; g.add(top);
          const stripe = new THREE.Mesh(new THREE.CylinderGeometry(B.d / 2 + .02, B.d / 2 + .02, B.h * .96, 16, 1, true, Math.PI * .85, Math.PI * .3), mat(B.stripe)); stripe.position.y = B.h / 2 + .3; g.add(stripe);
          break;
        }
        case 'led': {
          const c = LEDC[String(part.value).toLowerCase()] || '#ff2a1a';
          const lm = mat(c, { transparent: true, opacity: .82, roughness: .15, emissive: c, emissiveIntensity: .2 });
          const r = B.d / 2, h = B.h - r, body = cyl(r, h, lm, 28); body.position.y = h / 2 + 1; g.add(body);
          const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), lm); dome.position.y = h + 1; g.add(dome);
          const fl = cyl(r + .4, .9, lm, 28); fl.position.y = 1.45; g.add(fl);
          lead(pads[0].x, 0, pads[0].x, 0, 1, .25); lead(pads[1].x, 0, pads[1].x, 0, 1, .25);
          break;
        }
        case 'to92': {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 4.6, 24, 1, false, Math.PI / 2, Math.PI), blk); m.position.set(0, 5.5, .2); g.add(m);
          const fl = box(4.8, 4.6, .02, blk); fl.position.set(0, 5.5, .2); g.add(fl);
          for (const p of pads) lead(p.x, 0, p.x * .5, .8, 3.2, .22);
          break;
        }
        case 'to220': {
          const bd = box(10, 9, 4.4, blk); bd.position.set(0, 7.5, .6); g.add(bd);
          const tab = box(10, 6.4, 1.3, metal); tab.position.set(0, 14.9, -.9); g.add(tab);
          const hl = cyl(1.8, 1.4, mat('#111'), 20); hl.rotation.x = Math.PI / 2; hl.position.set(0, 15.2, -.9); g.add(hl);
          for (const p of pads) { const l = box(.8, 3.2, .5, metal); l.position.set(p.x, 1.6, 0); g.add(l); }
          break;
        }
        case 'dip': case 'soic': {
          const smd = B.kind === 'soic', hgt = smd ? 1.5 : 3.3, w = smd ? 3.9 : 6.35, y0 = smd ? .15 : .6;
          const bd = box(w, hgt, B.l, mat('#1c1c1c', { roughness: .7 })); bd.position.y = y0 + hgt / 2; g.add(bd);
          const dot = cyl(.4, .05, mat('#333'), 16); dot.position.set(-w / 2 + 1, y0 + hgt + .03, -B.l / 2 + 1); g.add(dot);
          for (const p of pads) {
            if (smd) { const l = box(1.1, .25, .42, metal); l.position.set(p.x * .88, .4, p.y); g.add(l); }
            else { const l = box(.5, y0 + 1, .5, metal); l.position.set(p.x, (y0 + 1) / 2, p.y); g.add(l); const s = box(Math.abs(p.x) - w / 2 + .2, .3, .5, metal); s.position.set(Math.sign(p.x) * (w / 2 + (Math.abs(p.x) - w / 2) / 2), y0 + 1.2, p.y); g.add(s); }
          }
          // print the chip name on top
          const cvs = document.createElement('canvas'); cvs.width = 256; cvs.height = Math.round(256 * B.l / w);
          const cx = cvs.getContext('2d'); cx.fillStyle = '#1c1c1c'; cx.fillRect(0, 0, cvs.width, cvs.height); cx.fillStyle = '#9a9a96';
          cx.translate(cvs.width / 2, cvs.height / 2); cx.rotate(-Math.PI / 2); cx.font = '500 ' + Math.round(cvs.width * .2) + 'px Inter, sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
          cx.fillText(String(part.value).replace(/ generic/i, ''), 0, 0);
          const lbl = new THREE.Mesh(new THREE.PlaneGeometry(w * .9, B.l * .9), new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(cvs), roughness: .7 }));
          lbl.rotation.x = -Math.PI / 2; lbl.position.y = y0 + hgt + .01; g.add(lbl);
          break;
        }
        case 'header': {
          const n = B.n, bd = box(2.5, 2.5, 2.54 * n, blk); bd.position.y = 1.25; g.add(bd);
          for (const p of pads) { const pin = box(.64, 9, .64, gold); pin.position.set(0, 3.5, p.y); g.add(pin); }
          break;
        }
        case 'terminal': {
          const n = B.n, bd = box(8, 10, 5.08 * n, mat('#2f6fd0', { roughness: .5 })); bd.position.set(.4, 5, 0); g.add(bd);
          for (const p of pads) { const sc = cyl(1.4, .4, metal, 18); sc.position.set(-.6, 10.2, p.y); g.add(sc); const sl = box(2.4, .12, .4, mat('#555')); sl.position.set(-.6, 10.42, p.y); g.add(sl); const hole = box(.1, 3, 3, mat('#111')); hole.position.set(4.42, 4, p.y); g.add(hole); }
          break;
        }
        case 'trimmer': { const bd = box(9.5, 10, 4.8, mat('#2f6fd0')); bd.position.set(0, 5, -1); g.add(bd); const sc = cyl(1.1, 1.2, gold, 16); sc.rotation.x = Math.PI / 2; sc.position.set(3.4, 8.4, -3.5); g.add(sc); break; }
        case 'crystal': { const bd = box(10.5, 3.6, 4.4, metal); bd.position.y = 2.2; g.add(bd); for (const s of [-1, 1]) { const e = cyl(2.2, 3.6, metal, 20); e.position.set(s * 5.25, 2.2, 0); g.add(e); } break; }
        case 'tact': {
          const bd = box(6, 3.4, 6, blk); bd.position.y = 1.7; g.add(bd); const pl = box(6.1, .2, 6.1, metal); pl.position.y = 3.5; g.add(pl);
          const btn = cyl(1.75, 1.6, mat('#2a2a2a'), 24); btn.position.y = 4.3; g.add(btn);
          break;
        }
      }
      g.position.set(part.bx - b.w / 2, 0, part.by - b.h / 2); g.rotation.y = -(part.brot || 0) * Math.PI / 180;
      root.add(g);
    }
    orbit.r = Math.max(b.w, b.h) * 1.6 + 20;
    dirty = true;
  }

  function place() {
    const { th, ph, r } = orbit;
    cam.position.set(orbit.tx + r * Math.sin(ph) * Math.sin(th), orbit.ty + r * Math.cos(ph), orbit.tz + r * Math.sin(ph) * Math.cos(th));
    cam.lookAt(orbit.tx, orbit.ty, orbit.tz); dirty = true;
  }
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!host || !host.clientWidth) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (ren.domElement.width !== Math.round(w * ren.getPixelRatio()) || ren.domElement.height !== Math.round(h * ren.getPixelRatio())) { ren.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); dirty = true; }
    if (dirty) { ren.render(scene, cam); dirty = false; }
  }

  async function show(el, pr) {
    host = el;
    T = await loadThree();
    const THREE = T;
    if (!ren) {
      ren = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      ren.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); ren.outputEncoding = THREE.sRGBEncoding;
      ren.setClearColor('#0b0b0c');
      scene = new THREE.Scene();
      cam = new THREE.PerspectiveCamera(35, 1, 0.5, 2000);
      scene.add(new THREE.HemisphereLight('#ffffff', '#3a3a40', .75));
      const d1 = new THREE.DirectionalLight('#ffffff', .85); d1.position.set(40, 80, 50); scene.add(d1);
      const d2 = new THREE.DirectionalLight('#ffe2cc', .3); d2.position.set(-60, 30, -40); scene.add(d2);
      const d3 = new THREE.DirectionalLight('#ffffff', .35); d3.position.set(0, -80, 0); scene.add(d3);
      const cvs = ren.domElement; let dr = null;
      cvs.addEventListener('contextmenu', e => e.preventDefault());
      const pts = new Map();
      cvs.addEventListener('pointerdown', e => { cvs.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); dr = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey }; if (pts.size === 2) { const [a, b2] = [...pts.values()]; dr.pinch = Math.hypot(a[0] - b2[0], a[1] - b2[1]); } });
      cvs.addEventListener('pointermove', e => {
        if (!dr) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
        if (pts.size === 2 && dr.pinch) { const [a, b2] = [...pts.values()], d = Math.hypot(a[0] - b2[0], a[1] - b2[1]); orbit.r = Math.max(10, Math.min(800, orbit.r * dr.pinch / d)); dr.pinch = d; place(); return; }
        const dx = e.clientX - dr.x, dy = e.clientY - dr.y; dr.x = e.clientX; dr.y = e.clientY;
        if (dr.pan) { const k = orbit.r / 700; orbit.tx -= (Math.cos(orbit.th) * dx) * k; orbit.tz -= (-Math.sin(orbit.th) * dx) * k; orbit.tx -= Math.sin(orbit.th) * dy * k * -1; orbit.tz -= Math.cos(orbit.th) * dy * k * -1; }
        else { orbit.th -= dx * .008; orbit.ph = Math.max(.05, Math.min(Math.PI - .05, orbit.ph - dy * .008)); }
        place();
      });
      const end = e => { pts.delete(e.pointerId); if (!pts.size) dr = null; };
      cvs.addEventListener('pointerup', end); cvs.addEventListener('pointercancel', end);
      cvs.addEventListener('wheel', e => { e.preventDefault(); orbit.r = Math.max(10, Math.min(800, orbit.r * Math.exp(e.deltaY * .0012))); place(); }, { passive: false });
    }
    if (ren.domElement.parentNode !== el) { el.innerHTML = ''; el.appendChild(ren.domElement); }
    build(pr); orbit.tx = orbit.ty = orbit.tz = 0; place();
    if (!raf) loop();
  }
  function hide() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  function update(pr) { if (T && ren && raf) { build(pr); place(); } }

  P.view3d = { show, hide, update, bands };
})(globalThis.PCB = globalThis.PCB || {});
