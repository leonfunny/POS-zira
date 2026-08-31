import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentConfig, ZiraInvoiceGatewayConfig } from '../../shared/types';
import { getConfig, getSecureAuthToken } from '../config/store';
import { BaseModule, ModuleState } from '../core/module';
import type { EventBus } from '../core/event-bus';
import { database } from '../database/database';
import {
  configureInvoiceHandoffContextProvider,
  fiscalAttemptRepo,
  normalizeValidPolishNip,
  type InvoiceHandoffRuntimeContext,
} from '../database/repos/fiscal-attempt-repo';
import { sellerSettingsRepo } from '../database/repos/seller-settings-repo';
import { invoiceHandoffRepo } from '../database/repos/invoice-handoff-repo';
import logger from '../logger';
import {
  InvoiceGatewayBridgeError,
  LocalInvoiceGatewayWebSocketTransport,
  ZiraInvoiceBridgeClient,
  type InvoiceGatewayTokenProvider,
} from './client';
import {
  INVOICE_GATEWAY_CONTRACT_VERSION,
  INVOICE_GATEWAY_DOCUMENT_INTENT,
  type InvoiceGatewayCapabilities,
} from './contract';
import {
  InvoiceHandoffWorker,
  type InvoiceGatewayScope,
} from './worker';

const HANDOFF_POLL_MS = 30_000;
const PREFLIGHT_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 2_000;
const MAX_TOKEN_BYTES = 512;

export interface InvoiceGatewayRuntimeWorker {
  wake(): Promise<void>;
  auditCompletedCorrections(): Promise<void>;
  recoverDispatchingOnly(): Promise<void>;
}

interface InvoiceGatewayBinding {
  salonId: string;
  tenantGeneration: number;
  companyNip: string;
  channelId: string;
  sessionEpoch: number;
}

type PreflightBinding = Omit<InvoiceGatewayBinding, 'sessionEpoch'>;

export interface InvoiceGatewayModuleDeps {
  getConfig: () => AgentConfig;
  isAuthenticated: () => boolean;
  getSellerNip: () => string | null;
  getTenantGeneration: () => number;
  isTenantGenerationReliable: () => boolean;
  flush: () => Promise<{ success: boolean; error?: string }>;
  backfill: () => number;
  auditLocalCorrections: (salonId: string, tenantGeneration: number) => number;
  configureContextProvider: (
    provider: (() => InvoiceHandoffRuntimeContext | null) | null,
  ) => void;
  tokenProvider: InvoiceGatewayTokenProvider;
  preflight: (binding: PreflightBinding) => Promise<void>;
  makeWorker: (
    tokenProvider: InvoiceGatewayTokenProvider,
    getScope: () => InvoiceGatewayScope,
  ) => InvoiceGatewayRuntimeWorker;
  setInterval: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
}

export function ziraInvoiceBridgeTokenPath(appDataDir: string): string {
  return join(appDataDir, 'com.zira.invoice', 'pos-bridge-token');
}

export function createZiraInvoiceBridgeTokenProvider(options: {
  appDataDir?: () => string;
  readText?: (path: string) => Promise<string>;
} = {}): InvoiceGatewayTokenProvider {
  const appDataDir = options.appDataDir ?? (() => app.getPath('appData'));
  const readText = options.readText ?? ((path) => readFile(path, 'utf8'));
  return async () => {
    let raw: string;
    try {
      raw = await readText(ziraInvoiceBridgeTokenPath(appDataDir()));
    } catch {
      throw new InvoiceGatewayBridgeError(
        'Zira Invoice bridge token is not available yet',
        'BRIDGE_TOKEN_UNAVAILABLE',
        true,
      );
    }
    const token = raw.trim();
    if (token.length < 32 || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
      throw new InvoiceGatewayBridgeError(
        'Zira Invoice bridge token is missing, truncated, or oversized',
        'BRIDGE_TOKEN_INVALID',
        false,
      );
    }
    return token;
  };
}

function bridgeError(message: string, code: string, retryable: boolean): never {
  throw new InvoiceGatewayBridgeError(message, code, retryable);
}

/** Validate every owner-pinned identity before a provider can create rows. */
export function assertInvoiceGatewayPreflight(
  capabilities: InvoiceGatewayCapabilities,
  binding: PreflightBinding,
): void {
  if (capabilities?.contractVersion !== INVOICE_GATEWAY_CONTRACT_VERSION) {
    bridgeError('Zira Invoice contract version is incompatible', 'CONTRACT_VERSION_MISMATCH', false);
  }
  if (!capabilities.ready) {
    bridgeError('Zira Invoice is not ready for POS imports', 'ZIRA_INVOICE_NOT_READY', true);
  }
  if (!Array.isArray(capabilities.supportedIntents)
    || !capabilities.supportedIntents.includes(INVOICE_GATEWAY_DOCUMENT_INTENT)) {
    bridgeError('Zira Invoice does not support fiscalized retail imports', 'DOCUMENT_INTENT_UNSUPPORTED', false);
  }
  const remoteNip = normalizeValidPolishNip(capabilities.companyNip);
  if (!remoteNip || remoteNip !== binding.companyNip) {
    bridgeError('Zira Invoice company NIP does not match the pinned POS company', 'COMPANY_NIP_MISMATCH', false);
  }
  const enabled = Array.isArray(capabilities.channels)
    ? capabilities.channels.filter((channel) => channel?.enabled === true && String(channel.id || '').trim())
    : [];
  if (enabled.length !== 1) {
    bridgeError(
      `Expected exactly one enabled POS channel, found ${enabled.length}`,
      enabled.length === 0 ? 'POS_CHANNEL_MISSING' : 'POS_CHANNEL_AMBIGUOUS',
      false,
    );
  }
  if (String(enabled[0].id).trim() !== binding.channelId) {
    bridgeError('Enabled Zira Invoice channel does not match the owner-pinned channel', 'POS_CHANNEL_BINDING_CHANGED', false);
  }
}

function gatewayConfig(config: AgentConfig): ZiraInvoiceGatewayConfig | null {
  return config.ziraInvoiceGateway?.enabled === true
    ? config.ziraInvoiceGateway
    : null;
}

function sameBinding(a: PreflightBinding, b: PreflightBinding): boolean {
  return a.salonId === b.salonId
    && a.tenantGeneration === b.tenantGeneration
    && a.companyNip === b.companyNip
    && a.channelId === b.channelId;
}

/**
 * Default-off runtime owner for the durable POS -> Zira Invoice handoff.
 * A valid owner pin installs only the durable local journal. Missing auth,
 * token, or remote capabilities keeps dispatch disabled while confirmed sales
 * continue to enqueue locally for later delivery. Invalid local salon/NIP/
 * generation identity remains fully fail-closed.
 */
export class InvoiceGatewayModule extends BaseModule {
  readonly name = 'invoice-gateway';

  private readonly deps: InvoiceGatewayModuleDeps;
  private worker: InvoiceGatewayRuntimeWorker | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cyclePromise: Promise<void> | null = null;
  private activeBinding: InvoiceGatewayBinding | null = null;
  private remoteReady = false;
  private recoveryBinding: InvoiceGatewayBinding | null = null;
  private recoveryWorker: InvoiceGatewayRuntimeWorker | null = null;
  private providerInstalled = false;
  private sessionEpoch = 0;
  private started = false;
  private sessionPaused = false;
  private lastUnavailableReason = '';
  private disabledLogged = false;

  constructor(overrides: Partial<InvoiceGatewayModuleDeps> = {}) {
    super();
    const baseDeps = {
      getConfig,
      isAuthenticated: () => !!getSecureAuthToken(),
      getSellerNip: () => sellerSettingsRepo.get()?.nip ?? null,
      getTenantGeneration: () => database.getTenantGeneration(),
      isTenantGenerationReliable: () => database.isTenantGenerationReliable(),
      flush: async () => {
        const result = await database.saveCoalesced();
        return result.success
          ? { success: true }
          : { success: false, error: result.error || 'Database durability flush failed' };
      },
      backfill: () => fiscalAttemptRepo.backfillInvoiceHandoffs(),
      auditLocalCorrections: (salonId: string, tenantGeneration: number) => (
        invoiceHandoffRepo.flagCompletedCorrections(salonId, tenantGeneration)
      ),
      configureContextProvider: configureInvoiceHandoffContextProvider,
      tokenProvider: createZiraInvoiceBridgeTokenProvider(),
      setInterval: (callback: () => void, delayMs: number) => setInterval(callback, delayMs),
      clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
    };
    const merged = { ...baseDeps, ...overrides };
    const preflight = overrides.preflight ?? (async (binding: PreflightBinding) => {
      const transport = new LocalInvoiceGatewayWebSocketTransport({
        tokenProvider: merged.tokenProvider,
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
      });
      const client = new ZiraInvoiceBridgeClient(transport);
      const capabilities = await client.capabilities(client.newRequestId());
      assertInvoiceGatewayPreflight(capabilities, binding);
    });
    const makeWorker = overrides.makeWorker ?? ((
      tokenProvider: InvoiceGatewayTokenProvider,
      getScope: () => InvoiceGatewayScope,
    ) => {
      const transport = new LocalInvoiceGatewayWebSocketTransport({ tokenProvider });
      const client = new ZiraInvoiceBridgeClient(transport);
      return new InvoiceHandoffWorker({
        getScope,
        client,
        flush: merged.flush,
        onError: (error, row) => {
          logger.warn(
            `[InvoiceGateway] handoff ${row.order_id} failed: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        },
      });
    });
    this.deps = { ...merged, preflight, makeWorker } as InvoiceGatewayModuleDeps;
  }

  async init(): Promise<void> {
    this.setState(ModuleState.READY);
  }

  registerEventHandlers(bus: EventBus): void {
    bus.on('user:logged-out', () => this.pauseSession('logout', false));
    bus.on('auth:expired', () => this.pauseSession('auth-expired', true));
    bus.on('salon:switching', () => this.pauseSession('salon-switching', false));
    bus.on('user:logged-in', () => {
      this.sessionPaused = false;
      this.clearRecovery();
      this.invalidateBinding('login');
      this.syncRuntimeGate();
    });
    bus.on('config:changed', ({ changedKeys }) => {
      if (changedKeys.includes('ziraInvoiceGateway')) this.syncRuntimeGate();
    });
  }

  async start(): Promise<void> {
    this.started = true;
    this.sessionPaused = false;
    this.setState(ModuleState.RUNNING);
    this.syncRuntimeGate();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.clearTimer();
    this.clearRecovery();
    this.invalidateBinding('module-stop');
    const cycle = this.cyclePromise;
    if (cycle) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      // Do not pretend an already-sent mutation can be cancelled safely: a
      // socket abort cannot prove whether the companion applied it. The worker
      // persisted DISPATCHING before opening that request, scope invalidation
      // blocks late local writes, and the next activation reconciles by the
      // stable idempotency key. Bound only the module shutdown wait itself.
      await Promise.race([
        cycle.catch(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> {
    await this.stop();
    this.setState(ModuleState.DESTROYED);
  }

  private syncRuntimeGate(): void {
    if (!this.started) return;
    if (!this.timer) {
      this.timer = this.deps.setInterval(() => this.kickCycle(), HANDOFF_POLL_MS);
    }
    this.kickCycle();
  }

  private kickCycle(): void {
    void this.runCycle().catch((error) => this.reportUnavailable(error));
  }

  private pauseSession(reason: string, recoverDispatching: boolean): void {
    const previous = this.activeBinding;
    this.sessionPaused = true;
    this.invalidateBinding(reason);
    if (recoverDispatching && previous) this.beginRecovery(previous);
    this.syncRuntimeGate();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.deps.clearInterval(this.timer);
    this.timer = null;
  }

  private invalidateBinding(_reason: string): void {
    this.sessionEpoch += 1;
    this.activeBinding = null;
    this.worker = null;
    this.remoteReady = false;
    if (this.providerInstalled) {
      this.deps.configureContextProvider(null);
      this.providerInstalled = false;
    }
  }

  private clearRecovery(): void {
    this.recoveryBinding = null;
    this.recoveryWorker = null;
  }

  private beginRecovery(binding: InvoiceGatewayBinding): void {
    this.clearRecovery();
    const frozen = { ...binding };
    const worker = this.deps.makeWorker(this.deps.tokenProvider, () => ({
      salonId: frozen.salonId,
      tenantGeneration: frozen.tenantGeneration,
      channelId: frozen.channelId,
      active: this.recoveryBinding === frozen,
    }));
    this.recoveryBinding = frozen;
    this.recoveryWorker = worker;
  }

  private resolveLocalBinding(): PreflightBinding | null {
    const config = this.deps.getConfig();
    const pin = gatewayConfig(config);
    if (!pin || !this.deps.isTenantGenerationReliable()) return null;

    const salonId = String(config.salonId || '').trim();
    const authSalonId = String(config.authUser?.salonId || '').trim();
    const pinnedSalonId = String(pin.salonId || '').trim();
    if (!salonId || salonId !== authSalonId || salonId !== pinnedSalonId) return null;

    const pinnedNip = normalizeValidPolishNip(pin.companyNip);
    const receiptNip = normalizeValidPolishNip(config.receiptSellerNip);
    const tenantSellerNip = normalizeValidPolishNip(this.deps.getSellerNip());
    if (!pinnedNip || pinnedNip !== receiptNip || pinnedNip !== tenantSellerNip) return null;

    const channelId = String(pin.channelId || '').trim();
    const tenantGeneration = this.deps.getTenantGeneration();
    if (!channelId || !Number.isSafeInteger(tenantGeneration) || tenantGeneration < 0) return null;

    return { salonId, tenantGeneration, companyNip: pinnedNip, channelId };
  }

  private isBindingActive(binding: InvoiceGatewayBinding): boolean {
    if (this.activeBinding !== binding || binding.sessionEpoch !== this.sessionEpoch) return false;
    const current = this.resolveLocalBinding();
    return current !== null && sameBinding(binding, current);
  }

  private runCycle(): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;
    const cycle = this.runCycleOnce();
    this.cyclePromise = cycle;
    cycle.finally(() => {
      if (this.cyclePromise === cycle) this.cyclePromise = null;
    }).catch(() => undefined);
    return cycle;
  }

  private async runCycleOnce(): Promise<void> {
    await this.auditLocalCorrections();
    if (this.recoveryWorker) {
      await this.recoveryWorker.recoverDispatchingOnly();
    }
    if (this.sessionPaused) return;

    const candidate = this.resolveLocalBinding();
    if (!candidate) {
      if (this.activeBinding || this.providerInstalled || this.worker) {
        this.invalidateBinding('binding-unavailable');
      }
      if (gatewayConfig(this.deps.getConfig()) === null && !this.disabledLogged) {
        logger.info('[InvoiceGateway] remote dispatch disabled (default)');
        this.disabledLogged = true;
      }
      return;
    }
    this.disabledLogged = false;

    if (this.activeBinding && !sameBinding(this.activeBinding, candidate)) {
      this.invalidateBinding('binding-changed');
    }
    if (!this.activeBinding) {
      this.activateLocal(candidate);
    }
    let binding = this.activeBinding;
    let worker = this.worker;
    if (!binding || !worker || !this.isBindingActive(binding)) return;

    // Each activation pass is deliberately bounded. Continue it on every
    // active poll so a journal with more than one page cannot strand the 101st
    // eligible sale until the app or tenant binding restarts.
    try {
      await this.continueBackfill();
    } catch (error) {
      if (this.activeBinding === binding) this.invalidateBinding('backfill-failed');
      throw error;
    }
    binding = this.activeBinding;
    worker = this.worker;
    if (!binding || !worker || !this.isBindingActive(binding)) return;

    // Local journaling and correction monitoring stay active while the
    // companion app is closed. Backend auth is required only before allowing
    // a new remote mutation lane.
    if (!this.deps.isAuthenticated()) {
      this.remoteReady = false;
      return;
    }
    if (!this.remoteReady) {
      const activationEpoch = binding.sessionEpoch;
      await this.deps.preflight({
        salonId: binding.salonId,
        tenantGeneration: binding.tenantGeneration,
        companyNip: binding.companyNip,
        channelId: binding.channelId,
      });
      if (
        activationEpoch !== this.sessionEpoch
        || !this.isBindingActive(binding)
        || !this.deps.isAuthenticated()
      ) return;
      this.remoteReady = true;
    }

    this.lastUnavailableReason = '';
    await worker.auditCompletedCorrections();
    await worker.wake();
  }

  private async auditLocalCorrections(): Promise<void> {
    if (!this.deps.isTenantGenerationReliable()) return;
    const salonId = String(this.deps.getConfig().salonId || '').trim();
    const tenantGeneration = this.deps.getTenantGeneration();
    if (!salonId || !Number.isSafeInteger(tenantGeneration) || tenantGeneration < 0) return;
    const flagged = this.deps.auditLocalCorrections(salonId, tenantGeneration);
    if (flagged <= 0) return;
    const persisted = await this.deps.flush();
    if (persisted.success === false) {
      throw new Error(`invoice-handoff-correction-flush-failed: ${persisted.error || 'unknown'}`);
    }
    logger.warn(`[InvoiceGateway] flagged ${flagged} completed sale correction(s) for manual review`);
  }

  private activateLocal(candidate: PreflightBinding): void {
    const activationEpoch = this.sessionEpoch;
    const binding: InvoiceGatewayBinding = {
      ...candidate,
      sessionEpoch: activationEpoch,
    };
    this.activeBinding = binding;
    try {
      this.worker = this.deps.makeWorker(this.deps.tokenProvider, () => ({
        salonId: binding.salonId,
        tenantGeneration: binding.tenantGeneration,
        channelId: binding.channelId,
        active: this.isBindingActive(binding),
      }));
      this.deps.configureContextProvider(() => this.isBindingActive(binding)
        ? { salonId: binding.salonId, companyNip: binding.companyNip }
        : null);
      this.providerInstalled = true;
      if (!this.isBindingActive(binding)) this.invalidateBinding('activation-superseded');
    } catch (error) {
      this.invalidateBinding('activation-failed');
      throw error;
    }
  }

  private async continueBackfill(): Promise<void> {
    const ensured = this.deps.backfill();
    // Backfill also advances a durable keyset cursor when every candidate is
    // skipped, so always cross the disk barrier rather than keying durability
    // only to the number of newly-created handoffs.
    const persisted = await this.deps.flush();
    if (persisted.success === false) {
      throw new Error(`invoice-handoff-backfill-flush-failed: ${persisted.error || 'unknown'}`);
    }
    if (ensured > 0) {
      logger.info(`[InvoiceGateway] ensured ${ensured} confirmed fiscal handoff(s)`);
    }
  }

  private reportUnavailable(error: unknown): void {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
    const message = error instanceof Error ? error.message : String(error);
    const reason = `${code}:${message}`;
    if (reason === this.lastUnavailableReason) return;
    this.lastUnavailableReason = reason;
    logger.warn(`[InvoiceGateway] runtime unavailable: ${message}`);
  }
}
