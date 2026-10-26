/**
 * Hand tremor and arm drift from the phone's motion sensor.
 *
 * Tremor: the phone is held for 20 seconds. Shaking shows up as a rhythmic
 * acceleration; its frequency (shakes per second) and size are measured
 * from the spectrum. Parkinson's rest tremor is typically 4–6 Hz, essential
 * tremor 4–12 Hz, and everyone has a tiny 8–12 Hz physiological tremor.
 *
 * Arm drift: the phone is held flat on the palm with the arm stretched out
 * and eyes closed. A weak arm slowly sinks and turns inward, which tilts
 * the phone; the tilt is read from the direction of gravity.
 *
 * Size cut-offs here are provisional: they have not been checked against
 * patients examined by a neurologist.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Motion = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const RATE = 50;                       // Hz, after resampling
  const BAND = [3, 14];                  // tremor band, Hz
  const NO_TREMOR_RMS = 0.15, STRONG_TREMOR_RMS = 0.6;   // m/s², provisional
  const MIN_RHYTHMIC = 0.3;              // share of band power near the peak
  const DRIFT_DEG = 10, DRIFT_GAP_DEG = 8;               // provisional

  /** samples: [{t (ms), x, y, z}] at any uneven rate -> {t, x, y, z} arrays at `rate`. */
  function resample(samples, rate = RATE) {
    const out = { x: [], y: [], z: [] };
    if (samples.length < 2) return out;
    const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
    let j = 0;
    for (let t = t0; t <= t1; t += 1000 / rate) {
      while (j < samples.length - 2 && samples[j + 1].t < t) j++;
      const a = samples[j], b = samples[j + 1], f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      for (const k of ['x', 'y', 'z']) out[k].push(a[k] + (b[k] - a[k]) * Math.max(0, Math.min(1, f)));
    }
    return out;
  }

  function biquad(kind, hz, rate) {
    const w = 2 * Math.PI * hz / rate, alpha = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w), a0 = 1 + alpha;
    const b = kind === 'low' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0 };
  }
  function filter(f, x) {
    const y = new Array(x.length);
    let x1 = x[0], x2 = x[0], y1 = kindStart(f, x[0]), y2 = y1;
    for (let i = 0; i < x.length; i++) {
      y[i] = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y[i];
    }
    return y;
  }
  // Start a low-pass at the first value and a high-pass at zero, so the
  // filter does not ring from a step at t = 0.
  const kindStart = (f, v) => (Math.abs(f.b0 + f.b1 + f.b2) > 1e-6 ? v : 0);
  const bandpass = (x, lo, hi, rate = RATE) => filter(biquad('low', hi, rate), filter(biquad('high', lo, rate), x));
  const lowpass = (x, hz, rate = RATE) => filter(biquad('low', hz, rate), x);
  const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));

  /** Power spectrum of x on a grid of frequencies (direct DFT; x is short). */
  function spectrum(x, from, to, step, rate = RATE) {
    const out = [];
    for (let hz = from; hz <= to + 1e-9; hz += step) {
      let re = 0, im = 0;
      for (let i = 0; i < x.length; i++) {
        const ph = 2 * Math.PI * hz * i / rate, w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (x.length - 1));
        re += w * x[i] * Math.cos(ph); im -= w * x[i] * Math.sin(ph);
      }
      out.push([hz, re * re + im * im]);
    }
    return out;
  }

  /**
   * samples: [{t, x, y, z}] linear acceleration in m/s² (gravity removed or
   * not; it is filtered out). Returns the tremor frequency and size, or a
   * retake.
   */
  function tremor(samples) {
    const retake = (code, problem) => ({ verdict: 'retake', code, problem });
    if (samples.length < 20) return retake('no-sensor', 'No motion readings arrived. This browser or device may not share its motion sensor.');
    const seconds = (samples[samples.length - 1].t - samples[0].t) / 1000;
    if (seconds < 10) return retake('short', 'The recording was too short. Hold the phone for the full 20 seconds.');
    const rate = (samples.length - 1) / seconds;
    if (rate < 25) return retake('slow', `The motion sensor only reported ${Math.round(rate)} times a second, too slowly to measure shaking. Try Chrome.`);

    const r = resample(samples);
    const trim = (x) => x.slice(RATE, x.length - RATE / 2);
    // Big, slow movements (walking, swinging the arm) are not tremor.
    const slow = Math.hypot(...['x', 'y', 'z'].map((k) => rms(trim(bandpass(r[k], 0.3, 2)))));
    const axes = ['x', 'y', 'z'].map((k) => trim(bandpass(r[k], BAND[0] - 0.5, BAND[1] + 1)));
    const size = Math.hypot(...axes.map(rms));
    if (slow > 1.5 && slow > 2 * size) return retake('moved', 'The phone moved around too much. Rest your elbow and hold the phone still in your hand.');

    const spec = axes.map((x) => spectrum(x, 2, 16, 0.1));
    const total = spec[0].map(([hz], i) => [hz, spec[0][i][1] + spec[1][i][1] + spec[2][i][1]]);
    let peak = total[0];
    for (const p of total) if (p[0] >= BAND[0] && p[0] <= BAND[1] && p[1] > peak[1]) peak = p;
    const inBand = total.filter(([hz]) => hz >= BAND[0] && hz <= BAND[1]).reduce((a, p) => a + p[1], 0) || 1e-12;
    const near = total.filter(([hz]) => Math.abs(hz - peak[0]) <= 0.5).reduce((a, p) => a + p[1], 0);
    const rhythmic = near / inBand;

    const hz = peak[0];
    // Back-and-forth distance of a sine wave with this RMS acceleration.
    const sizeMm = 2 * Math.SQRT2 * size / (2 * Math.PI * hz) ** 2 * 1000;
    const level = size < NO_TREMOR_RMS || rhythmic < MIN_RHYTHMIC ? 'none' : size < STRONG_TREMOR_RMS ? 'mild' : 'strong';
    const range = hz < 3.5 ? 'slow' : hz <= 7.5 ? 'parkinson-range' : 'physiological-range';
    return {
      verdict: 'ok', level, hz, rmsMs2: size, sizeMm, rhythmic, range, seconds, sensorRate: rate,
      spectrum: total.map(([f, p]) => [f, p]),
    };
  }

  /** Angle in degrees between two vectors. */
  function angle(a, b) {
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const n = Math.hypot(...a) * Math.hypot(...b);
    return n ? Math.acos(Math.max(-1, Math.min(1, dot / n))) * 180 / Math.PI : 0;
  }

  /**
   * samples: [{t, x, y, z}] acceleration including gravity, phone flat on
   * the palm. Compares the gravity direction in seconds 1–2 with the last
   * second: how far the phone tilted.
   */
  function armDrift(samples) {
    const retake = (code, problem) => ({ verdict: 'retake', code, problem });
    if (samples.length < 20) return retake('no-sensor', 'No motion readings arrived. This browser or device may not share its motion sensor.');
    const seconds = (samples[samples.length - 1].t - samples[0].t) / 1000;
    if (seconds < 8) return retake('short', 'Hold your arm out for the full 10 seconds.');
    const r = resample(samples);
    const g = ['x', 'y', 'z'].map((k) => lowpass(r[k], 1));
    const mean = (k, a, b) => { const s = g[k].slice(a, b); return s.reduce((p, v) => p + v, 0) / s.length; };
    const n = g[0].length;
    const start = [0, 1, 2].map((k) => mean(k, RATE, 2 * RATE));
    const end = [0, 1, 2].map((k) => mean(k, n - RATE, n));
    const gStart = Math.hypot(...start);
    if (gStart < 7 || gStart > 12.5) return retake('moved', 'The phone was moving at the start. Hold your arm out first, then start.');
    // How far the phone sits from flat (screen up), at the start.
    const flatDeg = angle(start, [0, 0, 1]) > 90 ? angle(start, [0, 0, -1]) : angle(start, [0, 0, 1]);
    if (flatDeg > 35) return retake('not-flat', 'Rest the phone flat on your palm, screen facing up, and start again.');
    const driftDeg = angle(start, end);
    return { verdict: 'ok', driftDeg, drifted: driftDeg >= DRIFT_DEG, seconds };
  }

  /** Two arms: a sign of weakness if either drifts, or one drifts much more than the other. */
  function compareArms(left, right) {
    const gap = Math.abs(left.driftDeg - right.driftDeg);
    const weaker = left.driftDeg > right.driftDeg ? 'left' : 'right';
    return { sign: left.drifted || right.drifted || gap >= DRIFT_GAP_DEG, weaker, gapDeg: gap };
  }

  return {
    RATE, BAND, NO_TREMOR_RMS, STRONG_TREMOR_RMS, DRIFT_DEG, DRIFT_GAP_DEG,
    resample, bandpass, spectrum, tremor, armDrift, compareArms, angle,
  };
});
