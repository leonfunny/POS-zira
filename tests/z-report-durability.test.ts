import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';

import { migrations } from '../src/main/database/migrations';

describe('durable Z-report recovery', () => {
  it('adds a versioned shift ledger without replaying historical closed shifts', () => {
    const migration = migrations.find((item) => item.version === 67);

    expect(migration).toMatchObject({ name: 'shift_z_report_ledger' });
    expect(migration?.up).toContain('ADD COLUMN z_report_payload TEXT');
    expect(migration?.up).toContain('ADD COLUMN z_report_status TEXT');
    expect(migration?.up).toContain('ADD COLUMN z_report_attempts INTEGER NOT NULL DEFAULT 0');
    expect(migration?.up).toContain("SET z_report_status = 'COMPLETED'");
    expect(migration?.up).toContain('WHERE closed_at IS NOT NULL');
  });

  it('executes the upgrade against an existing shift table', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE shifts (id TEXT PRIMARY KEY, closed_at TEXT)');
    db.run("INSERT INTO shifts (id, closed_at) VALUES ('old-closed', '2026-08-29 18:00:00')");
    db.run("INSERT INTO shifts (id, closed_at) VALUES ('still-open', NULL)");

    const migration = migrations.find((item) => item.version === 67);
    expect(migration).toBeDefined();
    db.run(migration!.up);

    const columns = db.exec('PRAGMA table_info(shifts)')[0].values
      .map((row) => String(row[1]));
    expect(columns).toEqual(expect.arrayContaining([
      'z_report_payload',
      'z_report_status',
      'z_report_attempts',
      'z_report_error',
      'z_report_dispatched_at',
      'z_report_completed_at',
    ]));
    const rows = db.exec(
      'SELECT id, z_report_status FROM shifts ORDER BY id',
    )[0].values;
    expect(rows).toEqual([
      ['old-closed', 'COMPLETED'],
      ['still-open', null],
    ]);
    db.close();
  });

  it('persists DISPATCHING before printing and persists COMPLETED afterwards', () => {
    const source = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    const dispatch = source.slice(
      source.indexOf('private async dispatchDurableZReport'),
      source.indexOf('private completeDurableShiftClose'),
    );

    const begin = dispatch.indexOf('beginZReportPrint');
    const dispatchBarrier = dispatch.indexOf(
      'const dispatchFlush = await database.saveCoalesced()',
    );
    const printerCall = dispatch.indexOf('printZReport(report)');
    const completed = dispatch.indexOf('markZReportCompleted');
    const completionBarrier = dispatch.indexOf(
      'const completionFlush = await database.saveCoalesced()',
    );

    expect(begin).toBeGreaterThan(-1);
    expect(dispatchBarrier).toBeGreaterThan(begin);
    expect(printerCall).toBeGreaterThan(dispatchBarrier);
    expect(completed).toBeGreaterThan(printerCall);
    expect(completionBarrier).toBeGreaterThan(completed);
    expect(dispatch).toContain('needsReview: !safeToRetry || !failureFlush.success');
  });

  it('exposes explicit retry and already-printed decisions to the renderer', () => {
    const moduleSource = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    const preloadSource = readFileSync(
      new URL('../src/preload/preload-pos.ts', import.meta.url),
      'utf8',
    );
    const rendererSource = readFileSync(
      new URL('../src/renderer/components/pos/POSLayout.tsx', import.meta.url),
      'utf8',
    );

    expect(moduleSource).toContain("ipcMain.handle('pos:shift:z-report:get-pending'");
    expect(moduleSource).toContain("'pos:shift:z-report:retry'");
    expect(moduleSource).toContain("'pos:shift:z-report:mark-printed'");
    expect(preloadSource).toContain('getPendingZReport:');
    expect(preloadSource).toContain('retryZReport:');
    expect(preloadSource).toContain('markZReportPrinted:');
    expect(rendererSource).toContain('confirmUncertainReprint: uncertain');
    expect(rendererSource).toContain('handleZReportMarkPrinted');
  });
});
