import { apiClient } from '../network/api-client';
import { staffRepo } from '../database/repos/staff-repo';
import { database } from '../database/database';
import { getSecureAuthToken } from '../config/store';
import logger from '../logger';

/**
 * StaffSync — pulls staff roster from server on reconnect.
 *
 * Uses existing backend endpoint: GET /public/pos/:salonSlug/staff
 * Handles both old shape (fullName, staffNumber) and new shape (name, commissionRate, role).
 * Staff is server-authoritative; client never pushes staff changes.
 */
export class StaffSync {
  async pullStaff(): Promise<number> {
    const token = getSecureAuthToken();
    if (!token) return 0;

    const data = await apiClient.getStaff(token);
    if (data === null) {
      logger.debug('[StaffSync] Endpoint not available (404/501), skipping');
      return 0;
    }

    if (!Array.isArray(data) || data.length === 0) {
      logger.debug('[StaffSync] No staff data returned');
      return 0;
    }

    const mapped = data.map((s: any) => ({
      id: s.id,
      // Handle both old shape (fullName) and new shape (name)
      name: s.name || s.fullName || `${s.firstName || ''} ${s.lastName || ''}`.trim() || 'Staff',
      commission_rate: s.commissionRate ?? s.commission_rate ?? 0,
      is_active: s.isActive !== undefined ? (s.isActive ? 1 : 0) : 1,
      updated_at: s.updatedAt ?? null,
      role: s.role ?? null,
      backend_synced_at: new Date().toISOString(),
    }));

    staffRepo.upsertMany(mapped);
    database.save();

    logger.info(`[StaffSync] Pulled ${mapped.length} staff members from server`);
    return mapped.length;
  }
}
