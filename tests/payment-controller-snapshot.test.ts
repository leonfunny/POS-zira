import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  orderRepoGetById,
  orderRepoGetItemsByOrderId,
  fiscalGetReceiptSnapshot,
  fiscalRecordRemoteFiscalSuccess,
  productRepoGetById,
  productRepoGetBySku,
} = vi.hoisted(() => ({
  orderRepoGetById: vi.fn(),
  orderRepoGetItemsByOrderId: vi.fn(),
  fiscalGetReceiptSnapshot: vi.fn(),
  fiscalRecordRemoteFiscalSuccess: vi.fn(),
  productRepoGetById: vi.fn(),
  productRepoGetBySku: vi.fn(),
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: {
    getById: orderRepoGetById,
    getItemsByOrderId: orderRepoGetItemsByOrderId,
  },
}));

vi.mock('../src/main/database/repos/fiscal-attempt-repo', () => ({
  fiscalAttemptRepo: {
    getReceiptSnapshot: fiscalGetReceiptSnapshot,
    recordRemoteFiscalSuccess: fiscalRecordRemoteFiscalSuccess,
  },
}));

vi.mock('../src/main/database/repos/product-repo', () => ({
  productRepo: {
    getById: productRepoGetById,
    getBySku: productRepoGetBySku,
  },
}));

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PaymentController } from '../src/main/pos/payment-controller';

function fakePrinter() {
  return {
    connect: vi.fn(async () => true),
    isConnected: vi.fn(() => true),
    printReceipt: vi.fn(async () => undefined),
    openDrawer: vi.fn(async () => undefined),
  };
}

function controller(printer: ReturnType<typeof fakePrinter>) {
  return new PaymentController(
    () => printer,
    () => true,
    () => 'Salon Snapshot',
    () => 'Seller Snapshot Sp. z o.o.',
    () => 'ul. Snapshot 1',
    () => '1234567890',
  );
}

describe('PaymentController receipt snapshot fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    productRepoGetById.mockReturnValue(null);
    productRepoGetBySku.mockReturnValue(null);
  });

  it('reprints a fiscal receipt from snapshot when the order row was purged', async () => {
    const printer = fakePrinter();
    orderRepoGetById.mockReturnValue(null);
    fiscalGetReceiptSnapshot.mockReturnValue({
      orderNumber: 'POS-SNAP-1',
      items: [{ name: 'Pierogi', quantity: 2, unitPrice: 500, totalPrice: 1000, vatRate: 8 }],
      payment: { method: 'CARD', amount: 1000 },
      subtotal: 1200,
      discount: 200,
      total: 1000,
      cashierName: 'Anna',
      customerName: 'Jan',
      customerNip: '5210000000',
      tenders: [
        { method: 'CARD', amount: 700 },
        { method: 'CASH', amount: 300 },
      ],
    });

    await expect(controller(printer).reprintReceipt('missing-order')).resolves.toBe(true);

    expect(orderRepoGetItemsByOrderId).not.toHaveBeenCalled();
    expect(fiscalGetReceiptSnapshot).toHaveBeenCalledWith('missing-order');
    const receipt = printer.printReceipt.mock.calls[0][0];
    expect(receipt).toMatchObject({
      orderId: 'missing-order',
      orderNumber: 'POS-SNAP-1',
      salonName: 'Salon Snapshot',
      sellerName: 'Seller Snapshot Sp. z o.o.',
      sellerAddress: 'ul. Snapshot 1',
      sellerNip: '1234567890',
      payment: { method: 'CARD', amount: 1000 },
      subtotal: 1200,
      discount: 200,
      total: 1000,
      cashierName: 'Anna',
      customerName: 'Jan',
      customerNip: '5210000000',
      isReprint: true,
    });
    expect(receipt.items).toHaveLength(1);
    expect(receipt.tenders).toEqual([
      { method: 'CARD', amount: 700 },
      { method: 'CASH', amount: 300 },
    ]);
  });

  it('returns false when neither order row nor confirmed snapshot exists', async () => {
    const printer = fakePrinter();
    orderRepoGetById.mockReturnValue(null);
    fiscalGetReceiptSnapshot.mockReturnValue(null);

    await expect(controller(printer).reprintReceipt('missing-order')).resolves.toBe(false);

    expect(printer.printReceipt).not.toHaveBeenCalled();
  });

  it('carries frozen Billiard line discounts into the receipt and validates payable total exactly', async () => {
    const printer = fakePrinter();
    orderRepoGetById.mockReturnValue({
      id: 'billiard-order-1',
      order_number: 'POS-B1',
      subtotal: 2904,
      discount: 1104,
      tax: 187,
      total: 1800,
      payment_method: 'CARD',
      payment_amount: 1800,
      payment_tenders: null,
      staff_name: 'Owner',
    });
    orderRepoGetItemsByOrderId.mockReturnValue([
      {
        id: 'time',
        name: 'Czas gry',
        price: 1000,
        quantity: 1,
        total: 1000,
        vat_rate: 23,
        billiard_json: JSON.stringify({ lineKey: 'time-1', kind: 'TIME' }),
        allocated_discount: 1000,
        payable_total: 0,
      },
      {
        id: 'weighted',
        name: 'Owoce',
        price: 8000,
        quantity: 0.238,
        total: 1904,
        vat_rate: 5,
        billiard_json: JSON.stringify({ lineKey: 'fnb-1', kind: 'FNB' }),
        allocated_discount: 104,
        payable_total: 1800,
      },
    ]);

    await expect(controller(printer).printReceipt('billiard-order-1')).resolves.toBe(true);
    expect(printer.printReceipt).toHaveBeenCalledWith(expect.objectContaining({
      total: 1800,
      discount: 1104,
      items: [
        expect.objectContaining({ totalPrice: 1000, allocatedDiscount: 1000 }),
        expect.objectContaining({ totalPrice: 1904, allocatedDiscount: 104 }),
      ],
    }));
  });

  it('fails closed when a frozen Billiard payable field differs from gross minus discount', async () => {
    const printer = fakePrinter();
    orderRepoGetById.mockReturnValue({
      id: 'billiard-order-bad',
      order_number: 'POS-BAD',
      subtotal: 1000,
      discount: 100,
      tax: 168,
      total: 900,
      payment_method: 'CASH',
      payment_amount: 900,
      payment_tenders: null,
    });
    orderRepoGetItemsByOrderId.mockReturnValue([{
      id: 'time',
      name: 'Czas gry',
      price: 1000,
      quantity: 1,
      total: 1000,
      vat_rate: 23,
      billiard_json: JSON.stringify({ lineKey: 'time-1', kind: 'TIME' }),
      allocated_discount: 100,
      payable_total: 901,
    }]);

    await expect(controller(printer).printReceipt('billiard-order-bad')).rejects.toThrow(
      'FISCAL_BILLIARD_PAYABLE_INVALID',
    );
    expect(printer.printReceipt).not.toHaveBeenCalled();
  });
});
