import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * 2026-08-08 baohan/chesaigon incident: the post-login product sync only
 * forced a FULL sync when the local catalog was empty. An in-flight sync of
 * the leaving salon had already refilled the catalog by then, so post-login
 * ran a delta against a foreign cursor and the contamination stuck. A login
 * that switched salons must always force a full sync.
 *
 * Source-level assertions (repo convention, see clear-salon-data.test.ts):
 * wiring both modules into a unit harness needs the full DI container; the
 * behavioral coverage lives in the gm real-fixture acceptance run.
 */
const authSource = readFileSync(
  resolve(__dirname, '../src/main/modules/auth.module.ts'),
  'utf-8',
);
const syncSource = readFileSync(
  resolve(__dirname, '../src/main/modules/sync.module.ts'),
  'utf-8',
);

describe('post-login salon-switch full sync wiring', () => {
  it('both login emit sites carry salonSwitched', () => {
    const emits = authSource.match(/emit\('user:logged-in',.*$/gm) ?? [];
    expect(emits.length).toBeGreaterThanOrEqual(2);
    for (const emit of emits) {
      expect(emit).toMatch(/salonSwitched/);
    }
  });

  it('post-login product sync forces full when salonSwitched', () => {
    expect(syncSource).toMatch(/salonSwitched\s*===\s*true/);
    expect(syncSource).toMatch(/post-login-salon-switch/);
  });
});
