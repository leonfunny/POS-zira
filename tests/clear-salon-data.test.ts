import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * tenant-isolation regression: clearSalonData() must wipe bookings,
 * services, service_rules along with the existing list. The 2026-04-30
 * incident left local bookings stranded after a re-login that wiped
 * local_sync_log; the next cancel pushed status_changed for a booking
 * the server had never seen → NOT_FOUND.
 */
describe('database.clearSalonData() table list', () => {
  const source = readFileSync(
    resolve(__dirname, '../src/main/database/database.ts'),
    'utf-8',
  );

  // Pull the array literal between `const tablesToClear = [` and the
  // matching `];`. Brittle but the alternative is loading sql.js into
  // jsdom which adds a lot of test setup for one assertion.
  const block = source.match(/const\s+tablesToClear\s*=\s*\[([\s\S]+?)\];/)?.[1] ?? '';

  it('includes bookings', () => {
    expect(block).toMatch(/'bookings'/);
  });

  it('includes services', () => {
    expect(block).toMatch(/'services'/);
  });

  it('includes service_rules', () => {
    expect(block).toMatch(/'service_rules'/);
  });

  // Keep existing entries — regression guard so the future doesn't
  // silently drop any of the already-wiped tables.
  it('keeps local_sync_log + sync_state', () => {
    expect(block).toMatch(/'local_sync_log'/);
    expect(block).toMatch(/'sync_state'/);
  });

  it('clears the local fiscal_attempts journal on salon switch', () => {
    expect(block).toMatch(/'fiscal_attempts'/);
  });
});
