/* hammi.ca PCB: parts library. Each part type has a schematic symbol
   (grid units, pins on whole numbers) and one or more footprints (mm).
   Footprint pads point at symbol pin numbers through `pin`. */
(function (P) {
  'use strict';

  /* ---------- footprint helpers ---------- */
  function tht(n, pin, x, y, d, drill, shape, h) { return { n: String(n), pin, x, y, shape: shape || 'circle', w: d, h: h || d, drill }; }
  function smd(n, pin, x, y, w, h, shape) { return { n: String(n), pin, x, y, shape: shape || 'rect', w, h, drill: 0 }; }
  const L = (x1, y1, x2, y2) => ['l', x1, y1, x2, y2];
  const C = (x, y, r) => ['c', x, y, r];
  const box = (x0, y0, x1, y1) => [L(x0, y0, x1, y0), L(x1, y0, x1, y1), L(x1, y1, x0, y1), L(x0, y1, x0, y0)];

  const FP = {
    axial(pitch, d, drill, bodyL, bodyD, color, band) {
      return {
        pads: [tht(1, 1, -pitch / 2, 0, d, drill, 'rect'), tht(2, 2, pitch / 2, 0, d, drill)],
        silk: [...box(-bodyL / 2, -bodyD / 2, bodyL / 2, bodyD / 2), L(-pitch / 2 + d / 2 + .3, 0, -bodyL / 2, 0), L(bodyL / 2, 0, pitch / 2 - d / 2 - .3, 0)]
          .concat(band ? [L(-bodyL / 2 + .7, -bodyD / 2, -bodyL / 2 + .7, bodyD / 2)] : []),
        body: { kind: 'axial', l: bodyL, d: bodyD, pitch, color, band }
      };
    },
    chip(size, color, polar) {
      const S = { '0805': [0.95, 1.0, 1.25, 2.0, 1.25], '1206': [1.45, 1.15, 1.8, 3.2, 1.6], 'sod123': [1.65, 0.9, 1.2, 2.7, 1.6] }[size];
      const [cx, w, h, bl, bw] = S, sy = h / 2 + .35;
      return {
        pads: [smd(1, 1, -cx, 0, w, h), smd(2, 2, cx, 0, w, h)],
        silk: [L(-bl / 2 + .2, -sy, bl / 2 - .2, -sy), L(-bl / 2 + .2, sy, bl / 2 - .2, sy)].concat(polar ? [L(-cx - w / 2 - .35, -sy, -cx - w / 2 - .35, sy)] : []),
        body: { kind: 'chip', l: bl, w: bw, h: size === 'sod123' ? 1.1 : 0.6, color }, smd: true
      };
    },
    disc(pitch) {
      return {
        pads: [tht(1, 1, -pitch / 2, 0, 1.6, .8), tht(2, 2, pitch / 2, 0, 1.6, .8)],
        silk: box(-pitch / 2 - 1.2, -1.4, pitch / 2 + 1.2, 1.4).map(l => l),
        body: { kind: 'disc', w: pitch + 2, d: 2.4, h: 4.5, color: '#c98a34' }
      };
    },
    radial(pitch, dia, h) {
      return {
        pads: [tht(1, 1, -pitch / 2, 0, pitch > 2.5 ? 2.0 : 1.6, pitch > 2.5 ? 1.0 : .8, 'rect'), tht(2, 2, pitch / 2, 0, pitch > 2.5 ? 2.0 : 1.6, pitch > 2.5 ? 1.0 : .8)],
        silk: [C(0, 0, dia / 2 + .15), L(-dia / 2 - .9, -dia / 2 + .2, -dia / 2 - .9, -dia / 2 + 1.4), L(-dia / 2 - 1.5, -dia / 2 + .8, -dia / 2 - .3, -dia / 2 + .8)],
        body: { kind: 'can', d: dia, h, color: '#1c2430', stripe: '#9aa3ad' }
      };
    },
    led(dia) {
      const r = dia / 2 + .3;
      return {
        pads: [tht(1, 1, -1.27, 0, 1.8, .9, 'rect'), tht(2, 2, 1.27, 0, 1.8, .9)],
        silk: [C(0, 0, r), L(-r * .55, -r * .84, -r * .55, r * .84)].slice(0, 1).concat([L(-r, -1.0, -r, 1.0)]),
        body: { kind: 'led', d: dia, h: dia === 5 ? 8.6 : 5.3 }
      };
    },
    to92(pins) {
      return {
        pads: [tht(1, pins[0], -2.54, 0, 1.5, .8, 'rect'), tht(2, pins[1], 0, 0, 1.5, .8), tht(3, pins[2], 2.54, 0, 1.5, .8)],
        silk: [L(-2.4, 1.7, 2.4, 1.7), ['a', 0, 0, 2.6, 200, 340]],
        body: { kind: 'to92' }
      };
    },
    sot23(pins) {
      return {
        pads: [smd(1, pins[0], -0.95, 1.1, .8, .9), smd(2, pins[1], 0.95, 1.1, .8, .9), smd(3, pins[2], 0, -1.1, .8, .9)],
        silk: [L(-1.6, -.45, -.65, -.45), L(.65, -.45, 1.6, -.45), L(-.3, .5, .3, .5)],
        body: { kind: 'chip', l: 2.9, w: 1.3, h: 1.0, color: '#1b1b1b' }, smd: true
      };
    },
    to220() {
      return {
        pads: [tht(1, 1, -2.54, 0, 1.8, 1.0, 'rect', 2.6), tht(2, 2, 0, 0, 1.8, 1.0, 'oval', 2.6), tht(3, 3, 2.54, 0, 1.8, 1.0, 'oval', 2.6)],
        silk: [...box(-5.2, -1.9, 5.2, 2.6), L(-5.2, -1.2, 5.2, -1.2)],
        body: { kind: 'to220' }
      };
    },
    dip(n) {
      const h = n / 2, pads = [];
      for (let i = 0; i < h; i++) pads.push(tht(i + 1, i + 1, -3.81, (i - (h - 1) / 2) * 2.54, 1.6, .8, i === 0 ? 'rect' : 'circle'));
      for (let i = 0; i < h; i++) pads.push(tht(h + i + 1, h + i + 1, 3.81, ((h - 1) / 2 - i) * 2.54, 1.6, .8));
      const y0 = -(h / 2) * 2.54 - .2, y1 = -y0;
      return {
        pads,
        silk: [L(-2.6, y0, -.8, y0), ['a', 0, y0, .8, 0, 180], L(.8, y0, 2.6, y0), L(2.6, y0, 2.6, y1), L(2.6, y1, -2.6, y1), L(-2.6, y1, -2.6, y0)],
        body: { kind: 'dip', n, l: h * 2.54, w: 6.4 }
      };
    },
    soic(n) {
      const h = n / 2, pads = [];
      for (let i = 0; i < h; i++) pads.push(smd(i + 1, i + 1, -2.7, (i - (h - 1) / 2) * 1.27, 1.55, .6));
      for (let i = 0; i < h; i++) pads.push(smd(h + i + 1, h + i + 1, 2.7, ((h - 1) / 2 - i) * 1.27, 1.55, .6));
      const y0 = -(h / 2) * 1.27 - .35, y1 = -y0;
      return {
        pads,
        silk: [L(-1.9, y0, 1.9, y0), L(-1.9, y1, 1.9, y1), C(-1.2, y0 + .75, .25)],
        body: { kind: 'soic', n, l: h * 1.27 + .3, w: 3.9 }, smd: true
      };
    },
    header(n) {
      const pads = [];
      for (let i = 0; i < n; i++) pads.push(tht(i + 1, i + 1, 0, (i - (n - 1) / 2) * 2.54, 1.7, 1.0, i === 0 ? 'rect' : 'circle'));
      const y0 = -n * 1.27, y1 = -y0;
      return { pads, silk: [...box(-1.33, y0 - .06, 1.33, y1 + .06), L(-1.9, y0 + .2, -1.9, y0 + 2.34)], body: { kind: 'header', n } };
    },
    terminal(n) {
      const pads = [];
      for (let i = 0; i < n; i++) pads.push(tht(i + 1, i + 1, 0, (i - (n - 1) / 2) * 5.08, 2.4, 1.2, i === 0 ? 'rect' : 'circle'));
      const y0 = -n * 2.54, y1 = -y0;
      return { pads, silk: box(-3.6, y0 - .2, 4.4, y1 + .2), body: { kind: 'terminal', n } };
    },
    trimmer() {
      return {
        pads: [tht(1, 1, -2.54, 0, 1.6, .8, 'rect'), tht(2, 2, 0, 0, 1.6, .8), tht(3, 3, 2.54, 0, 1.6, .8)],
        silk: box(-4.9, -3.6, 4.9, 1.4),
        body: { kind: 'trimmer' }
      };
    },
    crystal() {
      return {
        pads: [tht(1, 1, -2.44, 0, 1.5, .8), tht(2, 2, 2.44, 0, 1.5, .8)],
        silk: [L(-3, -2.3, 3, -2.3), L(-3, 2.3, 3, 2.3), ['a', -3, 0, 2.3, 90, 270], ['a', 3, 0, 2.3, -90, 90]],
        body: { kind: 'crystal' }
      };
    },
    tact() {
      return {
        pads: [tht(1, 1, -3.25, -2.25, 2.0, 1.0), tht(2, 1, 3.25, -2.25, 2.0, 1.0), tht(3, 2, -3.25, 2.25, 2.0, 1.0), tht(4, 2, 3.25, 2.25, 2.0, 1.0)],
        silk: [...box(-3.0, -3.0, 3.0, 3.0), C(0, 0, 1.75)],
        body: { kind: 'tact' }
      };
    },
    nano() {
      // Arduino Nano: 2 x 15 pins, rows 15.24 mm apart, USB end at the bottom (by D12/D13)
      const pads = [];
      for (let i = 0; i < 15; i++) pads.push(tht(i + 1, i + 1, -7.62, -17.78 + i * 2.54, 1.7, 1.0, i === 0 ? 'rect' : 'circle'));
      for (let i = 0; i < 15; i++) pads.push(tht(16 + i, 16 + i, 7.62, 17.78 - i * 2.54, 1.7, 1.0));
      return { pads, silk: [...box(-9, -21.6, 9, 21.6), ...box(-3.9, 18.6, 3.9, 22.6)], body: { kind: 'nano' } };
    },
    oled() {
      // 0.96 inch I2C OLED module, 27.3 x 27.8 mm, 4-pin header on top: GND VCC SCL SDA
      const pads = [0, 1, 2, 3].map(i => tht(i + 1, i + 1, -3.81 + i * 2.54, -11.6, 1.7, 1.0, i === 0 ? 'rect' : 'circle'));
      return { pads, silk: [...box(-13.65, -13.9, 13.65, 13.9), ...box(-12.6, -7.6, 12.6, 9.2)], body: { kind: 'oled' } };
    },
    encoder() {
      // EC11-style rotary encoder with push switch: A C B on one side, switch on the other, two mounting lugs
      return {
        pads: [tht(1, 1, -2.5, 7.5, 1.8, 1.0, 'rect'), tht(2, 2, 0, 7.5, 1.8, 1.0), tht(3, 3, 2.5, 7.5, 1.8, 1.0), tht(4, 4, -2.5, -7, 1.8, 1.0), tht(5, 5, 2.5, -7, 1.8, 1.0)],
        holes: [{ x: -5.7, y: 0, d: 2.4 }, { x: 5.7, y: 0, d: 2.4 }],
        silk: [...box(-6.2, -6.2, 6.2, 6.2), C(0, 0, 3)], body: { kind: 'encoder' }
      };
    },
    buzzer() {
      return { pads: [tht(1, 1, -3.8, 0, 2.0, 1.0, 'rect'), tht(2, 2, 3.8, 0, 2.0, 1.0)], silk: [C(0, 0, 6.15), L(-5.6, -3.4, -5.6, -2.0), L(-6.3, -2.7, -4.9, -2.7)], body: { kind: 'buzzer' } };
    },
    ldr() {
      return { pads: [tht(1, 1, -2.54, 0, 1.6, .8), tht(2, 2, 2.54, 0, 1.6, .8)], silk: [C(0, 0, 2.75)], body: { kind: 'ldr' } };
    },
    hole(d) { return { pads: [], holes: [{ x: 0, y: 0, d }], silk: [C(0, 0, d / 2 + .9)], body: null }; }
  };

  /* ---------- schematic symbol helpers (units; pins on integers) ---------- */
  function twoPin(body, names) {
    return { pins: [{ n: 1, name: names ? names[0] : '1', x: -3, y: 0 }, { n: 2, name: names ? names[1] : '2', x: 3, y: 0 }], prims: body, box: [-3, -1.6, 3, 1.6] };
  }
  const leads = (a, b) => [L(-3, 0, a, 0), L(b, 0, 3, 0)];
  const SYM = {
    resistor: () => twoPin([...leads(-1.6, 1.6), ['r', -1.6, -.6, 3.2, 1.2]]),
    cap: () => twoPin([...leads(-.3, .3), L(-.3, -1.2, -.3, 1.2), L(.3, -1.2, .3, 1.2)]),
    capPol: () => twoPin([...leads(-.3, .45), L(-.3, -1.2, -.3, 1.2), ['a', 1.5, 0, 1.05, 145, 215], ['t', -1.3, -1.25, '+', 'c', .9]], ['+', '-']),
    diode: (led) => {
      // anode (pin 2) on the left, cathode (pin 1) on the right
      const pr = [...leads(-.9, .9), ['p', [[-.9, -1], [.9, 0], [-.9, 1]], 1], L(.9, -1, .9, 1)];
      if (led) pr.push(L(.1, -1.2, .9, -2), L(.9, -2, .45, -1.9), L(.9, -2, .8, -1.55), L(.9, -1.2, 1.7, -2), L(1.7, -2, 1.25, -1.9), L(1.7, -2, 1.6, -1.55));
      return { pins: [{ n: 2, name: 'A', x: -3, y: 0 }, { n: 1, name: 'K', x: 3, y: 0 }], prims: pr, box: [-3, -2.2, 3, 1.4] };
    },
    crystal: () => twoPin([...leads(-.9, .9), L(-.9, -1, -.9, 1), L(.9, -1, .9, 1), ['r', -.5, -1.2, 1, 2.4]]),
    button: () => twoPin([...leads(-1.2, 1.2), C(-1.2, 0, .18), C(1.2, 0, .18), L(-1.3, -.8, 1.3, -.8), L(0, -.8, 0, -1.6), L(-.5, -1.6, .5, -1.6)]),
    pot: () => ({
      pins: [{ n: 1, name: '1', x: -3, y: 0 }, { n: 3, name: '3', x: 3, y: 0 }, { n: 2, name: 'W', x: 0, y: -3 }],
      prims: [...leads(-1.6, 1.6), ['r', -1.6, -.6, 3.2, 1.2], L(0, -3, 0, -.7), ['p', [[-.35, -1.25], [.35, -1.25], [0, -.65]], 1]], box: [-3, -3, 3, 1]
    }),
    bjt: (pnp) => {
      const pr = [L(-3, 0, -.6, 0), L(-.6, -1.2, -.6, 1.2), L(-.6, -.5, 2, -2), L(2, -2, 2, -3), L(-.6, .5, 2, 2), L(2, 2, 2, 3), C(.4, 0, 1.75)];
      if (!pnp) pr.push(['p', [[2, 2], [1.15, 1.95], [1.55, 1.25]], 1]); else pr.push(['p', [[-.55, .55], [.3, .55], [-.05, 1.25]], 1]);
      return { pins: [{ n: 2, name: 'B', x: -3, y: 0 }, { n: 3, name: 'C', x: 2, y: -3 }, { n: 1, name: 'E', x: 2, y: 3 }], prims: pr, box: [-3, -3, 2.4, 3] };
    },
    reg: () => ({
      pins: [{ n: 1, name: 'IN', x: -5, y: 0 }, { n: 3, name: 'OUT', x: 5, y: 0 }, { n: 2, name: 'GND', x: 0, y: 4 }],
      prims: [['r', -3, -2, 6, 4], L(-5, 0, -3, 0), L(3, 0, 5, 0), L(0, 2, 0, 4), ['t', -2.6, 0, 'IN', 'l', .8], ['t', 2.6, 0, 'OUT', 'r', .8], ['t', 0, 1.3, 'GND', 'c', .8]], box: [-5, -2, 5, 4]
    }),
    ic: (n, names) => {
      const h = n / 2, pins = [], prims = [], top = -(h - 1), bot = h - 1;
      for (let i = 0; i < h; i++) {
        const y = top + 2 * i; pins.push({ n: i + 1, name: names ? names[i] : String(i + 1), x: -7, y });
        prims.push(L(-7, y, -5, y), ['t', -4.6, y, names ? names[i] : '', 'l', .8], ['t', -5.4, y - .45, String(i + 1), 'r', .6]);
      }
      for (let i = 0; i < h; i++) {
        const y = bot - 2 * i, k = h + i; pins.push({ n: k + 1, name: names ? names[k] : String(k + 1), x: 7, y });
        prims.push(L(5, y, 7, y), ['t', 4.6, y, names ? names[k] : '', 'r', .8], ['t', 5.4, y - .45, String(k + 1), 'l', .6]);
      }
      prims.unshift(['r', -5, top - 1.5, 10, bot - top + 3], ['a', 0, top - 1.5, .7, 0, 180]);
      return { pins, prims, box: [-7, top - 1.5, 7, bot + 1.5] };
    },
    header: (n, screw) => {
      const pins = [], prims = [], top = -(n - 1);
      for (let i = 0; i < n; i++) {
        const y = top + 2 * i; pins.push({ n: i + 1, name: String(i + 1), x: -3, y });
        prims.push(L(-3, y, -1, y), screw ? C(0, y, .45) : ['r', -1, y - .25, 1, .5], ['t', -1.4, y - .45, String(i + 1), 'r', .6]);
      }
      prims.unshift(['r', -1, top - 1, 2, 2 * n]);
      return { pins, prims, box: [-3, top - 1, 1, top - 1 + 2 * n] };
    },
    power: (name) => {
      const gnd = /gnd|vss|0v/i.test(name);
      const prims = gnd ? [L(0, 0, 0, 1.2), L(-1.2, 1.2, 1.2, 1.2), L(-.75, 1.65, .75, 1.65), L(-.3, 2.1, .3, 2.1)]
        : [L(0, 0, 0, -1.2), L(-1, -1.2, 1, -1.2), ['t', 0, -2.1, name, 'c', .9]];
      return { pins: [{ n: 1, name, x: 0, y: 0 }], prims, box: gnd ? [-1.2, 0, 1.2, 2.2] : [-1.4, -2.7, 1.4, 0] };
    },
    module: (title, names, right) => {
      // pins down the left (and optionally right) side of a labelled box
      const L2 = names.filter((_, i) => !(right && right.includes(i))), R2 = names.filter((_, i) => right && right.includes(i));
      const rows = Math.max(L2.length, R2.length), top = -(rows - 1), pins = [], prims = [];
      let li = 0, ri = 0;
      names.forEach((nm, i) => {
        const isR = right && right.includes(i), y = top + 2 * (isR ? ri++ : li++), x = isR ? 7 : -7;
        pins.push({ n: i + 1, name: nm, x, y });
        prims.push(L(x, y, isR ? 5 : -5, y), ['t', isR ? 4.6 : -4.6, y, nm, isR ? 'r' : 'l', .8]);
      });
      prims.unshift(['r', -5, top - 2.6, 10, (rows - 1) * 2 + 4.2], ['t', 0, top - 1.6, title, 'c', .8]);
      return { pins, prims, box: [-7, top - 2.6, 7, top - 2.6 + (rows - 1) * 2 + 4.2] };
    },
    label: (name) => {
      const w = Math.max(2, String(name).length * .62 + .9);
      return { pins: [{ n: 1, name, x: 0, y: 0 }], prims: [['p', [[0, 0], [.6, -.6], [w, -.6], [w, .6], [.6, .6]], 0], ['t', .8, 0, name, 'l', .85]], box: [0, -.7, w, .7] };
    },
    hole: () => ({ pins: [], prims: [C(0, 0, 1.2), C(0, 0, .45)], box: [-1.4, -1.4, 1.4, 1.4] })
  };

  const CHIPS = {
    'DIP-8 generic': { n: 8 }, 'DIP-14 generic': { n: 14 }, 'DIP-16 generic': { n: 16 },
    'NE555': { n: 8, names: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THR', 'DIS', 'VCC'] },
    'ATtiny85': { n: 8, names: ['PB5', 'PB3', 'PB4', 'GND', 'PB0', 'PB1', 'PB2', 'VCC'] },
    'LM358': { n: 8, names: ['OUT1', 'IN1-', 'IN1+', 'GND', 'IN2+', 'IN2-', 'OUT2', 'VCC'] },
    'CD4017': { n: 16, names: ['Q5', 'Q1', 'Q0', 'Q2', 'Q6', 'Q7', 'Q3', 'VSS', 'Q8', 'Q4', 'Q9', 'CO', 'CE', 'CLK', 'MR', 'VDD'] },
    '74HC595': { n: 16, names: ['QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'GND', "QH'", 'SRCLR', 'SRCLK', 'RCLK', 'OE', 'SER', 'QA', 'VCC'] }
  };

  /* ---------- the library ---------- */
  const DEFS = {
    R: { name: 'Resistor', group: 'Passive', prefix: 'R', value: '10k', sym: () => SYM.resistor(),
      fps: { axial: ['THT axial 10.16 mm', () => FP.axial(10.16, 1.6, .8, 6.3, 2.5, '#d8c7a6')], '0805': ['SMD 0805', () => FP.chip('0805', '#1b1b1b')], '1206': ['SMD 1206', () => FP.chip('1206', '#1b1b1b')] }, fp: 'axial' },
    C: { name: 'Capacitor', group: 'Passive', prefix: 'C', value: '100n', sym: () => SYM.cap(),
      fps: { disc: ['THT disc 5.08 mm', () => FP.disc(5.08)], '0805': ['SMD 0805', () => FP.chip('0805', '#b7956a')], '1206': ['SMD 1206', () => FP.chip('1206', '#b7956a')] }, fp: 'disc' },
    CP: { name: 'Electrolytic cap', group: 'Passive', prefix: 'C', value: '10u', sym: () => SYM.capPol(),
      fps: { r5: ['Radial 5 mm, 2.0 pitch', () => FP.radial(2.0, 5, 11)], r8: ['Radial 8 mm, 3.5 pitch', () => FP.radial(3.5, 8, 12)] }, fp: 'r5' },
    POT: { name: 'Trimmer pot', group: 'Passive', prefix: 'RV', value: '10k', sym: () => SYM.pot(), fps: { t: ['Trimmer 3-pin 2.54 mm', () => FP.trimmer()] }, fp: 't' },
    Y: { name: 'Crystal', group: 'Passive', prefix: 'Y', value: '16MHz', sym: () => SYM.crystal(), fps: { hc49: ['HC-49 4.88 mm', () => FP.crystal()] }, fp: 'hc49' },
    LED: { name: 'LED', group: 'Semis', prefix: 'D', value: 'red', sym: () => SYM.diode(true),
      fps: { t5: ['THT 5 mm', () => FP.led(5)], t3: ['THT 3 mm', () => FP.led(3)], '0805': ['SMD 0805', () => FP.chip('0805', '#e8e2d0', true)] }, fp: 't5' },
    D: { name: 'Diode', group: 'Semis', prefix: 'D', value: '1N4148', sym: () => SYM.diode(false),
      fps: { do35: ['DO-35 7.62 mm', () => FP.axial(7.62, 1.6, .8, 3.8, 1.8, '#c4473a', true)], do41: ['DO-41 10.16 mm', () => FP.axial(10.16, 2.0, 1.0, 5.2, 2.7, '#222', true)], sod123: ['SMD SOD-123', () => FP.chip('sod123', '#222', true)] }, fp: 'do35' },
    QN: { name: 'NPN transistor', group: 'Semis', prefix: 'Q', value: '2N3904', sym: () => SYM.bjt(false),
      fps: { to92: ['TO-92 2.54 mm (E B C)', () => FP.to92([1, 2, 3])], sot23: ['SMD SOT-23 (B E C)', () => FP.sot23([2, 1, 3])] }, fp: 'to92' },
    QP: { name: 'PNP transistor', group: 'Semis', prefix: 'Q', value: '2N3906', sym: () => SYM.bjt(true),
      fps: { to92: ['TO-92 2.54 mm (E B C)', () => FP.to92([1, 2, 3])], sot23: ['SMD SOT-23 (B E C)', () => FP.sot23([2, 1, 3])] }, fp: 'to92' },
    REG: { name: 'Regulator 78xx', group: 'Semis', prefix: 'U', value: '7805', sym: () => SYM.reg(), fps: { to220: ['TO-220 vertical', () => FP.to220()] }, fp: 'to220' },
    IC: { name: 'Chip', group: 'Chips', prefix: 'U', value: 'NE555', chip: true,
      sym: (p) => { const c = CHIPS[p.value] || { n: p.n || 8 }; return SYM.ic(c.n, c.names); },
      fps: { dip: ['DIP (THT 2.54 mm)', (p) => FP.dip((CHIPS[p.value] || { n: p.n || 8 }).n)], soic: ['SOIC (SMD 1.27 mm)', (p) => FP.soic((CHIPS[p.value] || { n: p.n || 8 }).n)] }, fp: 'dip' },
    J: { name: 'Pin header', group: 'Connect', prefix: 'J', value: 'header', count: [1, 12], n: 2,
      sym: (p) => SYM.header(p.n || 2), fps: { h: ['2.54 mm header', (p) => FP.header(p.n || 2)] }, fp: 'h' },
    JT: { name: 'Screw terminal', group: 'Connect', prefix: 'J', value: 'terminal', count: [2, 4], n: 2,
      sym: (p) => SYM.header(p.n || 2, true), fps: { t: ['5.08 mm terminal', (p) => FP.terminal(p.n || 2)] }, fp: 't' },
    SW: { name: 'Push button', group: 'Connect', prefix: 'SW', value: 'tact', sym: () => SYM.button(), fps: { t6: ['Tactile 6x6 mm', () => FP.tact()] }, fp: 't6' },
    MH: { name: 'Mounting hole', group: 'Board', prefix: 'H', value: 'M3', sym: () => SYM.hole(),
      fps: { m3: ['M3, 3.2 mm hole', () => FP.hole(3.2)], m2: ['M2, 2.2 mm hole', () => FP.hole(2.2)] }, fp: 'm3' },
    NANO: { name: 'Arduino Nano', group: 'Blocks', prefix: 'U', value: 'Arduino Nano', block: 'brain',
      sym: () => SYM.ic(30, ['D1/TX', 'D0/RX', 'RST', 'GND', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', '3V3', 'AREF', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', '5V', 'RST', 'GND', 'VIN']),
      fps: { nano: ['Nano module, 2 x 15 pins', () => FP.nano()] }, fp: 'nano' },
    OLED: { name: 'Screen (OLED)', group: 'Blocks', prefix: 'DS', value: 'SSD1306 128x64', block: 'screen',
      sym: () => SYM.module('OLED 0.96"', ['GND', 'VCC', 'SCL', 'SDA']), fps: { m: ['0.96" I2C OLED module', () => FP.oled()] }, fp: 'm' },
    ENC: { name: 'Dial (encoder)', group: 'Blocks', prefix: 'EN', value: 'EC11', block: 'dial',
      sym: () => SYM.module('ENCODER', ['A', 'C', 'B', 'SW1', 'SW2'], [3, 4]), fps: { ec11: ['EC11 encoder with push', () => FP.encoder()] }, fp: 'ec11' },
    KNOB: { name: 'Knob (pot)', group: 'Blocks', prefix: 'RV', value: '10k', block: 'knob', sym: () => SYM.pot(), fps: { t: ['Trimmer 3-pin 2.54 mm', () => FP.trimmer()] }, fp: 't' },
    BUZ: { name: 'Buzzer', group: 'Blocks', prefix: 'BZ', value: 'passive 12mm', block: 'buzzer',
      sym: () => SYM.module('BUZZER', ['+', '-']), fps: { b12: ['12 mm buzzer, 7.6 mm pitch', () => FP.buzzer()] }, fp: 'b12' },
    LDR: { name: 'Light sensor', group: 'Blocks', prefix: 'LDR', value: 'GL5528', block: 'light',
      sym: () => SYM.module('LDR', ['1', '2']), fps: { l5: ['5 mm LDR', () => FP.ldr()] }, fp: 'l5' },
    PWR: { name: 'Power label', group: 'Power', prefix: '#PWR', value: 'VCC', power: true, values: ['VCC', '+5V', '+3V3', '+12V', 'GND'],
      sym: (p) => SYM.power(p.value || 'VCC'), fps: null },
    NL: { name: 'Net label', group: 'Power', prefix: '#NL', value: 'SIG', power: true, label: true, values: ['SIG', 'SDA', 'SCL', 'TX', 'RX', 'CLK'],
      sym: (p) => SYM.label(p.value || 'SIG'), fps: null }
  };

  P.lib = { DEFS, CHIPS, FP };
})(globalThis.PCB = globalThis.PCB || {});
