// Run: node --test stroke.test.js
const test = require('node:test');
const assert = require('node:assert');
const Stroke = require('./stroke.js');

/**
 * Landmarks for a face: eyes 0.2 apart at y = 0.4, mouth corners at
 * y = 0.6 minus each side's lift, the whole face rotated by `rollDeg`
 * and shifted, as from a 3:4 portrait camera frame.
 */
function face({ liftRight = 0, liftLeft = 0, rollDeg = 0, scale = 1, jitter = 0, seed = 1 }) {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * jitter;
  const aspect = 0.75, r = rollDeg * Math.PI / 180, cx = 0.5 * aspect, cy = 0.5;
  const at = (x, y) => {
    const dx = (x - 0.5) * scale * aspect, dy = (y - 0.5) * scale;
    return { x: (cx + dx * Math.cos(r) - dy * Math.sin(r)) / aspect + rand(), y: cy + dx * Math.sin(r) + dy * Math.cos(r) + rand() };
  };
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  // Image left is the person's right side.
  pts[Stroke.EYE_RIGHT] = at(0.5 - 0.1 / 0.75, 0.4);
  pts[Stroke.EYE_LEFT] = at(0.5 + 0.1 / 0.75, 0.4);
  pts[Stroke.MOUTH_RIGHT] = at(0.5 - 0.07 / 0.75, 0.6 - liftRight);
  pts[Stroke.MOUTH_LEFT] = at(0.5 + 0.07 / 0.75, 0.6 - liftLeft);
  return Stroke.corners(pts, aspect);
}
const frames = (n, opts) => Array.from({ length: n }, (_, i) => face({ ...opts, seed: i + 1 }));

test('mouth corners are measured from the eye line, whatever the head tilt or distance', () => {
  for (const rollDeg of [0, 12, -20]) for (const scale of [0.6, 1.3]) {
    const c = face({ rollDeg, scale });
    assert.ok(Math.abs(c.right - 1) < 1e-6 && Math.abs(c.left - 1) < 1e-6, `${rollDeg}° ×${scale}: ${c.right}, ${c.left}`);
  }
});

test('an even smile shows no droop; one side lagging does', () => {
  const rest = frames(20, { jitter: 0.002 });
  const even = Stroke.droop(rest, frames(30, { liftRight: 0.03, liftLeft: 0.028, jitter: 0.002, rollDeg: 8 }));
  assert.equal(even.verdict, 'ok', even.problem);
  assert.equal(even.sign, false, `ratio ${even.ratio}`);

  const weakLeft = Stroke.droop(rest, frames(30, { liftRight: 0.03, liftLeft: 0.006, jitter: 0.002 }));
  assert.equal(weakLeft.verdict, 'ok', weakLeft.problem);
  assert.equal(weakLeft.sign, true, `ratio ${weakLeft.ratio}`);
  assert.equal(weakLeft.weaker, 'left');
});

test('a face that is naturally a little uneven at rest is judged by how each side moves', () => {
  const rest = frames(20, { liftRight: 0.01 });        // right corner sits higher at rest
  const smile = frames(30, { liftRight: 0.04, liftLeft: 0.03 });  // both lift by 0.03
  const r = Stroke.droop(rest, smile);
  assert.equal(r.sign, false, `ratio ${r.ratio}`);
});

test('no face or no smile asks for a retake', () => {
  assert.equal(Stroke.droop([], frames(30, {})).code, 'no-face');
  assert.equal(Stroke.droop(frames(20, {}), frames(30, { liftRight: 0.005, liftLeft: 0.005 })).code, 'no-smile');
});

test('a one-sided smile, as in facial weakness, is flagged rather than sent back for a retake', () => {
  const r = Stroke.droop(frames(20, {}), frames(30, { liftRight: 0.012, liftLeft: 0 }));
  assert.equal(r.verdict, 'ok', r.problem);
  assert.equal(r.sign, true);
  assert.equal(r.weaker, 'left');
});

// ---- Speech ----

test('word match: the right sentence, a slurred one, and a different one', () => {
  assert.equal(Stroke.wordMatch(' You can\'t teach an old dog new tricks?').share, 1);
  assert.equal(Stroke.wordMatch('you cant teach an old dog new trick').share, 1, 'one letter off in a long word still counts');
  // What Whisper heard from slow, slurred speech (see the e2e recordings).
  assert.ok(Stroke.wordMatch(' You can TNO DWE New Ticks').share < Stroke.MIN_WORDS);
  assert.equal(Stroke.wordMatch('The cat is sitting on a red chair.').share, 0);
});

/** Speech-like test signal: bursts (syllables) of a 180 Hz buzz with gaps, plus room noise. */
function talk({ bursts = 8, burstS = 0.18, gapS = 0.1, pauseAt = -1, pauseS = 0, level = 0.2, sr = 16000 }) {
  const out = [];
  const push = (s, on) => { for (let i = 0; i < s * sr; i++) out.push((on ? level * Math.sin(2 * Math.PI * 180 * i / sr) * Math.sin(Math.PI * i / (s * sr)) : 0) + 0.001 * Math.sin(i * 12.9898) ); };
  push(0.5, false);
  for (let b = 0; b < bursts; b++) { push(burstS, true); push(b === pauseAt ? pauseS : gapS, false); }
  push(0.6, false);
  return Float32Array.from(out);
}

test('speech timing: length and the longest pause', () => {
  const normal = Stroke.speechTiming(talk({}), 16000);
  assert.ok(normal.voiced);
  assert.ok(Math.abs(normal.durationS - (8 * 0.28 - 0.1)) < 0.25, `duration ${normal.durationS}`);
  assert.ok(normal.longestPauseS < 0.3, `pause ${normal.longestPauseS}`);
  const halting = Stroke.speechTiming(talk({ pauseAt: 3, pauseS: 1.6 }), 16000);
  assert.ok(Math.abs(halting.longestPauseS - 1.6) < 0.15, `pause ${halting.longestPauseS}`);
  assert.equal(Stroke.speechTiming(new Float32Array(16000), 16000).voiced, false);
});

test('speech check: clear speech passes; wrong words, slow or halting speech is a sign', () => {
  const timing = Stroke.speechTiming(talk({}), 16000);
  assert.equal(Stroke.speechCheck({ timing, heard: 'You can\'t teach an old dog new tricks.' }).sign, false);
  assert.equal(Stroke.speechCheck({ timing, heard: 'You can TNO DWE New Ticks' }).sign, true);
  const slow = Stroke.speechTiming(talk({ burstS: 0.5, gapS: 0.3 }), 16000);
  assert.equal(Stroke.speechCheck({ timing: slow, heard: 'You can\'t teach an old dog new tricks.' }).sign, true);
  const halting = Stroke.speechTiming(talk({ pauseAt: 3, pauseS: 1.6 }), 16000);
  assert.match(Stroke.speechCheck({ timing: halting, heard: null }).reasons.join(), /stopped/);
  assert.equal(Stroke.speechCheck({ timing: Stroke.speechTiming(new Float32Array(16000), 16000), heard: '' }).code, 'silent');
});
