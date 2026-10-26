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
