/**
 * useConnectionStatus – wraps electronAPI connection status
 *
 * Provides real-time connection status and device info.
 */

import { useState, useEffect, useCallback } from 'react';

interface ConnectionInfo {
  connected: boolean;
  lastConnectedAt?: Date;
  deviceStatus: {
    printerConnected: boolean;
    scannerActive: boolean;
    appVersion: string;
  } | null;
}

export function useConnectionStatus() {
  const [info, setInfo] = useState<ConnectionInfo>({
    connected: false,
    deviceStatus: null,
  });

  useEffect(() => {
    // Fetch initial status
    window.electronAPI.getStatus().then((status) => {
      setInfo({
        connected: status.connected,
        deviceStatus: status.deviceStatus,
      });
    });

    // Subscribe to real-time updates
    const unsub = window.electronAPI.onConnectionStatus((status) => {
      setInfo((prev) => ({
        ...prev,
        connected: status.connected,
        lastConnectedAt: status.connected ? new Date() : prev.lastConnectedAt,
      }));
    });

    return unsub;
  }, []);

  const reconnect = useCallback(async () => {
    return window.electronAPI.connect();
  }, []);

  const disconnect = useCallback(async () => {
    return window.electronAPI.disconnect();
  }, []);

  return {
    connected: info.connected,
    deviceStatus: info.deviceStatus,
    lastConnectedAt: info.lastConnectedAt,
    reconnect,
    disconnect,
  };
}
