# Python backend — GPT-4o realtime transcription + translation

FastAPI service that relays between the browser and Azure OpenAI:

- accepts a client WebSocket at `WS /ws/transcribe`,
- opens an upstream WebSocket to the **Azure OpenAI Realtime transcription API**,
- forwards microphone PCM16 audio up and streams transcripts down,
- translates each finalized segment via the **Azure chat completions REST API**.

It implements the shared frontend↔backend contract in
[`../docs/WEBSOCKET_PROTOCOL.md`](../docs/WEBSOCKET_PROTOCOL.md) exactly, so the
React frontend works against this backend or the .NET one by only changing the
base URL.

## Endpoints

| Method | Path             | Purpose                                             |
|--------|------------------|-----------------------------------------------------|
| GET    | `/health`        | Liveness probe. Returns `{"status": "ok"}`.         |
| WS     | `/ws/transcribe` | One transcription session per connection.           |
| POST   | `/rest/transcribe` | Transcribe an uploaded audio file (REST path).    |

### WebSocket messages

- **Client → server:** binary frames = raw PCM16 (16-bit LE, 24 kHz, mono) audio;
  text frames = `start`, `stop`, `update` JSON control messages.
- **Server → client:** `ready`, `partial_transcript`, `final_transcript`,
  `translation`, `speech_started`, `speech_stopped`, `info`, `error`.

See the protocol doc for the exact shapes. `itemId` correlates a transcript with
its translation.

### REST transcription (`POST /rest/transcribe`)

An independent, non-streaming path for Azure deployments that expose
transcription over the REST `/audio/transcriptions` endpoint. The frontend
records audio into a WAV and POSTs it; the backend relays the bytes to Azure and
(optionally) translates the transcript. See
[`../docs/REST_API.md`](../docs/REST_API.md) for the full contract.

`Content-Type: multipart/form-data` with these fields:

| Field            | Required | Description                                                       |
|------------------|----------|-------------------------------------------------------------------|
| `file`           | yes      | Audio file (frontend sends mono 16-bit PCM WAV @ 24 kHz).         |
| `inputLanguage`  | no       | ISO-639-1 code of the spoken audio. Omit or send `auto` to detect. |
| `targetLanguage` | no       | ISO-639-1 code to translate into (required when `translate=true`). |
| `translate`      | no       | `true` / `false` (default `false`). Translates via the chat deployment. |

Response `200 application/json`:

```jsonc
{
  "transcript": "hello world",
  "translation": "hola mundo",   // null when translate=false or transcript empty
  "transcribeMs": 812,            // server-measured Azure transcription time
  "translateMs": 143              // server-measured translation time (0 when skipped)
}
```

A transcription failure returns `502` with `{"error": "..."}`. A translation
failure is non-fatal: the transcript is still returned with `"translation": null`
and a `"translateError"` field.

## Configuration

Read from environment variables (via the repo-root `.env` — see
[`../docs/AZURE_SETUP.md`](../docs/AZURE_SETUP.md)). For local dev the app also
loads `../.env` and `./.env` automatically.

| Variable                      | Default               | Description                                   |
|-------------------------------|-----------------------|-----------------------------------------------|
| `AZURE_OPENAI_ENDPOINT`       | —                     | `https://<resource>.openai.azure.com`         |
| `AZURE_OPENAI_API_KEY`        | —                     | Resource key (KEY 1 or KEY 2)                 |
| `AZURE_TRANSCRIBE_DEPLOYMENT` | `gpt-4o-transcribe`   | Realtime transcription **deployment name**    |
| `AZURE_REALTIME_API_VERSION`  | `2025-04-01-preview`  | Realtime API version                          |
| `AZURE_TRANSCRIBE_REST_API_VERSION` | `2025-04-01-preview` | REST `/audio/transcriptions` API version |
| `AZURE_CHAT_DEPLOYMENT`       | `gpt-4o`              | Chat deployment used for translation          |
| `AZURE_CHAT_API_VERSION`      | `2024-10-21`         | Chat completions API version                  |
| `VAD_THRESHOLD`               | `0.5`                 | Server VAD sensitivity                        |
| `VAD_PREFIX_PADDING_MS`       | `300`                 | Server VAD prefix padding (ms)                |
| `VAD_SILENCE_DURATION_MS`     | `500`                 | Server VAD silence duration (ms)              |
| `PYTHON_PORT`                 | `8000`                | Port for local `__main__` run                 |

Derived at runtime:

- Realtime WS URL:
  `wss://<resource>.openai.azure.com/openai/realtime?api-version=<ver>&intent=transcription`
- Translation REST URL:
  `https://<resource>.openai.azure.com/openai/deployments/<chat>/chat/completions?api-version=<chatver>`
- REST transcription URL:
  `https://<resource>.openai.azure.com/openai/deployments/<transcribe>/audio/transcriptions?api-version=<restver>`

## Install & run (local)

```bash
python -m venv .venv
. .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Fill in ../.env (repo root) with your Azure credentials first.
uvicorn app.main:app --reload --port 8000
```

`GET http://localhost:8000/health` should return `{"status":"ok"}`. Point the
frontend's Python backend URL at `ws://localhost:8000/ws/transcribe`.

## Run with Docker

From the repo root (builds both backends + frontend):

```bash
cp .env.example .env    # fill in Azure creds
docker compose up --build
```

Or just this backend:

```bash
docker build -t gpt4o-backend-python .
docker run --rm -p 8000:8000 --env-file ../.env gpt4o-backend-python
```

## Tests

Offline unit tests (no network, no Azure) cover URL derivation, partial-delta
accumulation, and the language-code→name mapping:

```bash
pytest -q
```

## Layout

```
app/
  config.py           # pydantic-settings config + derived Azure URLs
  models.py           # protocol message models
  azure_realtime.py   # upstream Azure Realtime WS client + event normalization
  translator.py       # Azure chat-completions translation + ISO→name map
  rest_transcribe.py  # Azure REST /audio/transcriptions client
  session.py          # per-connection orchestration (client ↔ Azure relay)
  main.py             # FastAPI app: /health + /ws/transcribe + /rest/transcribe, CORS
tests/
  test_protocol.py       # offline unit tests (realtime + translation)
  test_rest_transcribe.py # offline unit tests (REST URL + flag parsing)
```
