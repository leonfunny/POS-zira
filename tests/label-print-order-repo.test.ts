import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  get: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
}));

vi.mock('../src/main/database/database', () => ({ database: db }));
vi.mock('../src/main/logger', () => ({ default: { warn: vi.fn(), info: vi.fn() } }));

import {
  labelPrintOrderRepo,
  type LabelPrintOrderRow,
} from '../src/main/database/repos/label-print-order-repo';

function row(overrides: Partial<LabelPrintOrderRow> = {}): LabelPrintOrderRow {
  return {
    id: 'order-1',
    name: 'MoonCollection · KURTKA 114',
    payload: JSON.stringify({ customerName: 'MoonCollection' }),
    updated_at: '2026-09-06T10:00:00.000Z',
    deleted_at: null,
    dirty: 0,
    ...overrides,
  };
}

/** The SQL of the last `run`, with whitespace flattened so it can be read. */
function lastSql(): string {
  return String(db.run.mock.calls.at(-1)?.[0] ?? '').replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  db.all.mockReturnValue([]);
  db.get.mockReturnValue(undefined);
});

describe('the local copy of the salon print sheets', () => {
  it('lists live sheets, newest first', () => {
    db.all.mockReturnValue([row()]);
    const list = labelPrintOrderRepo.list();
    expect(list).toHaveLength(1);
    expect(list[0].order).toEqual({ customerName: 'MoonCollection' });
    const sql = String(db.all.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('deleted_at IS NULL');
    expect(sql).toContain('ORDER BY updated_at DESC');
  });

  it('skips a sheet it cannot read rather than losing the whole list', () => {
    db.all.mockReturnValue([row({ id: 'broken', payload: '{{{' }), row({ id: 'good' })]);
    expect(labelPrintOrderRepo.list().map((entry) => entry.id)).toEqual(['good']);
  });

  it('marks a written sheet dirty, so the sync knows to push it', () => {
    labelPrintOrderRepo.save({
      id: 'order-1',
      name: 'MOON',
      savedAt: '2026-09-06T11:00:00.000Z',
      order: { a: 1 },
    });
    expect(lastSql()).toContain('dirty = 1');
  });

  it('a saved sheet comes back from the dead, because staff delete by mistake', () => {
    labelPrintOrderRepo.save({ id: 'order-1', name: '', savedAt: 'now', order: {} });
    expect(lastSql()).toContain('deleted_at = NULL');
  });

  it('keeps a deleted sheet as a tombstone until the server has been told', () => {
    labelPrintOrderRepo.remove('order-1', '2026-09-06T12:00:00.000Z');
    const sql = lastSql();
    expect(sql).toContain('UPDATE label_print_orders SET deleted_at = ?');
    expect(sql).toContain('dirty = 1');
    expect(sql).not.toContain('DELETE FROM');
  });
});

describe('what comes down from the server', () => {
  it('is not allowed to overwrite an edit this machine has not pushed yet', () => {
    db.get.mockReturnValue(row({ dirty: 1 }));
    labelPrintOrderRepo.applyFromServer({
      id: 'order-1',
      name: 'server copy',
      payload: { customerName: 'OTHER' },
      updatedAt: '2026-09-06T09:00:00.000Z',
      deletedAt: null,
    });
    expect(db.run).not.toHaveBeenCalled();
  });

  it('is stored clean when nothing is pending here', () => {
    labelPrintOrderRepo.applyFromServer({
      id: 'order-1',
      name: 'server copy',
      payload: { customerName: 'OTHER' },
      updatedAt: '2026-09-06T09:00:00.000Z',
      deletedAt: null,
    });
    expect(lastSql()).toContain('dirty = 0');
  });

  it('removes a sheet deleted on another machine', () => {
    labelPrintOrderRepo.applyFromServer({
      id: 'order-1',
      name: '',
      payload: {},
      updatedAt: '2026-09-06T09:00:00.000Z',
      deletedAt: '2026-09-06T09:00:00.000Z',
    });
    expect(lastSql()).toContain('DELETE FROM label_print_orders WHERE id = ?');
  });
});

describe('acknowledging a push', () => {
  it('only clears the row that was actually sent', () => {
    // The operator can save the sheet again while the request is in flight.
    // Clearing dirty on that newer row would strand the newer edit here.
    labelPrintOrderRepo.markSynced('order-1', 'pushed-stamp', 'server-stamp', false);
    const [sql, params] = db.run.mock.calls.at(-1)!;
    expect(String(sql).replace(/\s+/g, ' ')).toContain('updated_at = ? AND dirty = 1');
    expect(params).toEqual(['server-stamp', 'order-1', 'pushed-stamp']);
  });

  it('drops the tombstone once the deletion is on the server', () => {
    labelPrintOrderRepo.markSynced('order-1', 'pushed-stamp', 'ignored', true);
    const [sql, params] = db.run.mock.calls.at(-1)!;
    expect(String(sql).replace(/\s+/g, ' ')).toContain('DELETE FROM label_print_orders');
    expect(params).toEqual(['order-1', 'pushed-stamp']);
  });
});
