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

/**
 * A synthetic face recording: blood absorbs mostly green, so each beat
 * dims the channels by relative strengths 0.33 / 0.77 / 0.53 (de Haan &
 * Jeanne 2013), on top of lighting changes common to all channels that
 * are 10× stronger than the pulse, plus camera noise. Averaging a few
 * thousand skin pixels leaves roughly ±0.05 of noise per frame; the
 * default here is twice that.
 */
function syntheticFace({ bpm, seconds = 30, lighting = 0.03, noise = 0.1, skin = 0.8, seed = 2, base = [190, 130, 110] }) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const strength = [0.33, 0.77, 0.53].map((k) => k * 0.004);
  const out = [];
  let walk = 0;
  for (let t = 0; t <= seconds * 1000; t += 1000 / 30 + (rand() - 0.5) * 8) {
    const phase = (t / 1000) * (bpm / 60);
    const pulse = Math.pow(Math.max(0, Math.sin(2 * Math.PI * phase)), 3);
    walk += (rand() - 0.5) * 0.002;
    const light = 1 + lighting * Math.sin(2 * Math.PI * t / 3300) + walk;
    const [r, g, b] = base.map((c, i) => c * light * (1 - strength[i] * pulse) + noise * gauss());
    out.push({ t, r, g, b, skin });
  }
  return out;
}

for (const bpm of [58, 76, 104]) {
  test(`face: ${bpm} bpm through lighting changes 10× the pulse`, () => {
    const r = Ppg.analyzeFace(syntheticFace({ bpm }));
    assert.equal(r.verdict, 'good', r.problem);
    assert.ok(Math.abs(r.heartRate - bpm) <= 3, `face hr ${r.heartRate}`);
    assert.equal(r.rmssdMs, null, 'no HRV claimed from face video');
  });
}

test('face: heavy noise never produces a wrong number', () => {
  for (const noise of [0.2, 0.3, 0.5]) {
    for (let bpm = 50; bpm <= 150; bpm += 10) {
      const r = Ppg.analyzeFace(syntheticFace({ bpm, noise, seed: bpm }));
      if (r.verdict === 'good') assert.ok(Math.abs(r.heartRate - bpm) <= 3, `${bpm} read as ${r.heartRate}`);
    }
  }
});

test('face: no face in the oval, darkness, or a short clip ask for a retake', () => {
  assert.match(Ppg.analyzeFace(syntheticFace({ bpm: 70, skin: 0.1 })).problem, /oval/);
  assert.match(Ppg.analyzeFace(syntheticFace({ bpm: 70, base: [30, 20, 18] })).problem, /too dark/);
  assert.match(Ppg.analyzeFace(syntheticFace({ bpm: 70, seconds: 9 })).problem, /too short/);
});

test('face: pure noise gives no number', () => {
  const rand = rng(11);
  const samples = Array.from({ length: 900 }, (_, i) => ({
    t: i * 33.3, r: 190 + 2 * (rand() - 0.5), g: 130 + 2 * (rand() - 0.5), b: 110 + 2 * (rand() - 0.5), skin: 0.8,
  }));
  assert.equal(Ppg.analyzeFace(samples).verdict, 'retake');
});

test('skin test and face oval averaging', () => {
  assert.ok(Ppg.isSkin(190, 130, 110));
  assert.ok(!Ppg.isSkin(60, 120, 200));
  const w = 60, h = 40, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([190, 130, 110, 255], i);
  const f = Ppg.averageFace(data, w, h);
  assert.equal(f.r, 190);
  assert.equal(f.skin, 1);
});

test('stress is only shown against the person\'s own usual HRV', () => {
  assert.equal(Ppg.stressVsUsual(40, [42, 38]), null, 'needs 3 earlier readings');
  assert.equal(Ppg.stressVsUsual(null, [40, 42, 38]), null);
  assert.equal(Ppg.stressVsUsual(40, [42, 38, 41, 39]).level, 'usual');
  assert.equal(Ppg.stressVsUsual(22, [42, 38, 41, 39]).level, 'higher');
  assert.equal(Ppg.stressVsUsual(65, [42, 38, 41, 39]).level, 'lower');
});

// ---- Heart rhythm (AFib) ----

/** Beat-to-beat intervals: random and independent, as in atrial fibrillation. */
function afibIntervals(meanMs, spread, seed, n = 80) {
  const rand = rng(seed);
  return Array.from({ length: n }, () => meanMs * (1 + spread * 2 * (rand() - 0.5)));
}

test('rhythm: steady and breathing-modulated hearts are regular', () => {
  for (const bpm of [55, 72, 100]) {
    const r = Ppg.rhythm(synthetic({ intervals: [60000 / bpm] }));
    assert.equal(r.verdict, 'ok', r.problem);
    assert.equal(r.rhythm, 'regular', `${bpm}: nRmssd ${r.nRmssd} share ${r.irregularShare}`);
    assert.ok(Math.abs(r.heartRate - bpm) <= 3, `hr ${r.heartRate}`);
  }
  // Sinus arrhythmia: intervals swing ±8% with each breath (5 beats), a healthy pattern.
  const rsa = Array.from({ length: 5 }, (_, k) => 900 * (1 + 0.08 * Math.sin(2 * Math.PI * k / 5)));
  const r = Ppg.rhythm(synthetic({ intervals: rsa, seed: 4 }));
  assert.equal(r.verdict, 'ok', r.problem);
  assert.notEqual(r.rhythm, 'irregular', `nRmssd ${r.nRmssd} share ${r.irregularShare}`);
});

test('rhythm: atrial fibrillation is irregular, where the pulse reading gives up', () => {
  for (const [mean, seed] of [[650, 1], [800, 2], [950, 3]]) {
    const samples = synthetic({ intervals: afibIntervals(mean, 0.5, seed), seed });
    const r = Ppg.rhythm(samples);
    assert.equal(r.verdict, 'ok', r.problem);
    assert.equal(r.rhythm, 'irregular', `mean ${mean}: nRmssd ${r.nRmssd} share ${r.irregularShare}`);
    assert.ok(Math.abs(r.heartRate - 60000 / mean) <= 8, `hr ${r.heartRate}`);
  }
});

test('rhythm: an occasional early beat is not called irregular', () => {
  const intervals = [800, 800, 800, 800, 800, 800, 520, 1080, 800, 800, 800, 800];
  const r = Ppg.rhythm(synthetic({ intervals, seed: 6 }));
  assert.equal(r.verdict, 'ok', r.problem);
  assert.equal(r.rhythm, 'early-beats', `nRmssd ${r.nRmssd}`);
  assert.ok(r.earlyBeats >= 2);
});

test('rhythm: movement and noise ask for a retake, never "irregular"', () => {
  const jolt = rng(9);
  for (let trial = 0; trial < 5; trial++) {
    let offset = 0, next = 0;
    const shaken = synthetic({ intervals: [800], seed: trial + 20 }).map((s) => {
      if (s.t >= next) { offset = (jolt() - 0.5) * 16; next = s.t + 300 + jolt() * 400; }
      return { ...s, red: s.red + offset };
    });
    const r = Ppg.rhythm(shaken);
    assert.notEqual(r.rhythm, 'irregular', `trial ${trial} read as irregular`);
  }
  const rand = rng(3);
  const noise = Array.from({ length: 900 }, (_, i) => ({ t: i * 33.3, red: 200 + 2 * (rand() - 0.5), green: 40 }));
  assert.equal(Ppg.rhythm(noise).verdict, 'retake');
  assert.match(Ppg.rhythm(synthetic({ intervals: [800], seconds: 15 })).problem, /too short/);
});

test('rhythm: across 40 runs each, a normal heart is never called irregular', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const noisy = Ppg.rhythm(synthetic({ intervals: [600 + seed * 15], amplitude: 0.6, noise: 0.25, seed }));
    assert.ok(noisy.verdict === 'retake' || noisy.rhythm === 'regular', `noisy seed ${seed}: ${noisy.rhythm}`);
    // Strong sinus arrhythmia (±12%) following slightly uneven breathing.
    const rand = rng(seed + 100), iv = [];
    for (let i = 0, ph = 0; i < 60; i++) { ph += 2 * Math.PI / (4 + 3 * rand()); iv.push((700 + seed * 10) * (1 + 0.12 * Math.sin(ph))); }
    assert.equal(Ppg.rhythm(synthetic({ intervals: iv, seed })).rhythm, 'regular', `sinus arrhythmia seed ${seed}`);
    assert.equal(Ppg.rhythm(synthetic({ intervals: afibIntervals(500 + seed * 15, 0.4, seed), seed })).rhythm, 'irregular', `AF seed ${seed}`);
  }
});
