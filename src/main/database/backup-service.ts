import path from 'path';

export interface BackupFlushResult {
  success: boolean;
  dbPath?: string;
  error?: string;
}

export interface BackupRunResult {
  success: boolean;
  path?: string;
  error?: string;
  createdAt: string;
}

export interface BackupStatus {
  backupDir: string;
  lastStatus?: 'success' | 'failed';
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastPath?: string;
  lastError?: string;
}

export interface BackupFileInfo {
  path: string;
  timestamp: Date;
}

interface BackupConfig {
  backupLastStatus?: 'success' | 'failed';
  backupLastRunAt?: string;
  backupLastSuccessAt?: string;
  backupLastPath?: string;
  backupLastError?: string;
}

interface BackupFs {
  mkdirSync(path: string, options?: { recursive?: boolean }): unknown;
  copyFileSync(from: string, to: string): void;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
  statSync(path: string): { mtimeMs: number };
  unlinkSync(path: string): void;
}

interface BackupLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface LocalBackupServiceDeps {
  backupDir: string;
  now: () => Date;
  flushDatabase: () => BackupFlushResult;
  getConfig: () => BackupConfig;
  setConfig: (patch: Partial<BackupConfig>) => void;
  fs: BackupFs;
  logger: BackupLogger;
  setTimeout?: typeof setTimeout;
  setInterval?: typeof setInterval;
  clearTimeout?: typeof clearTimeout;
  clearInterval?: typeof clearInterval;
  startupDelayMs?: number;
  dailyIntervalMs?: number;
}

const BACKUP_NAME_RE = /^pos-backup-(\d{8})-(\d{6})(?:-\d{3})?\.db$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export class LocalBackupService {
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private dailyTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: LocalBackupServiceDeps) {}

  createBackupFileName(date = this.deps.now()): string {
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `pos-backup-${yyyy}${mm}${dd}-${hh}${min}${ss}.db`;
  }

  getStatus(): BackupStatus {
    const config = this.deps.getConfig();
    return {
      backupDir: this.deps.backupDir,
      lastStatus: config.backupLastStatus,
      lastRunAt: config.backupLastRunAt,
      lastSuccessAt: config.backupLastSuccessAt,
      lastPath: config.backupLastPath,
      lastError: config.backupLastError,
    };
  }

  start(): void {
    const setTimeoutFn = this.deps.setTimeout || setTimeout;
    const setIntervalFn = this.deps.setInterval || setInterval;
    const startupDelayMs = this.deps.startupDelayMs ?? 10_000;
    const dailyIntervalMs = this.deps.dailyIntervalMs ?? DAY_MS;

    this.startupTimer = setTimeoutFn(() => {
      this.runStartupCatchupIfDue().catch((error) => {
        this.deps.logger.warn('[Backup] Startup catch-up backup crashed:', error);
      });
    }, startupDelayMs);

    this.dailyTimer = setIntervalFn(() => {
      this.runBackupIfDue('scheduled').catch((error) => {
        this.deps.logger.warn('[Backup] Scheduled backup crashed:', error);
      });
    }, dailyIntervalMs);
  }

  stop(): void {
    const clearTimeoutFn = this.deps.clearTimeout || clearTimeout;
    const clearIntervalFn = this.deps.clearInterval || clearInterval;
    if (this.startupTimer) {
      clearTimeoutFn(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.dailyTimer) {
      clearIntervalFn(this.dailyTimer);
      this.dailyTimer = null;
    }
  }

  async runStartupCatchupIfDue(): Promise<BackupRunResult | null> {
    return this.runBackupIfDue('startup');
  }

  async runBackupIfDue(reason: 'startup' | 'scheduled'): Promise<BackupRunResult | null> {
    if (!this.isBackupDue()) return null;
    const result = await this.runBackupNow(reason);
    if (!result.success) {
      const label = reason === 'startup' ? 'Startup catch-up' : 'Scheduled';
      this.deps.logger.warn(`[Backup] ${label} backup failed:`, result.error);
    }
    return result;
  }

  async runBackupNow(reason: 'manual' | 'startup' | 'scheduled' = 'manual'): Promise<BackupRunResult> {
    const createdAt = this.deps.now().toISOString();
    const flush = this.deps.flushDatabase();

    if (!flush.success || !flush.dbPath) {
      const error = flush.error || 'Database flush failed before backup';
      this.recordFailure(createdAt, error);
      return { success: false, error, createdAt };
    }

    try {
      this.deps.fs.mkdirSync(this.deps.backupDir, { recursive: true });
      const backupPath = this.createUniqueBackupPath();
      this.deps.fs.copyFileSync(flush.dbPath, backupPath);
      this.cleanupRetention();
      this.deps.setConfig({
        backupLastStatus: 'success',
        backupLastRunAt: createdAt,
        backupLastSuccessAt: createdAt,
        backupLastPath: backupPath,
        backupLastError: '',
      });
      this.deps.logger.info(`[Backup] ${reason} database backup created: ${backupPath}`);
      return { success: true, path: backupPath, createdAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordFailure(createdAt, message);
      return { success: false, error: message, createdAt };
    }
  }

  private createUniqueBackupPath(): string {
    const baseName = this.createBackupFileName();
    const basePath = path.join(this.deps.backupDir, baseName);
    if (!this.deps.fs.existsSync(basePath)) return basePath;

    const stem = baseName.replace(/\.db$/, '');
    for (let i = 1; i <= 999; i++) {
      const candidate = path.join(this.deps.backupDir, `${stem}-${String(i).padStart(3, '0')}.db`);
      if (!this.deps.fs.existsSync(candidate)) return candidate;
    }

    throw new Error(`No available backup filename for ${baseName}`);
  }

  listBackupFiles(): BackupFileInfo[] {
    let names: string[];
    try {
      names = this.deps.fs.readdirSync(this.deps.backupDir);
    } catch {
      return [];
    }

    return names
      .map((name) => {
        const timestamp = this.parseBackupTimestamp(name);
        if (!timestamp) return null;
        return { path: path.join(this.deps.backupDir, name), timestamp };
      })
      .filter((file): file is BackupFileInfo => !!file)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  selectBackupsToKeep(files: BackupFileInfo[]): BackupFileInfo[] {
    const sorted = [...files].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const keep = new Map<string, BackupFileInfo>();

    for (const file of sorted.slice(0, 30)) {
      keep.set(file.path, file);
    }

    const monthlySeen = new Set<string>();
    for (const file of sorted) {
      const monthKey = `${file.timestamp.getFullYear()}-${String(file.timestamp.getMonth() + 1).padStart(2, '0')}`;
      if (monthlySeen.has(monthKey)) continue;
      monthlySeen.add(monthKey);
      if (monthlySeen.size <= 12) {
        keep.set(file.path, file);
      }
      if (monthlySeen.size >= 12) break;
    }

    return [...keep.values()].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  cleanupRetention(): void {
    const files = this.listBackupFiles();
    const keep = new Set(this.selectBackupsToKeep(files).map((file) => file.path));
    for (const file of files) {
      if (keep.has(file.path)) continue;
      try {
        this.deps.fs.unlinkSync(file.path);
      } catch (error) {
        this.deps.logger.warn('[Backup] Failed to remove old backup:', file.path, error);
      }
    }
  }

  private isBackupDue(): boolean {
    const lastSuccessAt = this.deps.getConfig().backupLastSuccessAt;
    if (!lastSuccessAt) return true;
    const last = Date.parse(lastSuccessAt);
    if (!Number.isFinite(last)) return true;
    return this.deps.now().getTime() - last >= DAY_MS;
  }

  private recordFailure(createdAt: string, error: string): void {
    this.deps.setConfig({
      backupLastStatus: 'failed',
      backupLastRunAt: createdAt,
      backupLastError: error,
    });
    this.deps.logger.warn('[Backup] Database backup failed:', error);
  }

  private parseBackupTimestamp(name: string): Date | null {
    const match = name.match(BACKUP_NAME_RE);
    if (!match) return null;
    const [, datePart, timePart] = match;
    const year = Number(datePart.slice(0, 4));
    const month = Number(datePart.slice(4, 6));
    const day = Number(datePart.slice(6, 8));
    const hour = Number(timePart.slice(0, 2));
    const minute = Number(timePart.slice(2, 4));
    const second = Number(timePart.slice(4, 6));
    const date = new Date(year, month - 1, day, hour, minute, second);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
