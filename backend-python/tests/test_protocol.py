"""Offline unit tests (no network, no Azure).

Covers:
- config URL derivation (endpoint -> realtime wss URL, endpoint -> chat REST URL),
- partial-delta accumulation in AzureRealtimeClient._normalize,
- ISO language-code -> name mapping.
"""

from __future__ import annotations

from app.azure_realtime import AzureRealtimeClient, EventKind
from app.config import Settings
from app.translator import language_name


def _settings(**overrides) -> Settings:
    base = dict(
        AZURE_OPENAI_ENDPOINT="https://my-res.openai.azure.com",
        AZURE_OPENAI_API_KEY="secret",
        AZURE_TRANSCRIBE_DEPLOYMENT="gpt-4o-transcribe",
        AZURE_REALTIME_API_VERSION="2025-04-01-preview",
        AZURE_CHAT_DEPLOYMENT="gpt-4o",
        AZURE_CHAT_API_VERSION="2024-10-21",
    )
    base.update(overrides)
    return Settings(**base)


# ---------- URL derivation ----------


def test_realtime_ws_url_basic():
    s = _settings()
    assert s.realtime_ws_url == (
        "wss://my-res.openai.azure.com/openai/realtime"
        "?api-version=2025-04-01-preview&intent=transcription"
    )


def test_realtime_ws_url_strips_trailing_slash():
    s = _settings(AZURE_OPENAI_ENDPOINT="https://my-res.openai.azure.com/")
    assert s.realtime_ws_url.startswith("wss://my-res.openai.azure.com/openai/realtime")
    assert "azure.com//openai" not in s.realtime_ws_url


def test_realtime_ws_url_custom_version():
    s = _settings(AZURE_REALTIME_API_VERSION="2099-01-01-preview")
    assert "api-version=2099-01-01-preview" in s.realtime_ws_url
    assert "intent=transcription" in s.realtime_ws_url


def test_translation_url_basic():
    s = _settings()
    assert s.translation_url == (
        "https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions"
        "?api-version=2024-10-21"
    )


def test_translation_url_custom_deployment():
    s = _settings(AZURE_CHAT_DEPLOYMENT="gpt-4o-mini", AZURE_CHAT_API_VERSION="2025-01-01")
    assert s.translation_url == (
        "https://my-res.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions"
        "?api-version=2025-01-01"
    )


def test_endpoint_scheme_normalization():
    # Even if someone put a scheme-less or wss endpoint, host is extracted cleanly.
    for ep in (
        "https://my-res.openai.azure.com",
        "my-res.openai.azure.com",
        "wss://my-res.openai.azure.com/",
    ):
        s = _settings(AZURE_OPENAI_ENDPOINT=ep)
        assert s.realtime_ws_url.startswith("wss://my-res.openai.azure.com/openai/realtime")
        assert s.translation_url.startswith(
            "https://my-res.openai.azure.com/openai/deployments/"
        )


# ---------- partial-delta accumulation ----------


def test_partial_delta_accumulation():
    client = AzureRealtimeClient(_settings())

    e1 = client._normalize(
        {
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item_1",
            "delta": "hello",
        }
    )
    assert e1 is not None
    assert e1.kind == EventKind.PARTIAL
    assert e1.item_id == "item_1"
    assert e1.text == "hello"

    e2 = client._normalize(
        {
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item_1",
            "delta": " world",
        }
    )
    assert e2.text == "hello world"  # running concatenation


def test_partial_accumulation_is_per_item():
    client = AzureRealtimeClient(_settings())
    client._normalize(
        {
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "a",
            "delta": "foo",
        }
    )
    e = client._normalize(
        {
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "b",
            "delta": "bar",
        }
    )
    # Different item ids accumulate independently.
    assert e.text == "bar"


def test_completed_uses_transcript_and_clears_partial():
    client = AzureRealtimeClient(_settings())
    client._normalize(
        {
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item_1",
            "delta": "hel",
        }
    )
    final = client._normalize(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item_1",
            "transcript": "hello world",
        }
    )
    assert final.kind == EventKind.FINAL
    assert final.text == "hello world"
    # Partial state for the item is cleared after completion.
    assert "item_1" not in client._partials


def test_completed_falls_back_to_accumulated_partial():
    client = AzureRealtimeClient(_settings())
    client._normalize(
        {
            "type": "conversation.item.input_audio_transcription.delta",
            "item_id": "item_1",
            "delta": "partial only",
        }
    )
    final = client._normalize(
        {
            "type": "conversation.item.input_audio_transcription.completed",
            "item_id": "item_1",
            # no transcript field
        }
    )
    assert final.text == "partial only"


def test_speech_and_error_normalization():
    client = AzureRealtimeClient(_settings())
    assert (
        client._normalize({"type": "input_audio_buffer.speech_started"}).kind
        == EventKind.SPEECH_STARTED
    )
    assert (
        client._normalize({"type": "input_audio_buffer.speech_stopped"}).kind
        == EventKind.SPEECH_STOPPED
    )
    err = client._normalize({"type": "error", "error": {"message": "boom"}})
    assert err.kind == EventKind.ERROR
    assert err.message == "boom"


def test_uninteresting_events_ignored():
    client = AzureRealtimeClient(_settings())
    assert client._normalize({"type": "transcription_session.created"}) is None
    assert client._normalize({"type": "transcription_session.updated"}) is None
    assert client._normalize({"type": "something.else"}) is None


# ---------- language mapping ----------


def test_language_name_known_codes():
    assert language_name("es") == "Spanish"
    assert language_name("fr") == "French"
    assert language_name("EN") == "English"  # case-insensitive
    assert language_name(" de ") == "German"  # trimmed


def test_language_name_unknown_falls_back_to_code():
    assert language_name("xx") == "xx"
    assert language_name("zz-ZZ") == "zz-ZZ"


def test_language_name_empty_defaults_english():
    assert language_name("") == "English"
