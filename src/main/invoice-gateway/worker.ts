import { database } from '../database/database';
import {
  invoiceHandoffRepo,
  type InvoiceHandoffRepository,
  type InvoiceHandoffRow,
} from '../database/repos/invoice-handoff-repo';
import {
  INVOICE_GATEWAY_CONTRACT_VERSION,
  INVOICE_GATEWAY_DOCUMENT_INTENT,
  type GetDocumentStatusResult,
  type InvoiceGatewayCapabilities,
  type SyncPosOrderResult,
} from './contract';
import {
  InvoiceGatewayBridgeError,
  type InvoiceGatewayMutationInput,
  type ZiraInvoiceBridgeClientLike,
} from './client';

export interface InvoiceGatewayScope {
  salonId: string;
  tenantGeneration: number;
  /** Owner-selected channel, pinned for the whole activation lifetime. */
  channelId: string;
  /** False once logout/salon-switch invalidates this worker instance. */
  active?: boolean;
}

export interface InvoiceHandoffEligibility {
  getOrder(
    orderId: string,
    backendOrderId?: string | null,
  ): { status: string; created_at: string } | null;
  hasConfirmedFiscalReceipt(orderId: string): boolean;
  hasRefundEvidence?(orderId: string, backendOrderId?: string | null): boolean;
}

export interface InvoiceHandoffWorkerRepository extends Pick<
  InvoiceHandoffRepository,
  | 'getByOrderId'
  | 'listDue'
  | 'listDueDispatching'
  | 'listCompletedCorrections'
  | 'markWaitingEligibility'
  | 'markPending'
  | 'markDispatching'
  | 'markAmbiguous'
  | 'markRetryPending'
  | 'markCompleted'
  | 'markNotApplicable'
  | 'markNeedsReview'
  | 'markCompletedNeedsReview'
> {}

export interface InvoiceHandoffWorkerDeps {
  getScope: () => InvoiceGatewayScope;
  client: ZiraInvoiceBridgeClientLike;
  eligibility?: InvoiceHandoffEligibility;
  repo?: InvoiceHandoffWorkerRepository;
  flush: () => Promise<{ success: boolean; error?: string } | void>;
  now?: () => Date;
  retryDelayMs?: (attempts: number) => number;
  eligibilityPollMs?: number;
  onError?: (error: unknown, row: InvoiceHandoffRow) => void;
}

const databaseEligibility: InvoiceHandoffEligibility = {
  getOrder(orderId, backendOrderId) {
    const local = database.get<{ status: string; created_at: string }>(
      'SELECT status, created_at FROM orders WHERE id = ?',
      [orderId],
    );
    if (local) return local;

    const backendId = String(backendOrderId || '').trim();
    if (!backendId) return null;
    return database.get<{ status: string; created_at: string }>(
      `SELECT status, created_at FROM orders
       WHERE id = ? OR backend_id = ?
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
      [backendId, backendId, backendId],
    );
  },
  hasConfirmedFiscalReceipt(orderId) {
    return !!database.get<{ id: string }>(
      `SELECT id FROM fiscal_attempts
       WHERE order_id = ? AND status = 'SUCCESS_CONFIRMED' LIMIT 1`,
      [orderId],
    );
  },
  hasRefundEvidence(orderId, backendOrderId) {
    const local = database.get<{ event_id: string }>(
      `SELECT event_id FROM pos_event_outbox
       WHERE local_order_id = ? AND event_type = 'RefundIssued' LIMIT 1`,
      [orderId],
    );
    if (local) return true;

    const backendId = String(backendOrderId || '').trim();
    if (!backendId) return false;
    return !!database.get<{ event_id: string }>(
      `SELECT event_id FROM pos_event_outbox
       WHERE local_order_id = ? AND event_type = 'RefundIssued' LIMIT 1`,
      [backendId],
    );
  },
};

class DeterministicHandoffError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'DeterministicHandoffError';
  }
}

class ScopeChangedError extends Error {
  readonly code = 'INVOICE_HANDOFF_SCOPE_CHANGED';
}

type SourceDisposition =
  | { kind: 'ELIGIBLE' }
  | { kind: 'WAITING' }
  | { kind: 'NEEDS_REVIEW'; code: string; message: string };

type BatchOutcome = 'CONTINUE' | 'BRIDGE_UNAVAILABLE';

interface ReconciliationOutcome {
  disposition: 'RESOLVED' | 'NOT_FOUND' | 'UNKNOWN';
  bridgeUnavailable: boolean;
}

function normalizedNip(value: unknown): string {
  return String(value || '').replace(/\D/g, '');
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code || '').trim();
    if (code) return code;
  }
  return 'INVOICE_HANDOFF_ERROR';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown invoice handoff error');
}

function isDeterministic(error: unknown): boolean {
  return error instanceof DeterministicHandoffError
    || (error instanceof InvoiceGatewayBridgeError && !error.retryable
      && ![
        'BRIDGE_PROTOCOL_ERROR',
        'RESPONSE_ID_MISMATCH',
      ].includes(error.code));
}

function isBridgeUnavailable(error: unknown): boolean {
  return error instanceof InvoiceGatewayBridgeError && error.retryable;
}

function assertSyncResult(value: SyncPosOrderResult): SyncPosOrderResult {
  if (
    !value
    || !['IMPORTED', 'ALREADY_IMPORTED'].includes(value.importResult)
    || !String(value.localOrderId || '').trim()
    || !String(value.orderState || '').trim()
    || !Object.prototype.hasOwnProperty.call(value, 'document')
  ) {
    throw new InvoiceGatewayBridgeError(
      'Zira Invoice returned an invalid sync result',
      'BRIDGE_PROTOCOL_ERROR',
      false,
    );
  }
  return value;
}

function assertStatusResult(value: GetDocumentStatusResult): GetDocumentStatusResult {
  if (!value || typeof value.found !== 'boolean' || !Object.prototype.hasOwnProperty.call(value, 'document')) {
    throw new InvoiceGatewayBridgeError(
      'Zira Invoice returned an invalid status result',
      'BRIDGE_PROTOCOL_ERROR',
      false,
    );
  }
  if (value.found && (
    !String(value.localOrderId || '').trim()
    || !String(value.orderState || '').trim()
  )) {
    throw new InvoiceGatewayBridgeError(
      'Zira Invoice found the order but omitted its local identity/state',
      'BRIDGE_PROTOCOL_ERROR',
      false,
    );
  }
  return value;
}

/**
 * Explicitly-woken shadow worker. This class owns no timer and starts no
 * socket by itself; runtime wiring can be reviewed separately from the safety
 * state machine.
 */
export class InvoiceHandoffWorker {
  private readonly repo: InvoiceHandoffWorkerRepository;
  private readonly eligibility: InvoiceHandoffEligibility;
  private readonly now: () => Date;
  private readonly retryDelayMs: (attempts: number) => number;
  private readonly eligibilityPollMs: number;
  private readonly ownerPinnedChannelId: string;
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly deps: InvoiceHandoffWorkerDeps) {
    this.ownerPinnedChannelId = String(deps.getScope().channelId || '').trim();
    if (!this.ownerPinnedChannelId) {
      throw new ScopeChangedError('Invoice handoff owner-pinned channel is missing');
    }
    this.repo = deps.repo ?? invoiceHandoffRepo;
    this.eligibility = deps.eligibility ?? databaseEligibility;
    this.now = deps.now ?? (() => new Date());
    this.retryDelayMs = deps.retryDelayMs
      ?? ((attempts) => Math.min(5 * 60_000, 1_000 * (2 ** Math.max(0, attempts - 1))));
    this.eligibilityPollMs = Math.max(1_000, deps.eligibilityPollMs ?? 60_000);
  }

  wake(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    const drain = this.drain();
    this.drainPromise = drain;
    drain.finally(() => {
      if (this.drainPromise === drain) this.drainPromise = null;
    }).catch(() => undefined);
    return drain;
  }

  /**
   * A sale can be refunded/cancelled after its original import completed.
   * Contract v1 deliberately cannot manufacture a fiscal correction, so make
   * that divergence durable and visible instead of silently leaving Zira
   * Invoice with an apparently-current sale.
   */
  async auditCompletedCorrections(): Promise<void> {
    const scope = this.deps.getScope();
    const rows = this.repo.listCompletedCorrections(
      scope.salonId,
      scope.tenantGeneration,
    );
    for (const row of rows) {
      try {
        this.assertScope(row);
        const disposition = this.inspectSource(row);
        if (disposition.kind !== 'NEEDS_REVIEW') continue;
        this.repo.markCompletedNeedsReview(
          row.order_id,
          disposition.code,
          disposition.message,
          this.nowIso(),
        );
        await this.flushRequired();
      } catch (error) {
        this.deps.onError?.(error, row);
      }
    }
  }

  /**
   * Reconcile crash-ambiguous mutations without opening a new mutation path.
   * A later ordinary drain may retry authoritative NOT_FOUND rows, but this
   * recovery lane itself only performs capabilities and status requests.
   */
  async recoverDispatchingOnly(): Promise<void> {
    const scope = this.deps.getScope();
    if (
      scope.active === false
      || !scope.salonId
      || String(scope.channelId || '').trim() !== this.ownerPinnedChannelId
    ) {
      throw new ScopeChangedError('Invoice handoff recovery scope is not active');
    }
    const rows = this.repo.listDueDispatching(
      scope.salonId,
      scope.tenantGeneration,
      this.nowIso(),
    );
    let bridgeUnavailable = false;
    for (const initial of rows) {
      const row = this.repo.getByOrderId(initial.order_id) ?? initial;
      if (row.status !== 'DISPATCHING') continue;
      try {
        if (bridgeUnavailable) {
          await this.processRowWithoutBridge(row);
          continue;
        }
        const outcome = await this.recoverDispatchingRow(row);
        if (outcome === 'BRIDGE_UNAVAILABLE') bridgeUnavailable = true;
      } catch (error) {
        this.deps.onError?.(error, row);
      }
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private nextAttemptAt(attempts: number): string {
    return new Date(this.now().getTime() + this.retryDelayMs(Math.max(1, attempts))).toISOString();
  }

  private eligibilityPollAt(): string {
    return new Date(this.now().getTime() + this.eligibilityPollMs).toISOString();
  }

  private async flushRequired(): Promise<void> {
    const result = await this.deps.flush();
    if (result && result.success === false) {
      const error = new Error(`invoice-handoff-flush-failed: ${result.error || 'unknown'}`) as Error & {
        code?: string;
      };
      error.code = 'LOCAL_DURABILITY_FAILED';
      throw error;
    }
  }

  private assertScope(row: InvoiceHandoffRow): void {
    const current = this.deps.getScope();
    if (
      current.active === false
      || !current.salonId
      || current.salonId !== row.salon_id
      || current.tenantGeneration !== Number(row.tenant_generation)
      || String(current.channelId || '').trim() !== this.ownerPinnedChannelId
    ) {
      throw new ScopeChangedError('Invoice handoff tenant or channel changed while work was in flight');
    }
  }

  private async drain(): Promise<void> {
    const scope = this.deps.getScope();
    if (
      scope.active === false
      || !scope.salonId
      || String(scope.channelId || '').trim() !== this.ownerPinnedChannelId
    ) {
      throw new ScopeChangedError('Invoice handoff session is not active');
    }
    const rows = this.repo.listDue(
      scope.salonId,
      scope.tenantGeneration,
      this.nowIso(),
    );
    let bridgeUnavailable = false;
    for (const row of rows) {
      try {
        if (bridgeUnavailable) {
          await this.processRowWithoutBridge(row);
          continue;
        }
        const outcome = await this.processRow(row);
        if (outcome === 'BRIDGE_UNAVAILABLE') bridgeUnavailable = true;
      } catch (error) {
        this.deps.onError?.(error, row);
      }
    }
  }

  /**
   * A bridge circuit-break must stop network fan-out, not local safety work.
   * Continue inspecting the already-selected due rows so a refund,
   * cancellation, or missing source cannot remain queued as an ordinary sale.
   */
  private async processRowWithoutBridge(initial: InvoiceHandoffRow): Promise<void> {
    const row = this.repo.getByOrderId(initial.order_id) ?? initial;
    this.assertScope(row);
    if (!['WAITING_ELIGIBILITY', 'PENDING', 'DISPATCHING'].includes(row.status)) return;

    const disposition = this.inspectSource(row);
    if (disposition.kind === 'NEEDS_REVIEW') {
      await this.needsReview(row, disposition.code, disposition.message);
      return;
    }

    // DISPATCHING may already have mutated the remote application. Without a
    // status response it must retain its durable ambiguity evidence.
    if (row.status === 'DISPATCHING') return;

    if (disposition.kind === 'WAITING') {
      this.repo.markWaitingEligibility(row.order_id, this.eligibilityPollAt(), this.nowIso());
      await this.flushRequired();
      return;
    }

    if (row.status === 'WAITING_ELIGIBILITY') {
      this.repo.markPending(row.order_id, null, this.nowIso());
      await this.flushRequired();
    }
  }

  private async processRow(initial: InvoiceHandoffRow): Promise<BatchOutcome> {
    let row = this.repo.getByOrderId(initial.order_id) ?? initial;
    this.assertScope(row);

    if (row.status === 'WAITING_ELIGIBILITY') {
      const eligible = await this.prepareEligibility(row);
      if (!eligible) return 'CONTINUE';
      row = this.repo.getByOrderId(row.order_id)!;
    }

    const companyNip = normalizedNip(row.company_nip);
    if (companyNip.length !== 10) {
      await this.needsReview(row, 'SELLER_NIP_INVALID', 'Seller NIP must contain exactly 10 digits');
      return 'CONTINUE';
    }

    let capabilities: InvoiceGatewayCapabilities;
    try {
      this.assertScope(row);
      capabilities = await this.deps.client.capabilities(this.deps.client.newRequestId());
      this.assertScope(row);
    } catch (error) {
      this.assertScope(row);
      await this.handleBeforeMutationError(row, error);
      return isBridgeUnavailable(error) ? 'BRIDGE_UNAVAILABLE' : 'CONTINUE';
    }

    let channelId: string;
    try {
      channelId = this.resolveChannel(row, capabilities, companyNip);
    } catch (error) {
      if (isDeterministic(error)) {
        await this.needsReview(row, errorCode(error), errorMessage(error));
      } else {
        await this.handleBeforeMutationError(row, error);
      }
      return isBridgeUnavailable(error) ? 'BRIDGE_UNAVAILABLE' : 'CONTINUE';
    }
    const mutation: InvoiceGatewayMutationInput = {
      idempotencyKey: row.idempotency_key,
      channelId,
      posOrderId: row.order_id,
      companyNip,
    };

    if (row.status === 'DISPATCHING') {
      const reconciliation = await this.reconcileAmbiguous(row, mutation);
      if (reconciliation.bridgeUnavailable) return 'BRIDGE_UNAVAILABLE';
      if (reconciliation.disposition !== 'NOT_FOUND') return 'CONTINUE';
      row = this.repo.getByOrderId(row.order_id)!;
    }

    // Eligibility is mutable POS state. Re-read it after all non-mutating
    // capability work and immediately before a new sync attempt. In particular,
    // a refund/cancellation that lands after WAITING -> PENDING must never let
    // contract v1 import the now-uncorrected original sale.
    if (row.status === 'PENDING' && !(await this.applySourceEligibility(row, false))) {
      return 'CONTINUE';
    }

    if (row.status === 'PENDING' && row.channel_id !== channelId) {
      this.repo.markPending(row.order_id, channelId, this.nowIso());
      await this.flushRequired();
      row = this.repo.getByOrderId(row.order_id)!;
    }

    return this.dispatch(row, mutation);
  }

  private async recoverDispatchingRow(row: InvoiceHandoffRow): Promise<BatchOutcome> {
    this.assertScope(row);
    const companyNip = normalizedNip(row.company_nip);
    if (companyNip.length !== 10) {
      await this.needsReview(row, 'SELLER_NIP_INVALID', 'Seller NIP must contain exactly 10 digits');
      return 'CONTINUE';
    }

    let capabilities: InvoiceGatewayCapabilities;
    try {
      capabilities = await this.deps.client.capabilities(this.deps.client.newRequestId());
      this.assertScope(row);
    } catch (error) {
      this.assertScope(row);
      await this.handleBeforeMutationError(row, error);
      return isBridgeUnavailable(error) ? 'BRIDGE_UNAVAILABLE' : 'CONTINUE';
    }

    let channelId: string;
    try {
      channelId = this.resolveChannel(row, capabilities, companyNip);
    } catch (error) {
      if (isDeterministic(error)) {
        await this.needsReview(row, errorCode(error), errorMessage(error));
      } else {
        await this.handleBeforeMutationError(row, error);
      }
      return isBridgeUnavailable(error) ? 'BRIDGE_UNAVAILABLE' : 'CONTINUE';
    }

    const mutation: InvoiceGatewayMutationInput = {
      idempotencyKey: row.idempotency_key,
      channelId,
      posOrderId: row.order_id,
      companyNip,
    };
    let result: GetDocumentStatusResult;
    try {
      this.assertScope(row);
      result = assertStatusResult(await this.deps.client.getDocumentStatus(
        mutation,
        this.deps.client.newRequestId(),
      ));
      this.assertScope(row);
    } catch (error) {
      this.assertScope(row);
      if (isDeterministic(error)) {
        await this.needsReview(row, errorCode(error), errorMessage(error));
        return 'CONTINUE';
      }
      const latest = this.repo.getByOrderId(row.order_id) ?? row;
      this.repo.markAmbiguous(
        row.order_id,
        errorCode(error),
        errorMessage(error),
        this.nextAttemptAt(latest.attempts),
        this.nowIso(),
      );
      await this.flushRequired();
      return isBridgeUnavailable(error) ? 'BRIDGE_UNAVAILABLE' : 'CONTINUE';
    }

    if (result.found) {
      this.repo.markCompleted(row.order_id, JSON.stringify(result), this.nowIso());
      await this.flushRequired();
      return 'CONTINUE';
    }
    this.repo.markRetryPending(
      row.order_id,
      'REMOTE_NOT_FOUND',
      'Zira Invoice confirmed the idempotency key was not imported',
      this.nowIso(),
      this.nowIso(),
    );
    await this.flushRequired();
    return 'CONTINUE';
  }

  private async prepareEligibility(row: InvoiceHandoffRow): Promise<boolean> {
    return this.applySourceEligibility(row, true);
  }

  private inspectSource(row: InvoiceHandoffRow): SourceDisposition {
    const order = this.eligibility.getOrder(row.order_id, row.backend_order_id);
    if (!order) {
      return {
        kind: 'NEEDS_REVIEW',
        code: 'SOURCE_ORDER_MISSING',
        message: 'The source POS order is missing',
      };
    }
    const orderStatus = String(order.status || '').trim().toUpperCase();
    if (this.eligibility.hasRefundEvidence?.(row.order_id, row.backend_order_id)) {
      return {
        kind: 'NEEDS_REVIEW',
        code: 'REFUND_CORRECTION_REQUIRED',
        message: 'POS has immutable refund evidence; correction handoff is not supported in contract v1',
      };
    }
    if (['CANCELLED', 'VOIDED'].includes(orderStatus)) {
      return {
        kind: 'NEEDS_REVIEW',
        code: 'CANCELLATION_CORRECTION_REQUIRED',
        message: `Order is ${orderStatus} after fiscal confirmation; manual correction is required`,
      };
    }
    if (['REFUNDED', 'PARTIAL_REFUND'].includes(orderStatus)) {
      return {
        kind: 'NEEDS_REVIEW',
        code: 'REFUND_CORRECTION_REQUIRED',
        message: `Order is ${orderStatus}; POS refund correction handoff is not supported in contract v1`,
      };
    }
    if (orderStatus !== 'COMPLETED') {
      return { kind: 'WAITING' };
    }
    if (!this.eligibility.hasConfirmedFiscalReceipt(row.order_id)) {
      return { kind: 'WAITING' };
    }
    return { kind: 'ELIGIBLE' };
  }

  private async applySourceEligibility(
    row: InvoiceHandoffRow,
    promoteToPending: boolean,
  ): Promise<boolean> {
    const disposition = this.inspectSource(row);
    if (disposition.kind === 'NEEDS_REVIEW') {
      await this.needsReview(row, disposition.code, disposition.message);
      return false;
    }
    if (disposition.kind === 'WAITING') {
      this.repo.markWaitingEligibility(row.order_id, this.eligibilityPollAt(), this.nowIso());
      await this.flushRequired();
      return false;
    }
    if (promoteToPending) {
      this.repo.markPending(row.order_id, null, this.nowIso());
      await this.flushRequired();
    }
    return true;
  }

  private resolveChannel(
    row: InvoiceHandoffRow,
    capabilities: InvoiceGatewayCapabilities,
    companyNip: string,
  ): string {
    if (capabilities?.contractVersion !== INVOICE_GATEWAY_CONTRACT_VERSION) {
      throw new DeterministicHandoffError(
        'Zira Invoice contract version is incompatible',
        'CONTRACT_VERSION_MISMATCH',
      );
    }
    if (!capabilities.ready) {
      throw new InvoiceGatewayBridgeError(
        'Zira Invoice is not ready for POS imports',
        'ZIRA_INVOICE_NOT_READY',
        true,
      );
    }
    if (!Array.isArray(capabilities.supportedIntents)
      || !capabilities.supportedIntents.includes(INVOICE_GATEWAY_DOCUMENT_INTENT)) {
      throw new DeterministicHandoffError(
        'Zira Invoice does not support fiscalized retail imports',
        'DOCUMENT_INTENT_UNSUPPORTED',
      );
    }
    const remoteNip = normalizedNip(capabilities.companyNip);
    if (remoteNip.length !== 10 || remoteNip !== companyNip) {
      throw new DeterministicHandoffError(
        'POS seller NIP does not match the active Zira Invoice company',
        'COMPANY_NIP_MISMATCH',
      );
    }
    const enabled = Array.isArray(capabilities.channels)
      ? capabilities.channels.filter((channel) => channel?.enabled === true && String(channel.id || '').trim())
      : [];
    if (enabled.length !== 1) {
      throw new DeterministicHandoffError(
        `Expected exactly one enabled POS channel, found ${enabled.length}`,
        enabled.length === 0 ? 'POS_CHANNEL_MISSING' : 'POS_CHANNEL_AMBIGUOUS',
      );
    }
    const enabledChannelId = String(enabled[0].id).trim();
    if (
      enabledChannelId !== this.ownerPinnedChannelId
      || (row.channel_id && row.channel_id !== this.ownerPinnedChannelId)
    ) {
      throw new DeterministicHandoffError(
        'The enabled Zira Invoice POS channel differs from the owner-pinned channel',
        'POS_CHANNEL_BINDING_CHANGED',
      );
    }
    return this.ownerPinnedChannelId;
  }

  private async dispatch(
    row: InvoiceHandoffRow,
    mutation: InvoiceGatewayMutationInput,
  ): Promise<BatchOutcome> {
    this.assertScope(row);
    const requestId = this.deps.client.newRequestId();
    const dispatching = this.repo.markDispatching(
      row.order_id,
      mutation.channelId,
      requestId,
      this.nowIso(),
    );
    if (dispatching?.status !== 'DISPATCHING') return 'CONTINUE';

    // Hard boundary: never send sync_pos_order until DISPATCHING is on disk.
    try {
      await this.flushRequired();
    } catch (error) {
      // If the owner session was invalidated while durability was pending,
      // retain DISPATCHING. A future bound worker must reconcile it; writing a
      // retry transition under the stale scope could enable a duplicate sync.
      this.assertScope(dispatching);
      this.repo.markRetryPending(
        row.order_id,
        errorCode(error),
        errorMessage(error),
        this.nextAttemptAt(dispatching.attempts),
        this.nowIso(),
      );
      await this.flushRequired().catch(() => undefined);
      throw error;
    }

    try {
      // No await is allowed between this fence and opening the mutation
      // request. A logout/salon-switch invalidates the bound worker first.
      this.assertScope(dispatching);
      const result = assertSyncResult(
        await this.deps.client.syncPosOrder(mutation, requestId),
      );
      this.assertScope(dispatching);
      const correction = this.inspectSource(dispatching);
      if (correction.kind === 'NEEDS_REVIEW') {
        await this.needsReview(
          dispatching,
          correction.code,
          correction.message,
          JSON.stringify(result),
        );
        return 'CONTINUE';
      }
      this.repo.markCompleted(row.order_id, JSON.stringify(result), this.nowIso());
      await this.flushRequired();
      return 'CONTINUE';
    } catch (error) {
      this.assertScope(dispatching);
      if (isDeterministic(error)) {
        await this.needsReview(dispatching, errorCode(error), errorMessage(error));
        return 'CONTINUE';
      }
      const reconciliation = await this.reconcileAmbiguous(dispatching, mutation, error);
      return isBridgeUnavailable(error) || reconciliation.bridgeUnavailable
        ? 'BRIDGE_UNAVAILABLE'
        : 'CONTINUE';
    }
  }

  private async reconcileAmbiguous(
    row: InvoiceHandoffRow,
    mutation: InvoiceGatewayMutationInput,
    cause?: unknown,
  ): Promise<ReconciliationOutcome> {
    // A DISPATCHING row may already have mutated Zira Invoice, so reconcile it
    // even when the local order has since been refunded/cancelled. Preserve the
    // remote evidence, then route the unsupported correction to manual review.
    const reviewBeforeStatus = this.inspectSource(row);
    try {
      this.assertScope(row);
      const result = assertStatusResult(await this.deps.client.getDocumentStatus(
        mutation,
        this.deps.client.newRequestId(),
      ));
      this.assertScope(row);
      const reviewAfterStatus = this.inspectSource(row);
      const correction = reviewBeforeStatus.kind === 'NEEDS_REVIEW'
        ? reviewBeforeStatus
        : reviewAfterStatus.kind === 'NEEDS_REVIEW'
          ? reviewAfterStatus
          : null;
      if (correction) {
        await this.needsReview(
          row,
          correction.code,
          correction.message,
          JSON.stringify(result),
        );
        return {
          disposition: 'RESOLVED',
          bridgeUnavailable: isBridgeUnavailable(cause),
        };
      }
      if (result.found) {
        this.repo.markCompleted(row.order_id, JSON.stringify(result), this.nowIso());
        await this.flushRequired();
        return {
          disposition: 'RESOLVED',
          bridgeUnavailable: isBridgeUnavailable(cause),
        };
      }
      this.repo.markRetryPending(
        row.order_id,
        'REMOTE_NOT_FOUND',
        'Zira Invoice confirmed the idempotency key was not imported',
        this.nowIso(),
        this.nowIso(),
      );
      await this.flushRequired();
      return {
        disposition: 'NOT_FOUND',
        bridgeUnavailable: isBridgeUnavailable(cause),
      };
    } catch (statusError) {
      this.assertScope(row);
      if (isDeterministic(statusError)) {
        await this.needsReview(row, errorCode(statusError), errorMessage(statusError));
        return {
          disposition: 'RESOLVED',
          bridgeUnavailable: isBridgeUnavailable(cause),
        };
      }
      const latest = this.repo.getByOrderId(row.order_id) ?? row;
      const combined = cause
        ? `${errorMessage(cause)}; status reconciliation failed: ${errorMessage(statusError)}`
        : errorMessage(statusError);
      this.repo.markAmbiguous(
        row.order_id,
        errorCode(statusError),
        combined,
        this.nextAttemptAt(latest.attempts),
        this.nowIso(),
      );
      await this.flushRequired();
      return {
        disposition: 'UNKNOWN',
        bridgeUnavailable: isBridgeUnavailable(cause) || isBridgeUnavailable(statusError),
      };
    }
  }

  private async handleBeforeMutationError(
    row: InvoiceHandoffRow,
    error: unknown,
  ): Promise<void> {
    // Session invalidation is a control-flow fence, not a retryable bridge
    // failure. Do not write a post-logout transition; the next authenticated
    // worker will resume the already-durable row under a fresh scope.
    if (error instanceof ScopeChangedError) throw error;
    this.assertScope(row);
    if (row.status === 'DISPATCHING') {
      this.repo.markAmbiguous(
        row.order_id,
        errorCode(error),
        errorMessage(error),
        this.nextAttemptAt(row.attempts),
        this.nowIso(),
      );
    } else if (isDeterministic(error)) {
      this.repo.markNeedsReview(row.order_id, errorCode(error), errorMessage(error));
    } else {
      this.repo.markRetryPending(
        row.order_id,
        errorCode(error),
        errorMessage(error),
        this.nextAttemptAt(row.attempts),
        this.nowIso(),
      );
    }
    await this.flushRequired();
  }

  private async needsReview(
    row: InvoiceHandoffRow,
    code: string,
    message: string,
    responseJson: string | null = null,
  ): Promise<void> {
    this.assertScope(row);
    this.repo.markNeedsReview(row.order_id, code, message, responseJson, this.nowIso());
    await this.flushRequired();
  }
}

export { databaseEligibility as invoiceHandoffDatabaseEligibility };
