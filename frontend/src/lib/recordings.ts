// Browser-side storage for captured audio, backed by IndexedDB. Recordings
// survive reloads so you can replay them, download them, or re-run full-audio
// REST transcription on the exact same audio to compare against the batched
// result. Nothing is ever uploaded except when you explicitly transcribe.

const DB_NAME = 'gpt4o-transcribe';
const STORE = 'recordings';
const DB_VERSION = 1;

export type RecordingMode = 'websocket' | 'rest-batched' | 'rest-full';

export interface RecordingMeta {
  id: string;
  name: string;
  createdAt: number; // epoch ms
  mode: RecordingMode;
  durationMs: number;
  sampleRate: number;
  size: number; // bytes
  inputLanguage: string;
  targetLanguage: string;
}

export interface StoredRecording extends RecordingMeta {
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const store = transaction.objectStore(STORE);
        const request = run(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        transaction.oncomplete = () => db.close();
      }),
  );
}

export async function saveRecording(rec: StoredRecording): Promise<void> {
  await tx('readwrite', (store) => store.put(rec));
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  const all = await tx<StoredRecording[]>('readonly', (store) => store.getAll());
  return all
    .map(({ blob: _blob, ...meta }) => meta)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRecording(id: string): Promise<StoredRecording | undefined> {
  return tx<StoredRecording | undefined>('readonly', (store) => store.get(id));
}

export async function deleteRecording(id: string): Promise<void> {
  await tx('readwrite', (store) => store.delete(id));
}

export async function clearRecordings(): Promise<void> {
  await tx('readwrite', (store) => store.clear());
}

/** Best-effort unique id (crypto.randomUUID where available). */
export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `rec-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
