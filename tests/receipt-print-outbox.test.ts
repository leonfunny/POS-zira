import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    markDirty: vi.fn(),
  },
}));

vi.mock('../src/main/logger', () => ({
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  receiptPrintPayloadHash,
  stableReceiptPrintPayloadJson,
  type ReceiptPrintOutboxFailureClass,
  type ReceiptPrintOutboxRoute,
  type ReceiptPrintOutboxRow,
  type ReceiptPrintOutboxStatus,
} from '../src/main/database/repos/receipt-print-outbox-repo';
import {
  ReceiptPrintOutbox,
  type ReceiptPrintDispatchResult,
  type ReceiptPrintOutboxRepository,
} from '../src/main/printing/receipt-print-outbox';

function makeRow(
  seq: number,
  status: ReceiptPrintOutboxStatus = 'PENDING',
  overrides: Partial<ReceiptPrintOutboxRow> = {},
): ReceiptPrintOutboxRow {
  const payloadJson = stableReceiptPrintPayloadJson({
    orderId: `order-${seq}`,
    items: [{ name: `Item ${seq}`, quantity: 1 }],
  });
  return {
    seq,
    job_id: `job-${seq}`,
    idempotency_key: `pos-receipt:pos-1:order-${seq}:order:v1`,
    order_id: `order-${seq}`,
    salon_id: 'salon-1',
    device_id: 'pos-1',
    shift_id: 'shift-1',
    document_type: 'INITIAL_ORDER_COPY',
    open_drawer: 1,
    payload_json: payloadJson,
    payload_hash: receiptPrintPayloadHash(payloadJson),
    route: null,
    printer_id: null,
    remote_job_id: null,
    status,
    failure_class: null,
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    created_at: '2026-07-29T10:00:00.000Z',
    updated_at: '2026-07-29T10:00:00.000Z',
    dispatched_at: null,
    completed_at: null,
    ...overrides,
  };
}

class MemoryRepo implements ReceiptPrintOutboxRepository {
  readonly rows: ReceiptPrintOutboxRow[];

  constructor(rows: ReceiptPrintOutboxRow[]) {
    this.rows = rows.sort((a, b) => a.seq - b.seq);
  }

  getByJobId(jobId: string): ReceiptPrintOutboxRow | null {
    return this.rows.find((row) => row.job_id === jobId) ?? null;
  }

  getHead(salonId: string, deviceId: string): ReceiptPrintOutboxRow | null {
    return this.rows.find((row) =>
      row.salon_id === salonId
      && row.device_id === deviceId
      && ['PENDING', 'FAILED_SAFE', 'REMOTE_ACCEPTED'].includes(row.status)
    ) ?? null;
  }

  markDispatching(jobId: string, updatedAt?: string): ReceiptPrintOutboxRow | null {
    const row = this.getByJobId(jobId);
    if (!row || !['PENDING', 'FAILED_SAFE'].includes(row.status)) return row;
    row.status = 'DISPATCHING';
    row.attempts += 1;
    row.failure_class = null;
    row.last_error = null;
    row.next_attempt_at = null;
    row.dispatched_at = updatedAt || row.updated_at;
    row.updated_at = updatedAt || row.updated_at;
    return row;
  }

  markRemoteAccepted(jobId: string, input: {
    printerId: string;
    remoteJobId: string;
    nextAttemptAt: string;
    error?: string | null;
    updatedAt?: string;
  }): ReceiptPrintOutboxRow | null {
    const row = this.getByJobId(jobId);
    if (!row || !['DISPATCHING', 'REMOTE_ACCEPTED'].includes(row.status)) return row;
    row.status = 'REMOTE_ACCEPTED';
    row.route = 'SHARED_NETWORK';
    row.printer_id = input.printerId;
    row.remote_job_id = input.remoteJobId;
    row.next_attempt_at = input.nextAttemptAt;
    row.last_error = input.error || null;
    row.updated_at = input.updatedAt || row.updated_at;
    return row;
  }

  markCompleted(jobId: string, input: {
    route: ReceiptPrintOutboxRoute;
    printerId?: string | null;
    remoteJobId?: string | null;
    completedAt?: string;
  }): ReceiptPrintOutboxRow | null {
    const row = this.getByJobId(jobId);
    if (!row || !['DISPATCHING', 'REMOTE_ACCEPTED'].includes(row.status)) return row;
    row.status = 'COMPLETED';
    row.route = input.route;
    row.printer_id = input.printerId || row.printer_id;
    row.remote_job_id = input.remoteJobId || row.remote_job_id;
    row.next_attempt_at = null;
    row.last_error = null;
    row.completed_at = input.completedAt || row.updated_at;
    row.updated_at = input.completedAt || row.updated_at;
    return row;
  }

  markFailedSafe(jobId: string, input: {
    error: string;
    nextAttemptAt: string;
    route?: ReceiptPrintOutboxRoute | null;
    printerId?: string | null;
    updatedAt?: string;
  }): ReceiptPrintOutboxRow | null {
    const row = this.getByJobId(jobId);
    if (!row || !['PENDING', 'DISPATCHING', 'FAILED_SAFE'].includes(row.status)) return row;
    row.status = 'FAILED_SAFE';
    row.failure_class = 'SAFE_BEFORE_PRINT';
    row.last_error = input.error;
    row.next_attempt_at = input.nextAttemptAt;
    row.route = input.route || row.route;
    row.printer_id = input.printerId || row.printer_id;
    row.updated_at = input.updatedAt || row.updated_at;
    return row;
  }

  markNeedsReview(jobId: string, input: {
    error: string;
    failureClass?: ReceiptPrintOutboxFailureClass;
    route?: ReceiptPrintOutboxRoute | null;
    printerId?: string | null;
    remoteJobId?: string | null;
    updatedAt?: string;
  }): ReceiptPrintOutboxRow | null {
    const row = this.getByJobId(jobId);
    if (!row || !['PENDING', 'DISPATCHING', 'REMOTE_ACCEPTED', 'FAILED_SAFE'].includes(row.status)) return row;
    row.status = 'NEEDS_REVIEW';
    row.failure_class = input.failureClass || 'UNCERTAIN_AFTER_PRINT';
    row.last_error = input.error;
    row.next_attempt_at = null;
    row.route = input.route || row.route;
    row.printer_id = input.printerId || row.printer_id;
    row.remote_job_id = input.remoteJobId || row.remote_job_id;
    row.updated_at = input.updatedAt || row.updated_at;
    return row;
  }

  recoverInterruptedDispatches(
    salonId: string,
    deviceId: string,
    updatedAt?: string,
  ): number {
    const rows = this.rows.filter((row) =>
      row.salon_id === salonId
      && row.device_id === deviceId
      && row.status === 'DISPATCHING'
    );
    for (const row of rows) {
      this.markNeedsReview(row.job_id, {
        error: 'interrupted',
        failureClass: 'UNCERTAIN_AFTER_PRINT',
        updatedAt,
      });
    }
    return rows.length;
  }
}

describe('ReceiptPrintOutbox', () => {
  let now: Date;

  beforeEach(() => {
    now = new Date('2026-07-29T10:01:00.000Z');
    vi.clearAllMocks();
  });

  function build(
    rows: ReceiptPrintOutboxRow[],
    dispatch: (row: ReceiptPrintOutboxRow) => Promise<ReceiptPrintDispatchResult>,
    flush = vi.fn(async () => ({ success: true })),
    options: { staleAfterMs?: number; retryDelayMs?: (attempts: number) => number } = {},
  ) {
    const repo = new MemoryRepo(rows);
    const outbox = new ReceiptPrintOutbox({
      repo,
      getScope: () => ({
        salonId: 'salon-1',
        deviceId: 'pos-1',
        shiftId: 'shift-1',
      }),
      flush,
      dispatch: (row) => dispatch(row),
      now: () => new Date(now),
      staleAfterMs: options.staleAfterMs ?? 5 * 60_000,
      retryDelayMs: options.retryDelayMs,
    });
    return { repo, outbox, flush };
  }

  it('coalesces concurrent wakes and dispatches strictly FIFO', async () => {
    const rows = [makeRow(1), makeRow(2)];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    const events: string[] = [];
    const dispatch = vi.fn(async (row: ReceiptPrintOutboxRow) => {
      events.push(`dispatch:${row.job_id}`);
      calls.push(row.job_id);
      expect(row.status).toBe('DISPATCHING');
      if (row.job_id === 'job-1') await firstGate;
      return { kind: 'COMPLETED', route: 'LOCAL' } as const;
    });
    const flush = vi.fn(async () => {
      events.push('flush');
      return { success: true };
    });
    const { outbox, repo } = build(rows, dispatch, flush);

    const firstWake = outbox.wake();
    const secondWake = outbox.wake();
    expect(secondWake).toBe(firstWake);
    await vi.waitFor(() => expect(calls).toEqual(['job-1']));
    expect(events[0]).toBe('flush');
    expect(events[1]).toBe('dispatch:job-1');

    releaseFirst();
    await Promise.all([firstWake, secondWake]);

    expect(calls).toEqual(['job-1', 'job-2']);
    expect(repo.getByJobId('job-1')?.status).toBe('COMPLETED');
    expect(repo.getByJobId('job-2')?.status).toBe('COMPLETED');
  });

  it('quarantines stale and different-shift rows without opening the drawer', async () => {
    const stale = makeRow(1, 'PENDING', {
      created_at: '2026-07-29T09:50:00.000Z',
    });
    const wrongShift = makeRow(2, 'PENDING', {
      shift_id: 'shift-old',
      created_at: '2026-07-29T10:00:30.000Z',
    });
    const current = makeRow(3, 'PENDING', {
      created_at: '2026-07-29T10:00:30.000Z',
    });
    const dispatch = vi.fn(async () => ({
      kind: 'COMPLETED',
      route: 'LOCAL',
    } as const));
    const { outbox, repo } = build([stale, wrongShift, current], dispatch);

    await outbox.wake();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].job_id).toBe('job-3');
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      failure_class: 'SAFE_BEFORE_PRINT',
    });
    expect(repo.getByJobId('job-2')).toMatchObject({
      status: 'NEEDS_REVIEW',
      failure_class: 'SAFE_BEFORE_PRINT',
    });
  });

  it('never reprints recovered DISPATCHING, but reconciles an accepted remote job', async () => {
    const interrupted = makeRow(1, 'DISPATCHING');
    const remote = makeRow(2, 'REMOTE_ACCEPTED', {
      route: 'SHARED_NETWORK',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-2',
      next_attempt_at: null,
    });
    const dispatch = vi.fn(async (row: ReceiptPrintOutboxRow) => ({
      kind: 'COMPLETED',
      route: 'SHARED_NETWORK',
      printerId: row.printer_id,
      remoteJobId: row.remote_job_id,
    } as const));
    const { outbox, repo } = build([interrupted, remote], dispatch);

    await outbox.wake();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].job_id).toBe('job-2');
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      failure_class: 'UNCERTAIN_AFTER_PRINT',
    });
    expect(repo.getByJobId('job-2')?.status).toBe('COMPLETED');
  });

  it('retries only the stored remote job identity when polling is unavailable', async () => {
    const remote = makeRow(1, 'REMOTE_ACCEPTED', {
      route: 'SHARED_NETWORK',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-1',
      next_attempt_at: null,
    });
    const dispatch = vi.fn(async () => {
      throw new Error('remote status endpoint unavailable');
    });
    const { outbox, repo } = build(
      [remote],
      dispatch,
      undefined,
      { retryDelayMs: () => 1_000 },
    );

    await outbox.wake();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'REMOTE_ACCEPTED',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-1',
      last_error: 'remote status endpoint unavailable',
      next_attempt_at: '2026-07-29T10:01:01.000Z',
    });

    // The sleeping remote head blocks newer physical receipts until that exact
    // backend job can be reconciled.
    await outbox.wake();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('keeps a terminal socket nudge that arrives while remote acceptance is still flushing', async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const dispatchedRows: ReceiptPrintOutboxRow[] = [];
    const dispatch = vi.fn(async (row: ReceiptPrintOutboxRow) => {
      dispatchedRows.push({ ...row });
      if (row.status === 'DISPATCHING') {
        await createGate;
        return {
          kind: 'REMOTE_ACCEPTED',
          route: 'SHARED_NETWORK',
          printerId: 'printer-pos1',
          remoteJobId: 'remote-1',
        } as const;
      }
      return {
        kind: 'COMPLETED',
        route: 'SHARED_NETWORK',
        printerId: row.printer_id,
        remoteJobId: row.remote_job_id,
      } as const;
    });
    const { outbox, repo } = build([makeRow(1)], dispatch);

    const initialWake = outbox.wake();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const terminalNudge = outbox.nudgeRemoteJob('remote-1');
    releaseCreate();
    await Promise.all([initialWake, terminalNudge]);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatchedRows[1]).toMatchObject({
      status: 'REMOTE_ACCEPTED',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-1',
      attempts: 1,
    });
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'COMPLETED',
      attempts: 1,
      remote_job_id: 'remote-1',
    });
  });

  it('ignores an unrelated remote nudge without dispatching a pending receipt', async () => {
    const dispatch = vi.fn(async () => ({
      kind: 'COMPLETED',
      route: 'LOCAL',
    } as const));
    const { outbox, repo } = build([makeRow(1)], dispatch);

    await outbox.nudgeRemoteJob('remote-from-another-order');

    expect(dispatch).not.toHaveBeenCalled();
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'PENDING',
      attempts: 0,
    });
  });

  it('reports the exact due delay for the current FIFO head', () => {
    const remote = makeRow(1, 'REMOTE_ACCEPTED', {
      route: 'SHARED_NETWORK',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-1',
      next_attempt_at: '2026-07-29T10:01:00.250Z',
    });
    const { outbox } = build([remote], vi.fn());

    expect(outbox.getNextWakeDelayMs()).toBe(250);
    now = new Date('2026-07-29T10:01:00.400Z');
    expect(outbox.getNextWakeDelayMs()).toBe(0);
  });

  it('quarantines a replay result that tries to replace the stored remote identity', async () => {
    const remote = makeRow(1, 'REMOTE_ACCEPTED', {
      route: 'SHARED_NETWORK',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-original',
      next_attempt_at: null,
    });
    const dispatch = vi.fn(async () => ({
      kind: 'COMPLETED',
      route: 'SHARED_NETWORK',
      printerId: 'printer-pos1',
      remoteJobId: 'remote-different',
    } as const));
    const { outbox, repo } = build([remote], dispatch);

    await outbox.wake();

    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      route: 'SHARED_NETWORK',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-original',
      failure_class: 'UNCERTAIN_AFTER_PRINT',
      last_error: 'Remote receipt reconciliation returned a different printer/job identity',
    });
  });

  it('moves an unresolved remote head to manual review after the bounded poll window', async () => {
    const remote = makeRow(1, 'REMOTE_ACCEPTED', {
      route: 'SHARED_NETWORK',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-old',
      dispatched_at: '2026-07-29T09:50:00.000Z',
      // Even a corrupt/far-future poll time must not block FIFO forever.
      next_attempt_at: '2026-08-29T10:00:00.000Z',
    });
    const newer = makeRow(2, 'PENDING', {
      created_at: '2026-07-29T10:00:30.000Z',
    });
    const dispatch = vi.fn(async (row: ReceiptPrintOutboxRow) => ({
      kind: 'COMPLETED',
      route: 'LOCAL',
      printerId: row.printer_id,
    } as const));
    const { outbox, repo } = build([remote, newer], dispatch);

    await outbox.wake();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].job_id).toBe('job-2');
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      route: 'SHARED_NETWORK',
      printer_id: 'printer-pos1',
      remote_job_id: 'remote-old',
      failure_class: 'UNCERTAIN_AFTER_PRINT',
      last_error: expect.stringMatching(/automatic reconciliation window/i),
    });
    expect(repo.getByJobId('job-2')?.status).toBe('COMPLETED');
  });

  it('keeps a safe failed head ahead of newer receipts until its retry succeeds', async () => {
    const first = makeRow(1);
    const second = makeRow(2);
    let firstAttempts = 0;
    const dispatch = vi.fn(async (row: ReceiptPrintOutboxRow) => {
      if (row.job_id === 'job-1' && firstAttempts++ === 0) {
        return {
          kind: 'FAILED_SAFE',
          error: 'printer temporarily offline',
        } as const;
      }
      return { kind: 'COMPLETED', route: 'LOCAL' } as const;
    });
    const { outbox, repo } = build(
      [first, second],
      dispatch,
      undefined,
      { retryDelayMs: () => 1_000 },
    );

    await outbox.wake();
    expect(dispatch.mock.calls.map((call) => call[0].job_id)).toEqual(['job-1']);
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'FAILED_SAFE',
      attempts: 1,
    });
    expect(repo.getByJobId('job-2')?.status).toBe('PENDING');

    now = new Date(now.getTime() + 1_001);
    await outbox.wake();
    expect(dispatch.mock.calls.map((call) => call[0].job_id))
      .toEqual(['job-1', 'job-1', 'job-2']);
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'COMPLETED',
      attempts: 2,
    });
    expect(repo.getByJobId('job-2')?.status).toBe('COMPLETED');
  });

  it('marks an unexpected driver error NEEDS_REVIEW and never auto-retries it', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('connection dropped after WritePrinter');
    });
    const { outbox, repo } = build([makeRow(1)], dispatch);

    await outbox.wake();
    await outbox.wake();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      failure_class: 'UNCERTAIN_AFTER_PRINT',
    });
  });

  it('never retries an uncertain standalone drawer fallback outcome', async () => {
    const dispatch = vi.fn(async () => ({
      kind: 'NEEDS_REVIEW',
      route: 'LOCAL',
      error: 'combined receipt failed safely; standalone drawer outcome unknown',
      failureClass: 'UNCERTAIN_AFTER_PRINT',
    } as const));
    const { outbox, repo } = build([makeRow(1)], dispatch);

    await outbox.wake();
    await outbox.wake();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      route: 'LOCAL',
      failure_class: 'UNCERTAIN_AFTER_PRINT',
      attempts: 1,
      next_attempt_at: null,
      last_error: 'combined receipt failed safely; standalone drawer outcome unknown',
    });
  });

  it('does not dispatch unless the DISPATCHING boundary was flushed durably', async () => {
    const dispatch = vi.fn(async () => ({
      kind: 'COMPLETED',
      route: 'LOCAL',
    } as const));
    const flush = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'disk full' })
      .mockResolvedValueOnce({ success: true });
    const { outbox, repo } = build([makeRow(1)], dispatch, flush);

    await expect(outbox.wake()).rejects.toThrow('receipt-print-outbox-flush-failed');

    expect(dispatch).not.toHaveBeenCalled();
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'FAILED_SAFE',
      failure_class: 'SAFE_BEFORE_PRINT',
    });
  });

  it('refuses a corrupted stored payload before any side effect', async () => {
    const row = makeRow(1);
    row.payload_json = '{"orderId":"tampered"}';
    const dispatch = vi.fn(async () => ({
      kind: 'COMPLETED',
      route: 'LOCAL',
    } as const));
    const { outbox, repo } = build([row], dispatch);

    await outbox.wake();

    expect(dispatch).not.toHaveBeenCalled();
    expect(repo.getByJobId('job-1')).toMatchObject({
      status: 'NEEDS_REVIEW',
      failure_class: 'SAFE_BEFORE_PRINT',
      last_error: 'Stored receipt payload hash does not match',
    });
  });
});
