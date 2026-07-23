// AudioWorklet processor: receives Float32 mic frames (128 samples/quantum at
// the context's 24 kHz sample rate), converts them to PCM16 little-endian, and
// posts ~100 ms chunks to the main thread as transferable ArrayBuffers.
//
// Loaded via `audioContext.audioWorklet.addModule(new URL(...))` from the hook.
// Kept as a plain .js file so Vite emits it verbatim as a worklet module.

const CHUNK_SAMPLES = 2400; // 100 ms at 24 kHz — low latency, few messages/sec.

class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(CHUNK_SAMPLES);
    this._n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    // No input connected yet (e.g. between graph teardown) — keep the node alive.
    if (!input || input.length === 0) return true;
    const channel = input[0]; // mono: first channel only
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buf[this._n++] = channel[i];
      if (this._n === CHUNK_SAMPLES) {
        this._flush();
      }
    }
    return true;
  }

  _flush() {
    const pcm = new Int16Array(this._n);
    for (let j = 0; j < this._n; j++) {
      // Clamp to [-1, 1], then map to full Int16 range with correct asymmetry.
      let s = this._buf[j];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this._n = 0;
    // Transfer the underlying buffer to avoid a copy.
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
