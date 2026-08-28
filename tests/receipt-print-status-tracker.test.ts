import { describe, expect, it, vi } from 'vitest';
import {
  createReceiptPrintStatusHandler,
  type ReceiptPrintStatusInfo,
  type ReceiptPrintWarningStorage,
} from '../src/renderer/components/pos/receipt-print-status-tracker';

function memoryStorage(): ReceiptPrintWarningStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
  };
}

// Runs the coalescing flush synchronously so tests need no fake timers.
const immediate = (fn: () => void) => { fn(); };

describe('receipt print status tracker', () => {
  it('does not resurrect a stale warning when COMPLETED arrives before replay resolves', async () => {
    const warnings = vi.fn();
    const handleStatus = createReceiptPrintStatusHandler(warnings, { schedule: immediate });
    let resolveSnapshot!: (rows: ReceiptPrintStatusInfo[]) => void;
    const snapshot = new Promise<ReceiptPrintStatusInfo[]>((resolve) => {
      resolveSnapshot = resolve;
    });
    const replay = snapshot.then((rows) => rows.forEach(handleStatus));

    handleStatus({ jobId: 'job-1', orderId: 'order-1', orderNumber: 'ZAM-0001', status: 'COMPLETED' });
    resolveSnapshot([{ jobId: 'job-1', orderId: 'order-1', orderNumber: 'ZAM-0001', status: 'FAILED_SAFE' }]);
    await replay;

    expect(warnings).not.toHaveBeenCalled();
  });

  it('deduplicates the same job and does not re-warn when it escalates to NEEDS_REVIEW', () => {
    const warnings = vi.fn();
    const handleStatus = createReceiptPrintStatusHandler(warnings, { schedule: immediate });
    const base = { jobId: 'job-2', orderId: 'order-2', orderNumber: 'ZAM-0002' };

    handleStatus({ ...base, status: 'FAILED_SAFE' });
    handleStatus({ ...base, status: 'FAILED_SAFE' });
    handleStatus({ ...base, status: 'NEEDS_REVIEW' });

    expect(warnings).toHaveBeenCalledTimes(1);
  });

  it('coalesces a startup replay of many rows into one generic toast without order numbers', () => {
    const warnings = vi.fn();
    const scheduled: Array<() => void> = [];
    const handleStatus = createReceiptPrintStatusHandler(warnings, { schedule: (fn) => { scheduled.push(fn); } });

    handleStatus({ jobId: 'a', orderId: 'o-a', orderNumber: 'ZAM-20260827-0001', status: 'FAILED_SAFE' });
    handleStatus({ jobId: 'b', orderId: 'o-b', orderNumber: 'ZAM-20260827-0002', status: 'NEEDS_REVIEW' });
    handleStatus({ jobId: 'c', orderId: 'o-c', orderNumber: 'ZAM-20260827-0003', status: 'FAILED_SAFE' });
    expect(warnings).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    scheduled[0]();

    expect(warnings).toHaveBeenCalledTimes(1);
    const msg = warnings.mock.calls[0][0] as string;
    expect(msg).toMatch(/3 đơn hôm nay/);
    expect(msg).not.toMatch(/ZAM-/);
  });

  it('shows at most 2 warnings per local day, persisted across handler instances (app restarts)', () => {
    const storage = memoryStorage();
    const day = () => new Date(2026, 7, 27, 10, 0, 0);
    const warnings = vi.fn();
    const mk = () => createReceiptPrintStatusHandler(warnings, { schedule: immediate, storage, now: day });

    mk()({ jobId: 'j1', orderId: 'o1', status: 'FAILED_SAFE' });
    mk()({ jobId: 'j2', orderId: 'o2', status: 'FAILED_SAFE' });
    mk()({ jobId: 'j3', orderId: 'o3', status: 'FAILED_SAFE' });
    mk()({ jobId: 'j4', orderId: 'o4', status: 'NEEDS_REVIEW' });

    expect(warnings).toHaveBeenCalledTimes(2);
    expect(storage.data.get('pos.receiptPrintWarn.2026-08-27')).toBe('2');
  });

  it('resets the daily cap on a new local day', () => {
    const storage = memoryStorage();
    const warnings = vi.fn();
    let current = new Date(2026, 7, 27, 23, 50, 0);
    const handle = createReceiptPrintStatusHandler(warnings, { schedule: immediate, storage, now: () => current });

    handle({ jobId: 'j1', orderId: 'o1', status: 'FAILED_SAFE' });
    handle({ jobId: 'j2', orderId: 'o2', status: 'FAILED_SAFE' });
    handle({ jobId: 'j3', orderId: 'o3', status: 'FAILED_SAFE' });
    expect(warnings).toHaveBeenCalledTimes(2);

    current = new Date(2026, 7, 28, 0, 5, 0);
    handle({ jobId: 'j4', orderId: 'o4', status: 'FAILED_SAFE' });
    expect(warnings).toHaveBeenCalledTimes(3);
  });

  it('caps per session even without storage', () => {
    const warnings = vi.fn();
    const handle = createReceiptPrintStatusHandler(warnings, { schedule: immediate, maxWarningsPerDay: 1 });
    handle({ jobId: 'j1', orderId: 'o1', status: 'FAILED_SAFE' });
    handle({ jobId: 'j2', orderId: 'o2', status: 'FAILED_SAFE' });
    expect(warnings).toHaveBeenCalledTimes(1);
  });
});
