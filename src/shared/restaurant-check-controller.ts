import type { RestaurantCheck, RestaurantCheckScope } from './restaurant-check';
import { RestaurantCheckStore } from './restaurant-check-store';
import type { PosCheckoutSnapshot } from './billiard-pos-handoff';

/** Runtime-owned state only; the store validates every persisted snapshot. */
export interface RestaurantControllerState {
  cart: { items: unknown[]; total: number };
  checkoutDraft: { billiard?: unknown; restoredInterruption?: unknown; restaurant?: unknown };
  activeTable?: string | null;
  activeCustomer?: unknown;
  tip?: number;
  session: unknown;
}
export interface RestaurantControllerAction { type: string; payload?: any }
type PosState = RestaurantControllerState;
type PosAction = RestaurantControllerAction;
function capturePosCheckoutSnapshot(state: PosState, scope: RestaurantCheckScope, posMode: string): PosCheckoutSnapshot {
  return { schemaVersion: 1, state: JSON.parse(JSON.stringify(state)), scope: { ...scope }, posMode, capturedAt: new Date().toISOString() };
}

export interface RestaurantCheckAccess {
  scope: RestaurantCheckScope;
  isCurrent(): boolean;
}
export interface RestaurantControllerDependencies {
  store: RestaurantCheckStore;
  captureAccess(): RestaurantCheckAccess;
  getState(): PosState;
  dispatch(action: PosAction): void;
  getCovers(tableId: string | null): number;
  newId(): string;
  isOrderCommitted(orderId: string): boolean;
}

function checkoutKey(state: PosState): string {
  return JSON.stringify([state.cart, state.checkoutDraft, state.activeTable, state.activeCustomer, state.tip, state.session]);
}

/** Runtime owner of a recalled check. No renderer-provided snapshot/scope.
 * One instance per POS/database; a failed durable save requires restart.
 * Payment integration is deliberately a separate main-only boundary. */
export class RestaurantCheckController {
  private active: RestaurantCheck | null = null;
  private running = false;
  private failed = false;
  constructor(private readonly deps: RestaurantControllerDependencies) {}

  get hasActive(): boolean { return this.active !== null; }
  get busy(): boolean { return this.running; }
  get blocked(): boolean { return this.failed; }
  get activeId(): string | null { return this.active?.id ?? null; }

  resetForAuthBoundary(): void { this.active = null; }

  private assertCurrent(access: RestaurantCheckAccess): void {
    if (!access.isCurrent()) throw new Error('Restaurant POS user changed. Sign in again to recover the saved check.');
  }

  private assertActiveScope(access: RestaurantCheckAccess): void {
    if (this.active && (this.active.scope.salonId !== access.scope.salonId
      || this.active.scope.userId !== access.scope.userId || this.active.scope.registerId !== access.scope.registerId)) {
      throw new Error('Restaurant check belongs to another POS account.');
    }
  }

  private async run<T>(operation: (access: RestaurantCheckAccess) => Promise<T>): Promise<T> {
    if (this.failed) throw new Error('Restaurant storage needs a restart. Do not retry payment.');
    if (this.running) throw new Error('Wait for the restaurant check to finish saving.');
    const access = this.deps.captureAccess();
    this.assertCurrent(access); this.assertActiveScope(access);
    this.running = true;
    try { return await operation(access); }
    catch (error) {
      if (String(error).includes('RESTAURANT_STORAGE_RESTART_REQUIRED')) this.failed = true;
      throw error;
    } finally { this.running = false; }
  }

  list(): Promise<{ checks: RestaurantCheck[]; activeId: string | null }> {
    return this.run(async access => {
      const checks = await this.deps.store.listUnfinished(access.scope);
      this.assertCurrent(access);
      return { checks, activeId: this.activeId };
    });
  }

  saveCurrent(): Promise<{ id: string }> {
    return this.run(async access => {
      const before = this.deps.getState();
      if (this.active && this.active.status !== 'OPEN') throw new Error('Restaurant payment is locked. Do not charge again.');
      const snapshot = capturePosCheckoutSnapshot(before, access.scope, 'restaurant');
      const covers = this.active?.covers ?? this.deps.getCovers(before.activeTable ?? null);
      const saved = this.active
        ? await this.deps.store.save(access.scope, this.active.id, this.active.revision, snapshot, covers, true)
        : await this.deps.store.create(access.scope, this.deps.newId(), snapshot, covers);
      this.assertCurrent(access);
      // The live state cannot be changed by another runtime command while the
      // disk barrier is pending. Never clear a cart changed by an outside owner.
      if (checkoutKey(this.deps.getState()) !== checkoutKey(before)) {
        this.failed = true;
        throw new Error('Restaurant cart changed during save. Restart and recover the saved check.');
      }
      this.active = null;
      this.deps.dispatch({ type: 'cart/clear' });
      this.deps.dispatch({ type: 'table/setActive', payload: { tableId: null, orderType: 'dine_in' } });
      return { id: saved.id };
    });
  }

  open(id: string): Promise<RestaurantCheck> {
    return this.run(async access => {
      const before = this.deps.getState();
      if (this.active || before.cart.items.length || before.checkoutDraft.billiard || before.checkoutDraft.restoredInterruption) {
        throw new Error('Save the current cart before opening another restaurant check.');
      }
      const saved = await this.deps.store.get(access.scope, id);
      this.assertCurrent(access);
      if (!saved) throw new Error('Restaurant check not found on this register.');
      const opened = await this.deps.store.open(access.scope, id, saved.revision);
      this.assertCurrent(access);
      if (checkoutKey(this.deps.getState()) !== checkoutKey(before)) throw new Error('POS cart changed while opening a check. Keep the current cart and retry after saving it.');
      this.active = opened;
      this.deps.dispatch({ type: 'state/replaceCheckoutSnapshot', payload: { snapshot: opened.snapshot } });
      return opened;
    });
  }

  mutate(action: PosAction): Promise<void> {
    return this.run(async access => {
      const check = this.active;
      if (!check || check.status !== 'OPEN') throw new Error('Restaurant check is not editable.');
      if (['cart/clear', 'cart/completeCheckout', 'session/open', 'session/close', 'table/setActive', 'state/replaceCheckoutSnapshot'].includes(action.type)) {
        throw new Error('Save this restaurant check before changing context; use an authorized cancellation to discard it.');
      }
      const before = capturePosCheckoutSnapshot(this.deps.getState(), access.scope, 'restaurant');
      this.deps.dispatch(action);
      try {
        const after = capturePosCheckoutSnapshot(this.deps.getState(), access.scope, 'restaurant');
        const saved = await this.deps.store.save(access.scope, check.id, check.revision, after, check.covers);
        this.assertCurrent(access);
        this.active = saved;
      } catch (error) {
        if (access.isCurrent()) this.deps.dispatch({ type: 'state/replaceCheckoutSnapshot', payload: { snapshot: before } });
        throw error;
      }
    });
  }

  setCovers(tableId: string, covers: number): Promise<void> {
    return this.run(async access => {
      const check = this.active;
      if (!check || check.status !== 'OPEN' || check.tableId !== tableId) throw new Error('Guest count does not belong to the active restaurant check.');
      const saved = await this.deps.store.save(access.scope, check.id, check.revision,
        capturePosCheckoutSnapshot(this.deps.getState(), access.scope, 'restaurant'), covers);
      this.assertCurrent(access); this.active = saved;
    });
  }

  beginPayment(orderId: string): Promise<{ checkId: string }> {
    return this.run(async access => {
      const check = this.active;
      if (!check || check.status !== 'OPEN') throw new Error('Restaurant payment cannot be started or retried.');
      // Freeze the latest main-owned snapshot before crossing the money boundary.
      const saved = await this.deps.store.save(access.scope, check.id, check.revision,
        capturePosCheckoutSnapshot(this.deps.getState(), access.scope, 'restaurant'), check.covers);
      this.assertCurrent(access); this.active = saved;
      const pending = await this.deps.store.beginPayment(access.scope, saved.id, saved.revision, orderId, `restaurant:${orderId}`);
      this.assertCurrent(access); this.active = pending;
      return { checkId: pending.id };
    });
  }

  assertPaymentOrder(orderId: string, order?: any, items?: any[]): string | null {
    if (this.running || this.failed) throw new Error('Restaurant storage is busy or blocked. Do not charge again.');
    if (!this.active) return null;
    const access = this.deps.captureAccess();
    this.assertCurrent(access); this.assertActiveScope(access);
    if (this.active.status !== 'PAYMENT_PENDING' || this.active.orderId !== orderId) {
      throw new Error('Restaurant payment boundary is missing or belongs to another order.');
    }
    if (order && items) {
      const state = this.active.snapshot.state;
      const expected = state.cart.items.map((item: any) => [item.variantId, item.quantity, item.price, item.total, item.notes ?? null, item.course ?? null, item.lineDiscount ?? 0]);
      const incoming = items.map(item => [item.variant_id, item.sale_quantity ?? item.quantity, item.price, item.total, item.notes ?? null, item.course ?? null, item.allocated_discount ?? 0]);
      if (order.total !== state.cart.total || (order.table_id ?? null) !== this.active.tableId
        || (order.covers ?? 0) !== this.active.covers || (order.tip ?? 0) !== (state.tip ?? 0)
        || order.order_type !== (state.checkoutDraft?.restaurant?.orderType ?? 'dine_in')
        || JSON.stringify(expected) !== JSON.stringify(incoming)) {
        throw new Error('Restaurant payment does not match the frozen check. Reconcile without charging again.');
      }
    }
    return this.active.id;
  }

  confirmPaid(checkId: string, orderId: string): Promise<void> {
    return this.run(async access => {
      const check = await this.deps.store.get(access.scope, checkId);
      this.assertCurrent(access);
      if (!check || check.orderId !== orderId || !this.deps.isOrderCommitted(orderId)) throw new Error('Restaurant order has not been confirmed by the local payment ledger.');
      if (check.status !== 'PAID') await this.deps.store.confirmPaid(access.scope, check.id, check.revision, orderId);
      this.assertCurrent(access);
      if (this.active?.id === checkId) {
        this.active = null;
        this.deps.dispatch({ type: 'cart/completeCheckout' });
      }
    });
  }

  /** Called on listing after restart: only an existing paid ledger row can
   * resolve an interrupted commit. Otherwise leave the check locked. */
  recoverPaid(): Promise<void> {
    return this.run(async access => {
      const checks = await this.deps.store.listUnfinished(access.scope);
      this.assertCurrent(access);
      for (const check of checks) {
        if (['PAYMENT_PENDING', 'PAYMENT_UNCERTAIN'].includes(check.status) && check.orderId && this.deps.isOrderCommitted(check.orderId)) {
          await this.deps.store.confirmPaid(access.scope, check.id, check.revision, check.orderId);
          this.assertCurrent(access);
          if (this.active?.id === check.id) { this.active = null; this.deps.dispatch({ type: 'cart/completeCheckout' }); }
        }
      }
    });
  }
}
