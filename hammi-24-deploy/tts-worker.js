// Voices for the commentary booth: runs the Kokoro neural text-to-speech model in its own
// process, so the race never stutters while a line is being voiced. The server sends
// { id, text, voice } and gets back { id, wav (base64, 16-bit mono), dur } or { id, error }.
// Needs `npm install kokoro-js` in this folder. The model (about 90 MB) downloads on first start.
'use strict';

const MODEL = process.env.TTS_MODEL || 'onnx-community/Kokoro-82M-v1.0-ONNX';

function wav16(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// trim the quiet the model leaves at each end, so lines follow each other tightly
function trim(a) {
  let s = 0, e = a.length - 1;
  while (s < e && Math.abs(a[s]) < 0.004) s++;
  while (e > s && Math.abs(a[e]) < 0.004) e--;
  return a.subarray(Math.max(0, s - 600), Math.min(a.length, e + 2400));
}

(async () => {
  let tts;
  try {
    const { KokoroTTS } = await import('kokoro-js');
    tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu' });
  } catch (e) {
    process.send({ type: 'failed', error: String(e && e.message || e).slice(0, 300) });
    process.exit(1);
  }
  process.send({ type: 'ready' });
  const jobs = [];
  let working = false;
  async function next() {
    if (working) return;
    const job = jobs.shift();
    if (!job) return;
    working = true;
    try {
      const t0 = Date.now();
      const audio = await tts.generate(job.text, { voice: job.voice, speed: job.speed || 1 });
      const pcm = trim(audio.audio);
      process.send({ type: 'done', id: job.id, wav: wav16(pcm, audio.sampling_rate).toString('base64'), dur: pcm.length / audio.sampling_rate, ms: Date.now() - t0 });
    } catch (e) {
      process.send({ type: 'done', id: job.id, error: String(e && e.message || e).slice(0, 200) });
    }
    working = false;
    next();
  }
  process.on('message', (m) => { if (m && m.type === 'say') { jobs.push(m); next(); } });
})();
