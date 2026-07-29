import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handlers,
  databaseMock,
  orderRepoMock,
  outboxRepoMock,
  productRepoMock,
  paymentControllerMock,
  transactionState,
  lifecycle,
  notifyPosRenderersMock,
  getSecureAuthTokenMock,
  apiClientMock,
} = vi.hoisted(() => {
  const state = { insideOrderTransaction: false };
  return {
    handlers: new Map<string, (...args: any[]) => any>(),
    databaseMock: {
      transaction: vi.fn(),
      get: vi.fn(),
      run: vi.fn(),
      all: vi.fn(() => []),
      markDirty: vi.fn(),
      saveCoalesced: vi.fn(),
    },
    orderRepoMock: {
      create: vi.fn(),
      getById: vi.fn(),
    },
    outboxRepoMock: {
      enqueue: vi.fn(),
      findInitialByOrder: vi.fn(),
      prepareInitialForOrderMutation: vi.fn(),
    },
    productRepoMock: {
      getById: vi.fn(),
      decrementStock: vi.fn(),
    },
    paymentControllerMock: {
      buildSaleReceiptData: vi.fn(),
      reprintReceipt: vi.fn(),
      printFiscalReceipt: vi.fn(),
    },
    transactionState: state,
    lifecycle: [] as string[],
    notifyPosRenderersMock: vi.fn(),
    getSecureAuthTokenMock: vi.fn(),
    apiClientMock: {
      updateOrderPayment: vi.fn(),
      updateOrder: vi.fn(),
      voidOrder: vi.fn(),
      refundOrder: vi.fn(),
      correctBilliardOrder: vi.fn(),
      cancelOrder: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => 'C:\\test',
    getVersion: () => 'test',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
  },
  shell: {},
}));

vi.mock('../src/main/config/store', () => ({
  getConfig: vi.fn(() => ({
    salonId: 'salon-1',
    machineId: 'pos-1',
    allowOversell: false,
  })),
  getConfigValue: vi.fn(),
  getSecureApiKey: vi.fn(),
  getSecureAuthToken: getSecureAuthTokenMock,
  setConfigValue: vi.fn(),
}));

vi.mock('../src/main/database/database', () => ({
  database: databaseMock,
}));

vi.mock('../src/main/database/repos/order-repo', () => ({
  orderRepo: orderRepoMock,
}));

vi.mock('../src/main/database/repos/product-repo', () => ({
  STOCK_TRACKED_GUARD_SQL: '1 = 1',
  productRepo: productRepoMock,
}));

vi.mock('../src/main/database/repos/receipt-print-outbox-repo', () => ({
  RECEIPT_PRINT_OUTBOX_STATUSES: [
    'PENDING',
    'DISPATCHING',
    'REMOTE_ACCEPTED',
    'COMPLETED',
    'FAILED_SAFE',
    'NEEDS_REVIEW',
    'CANCELLED',
  ],
  receiptPrintOutboxRepo: outboxRepoMock,
}));

vi.mock('../src/main/events/pos-event-emitter', () => ({
  posEventEmitter: {
    emitOrderFinalized: vi.fn(),
    emitReceiptPrintAttempted: vi.fn(),
    emitFiscalReceiptEmitted: vi.fn(),
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

vi.mock('../src/main/kitchen-self-order/pickup-settle', () => ({
  drainPickupSettleOutbox: vi.fn(),
  settlePickupOrderForSale: vi.fn(),
}));

vi.mock('../src/main/windows/notify-pos-renderers', () => ({
  notifyPosRenderers: notifyPosRenderersMock,
}));

vi.mock('../src/main/network/api-client', () => ({
  apiClient: apiClientMock,
}));

import { PosModule } from '../src/main/modules/pos.module';

type PaymentMethod = 'CASH' | 'BLIK' | 'CARD';

function order(method: PaymentMethod) {
  return {
    id: `order-${method.toLowerCase()}`,
    order_number: `ZAM-${method}`,
    status: 'COMPLETED',
    subtotal: 1_000,
    discount: 0,
    tax: 187,
    total: 1_000,
    payment_method: method,
    payment_amount: 1_000,
    change_amount: 0,
    payment_tenders: JSON.stringify([{ method, amount: 1_000 }]),
    shift_id: 'shift-1',
    staff_id: 'staff-1',
    staff_name: 'Kasjer',
    source: 'POS',
    created_at: '2026-07-29T10:00:00.000Z',
  };
}

const items = [{
  id: 'item-1',
  order_id: 'unused',
  variant_id: null,
  name: 'Herbata',
  price: 1_000,
  quantity: 1,
  total: 1_000,
  vat_rate: 23,
}];

function buildModule() {
  const module = new PosModule({
    getOptional: vi.fn(() => undefined),
  } as any) as any;

  module.posStore = {
    getState: vi.fn(() => ({
      checkoutDraft: {
        billiard: null,
        restoredInterruption: null,
        kitchenSelfOrder: null,
      },
    })),
    dispatch: vi.fn(),
  };
  module.paymentController = paymentControllerMock;
  module.capturePosAuthContext = vi.fn(() => ({
    epoch: 1,
    scope: {
      salonId: 'salon-1',
      userId: 'staff-1',
      registerId: 'pos-1',
    },
  }));
  module.isPosAuthContextCurrent = vi.fn(() => true);
  module.assertOrdinaryPosPaymentPreflight = vi.fn();
  module.assertLocalTenderFiscalCompatibility = vi.fn();
  module.syncNailTurnCheckoutForOrder = vi.fn(async () => undefined);
  module.wakeReceiptPrintOutbox = vi.fn(async () => {
    lifecycle.push('wake');
  });

  module.registerIpcHandlers();
  return module;
}

async function submit(method: PaymentMethod) {
  const create = handlers.get('pos:orders:create');
  expect(create).toBeTypeOf('function');
  return create!(
    {},
    {
      ...order(method),
      payment_preflight_token: 'preflight-1',
    },
    items,
    { queueInitialReceipt: true },
  );
}

async function submitOrder(createdOrder: ReturnType<typeof order>) {
  const create = handlers.get('pos:orders:create');
  expect(create).toBeTypeOf('function');
  return create!(
    {},
    {
      ...createdOrder,
      payment_preflight_token: 'preflight-1',
    },
    items,
    { queueInitialReceipt: true },
  );
}

describe('POS initial receipt queue wiring', () => {
  beforeEach(() => {
    handlers.clear();
    lifecycle.length = 0;
    transactionState.insideOrderTransaction = false;
    vi.clearAllMocks();

    databaseMock.get.mockImplementation((sql: string) => {
      if (sql.includes('FROM shifts')) {
        return { id: 'shift-1', staff_id: 'staff-1', staff_name: 'Kasjer' };
      }
      return null;
    });
    databaseMock.saveCoalesced.mockImplementation(async () => {
      lifecycle.push('flush');
      return { success: true };
    });
    orderRepoMock.create.mockImplementation((createdOrder: any, _items: any[], options?: any) => {
      transactionState.insideOrderTransaction = true;
      try {
        options?.afterInsertInTransaction?.();
      } finally {
        transactionState.insideOrderTransaction = false;
      }
      return createdOrder.id;
    });
    paymentControllerMock.buildSaleReceiptData.mockImplementation((orderId: string) => ({
      orderId,
      orderNumber: `ZAM-${orderId}`,
      items: [{ name: 'Herbata', quantity: 1, price: 1_000 }],
      total: 1_000,
    }));
    outboxRepoMock.enqueue.mockImplementation((intent: any) => {
      lifecycle.push('enqueue');
      expect(transactionState.insideOrderTransaction).toBe(true);
      return {
        job_id: `job-${intent.orderId}`,
        order_id: intent.orderId,
        open_drawer: intent.openDrawer ? 1 : 0,
        status: 'PENDING',
      };
    });
    productRepoMock.getById.mockReturnValue(null);
  });

  it('persists a CASH print intent inside the order transaction, then returns after disk flush', async () => {
    const module = buildModule();

    const result = await submit('CASH');

    expect(outboxRepoMock.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-cash',
      salonId: 'salon-1',
      deviceId: 'pos-1',
      shiftId: 'shift-1',
      openDrawer: true,
      payload: expect.objectContaining({ orderId: 'order-cash' }),
    }));
    expect(result).toMatchObject({
      success: true,
      id: 'order-cash',
      receiptQueued: true,
      receiptPrintJobId: 'job-order-cash',
    });
    expect(lifecycle).toEqual(['enqueue', 'flush', 'wake']);
    expect(module.wakeReceiptPrintOutbox).toHaveBeenCalledWith('checkout');
  });

  it('queues BLIK without opening the cash drawer', async () => {
    buildModule();

    const result = await submit('BLIK');

    expect(outboxRepoMock.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-blik',
      openDrawer: false,
    }));
    expect(result).toMatchObject({
      success: true,
      receiptQueued: true,
    });
  });

  it('derives the drawer from every canonical split tender, not only the primary method', async () => {
    buildModule();
    const split = {
      ...order('CARD'),
      id: 'order-split',
      payment_method: 'CARD',
      payment_tenders: JSON.stringify([
        { method: 'CARD', amount: 600 },
        { method: 'CASH', amount: 400 },
      ]),
    };

    const result = await submitOrder(split);

    expect(outboxRepoMock.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-split',
      openDrawer: true,
    }));
    expect(result).toMatchObject({
      success: true,
      receiptQueued: true,
    });
  });

  it('does not queue CARD, leaving the existing fiscal route isolated', async () => {
    const module = buildModule();

    const result = await submit('CARD');

    expect(outboxRepoMock.enqueue).not.toHaveBeenCalled();
    expect(module.wakeReceiptPrintOutbox).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      success: true,
      id: 'order-card',
    }));
    expect(result).not.toHaveProperty('receiptQueued');
    expect(lifecycle).toEqual(['flush']);
  });

  it('replays durable unresolved print statuses after a renderer starts listening', async () => {
    buildModule();
    databaseMock.all.mockReturnValueOnce([{
      job_id: 'job-review',
      order_id: 'order-review',
      order_number: 'ZAM-0042',
      status: 'NEEDS_REVIEW',
      last_error: 'check paper',
    }]);
    const listStatuses = handlers.get('pos:receipt-print-status:list');

    expect(listStatuses?.({})).toEqual([{
      jobId: 'job-review',
      orderId: 'order-review',
      orderNumber: 'ZAM-0042',
      status: 'NEEDS_REVIEW',
      error: 'check paper',
    }]);
    expect(databaseMock.all).toHaveBeenCalledWith(
      expect.stringContaining("r.status IN ('FAILED_SAFE', 'NEEDS_REVIEW')"),
      ['salon-1', 'pos-1'],
    );
  });

  it('emits periodic receipt status changes only for the current salon and device', () => {
    const module = buildModule();
    databaseMock.all.mockReturnValueOnce([{
      seq: 7,
      job_id: 'job-current-device',
      order_id: 'order-current-device',
      order_number: 'ZAM-0043',
      status: 'NEEDS_REVIEW',
      last_error: 'check paper',
    }]);

    module.emitReceiptPrintStatusChanges();

    expect(databaseMock.all).toHaveBeenCalledWith(
      expect.stringMatching(
        /r\.salon_id = \? AND r\.device_id = \?[\s\S]*r\.status IN \('FAILED_SAFE', 'NEEDS_REVIEW', 'COMPLETED'\)/,
      ),
      ['salon-1', 'pos-1'],
    );
    expect(notifyPosRenderersMock).toHaveBeenCalledTimes(1);
    expect(notifyPosRenderersMock).toHaveBeenCalledWith(
      expect.anything(),
      'pos:receipt-print-status',
      expect.objectContaining({
        jobId: 'job-current-device',
        orderId: 'order-current-device',
        status: 'NEEDS_REVIEW',
      }),
    );
  });
});

describe('Manual receipt reprint versus the initial outbox', () => {
  beforeEach(() => {
    handlers.clear();
    lifecycle.length = 0;
    vi.clearAllMocks();
    paymentControllerMock.reprintReceipt.mockResolvedValue(true);
    paymentControllerMock.printFiscalReceipt.mockResolvedValue(true);
  });

  it.each([
    'PENDING',
    'FAILED_SAFE',
    'DISPATCHING',
    'REMOTE_ACCEPTED',
  ])('blocks a manual reprint while the initial job is %s', async (status) => {
    outboxRepoMock.findInitialByOrder.mockReturnValue({
      job_id: 'job-initial-order-cash',
      order_id: 'order-cash',
      status,
    });
    buildModule();

    const result = await handlers.get('pos:reprint-receipt')?.({}, 'order-cash');

    expect(outboxRepoMock.findInitialByOrder).toHaveBeenCalledWith('order-cash');
    expect(paymentControllerMock.reprintReceipt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      receiptPrinted: false,
      error: expect.stringContaining(status),
    });
    expect(result.error).toContain('job-initial-order-cash');
    expect(result.error).toContain('Check the queue result');
  });

  it.each([
    'COMPLETED',
    'CANCELLED',
    'NEEDS_REVIEW',
  ])('allows a deliberate manual reprint after initial status %s', async (status) => {
    outboxRepoMock.findInitialByOrder.mockReturnValue({
      job_id: 'job-initial-order-cash',
      order_id: 'order-cash',
      status,
    });
    buildModule();

    const result = await handlers.get('pos:reprint-receipt')?.({}, 'order-cash');

    expect(paymentControllerMock.reprintReceipt).toHaveBeenCalledWith('order-cash');
    expect(result).toEqual({ success: true, receiptPrinted: true });
  });

  it('keeps fiscal printing independent from the non-fiscal initial outbox', async () => {
    outboxRepoMock.findInitialByOrder.mockReturnValue({
      job_id: 'job-initial-order-cash',
      order_id: 'order-cash',
      status: 'PENDING',
    });
    buildModule();

    const result = await handlers.get('pos:print-fiscal-receipt')?.({}, 'order-cash');

    expect(result).toEqual({ success: true, fiscalPrinted: true });
    expect(paymentControllerMock.printFiscalReceipt).toHaveBeenCalledWith('order-cash');
    expect(outboxRepoMock.findInitialByOrder).not.toHaveBeenCalled();
  });
});

describe('Receipt lifecycle before external order mutation', () => {
  beforeEach(() => {
    handlers.clear();
    lifecycle.length = 0;
    vi.clearAllMocks();
    databaseMock.transaction.mockImplementation((work: () => void) => work());
    databaseMock.saveCoalesced.mockResolvedValue({ success: true });
    getSecureAuthTokenMock.mockReturnValue('auth-token-old-context');
  });

  it('forces cancellation to disk before allowing a backend mutation boundary', async () => {
    const module = buildModule();
    outboxRepoMock.findInitialByOrder.mockReturnValue({
      job_id: 'job-cash',
      order_id: 'order-cash',
      status: 'PENDING',
    });
    outboxRepoMock.prepareInitialForOrderMutation.mockImplementation(() => {
      lifecycle.push('cancel');
      return { job_id: 'job-cash', status: 'CANCELLED' };
    });
    databaseMock.saveCoalesced.mockImplementation(async () => {
      lifecycle.push('flush');
      return { success: true };
    });

    await module.prepareInitialReceiptForExternalOrderMutation(
      'order-cash',
      'server payment mutation',
    );

    expect(lifecycle).toEqual(['cancel', 'flush']);
  });

  it('retries the durability barrier when memory is CANCELLED after a failed save', async () => {
    const module = buildModule();
    outboxRepoMock.findInitialByOrder
      .mockReturnValueOnce({ job_id: 'job-cash', order_id: 'order-cash', status: 'PENDING' })
      .mockReturnValueOnce({ job_id: 'job-cash', order_id: 'order-cash', status: 'CANCELLED' });
    outboxRepoMock.prepareInitialForOrderMutation.mockReturnValue({
      job_id: 'job-cash',
      status: 'CANCELLED',
    });
    databaseMock.saveCoalesced
      .mockResolvedValueOnce({ success: false, error: 'disk busy' })
      .mockResolvedValueOnce({ success: true });

    await expect(module.prepareInitialReceiptForExternalOrderMutation(
      'order-cash',
      'server payment mutation',
    )).rejects.toMatchObject({
      code: 'RECEIPT_PRINT_CANCELLATION_NOT_DURABLE',
    });
    await expect(module.prepareInitialReceiptForExternalOrderMutation(
      'order-cash',
      'server payment mutation retry',
    )).resolves.toBeUndefined();

    expect(databaseMock.saveCoalesced).toHaveBeenCalledTimes(2);
  });

  it('wires the durable lifecycle guard before every backend order mutation', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/main/modules/pos.module.ts'),
      'utf8',
    );
    const guardedBefore = (handler: string, networkCall: string) => {
      const start = source.indexOf(`ipcMain.handle('${handler}'`);
      const end = source.indexOf('\n    ipcMain.handle(', start + 1);
      const block = source.slice(start, end > start ? end : undefined);
      expect(start).toBeGreaterThan(-1);
      expect(block.indexOf('prepareInitialReceiptForExternalOrderMutation('))
        .toBeGreaterThan(-1);
      expect(block.indexOf('prepareInitialReceiptForExternalOrderMutation('))
        .toBeLessThan(block.indexOf(networkCall));
      const barrierIndex = block.indexOf('prepareInitialReceiptForExternalOrderMutation(');
      const authCaptureIndex = block.indexOf('capturePosAuthContext(');
      const postBarrierAuthCheck = block.indexOf(
        'isPosAuthContextCurrent(',
        barrierIndex,
      );
      expect(authCaptureIndex).toBeGreaterThan(-1);
      expect(authCaptureIndex).toBeLessThan(barrierIndex);
      expect(postBarrierAuthCheck).toBeGreaterThan(barrierIndex);
      expect(postBarrierAuthCheck).toBeLessThan(block.indexOf(networkCall));
      expect(block).toMatch(
        /await this\.prepareInitialReceiptForExternalOrderMutation\([\s\S]*?\);\s*if \(!this\.isPosAuthContextCurrent\(/,
      );
    };

    guardedBefore('pos:orders:mutate', 'apiClient.updateOrderPayment');
    guardedBefore('pos:orders:refund', 'apiClient.refundOrder');
    guardedBefore('pos:orders:billiard-correction', 'apiClient.correctBilliardOrder');
    guardedBefore('pos:orders:cancel', 'apiClient.cancelOrder');
  });

  it.each([
    {
      handler: 'pos:orders:mutate',
      args: ['order-cash', {
        type: 'payment',
        paymentMethod: 'CASH',
        paymentAmount: 1_000,
        changeAmount: 0,
      }],
      network: () => apiClientMock.updateOrderPayment,
    },
    {
      handler: 'pos:orders:cancel',
      args: ['order-cash'],
      network: () => apiClientMock.cancelOrder,
    },
  ])('does not cross $handler network boundary when auth changes during receipt flush', async ({
    handler,
    args,
    network,
  }) => {
    const module = buildModule();
    orderRepoMock.getById.mockReturnValue({
      ...order('CASH'),
      id: 'order-cash',
      backend_id: 'backend-order-1',
      synced: 1,
    });
    module.prepareInitialReceiptForExternalOrderMutation = vi.fn(async () => {
      module.isPosAuthContextCurrent.mockReturnValue(false);
    });

    const result = await handlers.get(handler)?.({}, ...args);

    expect(result).toMatchObject({ success: false, requiresRefresh: true });
    expect(module.capturePosAuthContext).toHaveBeenCalledTimes(1);
    expect(module.isPosAuthContextCurrent).toHaveBeenCalledTimes(1);
    expect(network()).not.toHaveBeenCalled();
  });
});

describe('OrderRepo transaction boundary', () => {
  it('executes the receipt-intent hook before the order transaction commits', async () => {
    const actual = await vi.importActual<
      typeof import('../src/main/database/repos/order-repo')
    >('../src/main/database/repos/order-repo');
    let insideTransaction = false;
    const observations: boolean[] = [];
    databaseMock.transaction.mockImplementation((work: () => void) => {
      insideTransaction = true;
      try {
        work();
      } finally {
        insideTransaction = false;
      }
    });
    databaseMock.run.mockImplementation(() => undefined);

    actual.orderRepo.create(
      order('CASH') as any,
      items.map((item) => ({ ...item, order_id: 'order-cash' })) as any,
      {
        afterInsertInTransaction: () => {
          observations.push(insideTransaction);
        },
      },
    );

    expect(databaseMock.transaction).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([true]);
  });
});

describe('PaymentModal queued receipt handoff', () => {
  it('does not invoke a second synchronous receipt print after main reports receiptQueued', () => {
    const filename = path.resolve(
      __dirname,
      '../src/renderer/components/pos/PaymentModal.tsx',
    );
    const source = fs.readFileSync(filename, 'utf8');
    const ast = ts.createSourceFile(
      filename,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let queuedBranch: ts.IfStatement | null = null;

    const visit = (node: ts.Node): void => {
      if (
        ts.isIfStatement(node)
        && node.expression.getText(ast).replace(/\s+/g, '') === 'result?.receiptQueued'
      ) {
        queuedBranch = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);

    expect(queuedBranch).not.toBeNull();
    const callsIn = (node: ts.Node | undefined) => {
      if (!node) return [];
      const calls: string[] = [];
      const collect = (child: ts.Node): void => {
        if (ts.isCallExpression(child)) calls.push(child.expression.getText(ast));
        ts.forEachChild(child, collect);
      };
      collect(node);
      return calls;
    };
    const queuedCalls = callsIn(queuedBranch!.thenStatement);
    const compatibilityCalls = callsIn(queuedBranch!.elseStatement);

    expect(queuedCalls).not.toContain(
      'window.electronAPI.pos.payment.printReceipt',
    );
    expect(queuedCalls).not.toContain(
      'window.electronAPI.pos.payment.printReceiptAndOpenDrawer',
    );
    expect(compatibilityCalls).toEqual(expect.arrayContaining([
      'window.electronAPI.pos.payment.printReceipt',
      'window.electronAPI.pos.payment.printReceiptAndOpenDrawer',
    ]));
  });

  it('subscribes before querying durable receipt warnings so startup events are not lost', () => {
    const filename = path.resolve(
      __dirname,
      '../src/renderer/components/pos/POSLayout.tsx',
    );
    const source = fs.readFileSync(filename, 'utf8');
    const subscribe = source.indexOf('pos.onReceiptPrintStatus?.(handleStatus)');
    const replay = source.indexOf('pos.listReceiptPrintStatuses?.()');

    expect(subscribe).toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(subscribe);
    expect(source).toContain('createReceiptPrintStatusHandler');
  });
});

describe('Receipt outbox route identity wiring', () => {
  it('reconciles an accepted remote row before any local-route selection', () => {
    const filename = path.resolve(
      __dirname,
      '../src/main/modules/pos.module.ts',
    );
    const source = fs.readFileSync(filename, 'utf8');
    const remoteBranch = source.indexOf("if (row.status === 'REMOTE_ACCEPTED')");
    const reconcileCall = source.indexOf(
      'reconcileSharedReceiptPrintJob(identity)',
      remoteBranch,
    );
    const readinessCall = source.indexOf(
      'isLocalReceiptPrinterReadyForOutbox()',
      remoteBranch,
    );

    expect(remoteBranch).toBeGreaterThan(-1);
    expect(reconcileCall).toBeGreaterThan(remoteBranch);
    expect(readinessCall).toBeGreaterThan(reconcileCall);
  });

  it('uses the rich shared result when a configured local driver is not ready', () => {
    const filename = path.resolve(
      __dirname,
      '../src/main/modules/pos.module.ts',
    );
    const source = fs.readFileSync(filename, 'utf8');
    const readinessCall = source.indexOf(
      'isLocalReceiptPrinterReadyForOutbox()',
    );
    const sharedSubmit = source.indexOf(
      'submitSharedReceiptPrint(receiptData',
      readinessCall,
    );
    const richMapping = source.indexOf(
      'sharedReceiptOutboxResult(shared)',
      sharedSubmit,
    );

    expect(readinessCall).toBeGreaterThan(-1);
    expect(sharedSubmit).toBeGreaterThan(readinessCall);
    expect(richMapping).toBeGreaterThan(sharedSubmit);
  });
});
