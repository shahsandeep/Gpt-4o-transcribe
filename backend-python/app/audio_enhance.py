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
import subprocess
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

    # Run ffmpeg in a worker thread with the blocking subprocess API. We
    # deliberately avoid asyncio.create_subprocess_exec: on Windows it raises
    # NotImplementedError unless the event loop is a ProactorEventLoop, and the
    # loop uvicorn ends up with is not guaranteed. A thread + subprocess.run is
    # portable across every OS and event-loop policy.
    out, err = await asyncio.to_thread(_run_ffmpeg, binary, filters, audio, timeout_s)
    if out is None:
        logger.warning("ffmpeg enhancement failed; using original audio: %s", err)
        return audio, False
    return out, True


def _run_ffmpeg(
    binary: str, filters: str, audio: bytes, timeout_s: float
) -> tuple[Optional[bytes], Optional[str]]:
    """Blocking ffmpeg call (WAV in -> filtered WAV out). Returns (bytes, None)
    on success or (None, reason) on any failure. Safe to run in a thread."""
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
        proc = subprocess.run(
            cmd,
            input=audio,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired:
        return None, "timed out"
    except FileNotFoundError:
        return None, f"executable not found: {binary}"
    except Exception as exc:  # noqa: BLE001 - report and fall back
        return None, f"spawn failed: {exc}"

    if proc.returncode != 0 or not proc.stdout:
        detail = (proc.stderr or b"").decode("utf-8", "replace").strip()[:300]
        return None, f"rc={proc.returncode}: {detail}"
    return proc.stdout, None


__all__ = ["enhance_wav", "ffmpeg_available", "ffmpeg_binary"]
