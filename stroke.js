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

  return { EYE_RIGHT, EYE_LEFT, MOUTH_RIGHT, MOUTH_LEFT, MIN_SMILE, WEAK_RATIO, corners, droop };
});
