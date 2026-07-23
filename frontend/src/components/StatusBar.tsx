import type { ConnectionStatus, Notice } from '../types';

interface StatusBarProps {
  status: ConnectionStatus;
  speaking: boolean;
  notice: Notice | null;
  onDismissNotice: () => void;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  live: 'Live',
  stopping: 'Stopping…',
  error: 'Error',
};

export function StatusBar({ status, speaking, notice, onDismissNotice }: StatusBarProps) {
  return (
    <div className="statusbar">
      <div className="status-cluster">
        <span className={`status-dot status-${status}`} />
        <span className="status-text">{STATUS_LABEL[status]}</span>

        <span className={`vad ${speaking ? 'speaking' : ''}`} title="Voice activity">
          <span className="vad-dot" />
          {speaking ? 'Speaking' : 'Silent'}
        </span>
      </div>

      {notice && (
        <div className={`banner banner-${notice.kind}`} role="status">
          <span className="banner-text">{notice.text}</span>
          <button
            type="button"
            className="banner-close"
            onClick={onDismissNotice}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
