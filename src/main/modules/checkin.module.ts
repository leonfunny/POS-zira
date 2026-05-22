/**
 * CheckinModule — IPC handlers for salon customers, service popularity, and enhanced check-in.
 */

import { ipcMain } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import { SERVICE_TOKENS } from '../core/tokens';
import { salonCustomerRepo } from '../database/repos/salon-customer-repo';
import { servicePopularityRepo } from '../database/repos/service-popularity-repo';
import { checkinRepo } from '../database/repos/checkin-repo';
import { database } from '../database/database';
import { IPC_CHANNELS } from '../../shared/types';
import type { SyncLogService } from '../sync/sync-log-service';
import logger from '../logger';

export class CheckinModule extends BaseModule {
  readonly name = 'checkin';

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[CheckinModule] Initializing...');
    this.setState(ModuleState.READY);
  }

  registerIpcHandlers(): void {
    // Salon Customer CRUD
    ipcMain.handle(IPC_CHANNELS.SALON_CUSTOMER_SEARCH, (_e, query: string) => {
      try {
        return salonCustomerRepo.search(query);
      } catch (e: any) {
        logger.error('[CheckinModule] Customer search error:', e);
        return [];
      }
    });

    ipcMain.handle(IPC_CHANNELS.SALON_CUSTOMER_GET_BY_PHONE, (_e, phone: string) => {
      try {
        return salonCustomerRepo.getByPhone(phone);
      } catch (e: any) {
        logger.error('[CheckinModule] Customer getByPhone error:', e);
        return null;
      }
    });

    ipcMain.handle(IPC_CHANNELS.SALON_CUSTOMER_CREATE, (_e, data: any) => {
      try {
        const customer = salonCustomerRepo.upsertByPhone(data);
        database.markDirty();

        // Path B: write to sync log for outbound push
        try {
          const syncLog = this.container.getOptional<SyncLogService>(SERVICE_TOKENS.SYNC_LOG_SERVICE);
          if (syncLog && customer) {
            syncLog.writeLocalEntry('customer', customer.id, 'created', {
              id: customer.id,
              name: customer.name,
              phone: customer.phone,
              email: customer.email,
              birthday: customer.birthday,
              notes: customer.notes,
              marketingConsent: !!customer.marketing_consent,
              preferredStaffId: customer.preferred_staff_id,
              preferredStaffName: customer.preferred_staff_name,
              visitCount: customer.visit_count,
              lastVisitAt: customer.last_visit_at,
              lastServiceName: customer.last_service_name,
              createdAt: customer.created_at,
            });
          }
        } catch (e) { logger.debug('[CheckinModule] Sync log write failed for customer:', e); }

        return { success: true, data: customer };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.SALON_CUSTOMER_UPDATE, (_e, id: string, data: any) => {
      try {
        salonCustomerRepo.update(id, data);
        database.markDirty();
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.SALON_CUSTOMER_GET_HISTORY, (_e, customerId: string) => {
      try {
        return salonCustomerRepo.getHistory(customerId);
      } catch (e: any) {
        logger.error('[CheckinModule] History error:', e);
        return [];
      }
    });

    ipcMain.handle(IPC_CHANNELS.SALON_CUSTOMER_GET_RECOMMENDATIONS, (_e, customerId: string) => {
      try {
        return salonCustomerRepo.getRecommendations(customerId);
      } catch (e: any) {
        logger.error('[CheckinModule] Recommendations error:', e);
        return [];
      }
    });

    // Service Popularity
    ipcMain.handle(IPC_CHANNELS.SERVICE_POPULARITY_GET, () => {
      try {
        return servicePopularityRepo.getTop();
      } catch (e: any) {
        logger.error('[CheckinModule] Popularity error:', e);
        return [];
      }
    });

    ipcMain.handle(IPC_CHANNELS.SERVICE_POPULARITY_REFRESH, () => {
      try {
        servicePopularityRepo.refresh();
        database.markDirty();
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    // Enhanced check-in with customer tracking
    ipcMain.handle(IPC_CHANNELS.CHECKIN_CREATE_WITH_CUSTOMER, (_e, data: any) => {
      try {
        // Generate booking number (001/DDMM)
        const bookingNumber = checkinRepo.nextBookingNumber();
        data.booking_number = bookingNumber;

        // Create check-in
        checkinRepo.create(data);

        // Record customer visit if customer_id present
        if (data.customer_id && data.service_name) {
          salonCustomerRepo.recordVisit(
            data.customer_id,
            data.service_name,
            data.service_id,
            data.staff_name,
            data.staff_id,
            data.id,
          );
        }

        // Refresh popularity
        servicePopularityRepo.refresh();

        database.markDirty();

        // Path B: write to sync log for outbound push
        try {
          const syncLog = this.container.getOptional<SyncLogService>(SERVICE_TOKENS.SYNC_LOG_SERVICE);
          if (syncLog && data.id) {
            syncLog.writeLocalEntry('checkin', data.id, 'created', {
              id: data.id,
              bookingNumber,
              customerId: data.customer_id,
              customerName: data.customer_name,
              customerPhone: data.customer_phone,
              customerEmail: data.customer_email,
              serviceId: data.service_id,
              serviceName: data.service_name,
              staffId: data.staff_id,
              staffName: data.staff_name,
              bookingId: data.booking_id,
              bookingSource: data.booking_source,
              isWalkin: !!data.is_walkin,
              status: data.status || 'WAITING',
              checkedInAt: data.checked_in_at || new Date().toISOString(),
              estimatedDuration: data.estimated_duration,
              notes: data.notes,
            });
          }
        } catch (e) { logger.debug('[CheckinModule] Sync log write failed for check-in:', e); }

        return { success: true, bookingNumber };
      } catch (e: any) {
        logger.error('[CheckinModule] Create with customer error:', e);
        return { success: false, error: e.message };
      }
    });
  }
}
