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

const MAX_QUEUE_RETRIES = 3;

export class BilliardSync {
  private dashboardTimer: ReturnType<typeof setInterval> | null = null;
  private isOnline = false;
  private restaurantCombosCache: any[] = [];

  // ── Reference data sync (login/reconnect) ────────────

  async fullSync(): Promise<{ resources: number; floors: number; combos: number }> {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    logger.info('[BilliardSync] Starting full sync...');

    let resources = 0;
    let floors = 0;
    let combos = 0;

    try {
      // 1. Dashboard data (resources + sessions + layouts)
      const dashboard = await apiClient.request('GET', '/billiard/dashboard', token);
      if (dashboard) {
        const dashResources = dashboard.resources || dashboard.tables || [];
        if (dashResources.length > 0) {
          database.transaction(() => {
            billiardResourceRepo.upsertMany(dashResources);
          });
          resources = dashResources.length;
        }

        // Sessions from dashboard
        const sessions = dashboard.sessions || dashboard.activeSessions || [];
        database.transaction(() => {
          billiardSessionRepo.clearCompleted();
          if (sessions.length > 0) {
            billiardSessionRepo.upsertMany(sessions);
          }
        });

        // Layouts from dashboard (if embedded)
        const layouts = dashboard.layouts || [];
        if (layouts.length > 0) {
          database.transaction(() => {
            billiardFloorPlanRepo.upsertLayouts(layouts);
          });
        }
      }
    } catch (err) {
      logger.warn(`[BilliardSync] Dashboard sync failed: ${err}`);
    }

    try {
      // 2. Floor plans
      const plansData = await apiClient.request('GET', '/billiard/floor-plans', token);
      const plans = Array.isArray(plansData) ? plansData : (plansData?.data || []);
      if (plans.length > 0) {
        database.transaction(() => {
          billiardFloorPlanRepo.upsertMany(plans);
          // Extract layouts from floor plan responses
          for (const plan of plans) {
            const planLayouts = plan.layouts || plan.tableLayouts || [];
            if (planLayouts.length > 0) {
              billiardFloorPlanRepo.upsertLayouts(planLayouts);
            }
          }
        });
        floors = plans.length;
      }
    } catch (err) {
      logger.warn(`[BilliardSync] Floor plans sync failed: ${err}`);
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

    // Record sync timestamp
    database.run(
      "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('billiard_last_sync', ?, datetime('now'))",
      [new Date().toISOString()],
    );
    database.markDirty();

    logger.info(`[BilliardSync] Full sync done: ${resources} resources, ${floors} floors, ${combos} combos`);
    return { resources, floors, combos };
  }

  // ── Dashboard cache refresh ───────────────────────────

  async refreshDashboard(): Promise<void> {
    const token = getSecureAuthToken();
    if (!token) return;

    try {
      const dashboard = await apiClient.request('GET', '/billiard/dashboard', token);
      if (!dashboard) return;

      // Update sessions
      const sessions = dashboard.sessions || dashboard.activeSessions || [];
      database.transaction(() => {
        billiardSessionRepo.clearCompleted();
        billiardSessionRepo.upsertMany(sessions);
      });

      // Update resource statuses if present
      const resources = dashboard.resources || dashboard.tables || [];
      if (resources.length > 0) {
        database.transaction(() => {
          billiardResourceRepo.upsertMany(resources);
        });
      }

      // Update layouts if present
      const layouts = dashboard.layouts || [];
      if (layouts.length > 0) {
        database.transaction(() => {
          billiardFloorPlanRepo.upsertLayouts(layouts);
        });
      }

      database.markDirty();
      this.notifyRenderer('dashboard');
    } catch (err) {
      logger.debug(`[BilliardSync] Dashboard refresh failed: ${err}`);
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
    if (this.isOnline) {
      // Online: call API directly, update local cache from response
      const token = getSecureAuthToken();
      if (!token) throw new Error('Not authenticated');

      try {
        const result = await apiClient.request(method, path, token, body);

        // Trigger a quick dashboard refresh to update local cache
        // Run in background — don't block the mutation response
        this.refreshDashboard().catch((e) => { logger.debug('[BilliardSync] post-mutation refresh failed:', e?.message); });

        return result;
      } catch (err: any) {
        // Network error while isOnline was true (socket disconnect lags behind)
        // Fall through to offline queue instead of losing the mutation
        const msg = (err.message || '').toLowerCase();
        const isNetworkError = msg.includes('fetch') || msg.includes('network')
          || msg.includes('econnrefused') || msg.includes('timeout')
          || msg.includes('abort') || msg.includes('socket');
        if (!isNetworkError) {
          // Server-side error (400, 422, 500) — don't queue, propagate to UI
          throw err;
        }
        logger.warn(`[BilliardSync] Online mutation failed (network), falling back to queue: ${err.message}`);
        this.isOnline = false;
      }
    }

    // Offline (or network-failed fallback): queue the mutation
    const queueId = billiardMutationRepo.enqueue(op, method, path, body);

    // Optimistic local update so UI reflects the change immediately
    this.applyOptimisticUpdate(op, path, body);

    database.markDirty();

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
            status: 'active',
            billingMode: body.billingMode || 'per_minute',
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
            "UPDATE billiard_sessions SET status = 'paused', paused_at = ? WHERE id = ?",
            [new Date().toISOString(), sessionId],
          );
          break;
        }
        case 'resume_session': {
          if (!sessionId) break;
          database.run(
            "UPDATE billiard_sessions SET status = 'active', paused_at = NULL WHERE id = ?",
            [sessionId],
          );
          break;
        }
        case 'end_session': {
          if (!sessionId) break;
          database.run(
            "UPDATE billiard_sessions SET status = 'ended', ended_at = ? WHERE id = ?",
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
          if (!sessionId || !body?.resourceId) break;
          database.run(
            'UPDATE billiard_sessions SET resource_id = ? WHERE id = ?',
            [body.resourceId, sessionId],
          );
          break;
        }
        case 'process_payment': {
          if (!sessionId) break;
          database.run(
            "UPDATE billiard_sessions SET status = 'ended', ended_at = ? WHERE id = ?",
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
            if (sets.length > 0) {
              vals.push(fpMatch[1]);
              database.run(`UPDATE billiard_floor_plans SET ${sets.join(', ')} WHERE id = ?`, vals);
            }
          }
          break;
        }
        case 'upsert_layout': {
          // body has resourceId + layout fields
          if (body?.resourceId) {
            const existing = database.get<{ id: string }>(
              'SELECT id FROM billiard_table_layouts WHERE resource_id = ?',
              [body.resourceId],
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
    const token = getSecureAuthToken();
    if (!token) return { ok: 0, failed: 0 };

    const pending = billiardMutationRepo.getPending();
    if (pending.length === 0) return { ok: 0, failed: 0 };

    logger.info(`[BilliardSync] Replaying ${pending.length} queued mutations...`);

    let ok = 0;
    let failed = 0;

    for (const entry of pending) {
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

      return {
        id: r.id,
        name: r.name,
        code: r.code,
        typeId: r.type_id,
        typeName: r.type_name,
        pricingRules: JSON.parse(r.pricing_rules || '[]'),
        isActive: r.is_active === 1,
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
        // Session
        session: session ? {
          id: session.id,
          status: session.status,
          billingMode: session.billing_mode,
          guestCount: session.guest_count,
          startedAt: session.started_at,
          pausedAt: session.paused_at,
          endedAt: session.ended_at,
          totalMinutes: session.total_minutes,
          totalCharges: session.total_charges,
          comboId: session.combo_id,
          notes: session.notes,
          items: (session.items || []).map((i: any) => ({
            id: i.id,
            variantId: i.variant_id,
            name: i.name,
            quantity: i.quantity,
            unitPrice: i.unit_price,
          })),
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
      sessions: sessions.map((s) => ({
        id: s.id,
        resourceId: s.resource_id,
        status: s.status,
        billingMode: s.billing_mode,
        guestCount: s.guest_count,
        startedAt: s.started_at,
        pausedAt: s.paused_at,
        totalMinutes: s.total_minutes,
        totalCharges: s.total_charges,
        comboId: s.combo_id,
        items: (s.items || []).map((i: any) => ({
          id: i.id,
          variantId: i.variant_id,
          name: i.name,
          quantity: i.quantity,
          unitPrice: i.unit_price,
        })),
      })),
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

  getRestaurantCombos(): any[] {
    return this.restaurantCombosCache;
  }

  getSyncStatus(): { pending: number; lastSync: string | null; online: boolean } {
    const pending = billiardMutationRepo.countPending();
    const row = database.get<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'billiard_last_sync'",
    );
    return {
      pending,
      lastSync: row?.value ?? null,
      online: this.isOnline,
    };
  }

  // ── Helpers ───────────────────────────────────────────

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
