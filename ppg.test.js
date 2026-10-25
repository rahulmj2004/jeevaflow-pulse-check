// Run: node --test vitals-web/   (same synthetic signals as the Dart tests)
const test = require('node:test');
const assert = require('node:assert');
const Ppg = require('./ppg.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function synthetic({ intervals, seconds = 30, fps = 30, noise = 0.15, amplitude = 1.2, breathingPerMin = 0,
  breathingAmplitude = 0, baseRed = 200, baseGreen = 40, seed = 1 }) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const beats = [];
  for (let t = 300, i = 0; t < seconds * 1000 + 2000; t += intervals[i++ % intervals.length]) beats.push(t);
  const out = [];
  for (let now = 0; now <= seconds * 1000; now += 1000 / fps + (rand() - 0.5) * 8) {
    let pulse = 0;
    for (const b of beats) {
      const d = now - b;
      if (d < -400 || d > 900) continue;
      pulse += Math.exp(-((d / 70) ** 2)) + 0.35 * Math.exp(-(((d - 330) / 90) ** 2));
    }
    const drift = 1.5 * Math.sin(2 * Math.PI * now / 40000);
    const breath = breathingAmplitude * Math.sin(2 * Math.PI * now / 60000 * breathingPerMin);
    out.push({ t: now, red: baseRed - amplitude * pulse + drift + breath + noise * gauss(), green: baseGreen + 0.2 * gauss() });
  }
  return out;
}

for (const bpm of [50, 72, 95, 130]) {
  test(`${bpm} bpm is measured within ±2 bpm by both methods`, () => {
    const r = Ppg.analyze(synthetic({ intervals: [60000 / bpm] }));
    assert.equal(r.verdict, 'good', r.problem);
    assert.ok(Math.abs(r.heartRate - bpm) <= 2, `peaks ${r.heartRate}`);
    assert.ok(Math.abs(r.spectralHeartRate - bpm) <= 2, `spectrum ${r.spectralHeartRate}`);
  });
}

test('weak, noisy pulse is still measured', () => {
  const r = Ppg.analyze(synthetic({ intervals: [800], amplitude: 0.6, noise: 0.25, seed: 7 }));
  assert.equal(r.verdict, 'good', r.problem);
  assert.ok(Math.abs(r.heartRate - 75) <= 2);
});

test('HRV follows the beat-to-beat variation', () => {
  const r = Ppg.analyze(synthetic({ intervals: [760, 840] }));
  assert.equal(r.verdict, 'good', r.problem);
  assert.ok(Math.abs(r.rmssdMs - 80) <= 15, `rmssd ${r.rmssdMs}`);
  assert.ok(Math.abs(r.sdnnMs - 40) <= 10, `sdnn ${r.sdnnMs}`);
});

test('breathing at 15 / min is found', () => {
  const r = Ppg.analyze(synthetic({ intervals: [800], breathingPerMin: 15, breathingAmplitude: 1 }));
  assert.equal(r.verdict, 'good', r.problem);
  assert.ok(Math.abs(r.respiratoryRate - 15) <= 2.5, `resp ${r.respiratoryRate}`);
});

test('noise, an uncovered camera, a short recording and motion all ask for a retake', () => {
  const rand = rng(3);
  const noise = Array.from({ length: 900 }, (_, i) => ({ t: i * 33.3, red: 200 + 2 * (rand() - 0.5), green: 40 }));
  assert.equal(Ppg.analyze(noise).verdict, 'retake');
  assert.equal(Ppg.analyze(noise).heartRate, undefined);

  const uncovered = Ppg.analyze(synthetic({ intervals: [800], baseRed: 120, baseGreen: 110 }));
  assert.match(uncovered.problem, /not fully covered/);

  assert.match(Ppg.analyze(synthetic({ intervals: [800], seconds: 8 })).problem, /too short/);

  const jolt = rng(9);
  let offset = 0, next = 0;
  const shaken = synthetic({ intervals: [800] }).map((s) => {
    if (s.t >= next) { offset = (jolt() - 0.5) * 16; next = s.t + 300 + jolt() * 400; }
    return { ...s, red: s.red + offset };
  });
  assert.equal(Ppg.analyze(shaken).verdict, 'retake');
});

test('averages the centre of RGBA pixels', () => {
  const w = 40, h = 30, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([220, 60, 30, 255], i);
  const { red, green } = Ppg.averageRgba(data, w, h);
  assert.equal(red, 220);
  assert.equal(green, 60);
  assert.ok(Ppg.fingerCovers(red, green));
});
