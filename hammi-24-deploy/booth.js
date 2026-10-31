// Hammi 24 commentary booth: two commentators who call the race. Mick calls the action, Sasha
// explains the strategy. Lines are made up here from race control and the timing, read out by a
// neural voice model (tts-worker.js) and sent to every viewer, so everyone hears the same call.
'use strict';

const MICK = 0, SASHA = 1;
const NAMES = ['Mick', 'Sasha'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const now = () => Date.now();
const P = (n) => `P${n}`;
const ord = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
const secs = (s) => (s < 10 ? s.toFixed(1) : Math.round(s)) + ' seconds';
const name = (c) => c.name;
const tyreWord = { soft: 'softs', medium: 'mediums', hard: 'hards', inter: 'intermediates', wet: 'full wets' };
function fmtLap(t) { const m = Math.floor(t / 60); const s = (t - m * 60).toFixed(1); return `${m} minute ${s}`; }

// speak(line) must return a promise of { audio: bool, dur: seconds } once the line is ready to air.
function createBooth({ speak, air }) {
  let queue = [];            // { who, text, prio, at }
  let busy = false;          // a line is being voiced or is on air
  let airEnd = 0;            // when the line on air finishes
  let prev = null;
  let lastSpoke = 0, lastFill = 0;
  let fastest = Infinity;
  const cooldown = new Map();
  function ready(topic, s) {
    if ((cooldown.get(topic) || 0) > now()) return false;
    cooldown.set(topic, now() + s * 1000);
    return true;
  }
  function add(who, text, prio = 1) {
    queue.push({ who, text, prio, at: now() });
    queue.sort((a, b) => b.prio - a.prio || a.at - b.at);
    if (queue.length > 6) queue.length = 6;
    pump();
  }
  async function pump() {
    if (busy) return;
    queue = queue.filter((l) => now() - l.at < (l.prio >= 3 ? 30000 : 15000));
    const line = queue.shift();
    if (!line) return;
    busy = true;
    let r = { audio: false, dur: 1.5 + line.text.length * 0.065 };
    try { r = (await speak({ ...line, name: NAMES[line.who] })) || r; } catch { /* captions and browser voice instead */ }
    const wait = airEnd - now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastSpoke = now();
    airEnd = now() + r.dur * 1000 + 450;
    air({ ...line, name: NAMES[line.who], audio: r.audio, id: r.id || null, dur: r.dur });
    busy = false;
    // voice the next line while this one plays, so the booth has no dead air between lines
    setTimeout(pump, 50);
  }

  // ---- reacting to race control -------------------------------------------------------
  function onFeed(e, snap) {
    if (!e) return;
    const car = snap && e.car ? snap.cars.find((c) => c.id === e.car) : null;
    const isMine = false;
    const t = e.text;
    if (e.kind === 'lead') {
      if (/Chequered/.test(t)) {
        add(MICK, pick([`${t.replace('Chequered flag! ', 'There it is, the chequered flag! ')} What a race.`, `The chequered flag is out! ${car ? car.name : 'The leader'} has done it!`]), 5);
        add(SASHA, pick(['Twenty-four hours, and it comes down to strategy and nerve. Congratulations to the whole crew.', 'An incredible effort. Every driver, every mechanic, they all earned that.']), 4);
        return;
      }
      add(MICK, pick([`And ${car ? car.name : 'we have a new leader'} takes the lead of the race!`, `Change at the front! ${car ? car.name : 'A new leader'} is now P1!`, `${car ? car.name : 'A new car'} goes to the top of the order!`]), 4);
      if (car) add(SASHA, leadAnalysis(car, snap), 2);
      return;
    }
    if (e.kind === 'incident') {
      const where = (t.match(/at ([A-Z][\w\s]+?)[.!]/) || [])[1];
      if (/Big crash/.test(t)) add(MICK, pick([`Oh, big accident! ${car ? car.name : 'Someone'} is in the barrier${where ? ' at ' + where : ''}!`, `Huge crash${where ? ' at ' + where : ''}! That's ${car ? car.name : 'a car'} and it looks heavy!`]), 5);
      else if (/spins/.test(t)) add(MICK, pick([`${car ? car.name : 'Someone'} spins${where ? ' at ' + where : ''}!`, `Round it goes! ${car ? car.name : 'A car'} has spun${where ? ' at ' + where : ''}.`, `A spin for ${car ? car.name : 'one of the cars'}${where ? ' at ' + where : ''}, that'll cost them.`]), 3);
      else if (/goes off/.test(t)) add(MICK, pick([`${car ? car.name : 'A car'} is off${where ? ' at ' + where : ''}, and there's damage!`, `Trouble for ${car ? car.name : 'someone'}${where ? ' at ' + where : ''}, off the road and the car's hurt.`]), 3);
      else if (/Puncture/.test(t)) add(MICK, pick([`Puncture! ${car ? car.name : 'A car'} has a tyre let go!`, `Oh, that tyre's gone on ${car ? car.name : 'the car'}! They pushed it too far.`]), 4);
      else if (/fuel/.test(t)) add(MICK, `Unbelievable! ${car ? car.name : 'A car'} has run out of fuel!`, 4);
      else if (/gearbox/.test(t)) add(MICK, `${car ? car.name : 'A car'} is slowing, that's a gearbox problem.`, 3);
      else add(MICK, t, 3);
      if (car && Math.random() < 0.7) add(SASHA, incidentAnalysis(car, t), 2);
      if (isMine) add(SASHA, 'And that is not what the Hammi team wanted to see. Let\'s hope the car is okay.', 2);
      return;
    }
    if (e.kind === 'out') { add(MICK, pick([`That's it for ${car ? car.name : 'them'}. They're out of the race.`, `Heartbreak. ${car ? car.name : 'A car'} retires.`]), 4); add(SASHA, pick(['Twenty-four hour racing is cruel. You can do everything right and still not see the flag.', 'Tough, tough day for that team.']), 2); return; }
    if (e.kind === 'flag') {
      if (/Full course yellow/.test(t)) { add(MICK, pick(['Full course yellow! Everyone slows to eighty kilometres an hour.', 'The yellow flags are out across the circuit. Full course yellow.']), 4); add(SASHA, pick(['This is where strategy matters. A pit stop under yellow costs a lot less time. Watch who dives in.', 'Some teams will love this. If you were due to pit anyway, now is the moment.']), 3); }
      else if (/^Safety car:/.test(t)) { add(MICK, pick(['Safety car! That crash brings out the safety car, and the whole field will bunch up behind it.', 'Out comes the safety car. All those gaps are about to disappear.']), 4); add(SASHA, pick(['This changes everything. Whoever had a big lead just lost it, and a stop now is almost free.', 'Big moment for strategy. Pit now and you lose very little, and the restart will be nose to tail.']), 3); }
      else if (/Safety car in this lap/.test(t)) add(MICK, pick(['The safety car is coming in this lap. Restart time!', 'Lights off on the safety car. Get ready for the restart!']), 4);
      else if (/Green/.test(t)) add(MICK, pick(['And it\'s green, green, green! We are racing again!', 'Green flag! Back to full speed.']), 4);
      return;
    }
    if (e.kind === 'weather') {
      if (/Rain is falling/.test(t)) { add(MICK, pick(['And here comes the rain!', 'Rain! Rain is falling on the circuit!']), 4); add(SASHA, 'Now the big call. Stay out on slicks and gamble, or come in for intermediates. The early callers will be diving in.', 3); }
      else add(SASHA, 'The rain has stopped. The track will dry from here, so the question becomes when to go back to slicks.', 3);
      return;
    }
    if (e.kind === 'pit') {
      if (!car) return;
      if (car.pos <= 6 || isMine) {
        add(MICK, pick([`${name(car)} into the pits from ${P(car.pos)}.`, `In comes ${name(car)}, running ${ord(car.pos)}.`, `Pit stop for ${name(car)}.`]), car.pos <= 3 ? 3 : 2);
        if (Math.random() < 0.6) add(SASHA, pitAnalysis(car, t), 2);
      }
      return;
    }
    if (e.kind === 'info') {
      if (/^Hour (\d+) done/.test(t)) {
        const h = +t.match(/^Hour (\d+)/)[1];
        add(MICK, `${h} hour${h > 1 ? 's' : ''} down, ${24 - h} to go. ${snap && snap.cars[0] ? snap.cars[0].name + ' leads.' : ''}`, 3);
        if (snap) add(SASHA, hourAnalysis(snap), 2);
      } else if (/Night falls/.test(t)) { add(MICK, 'Night is falling, the headlights are on.', 3); add(SASHA, 'The night stint is where drivers get tired and mistakes happen. Teams with fresh drivers will have the edge.', 2); }
      else if (/Sunrise/.test(t)) add(MICK, 'And the sun is coming up over the circuit. They\'ve made it through the night.', 3);
      else if (/is go/.test(t)) { add(MICK, 'And they\'re away! The race is on!', 5); add(SASHA, 'Twenty-four hours of racing ahead. Remember, you can\'t win it in the first lap, but you can certainly lose it.', 3); }
    }
  }

  // ---- what Sasha says ---------------------------------------------------------------
  function leadAnalysis(c, snap) {
    const second = snap.cars[1];
    return pick([
      `${c.name} are on ${tyreWord[c.tyre] || c.tyre} with ${c.wear} percent wear. If they look after them, this could stick.`,
      `It's a long race, but track position is gold. ${second ? second.name + ' will need to answer this on strategy.' : ''}`,
      `That's a ${c.personality} car. ${c.personality === 'bold' ? 'They take risks, and so far it\'s paying off.' : c.personality === 'steady' ? 'They don\'t make mistakes, and that wins long races.' : 'Very smart racing, everything thought out.'}`,
    ]);
  }
  function incidentAnalysis(c, t) {
    const out = [];
    if (c.tired > 50) out.push(`That driver has been in the car a long time. ${c.tired} percent tired. Fatigue causes exactly these mistakes.`);
    if (c.wear > 80) out.push(`Tyres at ${c.wear} percent wear. There's just no grip left.`);
    if (/rain|wet/i.test(t)) out.push('Tricky conditions, and the wrong tyres will bite you.');
    out.push('That will cost them time, and maybe a trip to the garage for repairs.', 'A moment\'s loss of concentration, and twenty hours of work can disappear.');
    return pick(out);
  }
  function pitAnalysis(c, t) {
    const out = [];
    if (/driver change/.test(t)) out.push(`Driver change as well. Fresh legs in the car, and that will matter later.`);
    if (/repairs/.test(t)) out.push('They need repairs. That will be a longer stop.');
    const tyre = (t.match(/for (\w+)s/) || [])[1];
    if (tyre) out.push(`Going onto ${tyreWord[tyre] || tyre + 's'}. ${tyre === 'soft' ? 'Aggressive choice, quick but they won\'t last.' : tyre === 'hard' ? 'Hards for a long stint. Playing the long game.' : 'A sensible choice.'}`);
    out.push(`They'll rejoin around ${ord(Math.min(30, c.pos + 3))}, but everyone has to stop eventually.`);
    return pick(out);
  }
  function hourAnalysis(snap) {
    const a = snap.cars[0], b = snap.cars[1];
    if (!a || !b) return 'Plenty of racing still to come.';
    const gap = b.gapLaps ? `${b.gapLaps} lap${b.gapLaps > 1 ? 's' : ''}` : secs(b.gap);
    return pick([
      `${a.name} lead ${b.name} by ${gap}. In endurance racing, that's nothing.`,
      `The gap at the front is ${gap}. Pit stop timing could swing that either way.`,
    ]);
  }

  // ---- reacting to the timing -----------------------------------------------------------
  function onSnap(snap) {
    if (!snap || !snap.cars) { prev = snap; return; }
    const mine = null;
    if (prev && prev.id === snap.id) {
      const before = new Map(prev.cars.map((c) => [c.id, c]));
      // overtakes in the top ten (or for my car anywhere)
      for (const c of snap.cars) {
        const p = before.get(c.id);
        if (!p || c.pos >= p.pos || c.state !== 'track' || p.state !== 'track') continue;
        const passed = snap.cars.find((o) => o.pos === c.pos + 1);
        const pp = passed && before.get(passed.id);
        if (!passed || !pp || pp.pos !== p.pos - 1 || passed.state !== 'track') continue; // moved up because someone pitted
        if (c.pos === 1) continue; // the lead change line comes from race control
        if (!(c.pos <= 10 || c.id === mine || passed.id === mine)) continue;
        if (!ready('pass', c.pos <= 3 ? 8 : 16)) continue;
        add(MICK, pick([
          `${c.name} gets by ${passed.name} for ${P(c.pos)}!`,
          `And there's the move! ${c.name} past ${passed.name}!`,
          `${c.name} makes it stick, that's ${ord(c.pos)} place!`,
          `Through goes ${c.name}! ${passed.name} drops to ${ord(passed.pos)}.`,
        ]), c.pos <= 3 ? 4 : 3);
        if (c.id === mine) add(SASHA, pick(['Great move from the Hammi car!', 'Lovely bit of racing from that driver.']), 2);
        else if (Math.random() < 0.35) add(SASHA, pick([...(passed.wear - c.wear >= 8 ? [`${c.name} had the better tyres there. ${c.wear} percent worn against ${passed.wear}.`] : []), 'Used the slipstream perfectly on the straight.', `${passed.name} just couldn't defend.`]), 1);
      }
      // new fastest lap
      for (const c of snap.cars) {
        if (c.best && c.best < fastest - 0.05) {
          const first = fastest === Infinity;
          fastest = c.best;
          if (!first && snap.t > 600 && ready('fastest', 120)) add(MICK, `Fastest lap of the race for ${c.name}, a ${fmtLap(c.best)}.`, 2);
        }
      }
    } else {
      fastest = Math.min(...snap.cars.map((c) => c.best || Infinity));
    }
    prev = snap;

    // quiet spell: talk about a battle, the leader, or my car
    if (now() - lastSpoke > 22000 && now() - lastFill > 25000 && !queue.length && !busy) {
      lastFill = now();
      quietLine(snap, mine);
    }
  }

  function quietLine(snap, mine) {
    const cars = snap.cars.filter((c) => c.state === 'track');
    const options = [];
    // battles: two cars within a second
    for (let i = 1; i < Math.min(snap.cars.length, 12); i++) {
      const a = snap.cars[i - 1], b = snap.cars[i];
      if (a.state === 'track' && b.state === 'track' && a.gapLaps === b.gapLaps && b.gap - a.gap < 1 && b.gap - a.gap >= 0) options.push(() => {
        add(MICK, pick([
          `Great battle for ${a.pos === 1 ? 'the lead' : P(a.pos)}. ${b.name} is right on the gearbox of ${a.name}.`,
          `${b.name} is all over the back of ${a.name}, less than a second between them.`,
          `Watch this fight for ${a.pos === 1 ? 'the lead' : ord(a.pos)}. ${a.name} defending from ${b.name}.`,
        ]), 2);
        if (Math.random() < 0.6) add(SASHA, pick([...(a.wear - b.wear >= 8 ? [`${b.name} on ${b.wear} percent tyres, ${a.name} on ${a.wear}. Fresher rubber should tell.`] : []), 'Whoever gets the better exit onto the straight will have the tow.', 'It\'s a long race, but nobody likes giving up a place.']), 1);
      });
    }
    const lead = snap.cars[0], second = snap.cars[1];
    if (lead && second) options.push(() => {
      const gap = second.gapLaps ? `${second.gapLaps} lap${second.gapLaps > 1 ? 's' : ''}` : secs(second.gap);
      add(MICK, pick([`${lead.name} still leading, ${gap} clear of ${second.name}.`, `At the front it's ${lead.name}, ${second.name} ${gap} behind.`]), 1);
      if (Math.random() < 0.5) add(SASHA, pick([`${lead.name} have ${lead.fuel} litres left. ${lead.fuel < 20 ? 'They\'ll be in very soon.' : 'Plenty of fuel for now.'}`, `${lead.driver} driving for the leaders, ${Math.floor(lead.stint / 60)} minutes into the stint.`]), 1);
    });
    const m = mine && snap.cars.find((c) => c.id === mine);
    if (m) options.push(() => {
      add(MICK, pick([`Let's check on ${m.name}, running ${ord(m.pos)}.`, `${m.name} are ${ord(m.pos)} at the moment.`]), 1);
      add(SASHA, pick([`${m.driver} at the wheel. Tyres ${m.wear} percent worn, ${m.fuel} litres of fuel.`, m.tired > 50 ? `${m.driver} is getting tired, ${m.tired} percent. A driver change would help.` : `${m.driver} is still fresh. They can push.`]), 1);
    });
    const tired = cars.filter((c) => c.tired > 65).sort((a, b) => b.tired - a.tired)[0];
    if (tired) options.push(() => add(SASHA, `Keep an eye on ${tired.name}. ${tired.driver} is ${tired.tired} percent tired. That's when mistakes creep in.`, 1));
    const worn = cars.filter((c) => c.wear > 80 && c.pos <= 10)[0];
    if (worn) options.push(() => add(SASHA, `${worn.name} on very old tyres, ${worn.wear} percent worn. They must be close to a stop.`, 1));
    if (snap.forecast && snap.rain <= 0.02 && snap.forecast.rainIn <= 20) options.push(() => add(SASHA, `Rain is forecast in about ${snap.forecast.rainIn} minutes. The pit walls will be busy.`, 2));
    if (options.length) pick(options)();
  }

  function fmtLap(t) { const m = Math.floor(t / 60); const s = (t - m * 60).toFixed(1); return `${m} minute ${s}`; }


  return { onFeed, onSnap, add, reset() { queue = []; prev = null; fastest = Infinity; }, get idle() { return !busy && !queue.length; } };
}

module.exports = { createBooth };
