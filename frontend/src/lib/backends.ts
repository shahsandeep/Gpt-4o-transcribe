// Backend definitions for the in-app switcher. Both backends implement the
// identical WebSocket protocol (docs/WEBSOCKET_PROTOCOL.md); only host:port
// differs. Hosts default to the current page hostname so the app works whether
// served from localhost in dev or from a container/host in prod, and can be
// overridden per-backend via VITE_ env vars.

export interface Backend {
  id: string;
  label: string;
  host: string;
  port: number;
}

const PAGE_HOST =
  typeof window !== 'undefined' && window.location.hostname
    ? window.location.hostname
    : 'localhost';

const PYTHON_HOST = import.meta.env.VITE_PYTHON_HOST ?? PAGE_HOST;
const DOTNET_HOST = import.meta.env.VITE_DOTNET_HOST ?? PAGE_HOST;

export const BACKENDS: Backend[] = [
  {
    id: 'python',
    label: 'Python · :8000',
    host: PYTHON_HOST,
    port: Number(import.meta.env.VITE_PYTHON_PORT ?? 8000),
  },
  {
    id: 'dotnet',
    label: '.NET · :8080',
    host: DOTNET_HOST,
    port: Number(import.meta.env.VITE_DOTNET_PORT ?? 8080),
  },
];

export const DEFAULT_BACKEND_ID = BACKENDS[0].id;

/** Build the transcription WebSocket URL for a backend. */
export function wsUrlFor(backend: Backend): string {
  const scheme = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${backend.host}:${backend.port}/ws/transcribe`;
}

export function backendById(id: string): Backend {
  return BACKENDS.find((b) => b.id === id) ?? BACKENDS[0];
}
