import { useCallback, useEffect, useState } from 'react';

export interface AudioDevice {
  deviceId: string;
  label: string;
}

interface UseAudioDevices {
  devices: AudioDevice[];
  selectedDeviceId: string | null;
  setSelectedDeviceId: (id: string) => void;
  /** Prompt for mic permission, then (re)enumerate so labels are populated. */
  requestPermission: () => Promise<void>;
  permission: 'unknown' | 'granted' | 'denied';
  refresh: () => Promise<void>;
  error: string | null;
}

/**
 * Enumerate audio input devices and track the selected one.
 *
 * enumerateDevices() returns empty labels until the user grants mic permission,
 * so we expose requestPermission() which calls getUserMedia once (immediately
 * releasing the stream) and then re-enumerates to pick up real labels.
 */
export function useAudioDevices(): UseAudioDevices {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [permission, setPermission] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError('This browser does not support media device enumeration.');
      return;
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs: AudioDevice[] = all
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${i + 1}`,
        }));
      setDevices(inputs);
      setSelectedDeviceId((prev) => {
        if (prev && inputs.some((d) => d.deviceId === prev)) return prev;
        return inputs[0]?.deviceId ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enumerate devices.');
    }
  }, []);

  const requestPermission = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support microphone capture.');
      setPermission('denied');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // We only wanted the permission grant + labels; release immediately.
      stream.getTracks().forEach((t) => t.stop());
      setPermission('granted');
      setError(null);
      await refresh();
    } catch (e) {
      setPermission('denied');
      setError(
        e instanceof Error
          ? `Microphone permission denied: ${e.message}`
          : 'Microphone permission denied.',
      );
    }
  }, [refresh]);

  useEffect(() => {
    // Initial enumeration (labels may be empty until permission is granted).
    void refresh();

    const handler = () => void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', handler);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handler);
    };
  }, [refresh]);

  return {
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    requestPermission,
    permission,
    refresh,
    error,
  };
}
