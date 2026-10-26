// Run: node --test motion.test.js
const test = require('node:test');
const assert = require('node:assert');
const Motion = require('./motion.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * Phone accelerometer at ~60 Hz with uneven timing: a tremor of `hz` and
 * RMS size `rms` (m/s²) along a tilted axis, sensor noise, slow hand drift,
 * and gravity when `gravity` is set.
 */
function held({ hz = 5, rms = 0, seconds = 20, rate = 60, noise = 0.03, wander = 0.05, gravity = false, seed = 1, drift = null }) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const axis = [0.6, 0.3, 0.74], amp = rms * Math.SQRT2, out = [];
  let phase = 0;
  for (let t = 0; t <= seconds * 1000; t += 1000 / rate + (rand() - 0.5) * 4) {
    phase += 2 * Math.PI * (hz * (1 + 0.03 * Math.sin(t / 1700))) / rate;
    const shake = amp * Math.sin(phase);
    const slow = wander * Math.sin(2 * Math.PI * t / 2300);
    let g = [0, 0, 0];
    if (gravity) {
      const tilt = (drift ? drift(t / 1000) : 0) * Math.PI / 180;
      g = [0, 9.81 * Math.sin(tilt), 9.81 * Math.cos(tilt)];
    }
    out.push({ t, x: g[0] + axis[0] * shake + slow + noise * gauss(), y: g[1] + axis[1] * shake + noise * gauss(), z: g[2] + axis[2] * shake + noise * gauss() });
  }
  return out;
}

test('finds the tremor frequency and size', () => {
  for (const [hz, rms] of [[4.5, 0.8], [5.5, 0.35], [9, 0.3], [11, 0.25]]) {
    const r = Motion.tremor(held({ hz, rms, seed: hz * 10 }));
    assert.equal(r.verdict, 'ok', r.problem);
    assert.ok(Math.abs(r.hz - hz) <= 0.3, `${hz} Hz read as ${r.hz}`);
    assert.ok(Math.abs(r.rmsMs2 - rms) / rms < 0.2, `rms ${r.rmsMs2} vs ${rms}`);
    assert.notEqual(r.level, 'none', `${hz} Hz ${rms} m/s² missed`);
  }
  assert.equal(Motion.tremor(held({ hz: 5, rms: 0.8 })).level, 'strong');
  assert.equal(Motion.tremor(held({ hz: 5, rms: 0.3 })).range, 'parkinson-range');
  assert.equal(Motion.tremor(held({ hz: 10, rms: 0.3 })).range, 'physiological-range');
});

test('a steady hand has no tremor, with or without gravity in the signal', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = Motion.tremor(held({ rms: 0, seed, gravity: seed % 2 === 0 }));
    assert.equal(r.verdict, 'ok', r.problem);
    assert.equal(r.level, 'none', `seed ${seed}: ${r.rmsMs2}`);
  }
});

test('size in millimetres follows from acceleration and frequency', () => {
  const r = Motion.tremor(held({ hz: 5, rms: 0.5, noise: 0.005 }));
  // 0.5 m/s² RMS at 5 Hz: 2·√2·0.5 / (2π·5)² m ≈ 1.43 mm back and forth.
  assert.ok(Math.abs(r.sizeMm - 1.43) < 0.25, `size ${r.sizeMm}`);
});

test('no sensor, too short, too slow, and big movements ask for a retake', () => {
  assert.equal(Motion.tremor([]).code, 'no-sensor');
  assert.equal(Motion.tremor(held({ seconds: 6 })).code, 'short');
  assert.equal(Motion.tremor(held({ rate: 15 })).code, 'slow');
  const swinging = held({ rms: 0 }).map((s) => ({ ...s, x: s.x + 6 * Math.sin(2 * Math.PI * s.t / 1000) }));
  assert.equal(Motion.tremor(swinging).code, 'moved');
});

test('arm drift: a steady arm stays level, a sinking arm tilts', () => {
  const steady = Motion.armDrift(held({ gravity: true, seconds: 10, drift: () => 2 }));
  assert.equal(steady.verdict, 'ok', steady.problem);
  assert.ok(steady.driftDeg < 3, `steady ${steady.driftDeg}`);
  assert.equal(steady.drifted, false);

  const sinking = Motion.armDrift(held({ gravity: true, seconds: 10, drift: (s) => 2 + 2.5 * s, seed: 3 }));
  assert.equal(sinking.verdict, 'ok', sinking.problem);
  assert.ok(Math.abs(sinking.driftDeg - 2.5 * 8.5) < 4, `sinking ${sinking.driftDeg}`);
  assert.equal(sinking.drifted, true);

  const cmp = Motion.compareArms(steady, sinking);
  assert.equal(cmp.sign, true);
  assert.equal(cmp.weaker, 'right');
  assert.equal(Motion.compareArms(steady, steady).sign, false);

  assert.equal(Motion.armDrift(held({ gravity: true, seconds: 10, drift: () => 60 })).code, 'not-flat');
});
