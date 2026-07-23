// Encode mono 16-bit PCM (as produced by the pcm-worklet) into a WAV Blob.
//
// The realtime and REST paths both capture Int16 samples at 24 kHz. WAV is the
// simplest container that is (a) a standalone, valid file for every 5-second
// slice, (b) directly playable in an <audio> element, and (c) accepted by the
// Azure /audio/transcriptions endpoint.

const BYTES_PER_SAMPLE = 2;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** Merge Int16 chunks and wrap them in a 44-byte WAV header. */
export function encodeWav(chunks: Int16Array[], sampleRate: number): Blob {
  let totalSamples = 0;
  for (const c of chunks) totalSamples += c.length;

  const merged = new Int16Array(totalSamples);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  const dataBytes = totalSamples * BYTES_PER_SAMPLE;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // RIFF chunk size
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  // merged.buffer is little-endian on every mainstream browser/CPU, which
  // matches the WAV spec, so we can append it directly without re-encoding.
  return new Blob([header, merged.buffer], { type: 'audio/wav' });
}

/** Duration of a set of chunks in milliseconds at the given sample rate. */
export function chunksDurationMs(chunks: Int16Array[], sampleRate: number): number {
  let total = 0;
  for (const c of chunks) total += c.length;
  return Math.round((total / sampleRate) * 1000);
}
