/**
 * pushPickupOrderBestEffort — the kiosk → backend pickup-queue push.
 *
 * Contract: best-effort and fire-and-forget — it must NEVER throw, so a
 * queue/backend problem can never break the kiosk submit/print/QR path. A
 * transient failure is persisted to a durable outbox and retried on reconnect
 * via drainPickupPushOutbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { getConfigMock, getSecureApiKeyMock, storeGetMock, storeSetMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  getSecureApiKeyMock: vi.fn(),
  storeGetMock: vi.fn(),
  storeSetMock: vi.fn(),
}));
vi.mock('../src/main/config/store', () => ({
  default: { get: storeGetMock, set: storeSetMock },
  getConfig: getConfigMock,
  getSecureApiKey: getSecureApiKeyMock,
}));

import {
  pushPickupOrderBestEffort,
  updatePickupKitchenPrintStatusBestEffort,
  drainPickupPushOutbox,
  drainPickupKitchenPrintStatusOutbox,
  drainPickupOutboxesInOrder,
} from '../src/main/kitchen-self-order/pickup-queue-client';

const baseInput = {
  terminalId: 'KIOSK-1',
  sourceOrderId: 'kso-1',
  orderNumber: 'K-001',
  sequence: 1,
  totalGrosze: 1500,
  qr: 'KSO1:abc',
};

describe('pushPickupOrderBestEffort', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getConfigMock.mockReturnValue({ serverUrl: 'https://api.example.com', machineId: 'm1' });
    getSecureApiKeyMock.mockReturnValue('pa_test');
    storeGetMock.mockReturnValue([]);
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('POSTs apiKey + payload.qr to the pickup-orders endpoint', async () => {
    await pushPickupOrderBestEffort(baseInput);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/v1/print-agent/pickup-orders');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.apiKey).toBe('pa_test');
    expect(body.sourceOrderId).toBe('kso-1');
    expect(body.orderNumber).toBe('K-001');
    expect(body.totalGrosze).toBe(1500);
    expect(body.payload).toEqual({ qr: 'KSO1:abc' });
    expect(body.kitchenPrintStatus).toBe('PENDING');
  });

  it('does nothing when the terminal is not paired (no apiKey)', async () => {
    getSecureApiKeyMock.mockReturnValue(null);
    await pushPickupOrderBestEffort(baseInput);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws on a non-ok backend response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(pushPickupOrderBestEffort(baseInput)).resolves.toBeUndefined();
  });

  it('never throws when fetch rejects (offline / aborted)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(pushPickupOrderBestEffort(baseInput)).resolves.toBeUndefined();
  });

  it('queues a failed push to the outbox and never throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(pushPickupOrderBestEffort(baseInput)).resolves.toBeUndefined();
    expect(storeSetMock).toHaveBeenCalledTimes(1);
    expect(storeSetMock).toHaveBeenCalledWith('pendingPickupPushes', [baseInput]);
  });

  it('does not queue when the terminal is unpaired', async () => {
    getSecureApiKeyMock.mockReturnValue(null);
    await pushPickupOrderBestEffort(baseInput);
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('does not queue on a 2xx response', async () => {
    await pushPickupOrderBestEffort(baseInput);
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('drains queued pushes on reconnect, keeping ones that still fail', async () => {
    const a = { ...baseInput, sourceOrderId: 'kso-a' };
    const b = { ...baseInput, sourceOrderId: 'kso-b' };
    storeGetMock.mockReturnValue([a, b]);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error('still offline'));
    await drainPickupPushOutbox();
    expect(storeSetMock).toHaveBeenCalledTimes(1);
    expect(storeSetMock).toHaveBeenCalledWith('pendingPickupPushes', [b]);
  });

  it('drain is a no-op when the outbox is empty', async () => {
    storeGetMock.mockReturnValue([]);
    await drainPickupPushOutbox();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeSetMock).not.toHaveBeenCalled();
  });

  it('POSTs async kitchen print status updates to the backend', async () => {
    await updatePickupKitchenPrintStatusBestEffort({
      sourceOrderId: 'kso-1',
      orderNumber: 'K-001',
      status: 'PRINTED',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/v1/print-agent/pickup-orders/kitchen-print-status');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.apiKey).toBe('pa_test');
    expect(body.sourceOrderId).toBe('kso-1');
    expect(body.orderNumber).toBe('K-001');
    expect(body.status).toBe('PRINTED');
  });

  it('queues kitchen print status when the pickup row is not visible yet', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await updatePickupKitchenPrintStatusBestEffort({
      sourceOrderId: 'kso-1',
      orderNumber: 'K-001',
      status: 'FAILED',
      error: 'no_kitchen_printer',
    });

    expect(storeSetMock).toHaveBeenCalledWith('pendingPickupKitchenPrintStatuses', [{
      sourceOrderId: 'kso-1',
      orderNumber: 'K-001',
      status: 'FAILED',
      error: 'no_kitchen_printer',
    }]);
  });

  it('drains queued kitchen print statuses on reconnect', async () => {
    const a = { sourceOrderId: 'kso-a', orderNumber: 'K-001', status: 'PRINTED' as const };
    const b = { sourceOrderId: 'kso-b', orderNumber: 'K-002', status: 'FAILED' as const, error: 'offline' };
    storeGetMock.mockReturnValue([a, b]);
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error('still offline'));

    await drainPickupKitchenPrintStatusOutbox();

    expect(storeSetMock).toHaveBeenCalledWith('pendingPickupKitchenPrintStatuses', [b]);
  });

  it('drains queued pickup pushes before queued kitchen print statuses', async () => {
    const push = { ...baseInput, sourceOrderId: 'kso-a' };
    const status = { sourceOrderId: 'kso-a', orderNumber: 'K-001', status: 'PRINTED' as const };
    storeGetMock.mockImplementation((key: string) => {
      if (key === 'pendingPickupPushes') return [push];
      if (key === 'pendingPickupKitchenPrintStatuses') return [status];
      return [];
    });

    await drainPickupOutboxesInOrder();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/api/v1/print-agent/pickup-orders');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/api/v1/print-agent/pickup-orders/kitchen-print-status');
  });

  it('updates a pending pickup push with the terminal kitchen status before retrying', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const pendingPush = { ...baseInput, kitchenPrintStatus: 'PENDING' as const };
    storeGetMock.mockImplementation((key: string) => {
      if (key === 'pendingPickupPushes') return [pendingPush];
      if (key === 'pendingPickupKitchenPrintStatuses') return [];
      return [];
    });

    await updatePickupKitchenPrintStatusBestEffort({
      sourceOrderId: 'kso-1',
      orderNumber: 'K-001',
      status: 'FAILED',
      error: 'no_kitchen_printer',
    });

    expect(storeSetMock).toHaveBeenCalledWith('pendingPickupPushes', [{
      ...pendingPush,
      kitchenPrintStatus: 'FAILED',
    }]);
  });
});
