import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, KitchenTicketData, LanFirstPrintFailureClass } from '../src/shared/types';
import { PrinterType } from '../src/shared/types';
import { hashLanFirstPrintPayload } from '../src/main/printing/lan-first-payload-hash';
import { LanFirstKitchenTicketReceiverService } from '../src/main/printing/lan-first-kitchen-ticket-receiver';

type AttemptStatus = 'PRINTING' | 'COMPLETED' | 'FAILED';

type AttemptRow = {
  idempotencyKey: string;
  payloadHash: string;
  jobId: string;
  printerId: string;
  status: AttemptStatus;
  failureClass: LanFirstPrintFailureClass | null;
  errorMessage: string | null;
};

class InMemoryLedger {
  readonly rows = new Map<string, AttemptRow>();

  async beginPrintAttempt(input: {
    idempotencyKey: string;
    payloadHash: string;
    jobId: string;
    printerId: string;
  }) {
    const existing = this.rows.get(input.idempotencyKey);
    if (!existing) {
      const row = {
        ...input,
        status: 'PRINTING' as const,
        failureClass: null,
        errorMessage: null,
      };
      this.rows.set(input.idempotencyKey, row);
      return { action: 'PRINT' as const, row };
    }
    if (existing.payloadHash !== input.payloadHash) {
      return { action: 'REJECT' as const, reason: 'PAYLOAD_HASH_MISMATCH' as const, row: existing };
    }
    if (existing.status === 'COMPLETED' || existing.status === 'PRINTING') {
      return { action: 'NOOP' as const, duplicate: true, status: existing.status, row: existing };
    }
    if (existing.failureClass !== 'SAFE_BEFORE_PRINT') {
      return {
        action: 'NOOP' as const,
        duplicate: true,
        status: existing.status,
        failureClass: existing.failureClass,
        row: existing,
      };
    }
    const row = {
      ...existing,
      jobId: input.jobId,
      printerId: input.printerId,
      status: 'PRINTING' as const,
      failureClass: null,
      errorMessage: null,
    };
    this.rows.set(input.idempotencyKey, row);
    return { action: 'PRINT' as const, row };
  }

  async markCompleted(input: { idempotencyKey: string }) {
    const row = this.rows.get(input.idempotencyKey);
    if (row) this.rows.set(input.idempotencyKey, { ...row, status: 'COMPLETED', failureClass: null, errorMessage: null });
  }

  async markFailed(input: {
    idempotencyKey: string;
    failureClass: LanFirstPrintFailureClass;
    errorMessage: string;
  }) {
    const row = this.rows.get(input.idempotencyKey);
    if (row) {
      this.rows.set(input.idempotencyKey, {
        ...row,
        status: 'FAILED',
        failureClass: input.failureClass,
        errorMessage: input.errorMessage,
      });
    }
  }
}

const ticket: KitchenTicketData = {
  orderId: 'order-1',
  orderNumber: 'K-001',
  createdAt: '2026-06-18T10:00:00.000Z',
  source: 'SELF_CHECKOUT',
  kitchenLanguage: 'vi',
  items: [
    { name: 'Pho bo', quantity: 1, modifiers: ['No onion'] },
  ],
};

function config(): AgentConfig {
  return {
    name: 'Target POS',
    printerProtocol: 'THERMAL',
    printerBaudRate: 9600,
    serverUrl: 'http://localhost:3003',
    isPaired: true,
    autoStart: false,
    machineId: 'target-machine',
    lanFirstReceiver: { enabled: true, port: 0 },
  } as AgentConfig;
}

function validRequest(overrides: Record<string, unknown> = {}) {
  const request = {
    jobId: 'job-1',
    idempotencyKey: 'idem-1',
    dispatchMode: 'LAN_FIRST',
    sourceMachineId: 'source-machine',
    targetMachineId: 'target-machine',
    printerId: 'printer-1',
    jobType: 'KITCHEN_TICKET',
    printerType: 'KITCHEN',
    referenceType: 'KITCHEN_TICKET',
    referenceId: 'order-1',
    payload: ticket,
    ...overrides,
  };
  return {
    ...request,
    payloadHash: hashLanFirstPrintPayload({
      jobType: request.jobType as 'KITCHEN_TICKET',
      printerType: request.printerType as 'KITCHEN',
      printerId: request.printerId as string,
      referenceType: request.referenceType as 'KITCHEN_TICKET',
      referenceId: request.referenceId as string,
      payload: request.payload,
    }),
  };
}

async function postJson(port: number, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}/print/kitchen-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

describe('LanFirstKitchenTicketReceiverService', () => {
  let service: LanFirstKitchenTicketReceiverService | null = null;

  afterEach(async () => {
    await service?.stop();
    service = null;
  });

  async function start(deps: {
    ledger?: InMemoryLedger;
    printExecutor?: ReturnType<typeof vi.fn>;
    getConfig?: () => AgentConfig;
  } = {}) {
    const ledger = deps.ledger ?? new InMemoryLedger();
    const printExecutor = deps.printExecutor ?? vi.fn(async () => undefined);
    service = new LanFirstKitchenTicketReceiverService({
      getConfig: deps.getConfig ?? config,
      ledger,
      printKitchenTicket: printExecutor,
      getLocalPrinter: (printerId: string) => (
        printerId === 'printer-1'
          ? { id: printerId, printer_type: PrinterType.KITCHEN, is_enabled: 1 }
          : null
      ),
      reportResult: vi.fn(async () => undefined),
    });
    await service.applyConfig();
    const port = service.getStatus().port;
    expect(port).toBeGreaterThan(0);
    return { ledger, printExecutor, port: port as number };
  }

  it('rejects non-kitchen LAN_FIRST request shapes', async () => {
    const { port, printExecutor } = await start();

    for (const override of [
      { jobType: 'RECEIPT' },
      { printerType: 'RECEIPT' },
      { referenceType: 'POS_RECEIPT' },
      { dispatchMode: 'BACKEND' },
    ]) {
      const result = await postJson(port, validRequest(override));
      expect(result.status).toBe(400);
    }

    expect(printExecutor).not.toHaveBeenCalled();
  });

  it('rejects a payloadHash mismatch before printing', async () => {
    const { port, printExecutor } = await start();

    const result = await postJson(port, {
      ...validRequest(),
      payloadHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/payloadHash/i);
    expect(printExecutor).not.toHaveBeenCalled();
  });

  it('rejects a targetMachineId mismatch before printing', async () => {
    const { port, printExecutor } = await start();

    const result = await postJson(port, validRequest({ targetMachineId: 'other-machine' }));

    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/targetMachineId/i);
    expect(printExecutor).not.toHaveBeenCalled();
  });

  it('prints a valid kitchen ticket request once', async () => {
    const { port, printExecutor } = await start();

    const result = await postJson(port, validRequest());

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, status: 'COMPLETED' });
    expect(printExecutor).toHaveBeenCalledTimes(1);
    expect(printExecutor).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-1',
      printerId: 'printer-1',
      payload: ticket,
    }));
  });

  it('does not call the print executor again for a completed duplicate', async () => {
    const { port, printExecutor } = await start();

    const first = await postJson(port, validRequest());
    const duplicate = await postJson(port, validRequest());

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ success: true, status: 'COMPLETED', duplicate: true });
    expect(printExecutor).toHaveBeenCalledTimes(1);
  });
});
