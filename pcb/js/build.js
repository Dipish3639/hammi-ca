/* hammi.ca PCB: "build" mode. You drop blocks (screen, dial, buttons,
   LEDs, knobs, buzzer, light sensor) on the board; this wires them all to an
   Arduino Nano, adds the resistors they need, and writes the firmware. */
(function (P) {
  'use strict';
  const M = P.model, G = P.geom, DEFS = P.lib.DEFS;

  const ROLE = { OLED: 'screen', ENC: 'dial', SW: 'button', LED: 'led', KNOB: 'knob', BUZ: 'buzzer', LDR: 'light', NANO: 'brain' };
  const BLOCKS = [
    ['OLED', 'Screen', '128 × 64 OLED'], ['ENC', 'Dial', 'turn + push'], ['SW', 'Button', 'push button'], ['LED', 'LED', 'light, dimmable'],
    ['KNOB', 'Knob', 'turn to set a level'], ['BUZ', 'Buzzer', 'beeps and tones'], ['LDR', 'Light sensor', 'measures light'], ['NANO', 'Arduino Nano', 'the brain, added for you']
  ];
  const PIN = {}; // Nano pin name -> symbol pin number
  DEFS.NANO.sym().pins.forEach(p => { if (!(p.name in PIN)) PIN[p.name] = p.n; });

  function connect(pr) {
    const msgs = [];
    // 1. throw away what we generated last time
    const autoIds = new Set(pr.parts.filter(p => p.auto).map(p => p.id));
    pr.parts = pr.parts.filter(p => !p.auto);
    const blocks = pr.parts.filter(p => p.block);
    const blockIds = new Set(blocks.map(p => p.id));
    pr.wires = pr.wires.filter(w => !w.auto && !autoIds.has(w.a.p) && !autoIds.has(w.b.p) && !blockIds.has(w.a.p) && !blockIds.has(w.b.p));
    pr.traces = []; pr.vias = [];

    let brain = blocks.find(p => p.type === 'NANO');
    if (!brain) { brain = M.addPart(pr, 'NANO', { block: true, bx: -40, by: 25 }); msgs.push('Added an Arduino Nano as the brain.'); }
    const pos = p => p.by * 1000 + p.bx;
    const of = role => blocks.filter(p => ROLE[p.type] === role && p !== brain).sort((a, b) => pos(a) - pos(b));
    const screens = of('screen'), dials = of('dial'), buttons = of('button'), leds = of('led'), knobs = of('knob'), buzzers = of('buzzer'), lights = of('light');
    const extra = [];
    if (screens.length > 1) extra.push(...screens.splice(1));
    if (dials.length > 1) extra.push(...dials.splice(1));
    if (buzzers.length > 1) extra.push(...buzzers.splice(1));

    // 2. hand out Nano pins
    const dig = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], ana = ['A0', 'A1', 'A2', 'A3', 'A6', 'A7'];
    const take = (pref) => { for (const d of pref) { const i = dig.indexOf(d); if (i >= 0) { dig.splice(i, 1); return d; } } return dig.length ? dig.shift() : null; };
    const map = []; // {part, role, pins:{...}}
    if (dials.length) { take([2]); take([3]); take([4]); map.push({ part: dials[0], role: 'dial', a: 2, b: 3, sw: 4 }); }
    const pwm = [5, 6, 9, 10].concat(buzzers.length ? [] : [11], dials.length ? [] : [3]);
    for (const l of leds) { const d = take(pwm); if (d == null) { extra.push(l); continue; } map.push({ part: l, role: 'led', pin: d, pwm: [3, 5, 6, 9, 10, 11].includes(d) }); }
    if (buzzers.length) { const d = take([8, 7, 12]); if (d == null) extra.push(buzzers[0]); else map.push({ part: buzzers[0], role: 'buzzer', pin: d }); }
    for (const b of buttons) { const d = take([7, 8, 12, 13, 11, 10, 9]); if (d == null) { extra.push(b); continue; } map.push({ part: b, role: 'button', pin: d }); }
    for (const k of knobs) { const a = ana.shift(); if (!a) { extra.push(k); continue; } map.push({ part: k, role: 'knob', pin: a }); }
    for (const l of lights) { const a = ana.shift(); if (!a) { extra.push(l); continue; } map.push({ part: l, role: 'light', pin: a }); }
    if (screens.length) map.push({ part: screens[0], role: 'screen' });
    for (const x of extra) msgs.push('No room for ' + x.ref + ' (' + DEFS[x.type].name + '): ' + (['screen', 'dial', 'buzzer'].includes(ROLE[x.type]) ? 'only one of these is supported for now.' : 'the Nano is out of pins.'));

    // 3. draw the schematic: Nano in the middle, each block in a column with labels
    brain.sx = 0; brain.sy = 0; brain.srot = 0;
    const label = (part, n, name) => {
      const pin = M.symPins(part).find(q => q.n === n);
      const dx = pin.dx || -1, dy = pin.dy || 0;
      const rot = dx > 0 ? 0 : dx < 0 ? 180 : dy < 0 ? 90 : 270;
      const L = M.addPart(pr, 'NL', { value: name, sx: pin.x + dx * 2, sy: pin.y + dy * 2, srot: rot, auto: true });
      L.ref = M.nextRef(pr, '#NL');
      pr.wires.push({ a: { p: part.id, n }, b: { p: L.id, n: 1 }, auto: true });
    };
    const wire = (a, an, b, bn) => pr.wires.push({ a: { p: a.id, n: an }, b: { p: b.id, n: bn }, auto: true });
    const support = (type, value, at) => { const p = M.addPart(pr, type, Object.assign({ value, auto: true }, at)); return p; };
    label(brain, PIN['5V'], '+5V'); label(brain, 4, 'GND'); label(brain, 29, 'GND');
    const used = new Set();
    let col = 0, y = -18;
    const slot = (h) => { if (y + h > 22) { col++; y = -18; } const r = { x: 34 + col * 30, y }; y += h; return r; };
    for (const m of map) {
      const p = m.part;
      if (m.role === 'screen') {
        const s = slot(12); Object.assign(p, { sx: s.x, sy: s.y + 3, srot: 0 });
        label(p, 1, 'GND'); label(p, 2, '+5V'); label(p, 3, 'SCL'); label(p, 4, 'SDA');
        label(brain, PIN.A5, 'SCL'); label(brain, PIN.A4, 'SDA'); used.add('A4'); used.add('A5');
      } else if (m.role === 'dial') {
        const s = slot(12); Object.assign(p, { sx: s.x, sy: s.y + 3, srot: 0 });
        label(p, 1, 'D2'); label(p, 2, 'GND'); label(p, 3, 'D3'); label(p, 4, 'D4'); label(p, 5, 'GND');
        for (const d of ['D2', 'D3', 'D4']) { label(brain, PIN[d], d); used.add(d); }
      } else if (m.role === 'led') {
        const s = slot(6), nm = 'D' + m.pin;
        const r = support('R', '330', { sx: s.x - 4, sy: s.y, srot: 0 });
        Object.assign(p, { sx: s.x + 4, sy: s.y, srot: 0 });
        label(r, 1, nm); wire(r, 2, p, 2); label(p, 1, 'GND');
        label(brain, PIN[nm], nm); used.add(nm);
      } else if (m.role === 'buzzer') {
        const s = slot(8), nm = 'D' + m.pin;
        const r = support('R', '100', { sx: s.x - 8, sy: s.y - 1, srot: 0 });
        Object.assign(p, { sx: s.x + 4, sy: s.y, srot: 0 });
        label(r, 1, nm); wire(r, 2, p, 1); label(p, 2, 'GND');
        label(brain, PIN[nm], nm); used.add(nm);
      } else if (m.role === 'button') {
        const s = slot(6), nm = 'D' + m.pin;
        Object.assign(p, { sx: s.x, sy: s.y, srot: 0 });
        label(p, 1, nm); label(p, 2, 'GND'); label(brain, PIN[nm], nm); used.add(nm);
      } else if (m.role === 'knob') {
        const s = slot(8);
        Object.assign(p, { sx: s.x, sy: s.y + 2, srot: 0 });
        label(p, 1, 'GND'); label(p, 3, '+5V'); label(p, 2, m.pin); label(brain, PIN[m.pin], m.pin); used.add(m.pin);
      } else if (m.role === 'light') {
        const s = slot(8);
        Object.assign(p, { sx: s.x - 4, sy: s.y, srot: 0 });
        const r = support('R', '10k', { sx: s.x + 8, sy: s.y + 1, srot: 90 });
        label(p, 1, '+5V'); wire(p, 2, r, 1); label(r, 2, 'GND'); label(p, 2, m.pin); label(brain, PIN[m.pin], m.pin); used.add(m.pin);
      }
    }
    // park new support parts next to the board so auto-place picks them up
    for (const p of pr.parts) if (p.auto && M.footprintOf(p)) { p.bx = -20; p.by = 10; p.locked = false; }
    for (const p of blocks) if (p !== brain || p.locked) p.locked = true;

    const fw = firmware(pr, map);
    pr.firmware = fw;
    return { ok: true, msgs, map, firmware: fw, brain };
  }

  /* ---------- Arduino sketch ---------- */
  function firmware(pr, map) {
    const get = r => map.filter(m => m.role === r);
    const leds = get('led'), btns = get('button'), knobs = get('knob'), lights = get('light'), dial = get('dial')[0], buz = get('buzzer')[0], scr = get('screen')[0];
    const name = (pr.name || 'board').replace(/[^\w .-]/g, '');
    const L = [];
    const ln = (...a) => L.push(...a);
    ln('// ' + name + ' — firmware written by the hammi.ca PCB designer',
      '// Board: Arduino Nano (ATmega328P). In the Arduino IDE pick Tools > Board > Arduino Nano,',
      '// (older clones: Tools > Processor > ATmega328P (Old Bootloader)), then press Upload.');
    if (scr) ln('// Needs two libraries (Sketch > Include Library > Manage Libraries): "Adafruit SSD1306" and "Adafruit GFX".');
    ln('//', '// What it does:');
    if (dial) ln('//   Dial (' + dial.part.ref + '): turn to set the level 0-100, push to switch every light on or off.');
    if (knobs.length) ln('//   Knob' + (knobs.length > 1 ? 's' : '') + ' (' + knobs.map(k => k.part.ref).join(', ') + '): read as 0-100.' + (!dial ? ' The first knob sets the level.' : ''));
    if (btns.length) ln('//   Button' + (btns.length > 1 ? 's' : '') + ' (' + btns.map(b => b.part.ref).join(', ') + '): ' + (leds.length ? 'button N toggles LED N.' : 'each one beeps a different note.'));
    if (leds.length) ln('//   LED' + (leds.length > 1 ? 's' : '') + ' (' + leds.map(b => b.part.ref).join(', ') + '): glow at the current level when switched on.');
    if (lights.length) ln('//   Light sensor' + (lights.length > 1 ? 's' : '') + ' (' + lights.map(b => b.part.ref).join(', ') + '): read as 0-100 (brighter is higher).');
    if (buz) ln('//   Buzzer (' + buz.part.ref + '): clicks when the dial turns, beeps on button presses.');
    if (scr) ln('//   Screen (' + scr.part.ref + '): shows everything live.'); else ln('//   No screen, so values go to the Serial Monitor at 115200 baud.');
    ln('', '// ---- pin map (matches the board) ----');
    if (dial) ln('const byte DIAL_A = 2, DIAL_B = 3, DIAL_PUSH = 4;');
    if (leds.length) ln('const byte LED_PINS[] = {' + leds.map(l => l.pin).join(', ') + '};', 'const bool LED_PWM[] = {' + leds.map(l => l.pwm ? 'true' : 'false').join(', ') + '};', 'const byte LED_COUNT = ' + leds.length + ';', 'bool ledOn[LED_COUNT];');
    if (btns.length) ln('const byte BTN_PINS[] = {' + btns.map(b => b.pin).join(', ') + '};', 'const byte BTN_COUNT = ' + btns.length + ';', 'bool btnDown[BTN_COUNT];', 'unsigned long btnTime[BTN_COUNT];');
    if (knobs.length) ln('const byte KNOB_PINS[] = {' + knobs.map(k => k.pin).join(', ') + '};', 'const byte KNOB_COUNT = ' + knobs.length + ';', 'int knob[KNOB_COUNT];');
    if (lights.length) ln('const byte LIGHT_PINS[] = {' + lights.map(k => k.pin).join(', ') + '};', 'const byte LIGHT_COUNT = ' + lights.length + ';', 'int light[LIGHT_COUNT];');
    if (buz) ln('const byte BUZZER = ' + buz.pin + ';');
    if (scr) ln('', '#include <Wire.h>', '#include <Adafruit_GFX.h>', '#include <Adafruit_SSD1306.h>', 'Adafruit_SSD1306 screen(128, 64, &Wire, -1);', 'bool screenOk = false;');
    ln('', 'int level = 50;          // 0-100, set by the dial or the first knob', 'bool allOn = true;');
    if (dial) ln('int dialSteps = 0;', 'byte dialState = 0;', 'bool pushDown = false;', 'unsigned long pushTime = 0;');
    ln('', 'void beep(int hz, int ms) {', buz ? '  tone(BUZZER, hz, ms);' : '  (void)hz; (void)ms;   // no buzzer on this board', '}');
    ln('', 'void setup() {');
    if (dial) ln('  pinMode(DIAL_A, INPUT_PULLUP);', '  pinMode(DIAL_B, INPUT_PULLUP);', '  pinMode(DIAL_PUSH, INPUT_PULLUP);', '  dialState = (digitalRead(DIAL_A) << 1) | digitalRead(DIAL_B);');
    if (leds.length) ln('  for (byte i = 0; i < LED_COUNT; i++) { pinMode(LED_PINS[i], OUTPUT); ledOn[i] = true; }');
    if (btns.length) ln('  for (byte i = 0; i < BTN_COUNT; i++) pinMode(BTN_PINS[i], INPUT_PULLUP);');
    if (buz) ln('  pinMode(BUZZER, OUTPUT);');
    if (scr) ln('  screenOk = screen.begin(SSD1306_SWITCHCAPVCC, 0x3C);   // most modules are 0x3C, some are 0x3D', '  if (screenOk) { screen.clearDisplay(); screen.display(); }');
    ln('  Serial.begin(115200);', '  beep(1760, 60);', '}');
    if (dial) ln('', '// quadrature decoder: 4 steps per click on most EC11 encoders',
      'void readDial() {',
      '  static const int8_t table[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};',
      '  byte now = (digitalRead(DIAL_A) << 1) | digitalRead(DIAL_B);',
      '  if (now == dialState) return;',
      '  dialSteps += table[(dialState << 2) | now];',
      '  dialState = now;',
      '  if (dialSteps >= 4 || dialSteps <= -4) {',
      '    int dir = dialSteps > 0 ? 1 : -1;',
      '    dialSteps = 0;',
      '    level = constrain(level + dir * 5, 0, 100);',
      '    beep(dir > 0 ? 2400 : 1900, 4);',
      '  }',
      '}');
    ln('', 'void readInputs() {');
    if (dial) ln('  readDial();', '  bool p = digitalRead(DIAL_PUSH) == LOW;', '  if (p && !pushDown && millis() - pushTime > 40) { allOn = !allOn; beep(allOn ? 1320 : 660, 50); pushTime = millis(); }', '  pushDown = p;');
    if (knobs.length) ln('  for (byte i = 0; i < KNOB_COUNT; i++) knob[i] = map(analogRead(KNOB_PINS[i]), 0, 1023, 0, 100);' + (!dial ? '\n  level = knob[0];' : ''));
    if (lights.length) ln('  for (byte i = 0; i < LIGHT_COUNT; i++) light[i] = map(analogRead(LIGHT_PINS[i]), 0, 1023, 0, 100);');
    if (btns.length) {
      ln('  for (byte i = 0; i < BTN_COUNT; i++) {', '    bool d = digitalRead(BTN_PINS[i]) == LOW;', '    if (d && !btnDown[i] && millis() - btnTime[i] > 40) {   // new press, debounced', '      btnTime[i] = millis();');
      if (leds.length) ln('      byte led = i % LED_COUNT;', '      ledOn[led] = !ledOn[led];', '      beep(ledOn[led] ? 1500 : 900, 40);');
      else ln('      beep(880 + i * 220, 80);');
      ln('    }', '    btnDown[i] = d;', '  }');
    }
    ln('}');
    if (leds.length) ln('', 'void updateLeds() {', '  byte pwm = map(level, 0, 100, 0, 255);', '  for (byte i = 0; i < LED_COUNT; i++) {', '    bool on = allOn && ledOn[i] && level > 0;', '    if (LED_PWM[i]) analogWrite(LED_PINS[i], on ? pwm : 0);', '    else digitalWrite(LED_PINS[i], on ? HIGH : LOW);', '  }', '}');
    if (scr) {
      ln('', 'void bar(int x, int y, int w, int value) {', '  screen.drawRect(x, y, w, 6, SSD1306_WHITE);', '  screen.fillRect(x + 1, y + 1, (long)(w - 2) * value / 100, 4, SSD1306_WHITE);', '}');
      ln('', 'void drawScreen() {', '  screen.clearDisplay();', '  screen.setTextSize(1);', '  screen.setTextColor(SSD1306_WHITE);', '  screen.setCursor(0, 0);', '  screen.print(F("' + name.slice(0, 21).replace(/"/g, '') + '"));', '  screen.drawFastHLine(0, 10, 128, SSD1306_WHITE);');
      ln('  int y = 14;');
      ln('  screen.setCursor(0, y); screen.print(F("LEVEL")); screen.setCursor(40, y); screen.print(level); bar(64, y, 64, level); y += 10;');
      if (knobs.length) ln('  for (byte i = 0; i < KNOB_COUNT && y < 56; i++) { screen.setCursor(0, y); screen.print(F("KNOB")); screen.print(i + 1); screen.setCursor(40, y); screen.print(knob[i]); bar(64, y, 64, knob[i]); y += 10; }');
      if (lights.length) ln('  for (byte i = 0; i < LIGHT_COUNT && y < 56; i++) { screen.setCursor(0, y); screen.print(F("LIGHT")); screen.setCursor(40, y); screen.print(light[i]); bar(64, y, 64, light[i]); y += 10; }');
      if (leds.length) ln('  for (byte i = 0; i < LED_COUNT; i++) {', '    int x = i * 12, yy = 56;', '    if (allOn && ledOn[i]) screen.fillCircle(x + 4, yy + 4, 3, SSD1306_WHITE); else screen.drawCircle(x + 4, yy + 4, 3, SSD1306_WHITE);', '  }');
      if (btns.length) ln('  for (byte i = 0; i < BTN_COUNT; i++) {', '    int x = 120 - i * 10;', '    if (btnDown[i]) screen.fillRect(x, 56, 8, 8, SSD1306_WHITE); else screen.drawRect(x, 56, 8, 8, SSD1306_WHITE);', '  }');
      ln('  screen.display();', '}');
    }
    ln('', 'void report() {', '  Serial.print(F("level=")); Serial.print(level);');
    if (knobs.length) ln('  for (byte i = 0; i < KNOB_COUNT; i++) { Serial.print(F(" knob")); Serial.print(i + 1); Serial.print(\'=\'); Serial.print(knob[i]); }');
    if (lights.length) ln('  for (byte i = 0; i < LIGHT_COUNT; i++) { Serial.print(F(" light")); Serial.print(i + 1); Serial.print(\'=\'); Serial.print(light[i]); }');
    if (btns.length) ln('  for (byte i = 0; i < BTN_COUNT; i++) { Serial.print(F(" btn")); Serial.print(i + 1); Serial.print(\'=\'); Serial.print(btnDown[i] ? 1 : 0); }');
    ln('  Serial.println();', '}');
    ln('', 'void loop() {', '  readInputs();');
    if (leds.length) ln('  updateLeds();');
    if (scr) ln('  static unsigned long lastDraw = 0;', '  if (screenOk && millis() - lastDraw >= 40) { lastDraw = millis(); drawScreen(); }');
    ln('  static unsigned long lastReport = 0;', '  if (millis() - lastReport >= 250) { lastReport = millis(); report(); }', '}', '');
    return L.join('\n');
  }

  P.build = { connect, firmware, BLOCKS, ROLE };
})(globalThis.PCB = globalThis.PCB || {});
