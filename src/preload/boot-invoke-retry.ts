/**
 * Boot-race shield for ipcRenderer.invoke.
 *
 * Module IPC handlers register late in main-process boot — hardware probing
 * alone held Init for ~30s on POS1 Chesaigon — while a window can exist much
 * earlier: double-clicking the app while it boots fires second-instance →
 * showWindow(). Every invoke made from that early renderer then rejects with
 * "No handler registered for '<channel>'" and the renderer hard-fails into
 * an init-error screen (incident 2026-07-06 18:33 & 22:53).
 *
 * One choke point in front of all invokes retries exactly that error while
 * the renderer is young. A missing handler after the boot window (or any
 * other error) still fails fast — post-boot it is a real wiring bug.
 */

type InvokeFn = (channel: string, ...args: any[]) => Promise<any>;

export const BOOT_RETRY_WINDOW_MS = 120_000;
export const BOOT_RETRY_DELAY_MS = 400;

export function isNoHandlerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('No handler registered for');
}

export interface BootRetryOptions {
  bootWindowMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once per invoke that exhausts the boot window with no handler. */
  onRetryExhausted?: (channel: string, waitedMs: number) => void;
}

export function createBootRetryInvoke(
  rawInvoke: InvokeFn,
  options: BootRetryOptions = {},
): InvokeFn {
  const bootWindowMs = options.bootWindowMs ?? BOOT_RETRY_WINDOW_MS;
  const retryDelayMs = options.retryDelayMs ?? BOOT_RETRY_DELAY_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const bootStartedAt = now();

  return async (channel: string, ...args: any[]): Promise<any> => {
    for (;;) {
      try {
        return await rawInvoke(channel, ...args);
      } catch (err) {
        if (!isNoHandlerError(err)) throw err;
        const waitedMs = now() - bootStartedAt;
        if (waitedMs >= bootWindowMs) {
          options.onRetryExhausted?.(channel, waitedMs);
          throw err;
        }
        await sleep(retryDelayMs);
      }
    }
  };
}
