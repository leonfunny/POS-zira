/**
 * PaymentController — payment-doesn't-fail-on-print-or-drawer-error.
 *
 * The grocery POS owner does not have a cash drawer. Live test must
 * not block on drawer hardware, AND must not block on a missing or
 * misbehaving receipt printer. The current code already defends both
 * cases (printReceipt catches, openDrawer catches, completeCash uses
 * Promise.all), but no test pinned the contract — a future refactor
 * could quietly bring back a throw.
 *
 * These tests pin the exact return shape so the IPC layer + UI banner
 * (G1) keep working.
 *
 * Also covers refund_lines parsing — printRefundReceipt used to read
 * the raw server shape (PLN floats + taxRate field), which the
 * 2026-04-23 / 0a743c1 commits normalised to grosze + vatRate. This
 * test pins the consumer side so the format contract stays stable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock() is hoisted above module-level const declarations, so any
// helper the factory references must be defined inside vi.hoisted().
const { orderRepoGetById, orderRepoGetItemsByOrderId, productRepoGetById } = vi.hoisted(() => ({
  orderRepoGetById: vi.fn(),
  orderRepoGetItemsByOrderId: vi.fn(),
  productRepoGetById: vi.fn(),
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: {
    getById: orderRepoGetById,
    getItemsByOrderId: orderRepoGetItemsByOrderId,
  },
}));

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: { getById: productRepoGetById },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PaymentController } from '../src/main/pos/payment-controller';
import { PrinterType } from '../src/shared/types';

function makeFakePrinter(opts: {
  printRejects?: boolean;
  drawerRejects?: boolean;
  connected?: boolean;
}) {
  return {
    isConnected: () => opts.connected !== false,
    printReceipt: vi.fn(async () => {
      if (opts.printRejects) throw new Error('printer offline');
    }),
    openDrawer: vi.fn(async () => {
      if (opts.drawerRejects) throw new Error('no drawer attached');
    }),
  };
}

function buildController(printer: ReturnType<typeof makeFakePrinter> | null) {
  return new PaymentController(
    (_type: string) => printer as any,
    () => true,
    () => 'Chè Sài Gòn',
    () => 'Chè Sài Gòn Sp. z o.o.',
    () => 'ul. Marszałkowska 1',
    () => '5220052349',
  );
}

const sampleOrder = {
  id: 'order-1',
  order_number: 'POS-20260505-0001',
  status: 'COMPLETED',
  total: 1234,
  subtotal: 1234,
  payment_method: 'CASH' as const,
  payment_amount: 1234,
  staff_name: 'Anna',
  created_at: '2026-05-05T10:00:00.000Z',
  refund_amount: null,
  refund_reason: null,
  refund_lines: null,
};

describe('PaymentController — sale completes despite print/drawer failure (G2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orderRepoGetById.mockReset();
    orderRepoGetItemsByOrderId.mockReset();
    productRepoGetById.mockReset();
    orderRepoGetById.mockReturnValue(sampleOrder);
    orderRepoGetItemsByOrderId.mockReturnValue([
      { name: 'Bulka', quantity: 2, price: 200, total: 400, vat_rate: 5, sku: 'BULKA-1', variant_id: null },
      { name: 'Mleko', quantity: 1, price: 350, total: 350, vat_rate: 8, sku: 'MILK-1', variant_id: null },
    ]);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('completeCashPayment returns success=true with receiptPrinted=false when print rejects', async () => {
    const printer = makeFakePrinter({ printRejects: true });
    const ctl = buildController(printer);
    const result = await ctl.completeCashPayment('order-1');
    expect(result.success).toBe(true);
    expect(result.receiptPrinted).toBe(false);
  });

  it('completeCashPayment returns success=true even when drawer rejects (no drawer hardware case)', async () => {
    const printer = makeFakePrinter({ drawerRejects: true });
    const ctl = buildController(printer);
    const result = await ctl.completeCashPayment('order-1');
    expect(result.success).toBe(true);
    expect(result.drawerOpened).toBe(false);
  });

  it('completeCashPayment returns success=true when BOTH print and drawer reject', async () => {
    // The owner without a cash drawer + a missing printer must not be
    // a failed sale — the order is already saved before this controller
    // runs, this is just side-effects.
    const printer = makeFakePrinter({ printRejects: true, drawerRejects: true });
    const ctl = buildController(printer);
    const result = await ctl.completeCashPayment('order-1');
    expect(result.success).toBe(true);
    expect(result.receiptPrinted).toBe(false);
    expect(result.drawerOpened).toBe(false);
  });

  it('completeCardPayment returns success=true with receiptPrinted=false when print rejects', async () => {
    const printer = makeFakePrinter({ printRejects: true });
    const ctl = buildController(printer);
    const result = await ctl.completeCardPayment('order-1');
    expect(result.success).toBe(true);
    expect(result.receiptPrinted).toBe(false);
  });

  it('completeCashPayment with NO printer attached still returns success', async () => {
    const ctl = buildController(null);
    const result = await ctl.completeCashPayment('order-1');
    expect(result.success).toBe(true);
    expect(result.receiptPrinted).toBe(false);
  });

  it('completeCashPayment with disconnected printer still returns success', async () => {
    const printer = makeFakePrinter({ connected: false });
    const ctl = buildController(printer);
    const result = await ctl.completeCashPayment('order-1');
    expect(result.success).toBe(true);
    expect(result.receiptPrinted).toBe(false);
  });
});

describe('PaymentController.printRefundReceipt — refund_lines parsing (G2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orderRepoGetById.mockReset();
    orderRepoGetItemsByOrderId.mockReset();
    productRepoGetById.mockReturnValue(null);
  });

  it('parses stored refund_lines (grosze + vatRate shape) into ReceiptItem', async () => {
    // post-0a743c1 normalised shape — each line has unitPrice/refundAmount in
    // grosze and vatRate (not the legacy taxRate) field.
    const printer = makeFakePrinter({});
    const ctl = buildController(printer);
    orderRepoGetById.mockReturnValue({
      ...sampleOrder,
      refund_amount: 400,
      refund_reason: 'Klient zwrocil towar',
      refund_lines: JSON.stringify([
        { name: 'Bulka', quantity: 2, unitPrice: 200, refundAmount: 400, vatRate: 5, sku: 'BULKA-1' },
      ]),
    });

    const ok = await ctl.printRefundReceipt('order-1');
    expect(ok).toBe(true);
    expect(printer.printReceipt).toHaveBeenCalledTimes(1);

    const data = (printer.printReceipt.mock.calls[0] as any[])[0];
    expect(data.isRefund).toBe(true);
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      name: 'Bulka',
      quantity: 2,
      unitPrice: 200,        // grosze
      totalPrice: 400,       // refundAmount → totalPrice
      vatRate: 5,            // preserved from stored line
      sku: 'BULKA-1',
    });
    expect(data.refundReason).toBe('Klient zwrocil towar');
    expect(data.originalOrderNumber).toBe('POS-20260505-0001');
    // G5 fix: original date must flow into the refund receipt so the
    // formatter can print "Oryginał: ... z dnia DD.MM.YYYY".
    expect(data.originalDate).toBe('2026-05-05T10:00:00.000Z');
  });

  it('falls back to all order items when refund_lines is null (older orders)', async () => {
    const printer = makeFakePrinter({});
    const ctl = buildController(printer);
    orderRepoGetById.mockReturnValue({
      ...sampleOrder,
      refund_amount: 750,
      refund_lines: null,
    });
    orderRepoGetItemsByOrderId.mockReturnValue([
      { name: 'Bulka', quantity: 2, price: 200, total: 400, vat_rate: 5, sku: 'BULKA-1', variant_id: null },
      { name: 'Mleko', quantity: 1, price: 350, total: 350, vat_rate: 8, sku: 'MILK-1', variant_id: null },
    ]);

    const ok = await ctl.printRefundReceipt('order-1');
    expect(ok).toBe(true);
    const data = (printer.printReceipt.mock.calls[0] as any[])[0];
    expect(data.items).toHaveLength(2);
    expect(data.total).toBe(750);
  });

  it('returns false (no throw) when the receipt printer is missing', async () => {
    const ctl = buildController(null);
    orderRepoGetById.mockReturnValue({
      ...sampleOrder,
      refund_amount: 400,
      refund_lines: '[{"name":"Bulka","quantity":2,"unitPrice":200,"refundAmount":400,"vatRate":5}]',
    });
    const ok = await ctl.printRefundReceipt('order-1');
    expect(ok).toBe(false);
  });

  it('returns false when refund_lines JSON is corrupt — falls through to printer attempt with order items', async () => {
    // Defensive: a partially written DB row must not crash refund flow.
    const printer = makeFakePrinter({});
    const ctl = buildController(printer);
    orderRepoGetById.mockReturnValue({
      ...sampleOrder,
      refund_amount: 750,
      refund_lines: '{ malformed json',
    });
    orderRepoGetItemsByOrderId.mockReturnValue([
      { name: 'Bulka', quantity: 2, price: 200, total: 400, vat_rate: 5, sku: null, variant_id: null },
    ]);
    const ok = await ctl.printRefundReceipt('order-1');
    expect(ok).toBe(true);
    // Used the fallback path (order items), not the corrupt refund_lines.
    const data = (printer.printReceipt.mock.calls[0] as any[])[0];
    expect(data.items).toHaveLength(1);
  });
});
