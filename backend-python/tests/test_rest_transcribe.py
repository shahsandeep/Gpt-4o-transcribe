"""Offline unit tests for the REST transcription path (no network, no Azure).

Covers:
- config URL derivation (endpoint + deployment + rest api version -> REST URL),
- the "true"/"false" translate flag parsing helper.
"""

from __future__ import annotations

from app.config import Settings
from app.main import _parse_bool


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
