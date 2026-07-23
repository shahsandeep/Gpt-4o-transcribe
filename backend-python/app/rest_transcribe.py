"""Audio transcription via the Azure REST /audio/transcriptions endpoint.

The realtime WebSocket path streams PCM up and transcripts down. This module is
the independent REST path: a single POST of a complete audio file to Azure's
`/audio/transcriptions` endpoint, returning the whole transcript at once.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

import httpx

from .config import Settings

logger = logging.getLogger(__name__)


class TranscriptionError(Exception):
    """Raised when Azure returns a non-2xx response for a transcription request.

    Carries the HTTP status and a short reason so the endpoint can surface it.
    """

    def __init__(self, status: int, reason: str) -> None:
        self.status = status
        self.reason = reason
        super().__init__(f"azure transcription failed: {status} {reason}")


async def transcribe_audio(
    audio: bytes,
    filename: str,
    content_type: str,
    input_language: str | None,
    settings: Settings,
    client: Optional[httpx.AsyncClient] = None,
) -> tuple[str, int]:
    """POST `audio` to Azure's REST transcription endpoint.

    Sends multipart/form-data with `file`, `response_format=json`, and
    (only when `input_language` is set and not "auto") `language`. Returns
    `(transcript, elapsed_ms)` where `elapsed_ms` is the wall-clock duration of
    the Azure call. Raises `TranscriptionError` on any non-2xx response.
    """
    data: dict[str, str] = {"response_format": "json"}
    if input_language and input_language.strip().lower() != "auto":
        data["language"] = input_language.strip()

    files = {"file": (filename, audio, content_type)}
    headers = {"api-key": settings.azure_openai_api_key}

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=120.0)
    try:
        started = time.monotonic()
        resp = await client.post(
            settings.rest_transcribe_url,
            headers=headers,
            data=data,
            files=files,
        )
        elapsed_ms = int((time.monotonic() - started) * 1000)

        if resp.status_code < 200 or resp.status_code >= 300:
            reason = (resp.reason_phrase or "").strip()
            body = (resp.text or "").strip()
            if body:
                # Keep it short so it fits an error line.
                reason = (reason + " " + body).strip()[:300]
            raise TranscriptionError(resp.status_code, reason or "error")

        payload = resp.json()
        text = (payload.get("text") or "").strip()
        return text, elapsed_ms
    finally:
        if owns_client:
            await client.aclose()


__all__ = ["transcribe_audio", "TranscriptionError"]
