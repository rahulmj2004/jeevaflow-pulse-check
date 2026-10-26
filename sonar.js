/**
 * Breathing by sonar: the phone plays steady tones above most people's
 * hearing (18–20 kHz) and listens to them. Part of the sound bounces off
 * the chest; as the chest rises and falls by a few millimetres, the
 * echo's phase shifts (the wavelength is only about 18 mm), so the
 * recorded tone wobbles in step with breathing. The same idea as
 * ApneaApp (Nandakumar, Gollakota & Watson, MobiSys 2015), with steady
 * tones instead of chirps.
 *
 * Each tone is demodulated to a slow complex signal (I/Q, 20 per second).
 * Breathing is the main direction that signal moves in (PCA), band-passed
 * to 6–48 breaths a minute. A pause is a stretch of at least 10 seconds
 * where that movement nearly stops. Cut-offs are provisional: they have
 * not been checked against a sleep study.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sonar = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TONES = [18000, 18500, 19000, 19500, 20000];
  const QUIET_HZ = 17250;                // no tone here: the noise floor
  const BB_RATE = 20;                    // baseband samples per second
  const KEEP_S = 90, WINDOW_S = 60, MIN_S = 25;
  const PAUSE_S = 10, PAUSE_LEVEL = 0.25, MOVE_LEVEL = 5;
  const MIN_SCORE = 0.25;                // breathing share of the spectrum
  const MIN_SNR = 4;                     // breathing movement vs. noise at a silent frequency

  /**
   * Streaming demodulator. push() raw microphone samples; it keeps the
   * last KEEP_S seconds of baseband per tone.
   */
  function createDemod(sampleRate, tones = TONES) {
    const freqs = [...tones, QUIET_HZ];
    const block = Math.round(sampleRate / BB_RATE), keep = KEEP_S * BB_RATE;
    const w = freqs.map((f) => 2 * Math.PI * f / sampleRate);
    const acc = freqs.map(() => [0, 0]);
    const ring = freqs.map(() => ({ re: new Float32Array(keep), im: new Float32Array(keep) }));
    let n = 0, filled = 0, count = 0, at = 0;
    return {
      sampleRate, tones, freqs,
      push(x) {
        for (let i = 0; i < x.length; i++, n++) {
          const v = x[i];
          for (let k = 0; k < freqs.length; k++) {
            // Wrap the phase so long nights do not lose precision.
            const ph = (w[k] * n) % (2 * Math.PI);
            acc[k][0] += v * Math.cos(ph); acc[k][1] -= v * Math.sin(ph);
          }
          if (++count === block) {
            for (let k = 0; k < freqs.length; k++) {
              ring[k].re[at] = acc[k][0] / block; ring[k].im[at] = acc[k][1] / block;
              acc[k][0] = acc[k][1] = 0;
            }
            at = (at + 1) % keep; filled = Math.min(keep, filled + 1); count = 0;
          }
        }
      },
      /** Seconds of audio processed so far. */
      get seconds() { return n / sampleRate; },
      /** Last `seconds` of baseband for tone k, oldest first: {re, im}. */
      recent(k, seconds) {
        const len = Math.min(filled, Math.round(seconds * BB_RATE)), re = new Float64Array(len), im = new Float64Array(len);
        for (let i = 0; i < len; i++) {
          const j = (at - len + i + keep) % keep;
          re[i] = ring[k].re[j]; im[i] = ring[k].im[j];
        }
        return { re, im };
      },
    };
  }

  // ---- signal helpers ----
  function biquad(kind, hz, rate) {
    const w = 2 * Math.PI * hz / rate, alpha = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w), a0 = 1 + alpha;
    const b = kind === 'low' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
    return [b[0] / a0, b[1] / a0, b[2] / a0, -2 * c / a0, (1 - alpha) / a0];
  }
  function filt([b0, b1, b2, a1, a2], x) {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      y[i] = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y[i];
    }
    return y;
  }
  /** Zero-phase band-pass (forward and backward), so pauses are not smeared later in time. */
  function bandpass(x, lo, hi, rate = BB_RATE) {
    const once = (v) => filt(biquad('low', hi, rate), filt(biquad('high', lo, rate), v));
    return once(once(x).reverse()).reverse();
  }
  const rmsOf = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));
  const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
  const median = (xs) => { const s = Float64Array.from(xs).sort(), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const percentile = (xs, p) => { const s = Float64Array.from(xs).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

  /** Remove a straight line (slow drift) from x. */
  function detrend(x) {
    const n = x.length, mx = (n - 1) / 2, my = mean(x);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - mx) * (x[i] - my); den += (i - mx) ** 2; }
    const slope = den ? num / den : 0;
    return x.map((v, i) => v - my - slope * (i - mx));
  }

  /** The 1-D movement of a complex signal along its main direction. */
  function principal(re, im) {
    const a = detrend(re), b = detrend(im);
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < a.length; i++) { sxx += a[i] * a[i]; syy += b[i] * b[i]; sxy += a[i] * b[i]; }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(theta), uy = Math.sin(theta);
    return a.map((v, i) => v * ux + b[i] * uy);
  }

  function powerSpectrum(x, from, to, step, rate = BB_RATE) {
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

  /** Moving RMS over `win` samples, centred. */
  function envelope(x, win) {
    const out = new Float64Array(x.length), half = win >> 1;
    const sq = new Float64Array(x.length + 1);
    for (let i = 0; i < x.length; i++) sq[i + 1] = sq[i] + x[i] * x[i];
    for (let i = 0; i < x.length; i++) {
      const a = Math.max(0, i - half), b = Math.min(x.length, i + half + 1);
      out[i] = Math.sqrt((sq[b] - sq[a]) / (b - a));
    }
    return out;
  }

  /**
   * Analyse the last WINDOW_S seconds: which tone shows breathing best, the
   * breathing waveform and rate, and stretches where breathing paused.
   * Times in the result are seconds since the start of the recording.
   */
  function analyze(demod, windowS = WINDOW_S) {
    const quietK = demod.freqs.length - 1;
    const len = Math.min(windowS, demod.seconds);
    if (len < MIN_S) return { verdict: 'wait', seconds: demod.seconds };

    // Are the tones reaching the microphone at all?
    const level = (k) => { const z = demod.recent(k, len); return mean(Array.from(z.re, (r, i) => Math.hypot(r, z.im[i]))); };
    const floor = level(quietK);
    const heard = demod.tones.map((_, k) => level(k) > 10 * floor + 1e-7);
    if (!heard.some(Boolean)) {
      return { verdict: 'retake', code: 'no-tone', problem: 'The microphone cannot hear the high-pitched sound. Turn the volume up, take the phone out of its case, and make sure no earphones are connected. Some phones cannot play or record these frequencies.' };
    }

    // How much the silent frequency wobbles in the breathing band: the
    // noise any real breathing movement has to stand clear of.
    const q = demod.recent(quietK, len);
    const noiseRms = Math.hypot(rmsOf(bandpass(detrend(q.re), 0.1, 0.8)), rmsOf(bandpass(detrend(q.im), 0.1, 0.8))) / Math.SQRT2;

    let best = null;
    demod.tones.forEach((hz, k) => {
      if (!heard[k]) return;
      const z = demod.recent(k, len);
      const wave = bandpass(principal(z.re, z.im), 0.1, 0.8);
      const spec = powerSpectrum(wave, 0.05, 1.5, 1 / 120);
      const total = spec.reduce((a, p) => a + p[1], 0) || 1e-30;
      let peak = spec[0];
      for (const p of spec) if (p[0] >= 0.1 && p[0] <= 0.8 && p[1] > peak[1]) peak = p;
      const near = spec.filter((p) => Math.abs(p[0] - peak[0]) <= 0.05).reduce((a, p) => a + p[1], 0);
      const score = near / total, snr = rmsOf(wave) / (noiseRms || 1e-12);
      if (!best || score * Math.min(snr, 10) > best.score * Math.min(best.snr, 10)) best = { hz, k, wave, score, snr, rateHz: peak[0] };
    });

    const start = demod.seconds - len;
    const env = envelope(best.wave, 4 * BB_RATE);
    const baseline = percentile(env, 0.75);
    const pauses = [], moves = [];
    const runs = (test, minS, into) => {
      let from = -1;
      for (let i = 0; i <= env.length; i++) {
        const on = i < env.length && test(env[i]);
        if (on && from < 0) from = i;
        if (!on && from >= 0) {
          if ((i - from) / BB_RATE >= minS) into.push({ from: start + from / BB_RATE, to: start + i / BB_RATE, ongoing: i === env.length });
          from = -1;
        }
      }
    };
    // The 4-second envelope shortens a flat stretch by about 2 s at each
    // end, so a 10-second pause shows as about 6 seconds of low envelope.
    runs((e) => e < PAUSE_LEVEL * baseline, PAUSE_S - 4, pauses);
    runs((e) => e > MOVE_LEVEL * baseline, 1, moves);
    for (const p of pauses) { p.from -= 2; p.to += p.ongoing ? 0 : 2; }

    const breathing = best.score >= MIN_SCORE && best.snr >= MIN_SNR;
    return {
      verdict: breathing ? 'ok' : 'unclear',
      problem: breathing ? null : 'No clear breathing movement yet. Put the phone within about half a metre of the chest, speaker towards it, and keep the room quiet.',
      ratePerMin: breathing ? best.rateHz * 60 : null,
      wave: best.wave, waveStart: start, toneHz: best.hz, score: best.score, snr: best.snr, tonesHeard: heard.filter(Boolean).length,
      pauses: breathing ? pauses : [], moves, seconds: demod.seconds,
    };
  }

  /**
   * Keeps a night's list of pauses from overlapping analysis windows:
   * each pause is counted once, when it ends, and is ignored if the person
   * moved during it (moving is not a breathing pause).
   */
  function createNight() {
    const events = [], minutes = [];
    return {
      events, minutes,
      update(r) {
        if (r.verdict !== 'ok') return;
        for (const p of r.pauses) {
          if (p.ongoing) continue;
          if (r.moves.some((m) => m.from < p.to && m.to > p.from)) continue;
          const same = events.find((e) => e.from < p.to + 3 && e.to > p.from - 3);
          if (same) { same.from = Math.min(same.from, p.from); same.to = Math.max(same.to, p.to); } else events.push({ from: p.from, to: p.to });
        }
        const minute = Math.floor(r.seconds / 60);
        if (!minutes.length || minutes[minutes.length - 1].minute !== minute) minutes.push({ minute, rate: r.ratePerMin });
      },
      /** Pauses per hour over the time breathing was tracked. */
      perHour(trackedSeconds) {
        return trackedSeconds >= 600 ? events.length / (trackedSeconds / 3600) : null;
      },
    };
  }

  return { TONES, QUIET_HZ, BB_RATE, WINDOW_S, MIN_S, PAUSE_S, createDemod, analyze, createNight, bandpass, principal, envelope };
});
