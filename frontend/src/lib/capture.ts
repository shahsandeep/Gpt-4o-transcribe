// Shared microphone → PCM16 capture pipeline, used by BOTH the realtime
// (WebSocket) and the REST transcription paths.
//
// It owns the AudioContext (forced to 24 kHz so the browser resamples the mic
// for us), the AudioWorklet, and the MediaStream. Each ~100 ms Int16 chunk from
// the worklet is (a) handed to an optional `onChunk` callback (the WS path
// streams it; the REST batched path buffers it) and (b) accumulated so the whole
// session can be encoded to a WAV for playback / download / full-audio REST.

export interface PcmCaptureOptions {
  deviceId: string | null;
  /** Enable the browser's noise suppression / echo cancel / auto-gain. Default true. */
  audioCleanup?: boolean;
  /** Called for every ~100 ms Int16 chunk as it is captured. */
  onChunk?: (chunk: Int16Array) => void;
}

export class PcmCapture {
  readonly sampleRate = 24000;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;

  private allChunks: Int16Array[] = [];
  private totalSamples = 0;
  private onChunk?: (chunk: Int16Array) => void;

  async start(opts: PcmCaptureOptions): Promise<void> {
    this.onChunk = opts.onChunk;

    const ctx = new AudioContext({ sampleRate: this.sampleRate });
    this.ctx = ctx;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
    }

    // Vite rewrites this new URL(...) to the hashed worklet asset in dev + build.
    await ctx.audioWorklet.addModule(
      new URL('../worklets/pcm-worklet.js', import.meta.url).href,
    );

    // Explicitly drive the browser's built-in cleanup (WebRTC noise suppression,
    // echo cancellation, auto gain) instead of relying on undefined defaults.
    const cleanup = opts.audioCleanup !== false;
    const audio: MediaTrackConstraints = {
      channelCount: 1,
      noiseSuppression: cleanup,
      echoCancellation: cleanup,
      autoGainControl: cleanup,
    };
    if (opts.deviceId) audio.deviceId = { exact: opts.deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.stream = stream;

    const source = ctx.createMediaStreamSource(stream);
    this.source = source;

    const worklet = new AudioWorkletNode(ctx, 'pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    this.worklet = worklet;

    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const chunk = new Int16Array(e.data);
      this.allChunks.push(chunk);
      this.totalSamples += chunk.length;
      this.onChunk?.(chunk);
    };

    source.connect(worklet);
    // Keep the node processing. We never write output, so this is silent.
    worklet.connect(ctx.destination);
  }

  /** Total captured audio duration so far, in milliseconds. */
  get durationMs(): number {
    return Math.round((this.totalSamples / this.sampleRate) * 1000);
  }

  /** True once any audio has been captured. */
  get hasAudio(): boolean {
    return this.totalSamples > 0;
  }

  /** A copy of all captured Int16 chunks (for encoding a WAV). */
  getAllChunks(): Int16Array[] {
    return this.allChunks;
  }

  /** Tear down the audio graph. Captured chunks are preserved for encoding. */
  stop(): void {
    try {
      if (this.worklet) this.worklet.port.onmessage = null;
    } catch {
      /* best effort */
    }
    try {
      this.worklet?.disconnect();
    } catch {
      /* best effort */
    }
    try {
      this.source?.disconnect();
    } catch {
      /* best effort */
    }
    this.stream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* best effort */
      }
    });
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close().catch(() => undefined);
    }
    this.worklet = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.onChunk = undefined;
  }
}
