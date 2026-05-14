import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/main/database/database', () => ({
  database: {
    all: vi.fn(() => []),
  },
}));

import { database } from '../src/main/database/database';
import { productRepo } from '../src/main/database/repos/product-repo';

describe('POS product category contamination guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(database.all).mockReturnValue([]);
  });

  it('only returns categories that still have active sellable products', () => {
    productRepo.getCategories();

    const sql = vi.mocked(database.all).mock.calls[0][0] as string;
    expect(sql).toMatch(/FROM categories c/);
    expect(sql).toMatch(/WHERE EXISTS/);
    expect(sql).toMatch(/p\.category_id = c\.id/);
    expect(sql).toMatch(/p\.is_active = 1/);
    expect(sql).toMatch(/p\.id NOT IN/);
    expect(sql).not.toMatch(/SELECT \* FROM categories ORDER BY/);
  });

  it('does not seed demo catalog when the app is paired or authenticated', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/main/core/orchestrator.ts'),
      'utf8',
    );
    expect(source).toMatch(/getSecureAuthToken/);
    expect(source).toMatch(/const isPaired = !!getConfigValue\('isPaired'\)/);
    expect(source).toMatch(/const hasAuthToken = !!getSecureAuthToken\(\)/);
    expect(source).toMatch(/if \(!isPaired && !hasAuthToken\) \{\s*seedIfEmpty\(\);/);
  });
});
