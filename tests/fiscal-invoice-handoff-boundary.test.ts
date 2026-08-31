import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  databaseMock,
  runtimeContextMock,
  invoiceHandoffRepoMock,
  loggerMock,
} = vi.hoisted(() => ({
  databaseMock: {
    get: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    saveCoalesced: vi.fn(),
    markDirty: vi.fn(),
    getTenantGeneration: vi.fn(() => 9),
  },
  runtimeContextMock: vi.fn(() => ({
    salonId: 'salon-1',
    companyNip: '522-005-23-49',
  })),
  invoiceHandoffRepoMock: {
    enqueue: vi.fn(),
  },
  loggerMock: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../src/main/database/database', () => ({ database: databaseMock }));
vi.mock('../src/main/database/repos/invoice-handoff-repo', () => ({
  invoiceHandoffRepo: invoiceHandoffRepoMock,
}));
vi.mock('../src/main/logger', () => ({ default: loggerMock }));

import {
  configureInvoiceHandoffContextProvider,
  fiscalAttemptRepo,
} from '../src/main/database/repos/fiscal-attempt-repo';

function saleReceipt(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'order-1',
    orderNumber: 'POS-1',
    sellerNip: '522-005-23-49',
    items: [{ name: 'Service', quantity: 1, unitPrice: 1200, vatRate: 23 }],
    payment: { method: 'CASH', amount: 1200 },
    subtotal: 1200,
    total: 1200,
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attempt-1',
    order_id: 'order-1',
    payment_id: null,
    attempt_no: 1,
    idempotency_key: 'fiscal-key',
    printer_type: 'FISCAL',
    payload_json: JSON.stringify(saleReceipt()),
    payload_hash: 'hash',
    status: 'PENDING',
    result_json: null,
    error_code: null,
    created_at: '2026-08-30T10:00:00.000Z',
    sent_at: null,
    resolved_at: null,
    ...overrides,
  } as any;
}

describe('fiscal journal invoice handoff boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeContextMock.mockReturnValue({
      salonId: 'salon-1',
      companyNip: '522-005-23-49',
    });
    configureInvoiceHandoffContextProvider(runtimeContextMock);
    databaseMock.getTenantGeneration.mockReturnValue(9);
  });

  it('does not enqueue at PENDING, FAILED, UNKNOWN, or BLOCKED boundaries', () => {
    databaseMock.get.mockReturnValueOnce(attempt());

    fiscalAttemptRepo.createPending({
      orderId: 'order-1',
      attemptNo: 1,
      idempotencyKey: 'fiscal-key',
      printerType: 'FISCAL',
      payloadJson: JSON.stringify(saleReceipt()),
      payloadHash: 'hash',
    });
    fiscalAttemptRepo.markFailed('attempt-1', 'SAFE_FAILURE');
    fiscalAttemptRepo.markUnknown('attempt-1', 'AMBIGUOUS');
    fiscalAttemptRepo.markBlocked('attempt-1', 'SAFETY_GATE');

    expect(databaseMock.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO fiscal_attempts'),
      expect.any(Array),
    );
    expect(invoiceHandoffRepoMock.enqueue).not.toHaveBeenCalled();
  });

  it('stays dormant when the reviewed runtime activation provider is not wired', () => {
    configureInvoiceHandoffContextProvider(null);
    databaseMock.get.mockReturnValueOnce(attempt({ order_id: 'order-dormant' }));

    fiscalAttemptRepo.markSuccess('attempt-dormant', { ok: true });

    expect(invoiceHandoffRepoMock.enqueue).not.toHaveBeenCalled();
  });

  it('never blocks confirmed fiscal state when salon/bridge context is unavailable', () => {
    runtimeContextMock.mockReturnValueOnce({ salonId: '', companyNip: '' });
    databaseMock.get.mockReturnValueOnce(attempt({ order_id: 'order-1' }));

    expect(() => fiscalAttemptRepo.markSuccess('attempt-1', { ok: true })).not.toThrow();
    expect(invoiceHandoffRepoMock.enqueue).not.toHaveBeenCalled();

    invoiceHandoffRepoMock.enqueue.mockImplementationOnce(() => {
      throw new Error('invoice table unavailable');
    });
    databaseMock.get.mockReturnValueOnce(attempt({ order_id: 'order-2' }));
    expect(() => fiscalAttemptRepo.markSuccess('attempt-2', { ok: true })).not.toThrow();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('fiscal flow continues'),
    );
  });

  it('ensures handoffs for local success and operator-confirmed printing', () => {
    databaseMock.get
      .mockReturnValueOnce(attempt({ order_id: 'order-local-success' }))
      .mockReturnValueOnce(attempt({
        id: 'attempt-operator',
        order_id: 'order-operator',
        status: 'UNKNOWN_NEEDS_RECONCILIATION',
      }))
      .mockReturnValueOnce(attempt({
        id: 'attempt-operator',
        order_id: 'order-operator',
        status: 'SUCCESS_CONFIRMED',
      }));

    fiscalAttemptRepo.markSuccess('attempt-local', { ok: true });
    const resolved = fiscalAttemptRepo.resolveReconcilable('order-operator', true);

    expect(resolved?.status).toBe('SUCCESS_CONFIRMED');
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-local-success' }),
    );
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-operator' }),
    );
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ companyNip: '5220052349' }),
    );
  });

  it('preserves and canonicalizes REMOTE job evidence on operator confirmation', () => {
    const unknownRemote = attempt({
      id: 'attempt-remote-operator',
      order_id: 'order-remote-operator',
      printer_type: 'REMOTE',
      status: 'UNKNOWN_NEEDS_RECONCILIATION',
      result_json: JSON.stringify({
        handled: true,
        printed: false,
        jobId: 'job-operator',
        printerId: 'printer-operator',
      }),
    });
    databaseMock.get
      .mockReturnValueOnce(unknownRemote)
      .mockReturnValueOnce(attempt({
        ...unknownRemote,
        status: 'SUCCESS_CONFIRMED',
      }));

    fiscalAttemptRepo.resolveReconcilable('order-remote-operator', true);

    const successUpdate = databaseMock.run.mock.calls.find(([, params]) => (
      Array.isArray(params) && params[0] === 'SUCCESS_CONFIRMED'
    ));
    expect(successUpdate).toBeDefined();
    expect(JSON.parse(String(successUpdate![1][2]))).toMatchObject({
      remote: true,
      jobId: 'job-operator',
      printerId: 'printer-operator',
      reconciledBy: 'operator',
      didPrint: true,
    });
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-remote-operator' }),
    );
  });

  it('backfills canonical remote evidence before ensuring an existing confirmed receipt', () => {
    databaseMock.get.mockReturnValueOnce(attempt({
      id: 'confirmed-attempt',
      order_id: 'order-remote',
      printer_type: 'REMOTE',
      status: 'SUCCESS_CONFIRMED',
      result_json: JSON.stringify({ handled: true, printed: true }),
    }));

    fiscalAttemptRepo.recordRemoteFiscalSuccess(
      'order-remote',
      'job-1',
      'printer-1',
      saleReceipt({ orderId: 'order-remote' }) as any,
    );

    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-remote' }),
    );
    const update = databaseMock.run.mock.calls.find(([sql]) => (
      String(sql).includes("printer_type = 'REMOTE'")
      && String(sql).includes('SET result_json = ?')
    ));
    expect(update).toBeDefined();
    expect(JSON.parse(String(update![1][0]))).toMatchObject({
      handled: true,
      printed: true,
      remote: true,
      jobId: 'job-1',
      printerId: 'printer-1',
    });
    expect(update![1][1]).toBe('confirmed-attempt');
    expect(databaseMock.run).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO fiscal_attempts'),
      expect.anything(),
    );
  });

  it('backfills original confirmed sales while skipping newer refund and unproven remote rows', () => {
    databaseMock.all.mockReturnValueOnce([
      {
        order_id: 'order-local',
        attempt_no: 2,
        attempt_id: 'attempt-local-refund',
        printer_type: 'FISCAL',
        payload_json: JSON.stringify(saleReceipt({ orderId: 'order-local', isRefund: true })),
        result_json: null,
      },
      {
        order_id: 'order-local',
        attempt_no: 1,
        attempt_id: 'attempt-local-sale',
        printer_type: 'FISCAL',
        payload_json: JSON.stringify(saleReceipt({ orderId: 'order-local' })),
        result_json: null,
      },
      {
        order_id: 'order-remote-unknown',
        attempt_no: 1,
        attempt_id: 'attempt-remote-unknown',
        printer_type: 'REMOTE',
        payload_json: JSON.stringify(saleReceipt({ orderId: 'order-remote-unknown' })),
        result_json: JSON.stringify({ handled: true }),
      },
      {
        order_id: 'order-remote-proven',
        attempt_no: 1,
        attempt_id: 'attempt-remote-proven',
        printer_type: 'REMOTE',
        payload_json: JSON.stringify(saleReceipt({ orderId: 'order-remote-proven' })),
        result_json: JSON.stringify({
          remote: true,
          jobId: 'job-proven',
          printerId: 'printer-proven',
        }),
      },
    ]);

    expect(fiscalAttemptRepo.backfillInvoiceHandoffs()).toBe(2);
    expect(databaseMock.all).toHaveBeenCalledWith(
      expect.stringContaining("UPPER(COALESCE(o.status, '')) = 'COMPLETED'"),
      [100],
    );
    expect(databaseMock.all).toHaveBeenCalledWith(
      expect.stringContaining('NOT EXISTS'),
      [100],
    );
    expect(databaseMock.all).toHaveBeenCalledWith(
      expect.stringContaining("e.event_type = 'RefundIssued'"),
      [100],
    );
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledTimes(2);
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-local' }),
    );
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-remote-proven' }),
    );
  });

  it('pages past more than 100 skipped attempts and selects the original sale once', () => {
    const skipped = Array.from({ length: 200 }, (_, index) => ({
      order_id: 'order-many-copies',
      attempt_no: 201 - index,
      attempt_id: `attempt-${String(201 - index).padStart(3, '0')}`,
      printer_type: 'FISCAL',
      payload_json: JSON.stringify(saleReceipt({
        orderId: 'order-many-copies',
        isReprint: true,
      })),
      result_json: null,
    }));
    databaseMock.all
      .mockReturnValueOnce(skipped.slice(0, 100))
      .mockReturnValueOnce(skipped.slice(100))
      .mockReturnValueOnce([{
        order_id: 'order-many-copies',
        attempt_no: 1,
        attempt_id: 'attempt-001',
        printer_type: 'FISCAL',
        payload_json: JSON.stringify(saleReceipt({ orderId: 'order-many-copies' })),
        result_json: null,
      }]);

    expect(fiscalAttemptRepo.backfillInvoiceHandoffs()).toBe(1);

    expect(databaseMock.all).toHaveBeenCalledTimes(3);
    expect(databaseMock.all).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("fa.status = 'SUCCESS_CONFIRMED'"),
      [100],
    );
    expect(databaseMock.all).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('fa.id < ?'),
      ['order-many-copies', 'order-many-copies', 102, 102, 'attempt-102', 100],
    );
    expect(databaseMock.all).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('fa.id < ?'),
      ['order-many-copies', 'order-many-copies', 2, 2, 'attempt-002', 100],
    );
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledTimes(1);
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-many-copies' }),
    );
  });

  it('clears a legacy rowid cursor and safely rescans from the beginning', () => {
    databaseMock.get.mockReturnValueOnce({
      value: JSON.stringify({
        orderId: 'order-before-upgrade',
        attemptNo: 7,
        attemptRowid: 99,
        orderComplete: false,
      }),
    });
    databaseMock.all.mockReturnValueOnce([{
      order_id: 'order-before-upgrade',
      attempt_no: 7,
      attempt_id: 'attempt-before-upgrade',
      printer_type: 'FISCAL',
      payload_json: JSON.stringify(saleReceipt({ orderId: 'order-before-upgrade' })),
      result_json: null,
    }]);

    expect(fiscalAttemptRepo.backfillInvoiceHandoffs()).toBe(1);

    expect(databaseMock.run).toHaveBeenCalledWith(
      'DELETE FROM sync_metadata WHERE key IN (?, ?)',
      [
        '__zira_invoice_handoff_backfill_cursor_v2',
        '__zira_invoice_handoff_backfill_cursor_v1',
      ],
    );
    const [sql, params] = databaseMock.all.mock.calls[0];
    expect(sql).not.toContain('fa.id < ?');
    expect(params).toEqual([100]);
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-before-upgrade' }),
    );
  });

  it('does not let a newer original with the wrong NIP hide an older eligible original', () => {
    databaseMock.all.mockReturnValueOnce([
      {
        order_id: 'order-corrected-nip',
        attempt_no: 2,
        attempt_id: 'attempt-corrected-nip-newer',
        printer_type: 'FISCAL',
        payload_json: JSON.stringify(saleReceipt({
          orderId: 'order-corrected-nip',
          sellerNip: '5260250274',
        })),
        result_json: null,
      },
      {
        order_id: 'order-corrected-nip',
        attempt_no: 1,
        attempt_id: 'attempt-corrected-nip-older',
        printer_type: 'FISCAL',
        payload_json: JSON.stringify(saleReceipt({ orderId: 'order-corrected-nip' })),
        result_json: null,
      },
    ]);

    expect(fiscalAttemptRepo.backfillInvoiceHandoffs()).toBe(1);
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledTimes(1);
    expect(invoiceHandoffRepoMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-corrected-nip',
        companyNip: '5220052349',
      }),
    );
  });

  it('does not enqueue an existing REMOTE confirmation without concrete job evidence', () => {
    databaseMock.get.mockReturnValueOnce(attempt({
      id: 'confirmed-without-evidence',
      order_id: 'order-remote-unknown',
      printer_type: 'REMOTE',
      status: 'SUCCESS_CONFIRMED',
      result_json: JSON.stringify({ handled: true, printed: true }),
    }));

    fiscalAttemptRepo.recordRemoteFiscalSuccess(
      'order-remote-unknown',
      null,
      null,
      saleReceipt({ orderId: 'order-remote-unknown' }) as any,
    );

    expect(invoiceHandoffRepoMock.enqueue).not.toHaveBeenCalled();
    expect(databaseMock.run).not.toHaveBeenCalledWith(
      expect.stringContaining('SET result_json = ?'),
      expect.anything(),
    );
  });

  it('does not enqueue when operator confirms that nothing printed', () => {
    databaseMock.get
      .mockReturnValueOnce(attempt({
        id: 'attempt-not-printed',
        order_id: 'order-not-printed',
        status: 'UNKNOWN_NEEDS_RECONCILIATION',
      }))
      .mockReturnValueOnce(attempt({
        id: 'attempt-not-printed',
        order_id: 'order-not-printed',
        status: 'FAILED_CONFIRMED',
      }));

    fiscalAttemptRepo.resolveReconcilable('order-not-printed', false);

    expect(invoiceHandoffRepoMock.enqueue).not.toHaveBeenCalled();
  });

  it('never creates a retail-sale handoff for refunds, reprints, or invalid snapshots', () => {
    databaseMock.get
      .mockReturnValueOnce(attempt({
        id: 'attempt-refund',
        order_id: 'order-refund',
        payload_json: JSON.stringify(saleReceipt({ isRefund: true })),
      }))
      .mockReturnValueOnce(attempt({
        id: 'attempt-reprint',
        order_id: 'order-reprint',
        payload_json: JSON.stringify(saleReceipt({ isReprint: true })),
      }))
      .mockReturnValueOnce(attempt({
        id: 'attempt-invalid',
        order_id: 'order-invalid',
        payload_json: '{}',
      }));

    fiscalAttemptRepo.markSuccess('attempt-refund');
    fiscalAttemptRepo.markSuccess('attempt-reprint');
    fiscalAttemptRepo.markSuccess('attempt-invalid');

    expect(invoiceHandoffRepoMock.enqueue).not.toHaveBeenCalled();
  });

  it('does not create an immutable handoff row until seller NIP is valid', () => {
    runtimeContextMock.mockReturnValueOnce({
      salonId: 'salon-1',
      companyNip: '1234567890',
    });
    databaseMock.get.mockReturnValueOnce(attempt({ order_id: 'order-no-nip' }));

    fiscalAttemptRepo.markSuccess('attempt-no-nip');

    expect(invoiceHandoffRepoMock.enqueue).not.toHaveBeenCalled();
    expect(loggerMock.debug).toHaveBeenCalledWith(
      expect.stringContaining('fiscal payload seller NIP is missing, invalid, or differs'),
    );
  });

  it('rejects an all-identical placeholder NIP even though its checksum is zero', () => {
    runtimeContextMock.mockReturnValueOnce({
      salonId: 'salon-1',
      companyNip: '0000000000',
    });
    databaseMock.get.mockReturnValueOnce(attempt({
      order_id: 'order-placeholder-nip',
      payload_json: JSON.stringify(saleReceipt({
        orderId: 'order-placeholder-nip',
        sellerNip: '0000000000',
      })),
    }));

    fiscalAttemptRepo.markSuccess('attempt-placeholder-nip');

    expect(invoiceHandoffRepoMock.enqueue).not.toHaveBeenCalled();
  });

  it('does not enqueue when the fiscal snapshot NIP differs from the active company', () => {
    runtimeContextMock.mockReturnValueOnce({
      salonId: 'salon-1',
      companyNip: '5260250274',
    });
    databaseMock.get.mockReturnValueOnce(attempt({ order_id: 'order-company-mismatch' }));

    fiscalAttemptRepo.markSuccess('attempt-company-mismatch');

    expect(invoiceHandoffRepoMock.enqueue).not.toHaveBeenCalled();
  });

  it('hashes a fallback remote receipt snapshot with lowercase SHA-256', () => {
    const receipt = saleReceipt({ orderId: 'order-new-remote' });
    const payloadJson = JSON.stringify(receipt);
    databaseMock.get
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ max_attempt: 0 });

    fiscalAttemptRepo.recordRemoteFiscalSuccess(
      'order-new-remote',
      'job-new',
      'printer-1',
      receipt as any,
    );

    expect(databaseMock.run).toHaveBeenCalledWith(
      expect.stringContaining("'REMOTE', ?, ?, 'SUCCESS_CONFIRMED'"),
      expect.arrayContaining([
        payloadJson,
        createHash('sha256').update(payloadJson).digest('hex'),
      ]),
    );
  });

  it('excludes operator-confirmed refunds and remote refund/reprint confirmations', () => {
    databaseMock.get
      .mockReturnValueOnce(attempt({
        id: 'attempt-refund',
        order_id: 'order-refund',
        status: 'UNKNOWN_NEEDS_RECONCILIATION',
        payload_json: JSON.stringify(saleReceipt({ isRefund: true })),
      }))
      .mockReturnValueOnce(attempt({
        id: 'attempt-refund',
        order_id: 'order-refund',
        status: 'SUCCESS_CONFIRMED',
        payload_json: JSON.stringify(saleReceipt({ isRefund: true })),
      }))
      .mockReturnValueOnce({ id: 'remote-refund-confirmed' })
      .mockReturnValueOnce({ id: 'remote-reprint-confirmed' });

    fiscalAttemptRepo.resolveReconcilable('order-refund', true);
    fiscalAttemptRepo.recordRemoteFiscalSuccess(
      'remote-refund',
      'job-refund',
      'printer-1',
      saleReceipt({ isRefund: true }) as any,
    );
    fiscalAttemptRepo.recordRemoteFiscalSuccess(
      'remote-reprint',
      'job-reprint',
      'printer-1',
      saleReceipt({ isReprint: true }) as any,
    );

    expect(invoiceHandoffRepoMock.enqueue).not.toHaveBeenCalled();
  });
});
