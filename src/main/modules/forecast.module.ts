import { ipcMain } from 'electron';
import { BaseModule, ModuleState } from '../core/module';
import { ForecastService } from '../forecast/forecast-service';
import { IPC_CHANNELS } from '../../shared/types';
import type {
  ForecastOrderDraftCreateInput,
  ForecastRecommendationDTO,
  ForecastRunOptions,
  ReplenishmentPolicyDTO,
} from '../../shared/types';
import logger from '../logger';

export class ForecastModule extends BaseModule {
  readonly name = 'forecast';
  private service: ForecastService | null = null;

  async init(): Promise<void> {
    this.service = new ForecastService();
    logger.info('[ForecastModule] Initialized');
    this.setState(ModuleState.READY);
  }

  registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.FORECAST_GET_RECOMMENDATIONS, (_event, options?: ForecastRunOptions) => {
      return this.withService((service) => service.getRecommendations(options));
    });

    ipcMain.handle(IPC_CHANNELS.FORECAST_RECOMPUTE, (_event, options?: ForecastRunOptions) => {
      return this.withService((service) => service.recompute(options));
    });

    ipcMain.handle(IPC_CHANNELS.FORECAST_GET_POLICIES, (_event, variantIds?: string[]) => {
      return this.withService((service) => service.getPolicies(variantIds));
    });

    ipcMain.handle(
      IPC_CHANNELS.FORECAST_SAVE_POLICY,
      (_event, policy: Partial<ReplenishmentPolicyDTO> & { variantId: string }) => {
        return this.withService((service) => service.savePolicy(policy));
      },
    );

    ipcMain.handle(IPC_CHANNELS.FORECAST_EXPORT_CSV, (_event, recommendations: ForecastRecommendationDTO[]) => {
      return this.withService((service) => service.exportCsv(recommendations));
    });

    ipcMain.handle(IPC_CHANNELS.FORECAST_GET_TODAY_SALES, (_event, date?: string) => {
      return this.withService((service) => service.getTodaySales(date));
    });

    ipcMain.handle(IPC_CHANNELS.FORECAST_CREATE_ORDER_DRAFT, (_event, input: ForecastOrderDraftCreateInput) => {
      return this.withService((service) => service.createOrderDraft(input));
    });

    ipcMain.handle(IPC_CHANNELS.FORECAST_LIST_ORDER_DRAFTS, (_event, limit?: number) => {
      return this.withService((service) => service.listOrderDrafts(limit));
    });

    ipcMain.handle(IPC_CHANNELS.FORECAST_GET_ORDER_DRAFT, (_event, id: string) => {
      return this.withService((service) => service.getOrderDraft(id));
    });
  }

  async start(): Promise<void> {
    this.setState(ModuleState.RUNNING);
  }

  async stop(): Promise<void> {
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> {
    this.service = null;
    this.setState(ModuleState.DESTROYED);
  }

  private withService<T>(fn: (service: ForecastService) => T): { success: boolean; data?: T; error?: string } {
    if (!this.service) {
      return { success: false, error: 'Forecast service not initialized' };
    }
    try {
      return { success: true, data: fn(this.service) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[ForecastModule] IPC failed:', error);
      return { success: false, error: message };
    }
  }
}
