export type ReceiptPrintStatus = 'COMPLETED' | 'FAILED_SAFE' | 'NEEDS_REVIEW';

export interface ReceiptPrintStatusInfo {
  jobId: string;
  orderId: string;
  orderNumber?: string | null;
  status: ReceiptPrintStatus;
}

/** Minimal storage shape so the daily cap can be unit-tested without a DOM. */
export interface ReceiptPrintWarningStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ReceiptPrintStatusHandlerOptions {
  /** How many warnings may be shown per local calendar day. Default 2. */
  maxWarningsPerDay?: number;
  /** Persisted counter store (localStorage in the renderer). Optional. */
  storage?: ReceiptPrintWarningStorage | null;
  /** Clock override for tests. */
  now?: () => Date;
  /** Coalescing window in ms: statuses arriving together (startup replay) become one toast. */
  batchMs?: number;
  /** Timer override for tests. */
  schedule?: (fn: () => void, ms: number) => void;
}

const STORAGE_KEY_PREFIX = 'pos.receiptPrintWarn.';

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Builds the operator-facing warning text. Deliberately generic: it tells the
 * cashier that some of today's orders may not have printed and where to look,
 * without listing order numbers — the detail lives in Order History.
 */
export function formatReceiptPrintWarning(count: number): string {
  const n = Math.max(1, count);
  return n === 1
    ? 'Có 1 đơn hôm nay chưa chắc đã in hóa đơn — mở Lịch sử đơn để kiểm tra'
    : `Có ${n} đơn hôm nay chưa chắc đã in hóa đơn — mở Lịch sử đơn để kiểm tra`;
}

/**
 * Merge live main-process events with the durable startup snapshot.
 *
 * - The snapshot can resolve after a newer COMPLETED event. Once completion was
 *   observed, an older FAILED_SAFE/NEEDS_REVIEW snapshot must never resurrect a
 *   warning for that job.
 * - Unresolved jobs are coalesced into ONE generic toast ("N đơn hôm nay…")
 *   instead of one toast per order number.
 * - At most `maxWarningsPerDay` toasts are shown per local day per device; the
 *   counter is persisted so app restarts do not nag the cashier all day. A new
 *   day resets the counter (the main process also stops replaying yesterday's
 *   rows, so old orders never come back).
 */
export function createReceiptPrintStatusHandler(
  showWarning: (message: string) => void,
  options: ReceiptPrintStatusHandlerOptions = {},
): (info: ReceiptPrintStatusInfo) => void {
  const maxPerDay = options.maxWarningsPerDay ?? 2;
  const storage = options.storage ?? null;
  const now = options.now ?? (() => new Date());
  const batchMs = options.batchMs ?? 250;
  const schedule = options.schedule ?? ((fn, ms) => { setTimeout(fn, ms); });

  const latestStatus = new Map<string, ReceiptPrintStatus>();
  const completedJobs = new Set<string>();
  const unresolvedJobs = new Set<string>();
  let flushPending = false;
  let sessionCount = 0;

  const readDayCount = (dayKey: string): number => {
    if (!storage) return sessionCount;
    try {
      const raw = storage.getItem(STORAGE_KEY_PREFIX + dayKey);
      const n = raw ? Number.parseInt(raw, 10) : 0;
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return sessionCount;
    }
  };
  const writeDayCount = (dayKey: string, n: number): void => {
    sessionCount = n;
    if (!storage) return;
    try { storage.setItem(STORAGE_KEY_PREFIX + dayKey, String(n)); } catch { /* storage unavailable */ }
  };

  const flush = (): void => {
    flushPending = false;
    const pending = unresolvedJobs.size;
    unresolvedJobs.clear();
    if (pending === 0) return;
    const dayKey = localDayKey(now());
    const shown = readDayCount(dayKey);
    if (shown >= maxPerDay) return;
    writeDayCount(dayKey, shown + 1);
    showWarning(formatReceiptPrintWarning(pending));
  };

  return (info) => {
    const jobId = String(info?.jobId || '').trim();
    if (!jobId) return;

    if (info.status === 'COMPLETED') {
      completedJobs.add(jobId);
      latestStatus.set(jobId, info.status);
      unresolvedJobs.delete(jobId);
      return;
    }
    if (completedJobs.has(jobId) || latestStatus.get(jobId) === info.status) {
      return;
    }
    const wasUnresolved = latestStatus.has(jobId) && latestStatus.get(jobId) !== 'COMPLETED';
    latestStatus.set(jobId, info.status);
    // A job escalating FAILED_SAFE → NEEDS_REVIEW is the same order; do not count it twice.
    if (wasUnresolved) return;

    unresolvedJobs.add(jobId);
    if (!flushPending) {
      flushPending = true;
      schedule(flush, batchMs);
    }
  };
}
