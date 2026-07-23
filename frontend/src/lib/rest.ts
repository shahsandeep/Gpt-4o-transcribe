// Client for the backend REST transcription endpoint (docs/REST_API.md).
// Same endpoint on either backend; only the base URL differs.

import type { Backend } from './backends';

export interface RestResult {
  transcript: string;
  translation: string | null;
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

  return {
    transcript: json.transcript ?? '',
    translation: json.translation ?? null,
    transcribeMs: json.transcribeMs ?? 0,
    translateMs: json.translateMs ?? 0,
    translateError: json.translateError,
  };
}
