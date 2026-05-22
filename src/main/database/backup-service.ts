import path from 'path';
import { readFileSync } from 'fs';
import initSqlJs from 'sql.js';

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

export type BackupRunReason =
  | 'manual'
  | 'startup'
  | 'scheduled'
  | 'pre-full-product-sync'
  | 'pre-clear-salon-data';

export interface BackupStatus {
  backupDir: string;
  lastStatus?: 'success' | 'failed';
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastPath?: string;
  lastError?: string;
  pendingRestorePath?: string;
  pendingRestoreSourcePath?: string;
  pendingRestoreRequestedAt?: string;
  restoreLastStatus?: 'pending' | 'success' | 'failed';
  restoreLastError?: string;
  restoreLastSourcePath?: string;
  restoreLastSafetyBackupPath?: string;
  restoreLastAppliedAt?: string;
}

export interface BackupFileInfo {
  name?: string;
  path: string;
  timestamp: Date;
  createdAt?: string;
  sizeBytes?: number;
  isLatest?: boolean;
}

export interface BackupListItem {
  name: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  isLatest: boolean;
}

export interface BackupRestoreResult {
  success: boolean;
  error?: string;
}

export interface DatabaseValidationResult {
  valid: boolean;
  error?: string;
}

interface BackupConfig {
  backupLastStatus?: 'success' | 'failed';
  backupLastRunAt?: string;
  backupLastSuccessAt?: string;
  backupLastPath?: string;
  backupLastError?: string;
  backupPendingRestorePath?: string;
  backupPendingRestoreSourcePath?: string;
  backupPendingRestoreRequestedAt?: string;
  backupRestoreLastStatus?: 'pending' | 'success' | 'failed';
  backupRestoreLastError?: string;
  backupRestoreLastSourcePath?: string;
  backupRestoreLastSafetyBackupPath?: string;
  backupRestoreLastAppliedAt?: string;
}

interface BackupFs {
  mkdirSync(path: string, options?: { recursive?: boolean }): unknown;
  copyFileSync(from: string, to: string): void;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
  statSync(path: string): { mtimeMs: number; size?: number };
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
}

interface BackupLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface LocalBackupServiceDeps {
  backupDir: string;
  userDataDir: string;
  now: () => Date;
  flushDatabase: () => Promise<BackupFlushResult> | BackupFlushResult;
  getConfig: () => BackupConfig;
  setConfig: (patch: Partial<BackupConfig>) => void;
  validateDatabaseFile?: (path: string) => DatabaseValidationResult | Promise<DatabaseValidationResult>;
  fs: BackupFs;
  logger: BackupLogger;
  setTimeout?: typeof setTimeout;
  setInterval?: typeof setInterval;
  clearTimeout?: typeof clearTimeout;
  clearInterval?: typeof clearInterval;
  startupDelayMs?: number;
  dailyIntervalMs?: number;
}

const BACKUP_NAME_RE = /^pos-backup-(\d{8})-(\d{6})(?:-(\d{3}))?\.db$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const PENDING_RESTORE_FILENAME = 'pending-restore.db';

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
      pendingRestorePath: config.backupPendingRestorePath,
      pendingRestoreSourcePath: config.backupPendingRestoreSourcePath,
      pendingRestoreRequestedAt: config.backupPendingRestoreRequestedAt,
      restoreLastStatus: config.backupRestoreLastStatus,
      restoreLastError: config.backupRestoreLastError,
      restoreLastSourcePath: config.backupRestoreLastSourcePath,
      restoreLastSafetyBackupPath: config.backupRestoreLastSafetyBackupPath,
      restoreLastAppliedAt: config.backupRestoreLastAppliedAt,
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

  async runBackupIfDue(reason: Extract<BackupRunReason, 'startup' | 'scheduled'>): Promise<BackupRunResult | null> {
    if (!this.isBackupDue()) return null;
    const result = await this.runBackupNow(reason);
    if (!result.success) {
      const label = reason === 'startup' ? 'Startup catch-up' : 'Scheduled';
      this.deps.logger.warn(`[Backup] ${label} backup failed:`, result.error);
    }
    return result;
  }

  async runBackupNow(reason: BackupRunReason = 'manual'): Promise<BackupRunResult> {
    const createdAt = this.deps.now().toISOString();
    const flush = await this.deps.flushDatabase();

    if (!flush.success || !flush.dbPath) {
      const error = flush.error || 'Database flush failed before backup';
      this.recordFailure(createdAt, error);
      return { success: false, error, createdAt };
    }

    try {
      this.deps.fs.mkdirSync(this.deps.backupDir, { recursive: true });
      const backupPath = this.createUniqueBackupPath();
      // Atomic write: copy to .tmp then rename, so a crash mid-copy never
      // leaves a half-written file at backupPath that future restores would
      // pick up as valid.
      const tmpPath = `${backupPath}.tmp`;
      this.deps.fs.copyFileSync(flush.dbPath, tmpPath);
      this.deps.fs.renameSync(tmpPath, backupPath);
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

    const files: BackupFileInfo[] = [];
    for (const name of names) {
      const timestamp = this.parseBackupTimestamp(name);
      if (!timestamp) continue;
      const filePath = path.join(this.deps.backupDir, name);
      let sizeBytes = 0;
      try {
        sizeBytes = this.deps.fs.statSync(filePath).size || 0;
      } catch {
        sizeBytes = 0;
      }
      files.push({
        name,
        path: filePath,
        timestamp,
        createdAt: timestamp.toISOString(),
        sizeBytes,
        isLatest: false,
      });
    }

    files.sort((a, b) => {
      const byTime = b.timestamp.getTime() - a.timestamp.getTime();
      if (byTime !== 0) return byTime;
      return getBackupSuffixIndex(b.name || path.basename(b.path)) - getBackupSuffixIndex(a.name || path.basename(a.path));
    });

    if (files.length > 0) {
      files[0].isLatest = true;
    }

    return files;
  }

  async prepareRestore(requestedPath: string): Promise<BackupRestoreResult> {
    const validation = await this.validateRestoreCandidate(requestedPath);
    if (!validation.success || !validation.path) return validation;

    const pendingRestorePath = path.join(this.deps.userDataDir, PENDING_RESTORE_FILENAME);
    try {
      this.deps.fs.mkdirSync(this.deps.userDataDir, { recursive: true });
      this.deps.fs.copyFileSync(validation.path, pendingRestorePath);
      this.deps.setConfig({
        backupPendingRestorePath: pendingRestorePath,
        backupPendingRestoreSourcePath: validation.path,
        backupPendingRestoreRequestedAt: this.deps.now().toISOString(),
        backupRestoreLastStatus: 'pending',
        backupRestoreLastError: '',
      });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.setConfig({
        backupRestoreLastStatus: 'failed',
        backupRestoreLastError: message,
      });
      return { success: false, error: message };
    }
  }

  private async validateRestoreCandidate(requestedPath: string): Promise<BackupRestoreResult & { path?: string }> {
    const resolved = path.resolve(requestedPath);
    if (!isPathInsideDirectory(resolved, this.deps.backupDir)) {
      return { success: false, error: 'Backup path must be inside the backup folder' };
    }

    const name = path.basename(resolved);
    if (!BACKUP_NAME_RE.test(name)) {
      return { success: false, error: 'Invalid backup filename' };
    }

    if (!this.deps.fs.existsSync(resolved)) {
      return { success: false, error: 'Backup file does not exist' };
    }

    const validation = await validateDatabaseFile(resolved, this.deps.validateDatabaseFile);
    if (!validation.valid) {
      return { success: false, error: validation.error || 'Backup database failed validation' };
    }

    return { success: true, path: resolved };
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

function getBackupSuffixIndex(name: string): number {
  const match = name.match(BACKUP_NAME_RE);
  return match?.[3] ? Number(match[3]) : 0;
}

export interface ApplyPendingRestoreDeps {
  backupDir: string;
  dbPath: string;
  now: () => Date;
  getConfig: () => BackupConfig;
  setConfig: (patch: Partial<BackupConfig>) => void;
  validateDatabaseFile?: (path: string) => DatabaseValidationResult | Promise<DatabaseValidationResult>;
  fs: BackupFs;
  logger: BackupLogger;
}

export interface ApplyPendingRestoreResult {
  applied: boolean;
  sourcePath?: string;
  safetyBackupPath?: string;
  error?: string;
}

export async function applyPendingDatabaseRestore(deps: ApplyPendingRestoreDeps): Promise<ApplyPendingRestoreResult> {
  const config = deps.getConfig();
  const pendingPath = config.backupPendingRestorePath;
  if (!pendingPath) return { applied: false };

  const sourcePath = config.backupPendingRestoreSourcePath || '';

  if (!deps.fs.existsSync(pendingPath)) {
    return recordRestoreFailure(deps, 'Pending restore file does not exist');
  }

  const validation = await validateDatabaseFile(pendingPath, deps.validateDatabaseFile);
  if (!validation.valid) {
    return recordRestoreFailure(deps, validation.error || 'Pending restore database failed validation');
  }

  try {
    deps.fs.mkdirSync(deps.backupDir, { recursive: true });
    let safetyBackupPath = '';
    if (deps.fs.existsSync(deps.dbPath)) {
      safetyBackupPath = createUniqueBackupPath(deps.backupDir, deps.now(), deps.fs);
      deps.fs.copyFileSync(deps.dbPath, safetyBackupPath);
    }

    replaceDatabaseFile(deps, pendingPath);
    try {
      deps.fs.unlinkSync(pendingPath);
    } catch (error) {
      deps.logger.warn('[Backup] Failed to remove pending restore file:', pendingPath, error);
    }

    deps.setConfig({
      backupPendingRestorePath: '',
      backupPendingRestoreSourcePath: '',
      backupPendingRestoreRequestedAt: '',
      backupRestoreLastStatus: 'success',
      backupRestoreLastError: '',
      backupRestoreLastSourcePath: sourcePath,
      backupRestoreLastSafetyBackupPath: safetyBackupPath,
      backupRestoreLastAppliedAt: deps.now().toISOString(),
    });

    deps.logger.info('[Backup] Pending database restore applied before database initialization');
    return { applied: true, safetyBackupPath, sourcePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return recordRestoreFailure(deps, message, false);
  }
}

function replaceDatabaseFile(deps: ApplyPendingRestoreDeps, pendingPath: string): void {
  const restoreTempPath = `${deps.dbPath}.restore-tmp`;
  const previousPath = `${deps.dbPath}.restore-prev`;

  cleanupRestoreTemp(deps, restoreTempPath);
  cleanupRestoreTemp(deps, previousPath);

  deps.fs.copyFileSync(pendingPath, restoreTempPath);

  let previousMoved = false;
  try {
    if (deps.fs.existsSync(deps.dbPath)) {
      deps.fs.renameSync(deps.dbPath, previousPath);
      previousMoved = true;
    }

    deps.fs.renameSync(restoreTempPath, deps.dbPath);

    if (previousMoved) {
      cleanupRestoreTemp(deps, previousPath);
    }
  } catch (error) {
    if (previousMoved) {
      try {
        if (deps.fs.existsSync(deps.dbPath)) {
          deps.fs.unlinkSync(deps.dbPath);
        }
        if (deps.fs.existsSync(previousPath)) {
          deps.fs.renameSync(previousPath, deps.dbPath);
        }
      } catch (rollbackError) {
        deps.logger.error('[Backup] Failed to roll back database restore:', rollbackError);
      }
    }
    cleanupRestoreTemp(deps, restoreTempPath);
    throw error;
  }
}

function cleanupRestoreTemp(deps: ApplyPendingRestoreDeps, filePath: string): void {
  try {
    if (deps.fs.existsSync(filePath)) {
      deps.fs.unlinkSync(filePath);
    }
  } catch (error) {
    deps.logger.warn('[Backup] Failed to remove restore temp file:', filePath, error);
  }
}

function recordRestoreFailure(
  deps: ApplyPendingRestoreDeps,
  error: string,
  clearPendingRestore = true,
): ApplyPendingRestoreResult {
  deps.setConfig({
    ...(clearPendingRestore ? {
      backupPendingRestorePath: '',
      backupPendingRestoreSourcePath: '',
      backupPendingRestoreRequestedAt: '',
    } : {}),
    backupRestoreLastStatus: 'failed',
    backupRestoreLastError: error,
  });
  deps.logger.warn('[Backup] Pending database restore failed:', error);
  return { applied: false, error };
}

function createUniqueBackupPath(backupDir: string, date: Date, fs: BackupFs): string {
  const baseName = createBackupFileName(date);
  const basePath = path.join(backupDir, baseName);
  if (!fs.existsSync(basePath)) return basePath;

  const stem = baseName.replace(/\.db$/, '');
  for (let i = 1; i <= 999; i++) {
    const candidate = path.join(backupDir, `${stem}-${String(i).padStart(3, '0')}.db`);
    if (!fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`No available backup filename for ${baseName}`);
}

function createBackupFileName(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `pos-backup-${yyyy}${mm}${dd}-${hh}${min}${ss}.db`;
}

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  const relative = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function validateDatabaseFile(
  dbPath: string,
  injected?: (path: string) => DatabaseValidationResult | Promise<DatabaseValidationResult>,
): Promise<DatabaseValidationResult> {
  if (injected) return injected(dbPath);

  let db: import('sql.js').Database | null = null;
  try {
    const SQL = await initSqlJs();
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
    const result = db.exec('PRAGMA integrity_check');
    const value = result[0]?.values?.[0]?.[0];
    if (value !== 'ok') {
      return { valid: false, error: `integrity_check failed: ${String(value || 'no result')}` };
    }
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}
