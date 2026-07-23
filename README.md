# Realtime Transcription + Translation with Azure GPT-4o

Live speech-to-text with live translation, powered by **Azure OpenAI
`gpt-4o-transcribe`** (realtime WebSocket transcription) and **`gpt-4o`** (for
translation). One React frontend, **two interchangeable backends** — Python and
.NET — that speak the exact same WebSocket protocol, so you can switch between
them from a dropdown in the UI.

```
┌────────────┐   PCM16 24kHz (binary WS)   ┌──────────────┐   input_audio_buffer.append   ┌─────────────────────┐
│            │ ─────────────────────────▶  │   Backend    │ ───────────────────────────▶  │  Azure OpenAI        │
│  React UI  │                             │  (Python OR  │                               │  Realtime transcribe │
│            │ ◀───── transcript JSON ────  │   .NET)      │ ◀──── delta / completed ────  │  (gpt-4o-transcribe) │
└────────────┘   partial + final + trans.  └──────┬───────┘                               └─────────────────────┘
                                                   │  POST chat/completions (translate segment)
                                                   ▼
                                          ┌─────────────────────┐
                                          │  Azure OpenAI chat   │
                                          │  (gpt-4o) translate  │
                                          └─────────────────────┘
```

## Features

- **Realtime transcription** streamed from `gpt-4o-transcribe` over WebSocket.
- **Live partial transcripts** — words appear as you speak, then lock in as final.
- **Live translation** of every finalized segment into the target language via `gpt-4o`.
- **Input source picker** — choose which microphone/input device to use.
- **Input language** selection (or auto-detect) and **target language** selection,
  changeable mid-session.
- **Two backends, one protocol** — switch Python ⇆ .NET from the UI; identical behavior.
- **Transcript export** — download the full session as `.txt`, `.srt`, or `.json`.
- **Voice-activity indicator** driven by Azure server-side VAD.

## Repository layout

```
.
├── README.md                 # you are here
├── docs/
│   ├── WEBSOCKET_PROTOCOL.md  # the frontend↔backend contract (both backends obey it)
│   ├── AZURE_SETUP.md         # create the Azure resource + deployments
│   └── ARCHITECTURE.md        # how the pieces fit, design decisions
├── .env.example              # shared Azure config for both backends
├── docker-compose.yml        # run both backends + frontend together
├── backend-python/           # FastAPI backend
├── backend-dotnet/           # ASP.NET Core (.NET 8) backend
└── frontend/                 # Vite + React + TypeScript UI
```

## Quickstart (no Docker)

You need **one backend** (Python *or* .NET) plus the **frontend**. Run both
backends only if you want to flip between them with the in-app switcher. Each
command below runs in its own terminal and keeps running.

### Prerequisites

- **Python backend:** Python 3.11+
- **.NET backend:** .NET 8 SDK
- **Frontend:** Node 20+ (includes npm)

### Step 1 — Set up Azure and credentials

Follow [`docs/AZURE_SETUP.md`](docs/AZURE_SETUP.md) to create an Azure OpenAI
resource with a `gpt-4o-transcribe` deployment and a `gpt-4o` deployment. Then:

```bash
cp .env.example .env
# edit .env — set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and the deployment names
```

Both backends read this **same repo-root `.env`** automatically — you do not have
to export anything by hand.

### Step 2 — Start a backend (pick ONE)

**Option A — Python (port 8000):**

```bash
cd backend-python
python -m venv .venv
source .venv/bin/activate            # macOS / Linux
# .venv\Scripts\Activate.ps1         # Windows PowerShell
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**Option B — .NET (port 8080):**

```bash
cd backend-dotnet
dotnet run
```

Leave the backend running. Sanity check in another terminal:
`curl http://localhost:8000/health` (or `:8080`) → `{"status":"ok"}`.

### Step 3 — Start the frontend (port 5173)

```bash
cd frontend
npm install
npm run dev
```

### Step 4 — Use it

Open **http://localhost:5173**, allow microphone access, pick your input device
and languages, and press **Start**. In the backend switcher, select the backend
you started (Python `:8000` or .NET `:8080`). If you only started one backend,
select that one — the other will just fail to connect if picked.

> The mic API requires a secure context. `http://localhost` counts as secure, so
> local dev works. If you serve the frontend from a non-localhost host, use HTTPS.

### Per-component docs

| Component | Dev command | Port | README |
|-----------|-------------|------|--------|
| Python backend | `uvicorn app.main:app --host 0.0.0.0 --port 8000` | 8000 | [backend-python/README.md](backend-python/README.md) |
| .NET backend | `dotnet run` | 8080 | [backend-dotnet/README.md](backend-dotnet/README.md) |
| Frontend | `npm run dev` | 5173 | [frontend/README.md](frontend/README.md) |

## Quickstart (Docker, optional)

If you *do* have Docker with Compose, everything runs with one command:

```bash
cp .env.example .env   # fill in Azure creds first
docker compose up --build
```

Then open **http://localhost:5173**. This builds and runs both backends and the
frontend together.

## How it works

The browser captures microphone audio, resamples it to **PCM16 / 24 kHz / mono**
in an `AudioWorklet`, and streams it as binary WebSocket frames to the backend.
The backend relays that audio to the Azure Realtime transcription endpoint, which
streams back partial (`delta`) and final (`completed`) transcripts. On each
finalized segment the backend calls the `gpt-4o` chat deployment to translate it,
then forwards transcript and translation to the UI. The full message contract
lives in [`docs/WEBSOCKET_PROTOCOL.md`](docs/WEBSOCKET_PROTOCOL.md) — both
backends implement it byte-for-byte so the frontend is backend-agnostic.

## Security notes

- Azure credentials live only in the backend (in `.env`, never committed and
  never shipped to the browser). The frontend only ever talks to your backend.
- `.env` is git-ignored. Rotate keys with the second Azure key if one leaks.
- For production, terminate TLS in front of the backends (`wss://`) and restrict
  CORS to your frontend origin.

## Requirements

- An Azure OpenAI resource with `gpt-4o-transcribe` and `gpt-4o` deployments.
- Docker (for the compose path), or: Python 3.11+, .NET 8 SDK, Node 20+.
- A Chromium- or Firefox-based browser (microphone + AudioWorklet support). The
  mic API requires `https://` or `http://localhost`.
