"""Optional server-side audio enhancement via ffmpeg (REST path only).

When a REST request opts in and ffmpeg is available, the WAV is piped through a
filter chain (high-pass + denoise + loudness-normalize by default) before it is
sent to Azure. Everything degrades gracefully: if ffmpeg is missing, errors, or
returns nothing usable, the original audio is used unchanged.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def ffmpeg_binary(configured: str = "") -> Optional[str]:
    """Resolve the ffmpeg executable.

    `configured` (from FFMPEG_PATH) may be the full path to the executable or the
    folder that contains it. When empty, "ffmpeg" is looked up on PATH. Returns
    the resolved path/command, or None when ffmpeg can't be found.
    """
    configured = (configured or "").strip().strip('"')
    if configured:
        p = Path(configured)
        if p.is_dir():
            for name in ("ffmpeg.exe", "ffmpeg"):
                candidate = p / name
                if candidate.exists():
                    return str(candidate)
            return None
        return str(p) if p.exists() else None
    return shutil.which("ffmpeg")


def ffmpeg_available(configured: str = "") -> bool:
    """True when ffmpeg can be resolved (via FFMPEG_PATH or PATH)."""
    return ffmpeg_binary(configured) is not None


async def enhance_wav(
    audio: bytes, filters: str, ffmpeg_path: str = "", timeout_s: float = 60.0
) -> tuple[bytes, bool]:
    """Run `audio` (a WAV blob) through an ffmpeg filter chain.

    `ffmpeg_path` is the FFMPEG_PATH override (executable or its folder); empty
    means use PATH. Returns `(processed_bytes, enhanced)`. On any failure —
    ffmpeg absent, a non-zero exit, empty output, or timeout — returns
    `(audio, False)` so the caller can proceed with the original audio.
    """
    if not filters.strip():
        return audio, False
    binary = ffmpeg_binary(ffmpeg_path)
    if binary is None:
        logger.info("Audio enhancement requested but ffmpeg was not found; skipping")
        return audio, False

    # Read WAV from stdin, apply filters, write WAV (mono, 24 kHz) to stdout.
    cmd = [
        binary,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-af",
        filters,
        "-ac",
        "1",
        "-ar",
        "24000",
        "-f",
        "wav",
        "pipe:1",
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except Exception:  # noqa: BLE001 - spawn failure -> fall back to original
        logger.exception("Failed to spawn ffmpeg for audio enhancement")
        return audio, False

    try:
        out, err = await asyncio.wait_for(proc.communicate(input=audio), timeout_s)
    except asyncio.TimeoutError:
        logger.warning("ffmpeg audio enhancement timed out; using original audio")
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return audio, False

    if proc.returncode != 0 or not out:
        detail = (err or b"").decode("utf-8", "replace").strip()[:300]
        logger.warning("ffmpeg enhancement failed (rc=%s): %s", proc.returncode, detail)
        return audio, False

    return out, True


__all__ = ["enhance_wav", "ffmpeg_available", "ffmpeg_binary"]
