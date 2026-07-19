// bike-bpm — UI + mic capture. Feeds mono audio into BpmDetector and displays
// the tempo estimate. Pure detector logic lives in ./bpm-detector.js.

import { BpmDetector } from './bpm-detector.js';

const POLL_INTERVAL_MS = 250; // ~4x/sec display refresh
const SILENCE_DBFS = -55; // below this the mic is effectively hearing nothing
const SILENCE_HINT_AFTER_MS = 3000;
const DEBUG =
  typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('debug');

// Inlined AudioWorklet processor: forwards downmixed mono Float32 chunks to
// the main thread, where the (pure, DOM-free) detector runs. Inlining via a
// Blob URL keeps everything servable as static files.
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      let mono;
      if (input.length === 1) {
        mono = new Float32Array(input[0]);
      } else {
        mono = new Float32Array(input[0].length);
        for (let c = 0; c < input.length; c++) {
          const ch = input[c];
          for (let i = 0; i < ch.length; i++) mono[i] += ch[i];
        }
        const inv = 1 / input.length;
        for (let i = 0; i < mono.length; i++) mono[i] *= inv;
      }
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  listening: false,
  stream: null,
  audioCtx: null,
  workletNode: null,
  sourceNode: null,
  muteNode: null,
  workletUrl: null,
  detector: null,
  pollTimer: null,
  wakeLock: null,
  lowConfidenceSince: null,
  // Input diagnostics: accumulated between display polls in the worklet
  // message handler, so the meter reflects exactly what the detector hears.
  levelSumSq: 0,
  levelCount: 0,
  lastFrameAt: 0,
  silentSince: null,
  silenceHintShown: false,
  lastDebugLogAt: 0,
};

let els = null;

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function fmt(n) {
  return n == null || !isFinite(n) ? '—' : String(Math.round(n));
}

function suggestedCadence(bpm) {
  if (bpm == null) return null;
  if (bpm >= 50 && bpm <= 110) return bpm;
  const half = bpm / 2;
  if (half >= 50 && half <= 110) return half;
  return null;
}

function setStatus(msg) {
  if (els) els.status.textContent = msg || '';
}

function renderEstimate(est) {
  const { bpm, confidence, alternates, locked } = est;

  // Dim a stale reading: if confidence has been ~0 for several seconds
  // (music stopped, mic covered), the locked number no longer reflects
  // what is playing.
  const now = Date.now();
  if (confidence >= 0.15) {
    state.lowConfidenceSince = null;
  } else if (state.lowConfidenceSince == null) {
    state.lowConfidenceSince = now;
  }
  const stale =
    state.lowConfidenceSince != null && now - state.lowConfidenceSince > 5000;

  els.bpm.textContent = fmt(bpm);
  els.bpm.classList.toggle('bpm-locked', Boolean(locked && bpm != null && !stale));
  els.bpm.classList.toggle('bpm-dim', !(locked && bpm != null) || stale);

  if (bpm != null && alternates) {
    els.alternates.textContent =
      `half ${fmt(alternates.half)} · double ${fmt(alternates.double)}`;
  } else {
    els.alternates.textContent = 'half — · double —';
  }

  const cadence = suggestedCadence(bpm);
  els.cadence.textContent =
    cadence == null
      ? 'suggested cadence: —'
      : `suggested cadence: ${Math.round(cadence)} rpm`;

  let dotClass = 'dot dot-off';
  if (state.listening) {
    if (confidence >= 0.7) dotClass = 'dot dot-green';
    else if (confidence >= 0.4) dotClass = 'dot dot-yellow';
    else dotClass = 'dot dot-red';
  }
  els.confidenceDot.className = dotClass;
}

// Level meter + silence detection. Distinguishes the two ways the display can
// sit at "—" forever: audio arriving but no clear beat (meter dances, dot red)
// vs. no audio at all (meter flat — OS-level mic permission or wrong device).
function renderLevel() {
  const now = performance.now();
  const stalled = state.lastFrameAt > 0 && now - state.lastFrameAt > 1500;
  let db = -Infinity;
  if (!stalled && state.levelCount > 0) {
    const rms = Math.sqrt(state.levelSumSq / state.levelCount);
    db = 20 * Math.log10(rms + 1e-12);
  }
  state.levelSumSq = 0;
  state.levelCount = 0;

  // Map -60..0 dBFS to 0..100% width.
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  els.meterFill.style.width = `${pct}%`;
  els.meterFill.classList.toggle('meter-silent', db < SILENCE_DBFS);
  els.meterFill.classList.toggle(
    'meter-low',
    db >= SILENCE_DBFS && db < -35,
  );

  const silent = stalled || db < SILENCE_DBFS;
  if (!silent) {
    state.silentSince = null;
    if (state.silenceHintShown) {
      state.silenceHintShown = false;
      setStatus('Listening… point the phone toward the speaker.');
    }
  } else if (state.silentSince == null) {
    state.silentSince = now;
  } else if (
    now - state.silentSince > SILENCE_HINT_AFTER_MS &&
    !state.silenceHintShown
  ) {
    state.silenceHintShown = true;
    setStatus(
      stalled
        ? 'Audio stopped flowing — tap Stop, then Start to restart the mic.'
        : 'Mic is open but hearing silence. Check the mic named below is the ' +
          'right one, and that your browser has microphone access in ' +
          'System Settings → Privacy & Security → Microphone.'
    );
  }

  if (DEBUG && now - state.lastDebugLogAt > 1000) {
    state.lastDebugLogAt = now;
    const est = state.detector ? state.detector.getEstimate() : null;
    console.log(
      `[bike-bpm] level=${db === -Infinity ? '-inf' : db.toFixed(1)} dBFS` +
        ` stalled=${stalled}` +
        (est
          ? ` raw=${est.rawBpm == null ? 'null' : est.rawBpm.toFixed(1)}` +
            ` bpm=${est.bpm == null ? 'null' : est.bpm.toFixed(1)}` +
            ` conf=${est.confidence.toFixed(2)} locked=${est.locked}`
          : '')
    );
  }
}

function renderIdle() {
  els.bpm.textContent = '—';
  els.bpm.classList.remove('bpm-locked');
  els.bpm.classList.add('bpm-dim');
  els.alternates.textContent = 'half — · double —';
  els.cadence.textContent = 'suggested cadence: —';
  els.confidenceDot.className = 'dot dot-off';
}

// ---------------------------------------------------------------------------
// Wake lock (feature-detected)
// ---------------------------------------------------------------------------

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    });
  } catch {
    // Wake lock is best-effort (can fail when tab is hidden or on battery saver).
  }
}

async function releaseWakeLock() {
  if (state.wakeLock) {
    try {
      await state.wakeLock.release();
    } catch {
      // ignore
    }
    state.wakeLock = null;
  }
}

// ---------------------------------------------------------------------------
// Audio pipeline
// ---------------------------------------------------------------------------

async function startListening() {
  if (state.listening) return;

  // On phones over plain LAN http there is no secure context, so
  // navigator.mediaDevices does not exist at all — explain instead of
  // failing with a cryptic TypeError.
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus(
      'Microphone access requires a secure context: open this page over ' +
        'HTTPS or on http://localhost. See the README for serving the app ' +
        'to a phone (e.g. an HTTPS tunnel).'
    );
    return;
  }

  setStatus('');
  els.start.disabled = true;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Disable phone voice processing — it would mangle the music.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (err) {
    els.start.disabled = false;
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      setStatus(
        'Microphone access was denied. Allow mic access for this site in ' +
          'your browser settings, then tap Start again.'
      );
    } else if (err && err.name === 'NotFoundError') {
      setStatus('No microphone found on this device.');
    } else {
      setStatus(`Could not open microphone: ${err && err.name ? err.name : err}`);
    }
    return;
  }

  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.audioCtx = audioCtx;
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    state.detector = new BpmDetector({ sampleRate: audioCtx.sampleRate });

    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    state.workletUrl = URL.createObjectURL(blob);
    await audioCtx.audioWorklet.addModule(state.workletUrl);

    const workletNode = new AudioWorkletNode(audioCtx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    workletNode.port.onmessage = (e) => {
      if (!state.detector) return;
      const chunk = e.data;
      state.detector.process(chunk);
      let sumSq = 0;
      for (let i = 0; i < chunk.length; i++) sumSq += chunk[i] * chunk[i];
      state.levelSumSq += sumSq;
      state.levelCount += chunk.length;
      state.lastFrameAt = performance.now();
    };

    const sourceNode = audioCtx.createMediaStreamSource(stream);
    // Route through a muted gain to the destination so the graph keeps
    // pulling the worklet — without ever playing the mic back out loud.
    const muteNode = audioCtx.createGain();
    muteNode.gain.value = 0;
    sourceNode.connect(workletNode);
    workletNode.connect(muteNode);
    muteNode.connect(audioCtx.destination);

    state.stream = stream;
    state.workletNode = workletNode;
    state.sourceNode = sourceNode;
    state.muteNode = muteNode;
    state.listening = true;

    // The OS or another app can take the mic away (permission revoked,
    // external mic unplugged, phone call). Without these handlers the UI
    // would keep showing a stale locked BPM under "Listening…".
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', onMicLost);
      track.addEventListener('mute', () => {
        if (state.listening) {
          setStatus('Microphone muted by the system — audio is not coming through.');
        }
      });
      track.addEventListener('unmute', () => {
        if (state.listening) {
          setStatus('Listening… point the phone toward the speaker.');
        }
      });
    }

    audioCtx.onstatechange = () => {
      // Checking !== 'running' also covers iOS Safari's non-standard
      // 'interrupted' state (phone call, Siri, backgrounding).
      if (state.listening && audioCtx.state !== 'running' && audioCtx.state !== 'closed') {
        setStatus('Audio paused by the browser — tap the screen to resume.');
      }
    };

    state.pollTimer = setInterval(() => {
      if (state.detector) renderEstimate(state.detector.getEstimate());
      if (state.listening) renderLevel();
    }, POLL_INTERVAL_MS);

    const track = stream.getAudioTracks()[0];
    els.micLabel.textContent =
      `${track && track.label ? track.label : 'unknown mic'}` +
      ` · ${Math.round(audioCtx.sampleRate)} Hz`;
    els.diag.hidden = false;
    if (DEBUG) {
      console.log('[bike-bpm] mic:', track ? track.label : '(none)',
        'settings:', track ? track.getSettings() : null,
        'ctx sampleRate:', audioCtx.sampleRate);
    }

    await acquireWakeLock();

    els.start.hidden = true;
    els.stop.hidden = false;
    els.start.disabled = false;
    setStatus('Listening… point the phone toward the speaker.');
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    await teardownAudio();
    els.start.disabled = false;
    setStatus(`Audio setup failed: ${err && err.message ? err.message : err}`);
  }
}

async function onMicLost() {
  if (!state.listening) return;
  await teardownAudio();
  await releaseWakeLock();
  els.stop.hidden = true;
  els.start.hidden = false;
  els.start.disabled = false;
  renderIdle();
  setStatus('Microphone was disconnected — tap Start to retry.');
}

async function teardownAudio() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.workletNode) {
    state.workletNode.port.onmessage = null;
    try {
      state.workletNode.disconnect();
    } catch { /* ignore */ }
    state.workletNode = null;
  }
  if (state.sourceNode) {
    try {
      state.sourceNode.disconnect();
    } catch { /* ignore */ }
    state.sourceNode = null;
  }
  if (state.muteNode) {
    try {
      state.muteNode.disconnect();
    } catch { /* ignore */ }
    state.muteNode = null;
  }
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  if (state.audioCtx) {
    try {
      await state.audioCtx.close();
    } catch { /* ignore */ }
    state.audioCtx = null;
  }
  if (state.workletUrl) {
    URL.revokeObjectURL(state.workletUrl);
    state.workletUrl = null;
  }
  state.detector = null;
  state.listening = false;
  state.lowConfidenceSince = null;
  state.levelSumSq = 0;
  state.levelCount = 0;
  state.lastFrameAt = 0;
  state.silentSince = null;
  state.silenceHintShown = false;
  if (els) {
    els.diag.hidden = true;
    els.meterFill.style.width = '0%';
  }
}

async function stopListening() {
  if (!state.listening) return;
  await teardownAudio();
  await releaseWakeLock();
  els.stop.hidden = true;
  els.start.hidden = false;
  setStatus('');
  renderIdle();
}

// ---------------------------------------------------------------------------
// Tab-switch handling: resume the AudioContext and re-acquire the wake lock
// when the page becomes visible again.
// ---------------------------------------------------------------------------

async function onVisibilityChange() {
  if (document.visibilityState !== 'visible' || !state.listening) return;
  // !== 'running' covers both 'suspended' and iOS Safari's non-standard
  // 'interrupted' state (after a phone call/Siri/backgrounding).
  if (state.audioCtx && state.audioCtx.state !== 'running' && state.audioCtx.state !== 'closed') {
    try {
      await state.audioCtx.resume();
      setStatus('Listening…');
    } catch {
      setStatus('Audio paused — tap Stop, then Start to resume.');
    }
  }
  if (!state.wakeLock) await acquireWakeLock();
}

// ---------------------------------------------------------------------------
// Init — all DOM access lives here so a smoke `import` of this module in a
// non-browser environment (node --check / node --test) never throws.
// ---------------------------------------------------------------------------

export function init() {
  if (typeof document === 'undefined') return;

  els = {
    bpm: document.getElementById('bpm'),
    alternates: document.getElementById('alternates'),
    cadence: document.getElementById('cadence'),
    confidenceDot: document.getElementById('confidence-dot'),
    status: document.getElementById('status'),
    start: document.getElementById('start'),
    stop: document.getElementById('stop'),
    diag: document.getElementById('diag'),
    meterFill: document.getElementById('meter-fill'),
    micLabel: document.getElementById('mic-label'),
  };

  els.start.addEventListener('click', startListening);
  els.stop.addEventListener('click', stopListening);
  document.addEventListener('visibilitychange', onVisibilityChange);
  // Any tap can rescue a suspended context (browsers require a gesture).
  document.addEventListener('pointerdown', () => {
    // !== 'running' also covers iOS Safari's non-standard 'interrupted' state.
    const ctx = state.audioCtx;
    if (state.listening && ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
      ctx.resume().catch(() => {});
    }
  });

  renderIdle();
}
