// The race itself: cars, tyres, fuel, weather, traffic, incidents, pit stops, and each car's AI,
// which reads its team's strategy, decides what to do, and says what it's thinking.
// Everything is plain data so the whole race can be saved to disk and picked up after a restart.
'use strict';

const T = require('./track');

const TANK = 90;                 // litres
const BURN = 3.1 / T.LENGTH;     // litres per metre at balanced pace
const COMPOUNDS = {
  //        dry grip   laps of life   kind
  soft:   { grip: 1.000, life: 16, kind: 'slick' },
  medium: { grip: 0.990, life: 26, kind: 'slick' },
  hard:   { grip: 0.980, life: 38, kind: 'slick' },
  inter:  { grip: 0.930, life: 24, kind: 'inter' },
  wet:    { grip: 0.890, life: 26, kind: 'wet' },
};
const START_CLOCK = 9 * 3600;    // track time at the green flag, unless the race says otherwise

const DEFAULT_STRATEGY = {
  aggression: 3,        // 1 save the car .. 5 flat out
  nightAggression: 0,   // 0 = same as day, otherwise 1..5 between 9 pm and 6 am
  dryTyre: 'auto',      // auto | soft | medium | hard
  tyreChangeAt: 75,     // % worn before fresh tyres
  doubleStint: true,    // keep tyres through a fuel stop when they're still good
  fuelReserve: 1,       // laps of fuel kept in hand before boxing
  fuelLoad: 'full',     // full | light (60% tank: lighter, faster, one more stop)
  rainCall: 'normal',   // early | normal | late
  pitUnderYellow: true, // take a cheap stop when the yellow flag slows the field
  stintHours: 2,        // hours each driver stays in before swapping (0.5 to 4)
  traffic: 'balanced',  // defend | balanced | letby
  finalPush: true,      // flat out in the last hour
};

const PERSONALITIES = ['calculated', 'bold', 'steady'];

// ---- small helpers -------------------------------------------------------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pct = (v) => Math.round(v * 100) + '%';
const fmtGap = (s) => (s < 10 ? s.toFixed(1) : Math.round(s)) + 's';
function fmtLap(t) {
  if (!t) return '-';
  const m = Math.floor(t / 60);
  return m + ':' + (t - m * 60).toFixed(1).padStart(4, '0');
}
function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sanitizeStrategy(input, base = DEFAULT_STRATEGY) {
  const s = { ...base };
  const i = input || {};
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (int(i.aggression, 1, 5)) s.aggression = i.aggression;
  if (int(i.nightAggression, 0, 5)) s.nightAggression = i.nightAggression;
  if (['auto', 'soft', 'medium', 'hard'].includes(i.dryTyre)) s.dryTyre = i.dryTyre;
  if (int(i.tyreChangeAt, 40, 100)) s.tyreChangeAt = i.tyreChangeAt;
  if (typeof i.doubleStint === 'boolean') s.doubleStint = i.doubleStint;
  if (int(i.fuelReserve, 0, 4)) s.fuelReserve = i.fuelReserve;
  if (['full', 'light'].includes(i.fuelLoad)) s.fuelLoad = i.fuelLoad;
  if (['early', 'normal', 'late'].includes(i.rainCall)) s.rainCall = i.rainCall;
  if (typeof i.pitUnderYellow === 'boolean') s.pitUnderYellow = i.pitUnderYellow;
  if (typeof i.stintHours === 'number' && i.stintHours >= 0.5 && i.stintHours <= 4) s.stintHours = Math.round(i.stintHours * 2) / 2;
  if (['defend', 'balanced', 'letby'].includes(i.traffic)) s.traffic = i.traffic;
  if (typeof i.finalPush === 'boolean') s.finalPush = i.finalPush;
  return s;
}

function randomStrategy() {
  return sanitizeStrategy({
    aggression: pick([2, 3, 3, 4, 4, 5]),
    nightAggression: pick([0, 0, 2, 3]),
    dryTyre: pick(['auto', 'auto', 'soft', 'medium', 'hard']),
    tyreChangeAt: pick([60, 70, 75, 80, 90]),
    doubleStint: Math.random() < 0.6,
    fuelReserve: pick([0, 1, 1, 2]),
    fuelLoad: Math.random() < 0.8 ? 'full' : 'light',
    rainCall: pick(['early', 'normal', 'normal', 'late']),
    pitUnderYellow: Math.random() < 0.8,
    stintHours: pick([1, 1.5, 2, 2, 2.5, 3]),
    traffic: pick(['defend', 'balanced', 'balanced', 'letby']),
    finalPush: Math.random() < 0.8,
  });
}

// ---- weather -----------------------------------------------------------------
function makeWeather(seed, duration) {
  const r = mulberry(seed);
  const showers = [];
  const count = 1 + Math.floor(r() * 4); // 1 to 4 showers in a race
  for (let i = 0; i < count; i++) {
    showers.push({ start: Math.round(r() * duration * 0.92), dur: Math.round(900 + r() * 5400), peak: Math.round((0.25 + r() * 0.75) * 100) / 100 });
  }
  showers.sort((a, b) => a.start - b.start);
  return { showers, wet: 0, rain: 0 };
}

function rainAt(w, t) {
  let r = 0;
  for (const s of w.showers) {
    if (t < s.start || t > s.start + s.dur) continue;
    const x = (t - s.start) / s.dur;                  // 0..1 through the shower
    r = Math.max(r, s.peak * Math.sin(Math.PI * x) ** 0.6);
  }
  return r;
}

// What the pit wall's radar says: rain in the next 30 minutes, fuzzier further out.
function forecast(w, t) {
  for (let m = 0; m <= 30; m += 2) {
    const r = rainAt(w, t + m * 60);
    if (r > 0.15) return { rainIn: m, strength: r, sure: clamp(1 - m / 45, 0.3, 1) };
  }
  return null;
}

let startClock = START_CLOCK;     // the clock of the race being stepped or sent
const clockOf = (t) => (startClock + t) % 86400;
const isNight = (t) => { const c = clockOf(t) / 3600; return c >= 21 || c < 6; };

// ---- creating a race ---------------------------------------------------------
function newRace({ duration, number, startClock: clock = START_CLOCK }) {
  const seed = Math.floor(Math.random() * 2 ** 31);
  return {
    id: Date.now().toString(36), number, seed, duration, startClock: clock,
    simTime: 0, status: 'running', fcy: null, paceV2: true,
    weather: makeWeather(seed, duration),
    cars: [], feed: [], results: null, finishedAt: null,
    leaderId: null, lastHour: 0, night: false,
  };
}

function newCar(team, { start, grid }) {
  const c = {
    id: team.id, name: team.name, color: team.color, number: team.number, bot: !!team.bot,
    personality: team.personality || pick(PERSONALITIES),
    lap: 0, s: start ? -grid * 12 : 0, // grid slots 12 m apart behind the line
    v: 0, state: start ? 'track' : 'garage', service: start ? 0 : 45,
    tyre: { c: 'medium', wear: 0, laps: 0 },
    fuel: TANK, damage: 0, limp: false,
    driver: 0, drivers: team.drivers.slice(), tired: team.drivers.map(() => 0), stintStart: 0,
    plan: null, box: false, pits: 0, lapStart: 0, lastLap: 0, bestLap: 0,
    burnLap: 3.1, lapEma: T.lapTime,
    pace: rnd(0.994, 1.006), form: 1, heldUp: 0, passing: 0, passes: 0,
    nextThought: rnd(20, 120), lastAhead: null,
    finished: false, retired: false, why: '',
    thoughts: [],
  };
  return c;
}

// ---- the AI ------------------------------------------------------------------
// Each personality has its own voice. {x} placeholders are filled from the situation.
const VOICE = {
  calculated: {
    status: [
      'Fuel for {fuelLaps} laps, tyres at {wear}. Gap ahead {ahead}. Plan holds.',
      'Lap {lap}. Last lap {last}, {trend} than the lap before. Staying on target.',
      'Running P{pos}. The numbers say patience: {ahead} to {aheadName}.',
      'Tyres {wear} worn. Model says {tyreLaps} good laps left on them.',
    ],
    chase: ['{aheadName} is {ahead} ahead and I\'m {delta} a lap quicker. Catch in about {catch} laps.', 'Closing on {aheadName}. No need to force it yet.'],
    defend: ['{behindName} is {behind} behind. Covering the inside into {corner}.', 'Pressure from {behindName}. Keeping lines tight, not wasting tyres.'],
    pitFuel: ['Box this lap: fuel for {fuelLaps} laps, reserve is {reserve}. {extra}', 'Fuel window open. Pitting now as planned. {extra}'],
    pitTyre: ['Tyres at {wear}. Past our {limit} line, so new {tyre} this stop.', 'Grip is dropping off. Boxing for {tyre}.'],
    pitWeather: ['Track wetness {wetPct}. {fromTyre} are the wrong tyre now. Box for {tyre}.', 'Crossover point reached. Switching to {tyre}.'],
    pitYellow: ['Yellow flag, so a stop costs less. Taking it now.', 'Full course yellow. Cheap stop, boxing.'],
    hold: ['Rain on the radar in {rainIn} min but the track is still {wetPct} wet. Holding on {tyre} one more lap.'],
    passed: ['Done. Past {otherName} at {corner}.', 'Clean move on {otherName}. Up to P{pos}.'],
    lost: ['{otherName} got by at {corner}. Not fighting it, I\'ll get them back on strategy.'],
    heldUp: ['Stuck behind {aheadName}, losing about {loss} a lap. Waiting for the straight.'],
    incident: ['Lost the rear at {corner}. {damage}', 'Mistake at {corner}. {damage}'],
    night: ['Night now. Track is cooler, tyres will last longer.'],
    dawn: ['Sun\'s coming up. Grip will come back as the track warms.'],
    rain: ['Rain starting. Watching the lap times before calling it.'],
    swap: ['{driver} in. {prev} did {stint} at the wheel.'],
    push: ['Last hour. All the margins we saved go now.'],
    tired: ['{driver} is at {tiredPct} tiredness. Lap times are drifting, a swap is due soon.', 'Reaction times dropping. {stint} in the seat is a long time.'],
    out: ['Out of the pits on {tyre}, {fuel}L in. Rejoined P{pos}.'],
  },
  bold: {
    status: [
      'P{pos}. {ahead} to {aheadName}. I want that place.',
      'Lap {lap}, did a {last}. Car feels good, let\'s go.',
      'Tyres {wear} done but they\'ve got more in them than the team thinks.',
      'Fuel for {fuelLaps} laps. {fuelMood}',
    ],
    chase: ['{aheadName} {ahead} up the road. I\'ll have them in {catch} laps.', 'Reeling in {aheadName}. Going for it at {corner}.'],
    defend: ['{behindName} wants it. They\'re not getting it.', 'Door shut at {corner}. {behindName} can wait.'],
    pitFuel: ['Running on fumes, box! {extra}', 'In for fuel. Quick one please. {extra}'],
    pitTyre: ['Tyres are gone. Fresh {tyre} and I\'ll fly.', 'No grip left. Boxing for {tyre}.'],
    pitWeather: ['It\'s a lake out here. {tyre}, now!', 'Going to {tyre}. Gamble or genius, we\'ll see.'],
    pitYellow: ['Yellow! Free stop, I\'m coming in.'],
    hold: ['Rain in {rainIn} min? I\'ll risk it on {tyre}.', 'Wet patches but I\'m staying out on {tyre}. Brave call.'],
    passed: ['Sent it at {corner}! Bye {otherName}.', 'Got {otherName}! P{pos}!'],
    lost: ['{otherName} took it at {corner}. Taking that back.'],
    heldUp: ['Come on {aheadName}, move! Losing {loss} a lap here.'],
    incident: ['Too hot into {corner}. {damage}', 'Spun it at {corner}. My fault. {damage}'],
    night: ['Dark now. Fewer people want to brake late. Good.'],
    dawn: ['Daylight. Time to go faster.'],
    rain: ['Rain! This is where you win races.'],
    swap: ['{driver} jumps in. Go get them.'],
    push: ['Final hour. Everything we\'ve got.'],
    tired: ['Arms are heavy but I\'m fine. Keep me out.', '{stint} in. Tired, still quick.'],
    out: ['Back out on {tyre}, P{pos}. Let\'s go.'],
  },
  steady: {
    status: [
      'Lap {lap}. Clean laps, {last}. Bringing it home is the job.',
      'P{pos}. {ahead} ahead, {behind} behind. Nice and calm.',
      'Tyres {wear} worn, fuel for {fuelLaps} laps. All in the window.',
      'Smooth through {corner}. No need for heroics.',
    ],
    chase: ['Catching {aheadName} slowly. They\'ll come back to me.'],
    defend: ['{behindName} is quicker. Not worth a crash, I\'ll make it fair.', 'Watching the mirrors for {behindName}.'],
    pitFuel: ['Boxing for fuel as planned. {extra}'],
    pitTyre: ['Tyres at {wear}. Time for {tyre}.'],
    pitWeather: ['Wetness {wetPct}. Safer on {tyre}. Boxing.'],
    pitYellow: ['Yellow flag stop. Sensible timing.'],
    hold: ['A bit of rain, {wetPct}. Staying on {tyre} carefully for now.'],
    passed: ['By {otherName} at {corner}, gave them room.', 'Past {otherName}. P{pos}.'],
    lost: ['Let {otherName} through at {corner}. Not worth the risk.'],
    heldUp: ['Following {aheadName} for now. A pass will come.'],
    incident: ['Ran wide at {corner}. {damage}'],
    night: ['Night stint. Keeping it tidy, eyes on the markers.'],
    dawn: ['Morning. We\'re still here, that\'s what counts.'],
    rain: ['Rain coming. Slowing my inputs down.'],
    swap: ['{driver} takes over. {prev} did a good {stint}.'],
    push: ['Last hour. A bit more pace, still no risks.'],
    tired: ['Getting tired, {tiredPct}. Easing off a touch to stay safe.', 'Long stint. I\'d like to hand over soon.'],
    out: ['Rejoined P{pos} on {tyre}.'],
  },
};

const COOLDOWN = { passed: 90, lost: 90, heldUp: 120, hold: 300, tired: 900, rain: 600 };
function say(race, c, key, vars = {}, toFeed = false) {
  c.said = c.said || {};
  if (COOLDOWN[key] && race.simTime - (c.said[key] ?? -1e9) < COOLDOWN[key]) return;
  c.said[key] = race.simTime;
  const lines = VOICE[c.personality][key] || VOICE.calculated[key];
  if (!lines) return;
  const text = pick(lines).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : '?')).replace(/\s+/g, ' ').trim();
  const th = { t: Math.round(race.simTime), text };
  c.thoughts.push(th);
  if (c.thoughts.length > 40) c.thoughts.splice(0, c.thoughts.length - 40);
  race.events.push({ type: 'thought', car: c.id, ...th });
  if (toFeed) note(race, `${c.name}: "${text}"`, 'radio', c.id);
}

function note(race, text, kind = 'info', car = null) {
  const e = { t: Math.round(race.simTime), text, kind, car };
  race.feed.push(e);
  if (race.feed.length > 200) race.feed.splice(0, race.feed.length - 200);
  race.events.push({ type: 'feed', ...e });
}

// ---- physics -----------------------------------------------------------------
function gripOf(c, wet) {
  const k = COMPOUNDS[c.tyre.c];
  let g;
  if (k.kind === 'slick') g = k.grip * (1 - 0.6 * wet);
  else if (k.kind === 'inter') g = k.grip * (1 - 0.35 * Math.max(0, wet - 0.5));
  else g = k.grip * (1 - 0.05 * wet);
  return g * (1 - 0.08 * c.tyre.wear * c.tyre.wear);
}

function aggressionOf(race, c, st) {
  if (c.limp) return 1;
  if (st.finalPush && race.duration - race.simTime < 3600) return 5;
  if (st.nightAggression && isNight(race.simTime)) return st.nightAggression;
  return st.aggression;
}

// Each driver has a tiredness level 0..1. It rises while they drive (faster at night and when
// pushing) and falls while they rest. Past 0.4 it starts to cost pace and cause mistakes.
function fatigueOf(race, c) {
  return Math.max(0, (c.tired[c.driver] - 0.4) / 0.6);
}
function updateTiredness(race, c, st, dt) {
  for (let i = 0; i < c.tired.length; i++) {
    if (i === c.driver && c.state !== 'stopped' && c.state !== 'garage') {
      const load = (isNight(race.simTime) ? 1.3 : 1) * (1 + 0.1 * (aggressionOf(race, c, st) - 3));
      c.tired[i] = Math.min(1, c.tired[i] + load * dt / (3 * 3600));
    } else c.tired[i] = Math.max(0, c.tired[i] - dt / (1.5 * 3600));
  }
}

function paceOf(race, c, st) {
  const ag = aggressionOf(race, c, st);
  const grip = gripOf(c, race.weather.wet);
  let p = 1 - (1 - grip) * 0.6;
  p *= 1 + 0.004 * (ag - 3);
  p *= 1 - 0.0003 * c.fuel;
  p *= 1 - 0.12 * c.damage;
  p *= 1 - 0.012 * fatigueOf(race, c);
  if (isNight(race.simTime)) p *= 0.996;
  p *= c.pace * c.form;
  if (c.limp) p *= 0.5;
  return p;
}

function wearRate(race, c, st) {
  const k = COMPOUNDS[c.tyre.c];
  const wet = race.weather.wet;
  let r = 1 / (k.life * T.LENGTH);
  if (k.kind === 'slick') r *= 1 - 0.3 * wet;
  if (k.kind === 'inter' && wet < 0.15) r *= 2.5;
  if (k.kind === 'wet' && wet < 0.35) r *= 4;
  r *= 1 + 0.15 * (aggressionOf(race, c, st) - 3);
  if (isNight(race.simTime)) r *= 0.85;
  return r;
}

function riskPerMetre(race, c, st, fighting) {
  const wet = race.weather.wet;
  const kind = COMPOUNDS[c.tyre.c].kind;
  let r = 0.0009 / T.LENGTH * 6.2;
  r *= 1.5 ** (aggressionOf(race, c, st) - 3);
  if (kind === 'slick') r *= 1 + 12 * wet * wet;
  if (kind === 'inter' && wet > 0.75) r *= 2;
  if (isNight(race.simTime)) r *= 1.3;
  r *= 1 + 2 * fatigueOf(race, c);
  if (c.tyre.wear > 0.85) r *= 1 + 10 * (c.tyre.wear - 0.85);
  r *= 1 + c.damage;
  if (fighting) r *= 1.3;
  if (race.fcy) r *= 0.2;
  return r;
}

// ---- pit decisions -------------------------------------------------------------
function tyreKindFor(race, c, st) {
  const wet = race.weather.wet;
  const f = forecast(race.weather, race.simTime);
  const bold = c.personality === 'bold';
  const th = { early: [0.12, 0.55, 0.22], normal: [0.25, 0.65, 0.15], late: [0.4, 0.75, 0.08] }[st.rainCall];
  let toInter = th[0], toWet = th[1], toSlick = th[2];
  if (bold) { toInter += 0.05; toWet += 0.05; toSlick += 0.04; }
  const now = COMPOUNDS[c.tyre.c].kind;
  // rain coming soon pulls the early callers in sooner
  const soonHeavy = f && f.rainIn <= 8 && f.strength > 0.5 && f.sure > 0.6;
  if (wet >= toWet || (soonHeavy && st.rainCall === 'early' && wet > 0.35)) return 'wet';
  if (wet >= toInter || (soonHeavy && st.rainCall === 'early' && wet > 0.05)) return 'inter';
  if (now !== 'slick' && wet > toSlick) return now === 'wet' && wet < toInter ? 'inter' : now; // stay until it's dry enough
  return 'slick';
}

function dryChoice(race, c, st, lapsLeft) {
  if (st.dryTyre !== 'auto') return st.dryTyre;
  if (lapsLeft < 18) return 'soft';
  if (isNight(race.simTime + 1800)) return c.personality === 'steady' ? 'medium' : 'soft';
  return c.personality === 'steady' ? 'hard' : 'medium';
}

function decide(race, c, st) {
  const timeLeft = race.duration - race.simTime;
  const lapsLeft = Math.max(0, Math.ceil(timeLeft / c.lapEma));
  const fuelLaps = c.fuel / c.burnLap;
  const want = tyreKindFor(race, c, st);
  const haveKind = COMPOUNDS[c.tyre.c].kind;
  const reasons = [];

  if (c.box) reasons.push('order');
  if (c.limp) reasons.push('repair');
  if (fuelLaps < 1.2 + st.fuelReserve && fuelLaps < lapsLeft + 0.5) reasons.push('fuel');
  if (c.tyre.wear * 100 >= st.tyreChangeAt && !(lapsLeft <= 3 && c.tyre.wear < 0.95)) reasons.push('tyres');
  if (want !== haveKind) reasons.push('weather');
  if (c.damage >= 0.25) reasons.push('repair');
  if (c.drivers.length > 1 && race.simTime - c.stintStart >= st.stintHours * 3600 - c.lapEma && lapsLeft > 3) reasons.push('driver');
  if (race.fcy && st.pitUnderYellow && lapsLeft > 4 && (fuelLaps < TANK / c.burnLap * 0.55 || c.tyre.wear > 0.5)) reasons.push('yellow');

  const vars = { fuelLaps: fuelLaps.toFixed(1), reserve: st.fuelReserve, wear: pct(c.tyre.wear), limit: st.tyreChangeAt + '%', wetPct: pct(race.weather.wet), fromTyre: cap(c.tyre.c) };

  if (!reasons.length) {
    // tell the wall when we're deliberately staying out in changing weather
    const f = forecast(race.weather, race.simTime);
    if (haveKind === 'slick' && (race.weather.wet > 0.05 || (f && f.rainIn <= 6)) && Math.random() < 0.35) {
      say(race, c, 'hold', { ...vars, rainIn: f ? f.rainIn : 0, tyre: c.tyre.c });
    }
    return;
  }

  // build the stop
  let tyre = null;
  if (want === 'slick') {
    const fresh = reasons.includes('tyres') || reasons.includes('weather') || reasons.includes('repair') && c.tyre.wear > 0.3;
    const keep = st.doubleStint && c.tyre.wear < 0.45 && !fresh;
    if (!keep || c.tyre.wear > 0.6) tyre = dryChoice(race, c, st, lapsLeft);
    if (keep && c.tyre.wear <= 0.6) tyre = null;
  } else {
    tyre = want;
    if (haveKind === want && c.tyre.wear < 0.5 && !reasons.includes('tyres')) tyre = null;
  }
  const tank = st.fuelLoad === 'light' ? TANK * 0.6 : TANK;
  const need = (lapsLeft + 1.5) * c.burnLap;
  const fuelTo = Math.min(tank, need);
  const fuelAdd = Math.max(0, fuelTo - c.fuel);
  const swap = c.drivers.length > 1 && (reasons.includes('driver') || race.simTime - c.stintStart > st.stintHours * 3600 * 0.7) && lapsLeft > 3;

  c.plan = { reasons, tyre, fuel: Math.round(fuelAdd), swap, repair: c.damage > 0.05 };
  c.box = false;

  const tyreName = tyre ? cap(tyre) : 'the same tyres';
  const extra = tyre ? `${cap(tyre)} going on.` : (st.doubleStint ? 'Double stinting the tyres.' : '');
  if (reasons.includes('yellow')) say(race, c, 'pitYellow', vars, true);
  else if (reasons.includes('weather')) say(race, c, 'pitWeather', { ...vars, tyre: tyreName }, true);
  else if (reasons.includes('tyres')) say(race, c, 'pitTyre', { ...vars, tyre: tyreName });
  else if (reasons.includes('fuel')) say(race, c, 'pitFuel', { ...vars, extra });
  else if (reasons.includes('order')) say(race, c, 'pitFuel', { ...vars, extra: 'Team called me in.' });
  else if (reasons.includes('repair')) say(race, c, 'pitFuel', { ...vars, extra: 'Need repairs.' });
  else if (reasons.includes('driver')) say(race, c, 'pitFuel', { ...vars, extra: 'Driver change due.' });
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function serviceTime(c) {
  const p = c.plan || { fuel: 0, tyre: null, swap: false, repair: false };
  let t = 4 + Math.max(p.fuel * 0.35, (p.tyre ? 14 : 0) + (p.swap ? 6 : 0));
  if (p.repair) t += c.damage * 360 + (c.limp ? 120 : 0);
  return t;
}

function doService(race, c) {
  const p = c.plan || { fuel: 0, tyre: null, swap: false, repair: false };
  c.fuel = Math.min(TANK, c.fuel + p.fuel);
  if (p.tyre) c.tyre = { c: p.tyre, wear: 0, laps: 0 };
  if (p.repair) { c.damage = 0; c.limp = false; }
  if (p.swap) {
    const prev = c.drivers[c.driver];
    const stint = race.simTime - c.stintStart;
    // the most rested driver goes in next
    let best = (c.driver + 1) % c.drivers.length;
    for (let i = 0; i < c.drivers.length; i++) if (i !== c.driver && c.tired[i] < c.tired[best]) best = i;
    c.driver = best;
    c.stintStart = race.simTime;
    say(race, c, 'swap', { driver: c.drivers[c.driver], prev, stint: (stint / 3600).toFixed(1) + 'h' });
  }
  c.pits += 1;
  c.plan = null;
}

// ---- main step -------------------------------------------------------------------
function order(race) {
  const live = (c) => (c.retired ? 0 : 1);
  return race.cars.slice().sort((a, b) => live(b) - live(a) || (b.lap * T.LENGTH + b.s) - (a.lap * T.LENGTH + a.s));
}

function positionOf(race, c) { return order(race).indexOf(c) + 1; }

function step(race, dt, strategyOf) {
  if (race.status !== 'running') return;
  startClock = race.startClock ?? START_CLOCK;
  race.events = race.events || [];
  // races saved before the wider pace spread: give every car a fresh base pace once
  if (!race.paceV2) { for (const c of race.cars) c.pace = rnd(0.994, 1.006); race.paceV2 = true; }
  race.simTime += dt;
  const t = race.simTime;
  const w = race.weather;

  // weather
  const prevRain = w.rain;
  w.rain = rainAt(w, t);
  if (w.rain > 0.02) w.wet = Math.min(1, w.wet + w.rain * dt / 600);
  else w.wet = Math.max(0, w.wet - dt / (isNight(t) ? 3600 : 2100));
  if (prevRain <= 0.02 && w.rain > 0.02) { note(race, 'Rain is falling on the circuit.', 'weather'); for (const c of race.cars) if (!c.retired && Math.random() < 0.6) say(race, c, 'rain'); }
  if (prevRain > 0.02 && w.rain <= 0.02) note(race, 'The rain has stopped. The track will start to dry.', 'weather');

  // day and night
  const night = isNight(t);
  if (night !== race.night) {
    race.night = night;
    note(race, night ? 'Night falls. Headlights on.' : 'Sunrise at the circuit.', 'info');
    for (const c of race.cars) if (!c.retired && Math.random() < 0.5) say(race, c, night ? 'night' : 'dawn');
  }
  const hour = Math.floor(t / 3600);
  if (hour > race.lastHour) {
    race.lastHour = hour;
    const lead = order(race)[0];
    const left = Math.round((race.duration - t) / 3600);
    if (left > 0) note(race, `Hour ${hour} done, ${left} to go. ${lead ? lead.name + ' leads on lap ' + lead.lap + '.' : ''}`, 'info');
    if (left === 1) for (const c of race.cars) if (!c.retired && strategyOf(c.id).finalPush) say(race, c, 'push');
  }

  if (race.fcy && t > race.fcy.until) { race.fcy = null; note(race, 'Green flag. Racing resumes.', 'flag'); }

  const timeUp = t >= race.duration;
  const onTrack = race.cars.filter((c) => c.state === 'track' && !c.retired && !c.finished);

  for (const c of order(race)) {
    if (c.retired || c.finished) { c.v = 0; continue; }
    const st = strategyOf(c.id);
    updateTiredness(race, c, st, dt);

    if (c.state === 'garage' || c.state === 'stopped') {
      c.v = 0;
      c.service -= dt;
      if (c.service <= 0) {
        if (c.state === 'stopped') doService(race, c);
        c.state = 'pitlane';
        if (c.lap === 0 && c.s <= 0) c.s = 0;
        c.outLap = true;
      }
      continue;
    }

    let v;
    let fighting = false;
    if (c.state === 'pitlane') v = T.PIT_SPEED;
    else {
      v = T.speedAt(c.s) * paceOf(race, c, st);
      if (race.fcy) v = Math.min(v, 42);
      if (c.s < 0) v = Math.min(v, 30 + (t * 4)); // rolling off the grid
      // traffic: the nearest car ahead on track
      let ahead = null, gap = Infinity;
      for (const o of onTrack) {
        if (o === c) continue;
        let d = (((o.s - c.s) % T.LENGTH) + T.LENGTH) % T.LENGTH;
        if (d > 0 && d < gap) { gap = d; ahead = o; }
      }
      // slipstream: close behind on a straight, the tow is worth a little top speed
      if (ahead && gap < 40 && !race.fcy) v *= 1 + 0.012 * T.straightAt(c.s) * (1 - gap / 40);
      if (c.yielding > 0) { c.yielding -= dt; v -= 1.2; } // just lost the place, lifting to tuck in behind
      if (c.passing > 0) {
        // alongside: a better exit and the tow carry the car past, until it's clear ahead
        c.passing -= dt;
        v += 2.5;
        const o = race.cars.find((x) => x.id === c.passTarget);
        const lead = o ? (((c.s - o.s) % T.LENGTH) + T.LENGTH) % T.LENGTH : 1e9;
        if (!o || o.state !== 'track' || (lead > 9 && lead < T.LENGTH / 2)) c.passing = 0;
      }
      else if (ahead && gap < 24) {
        const lapping = c.lap * T.LENGTH + c.s > ahead.lap * T.LENGTH + ahead.s + T.LENGTH / 2;
        const ast = strategyOf(ahead.id);
        const aPace = paceOf(race, ahead, ast);
        // the car ahead's pace on this car's bit of track, plus a pull to sit about 12 m back
        const vf = T.speedAt(c.s) * aPace + clamp((gap - 12) * 0.25, -3, 3);
        if (v > vf) {
          fighting = true;
          const edge = paceOf(race, c, st) / aPace - 1; // how much quicker this car is, 0.004 = 0.4%
          c.heldUp += dt;
          let chance = 0;
          if (lapping || ahead.limp) chance = 0.5;
          else if (edge > 0 || c.heldUp > 60) {
            chance = 0.035 * (0.2 + T.straightAt(c.s)) * (1 + 250 * Math.max(0, edge)) * (1 + c.heldUp / 60);
            chance *= 1 + 0.25 * (aggressionOf(race, c, st) - 3);
            if (ast.traffic === 'letby') chance *= 2.5;
            else if (ast.traffic === 'defend') chance *= 0.6;
            if (c.lostTo === ahead.id && race.simTime - c.lostAt < 180) chance *= 0.15; // no instant re-pass
          }
          if (race.fcy) chance = 0;
          if (Math.random() < chance * dt) {
            c.passing = 8; c.passTarget = ahead.id; c.passes += 1; c.heldUp = 0;
            ahead.lostTo = c.id; ahead.lostAt = race.simTime; ahead.yielding = 3;
            if (!lapping) {
              const corner = T.cornerAt(c.s);
              if (Math.random() < 0.5) say(race, c, 'passed', { otherName: ahead.name, corner, pos: positionOf(race, c) - 1 });
              if (Math.random() < 0.4) say(race, ahead, 'lost', { otherName: c.name, corner });
            }
          } else {
            v = vf;
            if (c.heldUp > 25 && Math.random() < 0.02 * dt) {
              say(race, c, 'heldUp', { aheadName: ahead.name, loss: (0.3 + Math.random() * 0.8).toFixed(1) + 's' });
            }
          }
        } else c.heldUp = Math.max(0, c.heldUp - dt);
      } else c.heldUp = Math.max(0, c.heldUp - dt);
    }
    // real cars can't change speed instantly: cap acceleration and braking on track
    if (c.state === 'track') v = clamp(v, Math.max(0, c.v - 30 * dt), c.v + 9 * dt);
    c.v = v;

    // move
    const prevS = c.s;
    const ds = v * dt;
    c.s += ds;
    if (c.state === 'track' || c.state === 'pitlane') {
      const burn = BURN * (1 + 0.06 * (aggressionOf(race, c, st) - 3)) * (race.fcy ? 0.6 : 1);
      c.fuel = Math.max(0, c.fuel - burn * ds);
      c.tyre.wear += wearRate(race, c, st) * ds;
    }
    if (c.fuel <= 0 && c.state === 'track') {
      c.limp = true;
      if (!c.ranDry) { c.ranDry = true; note(race, `${c.name} has run out of fuel and is crawling to the pits!`, 'incident', c.id); }
    }

    // incidents
    if (c.state === 'track' && c.s > 0 && Math.random() < riskPerMetre(race, c, st, fighting) * ds) incident(race, c);
    if (c.state === 'track' && c.tyre.wear > 1.05 && Math.random() < 0.0004 * ds) {
      c.damage = Math.min(1, c.damage + 0.2); c.limp = true;
      note(race, `Puncture for ${c.name}! The tyres were worn out.`, 'incident', c.id);
    }
    if (c.state === 'track' && Math.random() < dt / (3600 * 400) * 1.4 ** (aggressionOf(race, c, st) - 3)) mechanical(race, c);
    if (c.retired) continue;

    // decision point, ~500 m before the pit entry
    const D = T.PIT_IN - 500;
    if (c.state === 'track' && prevS < D && c.s >= D && !c.plan && !timeUp) decide(race, c, st);

    // pit entry
    if (c.state === 'track' && prevS < T.PIT_IN && c.s >= T.PIT_IN && (c.plan || c.limp) && !timeUp) {
      if (!c.plan) c.plan = { reasons: ['repair'], tyre: null, fuel: Math.round(Math.max(0, TANK * 0.6 - c.fuel)), swap: false, repair: true };
      c.state = 'pitlane';
    }

    // crossing the line
    if (c.s >= T.LENGTH) {
      c.s -= T.LENGTH;
      if (c.lap > 0 || c.lapStart > 0 || prevS >= 0) lapDone(race, c);
      c.lap += 1;
      if (c.state === 'pitlane' && c.plan && !c.outLap) {
        c.state = 'stopped';
        c.service = serviceTime(c);
        c.s = 0;
        c.v = 0;
        note(race, `${c.name} pits${c.plan.tyre ? ' for ' + c.plan.tyre + 's' : ''}${c.plan.swap ? ', driver change' : ''}${c.plan.repair && c.damage > 0.05 ? ', repairs' : ''}. ${Math.round(c.service)}s stop.`, 'pit', c.id);
      }
      if (timeUp && c.state !== 'stopped') { c.finished = true; c.v = 0; }
    }

    // pit exit
    if (c.state === 'pitlane' && c.s >= T.PIT_OUT && c.s < T.LENGTH / 2 && (c.outLap || !c.plan)) {
      c.state = 'track';
      c.outLap = false;
      if (c.lap === 0 && race.simTime > 60) c.lapStart = race.simTime;
      say(race, c, 'out', { tyre: c.tyre.c, fuel: Math.round(c.fuel), pos: positionOf(race, c) });
    }

    // idle chatter
    c.nextThought -= dt;
    if (c.nextThought <= 0 && c.state === 'track') {
      c.nextThought = rnd(150, 420);
      chatter(race, c, st);
    }
  }

  // leader change
  const leader = order(race)[0];
  if (leader && leader.id !== race.leaderId && t > 30) {
    if (race.leaderId) note(race, `${leader.name} takes the lead!`, 'lead', leader.id);
    race.leaderId = leader.id;
  } else if (leader && !race.leaderId) race.leaderId = leader.id;

  // the end: everyone takes the flag once the clock runs out (or after 15 minutes regardless)
  if (timeUp && race.cars.every((c) => c.finished || c.retired || t > race.duration + 900)) finish(race);
}

function lapDone(race, c) {
  const t = race.simTime;
  const lt = t - c.lapStart;
  c.lapStart = t;
  if (lt > 30 && lt < 600) {
    c.lastLap = lt;
    if (c.state === 'track' && !race.fcy && (!c.bestLap || lt < c.bestLap)) c.bestLap = lt;
    if (c.state === 'track' && !race.fcy) c.lapEma = c.lapEma * 0.8 + lt * 0.2;
  }
  c.tyre.laps += 1;
  if (c.prevFuel !== undefined && c.prevFuel > c.fuel && c.state === 'track') c.burnLap = c.burnLap * 0.7 + (c.prevFuel - c.fuel) * 0.3;
  c.prevFuel = c.fuel;
  c.form = rnd(0.998, 1.002);
}

function chatter(race, c, st) {
  const ord = order(race).filter((o) => !o.retired);
  const i = ord.indexOf(c);
  const a = ord[i - 1], b = ord[i + 1];
  const lapLen = c.lapEma;
  const dist = (x) => x.lap * T.LENGTH + x.s;
  const gapS = (x, y) => Math.abs(dist(x) - dist(y)) / T.LENGTH * lapLen;
  const vars = {
    pos: i + 1, lap: c.lap, last: fmtLap(c.lastLap), wear: pct(c.tyre.wear), fuelLaps: (c.fuel / c.burnLap).toFixed(1),
    trend: Math.random() < 0.5 ? 'quicker' : 'slower', corner: T.cornerAt(c.s),
    tyreLaps: Math.max(0, Math.round((st.tyreChangeAt / 100 - c.tyre.wear) * COMPOUNDS[c.tyre.c].life)),
    ahead: a ? fmtGap(gapS(a, c)) : 'nobody', aheadName: a ? a.name : 'the lead',
    behind: b ? fmtGap(gapS(c, b)) : 'nobody', behindName: b ? b.name : 'nobody',
    fuelMood: c.fuel / c.burnLap > 8 ? 'Plenty. Pushing.' : 'Box soon.',
    driver: c.drivers[c.driver], tiredPct: pct(c.tired[c.driver]), stint: ((race.simTime - c.stintStart) / 3600).toFixed(1) + 'h',
  };
  if (fatigueOf(race, c) > 0.2 && Math.random() < 0.5) return say(race, c, 'tired', vars);
  if (a && gapS(a, c) < 6 && Math.random() < 0.6) {
    const delta = rnd(0.1, 0.6);
    return say(race, c, 'chase', { ...vars, delta: delta.toFixed(1) + 's', catch: Math.max(1, Math.round(gapS(a, c) / delta)) });
  }
  if (b && gapS(c, b) < 3 && Math.random() < 0.6) return say(race, c, 'defend', vars);
  say(race, c, 'status', vars);
}

function incident(race, c) {
  const corner = T.cornerAt(c.s);
  const roll = Math.random();
  if (roll < 0.7) {
    const lost = rnd(4, 12);
    c.s -= lost * 20; // ~ distance lost recovering
    c.tyre.wear += 0.04;
    note(race, `${c.name} spins at ${corner}.`, 'incident', c.id);
    say(race, c, 'incident', { corner, damage: 'No damage, lost ' + Math.round(lost) + 's.' });
  } else if (roll < 0.93) {
    const d = rnd(0.1, 0.4);
    c.damage = Math.min(1, c.damage + d);
    c.s -= 200;
    note(race, `${c.name} goes off at ${corner} and damages the car.`, 'incident', c.id);
    say(race, c, 'incident', { corner, damage: `Damage ${pct(c.damage)}. ${c.damage >= 0.25 ? 'Coming in to fix it.' : 'I can live with it.'}` });
  } else {
    const d = rnd(0.5, 1);
    c.damage = Math.min(1, c.damage + d);
    if (Math.random() < 0.12) return retire(race, c, `Heavy crash at ${corner}. ${c.drivers[c.driver]} is OK but the car is out.`, true);
    c.limp = true;
    note(race, `Big crash for ${c.name} at ${corner}!`, 'incident', c.id);
    say(race, c, 'incident', { corner, damage: 'Big damage. Limping back to the garage.' });
    yellow(race, rnd(180, 420), `crash for ${c.name}`);
  }
}

function mechanical(race, c) {
  if (Math.random() < 0.15) return retire(race, c, `${c.name} stops on track with an engine failure. They're out.`, false);
  c.damage = Math.max(c.damage, 0.5);
  c.limp = true;
  note(race, `${c.name} slows with a gearbox problem.`, 'incident', c.id);
  say(race, c, 'incident', { corner: T.cornerAt(c.s), damage: 'Gearbox problem. Nursing it back.' });
}

function retire(race, c, text, flag) {
  c.retired = true; c.v = 0; c.why = text; c.state = 'retired';
  note(race, text, 'out', c.id);
  if (flag) yellow(race, rnd(300, 600), `crash for ${c.name}`);
}

function yellow(race, secs, why) {
  const until = race.simTime + secs;
  if (race.fcy) { race.fcy.until = Math.max(race.fcy.until, until); return; }
  race.fcy = { until, why };
  note(race, `Full course yellow: ${why}. Everyone slows down.`, 'flag');
}

function finish(race) {
  race.status = 'finished';
  race.finishedAt = Date.now();
  race.results = order(race).map((c, i) => ({ pos: i + 1, id: c.id, name: c.name, color: c.color, number: c.number, laps: c.lap, best: Math.round(c.bestLap * 10) / 10, pits: c.pits, retired: c.retired, why: c.why, bot: c.bot }));
  const w = race.results[0];
  if (w) note(race, `Chequered flag! ${w.name} wins after ${w.laps} laps.`, 'lead', w.id);
}

// ---- what browsers get ---------------------------------------------------------
function snapshot(race) {
  startClock = race.startClock ?? START_CLOCK;
  const ord = order(race);
  const lead = ord[0];
  const dist = (x) => x.lap * T.LENGTH + x.s;
  return {
    id: race.id, number: race.number, status: race.status,
    t: Math.round(race.simTime * 10) / 10, duration: race.duration, clock: Math.round(clockOf(race.simTime)),
    night: isNight(race.simTime), wet: Math.round(race.weather.wet * 100) / 100, rain: Math.round(race.weather.rain * 100) / 100,
    forecast: forecast(race.weather, race.simTime),
    fcy: race.fcy ? { left: Math.round(race.fcy.until - race.simTime), why: race.fcy.why } : null,
    cars: ord.map((c, i) => {
      const behind = lead ? dist(lead) - dist(c) : 0;
      return {
        id: c.id, pos: i + 1, name: c.name, color: c.color, number: c.number, bot: c.bot,
        lap: c.lap, s: Math.round(c.s * 10) / 10, v: Math.round(c.v * 10) / 10, state: c.retired ? 'retired' : c.finished ? 'finished' : c.state,
        tyre: c.tyre.c, wear: Math.round(c.tyre.wear * 100), fuel: Math.round(c.fuel), damage: Math.round(c.damage * 100),
        driver: c.drivers[c.driver], tired: Math.round(c.tired[c.driver] * 100), crew: c.drivers.map((n, i) => ({ name: n, tired: Math.round(c.tired[i] * 100) })),
        stint: Math.round(race.simTime - c.stintStart), pits: c.pits, last: Math.round(c.lastLap * 10) / 10, best: Math.round(c.bestLap * 10) / 10,
        gapLaps: Math.floor(behind / T.LENGTH), gap: Math.round((behind / T.LENGTH) * c.lapEma * 10) / 10,
        personality: c.personality, plan: c.plan ? c.plan.reasons : null, limp: c.limp,
      };
    }),
  };
}

module.exports = {
  T, TANK, COMPOUNDS, DEFAULT_STRATEGY, PERSONALITIES,
  newRace, newCar, step, snapshot, finish, note, order,
  sanitizeStrategy, randomStrategy, fmtLap,
};
