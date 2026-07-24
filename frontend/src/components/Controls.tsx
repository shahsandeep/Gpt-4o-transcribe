import type { AudioDevice } from '../hooks/useAudioDevices';
import type { Backend } from '../lib/backends';
import { INPUT_LANGUAGES, TARGET_LANGUAGES } from '../lib/languages';
import { MODE_LABELS, type Mode } from '../types';

const MODES: Mode[] = ['websocket', 'rest-batched', 'rest-full'];

interface ControlsProps {
  mode: Mode;
  onModeChange: (m: Mode) => void;

  backends: Backend[];
  backendId: string;
  onBackendChange: (id: string) => void;

  devices: AudioDevice[];
  selectedDeviceId: string | null;
  onDeviceChange: (id: string) => void;
  onRequestPermission: () => void;
  permission: 'unknown' | 'granted' | 'denied';

  inputLanguage: string;
  onInputLanguageChange: (code: string) => void;
  targetLanguage: string;
  onTargetLanguageChange: (code: string) => void;
  translate: boolean;
  onTranslateChange: (on: boolean) => void;

  audioCleanup: boolean;
  onAudioCleanupChange: (on: boolean) => void;
  serverEnhance: boolean;
  onServerEnhanceChange: (on: boolean) => void;

  isActive: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function Controls(props: ControlsProps) {
  const {
    mode,
    onModeChange,
    backends,
    backendId,
    onBackendChange,
    devices,
    selectedDeviceId,
    onDeviceChange,
    onRequestPermission,
    permission,
    inputLanguage,
    onInputLanguageChange,
    targetLanguage,
    onTargetLanguageChange,
    translate,
    onTranslateChange,
    audioCleanup,
    onAudioCleanupChange,
    serverEnhance,
    onServerEnhanceChange,
    isActive,
    onStart,
    onStop,
  } = props;

  const noDevices = devices.length === 0;
  const isRest = mode !== 'websocket';

  return (
    <div className="controls">
      <div className="controls-row">
        <label className="field wide">
          <span className="field-label">Mode</span>
          <div className="mode-switch" role="radiogroup" aria-label="Transcription mode">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={`mode-btn ${mode === m ? 'active' : ''}`}
                onClick={() => onModeChange(m)}
                disabled={isActive}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
        </label>
      </div>

      <div className="controls-row">
        <label className="field">
          <span className="field-label">Backend</span>
          <div className="backend-switch" role="radiogroup" aria-label="Backend">
            {backends.map((b) => (
              <button
                key={b.id}
                type="button"
                role="radio"
                aria-checked={backendId === b.id}
                className={`backend-btn ${backendId === b.id ? 'active' : ''}`}
                onClick={() => onBackendChange(b.id)}
                disabled={isActive}
                title={`${b.host}:${b.port}`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </label>

        <label className="field">
          <span className="field-label">Microphone</span>
          <div className="mic-row">
            <select
              className="select"
              value={selectedDeviceId ?? ''}
              onChange={(e) => onDeviceChange(e.target.value)}
              disabled={isActive || noDevices}
            >
              {noDevices && <option value="">No microphones found</option>}
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
            {permission !== 'granted' && (
              <button type="button" className="btn ghost small" onClick={onRequestPermission}>
                Grant mic
              </button>
            )}
          </div>
        </label>
      </div>

      <div className="controls-row">
        <label className="field">
          <span className="field-label">Input language</span>
          <select
            className="select"
            value={inputLanguage}
            onChange={(e) => onInputLanguageChange(e.target.value)}
            disabled={isActive}
            title="Changing input language requires a reconnect"
          >
            {INPUT_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Target language</span>
          <select
            className="select"
            value={targetLanguage}
            onChange={(e) => onTargetLanguageChange(e.target.value)}
            disabled={!translate}
          >
            {TARGET_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field toggle-field">
          <span className="field-label">Translate</span>
          <button
            type="button"
            role="switch"
            aria-checked={translate}
            className={`toggle ${translate ? 'on' : ''}`}
            onClick={() => onTranslateChange(!translate)}
          >
            <span className="toggle-knob" />
            <span className="toggle-text">{translate ? 'On' : 'Off'}</span>
          </button>
        </label>
      </div>

      <div className="controls-row">
        <label className="field toggle-field">
          <span className="field-label" title="Browser noise suppression, echo cancellation, and auto gain">
            Audio cleanup
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={audioCleanup}
            className={`toggle ${audioCleanup ? 'on' : ''}`}
            onClick={() => onAudioCleanupChange(!audioCleanup)}
            disabled={isActive}
          >
            <span className="toggle-knob" />
            <span className="toggle-text">{audioCleanup ? 'On' : 'Off'}</span>
          </button>
        </label>

        <label className="field toggle-field">
          <span
            className="field-label"
            title={
              isRest
                ? 'Server-side ffmpeg pass (high-pass, denoise, loudness normalize) before upload'
                : 'Server enhance applies to the REST modes only'
            }
          >
            Server enhance (ffmpeg)
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={serverEnhance && isRest}
            className={`toggle ${serverEnhance && isRest ? 'on' : ''}`}
            onClick={() => onServerEnhanceChange(!serverEnhance)}
            disabled={isActive || !isRest}
            title={isRest ? undefined : 'Available in REST modes only'}
          >
            <span className="toggle-knob" />
            <span className="toggle-text">{serverEnhance && isRest ? 'On' : 'Off'}</span>
          </button>
        </label>
      </div>

      <div className="controls-row actions">
        {!isActive ? (
          <button
            type="button"
            className="btn primary"
            onClick={onStart}
            disabled={noDevices}
          >
            ● Start
          </button>
        ) : (
          <button type="button" className="btn danger" onClick={onStop}>
            ■ Stop
          </button>
        )}
      </div>
    </div>
  );
}
