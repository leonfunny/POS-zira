import { RestaurantCheckController } from '../../../shared/restaurant-check-controller';
import { RestaurantCheckStore } from '../../../shared/restaurant-check-store';
import { canChangeRestaurantContext, matchesRestaurantSaleContext } from '../../../shared/pos-mode';
import type { ShimConfigStore } from './config-store';
import type { ShimPosStore, PosAction } from './pos-store';
import type { AndroidDatabase } from './db/db';
import { getOrCreateAndroidDeviceId } from './db/device-identity';
import { createRestaurantTableRepo } from './db/restaurant-table-repo';
import { canUseCachedRestaurantLayout, parseRestaurantLayout } from './restaurant-layout';

interface Dependencies { configStore: ShimConfigStore; posStore: ShimPosStore; db(): Promise<AndroidDatabase>; fetchLayout?(): Promise<unknown> }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** One register-local owner. Neither database/scope nor restore actions are
 * exposed to the renderer. Only completed orders use the existing transport. */
export class AndroidRestaurantRuntime {
  private controller: RestaurantCheckController | null = null;
  private database: AndroidDatabase | null = null;
  private registerId = '';
  private running = false;
  private reading = false;
  private idle: Promise<void> = Promise.resolve();
  private releaseIdle: () => void = () => {};
  private preflight: { orderId: string; token: string; expiresAt: number; epoch: number; shiftId: string } | null = null;
  private failed = false;
  private epoch = 0;
  private identity: string;
  private layoutStatus: { source: 'local' | 'server' | 'cache'; syncedAt: string | null } = { source: 'local', syncedAt: null };
  private unsubscribe: () => void;

  constructor(private readonly deps: Dependencies) {
    this.identity = this.identityKey();
    this.unsubscribe = deps.configStore.onConfigUpdated(() => {
      const next = this.identityKey();
      if (next === this.identity) return;
      this.identity = next; this.epoch += 1;
      this.layoutStatus = { source: 'local', syncedAt: null };
      this.preflight = null;
      this.controller?.resetForAuthBoundary();
      deps.posStore.dispatch({ type: 'session/close' });
    });
  }
  dispose() { this.unsubscribe(); }
  private identityKey() {
    const config = this.deps.configStore.getRawConfig();
    return JSON.stringify([config.salonId, config.authUser?.id]);
  }
  private access() {
    const config = this.deps.configStore.getRawConfig();
    const user = config.authUser;
    if (!user?.id || !config.salonId || user.salonId !== config.salonId || config.posMode !== 'restaurant'
      || !['STAFF', 'MANAGER', 'OWNER', 'SUPER_ADMIN'].includes(user.role)) throw new Error('Authenticated restaurant staff required.');
    const epoch = this.epoch;
    return { scope: { salonId: config.salonId, userId: user.id, registerId: this.registerId },
      isCurrent: () => epoch === this.epoch && this.identityKey() === this.identity && this.deps.configStore.getRawConfig().posMode === 'restaurant' };
  }
  private async initialize() {
    if (this.controller) return this.controller;
    const db = await this.deps.db();
    this.database = db;
    const deviceId = getOrCreateAndroidDeviceId(db);
    await this.flush();
    this.registerId = deviceId;
    const store = new RestaurantCheckStore({
      run: (sql, params) => db.run(sql, params), get: (sql, params) => db.get(sql, params),
      all: (sql, params) => db.all(sql, params), transaction: fn => db.transaction(fn),
      flush: async () => { await this.flush(); return { success: true }; },
    });
    this.controller = new RestaurantCheckController({
      store, captureAccess: () => this.access(), getState: () => this.deps.posStore.getState(),
      dispatch: action => this.deps.posStore.dispatch(action as PosAction), newId: () => crypto.randomUUID(),
      getCovers: tableId => tableId ? this.tablesRepo().getById(tableId)?.covers ?? 0 : 0,
      isOrderCommitted: orderId => db.get<{ status: string }>('SELECT status FROM orders WHERE id = ?', [orderId])?.status === 'COMPLETED',
    });
    return this.controller;
  }
  private async flush() {
    try { await this.database!.flush(); }
    catch (error) { this.failed = true; throw new Error(`RESTAURANT_STORAGE_RESTART_REQUIRED: ${message(error)}`); }
  }
  private tablesRepo() { return createRestaurantTableRepo(this.database!, this.access().scope.salonId); }
  private async loadTables(activeOnly: boolean) {
    const access = this.access();
    const repo = this.tablesRepo();
    if (this.deps.fetchLayout) {
      let payload: unknown;
      try { payload = await this.deps.fetchLayout(); }
      catch (error) {
        if (!access.isCurrent()) throw new Error('POS account changed during table sync.');
        const syncedAt = repo.lastSyncedAt();
        if (!syncedAt || !canUseCachedRestaurantLayout(error)) throw error;
        this.layoutStatus = { source: 'cache', syncedAt };
        const state = this.deps.posStore.getState();
        return repo.list(activeOnly, state.cart.items.length ? state.activeTable : null);
      }
      if (!access.isCurrent()) throw new Error('POS account changed during table sync.');
      const rows = parseRestaurantLayout(payload, access.scope.salonId);
      const syncedAt = new Date().toISOString();
      repo.replaceLayout(rows, syncedAt);
      await this.flush();
      if (!access.isCurrent()) throw new Error('POS account changed during table sync.');
      this.layoutStatus = { source: 'server', syncedAt };
    }
    const state = this.deps.posStore.getState();
    return repo.list(activeOnly, state.cart.items.length ? state.activeTable : null);
  }
  assertIdle() {
    if (this.running) throw new Error('Wait for the restaurant operation to finish.');
    if (this.failed || this.controller?.blocked) throw new Error('Restaurant storage requires restart and payment reconciliation. Do not charge again.');
  }
  assertContextChange() {
    this.assertIdle();
    if (this.controller?.hasActive) throw new Error('Save the restaurant check before changing POS context.');
  }
  private lock() {
    this.running = true;
    this.idle = new Promise(resolve => { this.releaseIdle = resolve; });
  }
  private unlock() { this.running = false; this.reading = false; this.releaseIdle(); }
  /** Auth and shift operations must exclude cart/payment commands across awaits. */
  async contextBoundary<T>(operation: () => Promise<T>): Promise<T> {
    this.assertContextChange();
    if (this.deps.configStore.getRawConfig().posMode === 'restaurant' && this.deps.posStore.getState().cart.items.length) throw new Error('Save or finish the current sale first.');
    this.lock();
    this.preflight = null;
    try { return await operation(); } finally { this.unlock(); }
  }
  private async read<T>(fn: (controller: RestaurantCheckController) => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    while (this.running) await this.idle;
    if (epoch !== this.epoch) throw new Error('POS account changed.');
    return this.run(fn, true, true);
  }
  private async run<T>(fn: (controller: RestaurantCheckController) => Promise<T>, requireRestaurant = true, reading = false): Promise<T> {
    this.assertIdle();
    const epoch = this.epoch;
    if (requireRestaurant) this.access();
    this.lock();
    this.reading = reading;
    try {
      const controller = await this.initialize();
      if (epoch !== this.epoch) throw new Error('POS account changed.');
      const result = await fn(controller);
      if (epoch !== this.epoch) throw new Error('POS account changed during operation.');
      return result;
    } finally { this.unlock(); }
  }
  private async reply<T extends object>(fn: () => Promise<T>) {
    try { return { success: true as const, ...await fn() }; }
    catch (error) { return { success: false as const, error: message(error) }; }
  }
  private assertNoUnownedActive(controller: RestaurantCheckController) {
    const scope = this.access().scope;
    const active = this.database!.get<{ id: string }>(`SELECT id FROM pos_restaurant_checks WHERE salon_id = ? AND register_id = ?
      AND status IN ('OPEN','PAYMENT_PENDING','PAYMENT_UNCERTAIN')`, [scope.salonId, scope.registerId]);
    if (active && active.id !== controller.activeId) throw new Error('Recover or reconcile the active restaurant check before starting another sale.');
  }
  readonly checks = {
    list: () => this.reply(() => this.read(async controller => { await this.flush(); await controller.recoverPaid(); return controller.list(); })),
    saveCurrent: () => this.reply(() => this.run(async controller => { this.assertNoUnownedActive(controller); return controller.saveCurrent(); })),
    open: (id: string) => this.reply(() => this.run(async controller => ({ check: await controller.open(id) }))),
    beginPayment: (orderId: string, token: string) => this.reply(() => this.run(async controller => {
      const proof = this.preflight;
      if (!proof || token !== proof.token || orderId !== proof.orderId || proof.expiresAt <= Date.now() || proof.epoch !== this.epoch) {
        throw new Error('Restaurant payment preflight expired or does not match this order.');
      }
      const session = this.deps.posStore.getState().session;
      if (!session.isOpen || !session.shiftId || session.shiftId !== proof.shiftId || !this.database!.get('SELECT id FROM shifts WHERE id = ? AND closed_at IS NULL', [session.shiftId])) {
        throw new Error('Open a local shift before payment.');
      }
      const result = await controller.beginPayment(orderId);
      this.preflight = null;
      return result;
    })),
  };
  readonly tables = {
    getAll: () => this.read(() => this.loadTables(false)),
    getActive: () => this.read(() => this.loadTables(true)),
    getSyncStatus: async () => { this.access(); return { ...this.layoutStatus }; },
    updateStatus: (id: string, status: string, orderId?: string | null) => this.run(async () => {
      this.tablesRepo().updateStatus(id, status, orderId); await this.flush();
    }),
    clearTable: (id: string) => this.run(async () => { this.tablesRepo().updateStatus(id, 'free'); await this.flush(); }),
    setCovers: (id: string, covers: number) => this.reply(() => this.run(async controller => {
      if (!this.tablesRepo().getById(id) || !Number.isInteger(covers) || covers < 0) throw new Error('Invalid table or guest count.');
      if (controller.hasActive) await controller.setCovers(id, covers);
      else {
        const existing = this.database!.get("SELECT id FROM pos_restaurant_checks WHERE salon_id = ? AND table_id = ? AND status NOT IN ('PAID','CANCELLED')", [this.access().scope.salonId, id]);
        if (existing) throw new Error('Open the saved check before changing its guests.');
      }
      this.tablesRepo().setCovers(id, covers); await this.flush(); return {};
    })),
  };
  dispatch(action: PosAction) {
    return this.reply(async () => {
      const epoch = this.epoch;
      while (this.reading) await this.idle;
      if (epoch !== this.epoch) throw new Error('POS account changed.');
      this.assertIdle();
      if (action.type === 'state/replaceCheckoutSnapshot') throw new Error('Restaurant restore is runtime-owned.');
      const state = this.deps.posStore.getState();
      if (action.type === 'table/setActive' && !canChangeRestaurantContext(state, action.payload.tableId, action.payload.orderType)) {
        throw new Error('Finish or save the current sale before changing its table/service type.');
      }
      if (action.type === 'cart/addItem' && action.restaurantContext && !matchesRestaurantSaleContext(state, action.restaurantContext)) {
        throw new Error('Restaurant context changed. Select the product again.');
      }
      if (this.deps.configStore.getRawConfig().posMode !== 'restaurant' || action.type === 'display/setMode') {
        this.deps.posStore.dispatch(action); return {};
      }
      return this.run(async controller => {
        // Boot hydration restores only the real, open local shift, never an old
        // shift from the recalled snapshot. It must also work before recovery.
        if (action.type === 'session/open' && !controller.hasActive) {
          if (!this.database!.get('SELECT id FROM shifts WHERE id = ? AND closed_at IS NULL', [action.payload.shiftId])) throw new Error('Local shift is not open.');
          this.deps.posStore.dispatch(action); return {};
        }
        this.assertNoUnownedActive(controller);
        if (action.type === 'table/setActive' && action.payload.tableId) {
          const table = this.tablesRepo().getById(action.payload.tableId);
          if (!table?.is_active) throw new Error('Restaurant table not found.');
          const saved = this.database!.get("SELECT id FROM pos_restaurant_checks WHERE salon_id = ? AND table_id = ? AND status NOT IN ('PAID','CANCELLED')", [this.access().scope.salonId, table.id]);
          if (saved) throw new Error('Open the saved restaurant check instead of replacing its table cart.');
        }
        if (controller.hasActive) await controller.mutate(action);
        else this.deps.posStore.dispatch(action);
        return {};
      });
    });
  }
  paymentPreflight(orderId: string) {
    return this.reply(() => this.run(async () => {
      if (typeof orderId !== 'string' || !orderId.trim()) throw new Error('Order identity required.');
      const session = this.deps.posStore.getState().session;
      if (!session.isOpen || !session.shiftId || !this.database!.get('SELECT id FROM shifts WHERE id = ? AND closed_at IS NULL', [session.shiftId])) throw new Error('Open a local shift before payment.');
      const proof = { orderId, token: crypto.randomUUID(), expiresAt: Date.now() + 15 * 60 * 1000, epoch: this.epoch, shiftId: session.shiftId };
      this.preflight = proof;
      return { token: proof.token, expiresAt: proof.expiresAt };
    }));
  }
  async createOrder(order: any, items: any[], create: () => Promise<any>) {
    let crossedOrderBoundary = false;
    try {
      this.assertIdle();
      if (this.deps.configStore.getRawConfig().posMode !== 'restaurant') return create();
      return await this.run(async controller => {
        this.assertNoUnownedActive(controller);
        const checkId = controller.assertPaymentOrder(order?.id, order, items);
        crossedOrderBoundary = true;
        const result = await create();
        if (!result.success) {
          if (checkId || result.outcomeUncertain || result.paymentCommitted || this.database!.get('SELECT id FROM orders WHERE id = ?', [order.id])) {
            throw new Error(result.error || 'Order may have been committed. Reconcile before retrying.');
          }
          crossedOrderBoundary = false;
          return result;
        }
        await this.flush();
        if (result.id !== order.id) throw new Error('Created restaurant order identity mismatch.');
        if (checkId) {
          await controller.confirmPaid(checkId, order.id);
          if (order.table_id) { this.tablesRepo().updateStatus(order.table_id, 'free'); await this.flush(); }
        }
        return result;
      });
    } catch (error) {
      if (crossedOrderBoundary) this.failed = true;
      return { success: false, error: message(error), ...(crossedOrderBoundary ? { outcomeUncertain: true, paymentCommitted: true } : {}) };
    }
  }
}
