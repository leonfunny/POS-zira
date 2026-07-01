import { useCallback, useEffect, useRef, useState } from 'react';

export type KioskIdlePhase =
  | 'active'
  | { phase: 'warning'; secondsLeft: number }
  | 'expired';

export interface UseKioskIdleResetOptions {
  enabled: boolean;
  warnAfterMs: number;
  resetAfterMs: number;
  onReset: () => void;
}

export interface UseKioskIdleResetResult {
  warning: boolean;
  secondsLeft: number;
  dismissWarning: () => void;
}

export function computeIdlePhase(
  lastActivity: number,
  now: number,
  warnAfterMs: number,
  resetAfterMs: number,
): KioskIdlePhase {
  const warnAt = Math.max(0, warnAfterMs);
  const resetAt = Math.max(0, resetAfterMs);
  const idleMs = Math.max(0, now - lastActivity);

  if (idleMs >= resetAt) return 'expired';
  if (idleMs >= warnAt) {
    return {
      phase: 'warning',
      secondsLeft: Math.max(0, Math.ceil((resetAt - idleMs) / 1000)),
    };
  }
  return 'active';
}

export function useKioskIdleReset({
  enabled,
  warnAfterMs,
  resetAfterMs,
  onReset,
}: UseKioskIdleResetOptions): UseKioskIdleResetResult {
  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const lastActivityRef = useRef(Date.now());
  const resetCalledRef = useRef(false);
  const onResetRef = useRef(onReset);

  useEffect(() => {
    onResetRef.current = onReset;
  }, [onReset]);

  const resetIdleTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
    resetCalledRef.current = false;
    setWarning(false);
    setSecondsLeft(0);
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      resetCalledRef.current = false;
      setWarning(false);
      setSecondsLeft(0);
      return undefined;
    }

    resetIdleTimer();

    const updatePhase = () => {
      const phase = computeIdlePhase(
        lastActivityRef.current,
        Date.now(),
        warnAfterMs,
        resetAfterMs,
      );

      if (phase === 'active') {
        setWarning(false);
        setSecondsLeft(0);
        return;
      }

      if (phase === 'expired') {
        setWarning(false);
        setSecondsLeft(0);
        if (!resetCalledRef.current) {
          resetCalledRef.current = true;
          onResetRef.current();
        }
        return;
      }

      setWarning(true);
      setSecondsLeft(phase.secondsLeft);
    };

    updatePhase();
    const interval = window.setInterval(updatePhase, 250);
    const listenerOptions: AddEventListenerOptions = { passive: true };
    window.addEventListener('pointerdown', resetIdleTimer, listenerOptions);
    window.addEventListener('keydown', resetIdleTimer, listenerOptions);
    window.addEventListener('touchstart', resetIdleTimer, listenerOptions);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('pointerdown', resetIdleTimer);
      window.removeEventListener('keydown', resetIdleTimer);
      window.removeEventListener('touchstart', resetIdleTimer);
    };
  }, [enabled, resetAfterMs, resetIdleTimer, warnAfterMs]);

  return {
    warning,
    secondsLeft,
    dismissWarning: resetIdleTimer,
  };
}
