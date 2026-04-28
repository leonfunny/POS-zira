import { app, ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { BaseModule, ModuleState } from '../core/module';
import { database } from '../database/database';
import { LocalBackupService } from '../database/backup-service';
import { getConfig, setConfig } from '../config/store';
import { IPC_CHANNELS } from '../../shared/types';
import logger from '../logger';

export class BackupModule extends BaseModule {
  readonly name = 'backup';
  private service: LocalBackupService | null = null;

  async init(): Promise<void> {
    const userDataDir = app.getPath('userData');
    const backupDir = process.env.ELECTRON_USER_DATA_DIR
      ? path.join(process.env.ELECTRON_USER_DATA_DIR, 'Zira AI Backups')
      : path.join(app.getPath('documents'), 'Zira AI Backups');
    this.service = new LocalBackupService({
      backupDir,
      userDataDir,
      now: () => new Date(),
      flushDatabase: () => database.flushToDiskForBackup(),
      getConfig,
      setConfig,
      fs,
      logger,
    });
    logger.info('[BackupModule] Initialized');
    this.setState(ModuleState.READY);
  }

  registerIpcHandlers(): void {
    ipcMain.handle(IPC_CHANNELS.BACKUP_GET_STATUS, () => {
      return this.service?.getStatus() || null;
    });

    ipcMain.handle(IPC_CHANNELS.BACKUP_RUN_NOW, async () => {
      if (!this.service) return { success: false, error: 'Backup service not initialized' };
      return this.service.runBackupNow('manual');
    });

    ipcMain.handle(IPC_CHANNELS.BACKUP_LIST, async () => {
      if (!this.service) return [];
      return this.service.listBackupFiles().map(({ name, path, createdAt, sizeBytes, isLatest }) => ({
        name,
        path,
        createdAt,
        sizeBytes,
        isLatest,
      }));
    });

    ipcMain.handle(IPC_CHANNELS.BACKUP_PREPARE_RESTORE, async (_event, backupPath: string) => {
      if (!this.service) return { success: false, error: 'Backup service not initialized' };
      return this.service.prepareRestore(backupPath);
    });

    ipcMain.handle(IPC_CHANNELS.BACKUP_OPEN_FOLDER, async () => {
      if (!this.service) return { success: false, error: 'Backup service not initialized' };
      const backupDir = this.service.getStatus().backupDir;
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        const result = await shell.openPath(backupDir);
        return result ? { success: false, error: result } : { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    ipcMain.handle(IPC_CHANNELS.BACKUP_OPEN_DATA_FOLDER, async () => {
      try {
        const result = await shell.openPath(app.getPath('userData'));
        return result ? { success: false, error: result } : { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  async start(): Promise<void> {
    this.service?.start();
    this.setState(ModuleState.RUNNING);
  }

  async stop(): Promise<void> {
    this.service?.stop();
    this.setState(ModuleState.STOPPED);
  }
}
