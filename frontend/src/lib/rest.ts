// Client for the backend REST transcription endpoint (docs/REST_API.md).
// Same endpoint on either backend; only the base URL differs.

import type { Backend } from './backends';

/** One speaker turn from a diarized (or plain) transcription. */
export interface RestSegment {
  speaker: string | null;
  text: string;
  translation: string | null;
}

export interface RestResult {
  transcript: string;
  translation: string | null;
  /** Per-speaker-turn breakdown (one speaker-less entry when not diarized). */
  segments: RestSegment[];
  /** True when the backend actually ran the ffmpeg enhancement pass. */
  enhanced: boolean;
  transcribeMs: number;
  translateMs: number;
  translateError?: string;
}

export interface RestTranscribeParams {
  blob: Blob;
  fileName: string;
  inputLanguage: string; // "" or "auto" → let Azure detect
  targetLanguage: string;
  translate: boolean;
  /** Ask the backend to ffmpeg-enhance the audio before upload. */
  enhance?: boolean;
}

/** http(s)://host:port base for a backend's REST calls. */
export function httpBaseFor(backend: Backend): string {
  const scheme =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://${backend.host}:${backend.port}`;
}

export async function postTranscribe(
  backend: Backend,
  params: RestTranscribeParams,
  signal?: AbortSignal,
): Promise<RestResult> {
  const fd = new FormData();
  fd.append('file', params.blob, params.fileName);
  if (params.inputLanguage && params.inputLanguage !== 'auto') {
    fd.append('inputLanguage', params.inputLanguage);
  }
  fd.append('targetLanguage', params.targetLanguage);
  fd.append('translate', String(params.translate));
  if (params.enhance) fd.append('enhance', 'true');

  let res: Response;
  try {
    res = await fetch(`${httpBaseFor(backend)}/rest/transcribe`, {
      method: 'POST',
      body: fd,
      signal,
    });
  } catch (e) {
    throw new Error(
      e instanceof Error ? `Could not reach backend: ${e.message}` : 'Could not reach backend',
    );
  }

  const raw = await res.text();
  let json: Partial<RestResult> & { error?: string };
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Backend returned a non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    throw new Error(json.error ?? `Transcription failed (HTTP ${res.status}).`);
  }

  const transcript = json.transcript ?? '';
  const segments =
    Array.isArray(json.segments) && json.segments.length > 0
      ? json.segments.map((s) => ({
          speaker: s.speaker ?? null,
          text: s.text ?? '',
          translation: s.translation ?? null,
        }))
      : [{ speaker: null, text: transcript, translation: json.translation ?? null }];

  return {
    transcript,
    translation: json.translation ?? null,
    segments,
    enhanced: json.enhanced ?? false,
    transcribeMs: json.transcribeMs ?? 0,
    translateMs: json.translateMs ?? 0,
    translateError: json.translateError,
  };
}

/**
 * POST audio to /rest/enhance and get the ffmpeg-enhanced WAV back (for A/B
 * playback). Throws with the backend's message on 422 (ffmpeg missing/failed).
 */
export async function postEnhance(
  backend: Backend,
  blob: Blob,
  fileName: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const fd = new FormData();
  fd.append('file', blob, fileName);

  let res: Response;
  try {
    res = await fetch(`${httpBaseFor(backend)}/rest/enhance`, {
      method: 'POST',
      body: fd,
      signal,
    });
  } catch (e) {
    throw new Error(
      e instanceof Error ? `Could not reach backend: ${e.message}` : 'Could not reach backend',
    );
  }

  if (!res.ok) {
    let msg = `Enhancement failed (HTTP ${res.status}).`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }

  return res.blob();
}
