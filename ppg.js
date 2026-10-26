/*
 * Camera photoplethysmography (PPG): heart rate from the colour of a
 * fingertip held over the camera with the flash on.
 *
 * A JavaScript port of mobile/lib/features/vitals/ppg/ppg_signal.dart
 * (same algorithm and thresholds). Each heartbeat pushes blood into the
 * fingertip, which absorbs a little more light, so the frame's average
 * red level dips once per beat:
 *
 *   1. resample the frame averages to a steady 30 Hz
 *   2. zero-phase band-pass 0.7–3.5 Hz (42–210 bpm)
 *   3. heart rate two ways: beat peaks, and harmonic-summation spectrum
 *   4. HRV (RMSSD, SDNN) from clean beat intervals
 *   5. breathing rate (estimate) from the slow baseline wobble
 *   6. a quality verdict; a poor signal gives "retake", never a number
 *
 * Runs in the browser (window.Ppg) and in Node (module.exports) for tests.
 * A screening estimate, not a medical device.
 */
(function (root) {
  'use strict';

  const SAMPLE_RATE = 30;
  const LOW_HZ = 0.7;
  const HIGH_HZ = 3.5;
  const MIN_SECONDS = 15;
  const MAX_DISAGREEMENT_BPM = 6;

  /** Whether a frame looks like a fingertip lit by the flash. */
  function fingerCovers(red, green) {
    return red > 80 && red < 254 && red > green * 1.8;
  }

  /** samples: [{t (ms), red, ...}] at any spacing -> samples[key] at 30 Hz. */
  function resample(samples, rate = SAMPLE_RATE, key = 'red') {
    if (samples.length < 2) return [];
    const start = samples[0].t, end = samples[samples.length - 1].t, step = 1000 / rate;
    const out = [];
    let j = 0;
    for (let t = start; t <= end; t += step) {
      while (j < samples.length - 2 && samples[j + 1].t < t) j++;
      const a = samples[j], b = samples[j + 1];
      const span = b.t - a.t;
      const f = span <= 0 ? 0 : Math.min(1, Math.max(0, (t - a.t) / span));
      out.push(a[key] + (b[key] - a[key]) * f);
    }
    return out;
  }

  /** Second-order IIR section (RBJ cookbook, Q = 1/√2). */
  function biquad(kind, hz, rate) {
    const w = 2 * Math.PI * hz / rate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cosw = Math.cos(w);
    const a0 = 1 + alpha;
    const b = kind === 'low'
      ? [(1 - cosw) / 2, 1 - cosw, (1 - cosw) / 2]
      : [(1 + cosw) / 2, -(1 + cosw), (1 + cosw) / 2];
    return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: -2 * cosw / a0, a2: (1 - alpha) / a0 };
  }

  function runFilter(f, x) {
    const y = new Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  /** Zero-phase band-pass (filtfilt of high-pass then low-pass). */
  function bandpass(x, rate = SAMPLE_RATE, low = LOW_HZ, high = HIGH_HZ) {
    if (!x.length) return [];
    const mean = x.reduce((a, b) => a + b, 0) / x.length;
    const hp = biquad('high', low, rate), lp = biquad('low', high, rate);
    let y = x.map((v) => v - mean);
    y = runFilter(lp, runFilter(hp, y));
    y = runFilter(lp, runFilter(hp, y.slice().reverse())).reverse();
    return y;
  }

  function lowpass(x, cutoff, rate = SAMPLE_RATE) {
    if (!x.length) return [];
    const lp = biquad('low', cutoff, rate);
    return runFilter(lp, runFilter(lp, x).reverse()).reverse();
  }

  /** Local maxima above zero, at least minGap apart; sub-sample positions. */
  function findPeaks(x, minGap) {
    const peaks = [];
    let last = -minGap * 2;
    for (let i = 1; i < x.length - 1; i++) {
      if (x[i] <= 0 || x[i] < x[i - 1] || x[i] < x[i + 1]) continue;
      let isMax = true;
      for (let k = Math.max(0, i - minGap); k <= Math.min(x.length - 1, i + minGap); k++) {
        if (x[k] > x[i]) { isMax = false; break; }
      }
      if (!isMax || i - last < minGap) continue;
      const a = x[i - 1], b = x[i], c = x[i + 1];
      const denom = a - 2 * b + c;
      const offset = denom === 0 ? 0 : Math.min(0.5, Math.max(-0.5, 0.5 * (a - c) / denom));
      peaks.push(i + offset);
      last = i;
    }
    return peaks;
  }

  /** Power spectrum (Hann window) at fromHz..toHz: [[hz, power]]. */
  function spectrum(x, fromHz, toHz, stepHz = 1 / 60, rate = SAMPLE_RATE) {
    const n = x.length;
    const win = x.map((v, i) => v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))));
    const out = [];
    for (let f = fromHz; f <= toHz + 1e-9; f += stepHz) {
      let re = 0, im = 0;
      const w = 2 * Math.PI * f / rate;
      for (let i = 0; i < n; i++) { re += win[i] * Math.cos(w * i); im -= win[i] * Math.sin(w * i); }
      out.push([f, re * re + im * im]);
    }
    return out;
  }

  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function std(xs) {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
  }

  function breathing(raw) {
    if (raw.length < SAMPLE_RATE * 20) return null;
    const n = raw.length, xm = (n - 1) / 2;
    const ym = raw.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - xm) * (raw[i] - ym); den += (i - xm) ** 2; }
    const slope = num / den;
    const slow = lowpass(raw.map((v, i) => v - ym - slope * (i - xm)), 0.6);
    const down = slow.filter((_, i) => i % 6 === 0);
    const spec = spectrum(down, 0.1, 0.6, 0.01, SAMPLE_RATE / 6);
    const best = spec.reduce((a, b) => (a[1] >= b[1] ? a : b));
    const mean = spec.reduce((s, p) => s + p[1], 0) / spec.length;
    return best[1] > 3 * mean ? best[0] * 60 : null;
  }

  function retakeResult(problem, duration, extra = {}) {
    return {
      verdict: 'retake', problem, quality: 0, snrDb: -99, beats: 0, cleanIntervals: 0,
      waveform: [], peakIndexes: [], durationSeconds: duration, ...extra,
    };
  }

  /** Fingertip recording: [{t, red, green}] -> result. */
  function analyze(samples) {
    const raw = resample(samples);
    const duration = raw.length / SAMPLE_RATE;

    if (duration < MIN_SECONDS) return retakeResult('The recording was too short. Keep still for the full 30 seconds.', duration);

    const covered = samples.filter((s) => fingerCovers(s.red, s.green)).length / samples.length;
    if (covered < 0.9) return retakeResult('The camera was not fully covered. Rest your fingertip gently over the camera and flash.', duration);

    // Blood absorbs light, so each beat is a dip in red: invert it.
    return estimate(raw.map((v) => -v), { duration, breathingFrom: raw, hrv: true });
  }

  /**
   * Face recording (no touch): [{t, r, g, b, skin}] where r/g/b are the
   * mean colour of skin pixels in the face oval and skin is the share of
   * the oval that looked like skin.
   *
   * Uses POS ("plane orthogonal to skin", Wang et al., IEEE TBME 2017):
   * per 1.6 s window, normalise each channel by its mean and combine
   * G−B and G+B−2R so that brightness changes common to all channels
   * (lighting, small head movements) cancel and the pulse remains.
   */
  function analyzeFace(samples) {
    const R = resample(samples, SAMPLE_RATE, 'r');
    const duration = R.length / SAMPLE_RATE;

    if (duration < MIN_SECONDS) return retakeResult('The recording was too short. Keep still for the full 30 seconds.', duration);

    const onFace = samples.filter((s) => s.skin >= 0.35).length / samples.length;
    if (onFace < 0.9) return retakeResult('Your face was not inside the oval for long enough. Hold the phone steady and keep your face in the oval.', duration);

    const G = resample(samples, SAMPLE_RATE, 'g');
    const B = resample(samples, SAMPLE_RATE, 'b');
    if (G.reduce((a, b) => a + b, 0) / G.length < 40) {
      return retakeResult('It was too dark. Face a window or a lamp so your face is evenly lit.', duration);
    }

    // More blood absorbs more light, so beats are dips in POS: invert so
    // they are peaks, as in the fingertip path.
    return estimate(pos(R, G, B).map((v) => -v), { duration, breathingFrom: null, hrv: false });
  }

  /** POS pulse extraction with overlap-add of 1.6 s windows. */
  function pos(R, G, B, win = Math.round(1.6 * SAMPLE_RATE)) {
    const n = R.length, H = new Array(n).fill(0);
    for (let t = 0; t + win <= n; t++) {
      let mr = 0, mg = 0, mb = 0;
      for (let i = t; i < t + win; i++) { mr += R[i]; mg += G[i]; mb += B[i]; }
      mr /= win; mg /= win; mb /= win;
      if (!mr || !mg || !mb) continue;
      const s1 = [], s2 = [];
      for (let i = t; i < t + win; i++) {
        const r = R[i] / mr, g = G[i] / mg, b = B[i] / mb;
        s1.push(g - b);
        s2.push(g + b - 2 * r);
      }
      const sd2 = std(s2);
      const alpha = sd2 > 0 ? std(s1) / sd2 : 0;
      const h = s1.map((v, k) => v + alpha * s2[k]);
      const mh = h.reduce((a, b) => a + b, 0) / win;
      for (let k = 0; k < win; k++) H[t + k] += h[k] - mh;
    }
    return H;
  }

  /** Heart rate, HRV and quality from a pulse series (beats are peaks). */
  function estimate(pulse, { duration, breathingFrom, hrv }) {
    const retake = (problem, extra) => retakeResult(problem, duration, extra);
    const filtered = bandpass(pulse);
    const wave = filtered.slice(SAMPLE_RATE, filtered.length - SAMPLE_RATE);

    // Harmonic summation: a pulse wave has strong overtones, so score
    // each candidate rate by its fundamental plus weighted overtones.
    const spec = spectrum(wave, LOW_HZ, 3 * HIGH_HZ);
    const powerAt = (hz) => {
      const i = Math.round((hz - LOW_HZ) * 60);
      return i < 0 || i >= spec.length ? 0 : spec[i][1];
    };
    let f0 = LOW_HZ, bestScore = -1;
    for (const [hz, power] of spec) {
      if (hz > HIGH_HZ) break;
      const score = power + 0.8 * powerAt(2 * hz) + 0.6 * powerAt(3 * hz);
      if (score > bestScore) { bestScore = score; f0 = hz; }
    }
    const near = (hz) => spec.filter((p) => Math.abs(p[0] - hz) <= 0.1).reduce((s, p) => s + p[1], 0);
    const signal = near(f0) + near(2 * f0) + near(3 * f0);
    const total = spec.reduce((s, p) => s + p[1], 0);
    const snrDb = 10 * Math.log10(signal / Math.max(total - signal, 1e-12));
    const spectralBpm = f0 * 60;

    // Beats closer than 60% of the spectral interval are noise or the
    // pulse's own secondary (dicrotic) bump.
    const minGap = Math.max(Math.floor(SAMPLE_RATE * 60 / 200), Math.floor(0.6 * SAMPLE_RATE / f0));
    const peaks = findPeaks(wave, minGap);
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) intervals.push((peaks[i] - peaks[i - 1]) / SAMPLE_RATE * 1000);

    if (intervals.length < 8) {
      return retake('Not enough clear heartbeats were found. Keep your hand still and try again.', { waveform: wave, snrDb });
    }

    const med = median(intervals);
    const clean = intervals.map((ms) => ({ ms, ok: ms >= 285 && ms <= 1500 && Math.abs(ms - med) <= 0.25 * med }));
    const good = clean.filter((c) => c.ok).map((c) => c.ms);
    const cleanShare = good.length / intervals.length;
    const peakBpm = good.length ? 60000 / (good.reduce((a, b) => a + b, 0) / good.length) : 0;

    const diffs = [];
    for (let i = 1; i < clean.length; i++) if (clean[i].ok && clean[i - 1].ok) diffs.push(clean[i].ms - clean[i - 1].ms);
    const rmssd = hrv && diffs.length >= 10 ? Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length) : null;
    const sdnn = hrv && good.length >= 10 ? std(good) : null;

    const agree = Math.abs(peakBpm - spectralBpm) <= MAX_DISAGREEMENT_BPM;
    const snrScore = Math.min(1, Math.max(0, (snrDb + 3) / 9));
    const quality = Math.min(1, Math.max(0, 0.5 * snrScore + 0.3 * cleanShare + 0.2 * (agree ? 1 : 0)));
    const base = {
      spectralHeartRate: spectralBpm, quality, snrDb, beats: peaks.length, cleanIntervals: good.length,
      waveform: wave, peakIndexes: peaks.map(Math.round), durationSeconds: duration,
    };

    if (!agree || snrDb < -1 || cleanShare < 0.75) {
      return { verdict: 'retake', problem: 'The pulse signal was too noisy to trust. Keep still, press lightly, and try again.', ...base };
    }

    return { verdict: 'good', heartRate: peakBpm, rmssdMs: rmssd, sdnnMs: sdnn, respiratoryRate: breathingFrom ? breathing(breathingFrom) : null, ...base };
  }

  /** A causal band-pass for the live waveform while recording. */
  function liveBandpass() {
    const hp = biquad('high', LOW_HZ, SAMPLE_RATE), lp = biquad('low', HIGH_HZ, SAMPLE_RATE);
    const sh = [0, 0, 0, 0], sl = [0, 0, 0, 0];
    const step = (f, s, x) => {
      const y = f.b0 * x + f.b1 * s[0] + f.b2 * s[1] - f.a1 * s[2] - f.a2 * s[3];
      s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
      return y;
    };
    return (value) => step(lp, sl, step(hp, sh, -value));
  }

  /** Mean red and green over the centre of RGBA pixel data. */
  function averageRgba(data, width, height, step = 2) {
    let red = 0, green = 0, count = 0;
    for (let y = height >> 2; y < (height * 3) >> 2; y += step) {
      for (let x = width >> 2; x < (width * 3) >> 2; x += step) {
        const i = (y * width + x) * 4;
        red += data[i]; green += data[i + 1]; count++;
      }
    }
    return count ? { red: red / count, green: green / count } : { red: 0, green: 0 };
  }

  /** Skin test in YCbCr (Chai & Ngan ranges), for 0–255 RGB. */
  function isSkin(r, g, b) {
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    return cr >= 133 && cr <= 173 && cb >= 77 && cb <= 127;
  }

  /**
   * Mean colour of skin pixels inside the face oval of RGBA pixel data
   * (oval centred at 50% x, 45% y; 22% wide and 32% tall radii).
   */
  function averageFace(data, width, height) {
    const cx = width * 0.5, cy = height * 0.45, rx = width * 0.22, ry = height * 0.32;
    let r = 0, g = 0, b = 0, skin = 0, inside = 0;
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
        inside++;
        const i = (y * width + x) * 4;
        if (!isSkin(data[i], data[i + 1], data[i + 2])) continue;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; skin++;
      }
    }
    return skin ? { r: r / skin, g: g / skin, b: b / skin, skin: skin / inside } : { r: 0, g: 0, b: 0, skin: 0 };
  }

  /**
   * Stress compared with the person's own usual, from fingertip RMSSD.
   * HRV varies too much between people (age, fitness) for a fixed
   * threshold, so this needs at least 3 earlier readings and compares
   * ln(RMSSD) with their mean: lower HRV than usual suggests more stress.
   * Returns null without enough history.
   */
  function stressVsUsual(rmssd, earlier) {
    const past = earlier.filter((v) => v > 0).map(Math.log);
    if (!(rmssd > 0) || past.length < 3) return null;
    const mean = past.reduce((a, b) => a + b, 0) / past.length;
    // Floor the spread at 0.15 (about ±15%) so a few similar readings
    // do not make ordinary day-to-day wobble look significant.
    const spread = Math.max(std(past), 0.15);
    const z = (Math.log(rmssd) - mean) / spread;
    const level = z < -1 ? 'higher' : z > 1 ? 'lower' : 'usual';
    return { level, z, baselineMs: Math.exp(mean), readings: past.length };
  }

  /**
   * Heart rhythm from a fingertip recording: regular, irregular (as in
   * atrial fibrillation), or regular with a few early beats.
   *
   * Unlike analyze(), this does not assume beats are evenly spaced, so it
   * cannot use spacing to reject noise. Instead each beat must look like
   * a pulse: its shape is compared with the median beat (template
   * matching), and beats that are too small, too large or misshapen are
   * dropped along with the intervals on either side. Too many dropped
   * beats means movement, not an irregular heart.
   *
   * The irregularity test uses beat-to-beat changes (RMSSD as a fraction
   * of the mean interval, and the share of changes above 10%). The
   * cut-offs are provisional; they have not been checked against ECGs.
   */
  const IRREGULAR_NRMSSD = 0.1, IRREGULAR_SHARE = 0.45, MIN_RHYTHM_INTERVALS = 15, MIN_BEAT_CORR = 0.7, MIN_JUDGE_CORR = 0.85, PERIODIC_SHARE = 0.65;
  function rhythm(samples) {
    const raw = resample(samples);
    const duration = raw.length / SAMPLE_RATE;
    const retake = (problem) => ({ verdict: 'retake', problem, durationSeconds: duration });
    if (duration < 25) return retake('The recording was too short to judge the rhythm. Keep still for the full 30 seconds.');
    const covered = samples.filter((s) => fingerCovers(s.red, s.green)).length / samples.length;
    if (covered < 0.9) return retake('The camera was not fully covered. Rest your fingertip gently over the camera and flash.');

    const filtered = bandpass(raw.map((v) => -v));
    const wave = filtered.slice(SAMPLE_RATE, filtered.length - SAMPLE_RATE);
    const before = Math.round(0.2 * SAMPLE_RATE), after = Math.round(0.3 * SAMPLE_RATE);
    // Keep the sub-frame peak times for the intervals; round only to index samples.
    const candidates = findPeaks(wave, Math.round(0.33 * SAMPLE_RATE))
      .filter((t) => Math.round(t) - before >= 0 && Math.round(t) + after < wave.length);
    if (candidates.length < MIN_RHYTHM_INTERVALS) return retake('Not enough clear heartbeats were found. Keep your hand still and try again.');

    // Height above the trough before each beat, then drop small bumps.
    const height = (t) => { const p = Math.round(t); return wave[p] - Math.min(...wave.slice(Math.max(0, p - Math.round(0.4 * SAMPLE_RATE)), p)); };
    const heights = candidates.map(height);
    const typical = median(heights);
    const peaks = candidates.filter((p, i) => heights[i] >= 0.35 * typical);

    const segment = (t) => {
      const p = Math.round(t), seg = wave.slice(p - before, p + after + 1);
      const m = seg.reduce((a, b) => a + b, 0) / seg.length, sd = std(seg) || 1;
      return seg.map((v) => (v - m) / sd);
    };
    const segs = peaks.map(segment);
    const template = segs[0].map((_, k) => median(segs.map((s) => s[k])));
    const corr = segs.map((s) => s.reduce((acc, v, k) => acc + v * template[k], 0) / s.length);
    const ok = peaks.map((p, i) => corr[i] >= MIN_BEAT_CORR && height(p) <= 3 * typical);
    const goodShare = ok.filter(Boolean).length / peaks.length;
    if (goodShare < 0.8) return retake('The finger or phone moved during the recording. Rest your hand on a table, keep still, and try again.');

    const intervals = [];
    for (let i = 1; i < peaks.length; i++) {
      if (ok[i] && ok[i - 1]) intervals.push((peaks[i] - peaks[i - 1]) / SAMPLE_RATE * 1000);
    }
    if (intervals.length < MIN_RHYTHM_INTERVALS) return retake('Not enough clean heartbeats in a row. Keep still and try again.');
    if (intervals.some((ms) => ms > 2000)) return retake('A beat seems to be missing. Press a little more lightly and try again.');

    const irregularity = (rr) => {
      const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
      const diffs = rr.slice(1).map((v, i) => v - rr[i]);
      const rmssd = Math.sqrt(diffs.reduce((acc, d) => acc + d * d, 0) / diffs.length);
      return { nRmssd: rmssd / mean, share: diffs.filter((d) => Math.abs(d) > 0.1 * mean).length / diffs.length };
    };
    // Breathing makes a healthy heart speed up and slow down in a smooth,
    // repeating wave (sinus arrhythmia). Atrial fibrillation has no such
    // pattern. Share of the interval variance in the strongest rhythm:
    // near 1 for a breathing wave, low for random intervals.
    const periodicShare = (rr) => {
      const n = rr.length, mean = rr.reduce((a, b) => a + b, 0) / n, x = rr.map((v) => v - mean);
      const power = [];
      for (let k = 1; k <= n / 2; k++) {
        let re = 0, im = 0;
        for (let i = 0; i < n; i++) { re += x[i] * Math.cos(2 * Math.PI * k * i / n); im -= x[i] * Math.sin(2 * Math.PI * k * i / n); }
        power.push(re * re + im * im);
      }
      const total = power.reduce((a, b) => a + b, 0) || 1;
      let best = 0;
      for (let k = 0; k < power.length; k++) best = Math.max(best, (power[k - 1] || 0) + power[k] + (power[k + 1] || 0));
      return best / total;
    };

    // An early (ectopic) beat: a short interval followed by a long,
    // compensating one. Set those pairs aside and look at the rest.
    const med = median(intervals);
    const early = [];
    for (let i = 0; i + 1 < intervals.length; i++) {
      if (intervals[i] < 0.8 * med && intervals[i + 1] > 1.12 * med) { early.push(i); i++; }
    }
    const rest = intervals.filter((_, i) => !early.some((e) => i === e || i === e + 1));
    const all = irregularity(intervals), base = irregularity(rest.length >= 10 ? rest : intervals);
    const periodic = periodicShare(rest.length >= 10 ? rest : intervals);
    const isIrregular = (m) => m.nRmssd >= IRREGULAR_NRMSSD && m.share >= IRREGULAR_SHARE && periodic < PERIODIC_SHARE;
    const isBorderline = (m) => m.nRmssd >= 0.7 * IRREGULAR_NRMSSD && m.share >= 0.7 * IRREGULAR_SHARE && periodic < PERIODIC_SHARE;

    let result;
    if (isIrregular(base) || early.length > intervals.length / 4) result = 'irregular';
    else if (isBorderline(base)) result = 'unclear';
    else if (early.length) result = 'early-beats';
    else result = 'regular';

    // Noise only ever makes a rhythm look less regular, so a regular result
    // stands on a weaker signal, but anything else needs clean beats.
    const signalCorr = corr.filter((_, i) => ok[i]).reduce((a, b) => a + b, 0) / ok.filter(Boolean).length;
    if (result !== 'regular' && signalCorr < MIN_JUDGE_CORR) {
      return retake('The pulse signal was too weak to judge the rhythm. Press lightly, keep still, and try again.');
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    return {
      verdict: 'ok', rhythm: result, heartRate: 60000 / mean, intervals, earlyBeats: early.length,
      nRmssd: all.nRmssd, irregularShare: all.share, periodicShare: periodic, signalCorr, beatQuality: goodShare, durationSeconds: duration,
    };
  }

  const api = {
    rhythm, IRREGULAR_NRMSSD, IRREGULAR_SHARE,
    stressVsUsual, SAMPLE_RATE, fingerCovers, resample, bandpass, findPeaks, spectrum, analyze, analyzeFace, pos,
    liveBandpass, averageRgba, averageFace, isSkin,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Ppg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
