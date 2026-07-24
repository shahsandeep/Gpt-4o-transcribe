# Frontend — Live Transcribe & Translate

React + TypeScript + Vite UI for the Azure GPT-4o speech transcription and
translation app. It captures the microphone at 24 kHz PCM16 and transcribes in
one of three modes — realtime WebSocket, REST in 5-second batches, or REST
full-audio — with live translation. It talks to **either** backend (Python
`:8000` or .NET `:8080`) via an in-app switcher; both implement the identical
[WebSocket](../docs/WEBSOCKET_PROTOCOL.md) and [REST](../docs/REST_API.md)
contracts. Recordings are saved in the browser for replay, download, and
full-audio comparison.

## Quick start (dev)

```bash
npm install
npm run dev        # http://localhost:5173
```

Start one (or both) backends first so the switcher has something to connect to:

```bash
# from the repo root
cp .env.example .env    # fill in Azure creds
docker compose up --build backend-python backend-dotnet
```

## Build

```bash
npm run build      # type-checks, then emits static site to dist/
npm run preview    # serve the production build locally
```

## Docker

Multi-stage build (`node:20` build → `nginx:alpine` serving `dist/` on port 80):

```bash
docker build -t transcribe-frontend .
docker run -p 5173:80 transcribe-frontend
```

The repo-root `docker-compose.yml` already wires this up (`frontend` service maps
host `5173` → container `80`).

## How the backend switcher works

`src/lib/backends.ts` defines the two backends (label + host + port). The
Python/.NET toggle in the UI picks which one the next session connects to. The
WebSocket URL is built as `ws(s)://<host>:<port>/ws/transcribe`; the scheme
follows the page (`wss` when the page is served over HTTPS). Hosts default to the
page's own hostname, so it works on `localhost` in dev and against a deployed
host in prod. Override per-backend with the `VITE_*` vars in `.env.example` if
your backends live elsewhere. You can only switch backends while stopped — the
control is disabled during an active session.

## Transcription modes

The **Mode** switch (disabled while a session is active) picks the pipeline:

- **Realtime (WebSocket)** — streams PCM16 frames to `/ws/transcribe`; renders live
  partial transcripts that promote to final. Requires a realtime Azure deployment.
- **REST · 5s batches** — buffers ~5 seconds of audio, wraps it in a WAV, and POSTs to
  `/rest/transcribe`. Each response appends a segment, so results arrive near-realtime.
  Works with the standard `/audio/transcriptions` deployment.
- **REST · full audio** — records the whole session and POSTs one WAV on stop, for a
  single transcript with no chunk-boundary splits.

All three share the same capture pipeline (`src/lib/capture.ts`) and the same
translation. The REST client is `src/lib/rest.ts`.

## Saved recordings

Every session's audio is stored in the browser via **IndexedDB**
(`src/lib/recordings.ts`), encoded as a 24 kHz mono WAV (`src/lib/wav.ts`). The
**Saved recordings** panel lists them with:

- **Play** — inline `<audio>` playback.
- **Download** — save the `.wav`.
- **Transcribe full** — POST the whole recording via REST and show the transcript +
  translation, so you can compare full-audio accuracy against the 5-second batched run
  on the *same* audio.
- **Delete**.

Nothing is uploaded except when you explicitly transcribe; recordings never leave the
browser otherwise.

## Audio cleanup & enhancement

Two toggles in the controls:

- **Audio cleanup** (default on, both modes) — sets `noiseSuppression`,
  `echoCancellation`, and `autoGainControl` on `getUserMedia`, so the browser's WebRTC
  processing cleans the mic before capture. Turn it off if it hurts diarization on
  far-field / multi-speaker audio.
- **Server enhance (ffmpeg)** (default off, REST modes only) — sends `enhance=true` so
  the backend runs an ffmpeg filter chain (high-pass + denoise + loudness normalize)
  before uploading to Azure. The response's `enhanced` flag says whether it actually
  ran (it's a no-op if the backend has no ffmpeg).

Each saved recording also has a **Compare A/B** button: it calls `/rest/enhance` and
plays the **original** vs the **ffmpeg-enhanced** audio side by side (with a download
for the enhanced WAV), so you can hear exactly what the filter chain is doing before
trusting it for transcription.

**Diff enhance** goes one step further and quantifies the *transcription* impact: it
transcribes the same clip twice (enhancement off, then on — translation skipped) and
shows the two transcripts side by side with a word-level diff (`src/lib/diff.ts`,
LCS-based), plus a "N of M words differ" summary and each run's timing. Removed words
(only in the un-enhanced run) are struck through on the left; added words (only in the
enhanced run) are highlighted on the right. If ffmpeg isn't installed, it says so
(the two runs would be identical).

## Speaker diarization

With a diarize deployment (`AZURE_TRANSCRIBE_RESPONSE_FORMAT=diarized_json`), the REST
response includes per-speaker turns. The UI renders each turn as its own bubble with a
colored **Speaker A / B / C** chip (`src/lib/speakers.ts` maps each speaker to a stable
color). Each turn is translated separately so the translation sits under the matching
speaker. Speaker labels also appear in `.txt` / `.json` exports. Non-diarized responses
render as a single un-chipped block, exactly as before.

## How it works (audio pipeline)

1. **Device pick** — `navigator.mediaDevices.enumerateDevices()` lists inputs
   (`kind === 'audioinput'`). Labels are empty until mic permission is granted,
   so **Grant mic** calls `getUserMedia` once and re-enumerates.
2. **Capture** — an `AudioContext({ sampleRate: 24000 })` resamples the mic to
   24 kHz. An **AudioWorklet** (`src/worklets/pcm-worklet.js`) converts Float32
   frames to PCM16 little-endian and posts ~100 ms chunks to the main thread.
3. **Stream** — chunks are sent as **binary** WebSocket frames, but only after
   the backend sends `ready` and the client has sent `start`. Sends are guarded
   against a closed socket.
4. **Render** — segments are keyed by `itemId`: `partial_transcript` shows a
   greyed/italic live line, `final_transcript` promotes it to a solid line, and
   `translation` attaches the translated text beneath. The live indicator lights
   on `speech_started` and dims on `speech_stopped`.
5. **Live language change** — changing the target language or the translate
   toggle mid-session sends an `update` message (no reconnect). Changing the
   **input** language requires a reconnect, so that control is locked while live.
6. **Export** — download finalized segments (original + translation) as `.txt`,
   `.srt` (incrementing indices + `HH:MM:SS,mmm` timestamps captured client-side
   at finalization), or `.json`.

## Microphone permission & HTTPS

Browsers only expose `getUserMedia` in a **secure context**: `https://` origins
or `http://localhost`. Dev on `http://localhost:5173` works. If you serve the
built site from any other host over plain HTTP, the mic is blocked — put it
behind HTTPS. On first Start (or **Grant mic**) the browser prompts for mic
access; deny and the app surfaces the error in the banner.

## Project layout

```
src/
  App.tsx                  # top-level composition, mode selection, export wiring
  types.ts                 # protocol + UI types (Mode, StartOptions, Transcriber)
  lib/
    backends.ts            # Python/.NET definitions + ws URL builder
    rest.ts                # REST /rest/transcribe client + http base builder
    capture.ts             # shared mic → PCM16 capture (used by both pipelines)
    wav.ts                 # Int16 PCM → WAV blob encoder
    recordings.ts          # IndexedDB store (save/list/get/delete)
    languages.ts           # ISO code → display name (input has "auto")
    export.ts              # txt / srt / json serializers + download
  hooks/
    useAudioDevices.ts     # enumerate + permission + selection
    useTranscription.ts    # WebSocket pipeline (streams PCM, saves recording)
    useRestTranscription.ts # REST pipeline (batched 5s + full audio)
  worklets/
    pcm-worklet.js         # Float32 → Int16 PCM, posts ArrayBuffers
  components/
    Controls.tsx           # mode/backend/mic/language/translate/start-stop
    TranscriptView.tsx     # segment list with partial rendering + autoscroll
    StatusBar.tsx          # connection status, VAD indicator, banners
    Recordings.tsx         # saved-recording list: play/download/transcribe/delete
```
