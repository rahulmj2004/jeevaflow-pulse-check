/*
 * Ear echo (acoustic reflectometry) for JeevaFlow.
 *
 * The phone plays short chirps into the ear canal through a paper cone
 * and records what comes back. A healthy eardrum vibrates and absorbs
 * part of the sound, which shows as a dip in the echo spectrum; fluid
 * behind the eardrum stiffens it and flattens the dip (Chan et al.,
 * Science Translational Medicine, 2019).
 *
 * This file only measures the echo curve and its deepest dip. It does
 * not decide whether there is fluid: that needs a threshold learned
 * from doctor-checked ears, which this project does not have.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ear = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const F0 = 1800, F1 = 4400;            // chirp sweep, Hz
  const CHIRP_MS = 150, PERIOD_MS = 400, COUNT = 10;
  const BAND = [2000, 4200], STEP_HZ = 20, SMOOTH_HZ = 50;
  // Chirps must stand 10 dB above the room, and agree within 3 dB.
  const MIN_SNR_DB = 10, MAX_SPREAD_DB = 3;

  /** Linear chirp F0→F1 with 5 ms raised-cosine fades, peak 1. */
  function chirp(sampleRate, { f0 = F0, f1 = F1, ms = CHIRP_MS } = {}) {
    const n = Math.round(sampleRate * ms / 1000), fade = Math.round(sampleRate * 0.005);
    const out = new Float32Array(n), T = n / sampleRate, k = (f1 - f0) / T;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      let a = 1;
      if (i < fade) a = 0.5 - 0.5 * Math.cos(Math.PI * i / fade);
      else if (i >= n - fade) a = 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / fade);
      out[i] = a * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
    }
    return out;
  }

  /** In-place radix-2 FFT; inverse when inv is true (unscaled). */
  function fft(re, im, inv = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  /** Cross-correlation of rec with tpl at every lag 0..rec.length-tpl.length. */
  function correlate(rec, tpl) {
    const n = pow2(rec.length + tpl.length);
    const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    ar.set(rec); br.set(tpl);
    fft(ar, ai); fft(br, bi);
    for (let i = 0; i < n; i++) {
      const r = ar[i] * br[i] + ai[i] * bi[i], m = ai[i] * br[i] - ar[i] * bi[i];
      ar[i] = r; ai[i] = m;
    }
    fft(ar, ai, true);
    const out = new Float64Array(rec.length - tpl.length + 1);
    for (let i = 0; i < out.length; i++) out[i] = ar[i] / n;
    return out;
  }

  /** Where each chirp starts in the recording (sample indexes, sorted). */
  function findChirps(rec, tpl, sampleRate, { periodMs = PERIOD_MS, count = COUNT } = {}) {
    if (rec.length <= tpl.length) return [];
    const c = correlate(rec, tpl).map(Math.abs);
    let best = 0;
    for (let i = 1; i < c.length; i++) if (c[i] > c[best]) best = i;
    if (!(c[best] > 1e-6)) return [];   // silence: nothing to find
    const sorted = Float64Array.from(c).sort();
    const floor = sorted[sorted.length >> 1];
    const need = Math.max(0.3 * c[best], 8 * floor);
    const period = sampleRate * periodMs / 1000, slack = Math.round(sampleRate * 0.02);
    const found = [];
    for (let k = -count; k <= count; k++) {
      const centre = Math.round(best + k * period);
      let at = -1;
      for (let i = Math.max(0, centre - slack); i <= Math.min(c.length - 1, centre + slack); i++) {
        if (c[i] > need && (at < 0 || c[i] > c[at])) at = i;
      }
      if (at >= 0 && at !== found[found.length - 1]) found.push(at);
    }
    // A longer recording can hold more; keep the run around the strongest.
    while (found.length > count) {
      if (Math.abs(found[0] - best) > Math.abs(found[found.length - 1] - best)) found.shift(); else found.pop();
    }
    return found;
  }

  /** dB echo curve of one chirp (recorded ÷ played), on the output grid. */
  function echoCurve(rec, start, tpl, sampleRate, grid) {
    const len = tpl.length + Math.round(sampleRate * 0.01);
    const n = pow2(Math.max(len, sampleRate / 4));
    const rr = new Float64Array(n), ri = new Float64Array(n), tr = new Float64Array(n), ti = new Float64Array(n);
    rr.set(rec.subarray(start, start + len)); tr.set(tpl);
    fft(rr, ri); fft(tr, ti);
    const hz = sampleRate / n, half = Math.round(SMOOTH_HZ / hz);
    return grid.map((f) => {
      const centre = Math.round(f / hz);
      let r = 0, t = 0;
      for (let i = centre - half; i <= centre + half; i++) {
        r += rr[i] * rr[i] + ri[i] * ri[i];
        t += tr[i] * tr[i] + ti[i] * ti[i];
      }
      return 10 * Math.log10(Math.max(r, 1e-20) / Math.max(t, 1e-20));
    });
  }

  /**
   * Deepest dip of a curve: at each point, how far it sits below the
   * lower of the highest points on its left and right (like water
   * held in a valley). A steadily sloping curve has no dip.
   */
  function deepestDip(freqs, db) {
    const n = db.length, left = new Array(n), right = new Array(n);
    for (let i = 0; i < n; i++) left[i] = Math.max(db[i], i ? left[i - 1] : -Infinity);
    for (let i = n - 1; i >= 0; i--) right[i] = Math.max(db[i], i < n - 1 ? right[i + 1] : -Infinity);
    let at = 0, depth = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.min(left[i], right[i]) - db[i];
      if (d > depth) { depth = d; at = i; }
    }
    return { hz: freqs[at], depthDb: depth };
  }

  const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const meanSquare = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return b > a ? s / (b - a) : 0; };

  /**
   * rec: mono samples (-1..1) recorded while COUNT chirps played every
   * PERIOD_MS. Returns the echo curve (dB, mean removed), its deepest
   * dip, and quality figures; verdict is 'ok' or 'retake'. It never
   * says whether there is fluid.
   */
  function analyzeEcho(rec, sampleRate, opts = {}) {
    const { count = COUNT, periodMs = PERIOD_MS } = opts;
    const tpl = chirp(sampleRate, opts);
    const levels = micLevels(rec, sampleRate);
    const retake = (code, problem, extra = {}) => ({ verdict: 'retake', code, problem, chirpsHeard: 0, expected: count, ...levels, ...extra });

    if (levels.peakDb < -70) {
      return retake('silent', 'The microphone recorded silence. Close other apps that use the microphone (calls, voice recorder), allow the microphone for this page, and try again.');
    }

    let clipped = 0;
    for (let i = 0; i < rec.length; i++) if (Math.abs(rec[i]) >= 0.99) clipped++;
    if (clipped > rec.length * 0.001) return retake('clipped', 'The sound was too loud for the microphone. Turn the phone volume down a little and try again.');

    const starts = findChirps(rec, tpl, sampleRate, { periodMs, count }).filter((s) => s + tpl.length + sampleRate * 0.01 <= rec.length);
    if (starts.length < Math.ceil(count * 0.7)) {
      return retake('not-heard', 'The microphone heard sound but not the chirps clearly. Turn the media volume up, make sure no Bluetooth earphones are connected, and check the cone covers both the speaker and the microphone.', { chirpsHeard: starts.length });
    }

    // Loudness of the chirps against the room noise between them.
    const len = tpl.length, gapPad = Math.round(sampleRate * 0.05);
    let sig = 0, noise = 0, gaps = 0;
    for (let k = 0; k < starts.length; k++) {
      sig += meanSquare(rec, starts[k], starts[k] + len);
      const a = starts[k] + len + gapPad, b = (k + 1 < starts.length ? starts[k + 1] : a + gapPad * 4) - gapPad;
      if (b - a > gapPad && b <= rec.length) { noise += meanSquare(rec, a, b); gaps++; }
    }
    const snrDb = 10 * Math.log10((sig / starts.length) / Math.max(gaps ? noise / gaps : 1e-12, 1e-12));
    if (snrDb < MIN_SNR_DB) return retake('noisy', 'The room was too noisy compared with the chirps. Try somewhere quieter, or turn the volume up a little.', { chirpsHeard: starts.length, snrDb });

    const freqs = [];
    for (let f = BAND[0]; f <= BAND[1]; f += STEP_HZ) freqs.push(f);
    const curves = starts.map((s) => echoCurve(rec, s, tpl, sampleRate, freqs));

    // Per frequency: the median over chirps, and how much chirps disagree.
    const med = freqs.map((_, i) => median(curves.map((c) => c[i])));
    const spread = freqs.map((_, i) => {
      const xs = curves.map((c) => c[i] - c.reduce((a, b) => a + b, 0) / c.length);
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    });
    const consistencyDb = spread.reduce((a, b) => a + b, 0) / spread.length;
    if (consistencyDb > MAX_SPREAD_DB) {
      return retake('moved', 'The echo changed between chirps, which usually means the cone moved. Hold it gently in place and keep still.', { chirpsHeard: starts.length, snrDb, consistencyDb });
    }

    const mean = med.reduce((a, b) => a + b, 0) / med.length;
    const db = med.map((v) => v - mean);
    return {
      verdict: 'ok', freqs, db, dip: deepestDip(freqs, db),
      chirpsHeard: starts.length, expected: count, snrDb, consistencyDb, ...levels,
    };
  }

  /** Loudest moment and typical background level, in dB below full scale. */
  function micLevels(rec, sampleRate) {
    let peak = 0;
    for (let i = 0; i < rec.length; i++) { const v = Math.abs(rec[i]); if (v > peak) peak = v; }
    const block = Math.max(1, Math.round(sampleRate * 0.02)), rms = [];
    for (let i = 0; i + block <= rec.length; i += block) rms.push(Math.sqrt(meanSquare(rec, i, i + block)));
    rms.sort((a, b) => a - b);
    // The quietest fifth of the recording is the room between chirps.
    const room = rms.length ? rms[Math.floor(rms.length * 0.2)] : 0;
    const db = (v) => 20 * Math.log10(Math.max(v, 1e-6));
    return { peakDb: db(peak), roomDb: db(room) };
  }

  /** 16-bit mono WAV of samples, for playing through an <audio> element. */
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

  /** The whole chirp sequence as one signal: leadS of silence, COUNT chirps, tailS. */
  function sequence(sampleRate, { level = 0.8, leadS = 0.6, tailS = 0.5, count = COUNT, periodMs = PERIOD_MS } = {}) {
    const tpl = chirp(sampleRate), period = Math.round(sampleRate * periodMs / 1000), lead = Math.round(sampleRate * leadS);
    const out = new Float32Array(lead + (count - 1) * period + tpl.length + Math.round(sampleRate * tailS));
    for (let k = 0; k < count; k++) for (let i = 0; i < tpl.length; i++) out[lead + k * period + i] = level * tpl[i];
    return out;
  }

  return { F0, F1, CHIRP_MS, PERIOD_MS, COUNT, BAND, chirp, fft, correlate, findChirps, deepestDip, analyzeEcho, micLevels, wav, sequence };
});
