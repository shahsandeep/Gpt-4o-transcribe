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


def parse_segments(payload: dict) -> list[dict]:
    """Turn an Azure transcription response into a list of speaker turns.

    Handles the flat `json` shape (`{"text": ...}`) and the `diarized_json`
    shape (`{"segments": [{"speaker": "A", "text": ...}, ...]}`) produced by
    gpt-4o-transcribe-diarize. Consecutive segments from the same speaker are
    merged into one turn. Falls back to a single speaker-less turn built from
    the top-level `text` when there are no usable segments (Azure sometimes
    returns only that even for diarized_json).

    Returns a list of `{"speaker": str | None, "text": str}` (empty if nothing).
    """
    turns: list[dict] = []
    segments = payload.get("segments")
    if isinstance(segments, list) and segments:
        for seg in segments:
            if not isinstance(seg, dict):
                continue
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            speaker = seg.get("speaker")
            if turns and turns[-1]["speaker"] == speaker:
                turns[-1]["text"] += " " + text
            else:
                turns.append({"speaker": speaker, "text": text})

    if turns:
        return turns

    text = (payload.get("text") or "").strip()
    return [{"speaker": None, "text": text}] if text else []


def join_turns(turns: list[dict], field: str = "text") -> str:
    """Join speaker turns into labeled lines ("A: ...\\nB: ...")."""
    lines: list[str] = []
    for turn in turns:
        value = (turn.get(field) or "").strip()
        if not value:
            continue
        speaker = turn.get("speaker")
        lines.append(f"{speaker}: {value}" if speaker else value)
    return "\n".join(lines).strip()


def format_transcript(payload: dict) -> str:
    """Convenience: parse then join into labeled transcript text."""
    return join_turns(parse_segments(payload))


async def transcribe_audio(
    audio: bytes,
    filename: str,
    content_type: str,
    input_language: str | None,
    settings: Settings,
    client: Optional[httpx.AsyncClient] = None,
) -> tuple[list[dict], int]:
    """POST `audio` to Azure's REST transcription endpoint.

    Sends multipart/form-data with `file`, the configured `response_format`, and
    (only when `input_language` is set and not "auto") `language`. Returns
    `(turns, elapsed_ms)` where `turns` is a list of `{"speaker", "text"}` (one
    per speaker turn; a single speaker-less turn for non-diarized responses) and
    `elapsed_ms` is the wall-clock duration of the Azure call. Raises
    `TranscriptionError` on any non-2xx response.
    """
    data: dict[str, str] = {
        "response_format": settings.azure_transcribe_response_format or "json"
    }
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
        turns = parse_segments(payload) if isinstance(payload, dict) else []
        return turns, elapsed_ms
    finally:
        if owns_client:
            await client.aclose()


__all__ = [
    "transcribe_audio",
    "parse_segments",
    "join_turns",
    "format_transcript",
    "TranscriptionError",
]
