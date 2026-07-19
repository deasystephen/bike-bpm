# bike-bpm

A tiny web app that listens to the music playing from a Peloton bike and shows
the song's BPM in real time, so you can match your cadence to the beat.

No song identification — pure signal processing: low-frequency onset detection
(kick drum band) + autocorrelation tempo tracking, with octave-error
disambiguation and heavy smoothing so the number stays stable.

## Run it

```sh
npm start          # serves on http://localhost:8321
npm test           # DSP unit tests against synthetic audio (node --test)
```

Open http://localhost:8321, tap **Start listening**, and grant microphone
access. Microphone capture requires a secure context (localhost or HTTPS).

### Using it from a phone

Browsers only expose the microphone in a secure context, so opening
`http://<your-computer's-ip>:8321` from a phone will NOT work — the app will
tell you so instead of listening. Serve it over HTTPS instead, e.g. with a
tunnel:

```sh
npm start                      # in one terminal
npx localtunnel --port 8321    # in another; open the printed https:// URL
# or, if you use Tailscale:
tailscale serve 8321           # open the printed https:// URL on the phone
```

Any static-file host with HTTPS also works — the app is just static files
with no build step.

## Layout

- `index.html`, `src/app.js`, `src/style.css` — UI and mic capture
- `src/bpm-detector.js` — pure DSP module (no DOM/WebAudio dependencies)
- `test/` — unit tests using synthetically generated audio at known tempos
