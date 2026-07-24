"""FastAPI application: /health and /ws/transcribe.

The WebSocket endpoint hands each accepted connection to a TranscriptionSession,
which relays between the client and the upstream Azure Realtime API.
"""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import FastAPI, File, Form, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .audio_enhance import enhance_wav
from .config import get_settings
from .rest_transcribe import TranscriptionError, join_turns, transcribe_audio
from .session import TranscriptionSession
from .translator import translate

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


def _parse_bool(value: str | None) -> bool:
    """Parse a form flag: "true" (case-insensitive) is True, everything else False."""
    return (value or "").strip().lower() == "true"


@app.post("/rest/transcribe")
async def rest_transcribe(
    file: UploadFile = File(...),
    inputLanguage: str | None = Form(None),  # noqa: N803 - matches wire contract
    targetLanguage: str | None = Form(None),  # noqa: N803 - matches wire contract
    translate_flag: str | None = Form(None, alias="translate"),
    enhance_flag: str | None = Form(None, alias="enhance"),
) -> JSONResponse:
    """Transcribe an uploaded audio file via Azure REST, optionally translating."""
    settings = get_settings()
    audio = await file.read()

    # Optional server-side ffmpeg enhancement before upload (graceful fallback).
    enhanced = False
    if _parse_bool(enhance_flag):
        audio, enhanced = await enhance_wav(audio, settings.audio_enhance_filters)

    try:
        turns, transcribe_ms = await transcribe_audio(
            audio,
            file.filename or "audio.wav",
            file.content_type or "application/octet-stream",
            inputLanguage,
            settings,
        )
    except TranscriptionError as exc:
        return JSONResponse(status_code=502, content={"error": str(exc)})
    except Exception as exc:  # noqa: BLE001 - surface any upstream failure as 502
        logger.exception("REST transcription failed")
        return JSONResponse(
            status_code=502,
            content={"error": f"azure transcription failed: {exc}"},
        )

    transcript = join_turns(turns, "text")
    result: dict[str, object] = {
        "transcript": transcript,
        "translation": None,
        "enhanced": enhanced,
        # One entry per speaker turn (speaker is null for non-diarized audio).
        "segments": [
            {"speaker": t.get("speaker"), "text": t.get("text", ""), "translation": None}
            for t in turns
        ],
        "transcribeMs": transcribe_ms,
        "translateMs": 0,
    }

    if _parse_bool(translate_flag) and transcript:
        started = time.monotonic()
        target = targetLanguage or ""
        # Translate each speaker turn separately so translations align per turn.
        outcomes = await asyncio.gather(
            *(translate(t["text"], target, settings) for t in turns),
            return_exceptions=True,
        )
        result["translateMs"] = int((time.monotonic() - started) * 1000)
        segments = result["segments"]
        translate_error: str | None = None
        for i, outcome in enumerate(outcomes):
            if isinstance(outcome, Exception):
                logger.exception("REST turn translation failed", exc_info=outcome)
                if translate_error is None:
                    translate_error = f"translation failed: {outcome}"
            else:
                turns[i]["translation"] = outcome
                segments[i]["translation"] = outcome
        result["translation"] = join_turns(turns, "translation") or None
        if translate_error is not None:
            result["translateError"] = translate_error

    return JSONResponse(content=result)


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
