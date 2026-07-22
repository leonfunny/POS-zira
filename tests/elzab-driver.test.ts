import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/zira-elzab-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

// Keep the COM-port re-resolution (P1) deterministic and offline: stub the
// PnP-backed serial scanners so the driver never shells out to PowerShell or
// depends on whatever serial hardware the test machine happens to have.
vi.mock('../src/main/hardware/port-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/hardware/port-utils')>()),
  listSerialPorts: async () => [],
  getVidForPort: async () => null,
}));

import { ElzabDriver } from '../src/main/hardware/elzab/elzab-driver';
import { MissingElzabBridge, type ElzabBridge } from '../src/main/hardware/elzab/elzab-bridge';
import type { FiscalAttemptJournal, FiscalAttemptRow } from '../src/main/database/repos/fiscal-attempt-repo';
import type { DailyReportData, ReceiptData } from '../src/shared/types';

const receipt: ReceiptData = {
  orderId: 'order-1',
  orderNumber: 'POS-1',
  items: [],
  payment: { method: 'CASH', amount: 0 },
  subtotal: 0,
  total: 0,
};

const dailyReport: DailyReportData = {
  date: '2026-06-13',
  transactionCount: 0,
  grossSales: 0,
  discounts: 0,
  netSales: 0,
  unconditionally: 1,
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
  it('rejects allocated Billiard discounts before creating an attempt or calling the sidecar', async () => {
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
      await expect(driver.printReceipt({
        ...receipt,
        items: [{
          name: 'Czas gry',
          quantity: 1,
          unitPrice: 1000,
          totalPrice: 1000,
          allocatedDiscount: 100,
          vatRate: 23,
        }],
        payment: { method: 'CASH', amount: 900 },
        subtotal: 1000,
        discount: 100,
        total: 900,
      })).rejects.toThrow('ELZAB_LINE_DISCOUNT_UNSUPPORTED');
      expect(printReceipt).not.toHaveBeenCalled();
      expect(attempts).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_REAL_FISCAL_PRINT;
      else process.env.ALLOW_REAL_FISCAL_PRINT = previous;
    }
  });

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

  it('returns fiscal daily report diagnostics without creating a receipt journal attempt', async () => {
    const previous = process.env.ALLOW_REAL_FISCAL_PRINT;
    process.env.ALLOW_REAL_FISCAL_PRINT = 'true';
    const printReport = vi.fn(async () => ({
      ok: true,
      data: {
        commandUsed: 'DailyReport',
        beforeReportNumber: 41,
        afterReportNumber: 42,
        reportNumberIncreased: true,
        commandSent: true,
      },
    }));
    const { journal, attempts } = createJournal();
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true }),
      printTest: async () => ({ ok: true }),
      printReceipt: async () => ({ ok: true }),
      printReport,
    };
    const driver = new ElzabDriver({ port: 'COM4', bridge, fiscalJournal: journal });

    try {
      await expect(driver.connect()).resolves.toBe(true);
      await expect(driver.printDailyReport(dailyReport)).resolves.toMatchObject({
        ok: true,
        data: {
          beforeReportNumber: 41,
          afterReportNumber: 42,
          reportNumberIncreased: true,
        },
      });
      expect(printReport).toHaveBeenCalledWith(expect.objectContaining({ port: 'COM4' }), 'DAILY', dailyReport);
      expect(attempts).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_REAL_FISCAL_PRINT;
      else process.env.ALLOW_REAL_FISCAL_PRINT = previous;
    }
  });

  it('returns accepted daily report diagnostics when number confirmation stays stale', async () => {
    const previous = process.env.ALLOW_REAL_FISCAL_PRINT;
    process.env.ALLOW_REAL_FISCAL_PRINT = 'true';
    const reportResult = {
      ok: true,
      detail: 'DailyReport returned OK, but DailyReportNumber did not update immediately.',
      data: {
        commandUsed: 'DailyReport',
        beforeReportNumber: 23,
        afterReportNumber: 23,
        reportNumberIncreased: false,
        commandSent: true,
        confirmationUnknown: true,
      },
    };
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true }),
      printTest: async () => ({ ok: true }),
      printReceipt: async () => ({ ok: true }),
      printReport: async () => reportResult,
    };
    const driver = new ElzabDriver({ port: 'COM4', bridge, fiscalJournal: createJournal().journal });

    try {
      await expect(driver.connect()).resolves.toBe(true);
      await expect(driver.printDailyReport(dailyReport)).resolves.toMatchObject(reportResult);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_REAL_FISCAL_PRINT;
      else process.env.ALLOW_REAL_FISCAL_PRINT = previous;
    }
  });

  it('preserves confirmation-unknown report diagnostics on thrown errors', async () => {
    const previous = process.env.ALLOW_REAL_FISCAL_PRINT;
    process.env.ALLOW_REAL_FISCAL_PRINT = 'true';
    const reportResult = {
      ok: false,
      code: 'ELZAB_DAILY_REPORT_CONFIRMATION_UNKNOWN' as const,
      detail: 'DailyReport returned OK, but the app could not confirm the new daily report number.',
      data: {
        commandUsed: 'DailyReport',
        beforeReportNumber: 41,
        commandSent: true,
        confirmationUnknown: true,
      },
    };
    const bridge: ElzabBridge = {
      checkAvailability: async () => ({ ok: true }),
      connect: async () => ({ ok: true }),
      getStatus: async () => ({ ok: true }),
      printTest: async () => ({ ok: true }),
      printReceipt: async () => ({ ok: true }),
      printReport: async () => reportResult,
    };
    const driver = new ElzabDriver({ port: 'COM4', bridge, fiscalJournal: createJournal().journal });

    try {
      await expect(driver.connect()).resolves.toBe(true);
      await expect(driver.printDailyReport(dailyReport)).rejects.toMatchObject({
        result: reportResult,
      });
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

  it('sends fiscal-safe item names and units to the bridge and journal', async () => {
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
    const unsafeReceipt: ReceiptData = {
      ...receipt,
      orderId: 'order-safe',
      orderNumber: 'POS-SAFE',
      items: [
        { name: 'Chả', quantity: 1, unitPrice: 1000, totalPrice: 1000, vatRate: 23, unit: 'cái' },
        { name: 'Sól Mąka Żółty ryż', quantity: 1, unitPrice: 1000, totalPrice: 1000, vatRate: 23, unit: 'kg' },
        { name: 'Fähre Straße', quantity: 1, unitPrice: 1000, totalPrice: 1000, vatRate: 23, unit: 'szt' },
        { name: 'Sól Mąka Żółty ryż trójkątne opakowanie jęczmienia ekstra', quantity: 1, unitPrice: 1000, totalPrice: 1000, vatRate: 23, unit: 'opakowanie' },
      ],
      payment: { method: 'CASH', amount: 4000 },
      subtotal: 4000,
      total: 4000,
    };

    try {
      await expect(driver.connect()).resolves.toBe(true);
      await expect(driver.printReceipt(unsafeReceipt)).resolves.toBeUndefined();

      const sentData = printReceipt.mock.calls[0][1] as ReceiptData;
      expect(sentData.items.map((item) => ({ name: item.name, unit: item.unit }))).toEqual([
        { name: 'Cha', unit: 'cai' },
        { name: 'Sol Maka Zolty ryz', unit: 'kg' },
        { name: 'Fahre Strasse', unit: 'szt' },
        { name: 'Sol Maka Zolty ryz trojkatne opakowanie', unit: 'opak' },
      ]);
      expect(unsafeReceipt.items[0]).toMatchObject({ name: 'Chả', unit: 'cái' });

      const journalPayload = JSON.parse(attempts[0].payload_json) as ReceiptData;
      expect(journalPayload.items.map((item) => ({ name: item.name, unit: item.unit }))).toEqual([
        { name: 'Cha', unit: 'cai' },
        { name: 'Sol Maka Zolty ryz', unit: 'kg' },
        { name: 'Fahre Strasse', unit: 'szt' },
        { name: 'Sol Maka Zolty ryz trojkatne opakowanie', unit: 'opak' },
      ]);
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
