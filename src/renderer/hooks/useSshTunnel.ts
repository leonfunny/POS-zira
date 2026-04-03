/** useSshTunnel – wraps electronAPI SSH tunnel operations */

import { useState, useEffect, useCallback } from 'react';
import type { SshTunnelStatus } from '../../shared/types';
import rlog from '../utils/logger';

export function useSshTunnel() {
  const [status, setStatus] = useState<SshTunnelStatus | null>(null);

  useEffect(() => {
    window.electronAPI.sshTunnel.getStatus()
      .then(setStatus)
      .catch((err) => rlog.error('[useSshTunnel] Failed to load:', err));

    const unsub = window.electronAPI.sshTunnel.onStatusChanged(setStatus);
    return unsub;
  }, []);

  const start = useCallback(async () => {
    return window.electronAPI.sshTunnel.start();
  }, []);

  const disconnect = useCallback(async () => {
    await window.electronAPI.sshTunnel.disconnect();
  }, []);

  const generateKey = useCallback(async () => {
    return window.electronAPI.sshTunnel.generateKey();
  }, []);

  return {
    status,
    start,
    disconnect,
    generateKey,
  };
}
