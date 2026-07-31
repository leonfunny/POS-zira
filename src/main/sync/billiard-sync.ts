import { BrowserWindow } from 'electron';
import { apiClient } from '../network/api-client';
import { billiardResourceRepo } from '../database/repos/billiard-resource-repo';
import { billiardFloorPlanRepo } from '../database/repos/billiard-floor-plan-repo';
import { billiardComboRepo } from '../database/repos/billiard-combo-repo';
import { billiardSessionRepo } from '../database/repos/billiard-session-repo';
import { billiardMutationRepo } from '../database/repos/billiard-mutation-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';
import { ApiReachabilityTracker } from './api-reachability';
import {
  canonicalBilliardBillingMode,
  canonicalBilliardSessionStatus,
  getBilliardMutationPolicy,
  isBilliardNetworkError,
  isAllowedBilliardOperation,
  normalizeBilliardDashboard,
  normalizeBilliardPendingPayments,
} from '../../shared/billiard-contract';

const MAX_QUEUE_RETRIES = 3;
const SESSION_STATE_OPERATIONS = new Set([
  'start_session',
  'pause_session',
  'resume_session',
  'update_session',
  'add_item',
  'remove_item',
  'update_item',
  'transfer_table',
]);

function parseJsonObject(value: string | null | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export class BilliardSync {
  private dashboardTimer: ReturnType<typeof setInterval> | null = null;
  private isOnline = false;
  // REST/HTTPS health is independent from the realtime socket. The tracker is
  // tri-state and rejects late results from older overlapping probes.
  private readonly apiReachability = new ApiReachabilityTracker();
  private restaurantCombosCache: any[] = [];
  private pendingPaymentsSignature: string | null = null;
  private dashboardRefreshCount = 0;
  private replayInFlight: Promise<{ ok: number; failed: number }> | null = null;
  private stateEpoch = 0;
  private dashboardRequestId = 0;
  private pendingPaymentsEndpointMissingWarned = false;

  // ── Reference data sync (login/reconnect) ────────────

  async fullSync(): Promise<{ resources: number; floors: number; combos: number }> {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    logger.info('[BilliardSync] Starting full sync...');
    this.pendingPaymentsSignature = null;

    let resources = 0;
    let floors = 0;
    let combos = 0;
    let dashboardSynced = false;

    try {
      // 1. Floor-plan parents must exist before dashboard layouts. On a fresh
      // DB the layout table has FKs to both floor plans and resources.
      floors = await this.syncFloorPlans(token);
    } catch (err) {
      logger.warn(`[BilliardSync] Floor plans sync failed: ${err}`);
    }

    const dashboardProbe = this.beginApiProbe();
    try {
      // 2. Dashboard data (resource parents + sessions + layouts)
      const dashboard = await apiClient.request('GET', '/billiard/dashboard', token);
      this.setApiReachable(true, dashboardProbe);
      const normalized = normalizeBilliardDashboard(dashboard);
      database.transaction(() => {
        billiardResourceRepo.replaceAll(normalized.resources);
        billiardSessionRepo.replaceActive(normalized.sessions);
        if (normalized.layouts.length > 0) {
          billiardFloorPlanRepo.upsertLayouts(normalized.layouts);
        }
      });
      resources = normalized.resources.length;
      dashboardSynced = true;
    } catch (err) {
      this.setApiReachable(!isBilliardNetworkError(err), dashboardProbe);
      logger.warn(`[BilliardSync] Dashboard sync failed: ${err}`);
    }

    try {
      // Cashier-safe full snapshot: recover even when the end response was
      // lost before this device could journal it, including after a restart.
      await this.syncPendingPayments(token, 'pending payment recovery');
    } catch (err) {
      logger.debug(`[BilliardSync] Pending payment recovery skipped: ${err}`);
    }

    try {
      // 3. Combos
      const combosData = await apiClient.request('GET', '/billiard/combos', token);
      const comboList = Array.isArray(combosData) ? combosData : (combosData?.data || []);
      if (comboList.length > 0) {
        database.transaction(() => {
          billiardComboRepo.upsertMany(comboList);
        });
        combos = comboList.length;
      }
    } catch (err) {
      logger.warn(`[BilliardSync] Combos sync failed: ${err}`);
    }

    try {
      // 4. Restaurant combos (in-memory cache only)
      const restaurantCombos = await apiClient.request('GET', '/restaurant/combos', token);
      this.restaurantCombosCache = Array.isArray(restaurantCombos)
        ? restaurantCombos
        : (restaurantCombos?.data || []);
    } catch (err) {
      logger.warn(`[BilliardSync] Restaurant combos sync failed: ${err}`);
    }

    if (dashboardSynced) {
      database.run(
        "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('billiard_last_sync', ?, datetime('now'))",
        [new Date().toISOString()],
      );
      database.markDirty();
    }

    logger.info(`[BilliardSync] Full sync done: ${resources} resources, ${floors} floors, ${combos} combos`);
    return { resources, floors, combos };
  }

  // ── Dashboard cache refresh ───────────────────────────

  async refreshDashboard(): Promise<void> {
    const token = getSecureAuthToken();
    if (!token) return;

    this.dashboardRefreshCount++;
    if (
      billiardFloorPlanRepo.getAll().length === 0
      || this.dashboardRefreshCount % 6 === 0
    ) {
      try {
        await this.syncFloorPlans(token);
      } catch (err) {
        logger.debug(`[BilliardSync] Periodic floor-plan refresh failed: ${err}`);
      }
    }

    let restReachable = false;
    const requestId = ++this.dashboardRequestId;
    const requestEpoch = this.stateEpoch;
    const dashboardProbe = this.beginApiProbe();
    try {
      const dashboard = await apiClient.request('GET', '/billiard/dashboard', token);
      this.setApiReachable(true, dashboardProbe);
      if (!dashboard) return;
      restReachable = true;
      if (requestId !== this.dashboardRequestId || requestEpoch !== this.stateEpoch) {
        logger.debug('[BilliardSync] Discarding stale dashboard response');
      } else {
        const normalized = normalizeBilliardDashboard(dashboard);
        database.transaction(() => {
          billiardResourceRepo.replaceAll(normalized.resources);
          billiardSessionRepo.replaceActive(normalized.sessions);
          if (normalized.layouts.length > 0) {
            billiardFloorPlanRepo.upsertLayouts(normalized.layouts);
          }
        });

        database.markDirty();
        this.notifyRenderer('dashboard');
      }
    } catch (err) {
      this.setApiReachable(!isBilliardNetworkError(err), dashboardProbe);
      logger.debug(`[BilliardSync] Dashboard refresh failed: ${err}`);
    }

    try {
      if (await this.syncPendingPayments(token, 'periodic pending payment reconciliation')) {
        this.notifyRenderer('payment-reconciled');
      }
    } catch (err) {
      logger.debug(`[BilliardSync] Pending payment refresh failed: ${err}`);
    }

    // WebSocket health is independent from HTTPS health. If REST has
    // recovered, replay queue-safe offline edits even while realtime remains
    // disconnected. The single-flight guard prevents the post-replay refresh
    // from recursively starting another replay.
    if (restReachable && billiardMutationRepo.countPending() > 0) {
      this.replayQueue().catch((err) => {
        logger.debug(`[BilliardSync] REST-recovery queue replay failed: ${err}`);
      });
    }
  }

  startPeriodicDashboardRefresh(): void {
    if (this.dashboardTimer) return;
    logger.info('[BilliardSync] Starting periodic dashboard refresh (10s)');
    this.dashboardTimer = setInterval(() => this.refreshDashboard(), 10000);
  }

  stopPeriodicDashboardRefresh(): void {
    if (this.dashboardTimer) {
      clearInterval(this.dashboardTimer);
      this.dashboardTimer = null;
      logger.info('[BilliardSync] Periodic dashboard refresh stopped');
    }
  }

  // ── Mutation execution ────────────────────────────────

  async executeMutation(op: string, method: string, path: string, body?: any): Promise<any> {
    const routePolicy = getBilliardMutationPolicy(method, path);
    if (!routePolicy || !isAllowedBilliardOperation(op, method, path)) {
      throw new Error(`Billiard operation not allowed: ${String(method).toUpperCase()} ${path}`);
    }

    const normalizedMethod = String(method).toUpperCase();
    const sessionReconciliationRead = op === 'online_api'
      && normalizedMethod === 'GET'
      && /^\/billiard\/sessions\/[^/]+$/.test(path);
    const onlineOnly = routePolicy === 'online-only';
    // Every mutation probes REST first. WebSocket state only describes the
    // realtime channel and must never delay pause/resume or other HTTPS calls.
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    const mutationProbe = this.beginApiProbe();
    try {
      const result = await apiClient.request(method, path, token, body);
      this.setApiReachable(true, mutationProbe);
      if (normalizedMethod !== 'GET') this.stateEpoch++;

        if (op === 'end_session' && result?.id) {
          billiardSessionRepo.upsertOne(result);
          await this.flushPaymentJournal('session end');
          this.notifyRenderer('payment-pending');
        } else if (op === 'process_payment' && result?.id) {
          // Keep a PAID completed row as a short-lived tombstone. It is hidden
          // from the pending list but prevents a stale ACTIVE dashboard entry
          // from resurrecting the table. History sync later removes it.
          billiardSessionRepo.upsertOne(result);
          await this.flushPaymentJournal('payment result');
          this.notifyRenderer('payment-updated');
        } else if (op === 'void_session' && result?.id) {
          // A written-off session leaves the pending list immediately: the
          // VOID row upserts over the UNPAID/PARTIAL one and no longer matches
          // the pending query.
          billiardSessionRepo.upsertOne(result);
          await this.flushPaymentJournal('session void');
          this.notifyRenderer('payment-updated');
        } else if (op === 'void_sessions_batch') {
          // Batch returns per-id verdicts, not sessions — re-pull the pending
          // snapshot so every voided row drops out of the local cache.
          await this.syncPendingPayments(token, 'void batch');
          await this.flushPaymentJournal('session void batch');
          this.notifyRenderer('payment-updated');
        } else if (op === 'retail_quick_sale' && result?.session?.id) {
          // Walk-in retail returns a settled fnb_only session — cache it so
          // the local receipt printer and history can read it immediately.
          billiardSessionRepo.upsertOne(result.session);
          this.notifyRenderer('payment-updated');
        } else if (op === 'merge_sessions') {
          // Source sessions vanish into the target — pull a fresh dashboard
          // synchronously so stale ACTIVE rows drop off the floor before the
          // dialog closes.
          await this.refreshDashboard().catch(() => {});
        } else if (sessionReconciliationRead && result?.id) {
          const status = canonicalBilliardSessionStatus(result.status);
          if (status === 'COMPLETED') {
            billiardSessionRepo.upsertOne(result);
            await this.flushPaymentJournal('session reconciliation');
            this.notifyRenderer(
              String(result.paymentStatus || '').toUpperCase() === 'PAID'
                ? 'payment-updated'
                : 'payment-pending',
            );
          }
        } else if (SESSION_STATE_OPERATIONS.has(op)) {
          await this.syncSessionAfterMutation(op, path, result, token);
        }

        const floorPlanMutation = normalizedMethod !== 'GET'
          && /^\/billiard\/floor-plans(?:\/[^/?#]+)?$/.test(path);
        if (floorPlanMutation) {
          await this.syncFloorPlans(token).catch((e) => {
            logger.debug('[BilliardSync] post-mutation floor refresh failed:', e?.message);
          });
        }

        // Creating a resource is immediately followed by a layout upsert in
        // the UI. Refreshing between those two calls races the backend's
        // dashboard auto-layout creation with that explicit upsert. The
        // layout mutation performs the refresh once the pair is complete.
        const resourceCreateInProgress = op === 'online_api'
          && normalizedMethod === 'POST'
          && path === '/resources';
        const journalIsAuthoritative = op === 'end_session'
          || op === 'process_payment'
          || op === 'void_session'
          || op === 'void_sessions_batch'
          || op === 'retail_quick_sale'
          || op === 'merge_sessions'
          || sessionReconciliationRead
          || SESSION_STATE_OPERATIONS.has(op);
        if (!resourceCreateInProgress && !journalIsAuthoritative && !floorPlanMutation) {
          // Run in background — don't block the mutation response.
          this.refreshDashboard().catch((e) => {
            logger.debug('[BilliardSync] post-mutation refresh failed:', e?.message);
          });
        }

      return result;
    } catch (err: any) {
      // Only transport failures may enter the offline queue. HTTP 4xx/5xx
      // responses are authoritative and must be surfaced to the cashier.
      if (!isBilliardNetworkError(err)) {
        this.setApiReachable(true, mutationProbe);
        throw err;
      }
      this.setApiReachable(false, mutationProbe);
      if (onlineOnly) {
        throw new Error('Network connection was lost. Reconnect before trying this billiard operation again.');
      }
      logger.warn(`[BilliardSync] REST mutation failed (network), falling back to queue: ${err.message}`);
    }

    if (onlineOnly) {
      throw new Error('This billiard operation requires a network connection. Please reconnect and try again.');
    }

    // Offline (or network-failed fallback): queue the mutation
    const queueId = billiardMutationRepo.enqueue(op, method, path, body);

    // Optimistic local update so UI reflects the change immediately
    this.applyOptimisticUpdate(op, path, body);

    database.markDirty();
    const persisted = await database.saveCoalesced();
    if (!persisted.success) {
      throw new Error(
        `Could not durably queue the billiard operation: ${persisted.error || 'unknown database error'}`,
      );
    }

    const pending = billiardMutationRepo.countPending();
    logger.info(`[BilliardSync] Mutation queued (offline): ${op} → queue #${queueId}, ${pending} pending`);

    this.notifyRenderer('mutation-queued');

    return { queued: true, queueId, pendingCount: pending };
  }

  // ── Optimistic local updates (offline) ──────────────

  private applyOptimisticUpdate(op: string, path: string, body?: any): void {
    try {
      // Extract session ID from path: /billiard/sessions/:id/action
      const sessionMatch = path.match(/\/billiard\/sessions\/([^/]+)/);
      const sessionId = sessionMatch?.[1];

      switch (op) {
        case 'start_session': {
          if (!body) break;
          const tempId = `offline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          billiardSessionRepo.upsertOne({
            id: tempId,
            resourceId: body.resourceId,
            status: 'ACTIVE',
            billingMode: body.billingMode || 'PER_MINUTE',
            guestCount: body.guestCount || 1,
            startedAt: new Date().toISOString(),
            totalMinutes: 0,
            totalCharges: 0,
            comboId: body.comboId || null,
            notes: body.notes || null,
            items: [],
          });
          break;
        }
        case 'pause_session': {
          if (!sessionId) break;
          database.run(
            "UPDATE billiard_sessions SET status = 'PAUSED', paused_at = ? WHERE id = ?",
            [new Date().toISOString(), sessionId],
          );
          break;
        }
        case 'resume_session': {
          if (!sessionId) break;
          database.run(
            "UPDATE billiard_sessions SET status = 'ACTIVE', paused_at = NULL WHERE id = ?",
            [sessionId],
          );
          break;
        }
        case 'end_session': {
          if (!sessionId) break;
          database.run(
            "UPDATE billiard_sessions SET status = 'COMPLETED', ended_at = ? WHERE id = ?",
            [new Date().toISOString(), sessionId],
          );
          break;
        }
        case 'update_session': {
          if (!sessionId || !body) break;
          if (body.guestCount !== undefined) {
            database.run(
              'UPDATE billiard_sessions SET guest_count = ? WHERE id = ?',
              [body.guestCount, sessionId],
            );
          }
          if (body.notes !== undefined) {
            database.run(
              'UPDATE billiard_sessions SET notes = ? WHERE id = ?',
              [body.notes, sessionId],
            );
          }
          if (body.billingMode !== undefined) {
            database.run(
              'UPDATE billiard_sessions SET billing_mode = ? WHERE id = ?',
              [body.billingMode, sessionId],
            );
          }
          break;
        }
        case 'add_item': {
          if (!sessionId || !body) break;
          const itemId = `offline_item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          database.run(
            `INSERT INTO billiard_session_items (id, session_id, variant_id, name, quantity, unit_price)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [itemId, sessionId, body.variantId || null, body.name || '', body.quantity ?? 1, body.unitPrice ?? 0],
          );
          break;
        }
        case 'remove_item': {
          // Path: /billiard/sessions/:sessionId/items/:itemId
          const itemMatch = path.match(/\/items\/([^/]+)$/);
          if (itemMatch?.[1]) {
            database.run('DELETE FROM billiard_session_items WHERE id = ?', [itemMatch[1]]);
          }
          break;
        }
        case 'transfer_table': {
          if (!sessionId || !body?.targetResourceId) break;
          database.run(
            'UPDATE billiard_sessions SET resource_id = ? WHERE id = ?',
            [body.targetResourceId, sessionId],
          );
          break;
        }
        case 'process_payment': {
          if (!sessionId) break;
          database.run(
            "UPDATE billiard_sessions SET status = 'COMPLETED', ended_at = ? WHERE id = ?",
            [new Date().toISOString(), sessionId],
          );
          break;
        }
        // Edit-mode operations — update local layout cache
        case 'update_floor_plan': {
          // Path: /billiard/floor-plans/:id
          const fpMatch = path.match(/\/billiard\/floor-plans\/([^/]+)/);
          if (fpMatch?.[1] && body) {
            const sets: string[] = [];
            const vals: any[] = [];
            if (body.roomWidthM !== undefined) { sets.push('room_width_m = ?'); vals.push(body.roomWidthM); }
            if (body.roomHeightM !== undefined) { sets.push('room_height_m = ?'); vals.push(body.roomHeightM); }
            if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
            if (body.floorNumber !== undefined) { sets.push('floor_number = ?'); vals.push(body.floorNumber); }
            if (sets.length > 0) {
              vals.push(fpMatch[1]);
              database.run(`UPDATE billiard_floor_plans SET ${sets.join(', ')} WHERE id = ?`, vals);
            }
          }
          break;
        }
        case 'upsert_layout': {
          const layoutMatch = path.match(/\/billiard\/table-layouts\/([^/]+)$/);
          const resourceId = layoutMatch?.[1];
          if (body && resourceId) {
            const existing = database.get<{ id: string }>(
              'SELECT id FROM billiard_table_layouts WHERE resource_id = ?',
              [resourceId],
            );
            if (existing) {
              const sets: string[] = [];
              const vals: any[] = [];
              if (body.positionX !== undefined) { sets.push('position_x = ?'); vals.push(body.positionX); }
              if (body.positionY !== undefined) { sets.push('position_y = ?'); vals.push(body.positionY); }
              if (body.rotation !== undefined) { sets.push('rotation = ?'); vals.push(body.rotation); }
              if (body.widthPct !== undefined) { sets.push('width_pct = ?'); vals.push(body.widthPct); }
              if (body.heightPct !== undefined) { sets.push('height_pct = ?'); vals.push(body.heightPct); }
              if (body.floorPlanId !== undefined) { sets.push('floor_plan_id = ?'); vals.push(body.floorPlanId); }
              if (sets.length > 0) {
                vals.push(existing.id);
                database.run(`UPDATE billiard_table_layouts SET ${sets.join(', ')} WHERE id = ?`, vals);
              }
            }
          }
          break;
        }
        case 'batch_update_layouts': {
          if (body?.layouts && Array.isArray(body.layouts)) {
            for (const l of body.layouts) {
              if (!l.resourceId) continue;
              const sets: string[] = [];
              const vals: any[] = [];
              if (l.widthPct !== undefined) { sets.push('width_pct = ?'); vals.push(l.widthPct); }
              if (l.heightPct !== undefined) { sets.push('height_pct = ?'); vals.push(l.heightPct); }
              if (sets.length > 0) {
                database.run(
                  `UPDATE billiard_table_layouts SET ${sets.join(', ')} WHERE resource_id = ?`,
                  [...vals, l.resourceId],
                );
              }
            }
          }
          break;
        }
        case 'update_resource': {
          // Path: /resources/:id
          const resMatch = path.match(/\/resources\/([^/]+)/);
          if (resMatch?.[1] && body) {
            const sets: string[] = [];
            const vals: any[] = [];
            if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
            if (sets.length > 0) {
              vals.push(resMatch[1]);
              database.run(`UPDATE billiard_resources SET ${sets.join(', ')} WHERE id = ?`, vals);
            }
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      logger.warn(`[BilliardSync] Optimistic update failed for ${op}: ${err}`);
    }
  }

  // ── Queue replay (on reconnect) ───────────────────────

  async replayQueue(): Promise<{ ok: number; failed: number }> {
    if (this.replayInFlight) return this.replayInFlight;
    this.replayInFlight = this.replayQueueInternal();
    try {
      return await this.replayInFlight;
    } finally {
      this.replayInFlight = null;
    }
  }

  private async replayQueueInternal(): Promise<{ ok: number; failed: number }> {
    const interrupted = billiardMutationRepo.recoverInterrupted();
    if (interrupted.recovered > 0 || interrupted.quarantined > 0) {
      logger.warn(
        `[BilliardSync] Queue recovery: ${interrupted.recovered} safe retry, ${interrupted.quarantined} unsafe quarantined`,
      );
      database.markDirty();
      const saved = await database.saveCoalesced();
      if (!saved.success) {
        throw new Error(`Could not durably quarantine legacy billiard queue rows: ${saved.error || 'unknown database error'}`);
      }
    }

    const token = getSecureAuthToken();
    if (!token) return { ok: 0, failed: 0 };

    const pending = billiardMutationRepo.getPending();
    if (pending.length === 0) return { ok: 0, failed: 0 };

    logger.info(`[BilliardSync] Replaying ${pending.length} queued mutations...`);

    let ok = 0;
    let failed = 0;

    for (const entry of pending) {
      const routePolicy = getBilliardMutationPolicy(entry.method, entry.path);
      if (
        routePolicy !== 'queue-safe'
        || !isAllowedBilliardOperation(entry.operation, entry.method, entry.path)
      ) {
        billiardMutationRepo.markQuarantined(
          entry.id,
          'Quarantined queue row whose operation does not match a queue-safe route',
        );
        failed++;
        logger.warn(`[BilliardSync] Quarantined mutation #${entry.id}: unsafe or mismatched route`);
        continue;
      }

      if (entry.attempts >= MAX_QUEUE_RETRIES) {
        // Exceeded retries — discard
        billiardMutationRepo.markCompleted(entry.id);
        failed++;
        logger.warn(`[BilliardSync] Discarding mutation #${entry.id} (${entry.operation}): max retries exceeded`);
        continue;
      }

      billiardMutationRepo.markInFlight(entry.id);

      try {
        const payload = entry.payload ? JSON.parse(entry.payload) : undefined;
        await apiClient.request(entry.method, entry.path, token, payload);
        this.stateEpoch++;
        billiardMutationRepo.markCompleted(entry.id);
        ok++;
      } catch (err: any) {
        const message = err.message || String(err);
        // 409 Conflict = stale data, discard and force refresh
        if (message.includes('409') || message.includes('Conflict')) {
          billiardMutationRepo.markCompleted(entry.id);
          failed++;
          logger.warn(`[BilliardSync] Mutation #${entry.id} conflict, discarded`);
        } else {
          billiardMutationRepo.markFailed(entry.id, message);
          failed++;
        }
      }
    }

    billiardMutationRepo.clearCompleted();

    // Clean up optimistic sessions with temp IDs — server has the real ones now
    const tempSessions = database.all<{ id: string }>(
      "SELECT id FROM billiard_sessions WHERE id LIKE 'offline_%'",
    );
    if (tempSessions.length > 0) {
      database.transaction(() => {
        for (const s of tempSessions) {
          database.run('DELETE FROM billiard_session_items WHERE session_id = ?', [s.id]);
          database.run('DELETE FROM billiard_sessions WHERE id = ?', [s.id]);
        }
      });
      logger.info(`[BilliardSync] Cleaned up ${tempSessions.length} temp offline session(s)`);
    }

    database.markDirty();

    await this.syncFloorPlans(token).catch((e) => {
      logger.debug('[BilliardSync] post-replay floor refresh failed:', e?.message);
    });

    // Force dashboard refresh after replay
    await this.refreshDashboard().catch((e) => { logger.debug('[BilliardSync] post-replay refresh failed:', e?.message); });

    logger.info(`[BilliardSync] Queue replay done: ${ok} ok, ${failed} failed`);
    this.notifyRenderer('queue-replayed');

    return { ok, failed };
  }

  // ── Assembled floor overview (for IPC handler) ────────

  getLocalFloorOverview(): any {
    const resources = billiardResourceRepo.getAll();
    const floorPlans = billiardFloorPlanRepo.getAll();
    const layouts = billiardFloorPlanRepo.getLayouts();
    const sessions = billiardSessionRepo.getActive();
    const pendingPaymentRows = billiardSessionRepo.getPendingPayments();

    const comboById = new Map(billiardComboRepo.getAll(false).map((combo) => [combo.id, combo]));

    const hydrateSession = (session: any, pricingRules: Record<string, any> = {}) => {
      const payload = parseJsonObject(session.payload_json);
      const combo = session.combo_id ? comboById.get(session.combo_id) : null;
      const totalCharge = Number(
        payload.totalCharge ?? payload.totalCharges ?? session.total_charges ?? 0,
      );
      return {
        ...payload,
        id: session.id,
        resourceId: session.resource_id,
        status: canonicalBilliardSessionStatus(session.status),
        billingMode: canonicalBilliardBillingMode(session.billing_mode),
        guestCount: session.guest_count,
        startedAt: session.started_at,
        pausedAt: session.paused_at,
        endedAt: session.ended_at,
        paymentStatus: payload.paymentStatus ?? 'UNPAID',
        paymentMethod: payload.paymentMethod ?? null,
        paidAmount: Number(payload.paidAmount ?? 0),
        totalPausedSeconds: Number(payload.totalPausedSeconds ?? 0),
        totalMinutes: Number(session.total_minutes ?? payload.durationMinutes ?? 0),
        durationMinutes: Number(payload.durationMinutes ?? session.total_minutes ?? 0),
        // total_charges is the grand total in the legacy cache. Reusing it as
        // timeCharge would add cached items a second time in the renderer.
        timeCharge: Number(payload.timeCharge ?? 0),
        totalCharge,
        totalCharges: totalCharge,
        comboId: session.combo_id,
        combo: payload.combo ?? (combo ? {
          id: combo.id,
          name: combo.name,
          comboPrice: combo.combo_price,
          playMinutes: combo.play_minutes,
        } : null),
        packagePrice: Number(payload.packagePrice ?? combo?.combo_price ?? 0),
        pricingSnapshot: payload.pricingSnapshot ?? { basePrice: Number(pricingRules.basePrice ?? 0) },
        notes: session.notes,
        items: (session.items || []).map((item: any) => ({
          id: item.id,
          variantId: item.variant_id,
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unit_price,
        })),
      };
    };

    // Build a session map by resource_id for quick lookup
    const sessionByResource = new Map<string, any>();
    for (const s of sessions) {
      if (s.resource_id) {
        sessionByResource.set(s.resource_id, s);
      }
    }

    // Assemble tables with layout + session info (mirrors server response shape)
    const tables = resources.map((r) => {
      const layout = layouts.find((l) => l.resource_id === r.id);
      const session = sessionByResource.get(r.id);
      const payload = parseJsonObject(r.payload_json);
      const pricingRules = parseJsonObject(r.pricing_rules);
      const hydratedSession = session ? hydrateSession(session, pricingRules) : null;

      return {
        resource: {
          ...payload,
          id: r.id,
          name: r.name,
          code: r.code,
          resourceTypeId: r.type_id,
          typeId: r.type_id,
          typeName: r.type_name,
          pricingRules,
          metadata: payload.metadata ?? {},
          isActive: r.is_active === 1,
        },
        status: !hydratedSession
          ? 'free'
          : hydratedSession.status === 'PAUSED' ? 'paused' : 'occupied',
        // Layout
        layout: layout ? {
          id: layout.id,
          positionX: layout.position_x,
          positionY: layout.position_y,
          rotation: layout.rotation,
          widthPct: layout.width_pct,
          heightPct: layout.height_pct,
          shape: layout.shape,
          assetKey: layout.asset_key,
          floorPlanId: layout.floor_plan_id,
        } : null,
        session: hydratedSession,
      };
    });

    const hydratedSessions = sessions.map((session) => {
      const resource = resources.find((row) => row.id === session.resource_id);
      return hydrateSession(session, parseJsonObject(resource?.pricing_rules));
    });

    const pendingPayments = pendingPaymentRows.map((session) => {
      const resource = resources.find((row) => row.id === session.resource_id);
      const resourcePayload = parseJsonObject(resource?.payload_json);
      return {
        ...hydrateSession(session, parseJsonObject(resource?.pricing_rules)),
        resource: resource ? {
          ...resourcePayload,
          id: resource.id,
          name: resource.name,
        } : null,
      };
    });

    return {
      tables,
      floorPlans: floorPlans.map((fp) => ({
        id: fp.id,
        name: fp.name,
        floorNumber: fp.floor_number,
        roomWidthM: fp.room_width_m,
        roomHeightM: fp.room_height_m,
        backgroundImage: fp.background_image,
      })),
      layouts: layouts.map((l) => ({
        id: l.id,
        resourceId: l.resource_id,
        floorPlanId: l.floor_plan_id,
        positionX: l.position_x,
        positionY: l.position_y,
        rotation: l.rotation,
        widthPct: l.width_pct,
        heightPct: l.height_pct,
        shape: l.shape,
        assetKey: l.asset_key,
      })),
      sessions: hydratedSessions,
      pendingPayments,
      _fromCache: true,
    };
  }

  // ── Connection state ──────────────────────────────────

  setOnline(online: boolean): void {
    this.isOnline = online;
    logger.info(`[BilliardSync] Online status: ${online}`);
  }

  getIsOnline(): boolean {
    return this.isOnline;
  }

  private beginApiProbe(): number {
    return this.apiReachability.beginProbe();
  }

  private setApiReachable(reachable: boolean, probeId: number): void {
    // Requests overlap (dashboard polling, reconciliation and cashier
    // mutations). A late failure from an older request must never override a
    // newer successful probe and close an active cashier dialog.
    const previous = this.apiReachability.get();
    if (!this.apiReachability.apply(probeId, reachable)) return;
    if (previous === reachable) return;
    logger.info(`[BilliardSync] REST API reachable: ${reachable}`);
  }

  getRestaurantCombos(): any[] {
    return this.restaurantCombosCache;
  }

  getSyncStatus(): {
    pending: number;
    lastSync: string | null;
    online: boolean;
    apiReachable: boolean | null;
  } {
    const pending = billiardMutationRepo.countPending();
    const row = database.get<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'billiard_last_sync'",
    );
    return {
      pending,
      lastSync: row?.value ?? null,
      online: this.isOnline,
      apiReachable: this.apiReachability.get(),
    };
  }

  // ── Helpers ───────────────────────────────────────────

  private async flushPaymentJournal(reason: string): Promise<void> {
    database.markDirty();
    const result = await database.saveCoalesced();
    if (!result.success) {
      throw new Error(
        `Could not durably save the billiard ${reason}: ${result.error || 'unknown database error'}`,
      );
    }
  }

  private async syncPendingPayments(token: string, reason: string): Promise<boolean> {
    const requestEpoch = this.stateEpoch;
    let pendingData: any;
    try {
      pendingData = await apiClient.request(
        'GET',
        '/billiard/sessions/pending-payments',
        token,
      );
      this.pendingPaymentsEndpointMissingWarned = false;
    } catch (err: any) {
      if (Number(err?.status) === 404) {
        if (!this.pendingPaymentsEndpointMissingWarned) {
          logger.warn('[BilliardSync] Pending-payment endpoint is not deployed; preserving the local payment journal');
          this.pendingPaymentsEndpointMissingWarned = true;
        }
        return false;
      }
      throw err;
    }
    if (requestEpoch !== this.stateEpoch) {
      logger.debug('[BilliardSync] Discarding stale pending-payment response');
      return false;
    }
    const pendingPayments = normalizeBilliardPendingPayments(pendingData);
    const signature = JSON.stringify(
      pendingPayments
        .map((session: any) => ({
          id: session?.id,
          paymentStatus: session?.paymentStatus,
          paidAmount: session?.paidAmount,
          totalCharge: session?.totalCharge,
          updatedAt: session?.updatedAt,
        }))
        .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id))),
    );
    if (signature === this.pendingPaymentsSignature) {
      let pruned = 0;
      database.transaction(() => {
        pruned = billiardSessionRepo.pruneExpiredPaidTombstones();
      });
      if (pruned === 0) return false;
      await this.flushPaymentJournal(`${reason} tombstone cleanup`);
      return true;
    }

    database.transaction(() => {
      billiardSessionRepo.reconcilePendingSnapshot(pendingPayments);
    });
    await this.flushPaymentJournal(reason);
    this.pendingPaymentsSignature = signature;
    return true;
  }

  private async syncFloorPlans(token: string): Promise<number> {
    const plansData = await apiClient.request('GET', '/billiard/floor-plans', token);
    const plans = Array.isArray(plansData)
      ? plansData
      : (Array.isArray(plansData?.data) ? plansData.data : null);
    if (!plans) {
      throw new Error('Invalid floor plan response: expected an array');
    }
    if (plans.some((plan: any) => typeof plan?.id !== 'string' || !plan.id)) {
      throw new Error('Invalid floor plan response: row has no id');
    }

    database.transaction(() => {
      billiardFloorPlanRepo.syncSnapshot(plans);
      for (const plan of plans) {
        const planLayouts = plan.layouts || plan.tableLayouts || [];
        if (planLayouts.length > 0) {
          billiardFloorPlanRepo.upsertLayouts(planLayouts);
        }
      }
    });
    database.markDirty();
    this.notifyRenderer('floor-plans');
    return plans.length;
  }

  private async syncSessionAfterMutation(
    op: string,
    path: string,
    result: any,
    token: string,
  ): Promise<void> {
    const pathSessionId = path.match(/\/billiard\/sessions\/([^/]+)/)?.[1];
    let snapshot = op === 'start_session' && result?.id ? result : null;
    const sessionId = snapshot?.id || pathSessionId;
    if (!sessionId) return;

    if (!snapshot) {
      try {
        snapshot = await apiClient.request(
          'GET',
          `/billiard/sessions/${sessionId}`,
          token,
        );
      } catch (err) {
        // The mutation already committed. Never surface this read-after-write
        // failure as a failed add/pause/transfer that the cashier may repeat.
        logger.warn(`[BilliardSync] Session reload after ${op} failed: ${err}`);
        return;
      }
    }
    if (!snapshot?.id) return;

    billiardSessionRepo.upsertOne(snapshot);
    if (canonicalBilliardSessionStatus(snapshot.status) === 'COMPLETED') {
      await this.flushPaymentJournal(`post-${op} session reconciliation`);
    } else {
      database.markDirty();
    }
    this.notifyRenderer('session-updated');
  }

  private notifyRenderer(type: string): void {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('billiard:data-updated', { type });
        }
      }
    } catch { /* ignore if electron not ready */ }
  }
}
