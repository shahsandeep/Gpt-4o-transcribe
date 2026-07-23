import { useCallback, useMemo, useState } from 'react';
import { Controls } from './components/Controls';
import { StatusBar } from './components/StatusBar';
import { TranscriptView } from './components/TranscriptView';
import { useAudioDevices } from './hooks/useAudioDevices';
import { useTranscription } from './hooks/useTranscription';
import { BACKENDS, DEFAULT_BACKEND_ID, backendById, wsUrlFor } from './lib/backends';
import {
  downloadFile,
  exportableSegments,
  toJson,
  toSrt,
  toTxt,
  type ExportMeta,
} from './lib/export';

export default function App() {
  const {
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    requestPermission,
    permission,
    error: deviceError,
  } = useAudioDevices();

  const {
    status,
    segments,
    speaking,
    notice,
    isActive,
    start,
    stop,
    updateTarget,
    clearSegments,
    dismissNotice,
  } = useTranscription();

  const [backendId, setBackendId] = useState<string>(DEFAULT_BACKEND_ID);
  const [inputLanguage, setInputLanguage] = useState('auto');
  const [targetLanguage, setTargetLanguage] = useState('es');
  const [translate, setTranslate] = useState(true);

  const backend = useMemo(() => backendById(backendId), [backendId]);

  const handleStart = useCallback(() => {
    void start({
      deviceId: selectedDeviceId,
      inputLanguage,
      targetLanguage,
      translate,
      wsUrl: wsUrlFor(backend),
    });
  }, [start, selectedDeviceId, inputLanguage, targetLanguage, translate, backend]);

  // Live target-language change: update local state and, if a session is
  // running, push an `update` message so the backend switches without reconnect.
  const handleTargetLanguageChange = useCallback(
    (code: string) => {
      setTargetLanguage(code);
      if (isActive) updateTarget(code, translate);
    },
    [isActive, updateTarget, translate],
  );

  const handleTranslateChange = useCallback(
    (on: boolean) => {
      setTranslate(on);
      if (isActive) updateTarget(targetLanguage, on);
    },
    [isActive, updateTarget, targetLanguage],
  );

  const exportMeta = useCallback(
    (): ExportMeta => ({
      inputLanguage,
      targetLanguage,
      translate,
      backendLabel: backend.label,
      createdAt: new Date().toISOString(),
    }),
    [inputLanguage, targetLanguage, translate, backend],
  );

  const hasExport = exportableSegments(segments).length > 0;

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const doExport = useCallback(
    (kind: 'txt' | 'srt' | 'json') => {
      const meta = exportMeta();
      const base = `transcript-${stamp()}`;
      if (kind === 'txt') {
        downloadFile(`${base}.txt`, toTxt(segments, meta), 'text/plain;charset=utf-8');
      } else if (kind === 'srt') {
        downloadFile(`${base}.srt`, toSrt(segments), 'application/x-subrip;charset=utf-8');
      } else {
        downloadFile(`${base}.json`, toJson(segments, meta), 'application/json;charset=utf-8');
      }
    },
    [segments, exportMeta],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◎</span>
          <div>
            <h1>Live Transcribe &amp; Translate</h1>
            <p className="subtitle">Azure GPT-4o realtime speech · Python or .NET backend</p>
          </div>
        </div>
      </header>

      <StatusBar
        status={status}
        speaking={speaking}
        notice={notice}
        onDismissNotice={dismissNotice}
      />

      {deviceError && (
        <div className="banner banner-error standalone" role="alert">
          <span className="banner-text">{deviceError}</span>
        </div>
      )}

      <main className="layout">
        <section className="panel controls-panel">
          <Controls
            backends={BACKENDS}
            backendId={backendId}
            onBackendChange={setBackendId}
            devices={devices}
            selectedDeviceId={selectedDeviceId}
            onDeviceChange={setSelectedDeviceId}
            onRequestPermission={() => void requestPermission()}
            permission={permission}
            inputLanguage={inputLanguage}
            onInputLanguageChange={setInputLanguage}
            targetLanguage={targetLanguage}
            onTargetLanguageChange={handleTargetLanguageChange}
            translate={translate}
            onTranslateChange={handleTranslateChange}
            isActive={isActive}
            onStart={handleStart}
            onStop={stop}
          />

          <div className="export">
            <div className="export-header">
              <span className="field-label">Export</span>
              {hasExport && !isActive && (
                <button type="button" className="btn ghost small" onClick={clearSegments}>
                  Clear
                </button>
              )}
            </div>
            <div className="export-buttons">
              <button
                type="button"
                className="btn ghost"
                onClick={() => doExport('txt')}
                disabled={!hasExport}
              >
                .txt
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => doExport('srt')}
                disabled={!hasExport}
              >
                .srt
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => doExport('json')}
                disabled={!hasExport}
              >
                .json
              </button>
            </div>
          </div>
        </section>

        <section className="panel transcript-panel">
          <TranscriptView segments={segments} translate={translate} />
        </section>
      </main>

      <footer className="app-footer">
        <span>
          Connected target: <code>{wsUrlFor(backend)}</code>
        </span>
      </footer>
    </div>
  );
}
