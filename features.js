/**
 * Page logic for the Tremor, Stroke check and Sleep tabs. The measuring
 * itself lives in motion.js, stroke.js and sonar.js; this file only runs
 * the sensors and shows the results.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const load = (key) => { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; } };
  const store = (key, list) => { try { localStorage.setItem(key, JSON.stringify(list)); return true; } catch { return false; } };
  const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const setNotice = (el, text) => { el.hidden = !text; el.textContent = text || ''; };
  const radio = (on, off) => { on.setAttribute('aria-checked', 'true'); off.setAttribute('aria-checked', 'false'); };
  const chipOf = { good: 'chip good', warn: 'chip warn', bad: 'chip bad', none: 'chip' };

  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
      else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { /* optional */ }
  }

  /** Spoken prompt plus a beep, for steps done with eyes closed. */
  let beepCtx = null;
  function cue(text, { beep = true } = {}) {
    try {
      if (beep) {
        beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
        const o = beepCtx.createOscillator(), g = beepCtx.createGain();
        o.frequency.value = 880; g.gain.value = 0.2;
        o.connect(g).connect(beepCtx.destination); o.start(); o.stop(beepCtx.currentTime + 0.25);
      }
      if (text && 'speechSynthesis' in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); }
    } catch { /* sound is optional */ }
  }

  /** Line plot of the last values on a canvas, sized for the screen. */
  function plot(canvas, values, { color = css('--trace'), marks = [], fixed = null } = {}) {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = css('--line'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    if (!values.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (fixed) { lo = Math.min(lo, -fixed); hi = Math.max(hi, fixed); }
    const span = Math.max(hi - lo, 1e-12), X = (i) => i / Math.max(1, values.length - 1) * w, Y = (v) => h - 10 - (v - lo) / span * (h - 20);
    g.fillStyle = css('--warn-soft');
    for (const [a, b] of marks) g.fillRect(X(a), 0, Math.max(2, X(b) - X(a)), h);
    g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = 'round';
    g.beginPath();
    values.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
    g.stroke();
  }

  /** Motion sensor stream. Asks permission on iPhone (must be called from a tap). */
  async function motionStream(onSample, { gravity = false } = {}) {
    const D = window.DeviceMotionEvent;
    if (!D) throw new Error('This browser does not share the motion sensor.');
    if (typeof D.requestPermission === 'function') {
      const answer = await D.requestPermission().catch(() => 'denied');
      if (answer !== 'granted') throw new Error('Motion sensor permission was not given. Allow "Motion & Orientation Access" and try again.');
    }
    const handler = (e) => {
      const a = !gravity && e.acceleration && e.acceleration.x != null ? e.acceleration : e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      onSample({ t: performance.now(), x: a.x, y: a.y, z: a.z });
    };
    window.addEventListener('devicemotion', handler);
    return () => window.removeEventListener('devicemotion', handler);
  }

  // =====================================================================
  // Tremor
  // =====================================================================
  const TR_KEY = 'jf.tremor.checks';
  const tr = { hand: 'right', pose: 'rest', run: null, last: null };

  const TREMOR = {
    none: { box: 'clear', chip: 'good', short: 'None', head: 'No noticeable tremor' },
    mild: { box: 'unclear', chip: 'warn', short: 'Mild', head: 'Mild tremor' },
    strong: { box: 'flat', chip: 'bad', short: 'Strong', head: 'Strong tremor' },
  };
  const RANGE_TEXT = {
    'parkinson-range': 'This speed (3.5–7.5 per second) is typical of Parkinson\'s disease and essential tremor. Only a doctor can tell them apart: Parkinson\'s tremor is usually strongest with the hand resting, essential tremor when the arm is held out.',
    'physiological-range': 'This speed (above 7.5 per second) is typical of the normal tremor everyone has, which gets stronger with stress, caffeine, tiredness, low blood sugar, an overactive thyroid or some medicines.',
    slow: 'A slow wobble below 3.5 per second is less typical of a tremor; it can come from the arm getting tired.',
  };

  function trShow(r) {
    const box = $('trVerdict');
    $('trMeta').innerHTML = '';
    const meta = (t) => { const s = document.createElement('span'); s.textContent = t; $('trMeta').append(s); };
    if (r.verdict !== 'ok') {
      box.hidden = true;
      $('trHz').textContent = '--'; $('trRms').innerHTML = '--<span>m/s²</span>'; $('trMm').innerHTML = '--<span>mm</span>'; $('trRhythm').textContent = '--';
      meta('No result this time');
      return;
    }
    const info = TREMOR[r.level];
    box.hidden = false; box.className = `verdict ${info.box}`;
    const hand = `${r.hand === 'left' ? 'Left' : 'Right'} hand, ${r.pose === 'out' ? 'arm held out' : 'resting'}`;
    $('trHead').textContent = r.level === 'none' ? `${hand}: ${info.head}` : `${hand}: ${info.head} at ${r.hz.toFixed(1)} per second`;
    $('trText').textContent = r.level === 'none'
      ? `The shaking measured (${r.rmsMs2.toFixed(2)} m/s²) is below the level counted as a tremor.`
      : `${RANGE_TEXT[r.range]} ${r.level === 'strong' ? 'Please see a doctor, especially if it is new or getting worse.' : 'If you notice it in daily life, mention it to a doctor.'}`;
    $('trHz').textContent = r.level === 'none' ? '--' : r.hz.toFixed(1);
    $('trRms').innerHTML = `${r.rmsMs2.toFixed(2)}<span>m/s²</span>`;
    $('trMm').innerHTML = `${r.sizeMm < 0.1 ? '<0.1' : r.sizeMm.toFixed(1)}<span>mm</span>`;
    $('trRhythm').textContent = `${Math.round(r.rhythmic * 100)}%`;
    meta(`${Math.round(r.seconds)} s at ${Math.round(r.sensorRate)} readings a second`);
    if (r.level !== 'none') meta(`Peak at ${r.hz.toFixed(1)} Hz`);
    // The spectrum: where the shaking energy sits.
    const spec = r.spectrum.filter(([hz]) => hz >= 2 && hz <= 16);
    plot($('trTrace'), spec.map((p) => Math.sqrt(p[1])), { color: css('--accent') });
    $('trScale').textContent = 'shaking by speed · 2–16 per second';
  }

  function trRender() {
    const list = load(TR_KEY), body = $('trHistory').querySelector('tbody');
    body.innerHTML = '';
    for (const c of list.slice(0, 20)) {
      const tr2 = document.createElement('tr');
      const cells = [[when(c.at)], [`${c.hand === 'left' ? 'Left' : 'Right'}, ${c.pose === 'out' ? 'out' : 'rest'}`],
        [c.level === 'none' ? '--' : `${c.hz.toFixed(1)}/s`, 'num'], [`${c.rms.toFixed(2)}`, 'num']];
      for (const [text, cls] of cells) { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; tr2.append(td); }
      const td = document.createElement('td'), chip = document.createElement('span');
      chip.className = chipOf[TREMOR[c.level].chip]; chip.textContent = TREMOR[c.level].short; td.append(chip); tr2.append(td);
      body.append(tr2);
    }
    $('trHistory').hidden = !list.length; $('trNoHistory').hidden = !!list.length; $('trClear').hidden = !list.length;
  }

  async function trStart() {
    setNotice($('trNotice'), '');
    $('trSave').hidden = true; tr.last = null;
    const samples = [], live = [];
    let hp = 0, prev = null, stopFn = null, cancelled = false;
    try {
      stopFn = await motionStream((s) => {
        samples.push(s);
        // Simple high-pass for the live line, so gravity and slow drift do not swamp it.
        const v = s.x + s.y + s.z;
        hp = prev == null ? 0 : 0.85 * (hp + v - prev); prev = v;
        live.push(hp); if (live.length > 300) live.shift();
      });
    } catch (e) { setNotice($('trNotice'), e.message); return; }
    tr.run = { cancel() { cancelled = true; } };
    $('trStart').hidden = true; $('trStop').hidden = false; $('trProgressWrap').hidden = false;
    $('trVerdict').hidden = true; $('trScale').textContent = 'shaking · last 5 s';
    keepAwake(true);
    const draw = () => { if (tr.run) { plot($('trTrace'), live, { fixed: 0.3 }); requestAnimationFrame(draw); } };
    requestAnimationFrame(draw);

    // Settle for 3 seconds, then record 20.
    for (let k = 3; k > 0 && !cancelled; k--) { $('trStatus').textContent = `Hold still… starting in ${k}`; await wait(1000); }
    if (!samples.length && !cancelled) {
      cancelled = true;
      setNotice($('trNotice'), 'No motion readings arrived. Open this page in Chrome or Safari on a phone; computers have no motion sensor.');
    }
    samples.length = 0;
    const t0 = performance.now();
    while (!cancelled && performance.now() - t0 < 20000) {
      $('trStatus').textContent = `Measuring… keep still, ${Math.ceil(20 - (performance.now() - t0) / 1000)} s`;
      $('trProgress').style.width = `${(performance.now() - t0) / 200}%`;
      await wait(200);
    }
    stopFn(); tr.run = null; keepAwake(false);
    $('trStart').hidden = false; $('trStop').hidden = true; $('trProgressWrap').hidden = true; $('trProgress').style.width = '0%';
    if (cancelled) { $('trStatus').textContent = 'Stopped.'; return; }

    const r = Object.assign(Motion.tremor(samples), { hand: tr.hand, pose: tr.pose });
    trShow(r);
    if (r.verdict === 'ok') {
      tr.last = r; $('trSave').hidden = false; $('trSave').disabled = false; $('trSave').textContent = 'Save check';
      $('trStatus').textContent = 'Done. Check the other hand too.';
    } else {
      $('trStatus').textContent = 'No result this time.';
      setNotice($('trNotice'), r.problem);
    }
  }

  $('trLeft').addEventListener('click', () => { if (!tr.run) { tr.hand = 'left'; radio($('trLeft'), $('trRight')); } });
  $('trRight').addEventListener('click', () => { if (!tr.run) { tr.hand = 'right'; radio($('trRight'), $('trLeft')); } });
  $('trRest').addEventListener('click', () => { if (!tr.run) { tr.pose = 'rest'; radio($('trRest'), $('trOut')); } });
  $('trOut').addEventListener('click', () => { if (!tr.run) { tr.pose = 'out'; radio($('trOut'), $('trRest')); } });
  $('trStart').addEventListener('click', trStart);
  $('trStop').addEventListener('click', () => tr.run && tr.run.cancel());
  $('trSave').addEventListener('click', () => {
    if (!tr.last) return;
    const r = tr.last, list = load(TR_KEY);
    list.unshift({ at: new Date().toISOString(), hand: r.hand, pose: r.pose, level: r.level, hz: Math.round(r.hz * 10) / 10, rms: Math.round(r.rmsMs2 * 100) / 100, method: 'tremor-accel-v1' });
    if (store(TR_KEY, list.slice(0, 40))) { $('trSave').disabled = true; $('trSave').textContent = 'Saved'; tr.last = null; trRender(); }
    else setNotice($('trNotice'), 'This browser is not keeping data for this page (for example, a private window), so the check was not saved.');
  });
  $('trClear').addEventListener('click', () => { if (confirm('Delete every tremor check saved in this browser?')) { store(TR_KEY, []); trRender(); } });

  // =====================================================================
  // Stroke check (FAST)
  // =====================================================================
  const st = { face: null, arms: { left: null, right: null }, speech: null, run: null };
  const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const HF = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
  let landmarker = null, asrModel = null;

  async function getLandmarker() {
    if (landmarker) return landmarker;
    const vision = await import(`${MP}/vision_bundle.mjs`);
    const files = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const make = (delegate) => vision.FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: 'models/face_landmarker.task', delegate }, runningMode: 'VIDEO', numFaces: 1,
    });
    landmarker = await make('GPU').catch(() => make('CPU'));
    return landmarker;
  }

  /** Whisper tiny (English), downloaded once and cached by the browser; runs on the phone. */
  async function getAsr(onProgress) {
    if (asrModel) return asrModel;
    const { pipeline } = await import(`${HF}/dist/transformers.min.js`);
    asrModel = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', {
      dtype: 'q8',
      progress_callback: (p) => { if (p.status === 'progress' && p.total > 1e6) onProgress(p.loaded / p.total); },
    });
    return asrModel;
  }

  /** Horizontal bars, e.g. how much each side lifted. rows: [{label, value, max, bad, text}] */
  function bars(el, rows) {
    el.innerHTML = '';
    for (const r of rows) {
      const row = document.createElement('div'), label = document.createElement('span'), track = document.createElement('span'), fill = document.createElement('i'), val = document.createElement('b');
      label.textContent = r.label; track.className = 'track';
      fill.style.width = `${Math.max(2, Math.min(100, r.value / r.max * 100))}%`; if (r.bad) fill.className = 'bad';
      track.append(fill); val.textContent = r.text;
      row.append(label, track, val); el.append(row);
    }
  }

  function setResult(prefix, cls, head, text) {
    const box = $(`${prefix}Result`);
    box.hidden = false; box.className = `verdict ${cls}`;
    $(`${prefix}Head`).textContent = head; $(`${prefix}Text`).textContent = text;
  }
  const setChip = (id, cls, text) => { $(id).className = chipOf[cls]; $(id).textContent = text; };

  /** Arm sign: either arm drifted, or one drifted much more than the other. */
  function armsVerdict() {
    const { left, right } = st.arms;
    if (!left || !right) return null;
    return Motion.compareArms(left, right);
  }

  /** The overall FAST result once all three steps are done; progress before that. */
  function stOverall() {
    const arms = armsVerdict();
    const steps = [
      { id: 'pgF', name: 'Face', done: !!st.face, sign: st.face && st.face.sign,
        say: st.face ? (st.face.sign ? `${cap(st.face.weaker)} side of the mouth lifted less` : 'Even smile') : 'Not done' },
      { id: 'pgA', name: 'Arms', done: !!arms, sign: arms && arms.sign,
        say: arms ? (arms.sign ? `${cap(arms.weaker)} arm drifted` : 'Both arms steady') : (st.arms.left || st.arms.right ? 'One arm done' : 'Not done') },
      { id: 'pgS', name: 'Speech', done: !!st.speech, sign: st.speech && st.speech.sign,
        say: st.speech ? (st.speech.none ? 'Could not speak' : st.speech.sign ? 'Unclear or slow speech' : 'Clear speech') : 'Not done' },
    ];
    for (const s of steps) $(s.id).className = s.sign ? 'sign' : s.done ? 'done' : '';
    const tally = $('stTally'); tally.innerHTML = '';
    for (const s of steps) {
      const li = document.createElement('li'), b = document.createElement('b'), t = document.createElement('span');
      b.textContent = `${s.sign ? '✗' : s.done ? '✓' : '·'} ${s.name}`; b.style.color = s.sign ? 'var(--bad)' : s.done ? 'var(--good)' : 'var(--muted)';
      t.textContent = s.say; li.append(b, t); tally.append(li);
    }
    const signs = steps.filter((s) => s.sign).length, done = steps.every((s) => s.done);
    const box = $('stOverall');
    $('stOverallActions').hidden = !(signs || done);
    $('pgR').className = signs ? 'sign' : done ? 'done' : '';
    if (signs) {
      box.className = 'verdict overall flat';
      $('stOverallHead').textContent = `Possible stroke: ${signs} of 3 signs found`;
      $('stOverallText').textContent = `Call 108 now. Ambulance services treat even one of these signs, starting suddenly, as a stroke until a hospital scan shows otherwise. Tell them when the symptoms started (it is now ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}). Do not give food, drink or medicine.`;
    } else if (done) {
      box.className = 'verdict overall clear';
      $('stOverallHead').textContent = 'No stroke signs found';
      $('stOverallText').textContent = 'Face, arms and speech all looked normal in this check. This does not rule out a stroke: if there is sudden numbness, confusion, trouble seeing or walking, or a sudden severe headache, call 108 anyway.';
    } else {
      box.className = 'verdict overall';
      $('stOverallHead').textContent = 'Overall result';
      $('stOverallText').textContent = `Do all three checks to see the overall result (${steps.filter((s) => s.done).length} of 3 done).`;
    }
    if (done || signs) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const cap = (w) => w[0].toUpperCase() + w.slice(1);

  // ---- 1. Face ----
  async function faceStart() {
    if (st.run) return;
    const video = $('stVideo'), marks = $('stMarks');
    $('fResult').hidden = true;
    let stream = null, cancelled = false;
    st.run = { cancel() { cancelled = true; } };
    $('fStart').hidden = true; $('fStop').hidden = false;
    const finish = () => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      $('stCam').hidden = true; $('fPrompt').hidden = true; st.run = null;
      $('fStart').hidden = false; $('fStop').hidden = true; keepAwake(false);
    };
    try {
      $('fStatus').textContent = 'Opening the camera…';
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      video.srcObject = stream; await video.play();
      $('stCam').hidden = false;
      $('fStatus').textContent = 'Loading the face model (about 4 MB, first time only)…';
      await getLandmarker();
    } catch (e) {
      finish();
      $('fStatus').textContent = '';
      setResult('f', '', 'Could not start', e && e.name === 'NotAllowedError' ? 'Camera permission was not given. Allow the camera and try again.' : 'The face check could not start on this browser. Try Chrome.');
      $('fBars').innerHTML = '';
      return;
    }
    keepAwake(true);
    const collect = async (prompt, ms, speak) => {
      $('fPrompt').hidden = false; $('fPrompt').textContent = prompt; cue(speak, { beep: false });
      const out = [], t0 = performance.now();
      let lastT = -1;
      while (!cancelled && performance.now() - t0 < ms) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        if (video.readyState < 2 || now === lastT) continue;
        lastT = now;
        const res = landmarker.detectForVideo(video, now);
        const pts = res.faceLandmarks && res.faceLandmarks[0];
        drawMarks(marks, video, pts);
        if (pts && now - t0 > 600) out.push(Stroke.corners(pts, video.videoWidth / video.videoHeight));
      }
      return out;
    };
    $('fStatus').textContent = '';
    await wait(800);
    const rest = await collect('Relax your face', 2500, 'Relax your face');
    const smile = await collect('Big smile! Show your teeth', 3000, 'Now a big smile, show your teeth');
    finish();
    if (cancelled) return;
    const r = Stroke.droop(rest, smile);
    if (r.verdict !== 'ok') {
      setResult('f', 'unclear', 'Try again', r.problem); $('fBars').innerHTML = '';
      setChip('fChip', 'warn', 'Try again');
      return;
    }
    st.face = r;
    const pct = (v) => Math.max(0, Math.round(v * 100)) || 0, max = Math.max(r.liftRight, r.liftLeft);
    setResult('f', r.sign ? 'flat' : 'clear',
      r.sign ? `Sign found: the ${r.weaker} side lifted much less` : 'Normal: both sides lifted evenly',
      r.sign ? `The ${r.weaker} side of the mouth lifted only ${Math.round(r.ratio * 100)}% as much as the other side. Facial droop on one side is a stroke sign.`
        : `The weaker side lifted ${Math.round(r.ratio * 100)}% as much as the other, which counts as even.`);
    bars($('fBars'), [
      { label: 'Right side', value: Math.max(0, r.liftRight), max, bad: r.sign && r.weaker === 'right', text: `${pct(r.liftRight)}` },
      { label: 'Left side', value: Math.max(0, r.liftLeft), max, bad: r.sign && r.weaker === 'left', text: `${pct(r.liftLeft)}` },
    ]);
    setChip('fChip', r.sign ? 'bad' : 'good', r.sign ? 'Sign found' : 'Normal');
    stOverall();
  }

  function drawMarks(canvas, video, pts) {
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    if (!pts) return;
    // The video is shown with object-fit: cover; map image coordinates the same way.
    const vw = video.videoWidth, vh = video.videoHeight, s = Math.max(w / vw, h / vh);
    const P = (i) => [(pts[i].x * vw - vw / 2) * s + w / 2, (pts[i].y * vh - vh / 2) * s + h / 2];
    g.strokeStyle = '#5fd18f'; g.fillStyle = '#5fd18f'; g.lineWidth = 2;
    const [a, b] = [P(Stroke.EYE_RIGHT), P(Stroke.EYE_LEFT)];
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
    for (const i of [Stroke.EYE_RIGHT, Stroke.EYE_LEFT, Stroke.MOUTH_RIGHT, Stroke.MOUTH_LEFT]) { const [x, y] = P(i); g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); }
  }

  // ---- 2. Arms ----
  async function armStart(side) {
    if (st.run) return;
    const samples = [];
    let stopFn;
    try { stopFn = await motionStream((s) => samples.push(s), { gravity: true }); } catch (e) { $('aStatus').textContent = e.message; return; }
    let cancelled = false;
    st.run = { cancel() { cancelled = true; } };
    $('aLeft').disabled = $('aRight').disabled = true;
    $('aStatus').textContent = '';
    keepAwake(true);
    const prompt = $('aPrompt'); prompt.hidden = false;
    for (let k = 4; k > 0 && !cancelled; k--) {
      prompt.textContent = `${cap(side)} arm straight out, phone flat on the palm… ${k}`;
      if (k === 4) cue(`Hold your ${side} arm straight out, with the phone flat on your palm.`, { beep: false });
      await wait(1000);
    }
    cue('Close your eyes now and keep still.');
    samples.length = 0;
    const t0 = performance.now();
    while (!cancelled && performance.now() - t0 < 10000) { prompt.textContent = `Eyes closed… ${Math.ceil(10 - (performance.now() - t0) / 1000)}`; await wait(250); }
    cue('Done. Open your eyes.');
    stopFn(); st.run = null; prompt.hidden = true; keepAwake(false);
    $('aLeft').disabled = $('aRight').disabled = false;
    if (cancelled) return;
    const r = Motion.armDrift(samples);
    const key = side === 'left' ? 'aLeft' : 'aRight';
    if (r.verdict !== 'ok') { setResult(key, 'unclear', `${cap(side)} arm: try again`, r.problem); return; }
    st.arms[side] = r;
    // Each arm's own result straight away.
    setResult(key, r.drifted ? 'flat' : 'clear',
      r.drifted ? `${cap(side)} arm: drifted ${r.driftDeg.toFixed(1)}°` : `${cap(side)} arm: steady (${r.driftDeg.toFixed(1)}°)`,
      r.drifted ? `The arm sank or turned by more than ${Motion.DRIFT_DEG}° with the eyes closed, which can mean weakness.` : `It moved less than ${Motion.DRIFT_DEG}° in 10 seconds with the eyes closed.`);
    const { left, right } = st.arms, c = armsVerdict();
    if (c) {
      setResult('a', c.sign ? 'flat' : 'clear',
        c.sign ? `Sign found: the ${c.weaker} arm drifted` : 'Normal: both arms stayed steady',
        c.sign ? `A weak arm slowly sinks or turns when the eyes are closed. The arms differed by ${c.gapDeg.toFixed(1)}°.` : `Both arms moved less than ${Motion.DRIFT_DEG}° and within ${Motion.DRIFT_GAP_DEG}° of each other.`);
      const max = Math.max(20, left.driftDeg, right.driftDeg);
      bars($('aBars'), [
        { label: 'Left arm', value: left.driftDeg, max, bad: c.sign && c.weaker === 'left', text: `${left.driftDeg.toFixed(1)}°` },
        { label: 'Right arm', value: right.driftDeg, max, bad: c.sign && c.weaker === 'right', text: `${right.driftDeg.toFixed(1)}°` },
      ]);
      setChip('aChip', c.sign ? 'bad' : 'good', c.sign ? 'Sign found' : 'Normal');
    } else {
      $('aStatus').textContent = `Now test the ${left ? 'right' : 'left'} arm.`;
      setChip('aChip', r.drifted ? 'bad' : 'warn', r.drifted ? 'Sign found' : 'One arm done');
    }
    stOverall();
  }

  // ---- 3. Speech ----
  /** Average down to 16 kHz for the speech model. */
  function to16k(x, rate) {
    const ratio = rate / 16000, out = new Float32Array(Math.floor(x.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
      let s = 0; for (let k = a; k < b; k++) s += x[k]; out[i] = s / (b - a);
    }
    return out;
  }

  async function speechStart() {
    if (st.run) return;
    $('sResult').hidden = true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      $('sStatus').textContent = e && e.name === 'NotAllowedError' ? 'Microphone permission was not given.' : 'Could not open the microphone.';
      return;
    }
    // Start downloading the model while the person speaks.
    let progress = 0;
    const model = getAsr((p) => { progress = p; }).catch(() => null);
    const ctx = new Ctx(); await ctx.resume();
    const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), mute = ctx.createGain();
    mute.gain.value = 0;
    const chunks = [];
    let level = 0, done = false, spoke = false, quietSince = 0;
    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0); chunks.push(new Float32Array(x));
      let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
      level = m;
    };
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    st.run = { cancel() { done = true; } };
    $('sStart').hidden = true; $('sNone').hidden = true; $('sStop').hidden = false; $('sMeter').hidden = false;
    $('sStatus').textContent = 'Say the sentence now.';
    cue(null);
    const t0 = performance.now();
    // Stop by itself after 3 s of quiet following speech (halting speakers pause), or after 20 s.
    while (!done && performance.now() - t0 < 20000) {
      await wait(100);
      const db = 20 * Math.log10(level + 1e-6);
      $('sLevel').style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`;
      $('sMeterText').textContent = db > -35 ? 'Hearing you…' : spoke ? 'Listening… (stops after a short silence)' : 'Listening… speak now';
      if (db > -35) { spoke = true; quietSince = performance.now(); }
      else if (spoke && performance.now() - quietSince > 3000) break;
    }
    proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop());
    const rate = ctx.sampleRate; ctx.close();
    $('sStop').hidden = true; $('sMeter').hidden = true;
    const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0; for (const c of chunks) { all.set(c, at); at += c.length; }
    const timing = Stroke.speechTiming(all, rate);

    let heard = null;
    if (timing.voiced) {
      const tick = setInterval(() => { $('sStatus').textContent = progress && progress < 1 ? `Downloading the speech model… ${Math.round(progress * 100)}%` : 'Checking the words…'; }, 200);
      const asr = await model;
      if (asr) {
        // Only the stretch with speech, plus a little either side.
        const from = Math.max(0, Math.floor((timing.startS - 0.3) * rate)), to = Math.min(all.length, Math.ceil((timing.startS + timing.durationS + 0.4) * rate));
        try { heard = (await asr(to16k(all.subarray(from, to), rate))).text.trim(); } catch { heard = null; }
      }
      clearInterval(tick);
    }
    st.run = null;
    $('sStart').hidden = false; $('sNone').hidden = false; $('sStatus').textContent = '';
    showSpeech(Stroke.speechCheck({ timing, heard }), heard);
  }

  function showSpeech(r, heard) {
    $('sStart').textContent = 'Check speech again';
    if (r.verdict !== 'ok') {
      setResult('s', 'unclear', 'Try again', r.problem); $('sHeard').textContent = '';
      setChip('sChip', 'warn', 'Try again');
      return;
    }
    // A low word score alone may just be an accent: ask once more before counting it.
    const onlyWords = r.sign && r.reasons.length === 1 && r.match && r.match.share < Stroke.MIN_WORDS;
    if (onlyWords && !st.speechRetried) {
      st.speechRetried = true;
      setResult('s', 'unclear', 'Please say it once more', `The phone did not catch all the words (${r.match.matched} of ${r.match.total}). Speak clearly towards the phone. If it happens again, it will count as a sign.`);
      $('sHeard').textContent = heard ? `Heard: “${heard}”` : '';
      setChip('sChip', 'warn', 'Once more');
      return;
    }
    st.speech = r;
    setResult('s', r.sign ? 'flat' : 'clear',
      r.sign ? 'Sign found: speech was unclear or slow' : 'Normal: speech was clear',
      r.sign ? `${cap(r.reasons.join('; '))}. Slurred, slow or wrong words can be a stroke sign.`
        : `${r.match ? `All ${r.match.total} words` : 'The sentence'} came out in ${r.durationS.toFixed(1)} s without long stops.`);
    $('sHeard').textContent = heard != null ? `Heard: “${heard}”` : 'The speech model could not run here, so only the timing was checked.';
    setChip('sChip', r.sign ? 'bad' : 'good', r.sign ? 'Sign found' : 'Normal');
    stOverall();
  }

  $('fStart').addEventListener('click', faceStart);
  $('fStop').addEventListener('click', () => st.run && st.run.cancel());
  $('aLeft').addEventListener('click', () => armStart('left'));
  $('aRight').addEventListener('click', () => armStart('right'));
  $('sStart').addEventListener('click', speechStart);
  $('sStop').addEventListener('click', () => st.run && st.run.cancel());
  $('sNone').addEventListener('click', () => {
    if (st.run) return;
    st.speech = { verdict: 'ok', sign: true, none: true, reasons: ['could not speak'] };
    setResult('s', 'flat', 'Sign found: could not speak', 'Being unable to speak, or to understand, is a stroke sign.');
    $('sHeard').textContent = '';
    setChip('sChip', 'bad', 'Sign found');
    stOverall();
  });
  $('stReset').addEventListener('click', () => {
    Object.assign(st, { face: null, arms: { left: null, right: null }, speech: null, speechRetried: false });
    for (const id of ['fResult', 'aLeftResult', 'aRightResult', 'aResult', 'sResult']) $(id).hidden = true;
    for (const id of ['fChip', 'aChip', 'sChip']) setChip(id, 'none', 'Not done');
    $('sStart').textContent = 'Start speech check'; $('aStatus').textContent = '';
    stOverall();
    $('strokeUi').scrollIntoView({ behavior: 'smooth' });
  });
  stOverall();

  // =====================================================================
  // Sleep (sonar)
  // =====================================================================
  const SL_KEY = 'jf.sleep.nights';
  const sl = { run: null, last: null };

  function slFmt(seconds) {
    const m = Math.floor(seconds / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m ${Math.floor(seconds % 60)} s`;
  }

  function slRender() {
    const list = load(SL_KEY), body = $('slHistory').querySelector('tbody');
    body.innerHTML = '';
    for (const n of list.slice(0, 20)) {
      const row = document.createElement('tr');
      for (const [text, cls] of [[new Date(n.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })], [slFmt(n.tracked), 'num'],
        [n.rate == null ? '--' : `${n.rate}/min`, 'num'], [n.perHour == null ? '--' : n.perHour.toFixed(1), 'num']]) {
        const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; row.append(td);
      }
      const td = document.createElement('td'), chip = document.createElement('span'), lv = slLevel(n.perHour);
      chip.className = chipOf[lv.chip]; chip.textContent = lv.short; td.append(chip); row.append(td);
      body.append(row);
    }
    $('slHistory').hidden = !list.length; $('slNoHistory').hidden = !!list.length; $('slClear').hidden = !list.length;
  }

  // Sleep-study severity bands for the apnea-hypopnea index (5 / 15 / 30 per
  // hour), used here only as a rough guide: this count is not an AHI.
  function slLevel(perHour) {
    if (perHour == null) return { chip: 'none', short: 'Too short', box: '' };
    if (perHour < 5) return { chip: 'good', short: 'Few pauses', box: 'clear' };
    if (perHour < 15) return { chip: 'warn', short: 'Some pauses', box: 'unclear' };
    return { chip: 'bad', short: 'Many pauses', box: 'flat' };
  }

  async function slStart(demo) {
    setNotice($('slNotice'), '');
    $('slVerdict').hidden = true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !navigator.mediaDevices) { setNotice($('slNotice'), 'This browser cannot play and record sound here. Use Chrome on Android.'); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      setNotice($('slNotice'), e && e.name === 'NotAllowedError' ? 'Microphone permission was not given.' : 'Could not open the microphone.');
      return;
    }
    const ctx = new Ctx({ sampleRate: 48000 });
    if (ctx.sampleRate < 44100) { stream.getTracks().forEach((t) => t.stop()); ctx.close(); setNotice($('slNotice'), 'This device records at too low a sample rate for sonar.'); return; }
    await ctx.resume();
    const out = ctx.createGain(); out.gain.value = 0.14; out.connect(ctx.destination);
    const oscs = Sonar.TONES.filter((f) => f < ctx.sampleRate / 2 - 500).map((f) => { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(out); o.start(); return o; });
    const demod = Sonar.createDemod(ctx.sampleRate, oscs.map((o) => o.frequency.value));
    const night = Sonar.createNight();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain(); mute.gain.value = 0;
    proc.onaudioprocess = (e) => demod.push(e.inputBuffer.getChannelData(0));
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);

    let tracked = 0, last = null, cancelled = false;
    const startedAt = new Date();
    sl.run = { cancel() { cancelled = true; } };
    $('slActions').hidden = true; $('slRunActions').hidden = false; $('slResultActions').hidden = true;
    $('slRate').textContent = '--'; $('slPauses').textContent = '0'; $('slPerHour').textContent = '--'; $('slTime').textContent = '0 m';
    keepAwake(true);

    const prompt = $('slPrompt');
    const demoScript = demo ? [[0, 'Sit or lie still, phone close to your chest. Breathe normally.'], [45, 'Now hold your breath…'], [60, 'Breathe normally again.']] : [];
    while (!cancelled) {
      await wait(demo ? 2500 : 5000);
      const secs = demod.seconds;
      if (demo) {
        const step = demoScript.filter(([t]) => secs >= t).pop();
        prompt.hidden = false; prompt.textContent = step[1];
        if (step[0] === 45 && !sl.saidHold) { sl.saidHold = true; cue('Hold your breath now.'); }
        if (step[0] === 60 && !sl.saidGo) { sl.saidGo = true; cue('Breathe again.'); }
        if (secs >= 90) break;
      }
      const r = Sonar.analyze(demod);
      $('slTime').textContent = slFmt(tracked);
      if (r.verdict === 'wait') { $('slStatus').textContent = `Listening… ${Math.ceil(Sonar.MIN_S - secs)} s until the first reading`; continue; }
      if (r.verdict === 'retake') { setNotice($('slNotice'), r.problem); if (secs > 40) break; continue; }
      setNotice($('slNotice'), r.verdict === 'unclear' ? r.problem : '');
      if (r.verdict === 'ok') tracked += demo ? 2.5 : 5;
      night.update(r);
      last = r;
      $('slRate').textContent = r.ratePerMin == null ? '--' : Math.round(r.ratePerMin);
      $('slPauses').textContent = String(night.events.length);
      const ph = night.perHour(tracked);
      $('slPerHour').textContent = ph == null ? '--' : ph.toFixed(1);
      $('slStatus').textContent = r.verdict === 'ok' ? 'Tracking breathing.' : 'Looking for breathing…';
      // Shade pauses on the trace.
      const marks = night.events.concat(r.pauses).map((p) => [(p.from - r.waveStart) * Sonar.BB_RATE, (p.to - r.waveStart) * Sonar.BB_RATE]);
      plot($('slTrace'), Array.from(r.wave), { color: css('--trace'), marks });
      $('slMeta').innerHTML = '';
      for (const t of [`Started ${startedAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`, `Best tone ${(r.toneHz / 1000).toFixed(1)} kHz`, `${r.tonesHeard}/${oscs.length} tones heard`, `Signal ${Math.round(r.snr)}× noise`]) {
        const s = document.createElement('span'); s.textContent = t; $('slMeta').append(s);
      }
    }
    oscs.forEach((o) => o.stop()); proc.disconnect(); src.disconnect(); stream.getTracks().forEach((t) => t.stop()); ctx.close();
    keepAwake(false); sl.run = null; sl.saidHold = sl.saidGo = false;
    $('slDim').hidden = true; prompt.hidden = true; $('slRunActions').hidden = true;

    const perHour = night.perHour(tracked);
    const rates = night.minutes.map((m) => m.rate).filter((v) => v != null);
    const rate = rates.length ? Math.round(rates.sort((a, b) => a - b)[rates.length >> 1]) : null;
    sl.last = { at: startedAt.toISOString(), tracked: Math.round(tracked), pauses: night.events.length, perHour: perHour == null ? null : Math.round(perHour * 10) / 10, rate, method: 'sonar-breathing-v1' };
    const box = $('slVerdict'); box.hidden = false;
    if (demo) {
      const n = night.events.length;
      box.className = `verdict ${n ? 'clear' : 'unclear'}`;
      $('slHead').textContent = n ? `Found ${n} breathing pause${n > 1 ? 's' : ''}` : 'No pause found';
      $('slText').textContent = n
        ? `The sonar saw your chest stop moving${night.events[0] ? ` from ${Math.round(night.events[0].from)} to ${Math.round(night.events[0].to)} seconds` : ''}. This is how it counts pauses during the night.`
        : (last && last.verdict === 'ok' ? 'It saw your breathing but no pause of 10 seconds or more. Hold your breath a little longer, and keep still while you do.' : 'It could not see your breathing clearly. Move the phone closer to your chest, speaker towards you.');
      $('slActions').hidden = false;
      return;
    }
    const lv = slLevel(perHour);
    box.className = `verdict ${lv.box}`;
    if (perHour == null) {
      $('slHead').textContent = 'Too short to judge';
      $('slText').textContent = `Breathing was tracked for ${slFmt(tracked)}. Track at least 10 minutes; a whole night gives the most useful count.`;
    } else {
      $('slHead').textContent = `${lv.short}: ${perHour.toFixed(1)} per hour`;
      $('slText').textContent = perHour < 5
        ? 'Fewer than 5 pauses an hour. Sleep studies count fewer than 5 breathing events an hour as normal.'
        : perHour < 15
          ? 'Between 5 and 15 pauses an hour. If you snore, wake up tired, or someone has seen you stop breathing, ask a doctor about a sleep study.'
          : 'More than 15 pauses an hour. Please ask a doctor about a sleep study, especially if you snore loudly or feel sleepy during the day.';
    }
    $('slResultActions').hidden = false;
    $('slSave').disabled = false; $('slSave').textContent = 'Save night';
  }

  $('slNight').addEventListener('click', () => slStart(false));
  $('slDemo').addEventListener('click', () => slStart(true));
  $('slStop').addEventListener('click', () => sl.run && sl.run.cancel());
  $('slDimBtn').addEventListener('click', () => { $('slDim').hidden = false; });
  $('slDim').addEventListener('click', () => { $('slDim').hidden = true; });
  $('slAgain').addEventListener('click', () => { $('slResultActions').hidden = true; $('slActions').hidden = false; $('slVerdict').hidden = true; });
  $('slSave').addEventListener('click', () => {
    if (!sl.last) return;
    const list = load(SL_KEY); list.unshift(sl.last);
    if (store(SL_KEY, list.slice(0, 60))) { $('slSave').disabled = true; $('slSave').textContent = 'Saved'; sl.last = null; slRender(); }
    else setNotice($('slNotice'), 'This browser is not keeping data for this page (for example, a private window), so the night was not saved.');
  });
  $('slClear').addEventListener('click', () => { if (confirm('Delete every night saved in this browser?')) { store(SL_KEY, []); slRender(); } });

  // =====================================================================
  window.Features = {
    busy: () => !!(tr.run || st.run || sl.run),
    show(mode) {
      $('tremorUi').hidden = mode !== 'tremor';
      $('strokeUi').hidden = mode !== 'stroke';
      $('sleepUi').hidden = mode !== 'sleep';
      if (mode === 'tremor') plot($('trTrace'), []);
      if (mode === 'sleep') plot($('slTrace'), []);
    },
  };
  trRender();
  slRender();
})();
