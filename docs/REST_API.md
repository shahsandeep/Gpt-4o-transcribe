# REST transcription mode (frontend ↔ backend)

Some Azure deployments expose transcription through the **REST**
`/audio/transcriptions` endpoint rather than the realtime WebSocket. This mode
covers that: the frontend records audio, wraps it into WAV files, and POSTs them
to the backend, which relays to Azure's REST endpoint and (optionally) translates.

Both backends (Python + .NET) implement this identically, alongside the realtime
WebSocket protocol in [`WEBSOCKET_PROTOCOL.md`](WEBSOCKET_PROTOCOL.md). The two
modes are independent; the UI picks one.

## Two REST sub-modes (frontend behavior)

- **Batched (every 5 s):** while recording, the frontend flushes the audio
  captured in each ~5 second window into a standalone WAV and POSTs it. Results
  stream in every few seconds (near-realtime). Word boundaries can be split at
  chunk edges — that is inherent to batching and part of what you compare against.
- **Full audio at once:** the frontend records the whole session, and on stop
  POSTs one WAV. One transcript for the entire recording, no boundary splits.

Both sub-modes hit the **same** backend endpoint below; "batched vs full" is purely
how many requests the frontend makes and how big each file is.

## Endpoint

```
POST http://<host>:<port>/rest/transcribe
Content-Type: multipart/form-data
```

### Request (multipart form fields)

| Field | Required | Description |
|-------|----------|-------------|
| `file` | yes | Audio file. The frontend sends mono 16-bit PCM WAV at 24 kHz (`audio/wav`). The backend passes bytes through unchanged; Azure also accepts wav/mp3/m4a/ogg/webm/flac. |
| `inputLanguage` | no | ISO-639-1 code of the spoken audio. Omit or send `auto` to let Azure detect. |
| `targetLanguage` | no | ISO-639-1 code to translate into. Required only when `translate=true`. |
| `translate` | no | `true` / `false` (default `false`). When true the backend translates the transcript via the gpt-4o chat deployment. |

### Response `200 application/json`

```jsonc
{
  "transcript": "A: hello\nB: hi there",   // labeled lines when diarized, else flat text
  "translation": "A: hola\nB: hola",        // null when translate=false or transcript empty
  "segments": [                             // one entry per speaker turn
    { "speaker": "A", "text": "hello",     "translation": "hola" },
    { "speaker": "B", "text": "hi there",  "translation": "hola" }
  ],
  "transcribeMs": 812,            // server-measured Azure transcription time
  "translateMs": 143              // server-measured translation time (0 when skipped)
}
```

For non-diarized responses `segments` has a single entry with `"speaker": null`.
When translation is on, **each turn is translated separately** so the per-turn
`translation` aligns with its speaker; `translation` (top level) is the labeled
join of those.

### Error `4xx / 5xx application/json`

```jsonc
{ "error": "azure transcription failed: 401 Unauthorized" }
```

## What the backend does

1. Read the uploaded `file` bytes from the multipart body.
2. POST them to Azure:
   ```
   POST https://<resource>.openai.azure.com/openai/deployments/<AZURE_TRANSCRIBE_DEPLOYMENT>/audio/transcriptions?api-version=<AZURE_TRANSCRIBE_REST_API_VERSION>
   Header: api-key: <AZURE_OPENAI_API_KEY>
   multipart/form-data: file=<bytes>, response_format=json[, language=<inputLanguage>]
   ```
   (The deployment is in the URL, so no `model` form field is needed for Azure.)
3. Parse `{ "text": "..." }` → `transcript`.
4. If `translate=true` and the transcript is non-empty, translate **each speaker
   turn separately** (concurrently) via the gpt-4o chat path so translations align
   per turn. A failed turn leaves its `translation` null and surfaces one
   `translateError`; it never fails the whole request.
5. Return the JSON above.

> `gpt-4o-transcribe` supports `response_format` of `json` or `text` only (not
> `verbose_json` / `srt` / `vtt`). This mode uses `json`.

## Config

Two REST-specific environment variables (see [`AZURE_SETUP.md`](AZURE_SETUP.md)
and `.env.example`):

```dotenv
# REST audio transcription API version (may differ from the realtime one)
AZURE_TRANSCRIBE_REST_API_VERSION=2025-04-01-preview

# "json" (flat text) or "diarized_json" (speaker-labeled). See below.
AZURE_TRANSCRIBE_RESPONSE_FORMAT=json
```

Everything else (endpoint, deployment name, key, chat deployment for translation)
is shared with the WebSocket mode. The endpoint may be either an
`*.openai.azure.com` or an `*.cognitiveservices.azure.com` host — the backend
uses whatever you set in `AZURE_OPENAI_ENDPOINT`.

## Speaker diarization (`gpt-4o-transcribe-diarize`)

If your deployment is the **diarize** model, set:

```dotenv
AZURE_TRANSCRIBE_DEPLOYMENT=gpt-4o-transcribe-diarize
AZURE_TRANSCRIBE_RESPONSE_FORMAT=diarized_json
```

With `diarized_json`, Azure returns `segments` each carrying a `speaker` label
(`A`, `B`, ...) and timestamps. The backend collapses consecutive same-speaker
segments and formats the transcript as speaker-labeled lines:

```
A: Hi there, how are you?
B: Good thanks, and you?
```

That labeled text flows through the normal `transcript` field (and is what gets
translated). Parsing is defensive: if Azure returns only a flat `text` field for
a diarized request (a known inconsistency on some api-versions), the backend
falls back to that text. With the default `AZURE_TRANSCRIBE_RESPONSE_FORMAT=json`
the diarize model still works, just without speaker labels.

## Browser-side audio storage

Independent of transcription mode, the frontend saves each finished recording as a
WAV in **IndexedDB** so you can replay it, download it, or re-run full-audio REST
transcription on the exact same audio to compare against the batched result. No
audio is persisted server-side.
