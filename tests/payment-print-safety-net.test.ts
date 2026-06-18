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
const { orderRepoGetById, orderRepoGetItemsByOrderId, productRepoGetById, productRepoGetBySku } = vi.hoisted(() => ({
  orderRepoGetById: vi.fn(),
  orderRepoGetItemsByOrderId: vi.fn(),
  productRepoGetById: vi.fn(),
  productRepoGetBySku: vi.fn(),
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: {
    getById: orderRepoGetById,
    getItemsByOrderId: orderRepoGetItemsByOrderId,
  },
}));

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: { getById: productRepoGetById, getBySku: productRepoGetBySku },
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
  connectSucceeds?: boolean;
}) {
  let connected = opts.connected !== false;
  return {
    connect: vi.fn(async () => {
      if (opts.connectSucceeds) connected = true;
      return connected;
    }),
    isConnected: () => connected,
    printReceipt: vi.fn(async () => {
      if (opts.printRejects) throw new Error('printer offline');
    }),
    openDrawer: vi.fn(async () => {
      if (opts.drawerRejects) throw new Error('no drawer attached');
    }),
  };
}

function buildController(
  printer: ReturnType<typeof makeFakePrinter> | null,
  sharedReceiptPrinter?: any,
  sharedFiscalPrinter?: any,
  sharedFiscalStatus?: any,
) {
  return new PaymentController(
    (_type: string) => printer as any,
    () => true,
    () => 'Chè Sài Gòn',
    () => 'Chè Sài Gòn Sp. z o.o.',
    () => 'ul. Marszałkowska 1',
    () => '5220052349',
    sharedReceiptPrinter,
    sharedFiscalPrinter,
    sharedFiscalStatus,
  );
}

const sampleOrder = {
  id: 'order-1',
  order_number: 'POS-20260505-0001',
  status: 'COMPLETED',
  total: 750,
  subtotal: 750,
  payment_method: 'CASH' as const,
  payment_amount: 750,
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
    productRepoGetBySku.mockReset();
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

  it('printReceiptAndOpenDrawer uses the combined local thermal path when available', async () => {
    const printer = makeFakePrinter({}) as ReturnType<typeof makeFakePrinter> & {
      printReceiptWithDrawer: ReturnType<typeof vi.fn>;
    };
    printer.printReceiptWithDrawer = vi.fn(async () => undefined);
    const ctl = buildController(printer);

    const result = await ctl.printReceiptAndOpenDrawer('order-1');

    expect(result).toEqual({ receiptPrinted: true, drawerOpened: true });
    expect(printer.printReceiptWithDrawer).toHaveBeenCalledTimes(1);
    expect(printer.printReceipt).not.toHaveBeenCalled();
    expect(printer.openDrawer).not.toHaveBeenCalled();
  });

  it('printReceiptAndOpenDrawer asks the shared POS receipt route to open the remote drawer', async () => {
    const sharedReceiptPrinter = vi.fn(async () => ({
      handled: true,
      printed: true,
      printerId: 'printer-remote-1',
      drawerOpenRequested: true,
    }));
    const ctl = buildController(null, sharedReceiptPrinter);

    const result = await ctl.printReceiptAndOpenDrawer('order-1');

    expect(result).toEqual({ receiptPrinted: true, drawerOpened: true, error: undefined });
    expect(sharedReceiptPrinter).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', orderNumber: 'POS-20260505-0001' }),
      expect.objectContaining({ referenceType: 'POS_RECEIPT', referenceId: 'order-1', source: 'pos', openDrawer: true }),
    );
  });

  it('printReceiptAndOpenDrawer reports drawer not opened when remote backend lacks drawer support and no local printer exists', async () => {
    const sharedReceiptPrinter = vi.fn(async () => ({
      handled: true,
      printed: true,
      printerId: 'printer-remote-1',
      drawerOpenRequested: false,
    }));
    const ctl = buildController(null, sharedReceiptPrinter);

    const result = await ctl.printReceiptAndOpenDrawer('order-1');

    expect(result).toEqual({ receiptPrinted: true, drawerOpened: false, error: undefined });
  });

  it('printReceiptAndOpenDrawer uses the local printer directly even when the shared route would be offline', async () => {
    const printer = makeFakePrinter({});
    const sharedReceiptPrinter = vi.fn(async () => ({
      handled: true,
      printed: false,
      printerId: 'printer-remote-1',
      error: 'Printer is offline',
    }));
    const ctl = buildController(printer, sharedReceiptPrinter);

    const result = await ctl.printReceiptAndOpenDrawer('order-1');

    expect(result).toEqual({ receiptPrinted: true, drawerOpened: true });
    expect(printer.printReceipt).toHaveBeenCalledTimes(1);
    expect(printer.openDrawer).toHaveBeenCalledTimes(1);
    expect(sharedReceiptPrinter).not.toHaveBeenCalled();
  });

  it('completeCardPayment returns success=true with receiptPrinted=false when print rejects', async () => {
    const printer = makeFakePrinter({ printRejects: true });
    const ctl = buildController(printer);
    const result = await ctl.completeCardPayment('order-1');
    expect(result.success).toBe(true);
    expect(result.receiptPrinted).toBe(false);
  });

  it('completeCardPayment can route the receipt through a shared backend printer when local printer is missing', async () => {
    const sharedReceiptPrinter = vi.fn(async () => ({ handled: true, printed: true, printerId: 'printer-remote-1' }));
    const ctl = buildController(null, sharedReceiptPrinter);
    const result = await ctl.completeCardPayment('order-1');
    expect(result.success).toBe(true);
    expect(result.receiptPrinted).toBe(true);
    expect(sharedReceiptPrinter).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', orderNumber: 'POS-20260505-0001' }),
      expect.objectContaining({ referenceType: 'POS_RECEIPT', referenceId: 'order-1', source: 'pos' }),
    );
  });

  it('prints with the local printer without consulting shared receipt routing when local hardware is ready', async () => {
    const printer = makeFakePrinter({});
    const sharedReceiptPrinter = vi.fn(async () => ({ handled: false, printed: false }));
    const ctl = buildController(printer, sharedReceiptPrinter);
    const result = await ctl.completeCardPayment('order-1');
    expect(result.receiptPrinted).toBe(true);
    expect(printer.printReceipt).toHaveBeenCalledTimes(1);
    expect(sharedReceiptPrinter).not.toHaveBeenCalled();
  });

  it('uses the local printer directly even when the shared route would fail', async () => {
    const printer = makeFakePrinter({});
    const sharedReceiptPrinter = vi.fn(async () => ({
      handled: true,
      printed: false,
      printerId: 'printer-remote-1',
      error: 'Owning print agent is offline',
    }));
    const ctl = buildController(printer, sharedReceiptPrinter);
    const result = await ctl.completeCardPayment('order-1');
    expect(result.receiptPrinted).toBe(true);
    expect(printer.printReceipt).toHaveBeenCalledTimes(1);
    expect(sharedReceiptPrinter).not.toHaveBeenCalled();
  });

  it('routes fiscal receipts through the remote fiscal backend job when no local fiscal printer exists', async () => {
    const sharedFiscalPrinter = vi.fn(async () => ({
      handled: true,
      printed: true,
      printerId: 'remote-fiscal-1',
      jobId: 'job-1',
    }));
    const ctl = buildController(null, undefined, sharedFiscalPrinter);

    await expect(ctl.printFiscalReceipt('order-1')).resolves.toBe(true);

    expect(sharedFiscalPrinter).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', orderNumber: 'POS-20260505-0001' }),
      expect.objectContaining({ referenceType: 'POS_FISCAL_RECEIPT', referenceId: 'order-1', source: 'pos' }),
    );
  });

  it('grosses legacy mirrored net-priced order rows before fiscal printing', async () => {
    const fiscalPrinter = makeFakePrinter({});
    const ctl = buildController(fiscalPrinter);
    orderRepoGetById.mockReturnValue({
      ...sampleOrder,
      subtotal: 571,
      tax: 29,
      discount: 0,
      total: 600,
      payment_amount: 600,
    });
    orderRepoGetItemsByOrderId.mockReturnValue([
      {
        name: 'Sữa đậu nành bán theo cốc',
        quantity: 1,
        price: 571,
        total: 571,
        vat_rate: 5,
        sku: 'MOON-260601-NE6',
        variant_id: null,
      },
    ]);

    await expect(ctl.printFiscalReceipt('order-1')).resolves.toBe(true);

    const data = (fiscalPrinter.printReceipt.mock.calls[0] as any[])[0];
    expect(data.subtotal).toBe(600);
    expect(data.total).toBe(600);
    expect(data.payment.amount).toBe(600);
    expect(data.items[0]).toMatchObject({
      unitPrice: 600,
      totalPrice: 600,
      vatRate: 5,
      sku: 'MOON-260601-NE6',
    });
  });

  it('surfaces remote fiscal failure instead of treating job delivery as printed', async () => {
    const sharedFiscalPrinter = vi.fn(async () => ({
      handled: true,
      printed: false,
      printerId: 'remote-fiscal-1',
      error: 'Backend did not return final COMPLETED status for fiscal receipt job',
    }));
    const ctl = buildController(null, undefined, sharedFiscalPrinter);

    await expect(ctl.printFiscalReceipt('order-1')).rejects.toThrow('final COMPLETED');
  });

  it('reports remote fiscal availability when the backend exposes a ready fiscal route', async () => {
    const sharedFiscalStatus = vi.fn(async () => ({
      configured: true,
      connected: true,
      printerId: 'remote-fiscal-1',
    }));
    const ctl = buildController(null, undefined, undefined, sharedFiscalStatus);

    await expect(ctl.hasFiscalPrinter()).resolves.toEqual({ configured: true, connected: true });
    expect(sharedFiscalStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps fiscal receipts on the local FISCAL printer and never uses remote routes', async () => {
    const fiscalPrinter = makeFakePrinter({});
    const sharedReceiptPrinter = vi.fn(async () => ({ handled: true, printed: true, printerId: 'remote-fiscal' }));
    const sharedFiscalPrinter = vi.fn(async () => ({ handled: true, printed: true, printerId: 'remote-fiscal' }));
    const sharedFiscalStatus = vi.fn(async () => ({ configured: true, connected: true, printerId: 'remote-fiscal' }));
    const getPrinter = vi.fn((type: string) => (
      type === PrinterType.FISCAL ? fiscalPrinter as any : null
    ));
    const ctl = new PaymentController(
      getPrinter,
      () => true,
      () => 'ChÃ¨ SÃ i GÃ²n',
      () => 'ChÃ¨ SÃ i GÃ²n Sp. z o.o.',
      () => 'ul. MarszaÅ‚kowska 1',
      () => '5220052349',
      sharedReceiptPrinter,
      sharedFiscalPrinter,
      sharedFiscalStatus,
    );

    await expect(ctl.printFiscalReceipt('order-1')).resolves.toBe(true);

    expect(getPrinter).toHaveBeenCalledWith(PrinterType.FISCAL);
    expect(sharedReceiptPrinter).not.toHaveBeenCalled();
    expect(sharedFiscalPrinter).not.toHaveBeenCalled();
    expect(sharedFiscalStatus).not.toHaveBeenCalled();
    expect(fiscalPrinter.printReceipt).toHaveBeenCalledTimes(1);
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

  it('reconnects a configured receipt printer before treating it as unavailable', async () => {
    const printer = makeFakePrinter({ connected: false, connectSucceeds: true });
    const ctl = buildController(printer);

    const result = await ctl.completeCashPayment('order-1');

    expect(result.success).toBe(true);
    expect(result.receiptPrinted).toBe(true);
    expect(printer.connect).toHaveBeenCalledTimes(1);
    expect(printer.printReceipt).toHaveBeenCalledTimes(1);
  });

  it('openCashDrawer directly returns false when no drawer/printer hardware is available', async () => {
    const ctl = buildController(null);
    await expect(ctl.openCashDrawer()).resolves.toBe(false);
  });

  it('openCashDrawer directly returns false when drawer opening rejects', async () => {
    const printer = makeFakePrinter({ drawerRejects: true });
    const ctl = buildController(printer);
    await expect(ctl.openCashDrawer()).resolves.toBe(false);
  });

  it('reprintReceipt never opens the cash drawer', async () => {
    const printer = makeFakePrinter({});
    const ctl = buildController(printer);

    await expect(ctl.reprintReceipt('order-1')).resolves.toBe(true);

    expect(printer.printReceipt).toHaveBeenCalledTimes(1);
    expect(printer.openDrawer).not.toHaveBeenCalled();
  });

  it('reprintReceipt uses the local printer directly when local hardware is ready', async () => {
    const printer = makeFakePrinter({});
    const sharedReceiptPrinter = vi.fn(async () => ({
      handled: true,
      printed: false,
      printerId: 'printer-remote-1',
      error: 'Printer is offline',
    }));
    const ctl = buildController(printer, sharedReceiptPrinter);

    await expect(ctl.reprintReceipt('order-1')).resolves.toBe(true);

    expect(sharedReceiptPrinter).not.toHaveBeenCalled();
    expect(printer.printReceipt).toHaveBeenCalledTimes(1);
    expect(printer.openDrawer).not.toHaveBeenCalled();
  });

  it('prints the Polish catalog name on the customer receipt while keeping order rows canonical', async () => {
    const printer = makeFakePrinter({});
    const ctl = buildController(printer);
    orderRepoGetById.mockReturnValue({
      ...sampleOrder,
      total: 100,
      subtotal: 100,
      payment_amount: 100,
    });
    orderRepoGetItemsByOrderId.mockReturnValue([
      {
        name: 'Máy POS Ingenico Move/5000 Elavon',
        quantity: 1,
        price: 100,
        total: 100,
        vat_rate: 23,
        sku: 'terminal-platniczy-ingenico-elavon',
        variant_id: 'variant-1',
      },
    ]);
    productRepoGetById.mockReturnValue({
      id: 'variant-1',
      name: 'Máy POS Ingenico Move/5000 Elavon',
      name_translations: '{"pl":"Terminal płatniczy Ingenico Move/5000 Elavon"}',
      sale_unit: 'szt.',
    });

    const ok = await ctl.printReceipt('order-1');

    expect(ok).toBe(true);
    const data = (printer.printReceipt.mock.calls[0] as any[])[0];
    expect(data.items[0]).toMatchObject({
      name: 'Terminal płatniczy Ingenico Move/5000 Elavon',
      unit: 'szt.',
    });
  });
});

describe('PaymentController.printRefundReceipt — refund_lines parsing (G2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orderRepoGetById.mockReset();
    orderRepoGetItemsByOrderId.mockReset();
    productRepoGetById.mockReturnValue(null);
    productRepoGetBySku.mockReset();
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

  it('prints a just-confirmed second partial refund from delta override, not cumulative stored state', async () => {
    const printer = makeFakePrinter({});
    const ctl = buildController(printer);
    orderRepoGetById.mockReturnValue({
      ...sampleOrder,
      refund_amount: 3000,
      refund_reason: 'Second partial',
      refund_lines: JSON.stringify([
        { name: 'First item', quantity: 1, unitPrice: 2000, refundAmount: 2000, vatRate: 23, sku: 'FIRST-1' },
        { name: 'Second item', quantity: 2, unitPrice: 500, refundAmount: 1000, vatRate: 8, sku: 'SECOND-1' },
      ]),
    });

    const ok = await ctl.printRefundReceipt('order-1', {
      amount: 1000,
      reason: 'Second partial',
      lines: [
        { name: 'Second item', quantity: 2, unitPrice: 500, refundAmount: 1000, vatRate: 8, sku: 'SECOND-1' },
      ],
    });

    expect(ok).toBe(true);
    const data = (printer.printReceipt.mock.calls[0] as any[])[0];
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      name: 'Second item',
      quantity: 2,
      unitPrice: 500,
      totalPrice: 1000,
      vatRate: 8,
      sku: 'SECOND-1',
    });
    expect(data.subtotal).toBe(1000);
    expect(data.total).toBe(1000);
    expect(data.payment.amount).toBe(1000);
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

  it('uses the Polish catalog name for stored refund lines when SKU can still resolve the product', async () => {
    const printer = makeFakePrinter({});
    const ctl = buildController(printer);
    orderRepoGetById.mockReturnValue({
      ...sampleOrder,
      refund_amount: 100,
      refund_reason: 'Klient zwrocil towar',
      refund_lines: JSON.stringify([
        {
          name: 'Máy POS Ingenico Move/5000 Elavon',
          quantity: 1,
          unitPrice: 100,
          refundAmount: 100,
          vatRate: 23,
          sku: 'terminal-platniczy-ingenico-elavon',
        },
      ]),
    });
    productRepoGetBySku.mockReturnValue({
      name: 'Máy POS Ingenico Move/5000 Elavon',
      name_translations: '{"pl":"Terminal płatniczy Ingenico Move/5000 Elavon"}',
    });

    const ok = await ctl.printRefundReceipt('order-1');

    expect(ok).toBe(true);
    const data = (printer.printReceipt.mock.calls[0] as any[])[0];
    expect(data.items[0].name).toBe('Terminal płatniczy Ingenico Move/5000 Elavon');
  });
});
