import { ipcMain, dialog, app } from 'electron';
import { join } from 'path';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import { getConfig, setConfig } from '../config/store';
import { IPC_CHANNELS, type AgentConfig } from '../../shared/types';
import { AdVideoStore } from '../ad-display/ad-video-store';
import { AdDisplayServer } from '../ad-display/ad-display-server';
import { AdMdnsAdvertiser } from '../ad-display/ad-mdns';
import { AdTvBrowser } from '../ad-display/ad-tv-browser';
import { AD_DISPLAY_DEFAULTS, type TvAdConfig } from '../ad-display/ad-types';
import logger from '../logger';

export class AdDisplayModule extends BaseModule {
  readonly name = 'ad-display';
  private store: AdVideoStore;
  private server: AdDisplayServer;
  private mdns = new AdMdnsAdvertiser();
  private tvBrowser = new AdTvBrowser();

  constructor(private readonly container: ServiceContainer) {
    super();
    this.store = new AdVideoStore(join(app.getPath('userData'), 'ad-videos'));
    this.server = new AdDisplayServer(() => this.tvConfig(), this.store);
  }

  private tvConfig(): TvAdConfig {
    const c = getConfig() as Partial<TvAdConfig>;
    return { ...AD_DISPLAY_DEFAULTS, ...c } as TvAdConfig;
  }

  async start(): Promise<void> {
    this.tvBrowser.start();
    await this.applyAll();
    this.setState(ModuleState.RUNNING);
  }

  async stop(): Promise<void> {
    await this.server.stop();
    this.mdns.stop();
    this.tvBrowser.stop();
    this.setState(ModuleState.STOPPED);
  }

  private async applyAll(): Promise<void> {
    const cfg = this.tvConfig();
    await this.server.applyConfig();
    const status = this.server.getStatus();
    if (cfg.tvAdEnabled && status.running && status.port) {
      const name = (getConfig() as any).salonName || (getConfig() as any).deviceName || 'POS';
      this.mdns.start(status.port, String(name), status.primaryIp);
    } else {
      this.mdns.stop();
    }
  }

  registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.TV_AD_GET_STATUS, () => this.server.getStatus());
    ipcMain.handle(IPC_CHANNELS.TV_AD_GET_DEVICES, () => this.tvBrowser.getDevices());

    ipcMain.handle(IPC_CHANNELS.TV_AD_PICK_VIDEO, async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'] as const,
        filters: [{ name: 'Video', extensions: ['mp4', 'm4v', 'mov'] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      try {
        return this.store.addVideo(result.filePaths[0]);
      } catch (e: any) {
        logger.error('[AdDisplay] addVideo failed:', e?.message || e);
        throw e;
      }
    });

    ipcMain.handle(IPC_CHANNELS.TV_AD_SAVE, async (_e, partial: Partial<AgentConfig>) => {
      const before = this.tvConfig().tvAdPlaylist || [];
      setConfig(partial);
      const after = this.tvConfig().tvAdPlaylist || [];
      const afterIds = new Set(after.map(v => v.id));
      for (const v of before) {
        if (!afterIds.has(v.id)) this.store.removeVideo(v.filename);
      }
      const portChanged = partial.tvAdPort !== undefined;
      const enableChanged = partial.tvAdEnabled !== undefined;
      if (portChanged || enableChanged) {
        await this.server.stop();
        this.mdns.stop();
      }
      await this.applyAll();
      this.server.broadcastChanged();
      return { ok: true };
    });
  }
}
