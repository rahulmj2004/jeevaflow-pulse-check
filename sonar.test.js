// Run: node --test sonar.test.js
const test = require('node:test');
const assert = require('node:assert');
const Sonar = require('./sonar.js');

const SR = 48000, C = 343;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * What the microphone hears: each tone straight from the speaker, plus a
 * weak echo from a chest 40 cm away that moves `chest(t)` metres, plus a
 * fixed echo from the bed and room noise. Fed to the demodulator in 4096-
 * sample chunks, as the browser does.
 */
function night({ seconds, chest, echo = 0.02, noise = 0.003, tones = Sonar.TONES, gain = 0.15, seed = 1 }) {
  const rand = rng(seed);
  const demod = Sonar.createDemod(SR);
  const chunk = new Float32Array(4096);
  const total = seconds * SR;
  for (let n0 = 0; n0 < total; n0 += chunk.length) {
    for (let i = 0; i < chunk.length; i++) {
      const t = (n0 + i) / SR, d = 0.4 + chest(t);
      let v = 0;
      for (const f of tones) {
        const w = 2 * Math.PI * f;
        v += gain * Math.cos(w * t + 0.3)                       // straight from the speaker
          + gain * 0.05 * Math.cos(w * (t - 0.9 / C))           // bed / wall, does not move
          + gain * echo * Math.cos(w * (t - 2 * d / C));        // chest echo
      }
      chunk[i] = v + noise * (rand() - 0.5) * 3.46;
    }
    demod.push(chunk);
  }
  return demod;
}

/** Chest movement: breaths of 4 mm at `perMin`, with optional held-breath stretches [from, to] in seconds. */
const breathing = (perMin, holds = []) => (t) => {
  const held = holds.find(([a, b]) => t >= a && t < b);
  const tt = held ? held[0] : t;   // the chest stays where it was
  return 0.002 * (1 - Math.cos(2 * Math.PI * tt * perMin / 60));
};

test('measures the breathing rate from the echo', () => {
  for (const perMin of [10, 15, 22]) {
    const demod = night({ seconds: 60, chest: breathing(perMin), seed: perMin });
    const r = Sonar.analyze(demod);
    assert.equal(r.verdict, 'ok', r.problem);
    assert.ok(Math.abs(r.ratePerMin - perMin) <= 1, `${perMin}/min read as ${r.ratePerMin}`);
    assert.equal(r.pauses.length, 0, `${perMin}/min: false pause ${JSON.stringify(r.pauses)}`);
  }
});

test('finds a 15-second breathing pause at the right time, and only one', () => {
  const demod = night({ seconds: 60, chest: breathing(14, [[30, 45]]), seed: 7 });
  const r = Sonar.analyze(demod);
  assert.equal(r.verdict, 'ok', r.problem);
  assert.equal(r.pauses.length, 1, JSON.stringify(r.pauses));
  const p = r.pauses[0];
  assert.ok(Math.abs(p.from - 30) <= 3 && Math.abs(p.to - 45) <= 3, `pause ${p.from.toFixed(1)}–${p.to.toFixed(1)}`);
  const nightLog = Sonar.createNight();
  nightLog.update(r); nightLog.update(r);
  assert.equal(nightLog.events.length, 1, 'counted once across overlapping windows');
});

test('a 6-second pause between breaths is not counted', () => {
  const r = Sonar.analyze(night({ seconds: 60, chest: breathing(14, [[30, 36]]), seed: 8 }));
  assert.equal(r.pauses.length, 0, JSON.stringify(r.pauses));
});

test('no chest in front of the phone, or no tone reaching the microphone', () => {
  const still = Sonar.analyze(night({ seconds: 60, chest: () => 0, seed: 9 }));
  assert.notEqual(still.verdict, 'ok', 'a still room is not breathing');
  const silent = Sonar.analyze(night({ seconds: 30, chest: breathing(15), gain: 0, seed: 10 }));
  assert.equal(silent.code, 'no-tone');
  assert.equal(Sonar.analyze(night({ seconds: 10, chest: breathing(15) })).verdict, 'wait');
});

test('works when only some tones get through', () => {
  const r = Sonar.analyze(night({ seconds: 60, chest: breathing(16), tones: [18000, 18500], seed: 11 }));
  assert.equal(r.verdict, 'ok', r.problem);
  assert.equal(r.tonesHeard, 2);
  assert.ok(Math.abs(r.ratePerMin - 16) <= 1, `rate ${r.ratePerMin}`);
});
