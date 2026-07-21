import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import initSqlJs from 'sql.js';
import { database } from '../src/main/database/database';
import { billiardSessionRepo } from '../src/main/database/repos/billiard-session-repo';
import { resolveLiveTimeCharge } from '../src/renderer/components/billiard/utils';

const readSource = (relativePath: string): string =>
  readFileSync(join(__dirname, relativePath), 'utf8');

const MIN_MS = 60_000;

describe('resolveLiveTimeCharge — the sidebar charge must tick while a session runs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a live session ignores the placeholder timeCharge 0 and estimates from the rate', () => {
    // The cache hydrates timeCharge to 0 for a running session (the server only
    // computes it at end) — 0 must not be treated as authoritative.
    const session = {
      status: 'ACTIVE',
      billingMode: 'PER_HOUR',
      hourlyRate: 60,
      timeCharge: 0,
      startedAt: new Date(Date.now() - 40 * MIN_MS).toISOString(),
      totalPausedSeconds: 0,
    };
    expect(resolveLiveTimeCharge(session)).toBeCloseTo(40, 2);
  });

  it('a paused session shows the frozen estimate', () => {
    const session = {
      status: 'PAUSED',
      billingMode: 'PER_HOUR',
      hourlyRate: 60,
      timeCharge: 0,
      startedAt: new Date(Date.now() - 60 * MIN_MS).toISOString(),
      pausedAt: new Date(Date.now() - 20 * MIN_MS).toISOString(),
      totalPausedSeconds: 0,
    };
    expect(resolveLiveTimeCharge(session)).toBeCloseTo(40, 2);
  });

  it('an ended session keeps the authoritative server charge', () => {
    const session = {
      status: 'COMPLETED',
      billingMode: 'PER_HOUR',
      hourlyRate: 60,
      timeCharge: 131.8,
      startedAt: new Date(Date.now() - 300 * MIN_MS).toISOString(),
    };
    expect(resolveLiveTimeCharge(session)).toBe(131.8);
  });

  it('the popover consumes the helper instead of trusting a finite 0', () => {
    const popover = readSource('../src/renderer/components/billiard/TableActionPopover.tsx');
    expect(popover).toContain('resolveLiveTimeCharge');
    expect(popover).not.toContain('Number.isFinite(authoritativeTimeCharge)');
  });
});

describe('getPendingPayments — a voided session leaves the list immediately', () => {
  it('excludes VOID (and PAID) rows without waiting for the next server pull', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE billiard_sessions (
        id TEXT PRIMARY KEY, resource_id TEXT, status TEXT, billing_mode TEXT,
        guest_count INTEGER, started_at TEXT, paused_at TEXT, ended_at TEXT,
        total_minutes REAL, total_charges INTEGER, combo_id TEXT, notes TEXT,
        payload_json TEXT, updated_at TEXT
      );
      CREATE TABLE billiard_session_items (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, variant_id TEXT,
        name TEXT NOT NULL, quantity INTEGER, unit_price INTEGER
      );
    `);
    vi.spyOn(database as any, 'run').mockImplementation(
      (sql: string, params?: any[]) => db.run(sql, params),
    );
    vi.spyOn(database as any, 'all').mockImplementation(
      (sql: string, params?: any[]) => {
        const statement = db.prepare(sql);
        const rows: any[] = [];
        try {
          statement.bind(params || []);
          while (statement.step()) rows.push(statement.getAsObject());
        } finally {
          statement.free();
        }
        return rows;
      },
    );

    const base = {
      id: 'session-1',
      resourceId: 'table-1',
      status: 'COMPLETED',
      billingMode: 'PER_HOUR',
      endedAt: '2026-07-21T10:00:00.000Z',
      totalCharge: '131.80',
    };

    billiardSessionRepo.upsertOne({ ...base, paymentStatus: 'UNPAID' });
    expect(billiardSessionRepo.getPendingPayments().map((s) => s.id)).toEqual(['session-1']);

    billiardSessionRepo.upsertOne({ ...base, paymentStatus: 'VOID', voidReason: 'walked out' });
    expect(billiardSessionRepo.getPendingPayments()).toEqual([]);

    billiardSessionRepo.upsertOne({ ...base, id: 'session-2', paymentStatus: 'PAID' });
    expect(billiardSessionRepo.getPendingPayments()).toEqual([]);

    vi.restoreAllMocks();
    db.close();
  });
});

describe('touch keyboard — dialogs stay above it and the field stays visible', () => {
  it('every billiard fixed dialog lifts its bottom by the keyboard inset', () => {
    const dialogs = [
      'ReservationPanel.tsx',
      'AddTableDialog.tsx',
      'UnsettledPanel.tsx',
      'TableActionPopover.tsx',
      'PaymentDialog.tsx',
      'AddItemToTabModal.tsx',
      'TransferTableDialog.tsx',
    ];
    for (const file of dialogs) {
      const source = readSource(`../src/renderer/components/billiard/${file}`);
      expect(source, `${file} must consume --touch-keyboard-inset`).toContain('--touch-keyboard-inset');
    }
  });

  it('the keyboard manager scrolls the focused field into view once the keyboard is up', () => {
    const manager = readSource('../src/renderer/hooks/useKeyboardManager.ts');
    expect(manager).toContain('scrollIntoView');
  });
});
