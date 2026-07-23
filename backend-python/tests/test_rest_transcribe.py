"""Offline unit tests for the REST transcription path (no network, no Azure).

Covers:
- config URL derivation (endpoint + deployment + rest api version -> REST URL),
- the "true"/"false" translate flag parsing helper.
"""

from __future__ import annotations

from app.config import Settings
from app.main import _parse_bool
from app.rest_transcribe import format_transcript, join_turns, parse_segments


def _settings(**overrides) -> Settings:
    base = dict(
        AZURE_OPENAI_ENDPOINT="https://my-res.openai.azure.com",
        AZURE_OPENAI_API_KEY="secret",
        AZURE_TRANSCRIBE_DEPLOYMENT="gpt-4o-transcribe",
        AZURE_TRANSCRIBE_REST_API_VERSION="2025-04-01-preview",
    )
    base.update(overrides)
    return Settings(**base)


# ---------- REST URL derivation ----------


def test_rest_transcribe_url_basic():
    s = _settings()
    assert s.rest_transcribe_url == (
        "https://my-res.openai.azure.com/openai/deployments/"
        "gpt-4o-transcribe/audio/transcriptions"
        "?api-version=2025-04-01-preview"
    )


def test_rest_transcribe_url_custom_deployment_and_version():
    s = _settings(
        AZURE_TRANSCRIBE_DEPLOYMENT="whisper",
        AZURE_TRANSCRIBE_REST_API_VERSION="2099-01-01",
    )
    assert s.rest_transcribe_url == (
        "https://my-res.openai.azure.com/openai/deployments/"
        "whisper/audio/transcriptions"
        "?api-version=2099-01-01"
    )


def test_rest_transcribe_url_default_version():
    # Default matches the documented default.
    s = Settings(
        AZURE_OPENAI_ENDPOINT="https://my-res.openai.azure.com",
        AZURE_OPENAI_API_KEY="secret",
    )
    assert "api-version=2025-04-01-preview" in s.rest_transcribe_url


def test_rest_transcribe_url_strips_scheme_and_trailing_slash():
    for ep in (
        "https://my-res.openai.azure.com",
        "my-res.openai.azure.com",
        "wss://my-res.openai.azure.com/",
    ):
        s = _settings(AZURE_OPENAI_ENDPOINT=ep)
        assert s.rest_transcribe_url.startswith(
            "https://my-res.openai.azure.com/openai/deployments/"
        )
        assert "azure.com//openai" not in s.rest_transcribe_url


# ---------- translate flag parsing ----------


def test_parse_bool_true_variants():
    assert _parse_bool("true") is True
    assert _parse_bool("TRUE") is True
    assert _parse_bool(" True ") is True


def test_parse_bool_false_variants():
    assert _parse_bool("false") is False
    assert _parse_bool("FALSE") is False
    assert _parse_bool("0") is False
    assert _parse_bool("yes") is False


def test_parse_bool_default_none_and_empty():
    assert _parse_bool(None) is False
    assert _parse_bool("") is False


# ---------- cognitiveservices host + diarize deployment ----------


def test_rest_url_cognitiveservices_host_and_diarize():
    s = _settings(
        AZURE_OPENAI_ENDPOINT="https://mycompany.cognitiveservices.azure.com",
        AZURE_TRANSCRIBE_DEPLOYMENT="gpt-4o-transcribe-diarize",
        AZURE_TRANSCRIBE_REST_API_VERSION="2025-03-01-preview",
    )
    assert s.rest_transcribe_url == (
        "https://mycompany.cognitiveservices.azure.com/openai/deployments/"
        "gpt-4o-transcribe-diarize/audio/transcriptions"
        "?api-version=2025-03-01-preview"
    )


def test_response_format_default_and_override():
    assert _settings().azure_transcribe_response_format == "json"
    s = _settings(AZURE_TRANSCRIBE_RESPONSE_FORMAT="diarized_json")
    assert s.azure_transcribe_response_format == "diarized_json"


# ---------- transcript formatting (flat + diarized) ----------


def test_format_transcript_flat_json():
    assert format_transcript({"text": "  hello world  "}) == "hello world"


def test_format_transcript_diarized_groups_consecutive_speakers():
    payload = {
        "text": "ignored fallback",
        "segments": [
            {"speaker": "A", "text": "Hi there."},
            {"speaker": "A", "text": "How are you?"},
            {"speaker": "B", "text": "Good, thanks."},
        ],
    }
    assert format_transcript(payload) == "A: Hi there. How are you?\nB: Good, thanks."


def test_format_transcript_diarized_no_speaker_labels():
    payload = {"segments": [{"text": "one"}, {"text": "two"}]}
    assert format_transcript(payload) == "one two"


def test_format_transcript_falls_back_to_text_when_segments_empty():
    assert format_transcript({"text": "fallback", "segments": []}) == "fallback"


def test_format_transcript_missing_everything():
    assert format_transcript({}) == ""


# ---------- structured turns (diarization) ----------


def test_parse_segments_merges_and_keeps_speakers():
    payload = {
        "segments": [
            {"speaker": "A", "text": "Hi there."},
            {"speaker": "A", "text": "How are you?"},
            {"speaker": "B", "text": "Good, thanks."},
        ]
    }
    assert parse_segments(payload) == [
        {"speaker": "A", "text": "Hi there. How are you?"},
        {"speaker": "B", "text": "Good, thanks."},
    ]


def test_parse_segments_flat_json_single_turn():
    assert parse_segments({"text": "just text"}) == [
        {"speaker": None, "text": "just text"}
    ]


def test_parse_segments_empty():
    assert parse_segments({}) == []


def test_join_turns_labels_and_field():
    turns = [
        {"speaker": "A", "text": "hello", "translation": "hola"},
        {"speaker": "B", "text": "bye", "translation": "adios"},
    ]
    assert join_turns(turns, "text") == "A: hello\nB: bye"
    assert join_turns(turns, "translation") == "A: hola\nB: adios"
