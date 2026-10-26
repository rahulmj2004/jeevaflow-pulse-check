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
  const a = Heart.audible(r.envelope, 2);
  assert.equal(a.length, 2 * 22050);
  assert.ok(Math.max(...a) > 0.3);
  const buf = Heart.wav(a, 22050);
  assert.equal(buf.byteLength, 44 + a.length * 2);
});
