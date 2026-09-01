import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  get: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
}));

vi.mock('../src/main/database/database', () => ({ database: db }));

import {
  fabricTagArtworkRepo,
  toFabricTagArtwork,
  type FabricTagArtworkRow,
} from '../src/main/database/repos/fabric-tag-artwork-repo';

function row(overrides: Partial<FabricTagArtworkRow> = {}): FabricTagArtworkRow {
  return {
    id: 'asset-1',
    salon_id: 'salon-a',
    customer_name: 'Customer A',
    order_code: 'ORDER-7',
    variant: 'S/M',
    revision: 'r1',
    original_filename: 'customer-label.btw',
    source_type: 'BTW',
    status: 'NEEDS_CONVERSION',
    source_sha256: 'a'.repeat(64),
    source_path: '/private/salon-a/source/customer-label.btw',
    production_filename: null,
    production_sha256: null,
    production_path: null,
    width_px: null,
    height_px: null,
    physical_width_mm: null,
    physical_length_mm: null,
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-01T10:00:00.000Z',
    retired_at: null,
    ...overrides,
  };
}

describe('fabric artwork repository tenant boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.get.mockReturnValue(null);
    db.all.mockReturnValue([]);
  });

  it('requires both salon id and asset id for every single-row lookup', () => {
    fabricTagArtworkRepo.getRow('salon-a', 'asset-1');

    expect(db.get).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE\s+salon_id\s*=\s*\?\s+AND\s+id\s*=\s*\?/i),
      ['salon-a', 'asset-1'],
    );
  });

  it('lists only the requested salon and hides retired artwork by default', () => {
    fabricTagArtworkRepo.list('salon-a');

    const [sql, params] = db.all.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE\s+salon_id\s*=\s*\?/i);
    expect(sql).toMatch(/status\s*<>\s*'RETIRED'/i);
    expect(params).toEqual(['salon-a']);
  });

  it('scopes production attachment and the following read to the same salon', () => {
    db.get
      .mockReturnValueOnce({ count: 1 })
      .mockReturnValueOnce(row({
        status: 'READY',
        production_filename: 'production.png',
        production_sha256: 'b'.repeat(64),
        production_path: '/private/salon-a/production/production.png',
        width_px: 160,
        height_px: 240,
        physical_width_mm: 20,
        physical_length_mm: 30,
      }));

    fabricTagArtworkRepo.attachProduction('salon-a', 'asset-1', {
      productionFilename: 'production.png',
      productionSha256: 'b'.repeat(64),
      productionPath: '/private/salon-a/production/production.png',
      widthPx: 160,
      heightPx: 240,
      physicalWidthMm: 20,
      physicalLengthMm: 30,
      now: '2026-09-01T11:00:00.000Z',
    });

    const [updateSql, updateParams] = db.run.mock.calls[0] as [string, unknown[]];
    expect(updateSql).toMatch(
      /WHERE\s+salon_id\s*=\s*\?\s+AND\s+id\s*=\s*\?[\s\S]*source_type\s*=\s*'BTW'[\s\S]*status\s*=\s*'NEEDS_CONVERSION'/i,
    );
    for (const field of [
      'production_filename',
      'production_sha256',
      'production_path',
      'width_px',
      'height_px',
      'physical_width_mm',
      'physical_length_mm',
    ]) {
      expect(updateSql).toMatch(new RegExp(`${field}\\s+IS\\s+NULL`, 'i'));
    }
    expect(updateParams.slice(-2)).toEqual(['salon-a', 'asset-1']);
    expect(db.get).toHaveBeenNthCalledWith(1, 'SELECT changes() AS count');
    expect(db.get).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/WHERE\s+salon_id\s*=\s*\?\s+AND\s+id\s*=\s*\?/i),
      ['salon-a', 'asset-1'],
    );
  });

  it('returns null without reading a row when the immutable attach predicate changed nothing', () => {
    db.get.mockReturnValueOnce({ count: 0 });

    const result = fabricTagArtworkRepo.attachProduction('salon-a', 'asset-1', {
      productionFilename: 'replacement.png',
      productionSha256: 'b'.repeat(64),
      productionPath: '/private/salon-a/production/replacement.png',
      widthPx: 160,
      heightPx: 240,
      physicalWidthMm: 20,
      physicalLengthMm: 30,
      now: '2026-09-01T11:00:00.000Z',
    });

    expect(result).toBeNull();
    expect(db.get).toHaveBeenCalledOnce();
    expect(db.get).toHaveBeenCalledWith('SELECT changes() AS count');
  });

  it('never exposes private source or production paths to the renderer contract', () => {
    const mapped = toFabricTagArtwork(row({
      production_path: '/private/salon-a/production/production.png',
    }));

    expect(mapped).not.toHaveProperty('sourcePath');
    expect(mapped).not.toHaveProperty('source_path');
    expect(mapped).not.toHaveProperty('productionPath');
    expect(mapped).not.toHaveProperty('production_path');
  });
});
