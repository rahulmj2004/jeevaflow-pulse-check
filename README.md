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
deepest dip, and can compare left and right ears or the same ear over time. It does **not** say whether there is fluid
behind the eardrum: that needs a threshold learned from doctor-checked ears. Works best in Chrome on Android.

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
node --test ppg.test.js ear.test.js
```

Synthetic pulses at 50–130 bpm are measured within ±2 bpm; noise, motion, an uncovered camera and short recordings
are rejected. Synthetic face recordings at 58–104 bpm are measured within ±3 bpm through lighting changes ten times
stronger than the pulse; heavy noise gives no reading rather than a wrong one.

## Limits

A screening estimate, not a medical device or a diagnosis. It has not yet been validated against a pulse oximeter
on real people. Movement, pressing hard, cold fingers or an uncovered flash spoil the signal.
