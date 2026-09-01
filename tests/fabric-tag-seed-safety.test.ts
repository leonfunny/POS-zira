import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('fabric tag seed utility safety', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('refuses legacy --seed before touching pos.db', () => {
    const appData = mkdtempSync(join(tmpdir(), 'zira-fabric-seed-'));
    tempRoots.push(appData);
    const dataDir = join(appData, 'zira-ai');
    const dbPath = join(dataDir, 'pos.db');
    mkdirSync(dataDir);
    const original = Buffer.from('not-even-a-database: must remain byte-identical');
    writeFileSync(dbPath, original);

    let stderr = '';
    try {
      execFileSync(process.execPath, ['scripts/seed-fabric-tag.cjs', '--seed'], {
        cwd: process.cwd(),
        env: { ...process.env, APPDATA: appData },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('unsafe seed unexpectedly succeeded');
    } catch (error: any) {
      stderr = String(error?.stderr || '');
      expect(error?.status).toBe(2);
    }

    expect(stderr).toContain('Refusing --seed');
    expect(readFileSync(dbPath)).toEqual(original);
  });
});
