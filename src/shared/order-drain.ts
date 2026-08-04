export const ORDER_SYNC_INTERVAL_MS = 30_000;
export const ORDER_SYNC_MAX_JITTER_MS = 5_000;

export interface PeriodicOrderDrain {
  start(): void;
  stop(): void;
}

/** Browser-safe periodic order drain, matching the Windows order-sync timer. */
export function createPeriodicOrderDrain(
  drain: () => Promise<void>,
  random: () => number = Math.random,
): PeriodicOrderDrain {
  let jitterTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  return {
    start(): void {
      if (jitterTimer !== null || intervalTimer !== null) return;

      const jitter = Math.floor(random() * ORDER_SYNC_MAX_JITTER_MS);
      jitterTimer = setTimeout(() => {
        jitterTimer = null;
        intervalTimer = setInterval(() => {
          if (inFlight) return;
          inFlight = true;
          void drain()
            .catch((err) => console.debug(`[OrderSync] Periodic sync error: ${err}`))
            .finally(() => { inFlight = false; });
        }, ORDER_SYNC_INTERVAL_MS);
      }, jitter);
    },

    stop(): void {
      if (jitterTimer !== null) {
        clearTimeout(jitterTimer);
        jitterTimer = null;
      }
      if (intervalTimer !== null) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
    },
  };
}
