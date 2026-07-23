# Architecture

## Components

```
frontend (React/Vite)  ──ws──▶  backend (Python FastAPI  |  .NET ASP.NET Core)  ──ws/https──▶  Azure OpenAI
```

Three deployables, one shared contract:

- **frontend/** — captures mic audio, resamples to PCM16/24 kHz, streams it over a
  WebSocket, and renders partial + final transcripts and translations. Backend-agnostic.
- **backend-python/** and **backend-dotnet/** — functionally identical relays. Each
  owns one client WebSocket and one upstream Azure WebSocket per session, plus REST
  calls to the chat deployment for translation.
- **Azure OpenAI** — `gpt-4o-transcribe` (realtime STT) and `gpt-4o` (translation).

## Why two backends

The point of the project is parity: the same UI drives either runtime. That forces
a clean, transport-only contract ([`WEBSOCKET_PROTOCOL.md`](WEBSOCKET_PROTOCOL.md))
with no backend-specific leakage. The frontend's backend switcher just changes the
WebSocket host; nothing else differs.

## Data flow, in detail

1. **Capture.** `AudioContext({sampleRate:24000})` + an `AudioWorklet` produce
   Float32 frames. The worklet/host converts them to little-endian Int16 (PCM16).
2. **Uplink.** Frames go to the backend as **binary** WebSocket messages. Control
   messages (`start`/`stop`/`update`) go as **text** JSON on the same socket.
3. **Relay up.** The backend base64-encodes each audio chunk into an
   `input_audio_buffer.append` event on its upstream Azure WebSocket.
4. **Transcribe.** Azure server VAD segments speech and emits
   `conversation.item.input_audio_transcription.delta` (incremental) and
   `.completed` (final) events, plus `speech_started`/`speech_stopped`.
5. **Downlink.** The backend maps those to `partial_transcript` / `final_transcript`
   / `speech_*` protocol messages and pushes them to the client.
6. **Translate.** On each `.completed`, if translation is on, the backend POSTs the
   final text to the `gpt-4o` chat deployment (`temperature:0`, "output only the
   translation") and pushes a `translation` message tagged with the same `itemId`.

## Key design decisions

- **Translate on finalized segments, not partials.** Translating every partial delta
  would multiply chat calls and produce flickering half-translations. Segments finalize
  every few seconds under server VAD, so translations still feel live. The protocol
  reserves a `partial` flag on `translation` for a future streaming-translation mode.
- **24 kHz PCM16, resampled in the browser.** The Realtime API's `pcm16` format is
  24 kHz mono. Doing the resample in the browser via `AudioContext` keeps the backends
  pure byte-relays — no server-side audio processing, no ffmpeg dependency.
- **Binary audio, JSON control on one socket.** Sending raw PCM as binary frames avoids
  base64 bloat on the busy uplink; only the backend base64-encodes (once) for Azure.
- **`itemId` correlation.** Azure's `item_id` threads a segment's partial → final →
  translation together so the UI can update the right line in place.
- **Everything driven from env.** Endpoint, deployment names, and API version are all
  configuration. When Azure bumps the preview `api-version`, no code changes.
- **Per-connection isolation.** Each client WS gets its own upstream Azure socket and
  its own session state; one client's failure never touches another's.

## Failure handling

- Upstream Azure errors surface to the client as `error` messages and close the session.
- Client disconnects tear down the upstream socket (no leaked Azure connections).
- Translation failures are non-fatal: the transcript still shows; an `info`/`error`
  notes the translation failure for that segment.
- Both backends serialize writes to the client socket (WebSocket send is not concurrent-safe).

## Extending it

- **Streaming translation:** translate partials with debounce and set `partial:true`.
- **Text-to-speech output:** add an Azure TTS deployment and stream synthesized audio back.
- **File / system-audio input:** feed non-mic PCM16 sources into the same uplink.
- **Diarization:** switch to a diarizing transcribe model and carry speaker labels in the protocol.
