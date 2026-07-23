"""Segment translation via the Azure chat completions REST API."""

from __future__ import annotations

import logging
from typing import Optional

import httpx

from .config import Settings

logger = logging.getLogger(__name__)

# ISO-639-1 -> human-readable language name for the system prompt. Falls back to
# the raw code when unknown, so translation still works for uncommon codes.
LANGUAGE_NAMES: dict[str, str] = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "ru": "Russian",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "ar": "Arabic",
    "hi": "Hindi",
    "tr": "Turkish",
    "pl": "Polish",
    "sv": "Swedish",
    "no": "Norwegian",
    "da": "Danish",
    "fi": "Finnish",
    "el": "Greek",
    "he": "Hebrew",
    "th": "Thai",
    "vi": "Vietnamese",
    "id": "Indonesian",
    "uk": "Ukrainian",
    "cs": "Czech",
    "ro": "Romanian",
    "hu": "Hungarian",
}


def language_name(code: str) -> str:
    """Return the human-readable language name for an ISO code.

    Unknown codes fall back to the code itself (lowercased, trimmed).
    """
    if not code:
        return "English"
    return LANGUAGE_NAMES.get(code.strip().lower(), code.strip())


async def translate(
    text: str,
    target_language: str,
    settings: Settings,
    client: Optional[httpx.AsyncClient] = None,
) -> str:
    """Translate `text` into `target_language` (an ISO-639-1 code).

    POSTs to the Azure chat completions endpoint with `temperature: 0` and a
    system prompt that constrains the model to output only the translation.
    Returns the trimmed assistant message. Raises on HTTP or parse failure so
    the caller can surface an error/info to the client.
    """
    if not text or not text.strip():
        return ""

    lang = language_name(target_language)
    system_prompt = (
        f"You are a translation engine. Translate the user's text into {lang}. "
        "Output ONLY the translation, no explanations."
    )
    payload = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text},
        ],
        "temperature": 0,
    }
    headers = {
        "api-key": settings.azure_openai_api_key,
        "Content-Type": "application/json",
    }

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=30.0)
    try:
        resp = await client.post(
            settings.translation_url, headers=headers, json=payload
        )
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        return (content or "").strip()
    finally:
        if owns_client:
            await client.aclose()


__all__ = ["translate", "language_name", "LANGUAGE_NAMES"]
