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
  let landmarker = null;

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

  function stSummary() {
    const signs = [];
    if (st.face && st.face.sign) signs.push(`the ${st.face.weaker} side of the mouth lifted less`);
    const { left, right } = st.arms;
    let armSign = null;
    if (left && right) { const c = Motion.compareArms(left, right); if (c.sign) armSign = c.weaker; }
    else if ((left && left.drifted) || (right && right.drifted)) armSign = left && left.drifted ? 'left' : 'right';
    if (armSign) signs.push(`the ${armSign} arm drifted`);
    if (st.speech && st.speech !== 'normal') signs.push(st.speech === 'none' ? 'could not speak' : 'speech was slurred or wrong');
    const done = st.face && left && right && st.speech;
    const box = $('stSummary');
    if (signs.length) {
      box.hidden = false; box.className = 'verdict flat';
      $('stSummaryHead').textContent = 'Possible stroke sign: call 108 now';
      $('stSummaryText').textContent = `Found: ${signs.join('; ')}. Call 108 and tell them the time the symptoms started (now ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}). Do not give food, drink or medicine.`;
    } else if (done) {
      box.hidden = false; box.className = 'verdict unclear';
      $('stSummaryHead').textContent = 'No signs found in these checks';
      $('stSummaryText').textContent = 'This does not rule out a stroke. If symptoms started suddenly (numbness, confusion, trouble seeing or walking, a sudden severe headache), call 108 anyway.';
    } else box.hidden = true;
  }

  // ---- F: face ----
  async function faceStart() {
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
      $('fStatus').textContent = e && e.name === 'NotAllowedError' ? 'Camera permission was not given.' : 'Could not start the face check on this browser.';
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
    $('fStatus').textContent = 'Hold the phone at arm\'s length, face in good light.';
    await wait(800);
    const rest = await collect('Relax your face', 2500, 'Relax your face');
    const smile = await collect('Big smile! Show your teeth', 3000, 'Now a big smile, show your teeth');
    finish();
    if (cancelled) { $('fStatus').textContent = 'Stopped.'; return; }
    const r = Stroke.droop(rest, smile);
    if (r.verdict !== 'ok') { $('fStatus').textContent = r.problem; return; }
    st.face = r;
    $('fStatus').textContent = '';
    $('fResult').hidden = false;
    $('fResult').className = `verdict ${r.sign ? 'flat' : 'clear'}`;
    $('fHead').textContent = r.sign ? `The ${r.weaker} side lifted much less` : 'Both sides lifted evenly';
    $('fText').textContent = `Mouth corner lift, right ${Math.round(r.liftRight * 100) || 0} and left ${Math.round(r.liftLeft * 100) || 0} (hundredths of the eye distance). The weaker side lifted ${Math.round(r.ratio * 100)}% as much as the other.`;
    $('fChip').className = r.sign ? 'chip bad' : 'chip good'; $('fChip').textContent = r.sign ? 'Sign found' : 'Even';
    stSummary();
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

  // ---- A: arms ----
  async function armStart(side) {
    if (st.run) return;
    const samples = [];
    let stopFn;
    try { stopFn = await motionStream((s) => samples.push(s), { gravity: true }); } catch (e) { $('aStatus').textContent = e.message; return; }
    let cancelled = false;
    st.run = { cancel() { cancelled = true; } };
    $('aLeft').disabled = $('aRight').disabled = true;
    keepAwake(true);
    const prompt = $('aPrompt'); prompt.hidden = false;
    for (let k = 4; k > 0 && !cancelled; k--) {
      prompt.textContent = `${side === 'left' ? 'Left' : 'Right'} arm straight out, phone flat on the palm… ${k}`;
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
    if (r.verdict !== 'ok') { $('aStatus').textContent = r.problem; return; }
    st.arms[side] = r;
    $('aStatus').textContent = '';
    const { left, right } = st.arms;
    $('aResults').textContent = [left && `Left arm tilted ${left.driftDeg.toFixed(1)}°`, right && `Right arm tilted ${right.driftDeg.toFixed(1)}°`].filter(Boolean).join(' · ');
    const box = $('aResult');
    if (left && right) {
      const c = Motion.compareArms(left, right);
      box.hidden = false; box.className = `verdict ${c.sign ? 'flat' : 'clear'}`;
      $('aHead').textContent = c.sign ? `The ${c.weaker} arm drifted` : 'Both arms stayed steady';
      $('aText').textContent = c.sign
        ? `A weak arm slowly sinks or turns with the eyes closed. The difference between the arms was ${c.gapDeg.toFixed(1)}°.`
        : `Both arms tilted less than ${Motion.DRIFT_DEG}° and within ${Motion.DRIFT_GAP_DEG}° of each other.`;
      $('aChip').className = c.sign ? 'chip bad' : 'chip good'; $('aChip').textContent = c.sign ? 'Sign found' : 'Steady';
    } else {
      $('aStatus').textContent = `Now do the ${left ? 'right' : 'left'} arm.`;
      $('aChip').className = 'chip warn'; $('aChip').textContent = 'One arm done';
    }
    stSummary();
  }

  // ---- S: speech (judged by the person helping) ----
  function speech(answer) {
    st.speech = answer;
    for (const id of ['sNormal', 'sSlurred', 'sNone']) $(id).hidden = !!answer;
    $('sReset').hidden = !answer;
    $('sChip').className = !answer ? 'chip' : answer === 'normal' ? 'chip good' : 'chip bad';
    $('sChip').textContent = !answer ? 'Not done' : answer === 'normal' ? 'Clear' : answer === 'none' ? 'Could not speak' : 'Slurred';
    stSummary();
  }

  $('fStart').addEventListener('click', faceStart);
  $('fStop').addEventListener('click', () => st.run && st.run.cancel());
  $('aLeft').addEventListener('click', () => armStart('left'));
  $('aRight').addEventListener('click', () => armStart('right'));
  $('sNormal').addEventListener('click', () => speech('normal'));
  $('sSlurred').addEventListener('click', () => speech('slurred'));
  $('sNone').addEventListener('click', () => speech('none'));
  $('sReset').addEventListener('click', () => speech(null));

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
