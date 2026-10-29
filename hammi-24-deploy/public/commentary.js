// Hammi 24 commentary: plays the booth. The server writes the lines (Mick calls the action,
// Sasha explains the strategy) and voices them with a neural model, so every viewer hears the
// same call. If a line comes without audio, the browser's own best voice reads it instead.
'use strict';

window.Commentary = (() => {
  const synth = window.speechSynthesis || null;
  const player = new Audio();
  player.preload = 'auto';
  let on = false;
  let queue = [];            // voice events waiting to play
  let playing = false;
  let hooks = { onLine: () => {} };
  let voices = {};           // who -> browser voice, for lines without audio

  // the browser fallback: prefer the natural-sounding voices Edge, Chrome and Safari ship
  function chooseVoices() {
    if (!synth) return;
    const all = synth.getVoices().filter((v) => /^en/i.test(v.lang));
    if (!all.length) return;
    const score = (v) => (/natural|neural|online/i.test(v.name) ? 40 : 0) + (/premium|enhanced/i.test(v.name) ? 30 : 0) + (/google/i.test(v.name) ? 20 : 0) + (/en-GB/i.test(v.lang) ? 3 : 0) + (v.localService ? 0 : 2);
    const male = /\b(guy|ryan|thomas|george|daniel|arthur|oliver|christopher|eric|davis|brian|andrew|william|male)\b/i;
    const female = /\b(aria|jenny|sonia|libby|emma|ava|michelle|samantha|serena|kate|female|moira|tessa|karen|susan)\b/i;
    const best = (re) => all.filter((v) => re.test(v.name)).sort((a, b) => score(b) - score(a))[0];
    const anyBest = all.slice().sort((a, b) => score(b) - score(a));
    voices.Mick = best(male) || anyBest[0];
    voices.Sasha = best(female) || anyBest.find((v) => v !== voices.Mick) || anyBest[0];
  }
  if (synth) { chooseVoices(); synth.addEventListener?.('voiceschanged', chooseVoices); }

  function onVoice(e) {
    if (!on || !e || !e.text) return;
    queue.push({ ...e, got: performance.now() });
    if (queue.length > 5) queue.shift();
    next();
  }
  function next() {
    if (!on || playing) return;
    queue = queue.filter((l) => performance.now() - l.got < 20000);
    const line = queue.shift();
    if (!line) return;
    playing = true;
    hooks.onLine(line.who, line.text, line.dur);
    let finished = false;
    const end = () => { if (finished) return; finished = true; playing = false; setTimeout(next, 120); };
    setTimeout(end, (line.dur || 6) * 1000 + 6000); // never get stuck on a line
    if (line.audio && line.id) {
      player.onended = end;
      player.onerror = () => { if (!finished) speakLocal(line, end); };
      player.src = '/api/voice/' + encodeURIComponent(line.id);
      player.play().catch(() => { if (!finished) speakLocal(line, end); });
    } else speakLocal(line, end);
  }
  function speakLocal(line, end) {
    if (!synth) return setTimeout(end, (line.dur || 4) * 1000);
    const u = new SpeechSynthesisUtterance(line.text);
    const v = voices[line.who];
    if (v) u.voice = v;
    u.rate = line.who === 'Mick' ? 1.08 : 1.0;
    u.pitch = line.who === 'Mick' ? 0.95 : 1.05;
    u.onend = end; u.onerror = end;
    synth.speak(u);
  }

  function setOn(v) {
    on = v;
    queue = [];
    playing = false;
    player.pause();
    if (synth) synth.cancel();
    if (!on) { hooks.onLine(null, null); return; }
    chooseVoices();
    // unlock audio inside the click, so phones let the booth play later
    player.src = '/api/voice/hello';
    player.play().catch(() => {});
    if (synth) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); }
    hooks.onLine('Booth', 'Commentary on. Mick and Sasha are with you.', 3);
  }

  return {
    setHooks(h) { hooks = { ...hooks, ...h }; },
    available: true,
    get on() { return on; },
    setOn, onVoice,
  };
})();
