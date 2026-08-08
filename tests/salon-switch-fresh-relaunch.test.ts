import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 2026-08-08 baohan/chesaigon incident: the fresh-path salon switch (target
 * salon has no archive) cleared the DB but kept the process alive, so an
 * in-flight sync of the leaving salon later flushed its catalog into the
 * cleared DB. The fresh path must now snapshot the cleared DB as the new
 * salon's baseline and relaunch through the pending-restore machinery —
 * identical to the restore path, which was always immune (the boot-time
 * restore discards anything flushed between clear and process exit).
 *
 * Source-level assertions (repo convention, see clear-salon-data.test.ts);
 * behavioral coverage lives in the gm real-fixture acceptance run.
 */
describe('switchSalonForLogin fresh path', () => {
  const source = readFileSync(
    resolve(__dirname, '../src/main/modules/auth.module.ts'),
    'utf-8',
  );
  const fn = source.match(/private async switchSalonForLogin[\s\S]+?\n  \}/)?.[0] ?? '';

  it('extracts the switchSalonForLogin body', () => {
    expect(fn).toContain('clearSalonData(oldSalonId');
  });

  it('snapshots the cleared DB as the new salon baseline, then stages its restore', () => {
    expect(fn).toMatch(
      /clearSalonData\(oldSalonId[\s\S]+archiveSalon\(newSalonId\)[\s\S]+stageSalonRestore\(newSalonId\)/,
    );
  });

  it('relaunches on the fresh path too (second stageSalonRestore + willRestart)', () => {
    // one stageSalonRestore(newSalonId) belongs to the restore path; the
    // fresh path adds a second one followed by willRestart: true
    expect(fn.match(/stageSalonRestore\(newSalonId\)/g)?.length).toBeGreaterThanOrEqual(2);
    const freshBranch = fn.slice(fn.indexOf('clearSalonData(oldSalonId'));
    expect(freshBranch).toMatch(/willRestart:\s*true/);
  });

  it('keeps a non-restarting fallback so a failed snapshot cannot block login', () => {
    const freshBranch = fn.slice(fn.indexOf('clearSalonData(oldSalonId'));
    expect(freshBranch).toMatch(/ok:\s*true,\s*willRestart:\s*false/);
  });
});
