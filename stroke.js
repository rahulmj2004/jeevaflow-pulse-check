/**
 * Face droop for the stroke check (the F in FAST). Uses face landmarks
 * from MediaPipe Face Landmarker (478 points, computed on the phone).
 *
 * Heights are measured from the line through the outer eye corners, so
 * tilting the head does not matter, and divided by the distance between
 * the eyes, so distance from the camera does not matter. A smile lifts
 * both mouth corners; with facial weakness one side lifts much less.
 * Comparing the smile with the relaxed face cancels out the ordinary
 * asymmetry everyone's face has.
 *
 * Speech (the S in FAST): the person says a set sentence. The words are
 * transcribed on the phone (Whisper tiny, run in the browser) and compared
 * with the sentence, and the recording's timing shows slow or halting
 * speech. Accents can lower the word score, so a low score asks for one
 * more try before it counts.
 *
 * Cut-offs are provisional: they have not been checked against patients.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Stroke = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // MediaPipe face mesh indices. "Right"/"left" are the person's own sides.
  const EYE_RIGHT = 33, EYE_LEFT = 263, MOUTH_RIGHT = 61, MOUTH_LEFT = 291;
  // A drooping face lifts only one side, so judge the smile by the stronger side.
  const MIN_SMILE = 0.04;      // stronger corner's lift, in eye-distances
  const WEAK_RATIO = 0.4;      // weaker side lifts less than 40% of the other

  /**
   * points: landmarks [{x, y}] normalised to the image; aspect = width / height.
   * Returns mouth-corner heights below the eye line, in eye-distances.
   */
  function corners(points, aspect = 1) {
    const p = (i) => [points[i].x * aspect, points[i].y];
    const a = p(EYE_RIGHT), b = p(EYE_LEFT);
    const ex = b[0] - a[0], ey = b[1] - a[1], eyeDist = Math.hypot(ex, ey);
    // Distance below the eye line (image y grows downwards).
    const below = (q) => ((q[0] - a[0]) * -ey + (q[1] - a[1]) * ex) / eyeDist / eyeDist;
    const flip = ex < 0 ? -1 : 1;   // a mirrored image swaps the sides
    return { right: flip * below(p(MOUTH_RIGHT)), left: flip * below(p(MOUTH_LEFT)), eyeDist };
  }

  const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  /**
   * rest, smile: arrays of corners() from video frames. Uses the frames
   * with the biggest smile. Returns how much each side lifted and whether
   * one side lagged.
   */
  function droop(rest, smile) {
    if (rest.length < 5) return { verdict: 'retake', code: 'no-face', problem: 'The face was not found while relaxed. Hold the phone at arm\'s length with the face in good light.' };
    if (smile.length < 5) return { verdict: 'retake', code: 'no-face', problem: 'The face was not found during the smile. Keep the whole face in view.' };
    const base = { right: median(rest.map((c) => c.right)), left: median(rest.map((c) => c.left)) };
    const lifts = smile.map((c) => ({ right: base.right - c.right, left: base.left - c.left }));
    lifts.sort((a, b) => (b.right + b.left) - (a.right + a.left));
    const top = lifts.slice(0, Math.max(3, Math.round(lifts.length * 0.3)));
    const right = median(top.map((l) => l.right)), left = median(top.map((l) => l.left));
    if (Math.max(right, left) < MIN_SMILE) return { verdict: 'retake', code: 'no-smile', problem: 'The smile was too small to compare the two sides. Give a big smile showing the teeth.', liftRight: right, liftLeft: left };
    const weaker = right < left ? 'right' : 'left';
    const ratio = Math.max(0, Math.min(right, left)) / Math.max(right, left);
    return { verdict: 'ok', liftRight: right, liftLeft: left, ratio, weaker, sign: ratio < WEAK_RATIO };
  }

  // ---- Speech ----
  const SENTENCE = 'You can\'t teach an old dog new tricks.';
  const MIN_WORDS = 0.75;      // share of the sentence's words heard
  const SLOW_S = 5, PAUSE_S = 1.2;

  const words = (text) => text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  function editDistance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  // A word counts if it matches, or is one letter off in a word of 4+ letters.
  const same = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && editDistance(a, b) <= 1);

  /** Share of the target sentence's words heard, in order (longest common subsequence). */
  function wordMatch(heard, target = SENTENCE) {
    const h = words(heard), t = words(target);
    const L = Array.from({ length: t.length + 1 }, () => new Array(h.length + 1).fill(0));
    for (let i = 1; i <= t.length; i++) for (let j = 1; j <= h.length; j++) {
      L[i][j] = same(t[i - 1], h[j - 1]) ? L[i - 1][j - 1] + 1 : Math.max(L[i - 1][j], L[i][j - 1]);
    }
    return { matched: L[t.length][h.length], total: t.length, share: L[t.length][h.length] / t.length };
  }

  /**
   * x: mono samples. Finds where speech starts and ends (20 ms frames well
   * above the room's noise), its length, and the longest silence inside it.
   */
  function speechTiming(x, sampleRate) {
    const frame = Math.round(sampleRate * 0.02), db = [];
    for (let i = 0; i + frame <= x.length; i += frame) {
      let e = 0;
      for (let k = i; k < i + frame; k++) e += x[k] * x[k];
      db.push(10 * Math.log10(e / frame + 1e-12));
    }
    if (!db.length) return { voiced: false, peakDb: -120 };
    const sorted = [...db].sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.1)], peakDb = sorted[sorted.length - 1];
    const on = db.map((v) => v > Math.max(floor + 15, -55));
    const first = on.indexOf(true), last = on.lastIndexOf(true);
    if (first < 0 || peakDb < -50) return { voiced: false, peakDb };
    let longest = 0, run = 0;
    for (let i = first; i <= last; i++) { run = on[i] ? 0 : run + 1; longest = Math.max(longest, run); }
    return { voiced: true, peakDb, startS: first * 0.02, durationS: (last - first + 1) * 0.02, longestPauseS: longest * 0.02 };
  }

  /** Combine the words heard and the timing into one speech result. */
  function speechCheck({ timing, heard }) {
    if (!timing.voiced) return { verdict: 'retake', code: 'silent', problem: 'No speech was heard. Hold the phone about 30 cm from the mouth and try again. If the person cannot speak at all, tap "Could not speak".' };
    const reasons = [];
    const match = heard == null ? null : wordMatch(heard);
    if (match && match.share < MIN_WORDS) reasons.push(`only ${match.matched} of ${match.total} words came out right`);
    if (timing.durationS > SLOW_S) reasons.push(`it took ${timing.durationS.toFixed(1)} s (usually 2–3 s)`);
    if (timing.longestPauseS > PAUSE_S) reasons.push(`it stopped for ${timing.longestPauseS.toFixed(1)} s in the middle`);
    return { verdict: 'ok', sign: reasons.length > 0, reasons, heard, match, ...timing };
  }

  return {
    EYE_RIGHT, EYE_LEFT, MOUTH_RIGHT, MOUTH_LEFT, MIN_SMILE, WEAK_RATIO, corners, droop,
    SENTENCE, MIN_WORDS, SLOW_S, PAUSE_S, words, wordMatch, speechTiming, speechCheck,
  };
});
