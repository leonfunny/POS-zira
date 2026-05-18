import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElzabDriver } from '../src/main/hardware/elzab/elzab-driver';
import { MissingElzabBridge, type ElzabBridge } from '../src/main/hardware/elzab/elzab-bridge';
import type { FiscalAttemptJournal, FiscalAttemptRow } from '../src/main/database/repos/fiscal-attempt-repo';
import type { ReceiptData } from '../src/shared/types';

const receipt: ReceiptData = {
  orderId: 'order-1',
  orderNumber: 'POS-1',
  items: [],
  payment: { method: 'CASH', amount: 0 },
  subtotal: 0,
  total: 0,
};

const savedIgnoreConfigAllowReal = process.env.ZIRA_ELZAB_IGNORE_CONFIG_ALLOW_REAL;

beforeEach(() => {
  process.env.ZIRA_ELZAB_IGNORE_CONFIG_ALLOW_REAL = 'true';
});

afterEach(() => {
  if (savedIgnoreConfigAllowReal === undefined) delete process.env.ZIRA_ELZAB_IGNORE_CONFIG_ALLOW_REAL;
  else process.env.ZIRA_ELZAB_IGNORE_CONFIG_ALLOW_REAL = savedIgnoreConfigAllowReal;
});

function makeAttempt(overrides: Partial<FiscalAttemptRow> = {}): FiscalAttemptRow {
  return {
    id: 'attempt-1',
    order_id: 'order-1',
    payment_id: null,
    attempt_no: 1,
    idempotency_key: 'order-1:default:1',
    printer_type: 'FISCAL',
    payload_json: '{}',
    payload_hash: 'hash',
    status: 'PENDING',
    result_json: null,
    error_code: null,
    created_at: null,
    sent_at: null,
    resolved_at: null,
    ...overrides,
  };
}

function createJournal(seed: FiscalAttemptRow[] = []): { journal: FiscalAttemptJournal; attempts: FiscalAttemptRow[] } {
  const attempts = [...seed];
  const setStatus = (id: string, status: FiscalAttemptRow['status'], errorCode?: string, result?: unknown) => {
    const attempt = attempts.find((row) => row.id === id);
    if (!attempt) throw new Error(`missing attempt ${id}`);
    attempt.status = status;
    attempt.error_code = errorCode ?? null;
    attempt.result_json = result === undefined ? null : JSON.stringify(result);
  };
  return {
    attempts,
    journal: {
      findBlockingAttempt: vi.fn((orderId: string, paymentId?: string | null) => attempts.find((row) =>
        row.order_id === orderId &&
        (!paymentId || row.payment_id === paymentId) &&
        (row.status === 'SUCCESS_CONFIRMED' || row.status === 'UNKNOWN_NEEDS_RECONCILIATION')
      ) || null),
      getNextAttemptNo: vi.fn((orderId: string, paymentId?: string | null) => {
        const matching = attempts.filter((row) => row.order_id === orderId && (!paymentId || row.payment_id === paymentId));
        return Math.max(0, ...matching.map((row) => row.attempt_no)) + 1;
      }),
      createPending: vi.fn((input) => {
        const attempt = makeAttempt({
          id: `attempt-${attempts.length + 1}`,
          order_id: input.orderId,
          payment_id: input.paymentId ?? null,
          attempt_no: input.attemptNo,
          idempotency_key: input.idempotencyKey,
          printer_type: input.printerType,
          payload_json: input.payloadJson,
          payload_hash: input.payloadHash,
          status: 'PENDING',
        });
        attempts.push(attempt);
        return attempt;
      }),
      markSent: vi.fn((id: string) => setStatus(id, 'SENT')),
      markSuccess: vi.fn((id: string, result?: unknown) => setStatus(id, 'SUCCESS_CONFIRMED', undefined, result)),
      markFailed: vi.fn((id: string, errorCode: string, result?: unknown) => setStatus(id, 'FAILED_CONFIRMED', errorCode, result)),
      markUnknown: vi.fn((id: string, errorCode: string, result?: unknown) => setStatus(id, 'UNKNOWN_NEEDS_RECONCILIATION', errorCode, result)),
      markBlocked: vi.fn((id: string, errorCode: string, result?: unknown) => setStatus(id, 'BLOCKED_BY_SAFETY_GATE', errorCode, result)),
    },
  };
}

describe('ElzabDriver fail-closed behavior', () => {
  it('returns explicit missing-sidecar errors instead of false success', async () => {
    const driver = new ElzabDriver({
      port: 'COM8',
      bridge: new MissingElzabBridge(),
      fiscalJournal: createJournal().journal,
    });

    await expect(driver.connect()).resolves.toBe(false);
    await expect(driver.getStatus()).resolves.toMatchObject({
      connected: false,
      type: 'ELZAB',
      protocol: 'ELZAB_STX',
      diagnostic: {
        code: 'ELZAB_BRIDGE_NOT_CONFIGURED',
      },
    });
    await expect(driver.printTest()).rejects.toThrow(/ELZAB_BRIDGE_NOT_CONFIGURED/);
    await expect(driver.printReceipt(receipt)).rejects.toThrow(/ELZAB_BRIDGE_NOT_CONFIGURED/);
  });

  it('keeps hardware absence explicit when the sidecar is present but the device is not', async () => {
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({
        ok: false,
        code: 'ELZAB_HARDWARE_NOT_FOUND',
        detail: 'No ELZAB response on COM8',
      }),
      getStatus: async () => ({
        ok: false,
        code: 'ELZAB_HARDWARE_NOT_FOUND',
        detail: 'No ELZAB response on COM8',
      }),
      printTest: async () => ({ ok: false, code: 'ELZAB_HARDWARE_NOT_FOUND' }),
      printReceipt: async () => ({ ok: false, code: 'ELZAB_HARDWARE_NOT_FOUND' }),
    };
    const driver = new ElzabDriver({ port: 'COM8', bridge, fiscalJournal: createJournal().journal });

    await expect(driver.connect()).resolves.toBe(false);
    await expect(driver.getStatus()).resolves.toMatchObject({
      connected: false,
      diagnostic: {
        code: 'ELZAB_HARDWARE_NOT_FOUND',
        detail: 'No ELZAB response on COM8',
      },
    });
    await expect(driver.printTest()).rejects.toThrow(/ELZAB_HARDWARE_NOT_FOUND/);
  });

  it('does not pretend reports are supported when the bridge has no report operation', async () => {
    const previous = process.env.ALLOW_REAL_FISCAL_PRINT;
    process.env.ALLOW_REAL_FISCAL_PRINT = 'true';
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true }),
      printTest: async () => ({ ok: true }),
      printReceipt: async () => ({ ok: true }),
    };
    const driver = new ElzabDriver({ address: '192.168.192.1:9100', bridge, fiscalJournal: createJournal().journal });

    try {
      await expect(driver.connect()).resolves.toBe(true);
      await expect(driver.printZReport({
        date: '2026-05-06',
        transactionCount: 0,
        grossSales: 0,
        discounts: 0,
        netSales: 0,
      })).rejects.toThrow(/not implemented/);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_REAL_FISCAL_PRINT;
      else process.env.ALLOW_REAL_FISCAL_PRINT = previous;
    }
  });

  it('blocks real fiscal receipts unless the production safety flag is enabled', async () => {
    const previous = process.env.ALLOW_REAL_FISCAL_PRINT;
    delete process.env.ALLOW_REAL_FISCAL_PRINT;
    const printReceipt = vi.fn(async () => ({ ok: true }));
    const { journal, attempts } = createJournal();
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true }),
      printTest: async () => ({ ok: true }),
      printReceipt,
    };
    const driver = new ElzabDriver({ port: 'COM4', bridge, fiscalJournal: journal });

    try {
      await expect(driver.connect()).resolves.toBe(true);
      await expect(driver.printReceipt(receipt)).rejects.toThrow(/REAL_FISCAL_PRINT_DISABLED/);
      expect(printReceipt).not.toHaveBeenCalled();
      expect(attempts[0]).toMatchObject({
        status: 'BLOCKED_BY_SAFETY_GATE',
        error_code: 'REAL_FISCAL_PRINT_DISABLED',
      });
      await expect(driver.getStatus()).resolves.toMatchObject({
        connected: true,
        diagnostic: {
          code: 'REAL_FISCAL_PRINT_DISABLED',
        },
      });
    } finally {
      if (previous === undefined) delete process.env.ALLOW_REAL_FISCAL_PRINT;
      else process.env.ALLOW_REAL_FISCAL_PRINT = previous;
    }
  });

  it('allows real fiscal receipts only when the production safety flag is enabled', async () => {
    const previous = process.env.ALLOW_REAL_FISCAL_PRINT;
    process.env.ALLOW_REAL_FISCAL_PRINT = 'true';
    const printReceipt = vi.fn(async () => ({ ok: true }));
    const { journal, attempts } = createJournal();
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true }),
      printTest: async () => ({ ok: true }),
      printReceipt,
    };
    const driver = new ElzabDriver({ port: 'COM4', bridge, fiscalJournal: journal });

    try {
      await expect(driver.connect()).resolves.toBe(true);
      await expect(driver.printReceipt(receipt)).resolves.toBeUndefined();
      expect(printReceipt).toHaveBeenCalledTimes(1);
      expect(attempts[0]).toMatchObject({
        status: 'SUCCESS_CONFIRMED',
        idempotency_key: 'order-1:default:1',
      });
    } finally {
      if (previous === undefined) delete process.env.ALLOW_REAL_FISCAL_PRINT;
      else process.env.ALLOW_REAL_FISCAL_PRINT = previous;
    }
  });

  it('blocks automatic retry when a prior receipt attempt is unknown', async () => {
    const previous = process.env.ALLOW_REAL_FISCAL_PRINT;
    process.env.ALLOW_REAL_FISCAL_PRINT = 'true';
    const printReceipt = vi.fn(async () => ({ ok: true }));
    const { journal } = createJournal([
      makeAttempt({ status: 'UNKNOWN_NEEDS_RECONCILIATION' }),
    ]);
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true }),
      printTest: async () => ({ ok: true }),
      printReceipt,
    };
    const driver = new ElzabDriver({ port: 'COM4', bridge, fiscalJournal: journal });

    try {
      await expect(driver.connect()).resolves.toBe(true);
      await expect(driver.printReceipt(receipt)).rejects.toThrow(/FISCAL_ATTEMPT_RETRY_BLOCKED/);
      expect(printReceipt).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.ALLOW_REAL_FISCAL_PRINT;
      else process.env.ALLOW_REAL_FISCAL_PRINT = previous;
    }
  });

  it('marks timeout after SENT as unknown, not failed', async () => {
    const previous = process.env.ALLOW_REAL_FISCAL_PRINT;
    process.env.ALLOW_REAL_FISCAL_PRINT = 'true';
    const { journal, attempts } = createJournal();
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true }),
      printTest: async () => ({ ok: true }),
      printReceipt: async () => ({
        ok: false,
        code: 'ELZAB_COMMAND_FAILED',
        detail: 'operation timed out',
      }),
    };
    const driver = new ElzabDriver({ port: 'COM4', bridge, fiscalJournal: journal });

    try {
      await expect(driver.connect()).resolves.toBe(true);
      await expect(driver.printReceipt(receipt)).rejects.toThrow(/FISCAL_RESULT_UNKNOWN/);
      expect(attempts[0]).toMatchObject({
        status: 'UNKNOWN_NEEDS_RECONCILIATION',
        error_code: 'ELZAB_COMMAND_FAILED',
      });
    } finally {
      if (previous === undefined) delete process.env.ALLOW_REAL_FISCAL_PRINT;
      else process.env.ALLOW_REAL_FISCAL_PRINT = previous;
    }
  });

  it('marks local menu at ReceiptBegin as failed, not unknown', async () => {
    const previous = process.env.ALLOW_REAL_FISCAL_PRINT;
    process.env.ALLOW_REAL_FISCAL_PRINT = 'true';
    const { journal, attempts } = createJournal();
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true }),
      printTest: async () => ({ ok: true }),
      printReceipt: async () => ({
        ok: false,
        code: 'ELZAB_LOCAL_MENU_MODE',
        detail: 'ReceiptBegin failed: TRYB MENU LOKALNEGO',
      }),
    };
    const driver = new ElzabDriver({ port: 'COM4', bridge, fiscalJournal: journal });

    try {
      await expect(driver.connect()).resolves.toBe(true);
      await expect(driver.printReceipt(receipt)).rejects.toThrow(/ELZAB_LOCAL_MENU_MODE/);
      expect(attempts[0]).toMatchObject({
        status: 'FAILED_CONFIRMED',
        error_code: 'ELZAB_LOCAL_MENU_MODE',
      });
      await expect(driver.getStatus()).resolves.toMatchObject({
        connected: true,
        diagnostic: {
          code: 'ELZAB_LOCAL_MENU_MODE',
        },
      });
    } finally {
      if (previous === undefined) delete process.env.ALLOW_REAL_FISCAL_PRINT;
      else process.env.ALLOW_REAL_FISCAL_PRINT = previous;
    }
  });
});
