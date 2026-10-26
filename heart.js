/**
 * Heart sounds through the phone's microphone (Dhadkan).
 *
 * Each heartbeat closes two sets of valves, making two low thuds ("lub",
 * S1, and "dub", S2) at roughly 20–150 Hz. With the microphone pressed on
 * the chest, those vibrations are recorded like any other sound. This
 * module keeps only that low band, finds the beat-to-beat rhythm of its
 * loudness (autocorrelation of the envelope), and reports the heart rate
 * and how clearly a heartbeat was heard.
 *
 * It then labels each lub and dub, measures the sound between them
 * (where a murmur's whoosh would be), and scores how murmur-like the
 * recording is with a model fitted on doctor-labelled recordings.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Heart = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const RATE = 2000;                 // Hz, after decimation
  const BAND = [25, 150];            // heart sounds, Hz
  const ENV_RATE = 100;              // loudness envelope, Hz
  const MIN_BPM = 40, MAX_BPM = 180;
  const MIN_CLARITY = 0.3;           // autocorrelation needed to call it a heartbeat

  function biquad(kind, hz, rate, q = Math.SQRT1_2) {
    const w = 2 * Math.PI * hz / rate, alpha = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + alpha;
    const b = kind === 'low' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  }
  function step(f, x) {
    const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
    f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y;
    return y;
  }

  /**
   * Streaming filter: push() raw microphone samples, get back the heart
   * band at RATE. Averaging blocks of samples is the decimating low-pass;
   * two high-pass and four low-pass sections give a 25–150 Hz band that
   * cuts voices above it steeply.
   */
  function createFilter(sampleRate, { wide = false } = {}) {
    const block = Math.max(1, Math.round(sampleRate / RATE)), rate = sampleRate / block;
    // Anti-alias before averaging blocks, so hiss and voices above ~1 kHz
    // cannot fold down into the heart and murmur bands.
    const pre = block > 1 ? [biquad('low', 800, sampleRate), biquad('low', 800, sampleRate)] : [];
    const chain = wide ? [] : [biquad('high', BAND[0], rate), biquad('high', BAND[0], rate),
      biquad('low', BAND[1], rate), biquad('low', BAND[1], rate), biquad('low', BAND[1], rate), biquad('low', BAND[1], rate)];
    let acc = 0, n = 0;
    return {
      rate,
      push(x) {
        const out = [];
        for (let i = 0; i < x.length; i++) {
          let u = x[i];
          for (const f of pre) u = step(f, u);
          acc += u;
          if (++n === block) {
            let v = acc / block;
            for (const f of chain) v = step(f, v);
            out.push(v);
            acc = 0; n = 0;
          }
        }
        return out;
      },
    };
  }

  /** Whole recording through the filter: {y, rate}. */
  function filterAll(x, sampleRate, opts) {
    const f = createFilter(sampleRate, opts);
    return { y: Float64Array.from(f.push(x)), rate: f.rate };
  }

  const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
  const median = (xs) => { const s = Float64Array.from(xs).sort(), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

  /** Loudness envelope at ENV_RATE: RMS in 40 ms windows. */
  function envelope(y, rate) {
    const hop = Math.round(rate / ENV_RATE), win = Math.round(0.04 * rate), out = [];
    for (let c = 0; c + hop <= y.length; c += hop) {
      const a = Math.max(0, c - (win >> 1)), b = Math.min(y.length, c + (win >> 1));
      out.push(rms(y, a, b));
    }
    return Float64Array.from(out);
  }

  /** Peaks at least `gap` samples apart. */
  function peaks(x, gap, minHeight) {
    const out = [];
    for (let i = 1; i < x.length - 1; i++) {
      if (x[i] < minHeight || x[i] < x[i - 1] || x[i] < x[i + 1]) continue;
      if (out.length && i - out[out.length - 1] < gap) {
        if (x[i] > x[out[out.length - 1]]) out[out.length - 1] = i;
        continue;
      }
      out.push(i);
    }
    return out;
  }

  /** Usual time from lub to dub for a beat interval rr (s), from the CirCor recordings. */
  const systoleFor = (rr) => Math.min(0.42, 0.11 + 0.22 * rr);

  /**
   * Labels each "lub" (S1) and "dub" (S2) in a loudness envelope at
   * ENV_RATE, given the beat period in seconds. The lub-to-dub gap
   * (systole) is shorter than the dub-to-next-lub gap (diastole), and both
   * stay nearly constant through a recording, so the best chain of lubs is
   * found by dynamic programming: each lub scores the loudness at it and at
   * its dub, and consecutive lubs must sit about one period apart.
   */
  function segment(env, period) {
    const n = env.length, T = period * ENV_RATE;
    const scale = median(env) || 1e-12;
    const e = Float64Array.from(env, (v) => Math.log1p(v / scale));
    const lo = Math.round(0.75 * T), hi = Math.round(1.3 * T);
    const expected = systoleFor(period) * ENV_RATE;
    let best = null;
    for (let f = 0.75; f <= 1.3001; f += 0.05) {
      const ts = Math.round(expected * f);
      if (ts < 10 || ts > 0.55 * T) continue;
      const score = new Float64Array(n).fill(-Infinity), from = new Int32Array(n).fill(-1);
      for (let t = 0; t + ts < n; t++) {
        const own = e[t] + e[t + ts];
        if (t < hi) score[t] = own;
        for (let d = lo; d <= hi && d <= t; d++) {
          const prev = score[t - d];
          if (prev === -Infinity) continue;
          const v = prev + own - 2 * ((d - T) / T) ** 2;
          if (v > score[t]) { score[t] = v; from[t] = t - d; }
        }
      }
      let end = -1;
      for (let t = Math.max(0, n - ts - hi); t + ts < n; t++) if (end < 0 || score[t] > score[end]) end = t;
      if (end < 0) continue;
      const chain = [];
      for (let t = end; t >= 0; t = from[t]) chain.unshift(t);
      const mean = score[end] / chain.length - 5 * (f - 1) ** 2;   // prefer the usual systole
      if (!best || mean > best.mean) best = { mean, chain, ts };
    }
    if (!best) return null;
    // Let each dub settle on its own loudest point.
    const near = Math.round(0.04 * ENV_RATE);
    const s2 = best.chain.map((t) => {
      let at = t + best.ts;
      for (let k = t + best.ts - near; k <= t + best.ts + near; k++) if (k > t + 8 && k < n && env[k] > env[at]) at = k;
      return at;
    });
    return { s1: best.chain.map((t) => t / ENV_RATE), s2: s2.map((t) => t / ENV_RATE), systole: best.ts / ENV_RATE, fit: best.mean };
  }

  // Murmurs are a whoosh of blood between the lub and dub (or after the
  // dub), mostly above the thuds' pitch. Loudness is compared in these bands.
  const MURMUR_BANDS = [[25, 100], [100, 200], [200, 400], [400, 800]];
  const FEATURES = [
    ...MURMUR_BANDS.map(([a, b]) => `sys/dia ${a}-${b}`),
    ...MURMUR_BANDS.map(([a, b]) => `sys/S1 ${a}-${b}`),
    ...MURMUR_BANDS.map(([a, b]) => `dia/S1 ${a}-${b}`),
    'beats with loud systole 100-200', 'beats with loud systole 200-400', 'beats with loud diastole 100-200',
    'S2/S1', 'systole pitch', 'diastole pitch', 'clarity', 'fit'];

  /**
   * w: wide-band sound at rate, aligned with seg's times. For each beat,
   * the power in each band during S1, S2, systole and diastole (keeping
   * clear of the thuds themselves); then ratios, as log10, taken as the
   * median over beats so a single knock does not count.
   */
  function murmurFeatures(w, rate, seg, clarity) {
    const bands = MURMUR_BANDS.map(([a, b]) => {
      const chain = [biquad('high', a, rate), biquad('high', a, rate), biquad('low', b, rate), biquad('low', b, rate)];
      return Float64Array.from(w, (v) => { for (const f of chain) v = step(f, v); return v; });
    });
    const pow = (y, s, e) => { const a = Math.max(0, Math.round(s * rate)), b = Math.min(y.length, Math.round(e * rate)); if (b - a < 4) return NaN; let t = 0; for (let i = a; i < b; i++) t += y[i] * y[i]; return t / (b - a) + 1e-14; };
    const per = [];
    for (let i = 0; i + 1 < seg.s1.length; i++) {
      const s1 = seg.s1[i], s2 = seg.s2[i], next = seg.s1[i + 1];
      if (s2 - s1 < 0.15 || next - s2 < 0.18 || s1 < 0.05) continue;
      per.push(bands.map((y) => ({
        S1: pow(y, s1 - 0.04, s1 + 0.05), S2: pow(y, s2 - 0.04, s2 + 0.04),
        sys: pow(y, s1 + 0.07, s2 - 0.05), dia: pow(y, s2 + 0.07, next - 0.07),
      })));
    }
    if (per.length < 4) return null;
    const lg = Math.log10, med = (f) => median(per.map(f).filter(Number.isFinite));
    const share = (f) => per.filter(f).length / per.length;
    const v = [
      ...[0, 1, 2, 3].map((b) => med((c) => lg(c[b].sys / c[b].dia))),
      ...[0, 1, 2, 3].map((b) => med((c) => lg(c[b].sys / c[b].S1))),
      ...[0, 1, 2, 3].map((b) => med((c) => lg(c[b].dia / c[b].S1))),
      share((c) => c[1].sys > 2 * c[1].dia), share((c) => c[2].sys > 2 * c[2].dia), share((c) => c[1].dia > 2 * c[1].sys),
      med((c) => lg(c[0].S2 / c[0].S1)), med((c) => lg(c[3].sys / c[1].sys)), med((c) => lg(c[3].dia / c[1].dia)),
      clarity, seg.fit,
    ];
    return { values: v, beats: per.length };
  }

  /**
   * Logistic regression over FEATURES, fitted on the CirCor DigiScope
   * recordings (PhysioNet 2022; 942 children and teenagers in Brazil, digital
   * stethoscope at four chest spots, murmurs labelled by cardiologists).
   * Tested on patients it never saw (5-fold, split by patient): one
   * recording AUC 0.885; at MURMUR_POSSIBLE it caught 73% of murmurs
   * (93% of loud grade III/VI ones) and cleared 95% of normal recordings.
   * Not yet tested on phone microphones.
   */
  const MURMUR_MODEL = {
    mu: [0.09903, 0.196, 0.1735, 0.1204, -1.392, -0.9978, -0.5307, -0.2546, -1.485, -1.186, -0.7127, -0.3831, 0.3839, 0.3787, 0.2475, -0.06564, -0.2277, -0.15, 0.5494, 2.877],
    sd: [0.2919, 0.4602, 0.484, 0.4358, 0.4891, 0.6004, 0.5129, 0.3997, 0.4656, 0.5552, 0.5158, 0.449, 0.203, 0.1875, 0.1209, 0.4163, 0.4756, 0.4552, 0.1441, 0.2697],
    w: [0.0237, 0.3141, 0.09432, -0.0795, 0.2046, 0.1221, -0.104, -0.1006, 0.1515, 0.01585, 0.1286, 0.01706, 1.195, 0.7048, 0.5292, -0.03738, -0.3842, -0.02225, 0.3299, -0.09311],
    b: -1.03,
  };
  const MURMUR_POSSIBLE = 0.5, MURMUR_UNCLEAR = 0.3;

  /** Chance of a murmur in one recording, from analyze()'s features. */
  function murmur(features) {
    if (!features) return null;
    const m = MURMUR_MODEL;
    let t = m.b;
    features.values.forEach((v, j) => { t += m.w[j] * (v - m.mu[j]) / m.sd[j]; });
    const p = 1 / (1 + Math.exp(-t));
    const level = p >= MURMUR_POSSIBLE ? 'possible' : p >= MURMUR_UNCLEAR ? 'unclear' : 'none';
    const at = (name) => features.values[FEATURES.indexOf(name)];
    const loud = Math.max(at('beats with loud systole 100-200'), at('beats with loud systole 200-400'));
    return { p, level, loudSystoleShare: loud, loudDiastoleShare: at('beats with loud diastole 100-200'), beats: features.beats };
  }

  /** Several chest spots: the spot that sounds most like a murmur decides. */
  function combineSpots(results) {
    const judged = results.filter((r) => r && r.murmur);
    if (!judged.length) return null;
    const worst = judged.reduce((a, b) => (b.murmur.p > a.murmur.p ? b : a));
    return { ...worst.murmur, spot: worst.spot, spots: judged.length };
  }

  /**
   * x: raw microphone samples. Returns the heart rate, how clearly a
   * rhythm was heard (0–1), the beats, and the filtered sound for display
   * and playback; or a retake when no heartbeat is clear.
   */
  function analyze(x, sampleRate) {
    const seconds = x.length / sampleRate;
    if (seconds < 8) return { verdict: 'retake', code: 'short', problem: 'The recording was too short. Hold the phone on the chest for the full 20 seconds.' };
    const { y, rate } = filterAll(x, sampleRate);
    const skip = Math.round(0.5 * rate);               // filter settling
    const band = y.subarray(skip);
    const bassDb = 20 * Math.log10(rms(band) + 1e-9);
    const fullDb = 20 * Math.log10(rms(x) + 1e-9);

    // Loudness envelope; clip knocks and rubbing so one bump cannot dominate.
    let env = envelope(band, rate);
    const cap = 4 * median(env);
    env = env.map((v) => Math.min(v, cap));
    const mean = env.reduce((a, b) => a + b, 0) / env.length;
    const e = env.map((v) => v - mean);

    // Autocorrelation over plausible beat periods.
    const r0 = e.reduce((a, v) => a + v * v, 0) || 1e-12;
    const ac = (lag) => { let s = 0; for (let i = 0; i + lag < e.length; i++) s += e[i] * e[i + lag]; return s / r0 * e.length / (e.length - lag); };
    const lo = Math.round(ENV_RATE * 60 / MAX_BPM), hi = Math.round(ENV_RATE * 60 / MIN_BPM);
    const curve = [];
    for (let lag = lo; lag <= hi; lag++) curve.push([lag, ac(lag)]);
    let best = curve[0];
    for (let i = 1; i < curve.length - 1; i++) {
      const p = curve[i];
      if (p[1] > curve[i - 1][1] && p[1] >= curve[i + 1][1] && p[1] > best[1]) best = p;
    }
    // A peak at twice the true period can win on noisy recordings: prefer
    // half the lag when that is also a clear peak.
    const half = curve.find((p) => Math.abs(p[0] - best[0] / 2) <= 2 && p[1] > 0.6 * best[1]);
    if (half && half[0] >= lo) best = curve.filter((p) => Math.abs(p[0] - best[0] / 2) <= 2).reduce((a, b) => (b[1] > a[1] ? b : a));

    const clarity = Math.max(0, best[1]);
    const base = { seconds, bassDb, fullDb, clarity, filtered: band, rate, envelope: env };
    if (clarity < MIN_CLARITY) {
      return { verdict: 'retake', code: 'unclear', problem: 'No clear heartbeat was heard. Press the bottom edge of the phone firmly on bare skin, left of the breastbone, and keep quiet and still.', ...base };
    }
    // Refine the period with a parabola through the peak.
    const at = (lag) => ac(lag);
    const [l, c, r] = [at(best[0] - 1), at(best[0]), at(best[0] + 1)];
    const den = l - 2 * c + r, shift = den ? Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / den)) : 0;
    const period = (best[0] + shift) / ENV_RATE;
    const beats = peaks(env, Math.round(0.6 * period * ENV_RATE), median(env)).map((i) => i / ENV_RATE);
    const seg = segment(env, period);
    const wide = seg ? filterAll(x, sampleRate, { wide: true }).y.subarray(skip) : null;
    const features = seg ? murmurFeatures(wide, rate, seg, clarity) : null;
    return { verdict: 'ok', heartRate: 60 / period, beats, seg, wide, features, murmur: murmur(features), ...base };
  }

  /** In-place radix-2 FFT of (re, im); n must be a power of two. */
  function fft(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  /**
   * The real heart sound made audible on a phone speaker, which cannot
   * play below ~200 Hz. Every frequency in the recording is moved up by
   * `shift` Hz (a single-sideband shift), so the lub, the dub and any
   * whoosh between them keep their exact timing and order of pitch; they
   * are the person's own sounds, just higher.
   * w: wide-band sound at rate. Returns {samples, sampleRate}.
   */
  function audible(w, rate, shift = 200) {
    const sr = 8000, len = Math.round(w.length / rate * sr);
    let n = 1; while (n < len) n <<= 1;
    // Upsample by linear interpolation; the band limit below removes the images.
    const re = new Float64Array(n), im = new Float64Array(n), up = rate / sr;
    for (let i = 0; i < len; i++) { const p = i * up, k = Math.floor(p), f = p - k; re[i] = (w[k] || 0) * (1 - f) + (w[k + 1] || 0) * f; }
    fft(re, im);
    const hz = (k) => k * sr / n, by = Math.round(shift / sr * n);
    const yr = new Float64Array(n), yi = new Float64Array(n);
    for (let k = 1; k < n / 2 - by; k++) {
      if (hz(k) < 20 || hz(k) > 900) continue;          // heart and murmur sounds only
      yr[k + by] = 2 * re[k]; yi[k + by] = 2 * im[k];
    }
    fft(yr, yi, true);
    // Soften knocks: compress peaks above 4× the typical loudness.
    let e = 0; for (let i = 0; i < len; i++) e += yr[i] * yr[i];
    const lim = 4 * Math.sqrt(e / len) || 1;
    const samples = new Float32Array(len);
    let peak = 0;
    for (let i = 0; i < len; i++) { samples[i] = lim * Math.tanh(yr[i] / lim); peak = Math.max(peak, Math.abs(samples[i])); }
    if (peak) for (let i = 0; i < len; i++) samples[i] *= 0.9 / peak;
    return { samples, sampleRate: sr };
  }

  /** 16-bit mono WAV of samples in -1..1. */
  function wav(samples, sampleRate) {
    const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const text = (at, t) => { for (let i = 0; i < t.length; i++) data.setUint8(at + i, t.charCodeAt(i)); };
    text(0, 'RIFF'); data.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
    data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate * 2, true);
    data.setUint16(32, 2, true); data.setUint16(34, 16, true); text(36, 'data'); data.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
    return data.buffer;
  }

  return { RATE, BAND, ENV_RATE, MIN_CLARITY, MURMUR_BANDS, FEATURES, MURMUR_POSSIBLE, MURMUR_UNCLEAR, systoleFor, segment, murmurFeatures, murmur, combineSpots, createFilter, filterAll, envelope, analyze, audible, wav };
});
