/**
 * CheckinModule — IPC handlers for salon customers, service popularity, and enhanced check-in.
 */

import { ipcMain } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import { salonCustomerRepo } from '../database/repos/salon-customer-repo';
import { servicePopularityRepo } from '../database/repos/service-popularity-repo';
import { checkinRepo } from '../database/repos/checkin-repo';
import { database } from '../database/database';
import { IPC_CHANNELS } from '../../shared/types';
import logger from '../logger';

export class CheckinModule extends BaseModule {
  readonly name = 'checkin';

  constructor(_container: ServiceContainer) {
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
        database.save();
        return { success: true, data: customer };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle(IPC_CHANNELS.SALON_CUSTOMER_UPDATE, (_e, id: string, data: any) => {
      try {
        salonCustomerRepo.update(id, data);
        database.save();
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
        database.save();
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    // Enhanced check-in with customer tracking
    ipcMain.handle(IPC_CHANNELS.CHECKIN_CREATE_WITH_CUSTOMER, (_e, data: any) => {
      try {
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

        database.save();
        return { success: true };
      } catch (e: any) {
        logger.error('[CheckinModule] Create with customer error:', e);
        return { success: false, error: e.message };
      }
    });
  }
}
