import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  all: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
}));

vi.mock('../src/main/database/database', () => ({
  database: mock,
}));

vi.mock('../src/main/logger', () => ({
  default: { warn: vi.fn() },
}));

import { fabricTagTemplateRepo } from '../src/main/database/repos/fabric-tag-template-repo';

describe('fabric tag template list memory boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.all.mockReturnValue([]);
  });

  it('keeps the bulk list blob-free and reserves the logo for get(id)', () => {
    fabricTagTemplateRepo.list();

    const sql = String(mock.all.mock.calls[0]?.[0] || '');
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(sql).toMatch(/NULL\s+AS\s+logo_data_url/i);
    expect(sql).not.toMatch(/,\s*logo_data_url\s*,/i);
  });

  it('does not advertise legacy templates that can never satisfy the print identity boundary', () => {
    fabricTagTemplateRepo.listTemplateIds();

    const sql = String(mock.all.mock.calls[0]?.[0] || '');
    expect(sql).toMatch(/brand_name/i);
    expect(sql).toMatch(/logo_data_url/i);
    expect(sql).toMatch(/COALESCE/i);
  });
});
