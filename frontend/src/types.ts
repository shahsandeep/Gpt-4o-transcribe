// Protocol message types — mirrors docs/WEBSOCKET_PROTOCOL.md exactly.
// Both the Python (:8000) and .NET (:8080) backends speak this identical contract.

// ---------------------------------------------------------------------------
// Client -> Server (text frames). Binary frames carry raw PCM16 @ 24 kHz mono.
// ---------------------------------------------------------------------------

/** Sent once, immediately after the socket opens, before any audio. */
export interface StartMessage {
  type: 'start';
  /** ISO-639-1 of the spoken audio, or "auto". */
  inputLanguage: string;
  /** ISO-639-1 to translate into. */
  targetLanguage: string;
  /** If false, transcript only, no translation. */
  translate: boolean;
}

/** Ask the backend to flush and close the upstream session cleanly. */
export interface StopMessage {
  type: 'stop';
}

/**
 * Change target language / translate flag mid-session without reconnecting.
 * Changing inputLanguage requires a reconnect and is NOT allowed here.
 */
export interface UpdateMessage {
  type: 'update';
  targetLanguage: string;
  translate: boolean;
}

export type ClientMessage = StartMessage | StopMessage | UpdateMessage;

// ---------------------------------------------------------------------------
// Server -> Client (text frames).
// ---------------------------------------------------------------------------

/** Upstream Azure session established and configured. Safe to stream audio. */
export interface ReadyMessage {
  type: 'ready';
}

/** A live, still-growing transcript for the current speech segment. */
export interface PartialTranscriptMessage {
  type: 'partial_transcript';
  itemId: string;
  text: string;
}

/** The finalized transcript for a segment. */
export interface FinalTranscriptMessage {
  type: 'final_transcript';
  itemId: string;
  text: string;
}

/** Translated text for a segment. `partial` is reserved and currently always false. */
export interface TranslationMessage {
  type: 'translation';
  itemId: string;
  text: string;
  partial: boolean;
}

/** Voice-activity signal: speech began. */
export interface SpeechStartedMessage {
  type: 'speech_started';
}

/** Voice-activity signal: speech ended. */
export interface SpeechStoppedMessage {
  type: 'speech_stopped';
}

/** Non-fatal notice (e.g. reconnecting, language changed). */
export interface InfoMessage {
  type: 'info';
  message: string;
}

/** Something failed. May precede a socket close. */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | ReadyMessage
  | PartialTranscriptMessage
  | FinalTranscriptMessage
  | TranslationMessage
  | SpeechStartedMessage
  | SpeechStoppedMessage
  | InfoMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// UI-side domain types.
// ---------------------------------------------------------------------------

/** One transcript segment, correlated across partial/final/translation by itemId. */
export interface Segment {
  itemId: string;
  /** Diarized speaker label ("A", "B", ...) or null/undefined when not diarized. */
  speaker?: string | null;
  /** Original (transcribed) text. */
  original: string;
  /** Translated text, if any. */
  translation: string | null;
  /** True while the original is still a live partial (not yet finalized). */
  partial: boolean;
  /** ms offset from session start when the segment first appeared. */
  startMs: number;
  /** ms offset from session start when the segment finalized (null while partial). */
  endMs: number | null;
}

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'stopping'
  | 'error';

export interface Notice {
  kind: 'error' | 'info';
  text: string;
  id: number;
}

/** Transcription mode chosen in the UI. */
export type Mode = 'websocket' | 'rest-batched' | 'rest-full';

export const MODE_LABELS: Record<Mode, string> = {
  websocket: 'Realtime (WebSocket)',
  'rest-batched': 'REST · 5s batches',
  'rest-full': 'REST · full audio',
};

/** Options passed to a transcriber hook's start(). Backend-derived URLs are
 *  built inside each hook so the UI only picks the backend + mode. */
export interface StartOptions {
  deviceId: string | null;
  inputLanguage: string;
  targetLanguage: string;
  translate: boolean;
  /** Browser-side cleanup (noiseSuppression + echoCancellation + autoGainControl). */
  audioCleanup: boolean;
  /** REST only: ask the backend to ffmpeg-enhance the audio before upload. */
  serverEnhance: boolean;
  /** Which backend to talk to (host/port); the hook derives ws:// or http://). */
  backendId: string;
  /** Called after a recording is persisted to IndexedDB (to refresh the list). */
  onRecordingSaved?: () => void;
}

/** Common shape both the WebSocket and REST hooks expose to <App>. */
export interface Transcriber {
  status: ConnectionStatus;
  segments: Segment[];
  speaking: boolean;
  notice: Notice | null;
  isActive: boolean;
  start: (opts: StartOptions) => Promise<void>;
  stop: () => void;
  updateTarget: (targetLanguage: string, translate: boolean) => void;
  clearSegments: () => void;
  dismissNotice: () => void;
}
