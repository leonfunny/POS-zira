import {
  receiptPrintOutboxRepo,
  receiptPrintPayloadHash,
  type ReceiptPrintOutboxFailureClass,
  type ReceiptPrintOutboxRoute,
  type ReceiptPrintOutboxRow,
} from '../database/repos/receipt-print-outbox-repo';

export interface ReceiptPrintOutboxScope {
  salonId: string;
  deviceId: string;
  shiftId: string | null;
}

export type ReceiptPrintDispatchResult =
  | {
      kind: 'COMPLETED';
      route: ReceiptPrintOutboxRoute;
      printerId?: string | null;
      remoteJobId?: string | null;
    }
  | {
      kind: 'REMOTE_ACCEPTED';
      route: 'SHARED_NETWORK';
      printerId: string;
      remoteJobId: string;
      nextPollAt?: string;
      error?: string | null;
    }
  | {
      kind: 'FAILED_SAFE';
      error: string;
      route?: ReceiptPrintOutboxRoute | null;
      printerId?: string | null;
      nextAttemptAt?: string;
    }
  | {
      kind: 'NEEDS_REVIEW';
      error: string;
      failureClass?: ReceiptPrintOutboxFailureClass;
      route?: ReceiptPrintOutboxRoute | null;
      printerId?: string | null;
      remoteJobId?: string | null;
    };

export interface ReceiptPrintOutboxFlushResult {
  success: boolean;
  error?: string;
}

export interface ReceiptPrintOutboxRepository {
  getByJobId(jobId: string): ReceiptPrintOutboxRow | null;
  getHead(salonId: string, deviceId: string): ReceiptPrintOutboxRow | null;
  markDispatching(jobId: string, updatedAt?: string): ReceiptPrintOutboxRow | null;
  markRemoteAccepted(
    jobId: string,
    input: {
      printerId: string;
      remoteJobId: string;
      nextAttemptAt: string;
      error?: string | null;
      updatedAt?: string;
    },
  ): ReceiptPrintOutboxRow | null;
  markCompleted(
    jobId: string,
    input: {
      route: ReceiptPrintOutboxRoute;
      printerId?: string | null;
      remoteJobId?: string | null;
      completedAt?: string;
    },
  ): ReceiptPrintOutboxRow | null;
  markFailedSafe(
    jobId: string,
    input: {
      error: string;
      nextAttemptAt: string;
      route?: ReceiptPrintOutboxRoute | null;
      printerId?: string | null;
      updatedAt?: string;
    },
  ): ReceiptPrintOutboxRow | null;
  markNeedsReview(
    jobId: string,
    input: {
      error: string;
      failureClass?: ReceiptPrintOutboxFailureClass;
      route?: ReceiptPrintOutboxRoute | null;
      printerId?: string | null;
      remoteJobId?: string | null;
      updatedAt?: string;
    },
  ): ReceiptPrintOutboxRow | null;
  recoverInterruptedDispatches(
    salonId: string,
    deviceId: string,
    updatedAt?: string,
  ): number;
}

export interface ReceiptPrintOutboxDeps {
  getScope: () => ReceiptPrintOutboxScope;
  flush: () => Promise<ReceiptPrintOutboxFlushResult | void>;
  dispatch: (
    row: ReceiptPrintOutboxRow,
    payload: Record<string, unknown>,
  ) => Promise<ReceiptPrintDispatchResult>;
  repo?: ReceiptPrintOutboxRepository;
  now?: () => Date;
  staleAfterMs?: number;
  retryDelayMs?: (attempts: number) => number;
}

export class ReceiptPrintSafeBeforePrintError extends Error {
  readonly failureClass = 'SAFE_BEFORE_PRINT' as const;

  constructor(
    message: string,
    readonly route?: ReceiptPrintOutboxRoute | null,
    readonly printerId?: string | null,
  ) {
    super(message);
    this.name = 'ReceiptPrintSafeBeforePrintError';
  }
}

function cleanScope(scope: ReceiptPrintOutboxScope): ReceiptPrintOutboxScope {
  const salonId = String(scope?.salonId || '').trim();
  const deviceId = String(scope?.deviceId || '').trim();
  const shiftId = String(scope?.shiftId || '').trim() || null;
  if (!salonId || !deviceId) {
    throw new Error('receipt-print-outbox-scope-incomplete');
  }
  return { salonId, deviceId, shiftId };
}

function parseTimestamp(value: string): number {
  const raw = String(value || '').trim();
  if (!raw) return Number.NaN;
  const hasOffset = /(?:Z|[+-]\d\d:\d\d)$/i.test(raw);
  const normalized = hasOffset ? raw : `${raw.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error || 'unknown receipt print error');
}

function isSafeBeforePrintError(
  error: unknown,
): error is ReceiptPrintSafeBeforePrintError | (Error & {
  failureClass: 'SAFE_BEFORE_PRINT';
  route?: ReceiptPrintOutboxRoute | null;
  printerId?: string | null;
}) {
  return !!error
    && typeof error === 'object'
    && (error as { failureClass?: string }).failureClass === 'SAFE_BEFORE_PRINT';
}

export class ReceiptPrintOutbox {
  private readonly repo: ReceiptPrintOutboxRepository;
  private readonly now: () => Date;
  private readonly staleAfterMs: number;
  private readonly retryDelayMs: (attempts: number) => number;
  private drainPromise: Promise<void> | null = null;
  private recoveredScopeKey: string | null = null;

  constructor(private readonly deps: ReceiptPrintOutboxDeps) {
    this.repo = deps.repo ?? receiptPrintOutboxRepo;
    this.now = deps.now ?? (() => new Date());
    this.staleAfterMs = Math.max(1_000, deps.staleAfterMs ?? 5 * 60_000);
    this.retryDelayMs = deps.retryDelayMs
      ?? ((attempts) => Math.min(30_000, 1_000 * (2 ** Math.max(0, attempts - 1))));
  }

  /**
   * Coalesce concurrent wakes into one FIFO drain. A second caller joins the
   * current promise rather than starting another physical print.
   */
  wake(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    const drain = this.drain();
    this.drainPromise = drain;
    drain.finally(() => {
      if (this.drainPromise === drain) this.drainPromise = null;
    }).catch(() => undefined);
    return drain;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private async flushRequired(): Promise<void> {
    const result = await this.deps.flush();
    if (result && result.success === false) {
      throw new Error(`receipt-print-outbox-flush-failed: ${result.error || 'unknown error'}`);
    }
  }

  private nextAttemptAt(row: ReceiptPrintOutboxRow): string {
    return new Date(
      this.now().getTime() + Math.max(250, this.retryDelayMs(Math.max(1, row.attempts))),
    ).toISOString();
  }

  private rowNeedsReviewBeforeDispatch(
    row: ReceiptPrintOutboxRow,
    scope: ReceiptPrintOutboxScope,
  ): string | null {
    if ((row.shift_id || null) !== scope.shiftId) {
      return 'Receipt belongs to a different or closed shift; review it manually without opening the drawer';
    }
    const createdAt = parseTimestamp(row.created_at);
    if (!Number.isFinite(createdAt)) {
      return 'Receipt queue timestamp is invalid; review it manually';
    }
    if (this.now().getTime() - createdAt > this.staleAfterMs) {
      return 'Receipt is too old for automatic printing; review it manually without opening the drawer';
    }
    return null;
  }

  private remoteRowNeedsReviewBeforeReconcile(
    row: ReceiptPrintOutboxRow,
  ): string | null {
    if (
      row.route !== 'SHARED_NETWORK'
      || !String(row.printer_id || '').trim()
      || !String(row.remote_job_id || '').trim()
    ) {
      return 'Accepted shared receipt is missing its fixed printer/job identity';
    }

    const dispatchedAt = parseTimestamp(row.dispatched_at || row.created_at);
    if (!Number.isFinite(dispatchedAt)) {
      return 'Accepted shared receipt has an invalid dispatch timestamp';
    }
    if (this.now().getTime() - dispatchedAt > this.staleAfterMs) {
      return 'Shared receipt stayed unresolved beyond the automatic reconciliation window; check the stored job and paper manually';
    }
    return null;
  }

  private payloadFor(row: ReceiptPrintOutboxRow): Record<string, unknown> {
    if (receiptPrintPayloadHash(row.payload_json) !== row.payload_hash) {
      throw new Error('Stored receipt payload hash does not match');
    }
    const payload = JSON.parse(row.payload_json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Stored receipt payload is invalid');
    }
    return payload as Record<string, unknown>;
  }

  private async recoverOnce(scope: ReceiptPrintOutboxScope): Promise<void> {
    const scopeKey = `${scope.salonId}\u0000${scope.deviceId}`;
    if (this.recoveredScopeKey === scopeKey) return;
    const recovered = this.repo.recoverInterruptedDispatches(
      scope.salonId,
      scope.deviceId,
      this.nowIso(),
    );
    if (recovered > 0) await this.flushRequired();
    this.recoveredScopeKey = scopeKey;
  }

  private async drain(): Promise<void> {
    const scope = cleanScope(this.deps.getScope());
    await this.recoverOnce(scope);

    for (;;) {
      const row = this.repo.getHead(scope.salonId, scope.deviceId);
      if (!row) return;

      if (row.status === 'REMOTE_ACCEPTED') {
        const reviewReason = this.remoteRowNeedsReviewBeforeReconcile(row);
        if (reviewReason) {
          this.repo.markNeedsReview(row.job_id, {
            error: reviewReason,
            failureClass: 'UNCERTAIN_AFTER_PRINT',
            route: 'SHARED_NETWORK',
            printerId: row.printer_id,
            remoteJobId: row.remote_job_id,
            updatedAt: this.nowIso(),
          });
          await this.flushRequired();
          continue;
        }
      } else {
        const reviewReason = this.rowNeedsReviewBeforeDispatch(row, scope);
        if (reviewReason) {
          this.repo.markNeedsReview(row.job_id, {
            error: reviewReason,
            failureClass: 'SAFE_BEFORE_PRINT',
            updatedAt: this.nowIso(),
          });
          await this.flushRequired();
          continue;
        }
      }

      const nowMs = this.now().getTime();
      const dueAt = row.next_attempt_at ? parseTimestamp(row.next_attempt_at) : Number.NaN;
      if (Number.isFinite(dueAt) && dueAt > nowMs) {
        // Strict FIFO: never skip a sleeping head and print a newer receipt.
        // The bounded stale/manual-review checks above still run first so a
        // malformed or far-future poll time cannot block the queue forever.
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = this.payloadFor(row);
      } catch (error) {
        this.repo.markNeedsReview(row.job_id, {
          error: errorMessage(error),
          failureClass: 'SAFE_BEFORE_PRINT',
          updatedAt: this.nowIso(),
        });
        await this.flushRequired();
        continue;
      }

      let dispatchRow = row;
      if (row.status !== 'REMOTE_ACCEPTED') {
        dispatchRow = this.repo.markDispatching(row.job_id, this.nowIso()) ?? row;
        if (dispatchRow.status !== 'DISPATCHING') return;

        // Hard safety boundary: DISPATCHING must reach disk before any local
        // WritePrinter call or remote HTTP request can happen.
        try {
          await this.flushRequired();
        } catch (error) {
          this.repo.markFailedSafe(row.job_id, {
            error: errorMessage(error),
            nextAttemptAt: this.nextAttemptAt(dispatchRow),
            updatedAt: this.nowIso(),
          });
          // Best effort only. If this also fails, the last durable state was
          // PENDING, which is still safe to retry because dispatch never ran.
          await this.flushRequired().catch(() => undefined);
          throw error;
        }
      }

      let result: ReceiptPrintDispatchResult;
      try {
        result = await this.deps.dispatch(dispatchRow, payload);
      } catch (error) {
        if (dispatchRow.status === 'REMOTE_ACCEPTED') {
          if (dispatchRow.printer_id && dispatchRow.remote_job_id) {
            this.repo.markRemoteAccepted(dispatchRow.job_id, {
              printerId: dispatchRow.printer_id,
              remoteJobId: dispatchRow.remote_job_id,
              nextAttemptAt: this.nextAttemptAt(dispatchRow),
              error: errorMessage(error),
              updatedAt: this.nowIso(),
            });
          } else {
            this.repo.markNeedsReview(dispatchRow.job_id, {
              error: `Remote print was accepted but its identity is incomplete: ${errorMessage(error)}`,
              failureClass: 'UNCERTAIN_AFTER_PRINT',
              updatedAt: this.nowIso(),
            });
          }
        } else if (isSafeBeforePrintError(error)) {
          this.repo.markFailedSafe(dispatchRow.job_id, {
            error: errorMessage(error),
            nextAttemptAt: this.nextAttemptAt(dispatchRow),
            route: error.route,
            printerId: error.printerId,
            updatedAt: this.nowIso(),
          });
        } else {
          this.repo.markNeedsReview(dispatchRow.job_id, {
            error: errorMessage(error),
            failureClass: 'UNCERTAIN_AFTER_PRINT',
            updatedAt: this.nowIso(),
          });
        }
        await this.flushRequired();
        continue;
      }

      if (
        dispatchRow.status === 'REMOTE_ACCEPTED'
        && (result.kind === 'COMPLETED' || result.kind === 'REMOTE_ACCEPTED')
        && (
          result.route !== 'SHARED_NETWORK'
          || !dispatchRow.printer_id
          || !dispatchRow.remote_job_id
          || result.printerId !== dispatchRow.printer_id
          || result.remoteJobId !== dispatchRow.remote_job_id
        )
      ) {
        this.repo.markNeedsReview(dispatchRow.job_id, {
          error: 'Remote receipt reconciliation returned a different printer/job identity',
          failureClass: 'UNCERTAIN_AFTER_PRINT',
          route: 'SHARED_NETWORK',
          printerId: dispatchRow.printer_id,
          remoteJobId: dispatchRow.remote_job_id,
          updatedAt: this.nowIso(),
        });
        await this.flushRequired();
        continue;
      }

      if (result.kind === 'COMPLETED') {
        this.repo.markCompleted(dispatchRow.job_id, {
          route: result.route,
          printerId: result.printerId,
          remoteJobId: result.remoteJobId,
          completedAt: this.nowIso(),
        });
      } else if (result.kind === 'REMOTE_ACCEPTED') {
        this.repo.markRemoteAccepted(dispatchRow.job_id, {
          printerId: result.printerId,
          remoteJobId: result.remoteJobId,
          nextAttemptAt: result.nextPollAt || this.nextAttemptAt(dispatchRow),
          error: result.error,
          updatedAt: this.nowIso(),
        });
      } else if (result.kind === 'FAILED_SAFE') {
        this.repo.markFailedSafe(dispatchRow.job_id, {
          error: result.error,
          nextAttemptAt: result.nextAttemptAt || this.nextAttemptAt(dispatchRow),
          route: result.route,
          printerId: result.printerId,
          updatedAt: this.nowIso(),
        });
      } else {
        this.repo.markNeedsReview(dispatchRow.job_id, {
          error: result.error,
          failureClass: result.failureClass ?? 'UNCERTAIN_AFTER_PRINT',
          route: dispatchRow.status === 'REMOTE_ACCEPTED'
            ? 'SHARED_NETWORK'
            : result.route,
          printerId: dispatchRow.status === 'REMOTE_ACCEPTED'
            ? dispatchRow.printer_id
            : result.printerId,
          remoteJobId: dispatchRow.status === 'REMOTE_ACCEPTED'
            ? dispatchRow.remote_job_id
            : result.remoteJobId,
          updatedAt: this.nowIso(),
        });
      }
      await this.flushRequired();

      if (result.kind === 'REMOTE_ACCEPTED' || result.kind === 'FAILED_SAFE') {
        // This row remains the queue head. Stop until its poll/retry time so a
        // newer receipt can never overtake it.
        return;
      }
    }
  }
}
