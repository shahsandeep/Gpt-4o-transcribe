import { useEffect, useRef } from 'react';
import type { Segment } from '../types';
import { speakerColor, speakerName } from '../lib/speakers';
import { languageName } from '../lib/languages';

interface TranscriptViewProps {
  segments: Segment[];
  translate: boolean;
  inputLanguage: string;
  targetLanguage: string;
}

export function TranscriptView({
  segments,
  translate,
  inputLanguage,
  targetLanguage,
}: TranscriptViewProps) {
  const originalTag =
    inputLanguage && inputLanguage !== 'auto'
      ? `Original · ${languageName(inputLanguage)}`
      : 'Original';
  const translatedTag = `Translated · ${languageName(targetLanguage)}`;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom as new segments/text arrive, but only if the user is
  // already near the bottom (don't yank the view while they scroll back).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [segments]);

  if (segments.length === 0) {
    return (
      <div className="transcript empty" ref={scrollRef}>
        <div className="empty-state">
          <div className="empty-icon">🎙️</div>
          <p>Pick a microphone and press Start. Your speech appears here live.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript" ref={scrollRef}>
      {segments.map((s) => {
        const color = speakerColor(s.speaker);
        const name = speakerName(s.speaker);
        return (
          <div
            key={s.itemId}
            className={`segment ${s.partial ? 'partial' : 'final'} ${name ? 'has-speaker' : ''}`}
            style={color ? { borderLeftColor: color } : undefined}
          >
            {name && (
              <span className="speaker-chip" style={{ background: color ?? undefined }}>
                {name}
              </span>
            )}
            <div className="seg-line original-line">
              <span className="line-tag">{originalTag}</span>
              <div className="line-text">
                {s.original || <span className="placeholder">…</span>}
              </div>
            </div>
            {translate && s.translation != null && (
              <div className="seg-line translation-line">
                <span className="line-tag">{translatedTag}</span>
                <div className="line-text">{s.translation}</div>
              </div>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
