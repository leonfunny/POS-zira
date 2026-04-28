import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBackupService, type BackupFileInfo } from '../src/main/database/backup-service';

type FileEntry = { path: string; mtimeMs: number };

const backupDir = 'C:\\Users\\pc\\Documents\\Zira AI Backups';
const dbPath = 'C:\\Users\\pc\\AppData\\Roaming\\Zira AI\\pos.db';
const defaultNow = new Date(2026, 3, 28, 7, 5, 6);

function makeService(options: {
  now?: Date;
  files?: FileEntry[];
  flush?: () => { success: boolean; dbPath?: string; error?: string };
} = {}) {
  const calls: string[] = [];
  const files = new Map<string, FileEntry>();
  for (const file of options.files || []) {
    files.set(file.path, file);
  }

  const deps = {
    backupDir,
    now: () => options.now || defaultNow,
    flushDatabase: options.flush || (() => {
      calls.push('flush');
      return { success: true, dbPath };
    }),
    getConfig: vi.fn(() => ({})),
    setConfig: vi.fn((patch: Record<string, unknown>) => {
      calls.push(`setConfig:${JSON.stringify(patch)}`);
    }),
    fs: {
      mkdirSync: vi.fn(() => {
        calls.push('mkdir');
      }),
      copyFileSync: vi.fn((from: string, to: string) => {
        calls.push(`copy:${from}->${to}`);
        files.set(to, { path: to, mtimeMs: options.now?.getTime() || defaultNow.getTime() });
      }),
      readdirSync: vi.fn(() => [...files.keys()].map((path) => path.split('\\').pop() as string)),
      existsSync: vi.fn((path: string) => files.has(path)),
      statSync: vi.fn((path: string) => ({ mtimeMs: files.get(path)?.mtimeMs || 0 })),
      unlinkSync: vi.fn((path: string) => {
        calls.push(`unlink:${path}`);
        files.delete(path);
      }),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };

  return { service: new LocalBackupService(deps), deps, calls, files };
}

function backupPath(stamp: string): string {
  return `${backupDir}\\pos-backup-${stamp}.db`;
}

function suffixedBackupPath(stamp: string, suffix: string): string {
  return `${backupDir}\\pos-backup-${stamp}-${suffix}.db`;
}

describe('LocalBackupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats backup filenames with a sortable local timestamp', () => {
    const { service } = makeService({ now: new Date(2026, 0, 2, 3, 4, 5) });

    expect(service.createBackupFileName()).toBe('pos-backup-20260102-030405.db');
  });

  it('flushes the database before copying pos.db and reports success only after both steps complete', async () => {
    const { service, deps, calls } = makeService();

    const result = await service.runBackupNow('manual');

    expect(result).toEqual({
      success: true,
      path: backupPath('20260428-070506'),
      createdAt: defaultNow.toISOString(),
    });
    expect(calls[0]).toBe('flush');
    expect(calls[1]).toBe('mkdir');
    expect(calls[2]).toBe(`copy:${dbPath}->${backupPath('20260428-070506')}`);
    expect(deps.setConfig).toHaveBeenCalledWith({
      backupLastStatus: 'success',
      backupLastRunAt: defaultNow.toISOString(),
      backupLastSuccessAt: defaultNow.toISOString(),
      backupLastPath: backupPath('20260428-070506'),
      backupLastError: '',
    });
  });

  it('creates deterministic suffixed filenames for same-second backup collisions', async () => {
    const { service, files } = makeService();

    const first = await service.runBackupNow('manual');
    const second = await service.runBackupNow('manual');

    expect(first.path).toBe(backupPath('20260428-070506'));
    expect(second.path).toBe(suffixedBackupPath('20260428-070506', '001'));
    expect(files.has(backupPath('20260428-070506'))).toBe(true);
    expect(files.has(suffixedBackupPath('20260428-070506', '001'))).toBe(true);
    expect(service.listBackupFiles().map((file) => file.path)).toEqual([
      backupPath('20260428-070506'),
      suffixedBackupPath('20260428-070506', '001'),
    ]);
  });

  it('does not copy or report success when the database flush fails', async () => {
    const { service, deps } = makeService({
      flush: () => ({ success: false, error: 'disk full' }),
    });

    const result = await service.runBackupNow('manual');

    expect(result).toEqual({
      success: false,
      error: 'disk full',
      createdAt: defaultNow.toISOString(),
    });
    expect(deps.fs.copyFileSync).not.toHaveBeenCalled();
    expect(deps.setConfig).toHaveBeenCalledWith({
      backupLastStatus: 'failed',
      backupLastRunAt: defaultNow.toISOString(),
      backupLastError: 'disk full',
    });
  });

  it('keeps the union of newest 30 backups and monthly representatives for the 12 newest months', () => {
    const newestThirty: BackupFileInfo[] = Array.from({ length: 30 }, (_, i) => ({
      path: backupPath(`202604${String(30 - i).padStart(2, '0')}-010000`),
      timestamp: new Date(Date.UTC(2026, 3, 30 - i, 1)),
    }));
    const monthlyReps: BackupFileInfo[] = Array.from({ length: 11 }, (_, i) => ({
      path: backupPath(`2025${String(12 - i).padStart(2, '0')}28-010000`),
      timestamp: new Date(Date.UTC(2025, 11 - i, 28, 1)),
    }));
    const oldFile: BackupFileInfo = {
      path: backupPath('20250101-010000'),
      timestamp: new Date(Date.UTC(2025, 0, 1, 1)),
    };
    const allFiles = [...newestThirty, ...monthlyReps, oldFile];
    const { service } = makeService();

    const keep = service.selectBackupsToKeep(allFiles).map((file) => file.path);

    expect(keep).toHaveLength(41);
    expect(keep).toEqual(expect.arrayContaining(newestThirty.map((file) => file.path)));
    expect(keep).toEqual(expect.arrayContaining(monthlyReps.map((file) => file.path)));
    expect(keep).not.toContain(oldFile.path);
  });

  it('records startup backup failures without throwing', async () => {
    const { service, deps } = makeService({
      flush: () => ({ success: false, error: 'database locked' }),
    });

    await expect(service.runStartupCatchupIfDue()).resolves.toEqual({
      success: false,
      error: 'database locked',
      createdAt: defaultNow.toISOString(),
    });
    expect(deps.logger.warn).toHaveBeenCalledWith('[Backup] Startup catch-up backup failed:', 'database locked');
  });

  it('runs due scheduled backups with scheduled reason', async () => {
    const { service, deps } = makeService();

    await service.runBackupIfDue('scheduled');

    expect(deps.logger.info).toHaveBeenCalledWith(
      `[Backup] scheduled database backup created: ${backupPath('20260428-070506')}`,
    );
  });
});
