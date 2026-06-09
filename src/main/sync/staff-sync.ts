import { apiClient } from '../network/api-client';
import { staffRepo, StaffRow, StaffWriteInput } from '../database/repos/staff-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

/**
 * StaffSync — pulls staff roster from server on reconnect.
 *
 * Uses authenticated /staff first so POS gets staff_profiles.id + users.id
 * and inactive rows. Falls back to the older public POS endpoint when needed.
 * Staff is server-authoritative; local stale rows are kept but marked inactive.
 */
export class StaffSync {
  private syncPromise: Promise<number> | null = null;

  async pullStaff(): Promise<number> {
    if (this.syncPromise) return this.syncPromise;

    this.syncPromise = this.doPullStaff();
    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  private async doPullStaff(): Promise<number> {
    const token = getSecureAuthToken();
    if (!token) return 0;

    const data = await apiClient.getStaffProfiles(token).catch((err: any) => {
      logger.debug(`[StaffSync] Authenticated staff endpoint unavailable, falling back: ${err?.message ?? err}`);
      return apiClient.getStaff(token);
    });

    if (data === null) {
      logger.debug('[StaffSync] Endpoint not available (404/501), skipping');
      return 0;
    }

    if (!Array.isArray(data) || data.length === 0) {
      logger.debug('[StaffSync] No staff data returned');
      return 0;
    }

    const mapped = data.map((s: any) => mapBackendStaff(s)).filter((s: StaffRow | null): s is StaffRow => s !== null);
    if (mapped.length === 0) {
      logger.debug('[StaffSync] No usable staff rows returned');
      return 0;
    }

    staffRepo.reconcileFromBackend(mapped);
    database.run(
      "INSERT OR REPLACE INTO sync_metadata (key, value, updated_at) VALUES ('staff_last_sync', ?, datetime('now'))",
      [new Date().toISOString()],
    );
    database.markDirty();

    logger.info(`[StaffSync] Pulled ${mapped.length} staff members from server`);
    return mapped.length;
  }

  async createStaff(input: StaffWriteInput): Promise<StaffRow | null> {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    const user = await apiClient.createStaffUser(token, {
      full_name: input.name,
      role: normalizeUserRole(input.role) || 'STAFF',
    });

    if (input.commissionRate !== undefined) {
      await apiClient.updateStaffCommission(token, user.id, input.commissionRate);
    }

    await this.pullStaffAfterMutation();
    return user?.id ? staffRepo.getByUserId(user.id) : null;
  }

  async updateStaff(id: string, input: StaffWriteInput): Promise<StaffRow | null> {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    let staff = staffRepo.getById(id);
    if (!staff?.user_id) {
      await this.pullStaff();
      staff = staffRepo.getById(id);
    }
    if (!staff?.user_id) throw new Error('Staff is not linked to a backend user yet. Refresh staff and try again.');

    await apiClient.updateStaffUser(token, staff.user_id, {
      full_name: input.name,
      role: normalizeUserRole(input.role) || undefined,
    });

    if (input.commissionRate !== undefined) {
      await apiClient.updateStaffCommission(token, staff.user_id, input.commissionRate);
    }

    if (input.isActive !== undefined && input.isActive !== (staff.is_active !== 0)) {
      await apiClient.setStaffProfileStatus(token, staff.user_id, input.isActive ? 'ACTIVE' : 'OFF');
    }

    await this.pullStaffAfterMutation();
    return staffRepo.getById(id);
  }

  async setStaffActive(id: string, active: boolean): Promise<StaffRow | null> {
    const token = getSecureAuthToken();
    if (!token) throw new Error('Not authenticated');

    let staff = staffRepo.getById(id);
    if (!staff?.user_id) {
      await this.pullStaff();
      staff = staffRepo.getById(id);
    }
    if (!staff?.user_id) throw new Error('Staff is not linked to a backend user yet. Refresh staff and try again.');

    await apiClient.setStaffProfileStatus(token, staff.user_id, active ? 'ACTIVE' : 'OFF');
    await this.pullStaffAfterMutation();
    return staffRepo.getById(id);
  }

  private async pullStaffAfterMutation(): Promise<number> {
    if (this.syncPromise) {
      try { await this.syncPromise; } catch {}
    }
    return this.pullStaff();
  }
}

function normalizeUserRole(role: string | null | undefined): string | undefined {
  const value = String(role || '').trim().toUpperCase();
  return ['OWNER', 'MANAGER', 'STAFF'].includes(value) ? value : undefined;
}

function normalizeCommissionRate(value: unknown): number {
  const rate = Number(value ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) return 0;

  // Backend StaffProfile stores 0.4 for 40%; local POS UI stores basis points.
  if (rate <= 1) return Math.round(rate * 10000);
  if (rate <= 100) return Math.round(rate * 100);
  return Math.round(rate);
}

function mapBackendStaff(s: any): StaffRow | null {
  const id = s.id;
  const user = s.user || {};
  const name = (s.name || s.fullName || user.full_name || `${s.firstName || ''} ${s.lastName || ''}`.trim()).trim();
  if (!id || !name) return null;

  const status = String(s.status || 'ACTIVE').toUpperCase();
  const userActive = user.is_active !== false;
  const rowActive = s.isActive !== undefined ? !!s.isActive : userActive && status === 'ACTIVE';
  const now = new Date().toISOString();

  return {
    id,
    user_id: s.userId ?? s.user_id ?? user.id ?? null,
    name,
    commission_rate: normalizeCommissionRate(s.commissionRate ?? s.commission_rate),
    is_active: rowActive ? 1 : 0,
    updated_at: s.updatedAt ?? s.updated_at ?? now,
    role: s.role ?? user.role ?? null,
    backend_synced_at: now,
  };
}
