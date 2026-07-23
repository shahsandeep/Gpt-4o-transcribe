"""Per-connection session orchestration.

Bridges one client WebSocket to one upstream Azure Realtime transcription WS:

- forwards client binary frames (PCM16) up to Azure as audio appends,
- handles `start` / `stop` / `update` control messages,
- reads normalized upstream events and emits protocol messages to the client,
- translates finalized segments (fire-and-forget) and emits `translation`.

Two concurrent tasks run per session: a client-reader pump and an Azure-reader
pump. Either one ending (client disconnect, upstream close, `stop`) tears the
whole session down cleanly.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from .azure_realtime import AzureRealtimeClient, EventKind, RealtimeEvent
from .config import Settings
from .translator import translate

logger = logging.getLogger(__name__)


class TranscriptionSession:
    """Owns the lifecycle of a single client transcription session."""

    def __init__(self, client_ws: WebSocket, settings: Settings) -> None:
        self._ws = client_ws
        self._settings = settings
        self._azure = AzureRealtimeClient(settings)

        # Session config, populated by the `start` message.
        self._input_language: Optional[str] = None
        self._target_language: str = "en"
        self._translate: bool = True
        self._configured_language: Optional[str] = None  # what Azure is set to

        self._stopping = asyncio.Event()
        self._translation_tasks: set[asyncio.Task[Any]] = set()
        self._send_lock = asyncio.Lock()

    # ---- public entrypoint ----

    async def run(self) -> None:
        """Drive the whole session. Assumes the client WS is already accepted."""
        try:
            await self._azure.connect()
            # Configure with auto-detect first so we can signal `ready` per the
            # protocol sequence (ready precedes the client's `start`). If `start`
            # later names a concrete language we reconfigure.
            await self._azure.configure(input_language=None)
            self._configured_language = None
            await self._send({"type": "ready"})
        except Exception as exc:  # noqa: BLE001 - report and bail
            logger.exception("Failed to establish Azure upstream session")
            await self._send_safe(
                {"type": "error", "message": f"azure connection failed: {exc}"}
            )
            await self._cleanup()
            return

        client_task = asyncio.create_task(self._pump_client(), name="pump-client")
        azure_task = asyncio.create_task(self._pump_azure(), name="pump-azure")

        try:
            # First completed task ends the session (disconnect, stop, or error).
            done, pending = await asyncio.wait(
                {client_task, azure_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            # Surface any non-cancellation exception for logging.
            for task in done:
                exc = task.exception()
                if exc is not None:
                    logger.debug("Session pump ended with: %r", exc)
        finally:
            await self._cleanup()

    # ---- client -> azure pump ----

    async def _pump_client(self) -> None:
        """Read frames from the client and act on them."""
        while not self._stopping.is_set():
            try:
                message = await self._ws.receive()
            except WebSocketDisconnect:
                logger.info("Client disconnected")
                return

            if message.get("type") == "websocket.disconnect":
                logger.info("Client disconnect frame received")
                return

            # Binary frame -> raw PCM16 audio.
            data = message.get("bytes")
            if data is not None:
                try:
                    await self._azure.append_audio(data)
                except Exception:  # noqa: BLE001 - upstream may have dropped
                    logger.exception("Failed to append audio upstream")
                    return
                continue

            # Text frame -> JSON control message.
            text = message.get("text")
            if text is not None:
                await self._handle_control(text)
                if self._stopping.is_set():
                    return

    async def _handle_control(self, raw: str) -> None:
        """Handle a client text control message (start/stop/update)."""
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await self._send_safe(
                {"type": "error", "message": "invalid JSON control message"}
            )
            return

        mtype = msg.get("type")

        if mtype == "start":
            self._input_language = msg.get("inputLanguage")
            self._target_language = msg.get("targetLanguage") or self._target_language
            self._translate = bool(msg.get("translate", True))
            await self._maybe_reconfigure_language()
            return

        if mtype == "update":
            changed: list[str] = []
            if "targetLanguage" in msg and msg["targetLanguage"]:
                self._target_language = msg["targetLanguage"]
                changed.append(f"target language changed to {self._target_language}")
            if "translate" in msg and msg["translate"] is not None:
                self._translate = bool(msg["translate"])
                changed.append(
                    "translation enabled" if self._translate else "translation disabled"
                )
            for note in changed:
                await self._send_safe({"type": "info", "message": note})
            return

        if mtype == "stop":
            self._stopping.set()
            return

        # Unknown control type: non-fatal notice.
        await self._send_safe(
            {"type": "info", "message": f"ignoring unknown message type: {mtype}"}
        )

    async def _maybe_reconfigure_language(self) -> None:
        """Re-send session config if `start` specified a concrete input language.

        Azure was initially configured with auto-detect so we could send `ready`
        before `start` arrived. If the client asked for a specific language, and
        it differs from what Azure currently uses, push an updated session config.
        """
        lang = self._input_language
        normalized = None if (not lang or lang.lower() == "auto") else lang
        if normalized == self._configured_language:
            return
        try:
            await self._azure.configure(input_language=normalized)
            self._configured_language = normalized
        except Exception:  # noqa: BLE001 - non-fatal; keep auto config
            logger.exception("Failed to reconfigure input language")
            await self._send_safe(
                {"type": "info", "message": "could not apply input language; using auto-detect"}
            )

    # ---- azure -> client pump ----

    async def _pump_azure(self) -> None:
        """Read normalized upstream events and emit protocol messages."""
        try:
            async for event in self._azure.events():
                await self._emit_event(event)
                if self._stopping.is_set():
                    return
        except Exception:  # noqa: BLE001 - upstream closed or errored
            logger.info("Azure upstream read loop ended", exc_info=True)

    async def _emit_event(self, event: RealtimeEvent) -> None:
        if event.kind == EventKind.PARTIAL:
            await self._send_safe(
                {
                    "type": "partial_transcript",
                    "itemId": event.item_id,
                    "text": event.text or "",
                }
            )
        elif event.kind == EventKind.FINAL:
            text = event.text or ""
            await self._send_safe(
                {"type": "final_transcript", "itemId": event.item_id, "text": text}
            )
            # Translate finalized segments without blocking transcript delivery.
            if self._translate and text.strip():
                self._spawn_translation(event.item_id or "", text)
        elif event.kind == EventKind.SPEECH_STARTED:
            await self._send_safe({"type": "speech_started"})
        elif event.kind == EventKind.SPEECH_STOPPED:
            await self._send_safe({"type": "speech_stopped"})
        elif event.kind == EventKind.ERROR:
            await self._send_safe(
                {"type": "error", "message": event.message or "upstream error"}
            )

    def _spawn_translation(self, item_id: str, text: str) -> None:
        """Fire-and-forget translation task, tagged with the segment's itemId."""
        task = asyncio.create_task(
            self._translate_and_send(item_id, text), name=f"translate-{item_id}"
        )
        self._translation_tasks.add(task)
        task.add_done_callback(self._translation_tasks.discard)

    async def _translate_and_send(self, item_id: str, text: str) -> None:
        target = self._target_language
        try:
            translated = await translate(text, target, self._settings)
        except Exception as exc:  # noqa: BLE001 - surface but don't crash session
            logger.exception("Translation failed for item %s", item_id)
            await self._send_safe(
                {"type": "error", "message": f"translation failed: {exc}"}
            )
            return
        await self._send_safe(
            {
                "type": "translation",
                "itemId": item_id,
                "text": translated,
                "partial": False,
            }
        )

    # ---- send helpers ----

    async def _send(self, payload: dict[str, Any]) -> None:
        """Send a JSON message to the client (raises on failure)."""
        async with self._send_lock:
            await self._ws.send_text(json.dumps(payload))

    async def _send_safe(self, payload: dict[str, Any]) -> None:
        """Send a JSON message, swallowing errors (client may have vanished)."""
        if self._ws.client_state != WebSocketState.CONNECTED:
            return
        try:
            await self._send(payload)
        except Exception:  # noqa: BLE001 - client gone mid-send
            logger.debug("Failed to send message to client", exc_info=True)

    # ---- teardown ----

    async def _cleanup(self) -> None:
        """Tear down upstream socket, translation tasks, and the client WS."""
        # Cancel any in-flight translations.
        for task in list(self._translation_tasks):
            task.cancel()
        if self._translation_tasks:
            await asyncio.gather(*self._translation_tasks, return_exceptions=True)
            self._translation_tasks.clear()

        await self._azure.close()

        if self._ws.client_state == WebSocketState.CONNECTED:
            try:
                await self._ws.close()
            except Exception:  # noqa: BLE001 - already closing
                logger.debug("Ignoring error closing client WS", exc_info=True)


__all__ = ["TranscriptionSession"]
