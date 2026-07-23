"""FastAPI application: /health and /ws/transcribe.

The WebSocket endpoint hands each accepted connection to a TranscriptionSession,
which relays between the client and the upstream Azure Realtime API.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .session import TranscriptionSession

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("app.main")

app = FastAPI(title="GPT-4o Transcribe Backend (Python)", version="1.0.0")

# Permissive CORS: the frontend is served from a different origin (:5173) and may
# be switched between backends at runtime.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}


@app.websocket("/ws/transcribe")
async def transcribe(websocket: WebSocket) -> None:
    """One transcription session per client WebSocket connection."""
    await websocket.accept()
    settings = get_settings()
    session = TranscriptionSession(websocket, settings)
    try:
        await session.run()
    except Exception:  # noqa: BLE001 - never let a session crash the server
        logger.exception("Unhandled error in transcription session")


if __name__ == "__main__":  # pragma: no cover - manual run convenience
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app", host="0.0.0.0", port=settings.python_port, reload=False
    )
