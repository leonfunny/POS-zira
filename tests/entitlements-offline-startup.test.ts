import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, DEFAULT_ENTITLEMENTS, type SalonEntitlements } from '../src/shared/types';

const { handlers, configState } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  configState: {
    token: 'access-token',
    config: {} as any,
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
  },
  BrowserWindow: class {},
}));

vi.mock('../src/main/config/store', () => ({
  getConfig: vi.fn(() => configState.config),
  getSecureAuthToken: vi.fn(() => configState.token),
  setConfig: vi.fn((partial: Record<string, unknown>) => {
    configState.config = { ...configState.config, ...partial };
    return configState.config;
  }),
}));

import { registerEntitlementsHandlers } from '../src/main/entitlements/entitlements-controller';

function makeEntitlements(overrides: Partial<SalonEntitlements> = {}): SalonEntitlements {
  const features: SalonEntitlements['features'] = {} as any;
  for (const [featureKey, enabled] of Object.entries(DEFAULT_ENTITLEMENTS)) {
    features[featureKey as keyof typeof DEFAULT_ENTITLEMENTS] = {
      featureKey: featureKey as keyof typeof DEFAULT_ENTITLEMENTS,
      enabled,
    } as any;
  }
  return {
    salonId: 'salon-1',
    salonCode: '',
    salonName: 'Chesaigon',
    plan: 'free',
    suggestedPosMode: null,
    features,
    fetchedAt: '2026-06-01T00:00:00.000Z',
    validUntil: '2026-06-01T01:00:00.000Z',
    ...overrides,
  };
}

describe('entitlements startup while backend is down', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers.clear();
    configState.token = 'access-token';
    configState.config = {
      serverUrl: 'https://api.test',
      salonId: 'salon-1',
      salonName: 'Chesaigon',
      authUser: { salonId: 'salon-1', salonName: 'Chesaigon' },
    };
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns stale cached entitlements immediately and refreshes backend in the background', async () => {
    const stale = makeEntitlements();
    configState.config.entitlements = stale;
    const fresh = makeEntitlements({
      fetchedAt: '2026-06-09T10:00:00.000Z',
      validUntil: '2026-06-09T11:00:00.000Z',
    });
    vi.mocked(fetch).mockImplementationOnce(
      () => new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(
          JSON.stringify({ success: true, data: fresh }),
          { status: 200 },
        )), 1000);
      }),
    );

    registerEntitlementsHandlers(null);
    const getEntitlements = handlers.get(IPC_CHANNELS.ENTITLEMENTS_GET)!;
    const result = await getEntitlements();

    expect(result).toBe(stale);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);

    expect(configState.config.entitlements.validUntil).not.toBe(stale.validUntil);
    expect(configState.config.entitlements.salonId).toBe('salon-1');
  });

  it('does not replace stale cached entitlements with permissive defaults when background refresh fails', async () => {
    const stale = makeEntitlements({
      features: {
        ...makeEntitlements().features,
        pos: { featureKey: 'pos', enabled: false } as any,
      },
    });
    configState.config.entitlements = stale;
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));

    registerEntitlementsHandlers(null);
    const getEntitlements = handlers.get(IPC_CHANNELS.ENTITLEMENTS_GET)!;
    const result = await getEntitlements();
    await Promise.resolve();

    expect(result).toBe(stale);
    expect(configState.config.entitlements).toBe(stale);
    expect(configState.config.entitlements.features.pos.enabled).toBe(false);
  });

  it('returns permissive defaults immediately when there is no cache and backend fetch hangs', async () => {
    vi.mocked(fetch).mockImplementationOnce((_url: any, init: any) => (
      new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })
    ));

    registerEntitlementsHandlers(null);
    const getEntitlements = handlers.get(IPC_CHANNELS.ENTITLEMENTS_GET)!;
    const result = await getEntitlements();

    expect(result.salonId).toBe('salon-1');
    expect(result.features.pos.enabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
  });
});
