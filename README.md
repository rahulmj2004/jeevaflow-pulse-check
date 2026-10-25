# JeevaFlow Pulse Check

Measures heart rate, heart-rate variability and a rough breathing rate from a fingertip held over a phone's camera
(camera photoplethysmography, PPG). Part of the JeevaFlow Sentinel project.

**Open the page on a phone, then either:**

- **Measure live:** cover the rear camera and flash with your fingertip for 30 seconds. The page switches the flash
  on where the browser allows it (Chrome on Android, Safari on recent iPhones).
- **Analyse a video:** record about 35 seconds with your camera app's flash on and your fingertip over the lens, then
  choose that video.

## How it works

Each heartbeat pushes blood into the fingertip, which absorbs a little more light, so the camera image gets slightly
darker once per beat. The page averages the red colour of each frame and processes that series in `ppg.js`:

1. resample to a steady 30 Hz
2. zero-phase band-pass filter, 0.7–3.5 Hz (42–210 bpm)
3. heart rate two ways: beat-to-beat peak detection, and a harmonic-summation spectrum
4. HRV (RMSSD, SDNN) from clean beat intervals; breathing from the slow baseline wobble
5. a quality check: if the two heart-rate methods disagree, or the signal is noisy, no number is shown

## Privacy

Everything runs in the browser. Video is never uploaded or saved. Saved readings stay in that browser's local
storage and can be deleted on the page.

## Tests

```bash
node --test ppg.test.js
```

Synthetic pulses at 50–130 bpm are measured within ±2 bpm; noise, motion, an uncovered camera and short recordings
are rejected.

## Limits

A screening estimate, not a medical device or a diagnosis. It has not yet been validated against a pulse oximeter
on real people. Movement, pressing hard, cold fingers or an uncovered flash spoil the signal.
