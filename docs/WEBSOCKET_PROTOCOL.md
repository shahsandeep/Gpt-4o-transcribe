# WebSocket Protocol (frontend ↔ backend)

This is the **single contract** that both backends (Python and .NET) implement
identically, so the React frontend works against either one by only changing the
backend base URL. Do not diverge the two backends from this document.

## Connection

```
ws://<host>:<port>/ws/transcribe
```

The client opens one WebSocket per transcription session. The backend, on
connection, opens its own upstream WebSocket to the Azure OpenAI Realtime
transcription API and relays between the two.

Both **text frames** (JSON control/data messages) and **binary frames** (raw
audio) are used on the same socket:

- **Binary frame** → raw PCM16 audio (16-bit signed little-endian, **24 kHz**,
  mono) captured from the microphone. The backend base64-encodes it and forwards
  it to Azure as `input_audio_buffer.append`.
- **Text frame** → a JSON message, one of the shapes below.

## Client → Server (text)

### `start`
Sent once, immediately after the socket opens, before any audio.

```jsonc
{
  "type": "start",
  "inputLanguage": "en",     // ISO-639-1 of the spoken audio, or "auto"
  "targetLanguage": "es",    // ISO-639-1 to translate into
  "translate": true          // if false, transcript only, no translation
}
```

### `stop`
Ask the backend to flush and close the upstream session cleanly.

```jsonc
{ "type": "stop" }
```

### `update` (optional)
Change target language mid-session without reconnecting. Only `targetLanguage`
and `translate` may change live; changing `inputLanguage` requires a reconnect.

```jsonc
{ "type": "update", "targetLanguage": "fr", "translate": true }
```

## Server → Client (text)

Every server message has a `type`. `itemId` correlates a transcript with its
translation (it is the Azure `item_id` of the audio segment).

### `ready`
Upstream Azure session established and configured. The client may start
streaming audio now.

```jsonc
{ "type": "ready" }
```

### `partial_transcript`
A live, still-growing transcript for the current speech segment. Replaces any
previous partial for the same `itemId` in the UI.

```jsonc
{ "type": "partial_transcript", "itemId": "item_abc", "text": "hello wor" }
```

### `final_transcript`
The finalized transcript for a segment. The UI should promote the matching
partial to a permanent line.

```jsonc
{ "type": "final_transcript", "itemId": "item_abc", "text": "hello world" }
```

### `translation`
Translated text for a segment. Emitted after `final_transcript` for the same
`itemId` (translation runs on finalized segments). `partial` is reserved for
future streaming translation and is currently always `false`.

```jsonc
{ "type": "translation", "itemId": "item_abc", "text": "hola mundo", "partial": false }
```

### `speech_started` / `speech_stopped`
Voice-activity signals from Azure server VAD. Purely informational; the UI uses
them to show a "listening / speaking" indicator.

```jsonc
{ "type": "speech_started" }
{ "type": "speech_stopped" }
```

### `info`
Non-fatal notice (e.g. reconnecting, language changed).

```jsonc
{ "type": "info", "message": "target language changed to fr" }
```

### `error`
Something failed. The UI surfaces the message. May precede socket close.

```jsonc
{ "type": "error", "message": "azure auth failed: 401" }
```

## Sequence

```
client                         backend                        azure
  | --- open ws --------------->  |                              |
  |                               | --- open ws (intent=transcription) -->
  |                               | <-- transcription_session.created ---
  |                               | --- transcription_session.update --->
  | <---------- ready ----------- |                              |
  | --- start ------------------> | (stores languages)           |
  | === binary PCM16 =========>   | --- input_audio_buffer.append (b64) -->
  |                               | <-- speech_started ----------
  | <------ speech_started ------ |                              |
  |                               | <-- ...transcription.delta ---
  | <--- partial_transcript ----- |                              |
  |                               | <-- speech_stopped ----------
  | <------ speech_stopped ------ |                              |
  |                               | <-- ...transcription.completed
  | <--- final_transcript ------- |                              |
  |                               | (GPT-4o chat translate) ---->
  | <------ translation --------- |                              |
  | --- stop -------------------> | --- close upstream --------->
  | <---------- close ----------- |                              |
```

## Audio format contract (critical)

The Azure Realtime API expects **PCM16, 24 kHz, mono, little-endian** when
`input_audio_format` is `"pcm16"`. The frontend MUST resample microphone audio
to 24 kHz before sending. It does this by creating the `AudioContext` with
`{ sampleRate: 24000 }` and converting the worklet's Float32 samples to Int16.
The backends forward bytes unchanged; they never resample.
