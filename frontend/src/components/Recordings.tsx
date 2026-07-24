import { useCallback, useEffect, useRef, useState } from 'react';
import type { Backend } from '../lib/backends';
import { postTranscribe, type RestSegment } from '../lib/rest';
import { speakerColor, speakerName } from '../lib/speakers';
import {
  deleteRecording,
  getRecording,
  type RecordingMeta,
} from '../lib/recordings';

interface RecordingsProps {
  recordings: RecordingMeta[];
  backend: Backend;
  inputLanguage: string;
  targetLanguage: string;
  translate: boolean;
  enhance: boolean;
  onChanged: () => void;
}

interface RowResult {
  loading?: boolean;
  transcript?: string;
  translation?: string | null;
  segments?: RestSegment[];
  ms?: number;
  error?: string;
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function Recordings({
  recordings,
  backend,
  inputLanguage,
  targetLanguage,
  translate,
  enhance,
  onChanged,
}: RecordingsProps) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const urlRef = useRef<string | null>(null);

  const revokeUrl = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  useEffect(() => revokeUrl, [revokeUrl]);

  const play = useCallback(
    async (id: string) => {
      const rec = await getRecording(id);
      if (!rec) return;
      revokeUrl();
      const url = URL.createObjectURL(rec.blob);
      urlRef.current = url;
      setAudioUrl(url);
      setPlayingId(id);
    },
    [revokeUrl],
  );

  const download = useCallback(async (rec: RecordingMeta) => {
    const stored = await getRecording(rec.id);
    if (!stored) return;
    const url = URL.createObjectURL(stored.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rec.name.replace(/[^\w.-]+/g, '_')}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const transcribeFull = useCallback(
    async (id: string) => {
      const rec = await getRecording(id);
      if (!rec) return;
      setResults((prev) => ({ ...prev, [id]: { loading: true } }));
      try {
        const result = await postTranscribe(backend, {
          blob: rec.blob,
          fileName: `${rec.name}.wav`,
          inputLanguage,
          targetLanguage,
          translate,
          enhance,
        });
        setResults((prev) => ({
          ...prev,
          [id]: {
            transcript: result.transcript,
            translation: result.translation,
            segments: result.segments,
            ms: result.transcribeMs + result.translateMs,
            error: result.translateError,
          },
        }));
      } catch (e) {
        setResults((prev) => ({
          ...prev,
          [id]: { error: e instanceof Error ? e.message : 'Transcription failed.' },
        }));
      }
    },
    [backend, inputLanguage, targetLanguage, translate, enhance],
  );

  const remove = useCallback(
    async (id: string) => {
      if (playingId === id) {
        setPlayingId(null);
        setAudioUrl(null);
        revokeUrl();
      }
      await deleteRecording(id);
      setResults((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      onChanged();
    },
    [onChanged, playingId, revokeUrl],
  );

  if (recordings.length === 0) {
    return (
      <div className="recordings empty-recordings">
        <p>No saved recordings yet. Start a session and your audio is stored here for
        replay, download, or full-audio comparison.</p>
      </div>
    );
  }

  return (
    <div className="recordings">
      {audioUrl && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio className="rec-player" src={audioUrl} controls autoPlay />
      )}
      <ul className="rec-list">
        {recordings.map((r) => {
          const res = results[r.id];
          return (
            <li key={r.id} className={`rec-item ${playingId === r.id ? 'playing' : ''}`}>
              <div className="rec-head">
                <div className="rec-meta">
                  <span className="rec-name">{r.name}</span>
                  <span className="rec-sub">
                    <span className={`mode-tag mode-${r.mode}`}>{r.mode}</span>
                    {fmtDuration(r.durationMs)} · {fmtSize(r.size)}
                  </span>
                </div>
                <div className="rec-actions">
                  <button type="button" className="btn ghost small" onClick={() => play(r.id)}>
                    ▶ Play
                  </button>
                  <button type="button" className="btn ghost small" onClick={() => download(r)}>
                    ⭳ Download
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => transcribeFull(r.id)}
                    disabled={res?.loading}
                    title="Send the whole file at once via REST"
                  >
                    {res?.loading ? '…' : 'Transcribe full'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost small danger-text"
                    onClick={() => remove(r.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
              {res && !res.loading && (res.transcript !== undefined || res.error) && (
                <div className="rec-result">
                  {res.error && !res.transcript && (
                    <div className="rec-error">{res.error}</div>
                  )}
                  {res.transcript !== undefined && (
                    <>
                      {res.segments && res.segments.some((s) => s.speaker) ? (
                        <div className="rec-turns">
                          {res.segments
                            .filter((s) => s.text.trim())
                            .map((s, i) => {
                              const color = speakerColor(s.speaker);
                              return (
                                <div
                                  key={i}
                                  className="rec-turn"
                                  style={color ? { borderLeftColor: color } : undefined}
                                >
                                  <span className="speaker-chip" style={{ background: color ?? undefined }}>
                                    {speakerName(s.speaker)}
                                  </span>
                                  <div className="rec-transcript">{s.text}</div>
                                  {translate && s.translation && (
                                    <div className="rec-translation">{s.translation}</div>
                                  )}
                                </div>
                              );
                            })}
                        </div>
                      ) : (
                        <>
                          <div className="rec-transcript">
                            {res.transcript || '(no speech detected)'}
                          </div>
                          {translate && res.translation && (
                            <div className="rec-translation">{res.translation}</div>
                          )}
                        </>
                      )}
                      {typeof res.ms === 'number' && (
                        <div className="rec-timing">{res.ms} ms round-trip</div>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
