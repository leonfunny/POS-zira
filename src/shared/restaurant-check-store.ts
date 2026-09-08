import type { PosCheckoutSnapshot } from './billiard-pos-handoff';
import { validateRestaurantCheckScope, validateRestaurantCheckSnapshot, type RestaurantCheck, type RestaurantCheckScope, type RestaurantCheckStatus } from './restaurant-check';

/** Bind one instance per database. The platform adapter owns auth/role checks,
 * initialization/migrations and wiring confirmed payments; never expose this
 * directly to renderer input. flush must persist the latest transaction. */
export interface RestaurantCheckDatabase {
  run(sql: string, params?: any[]): void;
  get<T>(sql: string, params?: any[]): T | null;
  all<T>(sql: string, params?: any[]): T[];
  transaction<T>(fn: () => T): T;
  flush(): Promise<{ success: boolean; error?: string }>;
}

interface Row {
  id: string; salon_id: string; user_id: string; register_id: string;
  revision: number; status: RestaurantCheckStatus; table_id: string | null; covers: number;
  snapshot_json: string; order_id: string | null; payment_attempt_id: string | null;
  cancellation_reason: string | null; created_at: string; updated_at: string;
}

const scopeParams = (scope: RestaurantCheckScope) => [scope.salonId, scope.userId, scope.registerId];
const WHERE_SCOPE = 'salon_id = ? AND user_id = ? AND register_id = ?';
function adapt(row: Row): RestaurantCheck {
  const scope = { salonId: row.salon_id, userId: row.user_id, registerId: row.register_id };
  const snapshot = JSON.parse(row.snapshot_json) as PosCheckoutSnapshot;
  validateRestaurantCheckSnapshot(snapshot, scope, row.covers);
  if ((snapshot.state.activeTable ?? null) !== row.table_id) throw new Error('RESTAURANT_CORRUPT_CONTEXT');
  return { id: row.id, scope, revision: row.revision, status: row.status, tableId: row.table_id, covers: row.covers, snapshot,
    orderId: row.order_id, paymentAttemptId: row.payment_attempt_id, cancellationReason: row.cancellation_reason,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

/** An open check is never removed on recall. No retention/prune/delete API. */
export class RestaurantCheckStore {
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  constructor(private readonly db: RestaurantCheckDatabase) {}

  private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const operation = this.queue.then(() => {
      if (this.failed) throw new Error('RESTAURANT_STORAGE_RESTART_REQUIRED');
      return fn();
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async durable<T>(fn: () => T): Promise<T> {
    const result = this.db.transaction(fn);
    try {
      const flush = await this.db.flush();
      if (!flush.success) throw new Error(flush.error || 'Storage write failed');
    } catch (error) {
      // A failed/uncertain exporter must not make its in-memory mutation appear
      // committed to the next command. Reload from disk before any retry.
      this.failed = true;
      throw new Error(`RESTAURANT_STORAGE_RESTART_REQUIRED: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  }

  private read(scope: RestaurantCheckScope, id: string): RestaurantCheck | null {
    validateRestaurantCheckScope(scope);
    const row = this.db.get<Row>(`SELECT * FROM pos_restaurant_checks WHERE ${WHERE_SCOPE} AND id = ?`, [...scopeParams(scope), id]);
    return row ? adapt(row) : null;
  }

  get(scope: RestaurantCheckScope, id: string): Promise<RestaurantCheck | null> {
    const captured = { ...scope };
    return this.enqueue(() => this.read(captured, id));
  }

  listUnfinished(scope: RestaurantCheckScope): Promise<RestaurantCheck[]> {
    const captured = { ...scope };
    return this.enqueue(() => {
      validateRestaurantCheckScope(captured);
      return this.db.all<Row>(`SELECT * FROM pos_restaurant_checks WHERE ${WHERE_SCOPE}
        AND status NOT IN ('PAID','CANCELLED') ORDER BY updated_at DESC, id`, scopeParams(captured)).map(adapt);
    });
  }

  create(scope: RestaurantCheckScope, id: string, snapshot: PosCheckoutSnapshot, covers: number): Promise<RestaurantCheck> {
    const captured = { ...scope };
    const saved = JSON.parse(JSON.stringify(snapshot)) as PosCheckoutSnapshot;
    return this.enqueue(() => {
      validateRestaurantCheckSnapshot(saved, captured, covers);
      if (!id?.trim()) throw new Error('RESTAURANT_CHECK_ID_REQUIRED');
      return this.durable(() => {
        const now = new Date().toISOString();
        this.db.run(`INSERT INTO pos_restaurant_checks
          (id,salon_id,user_id,register_id,revision,status,table_id,covers,snapshot_json,created_at,updated_at)
          VALUES (?,?,?,?,1,'SAVED',?,?,?,?,?)`,
        [id, ...scopeParams(captured), saved.state.activeTable ?? null, covers, JSON.stringify(saved), now, now]);
        return this.read(captured, id)!;
      });
    });
  }

  private change(scope: RestaurantCheckScope, id: string, revision: number, allowed: RestaurantCheckStatus[],
    mutate: (check: RestaurantCheck) => void): Promise<RestaurantCheck> {
    const captured = { ...scope };
    return this.enqueue(() => this.durable(() => {
      const check = this.read(captured, id);
      if (!check) throw new Error('RESTAURANT_CHECK_NOT_FOUND');
      if (check.revision !== revision) throw new Error('RESTAURANT_CHECK_CONFLICT');
      if (!allowed.includes(check.status)) throw new Error('RESTAURANT_CHECK_LOCKED');
      mutate(check);
      validateRestaurantCheckSnapshot(check.snapshot, captured, check.covers);
      this.db.run(`UPDATE pos_restaurant_checks SET revision = revision + 1, status = ?, table_id = ?, covers = ?,
        snapshot_json = ?, order_id = ?, payment_attempt_id = ?, cancellation_reason = ?, updated_at = ?
        WHERE ${WHERE_SCOPE} AND id = ? AND revision = ?`,
      [check.status, check.tableId, check.covers, JSON.stringify(check.snapshot), check.orderId, check.paymentAttemptId,
        check.cancellationReason, new Date().toISOString(), ...scopeParams(captured), id, revision]);
      return this.read(captured, id)!;
    }));
  }

  open(scope: RestaurantCheckScope, id: string, revision: number): Promise<RestaurantCheck> {
    return this.change(scope, id, revision, ['SAVED', 'OPEN'], check => { check.status = 'OPEN'; });
  }

  save(scope: RestaurantCheckScope, id: string, revision: number, snapshot: PosCheckoutSnapshot, covers: number, park = false): Promise<RestaurantCheck> {
    const captured = JSON.parse(JSON.stringify(snapshot)) as PosCheckoutSnapshot;
    return this.change(scope, id, revision, ['OPEN'], check => {
      // Transferring an existing check to another table is a separate operation.
      if ((captured.state.activeTable ?? null) !== check.tableId
        || (captured.state.checkoutDraft?.restaurant?.orderType ?? 'dine_in') !== (check.snapshot.state.checkoutDraft?.restaurant?.orderType ?? 'dine_in')) {
        throw new Error('RESTAURANT_CONTEXT_CHANGE_REQUIRES_TRANSFER');
      }
      check.snapshot = captured;
      check.covers = covers;
      if (park) check.status = 'SAVED';
    });
  }

  beginPayment(scope: RestaurantCheckScope, id: string, revision: number, orderId: string, attemptId: string): Promise<RestaurantCheck> {
    return this.change(scope, id, revision, ['OPEN'], check => {
      if (!orderId?.trim() || !attemptId?.trim()) throw new Error('RESTAURANT_PAYMENT_ID_REQUIRED');
      check.status = 'PAYMENT_PENDING'; check.orderId = orderId; check.paymentAttemptId = attemptId;
    });
  }

  markPaymentUncertain(scope: RestaurantCheckScope, id: string, revision: number): Promise<RestaurantCheck> {
    return this.change(scope, id, revision, ['PAYMENT_PENDING'], check => { check.status = 'PAYMENT_UNCERTAIN'; });
  }

  /** Only the authoritative payment adapter may call this after verifying its
   * committed order. The renderer must never be allowed to forge confirmation. */
  confirmPaid(scope: RestaurantCheckScope, id: string, revision: number, orderId: string): Promise<RestaurantCheck> {
    return this.change(scope, id, revision, ['PAYMENT_PENDING', 'PAYMENT_UNCERTAIN'], check => {
      if (orderId !== check.orderId) throw new Error('RESTAURANT_PAYMENT_ID_MISMATCH');
      check.status = 'PAID';
    });
  }

  /** Caller must authorize cancellation; retain the snapshot and reason. */
  cancel(scope: RestaurantCheckScope, id: string, revision: number, reason: string): Promise<RestaurantCheck> {
    return this.change(scope, id, revision, ['SAVED', 'OPEN'], check => {
      if (!reason?.trim()) throw new Error('RESTAURANT_CANCEL_REASON_REQUIRED');
      check.status = 'CANCELLED'; check.cancellationReason = reason.trim();
    });
  }
}
