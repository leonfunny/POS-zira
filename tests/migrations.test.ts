import { describe, expect, it } from 'vitest';
import { migrations } from '../src/main/database/migrations';

describe('database migrations', () => {
  it('keeps pos_staff_user_id compatible with the semicolon-based runner', () => {
    const migration = migrations.find((m) => m.name === 'pos_staff_user_id');

    expect(migration).toBeDefined();
    const statements = migration!.up
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('ALTER TABLE pos_staff ADD COLUMN user_id TEXT');
    expect(statements[1]).toBe('CREATE INDEX IF NOT EXISTS idx_pos_staff_user_id ON pos_staff(user_id)');
  });

  it('adds paper_height to local_printers in a separate migration', () => {
    const migration = migrations.find((m) => m.name === 'local_printers_paper_height');

    expect(migration).toBeDefined();
    const statements = migration!.up
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(statements).toEqual([
      'ALTER TABLE local_printers ADD COLUMN paper_height INTEGER',
    ]);
  });
});
