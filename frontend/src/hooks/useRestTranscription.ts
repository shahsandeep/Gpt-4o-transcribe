import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConnectionStatus,
  Notice,
  Segment,
  StartOptions,
  Transcriber,
} from '../types';
import { backendById } from '../lib/backends';
import { PcmCapture } from '../lib/capture';
import { encodeWav, chunksDurationMs } from '../lib/wav';
import { postTranscribe } from '../lib/rest';
import { newId, saveRecording } from '../lib/recordings';

const BATCH_MS = 5000;

/**
 * REST transcription. Two sub-modes:
 *  - `rest-batched`: every ~5s, the audio captured in that window is wrapped in a
 *    WAV and POSTed to the backend's /rest/transcribe. Results stream in per chunk.
 *  - `rest-full`: the whole session is POSTed as one WAV when you stop.
 *
 * Either way the full recording is saved to IndexedDB for replay / download /
 * re-transcription. This path never opens a WebSocket.
 */
export function useRestTranscription(mode: 'rest-batched' | 'rest-full'): Transcriber {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  const captureRef = useRef<PcmCapture | null>(null);
  const optsRef = useRef<StartOptions | null>(null);
  const modeRef = useRef(mode);
  const rollingRef = useRef<Int16Array[]>([]); // current unsent window (batched)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seqRef = useRef(0);
  const savedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const sessionStartRef = useRef(0);
  const noticeSeq = useRef(0);

  modeRef.current = mode;

  const pushNotice = useCallback((kind: 'error' | 'info', text: string) => {
    setNotice({ kind, text, id: ++noticeSeq.current });
  }, []);

  // --- segment helpers -----------------------------------------------------

  const addPending = useCallback((itemId: string) => {
    const t = performance.now();
    setSegments((prev) => [
      ...prev,
      { itemId, original: '', translation: null, partial: true, startMs: t, endMs: null },
    ]);
  }, []);

  // Replace the pending placeholder (itemId) in place with the resolved turns,
  // preserving chronological position even when chunks resolve out of order.
  const resolveSegments = useCallback((placeholderId: string, resolved: Segment[]) => {
    setSegments((prev) => {
      const idx = prev.findIndex((s) => s.itemId === placeholderId);
      if (idx === -1) return prev;
      const next = prev.slice();
      next.splice(idx, 1, ...resolved);
      return next;
    });
  }, []);

  const dropSegment = useCallback((itemId: string) => {
    setSegments((prev) => prev.filter((s) => s.itemId !== itemId));
  }, []);

  // --- one POST for a WAV blob --------------------------------------------

  const transcribeBlob = useCallback(
    async (blob: Blob, fileName: string, itemId: string) => {
      const opts = optsRef.current;
      if (!opts) return;
      addPending(itemId);
      try {
        const result = await postTranscribe(
          backendById(opts.backendId),
          {
            blob,
            fileName,
            inputLanguage: opts.inputLanguage,
            targetLanguage: opts.targetLanguage,
            translate: opts.translate,
            enhance: opts.serverEnhance,
          },
          abortRef.current?.signal,
        );
        const turns = result.segments.filter((s) => s.text.trim());
        if (turns.length === 0) {
          // Silence or nothing recognized in this window — don't clutter the view.
          dropSegment(itemId);
          return;
        }
        const t = performance.now();
        resolveSegments(
          itemId,
          turns.map((s, i) => ({
            itemId: `${itemId}#${i}`,
            speaker: s.speaker,
            original: s.text,
            translation: s.translation,
            partial: false,
            startMs: t,
            endMs: t,
          })),
        );
        if (result.translateError) pushNotice('error', result.translateError);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          dropSegment(itemId);
          return;
        }
        dropSegment(itemId);
        pushNotice('error', e instanceof Error ? e.message : 'REST transcription failed.');
      }
    },
    [addPending, dropSegment, pushNotice, resolveSegments],
  );

  // Encode + POST the current rolling window (batched mode).
  const flushRolling = useCallback(() => {
    const chunks = rollingRef.current;
    if (chunks.length === 0) return;
    rollingRef.current = [];
    const capture = captureRef.current;
    const sampleRate = capture?.sampleRate ?? 24000;
    if (chunksDurationMs(chunks, sampleRate) < 200) return; // ignore tiny slivers
    const blob = encodeWav(chunks, sampleRate);
    const seq = ++seqRef.current;
    void transcribeBlob(blob, `chunk-${seq}.wav`, `c${seq}`);
  }, [transcribeBlob]);

  // --- recording persistence ----------------------------------------------

  const saveCurrentRecording = useCallback(() => {
    const capture = captureRef.current;
    const opts = optsRef.current;
    if (!capture || !capture.hasAudio || savedRef.current || !opts) return;
    savedRef.current = true;
    const blob = encodeWav(capture.getAllChunks(), capture.sampleRate);
    void saveRecording({
      id: newId(),
      name: `${modeRef.current === 'rest-full' ? 'REST full' : 'REST batched'} · ${new Date().toLocaleTimeString()}`,
      createdAt: Date.now(),
      mode: modeRef.current,
      durationMs: capture.durationMs,
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

  const teardown = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    captureRef.current?.stop();
    captureRef.current = null;
    rollingRef.current = [];
  }, []);

  // --- public API ----------------------------------------------------------

  const start = useCallback(
    async (opts: StartOptions) => {
      teardown();
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      setSegments([]);
      savedRef.current = false;
      seqRef.current = 0;
      sessionStartRef.current = performance.now();
      optsRef.current = opts;
      setStatus('connecting');

      const capture = new PcmCapture();
      captureRef.current = capture;
      try {
        await capture.start({
          deviceId: opts.deviceId,
          audioCleanup: opts.audioCleanup,
          onChunk: (chunk) => {
            if (modeRef.current === 'rest-batched') rollingRef.current.push(chunk);
            // rest-full: capture accumulates everything; nothing to do per chunk.
          },
        });
      } catch (e) {
        pushNotice('error', e instanceof Error ? e.message : 'Failed to start microphone.');
        setStatus('error');
        teardown();
        return;
      }

      setStatus('live');
      if (modeRef.current === 'rest-batched') {
        timerRef.current = setInterval(flushRolling, BATCH_MS);
      }
    },
    [flushRolling, pushNotice, teardown],
  );

  const stop = useCallback(() => {
    setStatus('stopping');
    const capture = captureRef.current;

    if (modeRef.current === 'rest-batched') {
      // Flush the final (<5s) window before tearing down.
      flushRolling();
    } else if (capture && capture.hasAudio) {
      // Full mode: POST the entire recording once.
      const blob = encodeWav(capture.getAllChunks(), capture.sampleRate);
      void transcribeBlob(blob, 'full.wav', `full-${Date.now()}`);
      pushNotice('info', 'Transcribing full audio...');
    }

    saveCurrentRecording();
    teardown();
    setStatus('idle');
  }, [flushRolling, pushNotice, saveCurrentRecording, teardown, transcribeBlob]);

  const updateTarget = useCallback((targetLanguage: string, translate: boolean) => {
    if (optsRef.current) {
      optsRef.current = { ...optsRef.current, targetLanguage, translate };
    }
  }, []);

  const clearSegments = useCallback(() => setSegments([]), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      teardown();
    };
  }, [teardown]);

  const isActive = status === 'connecting' || status === 'live' || status === 'stopping';

  return {
    status,
    segments,
    speaking: false,
    notice,
    isActive,
    start,
    stop,
    updateTarget,
    clearSegments,
    dismissNotice,
  };
}
