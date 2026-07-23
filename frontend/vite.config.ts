import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    // Never inline the AudioWorklet as a data: URL — some browsers refuse to
    // load a worklet module from data:. It must be emitted as a real .js asset
    // so `audioWorklet.addModule(new URL(...))` resolves to a fetchable file.
    assetsInlineLimit: (filePath: string) =>
      filePath.includes('pcm-worklet') ? false : undefined,
  },
});
