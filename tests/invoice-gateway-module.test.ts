import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { AgentConfig } from '../src/shared/types';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\Users\\test\\AppData\\Roaming') },
}));
vi.mock('../src/main/config/store', () => ({
  getConfig: vi.fn(),
  getSecureAuthToken: vi.fn(() => null),
}));
vi.mock('../src/main/database/database', () => ({
  database: {
    getTenantGeneration: vi.fn(() => 0),
    isTenantGenerationReliable: vi.fn(() => true),
    saveCoalesced: vi.fn(async () => ({ success: true })),
  },
}));
vi.mock('../src/main/database/repos/fiscal-attempt-repo', () => ({
  configureInvoiceHandoffContextProvider: vi.fn(),
  fiscalAttemptRepo: { backfillInvoiceHandoffs: vi.fn(() => 0) },
  normalizeValidPolishNip(value: unknown) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length === 10 ? digits : null;
  },
}));
vi.mock('../src/main/database/repos/seller-settings-repo', () => ({
  sellerSettingsRepo: { get: vi.fn(() => null) },
}));
vi.mock('../src/main/database/repos/invoice-handoff-repo', () => ({
  invoiceHandoffRepo: { flagCompletedCorrections: vi.fn(() => 0) },
}));
vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { EventBus } from '../src/main/core/event-bus';
import {
  InvoiceGatewayModule,
  assertInvoiceGatewayPreflight,
  createZiraInvoiceBridgeTokenProvider,
  ziraInvoiceBridgeTokenPath,
  type InvoiceGatewayModuleDeps,
} from '../src/main/invoice-gateway/module';
import { InvoiceGatewayBridgeError } from '../src/main/invoice-gateway/client';
import type { InvoiceGatewayScope } from '../src/main/invoice-gateway/worker';

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'Zira',
    printerProtocol: 'THERMAL',
    printerBaudRate: 9600,
    serverUrl: 'https://api.enail.pro',
    isPaired: true,
    autoStart: true,
    ziraInvoiceGateway: {
      enabled: false,
      salonId: '',
      companyNip: '',
      channelId: '',
    },
    ...overrides,
  } as AgentConfig;
}

function enabledConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return config({
    salonId: 'salon-1',
    authUser: { id: 'user-1', salonId: 'salon-1' } as AgentConfig['authUser'],
    receiptSellerNip: '522-005-23-49',
    ziraInvoiceGateway: {
      enabled: true,
      salonId: 'salon-1',
      companyNip: '5220052349',
      channelId: 'channel-1',
    },
    ...overrides,
  });
}

function runtime(overrides: Partial<InvoiceGatewayModuleDeps> = {}) {
  const worker = {
    auditCompletedCorrections: vi.fn(async () => undefined),
    recoverDispatchingOnly: vi.fn(async () => undefined),
    wake: vi.fn(async () => undefined),
  };
  const recoveryWorker = {
    auditCompletedCorrections: vi.fn(async () => undefined),
    recoverDispatchingOnly: vi.fn(async () => undefined),
    wake: vi.fn(async () => undefined),
  };
  const scopeProviders: Array<() => InvoiceGatewayScope> = [];
  const configureContextProvider = vi.fn();
  const clearTimer = vi.fn();
  const setTimer = vi.fn(() => ({}) as ReturnType<typeof setInterval>);
  const preflight = vi.fn(async () => undefined);
  const makeWorker = vi.fn((_tokenProvider, getScope: () => InvoiceGatewayScope) => {
    scopeProviders.push(getScope);
    return scopeProviders.length === 1 ? worker : recoveryWorker;
  });
  const deps: InvoiceGatewayModuleDeps = {
    getConfig: () => config(),
    isAuthenticated: () => true,
    getSellerNip: () => '5220052349',
    getTenantGeneration: () => 7,
    isTenantGenerationReliable: () => true,
    flush: vi.fn(async () => ({ success: true })),
    backfill: vi.fn(() => 0),
    auditLocalCorrections: vi.fn(() => 0),
    configureContextProvider,
    tokenProvider: vi.fn(async () => 'a'.repeat(32)),
    preflight,
    makeWorker,
    setInterval: setTimer,
    clearInterval: clearTimer,
    ...overrides,
  };
  return {
    module: new InvoiceGatewayModule(deps),
    deps,
    worker,
    recoveryWorker,
    configureContextProvider,
    setTimer,
    clearTimer,
    preflight: deps.preflight,
    getScope: (index = 0) => scopeProviders[index]?.() ?? null,
  };
}

describe('Zira Invoice gateway runtime', () => {
  beforeEach(() => vi.clearAllMocks());

  it('derives the Tauri token path and never needs the token in POS config', async () => {
    const readText = vi.fn(async () => `  ${'t'.repeat(32)}\r\n`);
    const tokenPath = join('/roaming', 'com.zira.invoice', 'pos-bridge-token');
    const provider = createZiraInvoiceBridgeTokenProvider({
      appDataDir: () => '/roaming',
      readText,
    });

    await expect(provider()).resolves.toBe('t'.repeat(32));
    expect(ziraInvoiceBridgeTokenPath('/roaming')).toBe(tokenPath);
    expect(readText).toHaveBeenCalledWith(tokenPath);
  });

  it('treats a not-yet-created token file as retryable without opening a socket', async () => {
    const provider = createZiraInvoiceBridgeTokenProvider({
      appDataDir: () => '/roaming',
      readText: vi.fn(async () => { throw new Error('ENOENT'); }),
    });

    await expect(provider()).rejects.toEqual(
      expect.objectContaining<Partial<InvoiceGatewayBridgeError>>({
        code: 'BRIDGE_TOKEN_UNAVAILABLE',
        retryable: true,
      }),
    );
  });

  it('validates the pinned NIP and channel during capabilities preflight', () => {
    expect(() => assertInvoiceGatewayPreflight({
      contractVersion: 1,
      ready: true,
      companyNip: '5220052349',
      supportedIntents: ['FISCALISED_RETAIL'],
      channels: [{ id: 'different-channel', name: 'POS', enabled: true }],
    }, {
      salonId: 'salon-1',
      tenantGeneration: 7,
      companyNip: '5220052349',
      channelId: 'channel-1',
    })).toThrowError(expect.objectContaining({ code: 'POS_CHANNEL_BINDING_CHANGED' }));
  });

  it('keeps only the local correction monitor alive when the owner-bound feature gate is off', async () => {
    const harness = runtime();

    await harness.module.init();
    await harness.module.start();

    expect(harness.deps.makeWorker).not.toHaveBeenCalled();
    expect(harness.deps.preflight).not.toHaveBeenCalled();
    expect(harness.deps.backfill).not.toHaveBeenCalled();
    expect(harness.configureContextProvider).not.toHaveBeenCalled();
    expect(harness.setTimer).toHaveBeenCalledWith(expect.any(Function), 30_000);
  });

  it('does not start when auth, salon binding, or tenant seller identity is absent', async () => {
    const harness = runtime({
      getConfig: () => enabledConfig({ salonId: 'wrong-salon' }),
      getSellerNip: () => null,
    });

    await harness.module.start();

    expect(harness.setTimer).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(harness.deps.preflight).not.toHaveBeenCalled();
    expect(harness.configureContextProvider).not.toHaveBeenCalled();
  });

  it('audits completed corrections locally even when remote dispatch is disabled', async () => {
    const auditLocalCorrections = vi.fn(() => 1);
    const harness = runtime({
      getConfig: () => config({ salonId: 'salon-1' }),
      auditLocalCorrections,
    });

    await harness.module.start();
    await vi.waitFor(() => expect(harness.deps.flush).toHaveBeenCalledOnce());

    expect(auditLocalCorrections).toHaveBeenCalledWith('salon-1', 7);
    expect(harness.deps.preflight).not.toHaveBeenCalled();
    expect(harness.deps.makeWorker).not.toHaveBeenCalled();
  });

  it('fails closed when tenant generation evidence is invalid or mixed', async () => {
    const harness = runtime({
      getConfig: () => enabledConfig(),
      isTenantGenerationReliable: () => false,
    });

    await harness.module.start();

    expect(harness.deps.makeWorker).not.toHaveBeenCalled();
    expect(harness.deps.preflight).not.toHaveBeenCalled();
    expect(harness.configureContextProvider).not.toHaveBeenCalled();
  });

  it('journals locally before remote preflight so bridge downtime cannot lose a sale', async () => {
    let releasePreflight!: () => void;
    const preflight = vi.fn(() => new Promise<void>((resolve) => {
      releasePreflight = resolve;
    }));
    const harness = runtime({
      getConfig: () => enabledConfig(),
      preflight,
    });

    await harness.module.start();
    await vi.waitFor(() => expect(preflight).toHaveBeenCalledOnce());
    expect(harness.deps.makeWorker).toHaveBeenCalledOnce();
    expect(harness.deps.backfill).toHaveBeenCalledOnce();
    expect(harness.configureContextProvider).toHaveBeenCalledOnce();
    expect(harness.worker.wake).not.toHaveBeenCalled();

    releasePreflight();
    await vi.waitFor(() => expect(harness.worker.wake).toHaveBeenCalledOnce());
  });

  it('wires bounded backfill and worker only after every binding check passes', async () => {
    const harness = runtime({
      getConfig: () => enabledConfig(),
      backfill: vi.fn(() => 3),
    });

    await harness.module.start();
    await vi.waitFor(() => expect(harness.worker.wake).toHaveBeenCalledOnce());

    expect(harness.deps.preflight).toHaveBeenCalledWith({
      salonId: 'salon-1',
      tenantGeneration: 7,
      companyNip: '5220052349',
      channelId: 'channel-1',
    });
    expect(harness.deps.makeWorker).toHaveBeenCalledOnce();
    expect(harness.deps.backfill).toHaveBeenCalledOnce();
    expect(harness.deps.flush).toHaveBeenCalledOnce();
    expect(harness.worker.auditCompletedCorrections).toHaveBeenCalledOnce();
    expect(harness.setTimer).toHaveBeenCalledWith(expect.any(Function), 30_000);
    const provider = harness.configureContextProvider.mock.calls[0][0];
    expect(provider()).toEqual({ salonId: 'salon-1', companyNip: '5220052349' });
    expect(harness.getScope()).toMatchObject({ active: true, channelId: 'channel-1' });

    await harness.module.stop();
    expect(harness.clearTimer).toHaveBeenCalledOnce();
    expect(harness.configureContextProvider).toHaveBeenLastCalledWith(null);
  });

  it('continues bounded backfill on active poll cycles instead of stranding later pages', async () => {
    const backfill = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(1);
    const harness = runtime({
      getConfig: () => enabledConfig(),
      backfill,
    });

    await harness.module.start();
    await vi.waitFor(() => expect(harness.worker.wake).toHaveBeenCalledOnce());
    expect(backfill).toHaveBeenCalledOnce();

    const poll = harness.setTimer.mock.calls[0][0];
    poll();

    await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(2));
    expect(harness.deps.flush).toHaveBeenCalledTimes(2);
    expect(harness.preflight).toHaveBeenCalledOnce();
    expect(harness.worker.wake).toHaveBeenCalledTimes(2);
  });

  it('keeps the durable provider connected but never dispatches when remote preflight fails', async () => {
    const preflight = vi.fn(async () => {
      throw new InvoiceGatewayBridgeError('not running', 'BRIDGE_CONNECTION_ERROR', true);
    });
    const harness = runtime({
      getConfig: () => enabledConfig(),
      preflight,
    });

    await harness.module.start();
    await vi.waitFor(() => expect(preflight).toHaveBeenCalledOnce());

    expect(harness.deps.makeWorker).toHaveBeenCalledOnce();
    expect(harness.deps.backfill).toHaveBeenCalledOnce();
    expect(harness.configureContextProvider).toHaveBeenCalledOnce();
    expect(harness.worker.wake).not.toHaveBeenCalled();
  });

  it('invalidates the worker synchronously on logout, auth expiry, or salon switch', async () => {
    const harness = runtime({ getConfig: () => enabledConfig() });
    const bus = new EventBus();
    harness.module.registerEventHandlers(bus);
    await harness.module.start();
    await vi.waitFor(() => expect(harness.worker.wake).toHaveBeenCalledOnce());
    expect(harness.getScope()).toMatchObject({ active: true });

    bus.emit('auth:expired', {});

    expect(harness.getScope(0)).toMatchObject({ active: false });
    await vi.waitFor(() => expect(harness.recoveryWorker.recoverDispatchingOnly).toHaveBeenCalled());
    expect(harness.recoveryWorker.wake).not.toHaveBeenCalled();
    expect(harness.clearTimer).not.toHaveBeenCalled();
    expect(harness.configureContextProvider).toHaveBeenLastCalledWith(null);
  });

  it('bounds module stop even when a bridge request never settles', async () => {
    const preflight = vi.fn(() => new Promise<void>(() => undefined));
    const harness = runtime({
      getConfig: () => enabledConfig(),
      preflight,
    });

    await harness.module.start();
    await vi.waitFor(() => expect(preflight).toHaveBeenCalledOnce());
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      callback();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      await expect(harness.module.stop()).resolves.toBeUndefined();
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_000);
      expect(harness.configureContextProvider).toHaveBeenLastCalledWith(null);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('fails closed and unwires the provider when backfill cannot cross the disk barrier', async () => {
    const harness = runtime({
      getConfig: () => enabledConfig(),
      backfill: vi.fn(() => 1),
      flush: vi.fn(async () => ({ success: false, error: 'disk busy' })),
    });

    await harness.module.start();
    await vi.waitFor(() => expect(harness.configureContextProvider).toHaveBeenLastCalledWith(null));

    expect(harness.worker.wake).not.toHaveBeenCalled();
    expect(harness.configureContextProvider).toHaveBeenCalledTimes(2);
    expect(harness.getScope()).toMatchObject({ active: false });
  });
});
