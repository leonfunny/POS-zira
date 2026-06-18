import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanFirstPrintFailureClass } from '../src/shared/types';

type Row = {
  idempotency_key: string;
  payload_hash: string;
  job_id: string;
  printer_id: string;
  status: string;
  failure_class: LanFirstPrintFailureClass | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

const rows = new Map<string, Row>();

vi.mock('../src/main/database/database', () => ({
  database: {
    transaction: vi.fn((fn: () => unknown) => fn()),
    get: vi.fn((_sql: string, params?: unknown[]) => rows.get(String(params?.[0])) ?? null),
    run: vi.fn((sql: string, params?: unknown[]) => {
      if (/INSERT INTO lan_first_print_attempts/i.test(sql)) {
        const [
          idempotencyKey,
          payloadHash,
          jobId,
          printerId,
          status,
          failureClass,
          errorMessage,
          now,
        ] = params as string[];
        rows.set(idempotencyKey, {
          idempotency_key: idempotencyKey,
          payload_hash: payloadHash,
          job_id: jobId,
          printer_id: printerId,
          status,
          failure_class: (failureClass as LanFirstPrintFailureClass | null) ?? null,
          error_message: errorMessage ?? null,
          created_at: now,
          updated_at: now,
        });
        return;
      }

      if (/UPDATE lan_first_print_attempts/i.test(sql) && /status = \?/i.test(sql)) {
        const [status, failureClass, errorMessage, jobId, printerId, now, idempotencyKey] = params as string[];
        const existing = rows.get(idempotencyKey);
        if (!existing) return;
        rows.set(idempotencyKey, {
          ...existing,
          status,
          failure_class: (failureClass as LanFirstPrintFailureClass | null) ?? null,
          error_message: errorMessage ?? null,
          job_id: jobId,
          printer_id: printerId,
          updated_at: now,
        });
      }
    }),
    markDirty: vi.fn(),
    save: vi.fn(async () => ({ success: true })),
  },
}));

import { database } from '../src/main/database/database';
import { lanFirstPrintAttemptRepo } from '../src/main/database/repos/lan-first-print-attempt-repo';

const baseInput = {
  idempotencyKey: 'idem-1',
  payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
  jobId: 'job-1',
  printerId: 'printer-1',
};

function existing(status: Row['status'], failureClass: LanFirstPrintFailureClass | null = null): Row {
  return {
    idempotency_key: baseInput.idempotencyKey,
    payload_hash: baseInput.payloadHash,
    job_id: baseInput.jobId,
    printer_id: baseInput.printerId,
    status,
    failure_class: failureClass,
    error_message: failureClass ? 'previous failure' : null,
    created_at: '2026-06-18T10:00:00.000Z',
    updated_at: '2026-06-18T10:00:00.000Z',
  };
}

describe('lanFirstPrintAttemptRepo', () => {
  beforeEach(() => {
    rows.clear();
    vi.clearAllMocks();
    vi.mocked(database.save).mockResolvedValue({ success: true });
  });

  it('marks a first attempt PRINTING and flushes it before the caller can print', async () => {
    const decision = await lanFirstPrintAttemptRepo.beginPrintAttempt(baseInput);

    expect(decision.action).toBe('PRINT');
    expect(rows.get(baseInput.idempotencyKey)?.status).toBe('PRINTING');
    expect(database.save).toHaveBeenCalledTimes(1);
  });

  it('no-ops completed duplicates with the same payload hash', async () => {
    rows.set(baseInput.idempotencyKey, existing('COMPLETED'));

    const decision = await lanFirstPrintAttemptRepo.beginPrintAttempt(baseInput);

    expect(decision).toMatchObject({ action: 'NOOP', status: 'COMPLETED', duplicate: true });
    expect(database.run).not.toHaveBeenCalled();
  });

  it('no-ops in-progress duplicates with the same payload hash', async () => {
    rows.set(baseInput.idempotencyKey, existing('PRINTING'));

    const decision = await lanFirstPrintAttemptRepo.beginPrintAttempt(baseInput);

    expect(decision).toMatchObject({ action: 'NOOP', status: 'PRINTING', duplicate: true });
    expect(database.run).not.toHaveBeenCalled();
  });

  it('rejects the same idempotency key with a different payload hash', async () => {
    rows.set(baseInput.idempotencyKey, existing('COMPLETED'));

    const decision = await lanFirstPrintAttemptRepo.beginPrintAttempt({
      ...baseInput,
      payloadHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    expect(decision).toMatchObject({ action: 'REJECT', reason: 'PAYLOAD_HASH_MISMATCH' });
    expect(database.run).not.toHaveBeenCalled();
  });

  it('allows retry after a SAFE_BEFORE_PRINT failure by marking the row PRINTING again', async () => {
    rows.set(baseInput.idempotencyKey, existing('FAILED', 'SAFE_BEFORE_PRINT'));

    const decision = await lanFirstPrintAttemptRepo.beginPrintAttempt(baseInput);

    expect(decision.action).toBe('PRINT');
    expect(rows.get(baseInput.idempotencyKey)).toMatchObject({
      status: 'PRINTING',
      failure_class: null,
      error_message: null,
    });
    expect(database.save).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry UNCERTAIN_AFTER_PRINT or FINAL failures', async () => {
    rows.set(baseInput.idempotencyKey, existing('FAILED', 'UNCERTAIN_AFTER_PRINT'));
    await expect(lanFirstPrintAttemptRepo.beginPrintAttempt(baseInput)).resolves.toMatchObject({
      action: 'NOOP',
      status: 'FAILED',
      failureClass: 'UNCERTAIN_AFTER_PRINT',
    });

    rows.set(baseInput.idempotencyKey, existing('FAILED', 'FINAL'));
    await expect(lanFirstPrintAttemptRepo.beginPrintAttempt(baseInput)).resolves.toMatchObject({
      action: 'NOOP',
      status: 'FAILED',
      failureClass: 'FINAL',
    });
  });

  it('rejects a non-durable PRINTING row as retry-safe instead of poisoning future duplicates', async () => {
    vi.mocked(database.save)
      .mockResolvedValueOnce({ success: false, error: 'disk full' })
      .mockResolvedValueOnce({ success: true });

    const decision = await lanFirstPrintAttemptRepo.beginPrintAttempt(baseInput);

    expect(decision).toMatchObject({
      action: 'REJECT',
      reason: 'LEDGER_NOT_DURABLE',
    });
    expect(rows.get(baseInput.idempotencyKey)).toMatchObject({
      status: 'FAILED',
      failure_class: 'SAFE_BEFORE_PRINT',
      error_message: 'LAN_FIRST ledger was not durable before print',
    });
    expect(database.markDirty).toHaveBeenCalled();

    const retry = await lanFirstPrintAttemptRepo.beginPrintAttempt(baseInput);

    expect(retry.action).toBe('PRINT');
    expect(rows.get(baseInput.idempotencyKey)).toMatchObject({
      status: 'PRINTING',
      failure_class: null,
      error_message: null,
    });
  });
});
