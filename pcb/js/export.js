/* hammi.ca PCB: manufacturing output. RS-274X Gerbers (with X2 file
   attributes), Excellon drill files, BOM and pick-and-place CSVs, and a
   plain stored ZIP so everything downloads as one file. */
(function (P) {
  'use strict';
  const M = P.model, G = P.geom;

  function Gerber(func, polarity, H) {
    this.func = func; this.pol = polarity || 'Positive'; this.H = H;
    this.aps = new Map(); this.next = 10; this.body = []; this.cur = null;
  }
  const n6 = v => String(Math.round(v * 1e6));
  const f6 = v => v.toFixed(6).replace(/0+$/, '0');
  Gerber.prototype.ap = function (kind, a, b) {
    const key = kind === 'C' ? 'C,' + f6(a) : kind + ',' + f6(a) + 'X' + f6(b);
    if (!this.aps.has(key)) this.aps.set(key, 'D' + (this.next++));
    return this.aps.get(key);
  };
  Gerber.prototype.use = function (d) { if (this.cur !== d) { this.body.push(d + '*'); this.cur = d; } };
  Gerber.prototype.xy = function (x, y) { return 'X' + n6(x) + 'Y' + n6(this.H - y); };
  Gerber.prototype.flash = function (d, x, y) { this.use(d); this.body.push(this.xy(x, y) + 'D03*'); };
  Gerber.prototype.path = function (d, pts) {
    if (pts.length < 2) return; this.use(d);
    this.body.push(this.xy(pts[0][0], pts[0][1]) + 'D02*');
    for (let i = 1; i < pts.length; i++) this.body.push(this.xy(pts[i][0], pts[i][1]) + 'D01*');
  };
  Gerber.prototype.pad = function (p, grow) {
    grow = grow || 0; const w = p.w + 2 * grow, h = p.h + 2 * grow;
    let d;
    if (p.shape === 'rect') d = this.ap('R', w, h);
    else if (p.shape === 'circle' || Math.abs(w - h) < 1e-9) d = this.ap('C', Math.min(w, h));
    else d = this.ap('O', w, h);
    this.flash(d, p.x, p.y);
  };
  Gerber.prototype.text = function (date) {
    const head = ['G04 hammi.ca PCB designer*', '%TF.GenerationSoftware,hammi.ca,PCB,1.0*%', '%TF.CreationDate,' + date + '*%', '%TF.FileFunction,' + this.func + '*%', '%TF.FilePolarity,' + this.pol + '*%', '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%'];
    for (const [key, d] of this.aps) {
      const [kind, v] = key.split(',');
      head.push('%AD' + d + kind + ',' + v + '*%');
    }
    head.push('G01*');
    return head.concat(this.body, ['M02*', '']).join('\n');
  };

  function excellon(drills, plated, H, date) {
    const tools = [...new Set(drills.map(d => +d.d.toFixed(3)))].sort((a, b) => a - b);
    const L = ['M48', '; DRILL file hammi.ca PCB designer ' + date, '; FORMAT={-:-/ absolute / metric / decimal}', '; #@! TF.FileFunction,' + (plated ? 'Plated,1,2,PTH' : 'NonPlated,1,2,NPTH'), 'FMAT,2', 'METRIC'];
    tools.forEach((t, i) => L.push('T' + (i + 1) + 'C' + t.toFixed(3)));
    L.push('%', 'G90', 'G05');
    tools.forEach((t, i) => {
      L.push('T' + (i + 1));
      for (const d of drills) if (+d.d.toFixed(3) === t) L.push('X' + d.x.toFixed(3) + 'Y' + (H - d.y).toFixed(3));
    });
    L.push('T0', 'M30', '');
    return L.join('\n');
  }

  function csvCell(v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  function fpName(part) {
    const d = P.lib.DEFS[part.type]; if (!d.fps) return '';
    const label = (d.fps[part.fp] || d.fps[d.fp])[0];
    if (part.type === 'IC') { const n = M.footprintOf(part).pads.length; return (part.fp === 'soic' ? 'SOIC-' : 'DIP-') + n; }
    if (part.type === 'J') return 'PinHeader_1x' + (part.n || 2) + '_2.54mm';
    if (part.type === 'JT') return 'TerminalBlock_1x' + (part.n || 2) + '_5.08mm';
    return label;
  }

  function buildFiles(pr, base) {
    base = (base || pr.name || 'board').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'board';
    const b = pr.board, R = pr.rules, H = b.h;
    const date = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const nets = M.computeNets(pr), info = M.boardPads(pr, nets);
    const files = [];

    const cu = [new Gerber('Copper,L1,Top', 'Positive', H), new Gerber('Copper,L2,Bot', 'Positive', H)];
    for (const p of info.pads) for (const l of p.layers) cu[l].pad(p);
    for (const t of pr.traces) cu[t.layer].path(cu[t.layer].ap('C', t.w || R.trace), t.pts);
    for (const v of pr.vias) for (const g of cu) g.flash(g.ap('C', v.d || R.via), v.x, v.y);

    const mask = [new Gerber('Soldermask,Top', 'Negative', H), new Gerber('Soldermask,Bot', 'Negative', H)];
    for (const p of info.pads) { mask[0].pad(p, R.mask); if (p.drill) mask[1].pad(p, R.mask); }
    for (const h of info.holes) for (const g of mask) g.flash(g.ap('C', h.d + 2 * R.mask), h.x, h.y);

    const silk = new Gerber('Legend,Top', 'Positive', H), sd = silk.ap('C', R.silk);
    for (const s of M.silkSegments(pr, info)) silk.path(sd, [[s[0], s[1]], [s[2], s[3]]]);

    const smdPads = info.pads.filter(p => !p.drill);
    const paste = new Gerber('Paste,Top', 'Positive', H);
    for (const p of smdPads) paste.pad(p);

    const edge = new Gerber('Profile,NP', 'Positive', H);
    edge.path(edge.ap('C', 0.1), G.boardOutline(b, 16));

    files.push({ name: base + '-F_Cu.GTL', data: cu[0].text(date) }, { name: base + '-B_Cu.GBL', data: cu[1].text(date) },
      { name: base + '-F_Mask.GTS', data: mask[0].text(date) }, { name: base + '-B_Mask.GBS', data: mask[1].text(date) },
      { name: base + '-F_Silkscreen.GTO', data: silk.text(date) });
    if (smdPads.length) files.push({ name: base + '-F_Paste.GTP', data: paste.text(date) });
    files.push({ name: base + '-Edge_Cuts.GKO', data: edge.text(date) });

    const pth = info.pads.filter(p => p.drill).map(p => ({ x: p.x, y: p.y, d: p.drill })).concat(pr.vias.map(v => ({ x: v.x, y: v.y, d: v.drill || R.viaDrill })));
    files.push({ name: base + '-PTH.DRL', data: excellon(pth, true, H, date) });
    if (info.holes.length) files.push({ name: base + '-NPTH.DRL', data: excellon(info.holes, false, H, date) });

    // BOM, grouped by value + footprint
    const groups = new Map();
    for (const p of pr.parts) {
      const d = P.lib.DEFS[p.type]; if (!d.fps || p.type === 'MH') continue;
      const k = p.value + '|' + fpName(p);
      if (!groups.has(k)) groups.set(k, { value: p.value, fp: fpName(p), name: d.name, refs: [], smd: !!M.footprintOf(p).smd });
      groups.get(k).refs.push(p.ref);
    }
    const bom = [['Comment', 'Designator', 'Footprint', 'Quantity', 'Type', 'Mount']];
    for (const g of [...groups.values()].sort((a, b) => a.refs[0].localeCompare(b.refs[0], undefined, { numeric: true })))
      bom.push([g.value, g.refs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(','), g.fp, g.refs.length, g.name, g.smd ? 'SMD' : 'THT']);
    files.push({ name: base + '-BOM.csv', data: bom.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n' });

    const cpl = [['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation']];
    for (const p of pr.parts) { if (!M.footprintOf(p) || p.type === 'MH') continue; cpl.push([p.ref, p.bx.toFixed(3) + 'mm', (H - p.by).toFixed(3) + 'mm', 'Top', String((360 - (p.brot || 0)) % 360)]); }
    files.push({ name: base + '-CPL.csv', data: cpl.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n' });

    const readme = [
      'Made with the hammi.ca PCB designer, ' + date,
      '',
      'Board: ' + b.w + ' x ' + b.h + ' mm, 2 copper layers, ' + (b.thick || 1.6) + ' mm thick, corner radius ' + (b.r || 0) + ' mm.',
      'Units mm. Gerber RS-274X with X2 attributes, format 4.6. Excellon drill, metric, decimal.',
      'Smallest trace ' + R.trace + ' mm, clearance ' + R.clearance + ' mm, via ' + R.via + ' / ' + R.viaDrill + ' mm drill (tented).',
      'Solder mask colour asked for: ' + b.mask + '. Surface finish: ' + (b.finish === 'enig' ? 'ENIG' : 'HASL') + '.',
      '',
      'Files:',
      '  *-F_Cu.GTL / *-B_Cu.GBL        top and bottom copper',
      '  *-F_Mask.GTS / *-B_Mask.GBS    solder mask openings',
      '  *-F_Silkscreen.GTO             top legend',
      smdPads.length ? '  *-F_Paste.GTP                  top paste stencil' : null,
      '  *-Edge_Cuts.GKO                board outline',
      '  *-PTH.DRL / *-NPTH.DRL         plated and non-plated holes',
      '  *-BOM.csv / *-CPL.csv          parts list and placement (for assembly)',
      pr.firmware ? '  *-firmware/*.ino               Arduino sketch for the Nano (open in the Arduino IDE)' : null,
      '  *-project.json                 open this in hammi.ca/pcb to edit the board again',
      '',
      'Upload this zip as-is to most PCB makers (JLCPCB, PCBWay, OSH Park, Aisler).',
      'Always look at their Gerber viewer before you pay.'
    ].filter(x => x !== null).join('\r\n');
    files.push({ name: base + '-README.txt', data: readme + '\r\n' });
    if (pr.firmware) files.push({ name: base + '-firmware/' + base + '-firmware.ino', data: pr.firmware });
    files.push({ name: base + '-project.json', data: JSON.stringify(pr, null, 1) });
    return { base, files };
  }

  /* ---------- tiny ZIP writer (stored, no compression) ---------- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    const now = new Date();
    const dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    }
    const csize = central.reduce((s, a) => s + a.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
    const all = parts.concat(central, [new Uint8Array(e.buffer)]);
    const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0)); let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  P.exporter = { buildFiles, zip, crc32, fpName };
})(globalThis.PCB = globalThis.PCB || {});
