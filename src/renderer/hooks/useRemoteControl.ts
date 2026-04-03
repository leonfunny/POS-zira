/** useRemoteControl – wraps electronAPI remote control operations */

import { useState, useEffect, useCallback } from 'react';
import type { RemoteControlState } from '../../shared/types';
import rlog from '../utils/logger';

const INITIAL_STATE: RemoteControlState = {
  isBeingControlled: false,
  session: null,
};

export function useRemoteControl() {
  const [state, setState] = useState<RemoteControlState>(INITIAL_STATE);

  useEffect(() => {
    window.electronAPI.remote.getState()
      .then(setState)
      .catch((err) => rlog.error('[useRemoteControl] Failed to load:', err));

    const unsub = window.electronAPI.remote.onStateChanged(setState);
    return unsub;
  }, []);

  const acceptSession = useCallback(async () => {
    await window.electronAPI.remote.acceptSession();
  }, []);

  const rejectSession = useCallback(async (reason?: string) => {
    await window.electronAPI.remote.rejectSession(reason);
  }, []);

  const endSession = useCallback(async (reason?: string) => {
    await window.electronAPI.remote.endSession(reason);
  }, []);

  return {
    state,
    acceptSession,
    rejectSession,
    endSession,
  };
}
