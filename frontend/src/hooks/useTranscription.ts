import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClientMessage,
  ConnectionStatus,
  Notice,
  Segment,
  ServerMessage,
  SessionOptions,
} from '../types';

interface UseTranscription {
  status: ConnectionStatus;
  segments: Segment[];
  speaking: boolean;
  notice: Notice | null;
  isActive: boolean;
  start: (opts: SessionOptions) => Promise<void>;
  stop: () => void;
  /** Live target-language / translate change via the `update` message. */
  updateTarget: (targetLanguage: string, translate: boolean) => void;
  clearSegments: () => void;
  dismissNotice: () => void;
}

export function useTranscription(): UseTranscription {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Long-lived handles that must not trigger re-renders.
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const startedRef = useRef(false); // true once `start` was sent (safe to stream)
  const optsRef = useRef<SessionOptions | null>(null);
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
        // Translation before we saw the segment — create a placeholder.
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

  // --- teardown ------------------------------------------------------------

  const teardownAudio = useCallback(() => {
    startedRef.current = false;
    try {
      workletRef.current?.port.close();
    } catch {
      /* best effort */
    }
    try {
      workletRef.current?.disconnect();
    } catch {
      /* best effort */
    }
    try {
      sourceRef.current?.disconnect();
    } catch {
      /* best effort */
    }
    streamRef.current?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        /* best effort */
      }
    });
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      void audioCtxRef.current.close().catch(() => undefined);
    }
    workletRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    audioCtxRef.current = null;
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

    const ctx = new AudioContext({ sampleRate: 24000 });
    audioCtxRef.current = ctx;
    // Some browsers start the context suspended until a user gesture.
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
    }

    // Vite rewrites this `new URL(..., import.meta.url)` to the hashed asset URL
    // in both dev and build, so the worklet module resolves correctly.
    await ctx.audioWorklet.addModule(
      new URL('../worklets/pcm-worklet.js', import.meta.url).href,
    );

    const constraints: MediaStreamConstraints = {
      audio: opts.deviceId
        ? { deviceId: { exact: opts.deviceId }, channelCount: 1 }
        : { channelCount: 1 },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    streamRef.current = stream;

    const source = ctx.createMediaStreamSource(stream);
    sourceRef.current = source;

    const worklet = new AudioWorkletNode(ctx, 'pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    workletRef.current = worklet;

    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const ws = wsRef.current;
      if (!startedRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(e.data); // binary PCM16 frame
    };

    source.connect(worklet);
    // Connect to destination so the node is guaranteed to keep processing.
    // We never write output samples, so this is silent (no mic echo).
    worklet.connect(ctx.destination);

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
          // Unknown message type — ignore per forward-compat.
          break;
      }
    },
    [applyFinal, applyPartial, applyTranslation, closeSocket, pushNotice, sendJson, setupAudio, teardownAudio],
  );

  // --- public API ----------------------------------------------------------

  const start = useCallback(
    async (opts: SessionOptions) => {
      // Fresh session.
      closeSocket();
      teardownAudio();
      setSegments([]);
      setSpeaking(false);
      sessionStartRef.current = performance.now();
      optsRef.current = opts;
      setStatus('connecting');

      let ws: WebSocket;
      try {
        ws = new WebSocket(opts.wsUrl);
      } catch (e) {
        pushNotice('error', e instanceof Error ? e.message : 'Could not open WebSocket.');
        setStatus('error');
        return;
      }
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return; // ignore any binary from server
        let parsed: ServerMessage;
        try {
          parsed = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        handleServerMessage(parsed);
      };

      ws.onerror = () => {
        pushNotice('error', `WebSocket error connecting to ${opts.wsUrl}. Is the backend running?`);
        setStatus('error');
      };

      ws.onclose = (event) => {
        teardownAudio();
        setSpeaking(false);
        // Only surface an unexpected close; a clean stop already resets to idle.
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
    [closeSocket, handleServerMessage, pushNotice, teardownAudio],
  );

  const stop = useCallback(() => {
    setStatus('stopping');
    sendJson({ type: 'stop' });
    startedRef.current = false;
    teardownAudio();
    setSpeaking(false);
    // Give the backend a beat to flush, then close.
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      setTimeout(() => closeSocket(), 150);
    } else {
      closeSocket();
    }
    setStatus('idle');
  }, [closeSocket, sendJson, teardownAudio]);

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

  // Cleanup on unmount.
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
