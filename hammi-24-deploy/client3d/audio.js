// Race sound, made live with Web Audio (no recordings): an engine note for each of the cars
// nearest the camera, with gear changes, throttle, distance, stereo position and doppler for
// fly-bys, plus tyre squeal, crashes, pit-stop air guns, the crowd, rain and wind noise onboard.
const SPEED_OF_SOUND = 343;
const GEARS = [88, 128, 165, 200, 236, 272, 340]; // km/h at the top of each gear
const VOICES = 5;

export function createAudio() {
  let ctx = null, master = null, engineBus = null, fxBus = null;
  let noise = null, crowd = null, rain = null, wind = null, squeal = null;
  let on = false, duckTo = 1;
  const voices = [];

  function noiseBuffer() {
    const len = ctx.sampleRate * 2, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function loopNoise() { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.start(0, Math.random() * 2); return s; }
  // a soft clipper gives the oscillators the rasp of a racing engine
  function shaper(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    const w = ctx.createWaveShaper(); w.curve = c; w.oversample = '2x'; return w;
  }
  function bed(type, freq, q) { const src = loopNoise(), f = ctx.createBiquadFilter(), g = ctx.createGain(); f.type = type; f.frequency.value = freq; f.Q.value = q; g.gain.value = 0; src.connect(f).connect(g).connect(fxBus); return g; }

  function makeVoice() {
    const v = { car: null };
    v.o1 = ctx.createOscillator(); v.o1.type = 'sawtooth';
    v.o2 = ctx.createOscillator(); v.o2.type = 'sawtooth';
    v.o3 = ctx.createOscillator(); v.o3.type = 'square';
    const g1 = ctx.createGain(), g2 = ctx.createGain(), g3 = ctx.createGain();
    g1.gain.value = 0.5; g2.gain.value = 0.42; g3.gain.value = 0.12;
    const mix = ctx.createGain();
    v.o1.connect(g1).connect(mix); v.o2.connect(g2).connect(mix); v.o3.connect(g3).connect(mix);
    // intake roar: noise tuned to the engine note
    const ns = loopNoise(); v.roar = ctx.createBiquadFilter(); v.roar.type = 'bandpass'; v.roar.Q.value = 3;
    v.roarGain = ctx.createGain(); v.roarGain.gain.value = 0.25;
    ns.connect(v.roar).connect(v.roarGain).connect(mix);
    v.drive = shaper(2.6);
    v.lp = ctx.createBiquadFilter(); v.lp.type = 'lowpass'; v.lp.Q.value = 1.4;
    v.body = ctx.createBiquadFilter(); v.body.type = 'peaking'; v.body.frequency.value = 180; v.body.gain.value = 6; v.body.Q.value = 1;
    v.gain = ctx.createGain(); v.gain.gain.value = 0;
    v.pan = ctx.createStereoPanner();
    mix.connect(v.drive).connect(v.lp).connect(v.body).connect(v.gain).connect(v.pan).connect(engineBus);
    for (const o of [v.o1, v.o2, v.o3]) { o.frequency.value = 200; o.start(); }
    return v;
  }

  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4;
    master = ctx.createGain(); master.gain.value = 0;
    master.connect(comp).connect(ctx.destination);
    engineBus = ctx.createGain(); engineBus.gain.value = 0.55; engineBus.connect(master);
    fxBus = ctx.createGain(); fxBus.gain.value = 0.8; fxBus.connect(master);
    noise = noiseBuffer();
    for (let i = 0; i < VOICES; i++) voices.push(makeVoice());
    crowd = bed('bandpass', 700, 0.5);
    rain = bed('highpass', 2500, 0.3);
    wind = bed('lowpass', 450, 0.7);
    squeal = bed('bandpass', 2900, 9);
  }

  function update(dt, { camera, cars, selected, mode, snap }) {
    if (!on || !ctx) return;
    const t = ctx.currentTime;
    const cp = camera.position;
    // camera right vector, for stereo
    const e = camera.matrixWorld.elements, rx = e[0], rz = e[2];
    const onboard = mode === 'onboard', follows = mode === 'chase' || onboard;
    // the nearest cars get engine voices
    const list = [];
    for (const car of cars.values()) {
      if (!car.g.visible || !car.data) continue;
      const st = car.data.state;
      if (st !== 'track' && st !== 'pitlane' && st !== 'finished') continue;
      const dx = car.g.position.x - cp.x, dz = car.g.position.z - cp.z, dy = car.g.position.y - cp.y;
      car.audioDist = Math.hypot(dx, dy, dz);
      if (car.audioDist < 900 || car.data.id === selected) list.push(car);
    }
    list.sort((a, b) => (b.data.id === selected && follows) - (a.data.id === selected && follows) || a.audioDist - b.audioDist);
    const chosen = list.slice(0, VOICES);
    // keep voices on the same cars where possible, so notes don't jump between cars
    const free = voices.filter((v) => !v.car || !chosen.includes(v.car));
    for (const v of free) v.car = null;
    for (const car of chosen) if (!voices.some((v) => v.car === car)) { const v = voices.find((x) => !x.car); if (v) v.car = car; }

    let squealAmt = 0, windAmt = 0;
    for (const v of voices) {
      const car = v.car;
      if (!car) { v.gain.gain.setTargetAtTime(0, t, 0.08); continue; }
      // speed as seen on screen, smoothed
      const sp = car.visSpeed || 0;
      const kmh = sp * 3.6;
      let gear = GEARS.findIndex((top) => kmh < top); if (gear < 0) gear = GEARS.length - 1;
      const lo = gear ? GEARS[gear - 1] * 0.62 : 0, hi = GEARS[gear];
      let rpm = 4200 + 7600 * Math.max(0, Math.min(1, (kmh - lo) / (hi - lo)));
      if (sp < 1) rpm = 2200;
      if (car.audioGear !== undefined && gear > car.audioGear) car.shiftT = 0.09; // upshift: a short cut
      car.audioGear = gear;
      const accel = car.visAccel || 0;
      let throttle = accel > -2 ? 1 : 0.25;
      if (car.data.state === 'pitlane') throttle = 0.35;
      if (car.shiftT > 0) { car.shiftT -= dt; throttle = 0.15; rpm *= 0.97; }
      // doppler from the car's speed along the line to the camera
      const dx = car.g.position.x - cp.x, dz = car.g.position.z - cp.z, d = Math.max(1, car.audioDist);
      const yaw = car.g.rotation.y, fx = Math.cos(yaw), fz = -Math.sin(yaw);
      const vr = -(fx * dx + fz * dz) / d * sp; // positive when coming towards us
      const dop = follows && car.data.id === selected ? 1 : Math.max(0.6, Math.min(1.6, SPEED_OF_SOUND / (SPEED_OF_SOUND - vr)));
      const f = (rpm / 15) * dop; // V8: four firing pulses per turn of the crank
      v.o1.frequency.setTargetAtTime(f, t, 0.03);
      v.o2.frequency.setTargetAtTime(f * 0.5 * 1.006, t, 0.03);
      v.o3.frequency.setTargetAtTime(f * 2.01, t, 0.03);
      v.roar.frequency.setTargetAtTime(f * 3, t, 0.05);
      const inside = onboard && car.data.id === selected;
      v.lp.frequency.setTargetAtTime((inside ? 700 : 900) + throttle * (inside ? 1500 : 3600) * Math.min(1, 60 / d + 0.35), t, 0.04);
      let g = 1 / Math.pow(1 + d / 14, 1.35);
      if (inside) g = 0.55;
      g *= 0.35 + 0.65 * throttle;
      v.gain.gain.setTargetAtTime(g, t, 0.05);
      v.pan.pan.setTargetAtTime(inside ? 0 : Math.max(-0.9, Math.min(0.9, (dx * rx + dz * rz) / d)), t, 0.05);
      // tyres squeal under hard braking or a big slide
      const slide = (car.visLat || 0) > 17 ? ((car.visLat || 0) - 17) / 10 : 0;
      const brake = accel < -22 ? (-accel - 22) / 15 : 0;
      squealAmt = Math.max(squealAmt, Math.min(1, slide + brake) * (inside ? 0.5 : g * 1.6));
      if (inside) windAmt = Math.min(1, sp / 85);
    }
    squeal.gain.setTargetAtTime(squealAmt * 0.35, t, 0.06);
    wind.gain.setTargetAtTime(windAmt * 0.18, t, 0.2);
    // a crowd bed under everything, rain when it falls
    crowd.gain.setTargetAtTime(onboard ? 0.01 : 0.045, t, 0.5);
    rain.gain.setTargetAtTime(snap ? Math.min(1, snap.rain || 0) * (onboard ? 0.12 : 0.2) : 0, t, 0.5);
    master.gain.setTargetAtTime(0.9 * duckTo, t, 0.25);
  }

  // one-shots, louder the closer the car is to the camera
  function hit(kind, distance) {
    if (!on || !ctx) return;
    const g0 = distance === undefined ? 0.25 : 1 / Math.pow(1 + distance / 25, 1.2);
    if (g0 < 0.02) return;
    const t = ctx.currentTime;
    const burst = (start, len, type, freq, q, gain) => {
      const s = ctx.createBufferSource(); s.buffer = noise;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(gain * g0, start + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, start + len);
      s.connect(f).connect(g).connect(fxBus); s.start(start, Math.random()); s.stop(start + len + 0.05);
    };
    if (kind === 'crash') {
      burst(t, 0.9, 'lowpass', 900, 0.7, 1.2);
      burst(t + 0.02, 0.5, 'bandpass', 3200, 1, 0.5); // carbon and glass
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.4);
      g.gain.setValueAtTime(0.9 * g0, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5); o.connect(g).connect(fxBus); o.start(t); o.stop(t + 0.55);
      skid(t - 0.6, 0.7, g0);
    } else if (kind === 'spin') skid(t, 1.3, g0);
    else if (kind === 'pop') { burst(t, 0.25, 'lowpass', 1800, 0.5, 1.1); burst(t + 0.05, 1.2, 'highpass', 1500, 0.5, 0.25); }
    else if (kind === 'pitgun') {
      // two quick bursts of the wheel guns, like a real stop
      for (let k = 0; k < 2; k++) for (let i = 0; i < 9; i++) burst(t + k * 0.55 + i * 0.035, 0.03, 'bandpass', 1800 + Math.random() * 600, 2, 0.5);
    }
  }
  function skid(start, len, g0) {
    const s = ctx.createBufferSource(); s.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 10; f.frequency.setValueAtTime(3200, start); f.frequency.linearRampToValueAtTime(2300, start + len);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(0.7 * g0, start + 0.05); g.gain.linearRampToValueAtTime(0.0001, start + len);
    s.connect(f).connect(g).connect(fxBus); s.start(Math.max(ctx.currentTime, start)); s.stop(start + len + 0.05);
  }

  return {
    get on() { return on; },
    setOn(v) {
      on = v;
      if (on) { if (!ctx) init(); ctx.resume(); }
      else if (ctx) { master.gain.setTargetAtTime(0, ctx.currentTime, 0.05); setTimeout(() => { if (!on) ctx.suspend(); }, 300); }
    },
    duck(v) { duckTo = v ? 0.45 : 1; },
    update, hit,
  };
}
