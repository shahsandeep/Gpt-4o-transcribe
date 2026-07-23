"""Upstream client for the Azure OpenAI Realtime transcription WebSocket.

Responsibilities:
- open the upstream WS with the `api-key` header,
- configure the transcription session (`transcription_session.update`),
- append base64 PCM16 audio (`input_audio_buffer.append`),
- read upstream events and translate them into normalized `RealtimeEvent`s that
  the session layer forwards to the client.

Partial transcription deltas are accumulated per `item_id` so a `PARTIAL` event
always carries the full running text for that segment, not just the increment.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional

import websockets
from websockets.asyncio.client import ClientConnection

from .config import Settings

logger = logging.getLogger(__name__)


class EventKind(str, Enum):
    """Normalized upstream event categories the session layer cares about."""

    PARTIAL = "partial"
    FINAL = "final"
    SPEECH_STARTED = "speech_started"
    SPEECH_STOPPED = "speech_stopped"
    ERROR = "error"


@dataclass
class RealtimeEvent:
    """A normalized event emitted from the upstream read loop."""

    kind: EventKind
    item_id: Optional[str] = None
    text: Optional[str] = None
    message: Optional[str] = None


def _connect_kwargs(headers: dict[str, str]) -> dict[str, Any]:
    """Build the header kwarg for `websockets.connect`.

    Recent `websockets` releases renamed `extra_headers` -> `additional_headers`.
    Detect which the installed version accepts and use it.
    """
    try:
        params = inspect.signature(websockets.connect).parameters
    except (TypeError, ValueError):  # pragma: no cover - defensive
        params = {}
    if "additional_headers" in params:
        return {"additional_headers": headers}
    return {"extra_headers": headers}


class AzureRealtimeClient:
    """Manages one upstream Azure Realtime transcription WebSocket connection."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._ws: Optional[ClientConnection] = None
        # item_id -> accumulated partial transcript text
        self._partials: dict[str, str] = {}

    async def connect(self) -> None:
        """Open the upstream WebSocket. Raises on failure."""
        url = self._settings.realtime_ws_url
        headers = {"api-key": self._settings.azure_openai_api_key}
        logger.info("Connecting to Azure realtime WS: %s", url)
        self._ws = await websockets.connect(url, **_connect_kwargs(headers))

    async def configure(self, input_language: Optional[str]) -> None:
        """Send `transcription_session.update` to configure the session.

        `input_language` of None or "auto" omits the language field so Azure
        auto-detects.
        """
        transcription: dict[str, Any] = {
            "model": self._settings.azure_transcribe_deployment,
            "prompt": "",
        }
        if input_language and input_language.lower() != "auto":
            transcription["language"] = input_language

        session = {
            "input_audio_format": "pcm16",
            "input_audio_transcription": transcription,
            "turn_detection": {
                "type": "server_vad",
                "threshold": self._settings.vad_threshold,
                "prefix_padding_ms": self._settings.vad_prefix_padding_ms,
                "silence_duration_ms": self._settings.vad_silence_duration_ms,
            },
            "input_audio_noise_reduction": {"type": "near_field"},
        }
        await self._send({"type": "transcription_session.update", "session": session})

    async def append_audio(self, pcm16: bytes) -> None:
        """Base64-encode raw PCM16 bytes and append to the input audio buffer."""
        audio_b64 = base64.b64encode(pcm16).decode("ascii")
        await self._send({"type": "input_audio_buffer.append", "audio": audio_b64})

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._ws is None:
            raise RuntimeError("Azure realtime WS is not connected")
        await self._ws.send(json.dumps(payload))

    async def events(self):
        """Async generator yielding normalized :class:`RealtimeEvent`s.

        Iterates upstream messages until the socket closes. Malformed or
        uninteresting events are skipped silently.
        """
        if self._ws is None:
            raise RuntimeError("Azure realtime WS is not connected")

        async for raw in self._ws:
            if isinstance(raw, (bytes, bytearray)):
                # The realtime transcription surface speaks JSON text frames.
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("Skipping non-JSON upstream frame")
                continue

            normalized = self._normalize(event)
            if normalized is not None:
                yield normalized

    def _normalize(self, event: dict[str, Any]) -> Optional[RealtimeEvent]:
        """Map an Azure event dict to a RealtimeEvent, or None to ignore it."""
        etype = event.get("type")

        if etype == "conversation.item.input_audio_transcription.delta":
            item_id = event.get("item_id", "")
            delta = event.get("delta", "") or ""
            # Accumulate incremental delta text into the running partial.
            running = self._partials.get(item_id, "") + delta
            self._partials[item_id] = running
            return RealtimeEvent(EventKind.PARTIAL, item_id=item_id, text=running)

        if etype == "conversation.item.input_audio_transcription.completed":
            item_id = event.get("item_id", "")
            # Prefer Azure's authoritative full transcript; fall back to the
            # accumulated partial if the field is absent.
            transcript = event.get("transcript")
            if transcript is None:
                transcript = self._partials.get(item_id, "")
            # Segment finalized; drop its partial state.
            self._partials.pop(item_id, None)
            return RealtimeEvent(EventKind.FINAL, item_id=item_id, text=transcript)

        if etype == "input_audio_buffer.speech_started":
            return RealtimeEvent(EventKind.SPEECH_STARTED)

        if etype == "input_audio_buffer.speech_stopped":
            return RealtimeEvent(EventKind.SPEECH_STOPPED)

        if etype == "error":
            err = event.get("error") or {}
            message = err.get("message") if isinstance(err, dict) else str(err)
            return RealtimeEvent(EventKind.ERROR, message=message or "unknown upstream error")

        # transcription_session.created / .updated and everything else: ignore.
        return None

    async def close(self) -> None:
        """Close the upstream WebSocket. Safe to call multiple times."""
        ws, self._ws = self._ws, None
        if ws is None:
            return
        try:
            await ws.close()
        except Exception:  # noqa: BLE001 - best-effort cleanup on shutdown
            logger.debug("Ignoring error while closing upstream WS", exc_info=True)


__all__ = ["AzureRealtimeClient", "RealtimeEvent", "EventKind", "_connect_kwargs"]
