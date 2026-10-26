# JeevaFlow Pulse Check

Measures heart rate, heart-rate variability and a rough breathing rate from a fingertip held over a phone's camera
(camera photoplethysmography, PPG), or heart rate from the face with the selfie camera, without touching anything.
Part of the JeevaFlow Sentinel project.

**Fingertip + flash.** Open the page on a phone, then either:

- **Measure live:** cover the rear camera and flash with your fingertip for 30 seconds. The page switches the flash
  on where the browser allows it (Chrome on Android, Safari on recent iPhones).
- **Analyse a video:** record about 35 seconds with your camera app's flash on and your fingertip over the lens, then
  choose that video.

**Face (no touch).** Switch to the Face tab, face a window or lamp, keep your face in the oval and stay still for
30 seconds (or analyse a 35-second selfie video). Face readings give heart rate only.

**Stress.** From fingertip HRV, compared with your own usual once 3 fingertip readings are saved: "higher", "usual"
or "lower" than usual. HRV differs too much between people for a fixed threshold.

**Ear echo.** Print the paper cone from the page, tape it over the phone's speaker and microphone, rest the tip at
the opening of the ear (never push it in) and play 5 seconds of soft chirps. The page shows the echo curve and its
deepest dip, and highlights a provisional result: **Looks normal** (dip ≥ 5 dB, green), **Unclear** (amber) or
**Flat echo: possible fluid** (dip < 2.5 dB, red), and points out an ear much flatter than the other. These cut-offs
have **not** been calibrated against doctor-checked ears, so the result is a screening hint, not a diagnosis. The paper
cone is required: without it the curve comes out flat. Works best in Chrome on Android.

**Heart rhythm (AFib).** Every fingertip reading also checks the rhythm (`Ppg.rhythm`): **Regular**, **A few early
beats**, **Unclear** or **Irregular: possible atrial fibrillation**. Each beat must match the shape of a typical beat
(template matching), so finger movement asks for a retake instead of looking irregular; breathing-linked speeding up and
slowing down (sinus arrhythmia) is recognised as a regular, repeating pattern. Cut-offs are provisional, not checked
against ECGs; only an ECG can confirm AFib.

**Tremor.** Hold the phone for 20 seconds, resting or with the arm out. The motion sensor gives the shake speed
(per second), strength (m/s²) and size (mm), with a provisional None / Mild / Strong result (`motion.js`).

**Stroke check (FAST).** Face: the selfie camera and MediaPipe face landmarks (run on the phone) compare how much each
mouth corner lifts in a smile. Arms: the phone, flat on the palm with eyes closed, measures how far each arm tilts in 10
seconds. Speech: the person says "You can't teach an old dog new tricks"; Whisper tiny (run in the browser with
transformers.js, about 40 MB, cached) writes down what it heard, which is compared word by word with the sentence, and the
recording's length and longest pause show slow or halting speech. Each step shows its own result, then an overall one:
**Possible stroke: N of 3 signs found, call 108 now**, or **No stroke signs found** (which never rules out a stroke).

**Sleep.** The phone plays 18–20 kHz tones and tracks the echo from the chest (`sonar.js`, after ApneaApp, MobiSys
2015) to show breathing rate and count pauses of 10 seconds or more, per hour of tracking. Not a sleep study. "Try it
awake" runs a 90-second demo: breathe, hold your breath for 15 seconds, and watch it find the pause.

**Heart sounds (Dhadkan): heart murmur check, test version.** Press the phone's bottom edge (microphone) on bare skin
at one of the four spots a doctor listens at (aortic, pulmonary, tricuspid, mitral) and record 20 seconds. `heart.js`
finds the heart rate, labels every "lub" (S1) and "dub" (S2) by dynamic programming on the loudness envelope (lub to
dub is the shorter, steady gap), then measures the sound in the gaps in four pitch bands against the lub, dub and
diastole. A logistic-regression model turns that into a murmur score: no murmur / unclear / possible murmur. The
results from several spots are combined (the most murmur-like spot decides).

The model was fitted on the [CirCor DigiScope dataset](https://physionet.org/content/circor-heart-sound/1.0.3/)
(PhysioNet 2022, ODC-By 1.0; 942 children, digital stethoscope, cardiologist labels). On patients it never saw
(5-fold, split by patient): one recording AUC 0.885, 73% of murmurs caught (93% of grade III/VI) and 95% of normal
recordings cleared at the 50% cut-off; per child with all spots, 78% sensitivity and 87% specificity. Lub/dub timing
F1 is about 0.82 against the dataset's annotations. **It has not been tested with phone microphones**, so phone
accuracy is unknown. Playback raises the person's real recording by 200 Hz (single-sideband shift) so phone speakers
can play it; two real CirCor recordings (normal, grade III/VI murmur) are included as samples in `sounds/`.

All new cut-offs are provisional, and nothing is uploaded: sound, video and motion are processed on the phone.

## How it works

Each heartbeat pushes blood into the fingertip, which absorbs a little more light, so the camera image gets slightly
darker once per beat. The page averages the red colour of each frame and processes that series in `ppg.js`:

1. resample to a steady 30 Hz
2. zero-phase band-pass filter, 0.7–3.5 Hz (42–210 bpm)
3. heart rate two ways: beat-to-beat peak detection, and a harmonic-summation spectrum
4. HRV (RMSSD, SDNN) from clean beat intervals; breathing from the slow baseline wobble
5. a quality check: if the two heart-rate methods disagree, or the signal is noisy, no number is shown

For the face, the page averages the colour of skin-coloured pixels inside the oval and uses the POS method (Wang
et al., IEEE TBME 2017) to cancel lighting changes common to all colour channels, leaving the pulse.

For the ear (`ear.js`), the page plays ten 150 ms chirps (1.8–4.4 kHz), finds each one in the recording by
cross-correlation, divides the recorded spectrum by the played one, and averages the chirps. A healthy eardrum absorbs
part of the sound and leaves a dip; fluid tends to flatten it (Chan et al., Science Translational Medicine, 2019).
Too few chirps heard, a noisy room, clipping or chirps that disagree (a moving cone) give no curve.

## Not measured: blood oxygen, anaemia, newborn jaundice

Phones can screen for these in research (UW's oximetry study, HemaApp and BiliCam), but each needs a model calibrated
against blood tests on real people. Without that, the page shows no number and explains why, instead of inventing one.

## Privacy

Everything runs in the browser. Video is never uploaded or saved. Saved readings stay in that browser's local
storage and can be deleted on the page.

## Tests

```bash
node --test ppg.test.js ear.test.js motion.test.js stroke.test.js sonar.test.js heart.test.js
```

Synthetic pulses at 50–130 bpm are measured within ±2 bpm; noise, motion, an uncovered camera and short recordings
are rejected. Synthetic face recordings at 58–104 bpm are measured within ±3 bpm through lighting changes ten times
stronger than the pulse; heavy noise gives no reading rather than a wrong one.

## Limits

A screening estimate, not a medical device or a diagnosis. It has not yet been validated against a pulse oximeter
on real people. Movement, pressing hard, cold fingers or an uncovered flash spoil the signal.
