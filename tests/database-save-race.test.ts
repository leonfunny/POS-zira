import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => 'unused-in-save-race-tests' },
  BrowserWindow: { getAllWindows: () => [] },
}));

const { logger, atomicWriteFile, atomicWriteFileSync } = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  atomicWriteFile: vi.fn(),
  atomicWriteFileSync: vi.fn(),
}));

vi.mock('../src/main/logger', () => ({ default: logger }));
vi.mock('../src/main/database/atomic-write', () => ({
  atomicWriteFile,
  atomicWriteFileSync,
}));

import { database } from '../src/main/database/database';

describe('database save dirty tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (database as any).db = { export: vi.fn(() => new Uint8Array([1, 2, 3])) };
    (database as any).dbPath = 'pos.db';
    (database as any).dirty = false;
    (database as any).dirtyVersion = 0;
    (database as any).saving = false;
    (database as any).consecutiveFailures = 0;
  });

  it('keeps dirty=true when a newer mutation happens while an older save is in flight', async () => {
    let finishWrite!: () => void;
    atomicWriteFile.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));

    database.markDirty();
    const savePromise = database.save();
    await Promise.resolve();

    database.markDirty();
    expect((database as any).dirty).toBe(true);
    await expect(database.save()).resolves.toMatchObject({
      success: false,
      error: 'Database save already in progress',
    });

    finishWrite();
    await expect(savePromise).resolves.toMatchObject({ success: true });

    expect((database as any).dirty).toBe(true);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('newer changes still dirty'),
    );

    atomicWriteFile.mockResolvedValueOnce(undefined);
    await expect(database.save()).resolves.toMatchObject({ success: true });
    expect((database as any).dirty).toBe(false);
  });

  it('saveCoalesced waits for an older writer and persists the newer dirty version', async () => {
    let finishFirstWrite!: () => void;
    atomicWriteFile
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirstWrite = resolve;
      }))
      .mockResolvedValueOnce(undefined);

    database.markDirty();
    const firstSave = database.save();
    await Promise.resolve();
    database.markDirty();

    const durabilityBarrier = database.saveCoalesced(5000);
    finishFirstWrite();
    await expect(firstSave).resolves.toMatchObject({ success: true });
    await expect(durabilityBarrier).resolves.toMatchObject({ success: true });

    expect(atomicWriteFile).toHaveBeenCalledTimes(2);
    expect((database as any).dirty).toBe(false);
  });

  it('saveSync fails closed while the async writer owns the shared temp file', async () => {
    let finishWrite!: () => void;
    atomicWriteFile.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));

    database.markDirty();
    const asyncSave = database.save();
    await Promise.resolve();
    // Simulate the tenant lifecycle transaction becoming newer while the old
    // snapshot is still writing.
    database.markDirty();

    expect(database.saveSync()).toMatchObject({
      success: false,
      error: expect.stringContaining('async save is in progress'),
    });
    expect(atomicWriteFileSync).not.toHaveBeenCalled();

    finishWrite();
    await expect(asyncSave).resolves.toMatchObject({ success: true });
    expect((database as any).dirty).toBe(true);
  });
});
