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
 * It does not look for murmurs: that needs a model trained and tested on
 * doctor-labelled recordings.
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
  function createFilter(sampleRate) {
    const block = Math.max(1, Math.round(sampleRate / RATE)), rate = sampleRate / block;
    const chain = [biquad('high', BAND[0], rate), biquad('high', BAND[0], rate),
      biquad('low', BAND[1], rate), biquad('low', BAND[1], rate), biquad('low', BAND[1], rate), biquad('low', BAND[1], rate)];
    let acc = 0, n = 0;
    return {
      rate,
      push(x) {
        const out = [];
        for (let i = 0; i < x.length; i++) {
          acc += x[i];
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
  function filterAll(x, sampleRate) {
    const f = createFilter(sampleRate);
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
    return { verdict: 'ok', heartRate: 60 / period, beats, ...base };
  }

  /**
   * The heart sound made audible on a phone speaker, which cannot play
   * below ~200 Hz: a 220 Hz tone shaped by the recording's own loudness
   * envelope, so each lub and dub is heard where it really happened.
   */
  function audible(env, seconds, sampleRate = 22050) {
    const out = new Float32Array(Math.round(seconds * sampleRate));
    const max = Math.max(...env) || 1;
    for (let i = 0; i < out.length; i++) {
      const p = i / sampleRate * ENV_RATE, k = Math.floor(p), f = p - k;
      const a = ((env[k] || 0) * (1 - f) + (env[k + 1] || 0) * f) / max;
      const t = i / sampleRate;
      out[i] = Math.pow(a, 1.5) * (0.7 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 330 * t));
    }
    return out;
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

  return { RATE, BAND, ENV_RATE, MIN_CLARITY, createFilter, filterAll, envelope, analyze, audible, wav };
});
