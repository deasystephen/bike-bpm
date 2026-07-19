import test from 'node:test';
import assert from 'node:assert/strict';
import { BpmDetector } from '../src/bpm-detector.js';
import { kickTrack, speechNoise, mix, silence } from './synth.js';

const CHUNKS = [128, 1024, 1536, 512, 96, 2048];

function feedInChunks(det, samples, chunkSizes = CHUNKS) {
  let i = 0;
  let c = 0;
  while (i < samples.length) {
    const size = Array.isArray(chunkSizes)
      ? chunkSizes[c % chunkSizes.length]
      : chunkSizes;
    const n = Math.min(size, samples.length - i);
    det.process(samples.subarray(i, i + n));
    i += n;
    c++;
  }
}

function detect(samples, sampleRate, chunkSizes = CHUNKS) {
  const det = new BpmDetector({ sampleRate });
  feedInChunks(det, samples, chunkSizes);
  return det.getEstimate();
}

test('detects kick tracks at 90, 128, 174 BPM within ±2 (mixed chunk sizes)', () => {
  for (const bpm of [90, 128, 174]) {
    const est = detect(kickTrack(bpm, 15, 44100, { hiHat: true }), 44100);
    assert.ok(est.bpm !== null, `bpm should not be null for ${bpm} BPM track`);
    assert.ok(
      Math.abs(est.bpm - bpm) <= 2,
      `expected ~${bpm}, got ${est.bpm} (raw ${est.rawBpm})`,
    );
    assert.ok(est.confidence > 0.5, `low confidence ${est.confidence} at ${bpm}`);
  }
});

test('chunk-size independence: same track detected with tiny and large fixed chunks', () => {
  const track = kickTrack(128, 15, 44100);
  for (const size of [128, 1531, 4096]) {
    const est = detect(track, 44100, size);
    assert.ok(est.bpm !== null, `bpm null at chunk size ${size}`);
    assert.ok(
      Math.abs(est.bpm - 128) <= 2,
      `chunk size ${size}: expected ~128, got ${est.bpm}`,
    );
  }
});

test('octave preference: 87 BPM track reports ~87, not 174', () => {
  const est = detect(kickTrack(87, 15, 44100, { hiHat: true }), 44100);
  assert.ok(est.bpm !== null);
  assert.ok(
    Math.abs(est.bpm - 87) <= 2,
    `expected ~87, got ${est.bpm} (raw ${est.rawBpm})`,
  );
});

test('octave preference: 174 BPM track reports ~174 with alternates.half ~87', () => {
  const est = detect(kickTrack(174, 15, 44100, { hiHat: true }), 44100);
  assert.ok(est.bpm !== null);
  assert.ok(
    Math.abs(est.bpm - 174) <= 2,
    `expected ~174, got ${est.bpm} (raw ${est.rawBpm})`,
  );
  assert.ok(
    Math.abs(est.alternates.half - 87) <= 2,
    `expected alternates.half ~87, got ${est.alternates.half}`,
  );
});

test('tempo sweep: 60-180 BPM in steps of 2 at 44100 and 48000 Hz (±2)', () => {
  for (const sampleRate of [44100, 48000]) {
    for (let bpm = 60; bpm <= 180; bpm += 2) {
      const est = detect(kickTrack(bpm, 12, sampleRate), sampleRate);
      assert.ok(est.bpm !== null, `bpm null for ${bpm} BPM @ ${sampleRate} Hz`);
      assert.ok(
        Math.abs(est.bpm - bpm) <= 2,
        `${sampleRate} Hz: expected ~${bpm}, got ${est.bpm} (raw ${est.rawBpm})`,
      );
    }
  }
});

test('genuine low-frequency offbeats: 80 BPM with 0.6x offbeat kicks reports 80, not 160', () => {
  for (const sampleRate of [44100, 48000]) {
    const est = detect(
      kickTrack(80, 15, sampleRate, { offbeatKick: 0.6 }),
      sampleRate,
    );
    assert.ok(est.bpm !== null, `bpm null @ ${sampleRate} Hz`);
    assert.ok(
      Math.abs(est.bpm - 80) <= 2,
      `${sampleRate} Hz: expected ~80, got ${est.bpm} (raw ${est.rawBpm})`,
    );
  }
});

test('genuine low-frequency offbeats: 100 and 140 BPM with 0.5x offbeat kicks keep base tempo', () => {
  for (const bpm of [100, 140]) {
    const est = detect(kickTrack(bpm, 15, 48000, { offbeatKick: 0.5 }), 48000);
    assert.ok(est.bpm !== null, `bpm null for ${bpm}`);
    assert.ok(
      Math.abs(est.bpm - bpm) <= 2,
      `expected ~${bpm}, got ${est.bpm} (raw ${est.rawBpm})`,
    );
  }
});

test('equal-amplitude offbeat kicks are a genuine double-time train: 80 BPM base reports ~160', () => {
  const est = detect(kickTrack(80, 15, 48000, { offbeatKick: 1 }), 48000);
  assert.ok(est.bpm !== null);
  assert.ok(
    Math.abs(est.bpm - 160) <= 2,
    `expected ~160, got ${est.bpm} (raw ${est.rawBpm})`,
  );
});

test('robust to instructor speech: 128 BPM kick + speech noise within ±2', () => {
  const track = mix(
    kickTrack(128, 15, 44100),
    speechNoise(15, 44100, { amp: 0.6 }),
  );
  const est = detect(track, 44100);
  assert.ok(est.bpm !== null, 'bpm should not be null');
  assert.ok(
    Math.abs(est.bpm - 128) <= 2,
    `expected ~128, got ${est.bpm} (raw ${est.rawBpm})`,
  );
});

test('silence yields null bpm / low confidence', () => {
  const est = detect(silence(10, 44100), 44100);
  assert.ok(
    est.bpm === null || est.confidence < 0.3,
    `silence gave bpm=${est.bpm} confidence=${est.confidence}`,
  );
  assert.equal(est.locked, false);
});

test('speech-only input yields null bpm or confidence < 0.3', () => {
  const est = detect(speechNoise(12, 44100, { amp: 0.7 }), 44100);
  assert.ok(
    est.bpm === null || est.confidence < 0.3,
    `speech gave bpm=${est.bpm} confidence=${est.confidence}`,
  );
});

test('locks onto a steady track and exposes half/double alternates', () => {
  const det = new BpmDetector({ sampleRate: 44100 });
  feedInChunks(det, kickTrack(128, 15, 44100));
  const est = det.getEstimate();
  assert.ok(est.bpm !== null);
  assert.equal(est.locked, true, 'locked should be true on a steady track');
  assert.ok(Math.abs(est.alternates.half - est.bpm / 2) < 1e-9);
  assert.ok(Math.abs(est.alternates.double - est.bpm * 2) < 1e-9);
});

test('alternates are null while bpm is null', () => {
  const det = new BpmDetector({ sampleRate: 44100 });
  const est = det.getEstimate();
  assert.equal(est.bpm, null);
  assert.deepEqual(est.alternates, { half: null, double: null });
});

test('reset() clears state', () => {
  const det = new BpmDetector({ sampleRate: 44100 });
  feedInChunks(det, kickTrack(128, 15, 44100));
  assert.ok(det.getEstimate().bpm !== null);
  det.reset();
  const est = det.getEstimate();
  assert.equal(est.bpm, null);
  assert.equal(est.rawBpm, null);
  assert.equal(est.confidence, 0);
  assert.equal(est.locked, false);
  assert.deepEqual(est.alternates, { half: null, double: null });
  // Detector still works after reset.
  feedInChunks(det, kickTrack(90, 15, 44100));
  const est2 = det.getEstimate();
  assert.ok(est2.bpm !== null && Math.abs(est2.bpm - 90) <= 2);
});

test('works at 48000 Hz sample rate', () => {
  for (const bpm of [90, 128, 174]) {
    const est = detect(kickTrack(bpm, 15, 48000, { hiHat: true }), 48000);
    assert.ok(est.bpm !== null, `bpm null at 48k for ${bpm}`);
    assert.ok(
      Math.abs(est.bpm - bpm) <= 2,
      `48k: expected ~${bpm}, got ${est.bpm}`,
    );
  }
});
