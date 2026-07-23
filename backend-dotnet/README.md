# .NET backend — Azure GPT-4o transcription + translation

ASP.NET Core (.NET 8) minimal-API backend for the real-time Azure GPT-4o speech
transcription and translation app. It is behavior-identical to the Python backend
and speaks the exact same WebSocket protocol, so the same React frontend works
against either backend by only changing the base URL.

See the shared contracts:

- [`../docs/WEBSOCKET_PROTOCOL.md`](../docs/WEBSOCKET_PROTOCOL.md) — the client↔backend WebSocket contract.
- [`../docs/AZURE_SETUP.md`](../docs/AZURE_SETUP.md) — how the backend reaches Azure.

## What it does

On each client WebSocket connection the backend:

1. Opens an upstream `ClientWebSocket` to the Azure OpenAI Realtime transcription
   API with language auto-detect, sends `transcription_session.update`, and emits
   `ready` (per the protocol, `ready` precedes the client's `start`).
2. On the client's `start` frame (input/target language, translate flag), stores
   the target language and, if a specific input language was named, reconfigures
   the upstream session for it.
3. Relays microphone PCM16 audio (binary frames) up to Azure as
   `input_audio_buffer.append`, and streams `partial_transcript` /
   `final_transcript` / `speech_started` / `speech_stopped` back down.
4. Translates each finalized segment via the Azure chat completions REST API and
   sends a `translation` message correlated by `itemId`. Translation runs on a
   background task and never blocks the `final_transcript` send.

## Endpoints

| Method | Path              | Description                          |
|--------|-------------------|--------------------------------------|
| GET    | `/health`         | Liveness probe → `{ "status": "ok" }` |
| WS     | `/ws/transcribe`  | One WebSocket per transcription session |
| POST   | `/rest/transcribe`| Transcribe a complete audio file (optionally translate) |

### `POST /rest/transcribe`

An independent REST path alongside the WebSocket: POST one complete audio file and
get the whole transcript back at once, optionally translated. Behavior-identical to
the Python backend; see [`../docs/REST_API.md`](../docs/REST_API.md) for the full
contract.

Request — `multipart/form-data`:

| Field | Required | Description |
|-------|----------|-------------|
| `file` | yes | Audio file bytes (frontend sends mono 16-bit PCM WAV @ 24 kHz, `audio/wav`). Passed through to Azure unchanged. |
| `inputLanguage` | no | ISO-639-1 code of the spoken audio. Omit or send `auto` to let Azure detect. |
| `targetLanguage` | no | ISO-639-1 code to translate into. Required only when `translate=true`. |
| `translate` | no | `true` / `false` (default `false`). When true, the transcript is translated via the chat deployment. |

Response — `200 application/json`:

```jsonc
{
  "transcript": "hello world",
  "translation": "hola mundo",   // null when translate=false or transcript empty
  "transcribeMs": 812,            // server-measured Azure transcription time
  "translateMs": 143              // server-measured translation time (0 when skipped)
}
```

A transcription failure returns `502` with `{ "error": "..." }`. A translation
failure is non-fatal: the transcript is still returned with `translation: null`
and an extra `translateError` field.

## Configuration

All configuration is read from environment variables. When run outside Docker the
backend **auto-loads the shared repo-root `.env`** (real environment variables
still take priority); in Docker the values are injected via `env_file`. Defaults
match the Python backend.

| Variable | Default | Purpose |
|----------|---------|---------|
| `AZURE_OPENAI_ENDPOINT` | `https://your-resource.openai.azure.com` | Azure OpenAI resource endpoint |
| `AZURE_OPENAI_API_KEY` | *(empty)* | Azure OpenAI API key (`api-key` header) |
| `AZURE_TRANSCRIBE_DEPLOYMENT` | `gpt-4o-transcribe` | Realtime + REST transcription deployment name |
| `AZURE_REALTIME_API_VERSION` | `2025-04-01-preview` | Realtime API version |
| `AZURE_TRANSCRIBE_REST_API_VERSION` | `2025-04-01-preview` | REST `/audio/transcriptions` API version |
| `AZURE_CHAT_DEPLOYMENT` | `gpt-4o` | Chat deployment used for translation |
| `AZURE_CHAT_API_VERSION` | `2024-10-21` | Chat completions API version |
| `VAD_THRESHOLD` | `0.5` | Server VAD threshold |
| `VAD_PREFIX_PADDING_MS` | `300` | Server VAD prefix padding (ms) |
| `VAD_SILENCE_DURATION_MS` | `500` | Server VAD silence duration (ms) |
| `DOTNET_PORT` | `8080` | Listen port (bound on `0.0.0.0`) |

Derived URLs (same rules as the Python backend):

- Realtime WS: `wss://<host>/openai/realtime?api-version=<ver>&intent=transcription`
- REST transcription: `https://<host>/openai/deployments/<transcribe>/audio/transcriptions?api-version=<restver>`
- Translation: `https://<host>/openai/deployments/<chat>/chat/completions?api-version=<chatver>`

## Run locally

```bash
# From the repo root, copy and fill in Azure creds:
cp .env.example .env

# Run — the backend auto-loads the shared repo-root .env:
cd backend-dotnet
dotnet restore
dotnet run
```

The server listens on `http://0.0.0.0:8080` by default. Check it:

```bash
curl http://localhost:8080/health   # {"status":"ok"}
```

## Run with Docker

From the repo root, `docker compose up --build` builds and runs both backends
plus the frontend. To build just this backend:

```bash
docker build -t transcribe-dotnet ./backend-dotnet
docker run --env-file .env -p 8080:8080 transcribe-dotnet
```

## Project layout

```
backend-dotnet/
├── Program.cs                     # Minimal API: /health + /ws/transcribe + /rest/transcribe wiring
├── Config/AzureOptions.cs         # Env-bound config + derived Azure URLs
├── Models/Messages.cs             # Protocol DTOs + camelCase serializer helpers
├── Realtime/
│   ├── AzureRealtimeClient.cs     # Upstream ClientWebSocket to Azure realtime
│   ├── TranslationService.cs      # Azure chat completions translation
│   ├── RestTranscriptionService.cs # Azure REST /audio/transcriptions client
│   └── TranscriptionSession.cs    # Per-connection orchestration
├── TranscribeApi.csproj
├── Dockerfile
└── appsettings.json
```
