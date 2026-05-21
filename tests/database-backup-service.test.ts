import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPendingDatabaseRestore,
  LocalBackupService,
  type BackupFileInfo,
} from '../src/main/database/backup-service';

type FileEntry = { path: string; mtimeMs: number; sizeBytes?: number; content?: string };

const backupDir = 'C:\\Users\\pc\\Documents\\Zira AI Backups';
const dbPath = 'C:\\Users\\pc\\AppData\\Roaming\\Zira AI\\pos.db';
const userDataDir = 'C:\\Users\\pc\\AppData\\Roaming\\Zira AI';
const pendingRestorePath = `${userDataDir}\\pending-restore.db`;
const defaultNow = new Date(2026, 3, 28, 7, 5, 6);

function makeService(options: {
  now?: Date;
  files?: FileEntry[];
  flush?: () => { success: boolean; dbPath?: string; error?: string };
  config?: Record<string, unknown>;
  validateDatabaseFile?: (path: string) => { valid: boolean; error?: string };
  failCopy?: (from: string, to: string, files: Map<string, FileEntry>) => Error | null;
  failRename?: (from: string, to: string, files: Map<string, FileEntry>) => Error | null;
} = {}) {
  const calls: string[] = [];
  const files = new Map<string, FileEntry>();
  const config = { ...(options.config || {}) };
  for (const file of options.files || []) {
    files.set(file.path, file);
  }

  const deps = {
    backupDir,
    userDataDir,
    now: () => options.now || defaultNow,
    flushDatabase: options.flush || (() => {
      calls.push('flush');
      return { success: true, dbPath };
    }),
    validateDatabaseFile: vi.fn(options.validateDatabaseFile || (() => ({ valid: true }))),
    getConfig: vi.fn(() => config),
    setConfig: vi.fn((patch: Record<string, unknown>) => {
      calls.push(`setConfig:${JSON.stringify(patch)}`);
      Object.assign(config, patch);
    }),
    fs: {
      mkdirSync: vi.fn(() => {
        calls.push('mkdir');
      }),
      copyFileSync: vi.fn((from: string, to: string) => {
        calls.push(`copy:${from}->${to}`);
        const failure = options.failCopy?.(from, to, files);
        if (failure) throw failure;
        const source = files.get(from);
        files.set(to, {
          path: to,
          mtimeMs: options.now?.getTime() || defaultNow.getTime(),
          sizeBytes: source?.sizeBytes || 1,
          content: source?.content,
        });
      }),
      readdirSync: vi.fn(() => [...files.keys()].map((path) => path.split('\\').pop() as string)),
      existsSync: vi.fn((path: string) => files.has(path)),
      statSync: vi.fn((path: string) => ({
        mtimeMs: files.get(path)?.mtimeMs || 0,
        size: files.get(path)?.sizeBytes || 0,
      })),
      unlinkSync: vi.fn((path: string) => {
        calls.push(`unlink:${path}`);
        files.delete(path);
      }),
      renameSync: vi.fn((from: string, to: string) => {
        calls.push(`rename:${from}->${to}`);
        const failure = options.failRename?.(from, to, files);
        if (failure) throw failure;
        const source = files.get(from);
        if (!source) throw new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
        files.set(to, { ...source, path: to });
        files.delete(from);
      }),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };

  return { service: new LocalBackupService(deps as any), deps, calls, files, config };
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
    expect(calls[2]).toBe(`copy:${dbPath}->${backupPath('20260428-070506')}.tmp`);
    expect(calls[3]).toBe(`rename:${backupPath('20260428-070506')}.tmp->${backupPath('20260428-070506')}`);
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
      suffixedBackupPath('20260428-070506', '001'),
      backupPath('20260428-070506'),
    ]);
  });

  it('lists only valid backup filenames with metadata, newest first', () => {
    const { service } = makeService({
      files: [
        { path: backupPath('20260427-070506'), mtimeMs: 1, sizeBytes: 100 },
        { path: `${backupDir}\\notes.txt`, mtimeMs: 2, sizeBytes: 200 },
        { path: `${backupDir}\\pos-backup-20260427-070506.tmp`, mtimeMs: 3, sizeBytes: 300 },
        { path: suffixedBackupPath('20260428-070506', '001'), mtimeMs: 4, sizeBytes: 401 },
        { path: backupPath('20260428-070506'), mtimeMs: 5, sizeBytes: 400 },
        { path: `${backupDir}\\pos-backup-20260428-070506-1.db`, mtimeMs: 6, sizeBytes: 600 },
      ],
    });

    expect(service.listBackupFiles()).toEqual([
      {
        name: 'pos-backup-20260428-070506-001.db',
        path: suffixedBackupPath('20260428-070506', '001'),
        createdAt: new Date(2026, 3, 28, 7, 5, 6).toISOString(),
        sizeBytes: 401,
        isLatest: true,
        timestamp: new Date(2026, 3, 28, 7, 5, 6),
      },
      {
        name: 'pos-backup-20260428-070506.db',
        path: backupPath('20260428-070506'),
        createdAt: new Date(2026, 3, 28, 7, 5, 6).toISOString(),
        sizeBytes: 400,
        isLatest: false,
        timestamp: new Date(2026, 3, 28, 7, 5, 6),
      },
      {
        name: 'pos-backup-20260427-070506.db',
        path: backupPath('20260427-070506'),
        createdAt: new Date(2026, 3, 27, 7, 5, 6).toISOString(),
        sizeBytes: 100,
        isLatest: false,
        timestamp: new Date(2026, 3, 27, 7, 5, 6),
      },
    ]);
  });

  it('rejects restore requests outside the configured backup folder', async () => {
    const { service, deps } = makeService({
      files: [{ path: 'C:\\Users\\pc\\Documents\\pos-backup-20260428-070506.db', mtimeMs: 1, sizeBytes: 100 }],
    });

    await expect((service as any).prepareRestore('C:\\Users\\pc\\Documents\\pos-backup-20260428-070506.db'))
      .resolves.toEqual({ success: false, error: 'Backup path must be inside the backup folder' });
    expect(deps.fs.copyFileSync).not.toHaveBeenCalled();
  });

  it('rejects restore requests whose filename does not match the backup pattern', async () => {
    const { service, deps } = makeService({
      files: [{ path: `${backupDir}\\manual-copy.db`, mtimeMs: 1, sizeBytes: 100 }],
    });

    await expect((service as any).prepareRestore(`${backupDir}\\manual-copy.db`))
      .resolves.toEqual({ success: false, error: 'Invalid backup filename' });
    expect(deps.fs.copyFileSync).not.toHaveBeenCalled();
  });

  it('rejects restore requests for missing backup files', async () => {
    const { service, deps } = makeService();

    await expect((service as any).prepareRestore(backupPath('20260428-070506')))
      .resolves.toEqual({ success: false, error: 'Backup file does not exist' });
    expect(deps.fs.copyFileSync).not.toHaveBeenCalled();
  });

  it('rejects restore requests for invalid database files before staging', async () => {
    const { service, deps } = makeService({
      files: [{ path: backupPath('20260428-070506'), mtimeMs: 1, sizeBytes: 100 }],
      validateDatabaseFile: () => ({ valid: false, error: 'integrity_check failed: malformed' }),
    });

    await expect((service as any).prepareRestore(backupPath('20260428-070506')))
      .resolves.toEqual({ success: false, error: 'integrity_check failed: malformed' });
    expect(deps.fs.copyFileSync).not.toHaveBeenCalled();
  });

  it('stages a valid backup and records pending restore config', async () => {
    const { service, deps, config } = makeService({
      files: [{ path: backupPath('20260428-070506'), mtimeMs: 1, sizeBytes: 100 }],
    });

    await expect((service as any).prepareRestore(backupPath('20260428-070506')))
      .resolves.toEqual({ success: true });
    expect(deps.fs.mkdirSync).toHaveBeenCalledWith(userDataDir, { recursive: true });
    expect(deps.fs.copyFileSync).toHaveBeenCalledWith(backupPath('20260428-070506'), pendingRestorePath);
    expect(config).toMatchObject({
      backupPendingRestorePath: pendingRestorePath,
      backupPendingRestoreSourcePath: backupPath('20260428-070506'),
      backupPendingRestoreRequestedAt: defaultNow.toISOString(),
      backupRestoreLastStatus: 'pending',
      backupRestoreLastError: '',
    });
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

describe('applyPendingDatabaseRestore', () => {
  it('copies the current database to a safety backup before replacing it and clears pending config', async () => {
    const { deps, config, files } = makeService({
      config: {
        backupPendingRestorePath: pendingRestorePath,
        backupPendingRestoreSourcePath: backupPath('20260428-070506'),
        backupPendingRestoreRequestedAt: '2026-04-28T06:00:00.000Z',
      },
      files: [
        { path: pendingRestorePath, mtimeMs: 1, sizeBytes: 100 },
        { path: dbPath, mtimeMs: 2, sizeBytes: 200 },
      ],
    });

    const result = await applyPendingDatabaseRestore({
      backupDir,
      dbPath,
      now: () => defaultNow,
      getConfig: deps.getConfig,
      setConfig: deps.setConfig,
      validateDatabaseFile: deps.validateDatabaseFile,
      fs: deps.fs,
      logger: deps.logger,
    } as any);

    const safetyPath = backupPath('20260428-070506');
    expect(result).toEqual({ applied: true, safetyBackupPath: safetyPath, sourcePath: backupPath('20260428-070506') });
    expect(deps.fs.copyFileSync).toHaveBeenNthCalledWith(1, dbPath, safetyPath);
    expect(deps.fs.copyFileSync).toHaveBeenNthCalledWith(2, pendingRestorePath, `${dbPath}.restore-tmp`);
    expect(deps.fs.renameSync).toHaveBeenNthCalledWith(1, dbPath, `${dbPath}.restore-prev`);
    expect(deps.fs.renameSync).toHaveBeenNthCalledWith(2, `${dbPath}.restore-tmp`, dbPath);
    expect(files.has(safetyPath)).toBe(true);
    expect(config).toMatchObject({
      backupPendingRestorePath: '',
      backupPendingRestoreSourcePath: '',
      backupPendingRestoreRequestedAt: '',
      backupRestoreLastStatus: 'success',
      backupRestoreLastError: '',
      backupRestoreLastSourcePath: backupPath('20260428-070506'),
      backupRestoreLastSafetyBackupPath: safetyPath,
      backupRestoreLastAppliedAt: defaultNow.toISOString(),
    });
  });

  it('leaves the current database untouched and records failure when the staged restore is invalid', async () => {
    const { deps, config } = makeService({
      config: {
        backupPendingRestorePath: pendingRestorePath,
        backupPendingRestoreSourcePath: backupPath('20260428-070506'),
      },
      files: [
        { path: pendingRestorePath, mtimeMs: 1, sizeBytes: 100 },
        { path: dbPath, mtimeMs: 2, sizeBytes: 200 },
      ],
      validateDatabaseFile: () => ({ valid: false, error: 'integrity_check failed: malformed' }),
    });

    await expect(applyPendingDatabaseRestore({
      backupDir,
      dbPath,
      now: () => defaultNow,
      getConfig: deps.getConfig,
      setConfig: deps.setConfig,
      validateDatabaseFile: deps.validateDatabaseFile,
      fs: deps.fs,
      logger: deps.logger,
    } as any)).resolves.toEqual({
      applied: false,
      error: 'integrity_check failed: malformed',
    });
    expect(deps.fs.copyFileSync).not.toHaveBeenCalled();
    expect(config).toMatchObject({
      backupPendingRestorePath: '',
      backupPendingRestoreSourcePath: '',
      backupPendingRestoreRequestedAt: '',
      backupRestoreLastStatus: 'failed',
      backupRestoreLastError: 'integrity_check failed: malformed',
    });
  });

  it('preserves current database and pending metadata when restore replacement fails', async () => {
    const { deps, config, files } = makeService({
      config: {
        backupPendingRestorePath: pendingRestorePath,
        backupPendingRestoreSourcePath: backupPath('20260428-070506'),
        backupPendingRestoreRequestedAt: '2026-04-28T06:00:00.000Z',
      },
      files: [
        { path: pendingRestorePath, mtimeMs: 1, sizeBytes: 100, content: 'restored-db' },
        { path: dbPath, mtimeMs: 2, sizeBytes: 200, content: 'original-db' },
      ],
      failCopy: (from, to, fsFiles) => {
        if (from === pendingRestorePath && to === dbPath) {
          fsFiles.set(dbPath, { path: dbPath, mtimeMs: 999, sizeBytes: 7, content: 'partial' });
          return new Error('replace failed');
        }
        return null;
      },
      failRename: (from, to, fsFiles) => {
        if (from === `${dbPath}.restore-tmp` && to === dbPath) {
          fsFiles.set(dbPath, { path: dbPath, mtimeMs: 999, sizeBytes: 7, content: 'partial' });
          return new Error('replace failed');
        }
        return null;
      },
    });

    await expect(applyPendingDatabaseRestore({
      backupDir,
      dbPath,
      now: () => defaultNow,
      getConfig: deps.getConfig,
      setConfig: deps.setConfig,
      validateDatabaseFile: deps.validateDatabaseFile,
      fs: deps.fs,
      logger: deps.logger,
    } as any)).resolves.toEqual({
      applied: false,
      error: 'replace failed',
    });
    expect(files.get(dbPath)).toMatchObject({
      mtimeMs: 2,
      sizeBytes: 200,
      content: 'original-db',
    });
    expect(config).toMatchObject({
      backupPendingRestorePath: pendingRestorePath,
      backupPendingRestoreSourcePath: backupPath('20260428-070506'),
      backupPendingRestoreRequestedAt: '2026-04-28T06:00:00.000Z',
      backupRestoreLastStatus: 'failed',
      backupRestoreLastError: 'replace failed',
    });
  });
});
