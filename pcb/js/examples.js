/* hammi.ca PCB: ready-made example boards */
(function (P) {
  'use strict';
  const M = P.model;

  function build(name, list, wires, board) {
    const pr = M.newProject(); pr.name = name; Object.assign(pr.board, board || {});
    const by = {};
    for (const [key, type, value, sx, sy, srot, extra] of list) {
      const p = M.addPart(pr, type, Object.assign({ value, sx, sy, srot: srot || 0 }, extra || {}));
      by[key] = p;
    }
    for (const [a, an, b, bn] of wires) pr.wires.push({ a: { p: by[a].id, n: an }, b: { p: by[b].id, n: bn } });
    let i = 0; for (const p of pr.parts) if (M.footprintOf(p)) { p.bx = -14 - (i % 2) * 12; p.by = 6 + Math.floor(i / 2) * 9; i++; }
    return pr;
  }

  const EX = {
    blinker: {
      title: '555 LED blinker',
      make: () => build('555-blinker', [
        ['U1', 'IC', 'NE555', 0, 0],
        ['J1', 'J', 'header', -26, 0, 0, { n: 2 }],
        ['R1', 'R', '10k', 14, -7, 90], ['R2', 'R', '47k', 14, 3, 90],
        ['C1', 'CP', '10u', 20, 9, 90], ['C2', 'C', '10n', 10, 10, 90],
        ['R3', 'R', '470', -14, 1], ['D1', 'LED', 'red', -18, 7, 90],
        ['C3', 'C', '100n', -19, -6, 90],
        ['V1', 'PWR', 'VCC', -31, -3], ['G1', 'PWR', 'GND', -31, 3],
        ['V2', 'PWR', 'VCC', 14, -12], ['V3', 'PWR', 'VCC', 9, -6],
        ['V4', 'PWR', 'VCC', -19, -11], ['G2', 'PWR', 'GND', -19, -1],
        ['L4', 'NL', 'GND', -9, -3, 180], ['G4', 'PWR', 'GND', -18, 13],
        ['G5', 'PWR', 'GND', 20, 14], ['G6', 'PWR', 'GND', 10, 15],
        ['L3', 'NL', 'VCC', -9, 3, 180], ['L1', 'NL', 'THR', -10, -1, 180], ['L2', 'NL', 'THR', 24, 2]
      ], [
        ['J1', 1, 'V1', 1], ['J1', 2, 'G1', 1],
        ['U1', 8, 'V3', 1], ['U1', 4, 'L3', 1], ['U1', 1, 'L4', 1],
        ['R1', 1, 'V2', 1], ['R1', 2, 'U1', 7], ['R2', 1, 'U1', 7], ['R2', 2, 'U1', 6], ['U1', 2, 'L1', 1], ['R2', 2, 'L2', 1],
        ['C1', 1, 'R2', 2], ['C1', 2, 'G5', 1], ['C2', 1, 'U1', 5], ['C2', 2, 'G6', 1],
        ['U1', 3, 'R3', 2], ['R3', 1, 'D1', 2], ['D1', 1, 'G4', 1],
        ['C3', 1, 'V4', 1], ['C3', 2, 'G2', 1]
      ], { label: 'hammi.ca 555 blinker' })
    },
    usbled: {
      title: 'Button + LED + transistor',
      make: () => build('button-led', [
        ['J1', 'JT', 'terminal', -20, 0, 0, { n: 2 }],
        ['SW1', 'SW', 'tact', -8, -6],
        ['R1', 'R', '10k', 0, -6], ['Q1', 'QN', '2N3904', 6, -6],
        ['R2', 'R', '330', 8, -14, 90], ['D1', 'LED', 'green', 8, -20, 90],
        ['H1', 'MH', 'M3', 20, 4], ['H2', 'MH', 'M3', 24, 4], ['H3', 'MH', 'M3', 28, 4], ['H4', 'MH', 'M3', 32, 4],
        ['V1', 'PWR', '+5V', -25, -3], ['G1', 'PWR', 'GND', -25, 3], ['V2', 'PWR', '+5V', -11, -9], ['V3', 'PWR', '+5V', 8, -25], ['G2', 'PWR', 'GND', 8, 0]
      ], [
        ['J1', 1, 'V1', 1], ['J1', 2, 'G1', 1], ['SW1', 1, 'V2', 1], ['SW1', 2, 'R1', 1], ['R1', 2, 'Q1', 2],
        ['Q1', 1, 'G2', 1], ['Q1', 3, 'R2', 2], ['R2', 1, 'D1', 1], ['D1', 2, 'V3', 1]
      ], { label: 'hammi.ca' })
    }
  };
  P.examples = EX;
})(globalThis.PCB = globalThis.PCB || {});
