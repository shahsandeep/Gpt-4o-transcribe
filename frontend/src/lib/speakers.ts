// Per-speaker color + label helpers for diarized transcripts.

const SPEAKER_COLORS = [
  '#5b8cff', // A - blue
  '#37d67a', // B - green
  '#f5b041', // C - amber
  '#c07bff', // D - purple
  '#ff6fa5', // E - pink
  '#3ec8d8', // F - teal
  '#ff8a5b', // G - orange
  '#9ccc65', // H - lime
];

/** Stable index for a speaker label. A..Z map to 0..25; anything else hashes. */
function speakerIndex(speaker: string | null | undefined): number {
  if (!speaker) return -1;
  const s = speaker.trim().toUpperCase();
  const code = s.charCodeAt(0);
  if (s.length === 1 && code >= 65 && code <= 90) return code - 65; // A..Z
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Color for a speaker, or null when there is no speaker (non-diarized). */
export function speakerColor(speaker: string | null | undefined): string | null {
  const i = speakerIndex(speaker);
  if (i < 0) return null;
  return SPEAKER_COLORS[i % SPEAKER_COLORS.length];
}

/** Display name for a speaker label, e.g. "Speaker A". */
export function speakerName(speaker: string | null | undefined): string | null {
  if (!speaker) return null;
  return `Speaker ${speaker.trim().toUpperCase()}`;
}
