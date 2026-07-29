import { describe, expect, it, vi } from 'vitest';
import {
  createReceiptPrintStatusHandler,
  type ReceiptPrintStatusInfo,
} from '../src/renderer/components/pos/receipt-print-status-tracker';

describe('receipt print status tracker', () => {
  it('does not resurrect a stale warning when COMPLETED arrives before replay resolves', async () => {
    const warnings = vi.fn();
    const handleStatus = createReceiptPrintStatusHandler(warnings);
    let resolveSnapshot!: (rows: ReceiptPrintStatusInfo[]) => void;
    const snapshot = new Promise<ReceiptPrintStatusInfo[]>((resolve) => {
      resolveSnapshot = resolve;
    });
    const replay = snapshot.then((rows) => rows.forEach(handleStatus));

    handleStatus({
      jobId: 'job-1',
      orderId: 'order-1',
      orderNumber: 'ZAM-0001',
      status: 'COMPLETED',
    });
    resolveSnapshot([{
      jobId: 'job-1',
      orderId: 'order-1',
      orderNumber: 'ZAM-0001',
      status: 'FAILED_SAFE',
    }]);
    await replay;

    expect(warnings).not.toHaveBeenCalled();
  });

  it('deduplicates the same unresolved status but surfaces a stronger review status', () => {
    const warnings = vi.fn();
    const handleStatus = createReceiptPrintStatusHandler(warnings);
    const base = {
      jobId: 'job-2',
      orderId: 'order-2',
      orderNumber: 'ZAM-0002',
    };

    handleStatus({ ...base, status: 'FAILED_SAFE' });
    handleStatus({ ...base, status: 'FAILED_SAFE' });
    handleStatus({ ...base, status: 'NEEDS_REVIEW' });

    expect(warnings).toHaveBeenCalledTimes(2);
    expect(warnings.mock.calls[1][0]).toMatch(/chưa chắc chắn/);
  });
});
