import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    all: vi.fn(() => []),
    run: vi.fn(),
  },
}));

vi.mock('../src/main/logger', () => ({
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { database } from '../src/main/database/database';
import { productRepo } from '../src/main/database/repos/product-repo';

describe('billiard F&B category search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(database.all).mockReturnValue([]);
  });

  it('scopes ranked text-search candidates to the selected category', () => {
    productRepo.search('tra sua', 'cat-m2');

    const [sql, params] = vi.mocked(database.all).mock.calls[0];
    expect(sql).toMatch(/AND category_id = \?/);
    expect(params).toEqual(['cat-m2']);
  });

  it('keeps ordinary POS searches unscoped', () => {
    productRepo.search('tra sua');

    const [sql, params] = vi.mocked(database.all).mock.calls[0];
    expect(sql).not.toMatch(/AND category_id = \?/);
    expect(params).toBeUndefined();
  });

  it('passes both filters through the billiard IPC reader', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/main/modules/sync.module.ts'),
      'utf8',
    );

    expect(source).toContain('productRepo.search(search, categoryId)');
  });
});
