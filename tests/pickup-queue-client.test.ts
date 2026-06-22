/**
 * pushPickupOrderBestEffort — the kiosk → backend pickup-queue push.
 *
 * Contract: it is best-effort and fire-and-forget. It must build the right
 * request, and — most importantly — it must NEVER throw, so a queue/backend
 * problem can never break the kiosk submit/print/QR path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { getConfigMock, getSecureApiKeyMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  getSecureApiKeyMock: vi.fn(),
}));
vi.mock('../src/main/config/store', () => ({
  getConfig: getConfigMock,
  getSecureApiKey: getSecureApiKeyMock,
}));

import { pushPickupOrderBestEffort } from '../src/main/kitchen-self-order/pickup-queue-client';

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
});
