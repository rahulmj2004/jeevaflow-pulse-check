// Run: node --test ear.test.js
const test = require('node:test');
const assert = require('node:assert');
const Ear = require('./ear.js');

const SR = 48000;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** RBJ peaking filter: gainDb < 0 cuts a notch around hz. */
function peaking(x, hz, gainDb, q) {
  const A = 10 ** (gainDb / 40), w = 2 * Math.PI * hz / SR, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const a0 = 1 + al / A;
  const b = [(1 + al * A) / a0, -2 * c / a0, (1 - al * A) / a0], a = [-2 * c / a0, (1 - al / A) / a0];
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    y[i] = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y[i];
  }
  return y;
}

/** One-pole low-pass: a steady downward slope, no dip. */
function tilt(x) {
  const y = new Float32Array(x.length), k = Math.exp(-2 * Math.PI * 2500 / SR);
  for (let i = 0, p = 0; i < x.length; i++) y[i] = p = (1 - k) * x[i] + k * p;
  return y;
}

/**
 * A recording of COUNT chirps every PERIOD_MS after an unknown delay,
 * each shaped by `ear` (a filter), plus room noise.
 */
function recording({ ear = (x) => x, level = 0.2, noise = 0.002, delayMs = 230, periodScale = 1, seed = 1, perChirp }) {
  const rand = rng(seed);
  const tpl = Ear.chirp(SR);
  const out = new Float32Array(Math.round(SR * (0.6 + Ear.COUNT * Ear.PERIOD_MS / 1000 + 0.5)));
  for (let k = 0; k < Ear.COUNT; k++) {
    const shaped = (perChirp ? perChirp(k) : ear)(tpl);
    const at = Math.round(SR * (delayMs + k * Ear.PERIOD_MS * periodScale) / 1000);
    for (let i = 0; i < shaped.length; i++) out[at + i] += level * shaped[i];
  }
  for (let i = 0; i < out.length; i++) out[i] += noise * (rand() - 0.5) * 3.46;
  return out;
}

test('finds a dip where the eardrum absorbs sound', () => {
  const r = Ear.analyzeEcho(recording({ ear: (x) => peaking(x, 3000, -10, 3) }), SR);
  assert.equal(r.verdict, 'ok', r.problem);
  assert.equal(r.chirpsHeard, 10);
  assert.equal(Ear.findChirps(recording({ delayMs: 230 }).subarray(0), Ear.chirp(SR), SR, { count: 6 }).length, 6, 'never more than expected');
  assert.ok(Math.abs(r.dip.hz - 3000) <= 100, `dip at ${r.dip.hz}`);
  assert.ok(r.dip.depthDb > 6 && r.dip.depthDb < 12, `depth ${r.dip.depthDb}`);
});

test('a flat or steadily sloping echo has no dip', () => {
  for (const ear of [(x) => x, tilt]) {
    const r = Ear.analyzeEcho(recording({ ear }), SR);
    assert.equal(r.verdict, 'ok', r.problem);
    assert.ok(r.dip.depthDb < 1.5, `depth ${r.dip.depthDb}`);
  }
});

test('survives a small clock difference between speaker and microphone', () => {
  const r = Ear.analyzeEcho(recording({ ear: (x) => peaking(x, 2600, -8, 3), periodScale: 1.0008 }), SR);
  assert.equal(r.verdict, 'ok', r.problem);
  assert.ok(Math.abs(r.dip.hz - 2600) <= 100, `dip at ${r.dip.hz}`);
});

test('silence, loud noise, clipping and a moving cone ask for a retake', () => {
  const rand = rng(4);
  const silence = Float32Array.from({ length: SR * 5 }, () => 0.002 * (rand() - 0.5));
  assert.match(Ear.analyzeEcho(silence, SR).problem, /did not hear/);
  const zeros = Ear.analyzeEcho(new Float32Array(SR * 5), SR);
  assert.match(zeros.problem, /did not hear/);
  assert.equal(zeros.chirpsHeard, 0);

  assert.equal(Ear.analyzeEcho(recording({ noise: 0.15 }), SR).verdict, 'retake');

  assert.match(Ear.analyzeEcho(recording({ level: 3 }), SR).problem, /too loud/);

  const moving = Ear.analyzeEcho(recording({ perChirp: (k) => (x) => peaking(x, 2100 + k * 230, -12, 4) }), SR);
  assert.match(moving.problem, /cone moved/);
});

test('fft round trip and dip helper', () => {
  const re = Float64Array.from({ length: 8 }, (_, i) => i), im = new Float64Array(8);
  Ear.fft(re, im); Ear.fft(re, im, true);
  re.forEach((v, i) => assert.ok(Math.abs(v / 8 - i) < 1e-9));
  assert.deepEqual(Ear.deepestDip([1, 2, 3, 4, 5], [0, -1, -4, -1, 0]), { hz: 3, depthDb: 4 });
  assert.equal(Ear.deepestDip([1, 2, 3], [3, 2, 1]).depthDb, 0);
});
