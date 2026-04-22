/**
 * Per-port serial mutex — ensures only one operation accesses a COM port at a time.
 * All serial I/O (connect, identify, test print, receipt, health check, probe)
 * must acquire the lock before opening the port.
 */

import logger from '../../logger';

export type PortLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'PORT_BUSY'; message: string };

class PortLock {
  private queue: Array<{ resolve: () => void }> = [];
  private locked = false;

  async acquire(timeoutMs = 15000): Promise<boolean> {
    if (!this.locked) {
      this.locked = true;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;

      const entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };

      timer = setTimeout(() => {
        const idx = this.queue.findIndex(e => e.resolve === entry.resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        resolve(false);
      }, timeoutMs);

      this.queue.push(entry);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve();
    } else {
      this.locked = false;
    }
  }

  isLocked(): boolean {
    return this.locked;
  }
}

const portLocks = new Map<string, PortLock>();

function getLock(port: string): PortLock {
  const key = port.toUpperCase();
  let lock = portLocks.get(key);
  if (!lock) {
    lock = new PortLock();
    portLocks.set(key, lock);
  }
  return lock;
}

/**
 * Execute an operation while holding the serial port lock.
 * If the port is already locked and timeout expires, returns PORT_BUSY error.
 */
export async function withPortLock<T>(port: string, operation: string, fn: () => Promise<T>): Promise<PortLockResult<T>> {
  const lock = getLock(port);
  const acquired = await lock.acquire();
  if (!acquired) {
    logger.warn(`[PortMutex] PORT_BUSY: ${port} locked, cannot run "${operation}"`);
    return { ok: false, error: 'PORT_BUSY', message: `Port ${port} is busy (another operation in progress)` };
  }

  try {
    logger.debug(`[PortMutex] Acquired lock on ${port} for "${operation}"`);
    const value = await fn();
    return { ok: true, value };
  } finally {
    lock.release();
    logger.debug(`[PortMutex] Released lock on ${port} for "${operation}"`);
  }
}

export function isPortBusy(port: string): boolean {
  const lock = portLocks.get(port.toUpperCase());
  return lock?.isLocked() ?? false;
}
