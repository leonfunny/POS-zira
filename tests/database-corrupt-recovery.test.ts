import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

// Mock electron + logger before importing the module under test so the
// app.getPath call never fires and we capture log lines.
vi.mock('electron', () => ({
  app: { getPath: () => 'unused-in-static-tests' },
}));

const { logger } = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../src/main/logger', () => ({ default: logger }));

// Import after mocks are in place. The default export is a singleton
// instance, but we reach the static helpers via the constructor reference
// to avoid touching Electron-bound state.
import { database } from '../src/main/database/database';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DatabaseClass = (database.constructor as any) as {
  isValidSqliteHeader(buf: Buffer): boolean;
  quarantineCorruptFile(dbPath: string, buf: Buffer): void;
};

describe('database self-heal helpers', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'pos-zira-db-test-'));
    logger.error.mockClear();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('isValidSqliteHeader', () => {
    it('returns true for a well-formed SQLite header', () => {
      const buf = Buffer.alloc(64);
      buf.write('SQLite format 3', 0, 'ascii');
      buf.writeUInt8(0x00, 15);
      expect(DatabaseClass.isValidSqliteHeader(buf)).toBe(true);
    });

    it('returns false for an all-zero buffer (Type B corruption from Windows fsync lie)', () => {
      const buf = Buffer.alloc(6_098_944, 0);
      expect(DatabaseClass.isValidSqliteHeader(buf)).toBe(false);
    });

    it('returns false for a buffer shorter than the magic prefix', () => {
      expect(DatabaseClass.isValidSqliteHeader(Buffer.from('SQLite'))).toBe(false);
    });

    it('returns false when magic bytes are mangled mid-header', () => {
      const buf = Buffer.from('SQLite_format_3', 'ascii');
      // padding so length >= 16 — only the magic content should make this fail.
      const padded = Buffer.concat([buf, Buffer.alloc(1, 0)]);
      expect(DatabaseClass.isValidSqliteHeader(padded)).toBe(false);
    });
  });

  describe('quarantineCorruptFile', () => {
    it('renames the corrupt file with a .corrupted-<ts> suffix and logs forensic info', () => {
      const dbPath = join(tmpDir, 'pos.db');
      const corruptBuffer = Buffer.alloc(32, 0);
      fs.writeFileSync(dbPath, corruptBuffer);

      DatabaseClass.quarantineCorruptFile(dbPath, corruptBuffer);

      expect(fs.existsSync(dbPath)).toBe(false);
      const surviving = fs.readdirSync(tmpDir);
      const quarantined = surviving.find((name) => name.startsWith('pos.db.corrupted-'));
      expect(quarantined).toBeTruthy();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('[DB] Quarantined corrupt database'),
      );
    });

    it('logs but does not throw when the rename fails (file locked)', () => {
      const dbPath = join(tmpDir, 'never-existed.db');
      // dbPath does not exist — renameSync will throw ENOENT.
      expect(() =>
        DatabaseClass.quarantineCorruptFile(dbPath, Buffer.alloc(16, 0)),
      ).not.toThrow();
      // Two errors expected: the quarantine intent + the rename failure.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to quarantine corrupt file'),
      );
    });
  });
});
