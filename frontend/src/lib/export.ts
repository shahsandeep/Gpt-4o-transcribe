import type { Segment } from '../types';
import { languageName } from './languages';

export interface ExportMeta {
  inputLanguage: string;
  targetLanguage: string;
  translate: boolean;
  backendLabel: string;
  createdAt: string; // ISO timestamp
}

/** Only finalized segments with actual text are worth exporting. */
export function exportableSegments(segments: Segment[]): Segment[] {
  return segments.filter((s) => !s.partial && s.original.trim().length > 0);
}

// ---------------------------------------------------------------------------
// .txt
// ---------------------------------------------------------------------------

export function toTxt(segments: Segment[], meta: ExportMeta): string {
  const rows = exportableSegments(segments);
  const header = [
    'GPT-4o Live Transcript',
    `Created: ${meta.createdAt}`,
    `Input language: ${languageName(meta.inputLanguage)}`,
    meta.translate ? `Target language: ${languageName(meta.targetLanguage)}` : 'Translation: off',
    `Backend: ${meta.backendLabel}`,
    '',
    '----------------------------------------',
    '',
  ].join('\n');

  const body = rows
    .map((s) => {
      const lines = [`[${formatClock(s.startMs)}] ${s.original.trim()}`];
      if (s.translation && s.translation.trim()) {
        lines.push(`    → ${s.translation.trim()}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  return `${header}${body}\n`;
}

// ---------------------------------------------------------------------------
// .srt  — incrementing indices + HH:MM:SS,mmm timestamps
// ---------------------------------------------------------------------------

export function toSrt(segments: Segment[]): string {
  const rows = exportableSegments(segments);
  return (
    rows
      .map((s, i) => {
        const start = s.startMs;
        // Fall back to a short default duration if end wasn't captured.
        const end = s.endMs != null && s.endMs > start ? s.endMs : start + 2000;
        const text = [s.original.trim()];
        if (s.translation && s.translation.trim()) text.push(s.translation.trim());
        return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text.join('\n')}`;
      })
      .join('\n\n') + '\n'
  );
}

// ---------------------------------------------------------------------------
// .json
// ---------------------------------------------------------------------------

export function toJson(segments: Segment[], meta: ExportMeta): string {
  const rows = exportableSegments(segments).map((s, i) => ({
    index: i + 1,
    itemId: s.itemId,
    startMs: Math.round(s.startMs),
    endMs: s.endMs != null ? Math.round(s.endMs) : null,
    original: s.original.trim(),
    translation: s.translation ? s.translation.trim() : null,
  }));

  return JSON.stringify(
    {
      meta: {
        ...meta,
        inputLanguageName: languageName(meta.inputLanguage),
        targetLanguageName: languageName(meta.targetLanguage),
      },
      segments: rows,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Time formatting helpers
// ---------------------------------------------------------------------------

/** SRT wants HH:MM:SS,mmm. */
export function srtTime(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSec = Math.floor(clamped / 1000);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const mmm = Math.floor(clamped % 1000);
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(mmm, 3)}`;
}

/** Short MM:SS clock for the .txt header rows. */
function formatClock(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${pad(mm, 2)}:${pad(ss, 2)}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

// ---------------------------------------------------------------------------
// Download trigger
// ---------------------------------------------------------------------------

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
