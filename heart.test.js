// Run: node --test heart.test.js
const test = require('node:test');
const assert = require('node:assert');
const Heart = require('./heart.js');

const SR = 48000;
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * A phone on the chest: S1 ("lub", ~45 Hz, 100 ms) and S2 ("dub", ~70 Hz,
 * 80 ms, softer) each beat, with beat-to-beat variation, plus room noise
 * (voices and hum above the heart band) and a little low rumble.
 */
function chest({ bpm = 72, seconds = 20, level = 0.05, noise = 0.02, voice = 0, jitter = 0.03, seed = 1 }) {
  const rand = rng(seed), out = new Float32Array(seconds * SR);
  const thud = (at, hz, ms, amp) => {
    const n = Math.round(ms / 1000 * SR);
    for (let i = 0; i < n && at + i < out.length; i++) {
      const t = i / SR, w = Math.sin(Math.PI * i / n) ** 2;
      out[at + i] += amp * w * Math.sin(2 * Math.PI * hz * t);
    }
  };
  for (let t = 0.3; t < seconds; ) {
    const period = 60 / bpm * (1 + jitter * (rand() - 0.5) * 2);
    thud(Math.round(t * SR), 45, 100, level);
    thud(Math.round((t + Math.min(0.33, 0.4 * period)) * SR), 70, 80, 0.6 * level);
    t += period;
  }
  let low = 0;
  for (let i = 0; i < out.length; i++) {
    low = 0.999 * low + 0.001 * (rand() - 0.5);                         // slow rumble
    out[i] += noise * (rand() - 0.5) + 0.3 * noise * low * 30
      + voice * Math.sin(2 * Math.PI * 220 * i / SR) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * i / SR));
  }
  return out;
}

test('measures heart rate from the sound', () => {
  for (const bpm of [52, 72, 95, 130]) {
    const r = Heart.analyze(chest({ bpm, seed: bpm }), SR);
    assert.equal(r.verdict, 'ok', r.problem);
    assert.ok(Math.abs(r.heartRate - bpm) <= 3, `${bpm} read as ${r.heartRate}`);
    assert.ok(Math.abs(r.beats.length - bpm / 3) <= 4, `${r.beats.length} beats for ${bpm} bpm`);
  }
});

test('a voice in the room does not stop it hearing the heart', () => {
  const r = Heart.analyze(chest({ bpm: 80, voice: 0.2, seed: 5 }), SR);
  assert.equal(r.verdict, 'ok', r.problem);
  assert.ok(Math.abs(r.heartRate - 80) <= 3, `read as ${r.heartRate}`);
});

test('noise alone, silence, or a short recording is not a heartbeat', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const r = Heart.analyze(chest({ level: 0, noise: 0.05, seed }), SR);
    assert.equal(r.verdict, 'retake', `seed ${seed}: heard ${r.heartRate}`);
  }
  assert.equal(Heart.analyze(new Float32Array(SR * 20), SR).verdict, 'retake');
  assert.equal(Heart.analyze(chest({ seconds: 5 }), SR).code, 'short');
});

test('the filter keeps the heart band and removes voices', () => {
  const tone = (hz) => Float32Array.from({ length: SR * 2 }, (_, i) => Math.sin(2 * Math.PI * hz * i / SR));
  const level = (hz) => { const { y } = Heart.filterAll(tone(hz), SR); return Math.sqrt(y.slice(2000).reduce((a, v) => a + v * v, 0) / (y.length - 2000)); };
  assert.ok(level(60) > 0.6, `60 Hz kept: ${level(60)}`);
  assert.ok(level(800) < 0.02, `800 Hz removed: ${level(800)}`);
  assert.ok(level(8) < 0.15, `8 Hz rumble reduced: ${level(8)}`);
});

test('audible version and WAV export', () => {
  const r = Heart.analyze(chest({ bpm: 70 }), SR);
  const { samples, sampleRate } = Heart.audible(r.wide, r.rate);
  assert.equal(sampleRate, 8000);
  assert.ok(Math.abs(samples.length / sampleRate - r.wide.length / r.rate) < 0.01, 'same length as the recording');
  // The 45 Hz lub comes out near 245 Hz.
  const tone = (hz) => { let re = 0, im = 0; for (let i = 0; i < samples.length; i++) { re += samples[i] * Math.cos(2 * Math.PI * hz * i / sampleRate); im += samples[i] * Math.sin(2 * Math.PI * hz * i / sampleRate); } return Math.hypot(re, im); };
  assert.ok(tone(245) > 20 * tone(45), `raised: ${tone(245)} vs ${tone(45)}`);
  const buf = Heart.wav(samples, sampleRate);
  assert.equal(buf.byteLength, 44 + samples.length * 2);
});

test('labels lub and dub in the right order', () => {
  for (const bpm of [60, 75, 100]) {
    const r = Heart.analyze(chest({ bpm, seed: bpm, jitter: 0 }), SR);   // steady beats, so the true lub times are known
    const seg = r.seg, period = 60 / bpm, gap = Math.min(0.33, 0.4 * period);
    assert.ok(seg.s1.length >= bpm / 3 - 4, `${seg.s1.length} lubs at ${bpm} bpm`);
    // The chest() lub is centred at 0.35 s + k·period (envelope time starts 0.5 s in); filters delay it a little.
    const phase = (t) => { const p = ((t + 0.5 - 0.35) % period + period) % period; return Math.min(p, period - p); };
    const onLub = seg.s1.filter((t) => phase(t) < 0.1).length / seg.s1.length;
    assert.ok(onLub > 0.9, `${bpm} bpm: only ${onLub} of lubs on S1`);
    assert.ok(Math.abs(seg.systole - (gap - 0.01)) < 0.06, `${bpm} bpm: systole ${seg.systole}, expected ~${gap}`);
  }
});

// Real recordings from the CirCor DigiScope dataset (PhysioNet, ODC-By 1.0).
function readWav(file) {
  const b = require('node:fs').readFileSync(require('node:path').join(__dirname, file));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), n = dv.getUint32(40, true) >> 1;
  return { x: Float32Array.from({ length: n }, (_, i) => dv.getInt16(44 + 2 * i, true) / 32768), rate: dv.getUint32(24, true) };
}

test('murmur check on real recordings: normal heart and a loud murmur', () => {
  const normal = readWav('sounds/circor-normal.wav'), murmur = readWav('sounds/circor-murmur.wav');
  const a = Heart.analyze(normal.x, normal.rate), b = Heart.analyze(murmur.x, murmur.rate);
  assert.equal(a.murmur.level, 'none', `normal scored ${a.murmur.p}`);
  assert.equal(b.murmur.level, 'possible', `murmur scored ${b.murmur.p}`);
  assert.ok(b.murmur.loudSystoleShare > 0.8);
  const both = Heart.combineSpots([{ ...a, spot: 'PV' }, { ...b, spot: 'TV' }]);
  assert.equal(both.level, 'possible'); assert.equal(both.spot, 'TV'); assert.equal(both.spots, 2);
});

test('a whoosh added between lub and dub raises the murmur score', () => {
  const quiet = chest({ bpm: 80, seed: 3, noise: 0.004 }), loud = Float32Array.from(quiet);
  const rand = rng(9), period = 0.75;
  for (let t = 0.3; t < 20; t += period) {
    for (let i = Math.round((t + 0.11) * SR); i < Math.round((t + 0.27) * SR) && i < loud.length; i++) loud[i] += 0.03 * (rand() - 0.5);
  }
  const a = Heart.analyze(quiet, SR), b = Heart.analyze(loud, SR);
  assert.ok(a.murmur && b.murmur, 'both judged');
  assert.ok(b.murmur.p > a.murmur.p + 0.3, `quiet ${a.murmur.p} vs whoosh ${b.murmur.p}`);
});
