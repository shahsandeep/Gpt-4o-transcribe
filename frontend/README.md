# Frontend — Live Transcribe & Translate

React + TypeScript + Vite UI for the Azure GPT-4o realtime speech transcription
and translation app. It captures the microphone, streams PCM16 audio at 24 kHz
over a WebSocket, and renders live partial transcripts, finalized lines, and
translations. It talks to **either** backend (Python `:8000` or .NET `:8080`)
via an in-app switcher — both implement the identical protocol in
[`../docs/WEBSOCKET_PROTOCOL.md`](../docs/WEBSOCKET_PROTOCOL.md).

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
  App.tsx                  # top-level composition + export wiring
  types.ts                 # protocol message types (mirror the contract)
  lib/
    backends.ts            # Python/.NET definitions + ws URL builder
    languages.ts           # ISO code → display name (input has "auto")
    export.ts              # txt / srt / json serializers + download
  hooks/
    useAudioDevices.ts     # enumerate + permission + selection
    useTranscription.ts    # WebSocket + audio pipeline orchestration
  worklets/
    pcm-worklet.js         # Float32 → Int16 PCM, posts ArrayBuffers
  components/
    Controls.tsx           # backend/mic/language/translate/start-stop
    TranscriptView.tsx     # segment list with partial rendering + autoscroll
    StatusBar.tsx          # connection status, VAD indicator, banners
```
