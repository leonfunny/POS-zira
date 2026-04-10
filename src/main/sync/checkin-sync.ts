import { apiClient } from '../network/api-client';
import { checkinRepo } from '../database/repos/checkin-repo';
import { salonCustomerRepo } from '../database/repos/salon-customer-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

/**
 * CheckinSync — Phase 1 of the log-based sync project.
 *
 * Pushes locally-created salon customers and check-ins to the backend server.
 * Mirrors the tri-state pattern used by OrderSync (0 pending → 2 in-flight → 1 synced)
 * so crashes and concurrent sync cycles can never cause a double-send.
 *
 * Customers are pushed before check-ins because a check-in can reference a
 * customer_id that the server needs to resolve.
 *
 * When the server endpoints are not deployed yet the api client returns null;
 * this class detects that, pauses the periodic sync for the current session,
 * and resumes on the next socket reconnect (see resetEndpointAvailability).
 */
export class CheckinSync {
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private endpointUnavailable = false;
  private hasLoggedUnavailable = false;

  /** Called from sync.module on socket:connected to retry after a server deploy. */
  resetEndpointAvailability(): void {
    this.endpointUnavailable = false;
    this.hasLoggedUnavailable = false;
  }

  private markEndpointUnavailable(reason: string): void {
    this.endpointUnavailable = true;
    if (!this.hasLoggedUnavailable) {
      logger.warn(`[CheckinSync] Server endpoint unavailable (${reason}) — pausing until reconnect`);
      this.hasLoggedUnavailable = true;
    }
  }

  /** Push one batch of pending customers + check-ins. Returns counts synced. */
  async syncPending(): Promise<{ customers: number; checkins: number }> {
    const token = getSecureAuthToken();
    if (!token) return { customers: 0, checkins: 0 };
    if (this.endpointUnavailable) return { customers: 0, checkins: 0 };

    let syncedCustomers = 0;
    let syncedCheckins = 0;

    // ── 1. Customers first (check-ins may reference them) ──────────────
    const pendingCustomers = salonCustomerRepo.getUnsynced();
    for (const c of pendingCustomers) {
      try {
        salonCustomerRepo.markSyncing(c.id);
        database.save();

        const res = await apiClient.createSalonCustomer(token, {
          id: c.id,
          name: c.name,
          phone: c.phone,
          email: c.email,
          birthday: c.birthday,
          notes: c.notes,
          marketingConsent: !!c.marketing_consent,
          preferredStaffId: c.preferred_staff_id,
          preferredStaffName: c.preferred_staff_name,
          visitCount: c.visit_count,
          lastVisitAt: c.last_visit_at,
          lastServiceName: c.last_service_name,
          createdAt: c.created_at,
        });

        if (res === null) {
          salonCustomerRepo.markSyncFailed(c.id);
          database.save();
          this.markEndpointUnavailable('POST /salon-customers returned 404/501');
          return { customers: syncedCustomers, checkins: syncedCheckins };
        }

        salonCustomerRepo.markSynced(c.id, res.customerId || c.id);
        database.save();
        syncedCustomers++;
      } catch (err: any) {
        salonCustomerRepo.markSyncFailed(c.id);
        database.save();
        logger.warn(`[CheckinSync] Failed to sync customer ${c.id}: ${err?.message ?? err}`);
      }
    }

    // ── 2. Check-ins ───────────────────────────────────────────────────
    const pendingCheckins = checkinRepo.getUnsynced();
    for (const ci of pendingCheckins) {
      try {
        checkinRepo.markSyncing(ci.id);
        database.save();

        const res = await apiClient.createCheckin(token, {
          id: ci.id,
          bookingNumber: ci.booking_number,
          customerId: ci.customer_id,
          customerName: ci.customer_name,
          customerPhone: ci.customer_phone,
          customerEmail: ci.customer_email,
          serviceId: ci.service_id,
          serviceName: ci.service_name,
          staffId: ci.staff_id,
          staffName: ci.staff_name,
          bookingId: ci.booking_id,
          bookingSource: ci.booking_source,
          isWalkin: !!ci.is_walkin,
          status: ci.status,
          checkedInAt: ci.checked_in_at,
          startedAt: ci.started_at,
          completedAt: ci.completed_at,
          estimatedDuration: ci.estimated_duration,
          notes: ci.notes,
          upsellsAdded: ci.upsells_added ? this.tryParseJson(ci.upsells_added) : null,
          services: ci.services_json ? this.tryParseJson(ci.services_json) : null,
        });

        if (res === null) {
          checkinRepo.markSyncFailed(ci.id);
          database.save();
          this.markEndpointUnavailable('POST /checkins returned 404/501');
          return { customers: syncedCustomers, checkins: syncedCheckins };
        }

        checkinRepo.markSynced(ci.id, res.checkinId || ci.id);
        database.save();
        syncedCheckins++;
      } catch (err: any) {
        checkinRepo.markSyncFailed(ci.id);
        database.save();
        logger.warn(`[CheckinSync] Failed to sync check-in ${ci.id}: ${err?.message ?? err}`);
      }
    }

    if (syncedCustomers + syncedCheckins > 0) {
      logger.info(
        `[CheckinSync] Synced ${syncedCustomers}/${pendingCustomers.length} customers, ${syncedCheckins}/${pendingCheckins.length} check-ins`,
      );
    }

    return { customers: syncedCustomers, checkins: syncedCheckins };
  }

  /** Start a 30-second periodic sync loop (mirrors OrderSync). */
  startPeriodicSync(): void {
    if (this.retryTimer) return;
    logger.info('[CheckinSync] Starting periodic sync (30s interval)');
    this.retryTimer = setInterval(async () => {
      try {
        await this.syncPending();
      } catch (err: any) {
        logger.debug(`[CheckinSync] Periodic sync error: ${err?.message ?? err}`);
      }
    }, 30000);
  }

  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
      logger.info('[CheckinSync] Periodic sync stopped');
    }
  }

  private tryParseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
}
