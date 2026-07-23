"""Protocol message models (frontend <-> backend).

These mirror the shapes in docs/WEBSOCKET_PROTOCOL.md. They are lightweight
helpers used for validation/serialization convenience; the wire format is plain
JSON, so the session code may also build dicts directly.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

# ---------- Client -> Server (text) ----------


class StartMessage(BaseModel):
    type: Literal["start"]
    inputLanguage: str = "auto"
    targetLanguage: str = "en"
    translate: bool = True


class StopMessage(BaseModel):
    type: Literal["stop"]


class UpdateMessage(BaseModel):
    type: Literal["update"]
    targetLanguage: Optional[str] = None
    translate: Optional[bool] = None


# ---------- Server -> Client (text) ----------


class ReadyMessage(BaseModel):
    type: Literal["ready"] = "ready"


class PartialTranscriptMessage(BaseModel):
    type: Literal["partial_transcript"] = "partial_transcript"
    itemId: str
    text: str


class FinalTranscriptMessage(BaseModel):
    type: Literal["final_transcript"] = "final_transcript"
    itemId: str
    text: str


class TranslationMessage(BaseModel):
    type: Literal["translation"] = "translation"
    itemId: str
    text: str
    partial: bool = False


class SpeechStartedMessage(BaseModel):
    type: Literal["speech_started"] = "speech_started"


class SpeechStoppedMessage(BaseModel):
    type: Literal["speech_stopped"] = "speech_stopped"


class InfoMessage(BaseModel):
    type: Literal["info"] = "info"
    message: str


class ErrorMessage(BaseModel):
    type: Literal["error"] = "error"
    message: str
