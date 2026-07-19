// synth.js — deterministic synthetic PCM generators for detector tests.

export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Kick-drum track: decaying ~60 Hz sine pulse on every beat, optional
 * offbeat hi-hat-ish (high-passed noise) ticks, optional offbeat KICKS
 * (genuine low-frequency energy between beats — offbeat bassline/floor tom)
 * at `offbeatKick` times the main amplitude.
 */
export function kickTrack(bpm, seconds, sampleRate, opts = {}) {
  const {
    amp = 0.9,
    kickFreq = 60,
    hiHat = false,
    hiHatAmp = 0.25,
    offbeatKick = 0,
    seed = 42,
  } = opts;
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  const period = (60 / bpm) * sampleRate;
  const kickLen = Math.floor(0.12 * sampleRate);
  const decay = 0.05 * sampleRate;
  const addKicks = (phase, a) => {
    for (let b = 0; (b + phase) * period < n; b++) {
      const start = Math.round((b + phase) * period);
      const end = Math.min(n, start + kickLen);
      for (let i = start; i < end; i++) {
        const k = i - start;
        out[i] +=
          a * Math.exp(-k / decay) * Math.sin((2 * Math.PI * kickFreq * k) / sampleRate);
      }
    }
  };
  addKicks(0, amp);
  if (offbeatKick > 0) addKicks(0.5, amp * offbeatKick);
  if (hiHat) {
    const rng = makeRng(seed);
    const tickLen = Math.floor(0.02 * sampleRate);
    const tickDecay = 0.006 * sampleRate;
    for (let b = 0; (b + 0.5) * period < n; b++) {
      const start = Math.round((b + 0.5) * period);
      const end = Math.min(n, start + tickLen);
      let prev = 0;
      for (let i = start; i < end; i++) {
        const k = i - start;
        const white = rng() * 2 - 1;
        const hp = white - prev; // crude first-difference high-pass
        prev = white;
        out[i] += hiHatAmp * Math.exp(-k / tickDecay) * hp;
      }
    }
  }
  return out;
}

/**
 * Speech-like interference: band-limited 300-3000 Hz noise bursts with
 * irregular pauses, imitating an instructor talking over the music.
 */
export function speechNoise(seconds, sampleRate, opts = {}) {
  const { amp = 0.5, seed = 7 } = opts;
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  const rng = makeRng(seed);
  // One-pole coefficients for a crude 300-3000 Hz band-pass.
  const aHp = 1 - Math.exp((-2 * Math.PI * 300) / sampleRate);
  const aLp = 1 - Math.exp((-2 * Math.PI * 3000) / sampleRate);
  let lpLow = 0; // tracks < 300 Hz content (subtracted -> high-pass)
  let lpHigh = 0; // < 3000 Hz smoother (low-pass)
  let i = 0;
  let inBurst = true;
  let remaining = Math.floor((0.12 + rng() * 0.5) * sampleRate);
  while (i < n) {
    const white = rng() * 2 - 1;
    const gated = inBurst ? white : 0;
    lpLow += aHp * (gated - lpLow);
    const highPassed = gated - lpLow;
    lpHigh += aLp * (highPassed - lpHigh);
    out[i] = amp * lpHigh;
    i++;
    if (--remaining <= 0) {
      inBurst = !inBurst;
      remaining = inBurst
        ? Math.floor((0.12 + rng() * 0.5) * sampleRate) // burst 0.12-0.62 s
        : Math.floor((0.08 + rng() * 0.45) * sampleRate); // pause 0.08-0.53 s
    }
  }
  return out;
}

/** Element-wise sum of tracks into a new Float32Array (length = longest). */
export function mix(...tracks) {
  const n = Math.max(...tracks.map((t) => t.length));
  const out = new Float32Array(n);
  for (const t of tracks) {
    for (let i = 0; i < t.length; i++) out[i] += t[i];
  }
  return out;
}

/** All-zero PCM. */
export function silence(seconds, sampleRate) {
  return new Float32Array(Math.floor(seconds * sampleRate));
}
