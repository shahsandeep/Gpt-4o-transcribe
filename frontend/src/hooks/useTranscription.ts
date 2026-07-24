import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClientMessage,
  ConnectionStatus,
  Notice,
  Segment,
  ServerMessage,
  StartOptions,
  Transcriber,
} from '../types';
import { backendById, wsUrlFor } from '../lib/backends';
import { PcmCapture } from '../lib/capture';
import { encodeWav } from '../lib/wav';
import { newId, saveRecording } from '../lib/recordings';

/**
 * Realtime (WebSocket) transcription: streams PCM16 to the backend, which relays
 * to the Azure Realtime API and streams partial/final transcripts + translations
 * back. Also accumulates the captured audio and saves it to IndexedDB on stop so
 * it can be replayed, downloaded, or re-run through REST for comparison.
 */
export function useTranscription(): Transcriber {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<PcmCapture | null>(null);
  const startedRef = useRef(false); // true once `start` was sent (safe to stream)
  const optsRef = useRef<StartOptions | null>(null);
  const savedRef = useRef(false); // guard against double-saving a recording
  const sessionStartRef = useRef<number>(0);
  const noticeSeq = useRef(0);

  const pushNotice = useCallback((kind: 'error' | 'info', text: string) => {
    setNotice({ kind, text, id: ++noticeSeq.current });
  }, []);

  const nowMs = useCallback(() => performance.now() - sessionStartRef.current, []);

  const sendJson = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  // --- segment reducers ----------------------------------------------------

  const applyPartial = useCallback(
    (itemId: string, text: string) => {
      const t = nowMs();
      setSegments((prev) => {
        const idx = prev.findIndex((s) => s.itemId === itemId);
        if (idx === -1) {
          return [
            ...prev,
            { itemId, original: text, translation: null, partial: true, startMs: t, endMs: null },
          ];
        }
        const next = prev.slice();
        next[idx] = { ...next[idx], original: text, partial: true };
        return next;
      });
    },
    [nowMs],
  );

  const applyFinal = useCallback(
    (itemId: string, text: string) => {
      const t = nowMs();
      setSegments((prev) => {
        const idx = prev.findIndex((s) => s.itemId === itemId);
        if (idx === -1) {
          return [
            ...prev,
            { itemId, original: text, translation: null, partial: false, startMs: t, endMs: t },
          ];
        }
        const next = prev.slice();
        next[idx] = { ...next[idx], original: text, partial: false, endMs: t };
        return next;
      });
    },
    [nowMs],
  );

  const applyTranslation = useCallback((itemId: string, text: string) => {
    setSegments((prev) => {
      const idx = prev.findIndex((s) => s.itemId === itemId);
      if (idx === -1) {
        return [
          ...prev,
          { itemId, original: '', translation: text, partial: false, startMs: 0, endMs: null },
        ];
      }
      const next = prev.slice();
      next[idx] = { ...next[idx], translation: text };
      return next;
    });
  }, []);

  // --- recording persistence ----------------------------------------------

  const saveCurrentRecording = useCallback(() => {
    const capture = captureRef.current;
    const opts = optsRef.current;
    if (!capture || !capture.hasAudio || savedRef.current || !opts) return;
    savedRef.current = true;
    // Encode synchronously (before teardown nulls the capture), persist async.
    const blob = encodeWav(capture.getAllChunks(), capture.sampleRate);
    const durationMs = capture.durationMs;
    void saveRecording({
      id: newId(),
      name: `Realtime · ${new Date().toLocaleTimeString()}`,
      createdAt: Date.now(),
      mode: 'websocket',
      durationMs,
      sampleRate: capture.sampleRate,
      size: blob.size,
      inputLanguage: opts.inputLanguage,
      targetLanguage: opts.targetLanguage,
      blob,
    })
      .then(() => opts.onRecordingSaved?.())
      .catch(() => undefined);
  }, []);

  // --- teardown ------------------------------------------------------------

  const teardownAudio = useCallback(() => {
    startedRef.current = false;
    captureRef.current?.stop();
    captureRef.current = null;
  }, []);

  const closeSocket = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {
          /* best effort */
        }
      }
    }
  }, []);

  // --- audio graph setup (runs after `ready` + `start`) --------------------

  const setupAudio = useCallback(async () => {
    const opts = optsRef.current;
    if (!opts) return;

    const capture = new PcmCapture();
    captureRef.current = capture;
    await capture.start({
      deviceId: opts.deviceId,
      audioCleanup: opts.audioCleanup,
      onChunk: (chunk) => {
        const ws = wsRef.current;
        if (!startedRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(chunk.buffer); // binary PCM16 frame
      },
    });

    setStatus('live');
  }, []);

  // --- message handling ----------------------------------------------------

  const handleServerMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case 'ready': {
          const opts = optsRef.current;
          if (!opts) return;
          sendJson({
            type: 'start',
            inputLanguage: opts.inputLanguage,
            targetLanguage: opts.targetLanguage,
            translate: opts.translate,
          });
          startedRef.current = true;
          setupAudio().catch((e) => {
            pushNotice('error', e instanceof Error ? e.message : 'Failed to start microphone.');
            setStatus('error');
            teardownAudio();
            closeSocket();
          });
          break;
        }
        case 'partial_transcript':
          applyPartial(msg.itemId, msg.text);
          break;
        case 'final_transcript':
          applyFinal(msg.itemId, msg.text);
          break;
        case 'translation':
          applyTranslation(msg.itemId, msg.text);
          break;
        case 'speech_started':
          setSpeaking(true);
          break;
        case 'speech_stopped':
          setSpeaking(false);
          break;
        case 'info':
          pushNotice('info', msg.message);
          break;
        case 'error':
          pushNotice('error', msg.message);
          setStatus('error');
          break;
        default:
          break;
      }
    },
    [applyFinal, applyPartial, applyTranslation, closeSocket, pushNotice, sendJson, setupAudio, teardownAudio],
  );

  // --- public API ----------------------------------------------------------

  const start = useCallback(
    async (opts: StartOptions) => {
      closeSocket();
      teardownAudio();
      setSegments([]);
      setSpeaking(false);
      savedRef.current = false;
      sessionStartRef.current = performance.now();
      optsRef.current = opts;
      setStatus('connecting');

      const wsUrl = wsUrlFor(backendById(opts.backendId));
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        pushNotice('error', e instanceof Error ? e.message : 'Could not open WebSocket.');
        setStatus('error');
        return;
      }
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        handleServerMessage(parsed);
      };

      ws.onerror = () => {
        pushNotice('error', `WebSocket error connecting to ${wsUrl}. Is the backend running?`);
        setStatus('error');
      };

      ws.onclose = (event) => {
        saveCurrentRecording();
        teardownAudio();
        setSpeaking(false);
        setStatus((prev) => {
          if (prev === 'idle' || prev === 'stopping') return 'idle';
          if (prev === 'error') return 'error';
          if (!event.wasClean) {
            pushNotice('error', `Connection closed (code ${event.code}).`);
            return 'error';
          }
          return 'idle';
        });
        wsRef.current = null;
      };
    },
    [closeSocket, handleServerMessage, pushNotice, saveCurrentRecording, teardownAudio],
  );

  const stop = useCallback(() => {
    setStatus('stopping');
    sendJson({ type: 'stop' });
    startedRef.current = false;
    saveCurrentRecording();
    teardownAudio();
    setSpeaking(false);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      setTimeout(() => closeSocket(), 150);
    } else {
      closeSocket();
    }
    setStatus('idle');
  }, [closeSocket, saveCurrentRecording, sendJson, teardownAudio]);

  const updateTarget = useCallback(
    (targetLanguage: string, translate: boolean) => {
      if (optsRef.current) {
        optsRef.current = { ...optsRef.current, targetLanguage, translate };
      }
      sendJson({ type: 'update', targetLanguage, translate });
    },
    [sendJson],
  );

  const clearSegments = useCallback(() => setSegments([]), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  useEffect(() => {
    return () => {
      closeSocket();
      teardownAudio();
    };
  }, [closeSocket, teardownAudio]);

  const isActive = status === 'connecting' || status === 'live' || status === 'stopping';

  return {
    status,
    segments,
    speaking,
    notice,
    isActive,
    start,
    stop,
    updateTarget,
    clearSegments,
    dismissNotice,
  };
}
