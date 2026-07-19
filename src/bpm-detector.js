// bpm-detector.js — pure DSP tempo estimator. No DOM, no WebAudio, no imports.
//
// Pipeline:
//   1. 3x cascaded one-pole low-pass (~140 Hz) isolates the kick band so an
//      instructor's voice (300 Hz - 3 kHz) barely affects the onset envelope.
//   2. Energy per hop (~5 ms) -> half-wave-rectified flux = onset envelope.
//   3. Rolling ~8 s onset window, triangular-smoothed (~25 ms) so each beat
//      peak spans several lag bins (an unsmoothed 1-frame-wide flux spike
//      splits across two bins whenever the true beat lag falls near a
//      half-integer frame count, gutting the fundamental peak's apparent
//      height in a sample-rate-dependent way). Normalized autocorrelation
//      over lags for 60-200 BPM, parabolic peak interpolation for sub-frame
//      precision.
//   4. Octave disambiguation: anchor on the strongest autocorrelation peak,
//      then resolve T vs T/2 vs 2T explicitly by comparing combined
//      autocorrelation support along each candidate's harmonic series (odd
//      vs even multiples of the half period). Range preference 70-180 BPM
//      corrects out-of-range picks via their half/double partner peaks.
//   5. Median smoothing over ~7 s of raw candidates plus ~2 s hysteresis
//      before the displayed bpm changes; `locked` after ~2 s of stability.

const LP_CUTOFF_HZ = 140;
const ENV_RATE_TARGET_HZ = 200;
const WINDOW_SECONDS = 8;
const MIN_ANALYSIS_SECONDS = 3;
const ANALYSIS_INTERVAL_SECONDS = 0.25;
const MIN_BPM = 60;
const MAX_BPM = 200;
const PREF_MIN_BPM = 70;
const PREF_MAX_BPM = 180;
const HALF_PEAK_RATIO = 0.5; // half-lag peak worth considering as 2x tempo
const PARTNER_PEAK_RATIO = 0.6; // octave partner must be at least this * max
// Prefer the double tempo only when its odd harmonics carry at least this
// fraction of the even harmonics' autocorrelation support. Offbeats at ~0.6x
// amplitude (0.36x energy) fall well below this; a genuine double-time kick
// train sits near 1.0.
const HARMONIC_SUPPORT_RATIO = 0.72;
const HISTORY_SECONDS = 7;
const STABLE_TOLERANCE_BPM = 3;
const SWITCH_DELAY_SECONDS = 2.0;
const LOCK_SECONDS = 2.0;
const MIN_CANDIDATE_CONFIDENCE = 0.35;

function median(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export class BpmDetector {
  constructor({ sampleRate }) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('BpmDetector requires a positive sampleRate');
    }
    this.sampleRate = sampleRate;
    this.hopSize = Math.max(1, Math.round(sampleRate / ENV_RATE_TARGET_HZ));
    this.envRate = sampleRate / this.hopSize;
    this.lpAlpha = 1 - Math.exp((-2 * Math.PI * LP_CUTOFF_HZ) / sampleRate);
    this.windowFrames = Math.round(this.envRate * WINDOW_SECONDS);
    this.minLag = Math.max(2, Math.floor((this.envRate * 60) / MAX_BPM));
    this.maxLag = Math.ceil((this.envRate * 60) / MIN_BPM);
    this.minAnalysisFrames = Math.round(this.envRate * MIN_ANALYSIS_SECONDS);
    this.analysisIntervalFrames = Math.max(
      1,
      Math.round(this.envRate * ANALYSIS_INTERVAL_SECONDS),
    );
    this.reset();
  }

  reset() {
    // Filter + framing state
    this.lp1 = 0;
    this.lp2 = 0;
    this.lp3 = 0;
    this.hopAccum = 0;
    this.hopFill = 0;
    this.prevEnergy = 0;
    // Onset envelope ring buffer
    this.onset = new Float32Array(this.windowFrames);
    this.onsetLen = 0;
    this.onsetPos = 0;
    this.totalFrames = 0;
    this.framesSinceAnalysis = 0;
    // Estimation state
    this.history = []; // { t, bpm } accepted raw candidates
    this.displayBpm = null;
    this.rawBpm = null;
    this.confidence = 0;
    this.stableSince = null;
    this.divergeSince = null;
    this.locked = false;
  }

  process(samples) {
    const a = this.lpAlpha;
    let lp1 = this.lp1;
    let lp2 = this.lp2;
    let lp3 = this.lp3;
    let accum = this.hopAccum;
    let fill = this.hopFill;
    const hop = this.hopSize;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      lp1 += a * (x - lp1);
      lp2 += a * (lp1 - lp2);
      lp3 += a * (lp2 - lp3);
      accum += lp3 * lp3;
      if (++fill >= hop) {
        // Commit filter state before frame handling (analysis reads no filter
        // state, but keep the object coherent).
        this.lp1 = lp1;
        this.lp2 = lp2;
        this.lp3 = lp3;
        this._pushFrame(accum / hop);
        accum = 0;
        fill = 0;
      }
    }
    this.lp1 = lp1;
    this.lp2 = lp2;
    this.lp3 = lp3;
    this.hopAccum = accum;
    this.hopFill = fill;
  }

  getEstimate() {
    const bpm = this.displayBpm;
    return {
      bpm,
      rawBpm: this.rawBpm,
      confidence: this.confidence,
      alternates:
        bpm === null
          ? { half: null, double: null }
          : { half: bpm / 2, double: bpm * 2 },
      locked: this.locked,
    };
  }

  // ---- internals ----------------------------------------------------------

  _pushFrame(energy) {
    const flux = Math.max(0, energy - this.prevEnergy);
    this.prevEnergy = energy;
    this.onset[this.onsetPos] = flux;
    this.onsetPos = (this.onsetPos + 1) % this.windowFrames;
    if (this.onsetLen < this.windowFrames) this.onsetLen++;
    this.totalFrames++;
    if (
      this.onsetLen >= this.minAnalysisFrames &&
      ++this.framesSinceAnalysis >= this.analysisIntervalFrames
    ) {
      this.framesSinceAnalysis = 0;
      this._analyze();
    }
  }

  _linearOnsetWindow() {
    const n = this.onsetLen;
    const x = new Float32Array(n);
    const start =
      this.onsetLen < this.windowFrames
        ? 0
        : this.onsetPos; // oldest frame when the ring is full
    for (let i = 0; i < n; i++) {
      x[i] = this.onset[(start + i) % this.windowFrames];
    }
    return x;
  }

  _analyze() {
    const x = this._linearOnsetWindow();
    const n = x.length;
    // Triangular smoothing ([1,2,3,2,1]/9, ~25 ms at 200 Hz env rate) so a
    // beat's flux spike spans several frames. Without it, a beat lag near a
    // half-integer frame count splits its autocorrelation peak across two
    // bins at roughly half height, and octave selection then latches onto a
    // harmonic whose lag happens to land near an integer.
    if (n >= 5) {
      const sm = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 3 * x[i];
        let w = 3;
        if (i >= 1) { acc += 2 * x[i - 1]; w += 2; }
        if (i >= 2) { acc += x[i - 2]; w += 1; }
        if (i + 1 < n) { acc += 2 * x[i + 1]; w += 2; }
        if (i + 2 < n) { acc += x[i + 2]; w += 1; }
        sm[i] = acc / w;
      }
      x.set(sm);
    }
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    let denom = 0;
    for (let i = 0; i < n; i++) {
      x[i] -= mean;
      denom += x[i] * x[i];
    }
    const now = (this.totalFrames * this.hopSize) / this.sampleRate;
    if (!(denom > 1e-16)) {
      // Near-silence: no periodicity information at all.
      this.rawBpm = null;
      this.confidence = 0;
      this._updateDisplay(now);
      return;
    }
    const maxLag = Math.min(this.maxLag, Math.floor(n / 2));
    const minLag = this.minLag;
    if (maxLag <= minLag + 2) return;
    // Normalized (biased) autocorrelation.
    const r = new Float32Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1 && lag < n; lag++) {
      let s = 0;
      const limit = n - lag;
      for (let i = 0; i < limit; i++) s += x[i] * x[i + lag];
      r[lag] = s / denom;
    }
    // Peak picking with parabolic interpolation.
    const peaks = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      const v = r[lag];
      if (v > 0.02 && v >= r[lag - 1] && v >= r[lag + 1]) {
        let refinedLag = lag;
        let refinedR = v;
        const d = r[lag - 1] - 2 * v + r[lag + 1];
        if (d < 0) {
          const delta = (0.5 * (r[lag - 1] - r[lag + 1])) / d;
          if (Math.abs(delta) <= 1) {
            refinedLag = lag + delta;
            refinedR = v - 0.25 * (r[lag - 1] - r[lag + 1]) * delta;
          }
        }
        peaks.push({ lag: refinedLag, r: refinedR });
        // Skip the immediate neighbor to avoid double-reporting a wide peak.
        lag++;
      }
    }
    if (peaks.length === 0) {
      this.rawBpm = null;
      this.confidence = 0;
      this._updateDisplay(now);
      return;
    }
    let rMax = 0;
    let positiveSum = 0;
    let positiveCount = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (r[lag] > rMax) rMax = r[lag];
      positiveSum += Math.max(0, r[lag]);
      positiveCount++;
    }
    const baseline = positiveSum / positiveCount;

    // Octave disambiguation: anchor on the strongest peak, then resolve
    // competing T vs T/2 (and T vs 2T) candidates by comparing combined
    // autocorrelation support along each candidate's harmonic series. For a
    // true tempo with period T and weak offbeat leakage, support at odd
    // multiples of T/2 is much weaker than at multiples of T; genuine
    // double-time energy shows comparable support at both.
    const cache = new Map();
    let chosen = peaks.reduce((a, b) => (b.r > a.r ? b : a));
    // Descend: adopt the double tempo only when its odd harmonics carry
    // support comparable to its even ones.
    for (let hop = 0; hop < 3; hop++) {
      const half = this._findPeakNear(
        peaks,
        chosen.lag / 2,
        rMax,
        HALF_PEAK_RATIO,
      );
      if (!half || half.lag < this.minLag) break;
      if (!this._preferFast(x, denom, half.lag, cache)) break;
      chosen = half;
    }
    // Ascend: if the chosen peak's own odd-harmonic support is weak relative
    // to its doubles, it is the offbeat of a slower fundamental.
    for (let hop = 0; hop < 3; hop++) {
      if (this._preferFast(x, denom, chosen.lag, cache)) break;
      const dbl = this._findPeakNear(peaks, chosen.lag * 2, rMax);
      if (!dbl) break;
      chosen = dbl;
    }
    let bpm = (60 * this.envRate) / chosen.lag;

    // Range preference 70-180: if the pick fell outside, look for its octave
    // partner peak (double/half lag) and take it when it has real support.
    // The 1 BPM tolerance keeps estimation jitter at exactly 70/180 from
    // flip-flopping across the boundary (raw candidates alternating between
    // e.g. 180 and 90 would never stabilize).
    if (bpm > PREF_MAX_BPM + 1) {
      const partner = this._findPeakNear(peaks, chosen.lag * 2, rMax);
      if (partner) {
        const partnerBpm = (60 * this.envRate) / partner.lag;
        if (partnerBpm >= PREF_MIN_BPM) {
          chosen = partner;
          bpm = partnerBpm;
        }
      }
    } else if (bpm < PREF_MIN_BPM - 1) {
      const partner = this._findPeakNear(peaks, chosen.lag / 2, rMax);
      if (partner) {
        const partnerBpm = (60 * this.envRate) / partner.lag;
        if (partnerBpm <= PREF_MAX_BPM) {
          chosen = partner;
          bpm = partnerBpm;
        }
      }
    }

    // Confidence from peak salience over the autocorrelation baseline.
    const salience = chosen.r - baseline;
    const confidence = Math.max(0, Math.min(1, (salience - 0.08) / 0.45));
    this.rawBpm = bpm;
    this.confidence = confidence;

    if (confidence >= MIN_CANDIDATE_CONFIDENCE) {
      this.history.push({ t: now, bpm });
    }
    while (this.history.length && now - this.history[0].t > HISTORY_SECONDS) {
      this.history.shift();
    }
    this._updateDisplay(now);
  }

  _findPeakNear(peaks, targetLag, rMax, ratio = PARTNER_PEAK_RATIO) {
    const tolerance = Math.max(2, targetLag * 0.06);
    let best = null;
    for (const p of peaks) {
      if (
        Math.abs(p.lag - targetLag) <= tolerance &&
        p.r >= ratio * rMax &&
        (best === null || p.r > best.r)
      ) {
        best = p;
      }
    }
    return best;
  }

  // True when the FAST candidate (beat period = halfLag) is the better tempo
  // reading: its odd harmonics (halfLag, 3*halfLag) must carry combined
  // autocorrelation support comparable to the even ones (2*halfLag,
  // 4*halfLag), which alone would indicate a fundamental of 2*halfLag.
  _preferFast(x, denom, halfLag, cache) {
    const a1 = this._corrAt(x, denom, halfLag, cache);
    const b1 = this._corrAt(x, denom, 2 * halfLag, cache);
    if (a1 === null || b1 === null) return true; // no evidence against fast
    let odd = a1;
    let even = b1;
    const a2 = this._corrAt(x, denom, 3 * halfLag, cache);
    const b2 = this._corrAt(x, denom, 4 * halfLag, cache);
    if (a2 !== null && b2 !== null) {
      // Matched term counts keep the comparison fair.
      odd += a2;
      even += b2;
    }
    if (even <= 0) return true;
    return odd >= HARMONIC_SUPPORT_RATIO * even;
  }

  // Bias-compensated normalized autocorrelation at an arbitrary (possibly
  // fractional) lag, computed on demand and memoized. The n/(n-lag)
  // compensation keeps harmonic comparisons between short and long lags fair.
  // Returns null when the lag leaves too little overlap to be trustworthy.
  _corrAt(x, denom, lag, cache) {
    const n = x.length;
    const f = Math.floor(lag);
    if (f < 1 || f + 1 > Math.floor(n * 0.75)) return null;
    const a = this._corrAtInt(x, denom, f, cache);
    const frac = lag - f;
    if (frac === 0) return a;
    const b = this._corrAtInt(x, denom, f + 1, cache);
    return a + (b - a) * frac;
  }

  _corrAtInt(x, denom, lag, cache) {
    const hit = cache.get(lag);
    if (hit !== undefined) return hit;
    const n = x.length;
    const limit = n - lag;
    let s = 0;
    for (let i = 0; i < limit; i++) s += x[i] * x[i + lag];
    const v = (s / denom) * (n / limit);
    cache.set(lag, v);
    return v;
  }

  _updateDisplay(now) {
    const recent = this.history;
    if (recent.length >= 8 && recent[recent.length - 1].t - recent[0].t >= 2) {
      const med = median(recent.map((h) => h.bpm));
      const last2 = recent.filter((h) => now - h.t <= 2.0);
      const consistentFrac =
        last2.length === 0
          ? 0
          : last2.filter((h) => Math.abs(h.bpm - med) <= STABLE_TOLERANCE_BPM)
              .length / last2.length;
      if (this.displayBpm === null) {
        if (last2.length >= 6 && consistentFrac >= 0.8) {
          this.displayBpm = med;
          this.stableSince = now;
          this.divergeSince = null;
        }
      } else if (Math.abs(med - this.displayBpm) <= STABLE_TOLERANCE_BPM) {
        // Track slow drift while stable; stability clock keeps running.
        this.displayBpm = med;
        this.divergeSince = null;
      } else {
        // Hysteresis: require the new tempo to persist before switching.
        if (this.divergeSince === null) {
          this.divergeSince = now;
        } else if (now - this.divergeSince >= SWITCH_DELAY_SECONDS) {
          this.displayBpm = med;
          this.stableSince = now;
          this.divergeSince = null;
        }
      }
    }
    this.locked =
      this.displayBpm !== null &&
      this.stableSince !== null &&
      now - this.stableSince >= LOCK_SECONDS;
  }
}
