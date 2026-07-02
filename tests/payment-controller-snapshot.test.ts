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
});
