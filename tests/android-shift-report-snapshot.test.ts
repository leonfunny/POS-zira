import { describe, expect, it } from 'vitest';
import { initAndroidDb } from '../src/renderer/android-pos/shim/db/db';
import { createOrderRepo } from '../src/renderer/android-pos/shim/db/order-repo';
import { MemoryAndroidPersistence } from './helpers/android-persistence';

async function setup() {
  const persistence = new MemoryAndroidPersistence();
  const db = await initAndroidDb({ locateFile: null, persistence });
  db.run(`INSERT INTO shifts (id,staff_name,opening_cash,opened_at) VALUES ('shift','Owner',100,'2026-09-08T08:00:00Z')`);
  db.run(`INSERT INTO orders (id,shift_id,status,total,discount,payment_method,payment_amount,change_amount,refund_amount,synced)
    VALUES ('order','shift','PARTIAL_REFUND',2000,100,'CASH',2500,500,500,1)`);
  return { db, persistence, repo: createOrderRepo(db) };
}
const fields = ['openingCash', 'closingCash', 'totalSales', 'totalOrders', 'cashTotal', 'cardTotal',
  'blikTotal', 'transferTotal', 'totalRefunds', 'totalDiscounts', 'totalTips', 'difference', 'unsyncedOrders'];

describe('Android immutable close report snapshots', () => {
  it('stores the unchanged legacy calculation together with cash/date and does not flush itself', async () => {
    const { db, persistence, repo } = await setup();
    const report = repo.closeShift('shift', 1600);
    expect(report).toMatchObject({ shiftId: 'shift', staffName: 'Owner', openingCash: 100, closingCash: 1600,
      totalSales: 1500, totalOrders: 1, cashTotal: 1500, cardTotal: 0, blikTotal: 0, transferTotal: 0,
      totalRefunds: 500, totalDiscounts: 100, totalTips: 0, difference: 0, unsyncedOrders: 0 });
    const shift = db.get<any>("SELECT * FROM shifts WHERE id='shift'");
    expect(shift.closed_at).toBe(report.closedAt);
    expect(shift.closing_cash).toBe(report.closingCash);
    expect(JSON.parse(shift.close_report_json)).toEqual(report);
    expect(persistence.image).toBeNull();
    await db.flush();
  });

  it('reuses exact snapshot bytes on repeat/restart despite later order changes and a different invalid cash argument', async () => {
    const { db, persistence, repo } = await setup();
    const report = repo.closeShift('shift', 1600);
    const shift = db.get<any>("SELECT * FROM shifts WHERE id='shift'");
    db.run("UPDATE orders SET total=999999,refund_amount=999999,payment_method='CARD',synced=0");
    expect(repo.closeShift('shift', NaN)).toEqual(report);
    expect(repo.getClosedShiftReport('shift')).toEqual(report);
    expect(db.get("SELECT * FROM shifts WHERE id='shift'")).toEqual(shift);
    report.cashTotal = 42; // A caller cannot mutate the stored report by reference.
    expect(repo.getClosedShiftReport('shift')?.cashTotal).toBe(1500);
    await db.flush();
    const restarted = await initAndroidDb({ locateFile: null, persistence });
    expect(createOrderRepo(restarted).closeShift('shift', -1)).toEqual(JSON.parse(shift.close_report_json));
    expect(restarted.get("SELECT * FROM shifts WHERE id='shift'")).toEqual(shift);
  });

  it('does not fabricate reports for absent, open or legacy closed shifts', async () => {
    const { db, repo } = await setup();
    expect(repo.getClosedShiftReport('missing')).toBeNull();
    expect(repo.getClosedShiftReport('shift')).toBeNull();
    db.run("UPDATE shifts SET closed_at='2026-09-08T17:00:00Z',closing_cash=1600 WHERE id='shift'");
    expect(repo.getClosedShiftReport('shift')).toBeNull();
    expect(() => repo.closeShift('shift', 1)).toThrow('already closed');
    expect(db.get<any>("SELECT close_report_json FROM shifts WHERE id='shift'")?.close_report_json).toBeNull();
    await db.flush();
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', null])('rejects invalid new closing cash %s before changing the shift', async value => {
    const { db, repo } = await setup();
    const before = db.get("SELECT * FROM shifts WHERE id='shift'");
    expect(() => repo.closeShift('shift', value as number)).toThrow(/closing cash/i);
    expect(db.get("SELECT * FROM shifts WHERE id='shift'")).toEqual(before);
    await db.flush();
  });

  it.each(['not-json', 'null', '[]', '{}'])('rejects malformed snapshot %s instead of recomputing orders', async json => {
    const { db, repo } = await setup(); repo.closeShift('shift', 1600);
    db.run("UPDATE shifts SET close_report_json=? WHERE id='shift'", [json]);
    expect(() => repo.getClosedShiftReport('shift')).toThrow('ANDROID_SHIFT_REPORT_INVALID');
    expect(() => repo.closeShift('shift', 1600)).toThrow('ANDROID_SHIFT_REPORT_INVALID');
    await db.flush();
  });

  it.each(['shiftId', 'openingCash', 'closingCash', 'openedAt', 'closedAt'])('rejects a snapshot with mismatched %s', async field => {
    const { db, repo } = await setup(); const report = repo.closeShift('shift', 1600);
    report[field] = typeof report[field] === 'number' ? report[field] + 1 : 'different';
    db.run("UPDATE shifts SET close_report_json=? WHERE id='shift'", [JSON.stringify(report)]);
    expect(() => repo.getClosedShiftReport('shift')).toThrow('ANDROID_SHIFT_REPORT_INVALID');
    await db.flush();
  });

  it.each(fields)('requires safe integer field %s in a persisted report', async field => {
    const { db, repo } = await setup(); const report = repo.closeShift('shift', 1600);
    report[field] = 1.25;
    db.run("UPDATE shifts SET close_report_json=? WHERE id='shift'", [JSON.stringify(report)]);
    expect(() => repo.getClosedShiftReport('shift')).toThrow('ANDROID_SHIFT_REPORT_INVALID');
    delete report[field];
    db.run("UPDATE shifts SET close_report_json=? WHERE id='shift'", [JSON.stringify(report)]);
    expect(() => repo.getClosedShiftReport('shift')).toThrow('ANDROID_SHIFT_REPORT_INVALID');
    await db.flush();
  });

  it.each(['totalOrders', 'unsyncedOrders', 'totalRefunds', 'totalDiscounts', 'totalTips'])('rejects negative count/non-net amount %s', async field => {
    const { db, repo } = await setup(); const report = repo.closeShift('shift', 1600); report[field] = -1;
    db.run("UPDATE shifts SET close_report_json=? WHERE id='shift'", [JSON.stringify(report)]);
    expect(() => repo.getClosedShiftReport('shift')).toThrow('ANDROID_SHIFT_REPORT_INVALID'); await db.flush();
  });

  it('allows negative net totals, but rejects snapshots attached to open rows or invalid stored dates', async () => {
    const { db, repo } = await setup();
    db.run("UPDATE orders SET refund_amount=3000 WHERE id='order'");
    const report = repo.closeShift('shift', 0);
    expect(report.totalSales).toBe(-1000); expect(report.cashTotal).toBe(-1000);
    expect(repo.getClosedShiftReport('shift')).toEqual(report);
    db.run("UPDATE shifts SET closed_at=NULL WHERE id='shift'");
    expect(() => repo.getClosedShiftReport('shift')).toThrow('ANDROID_SHIFT_REPORT_INVALID');
    expect(() => repo.closeShift('shift', 0)).toThrow('ANDROID_SHIFT_REPORT_INVALID');
    db.run("UPDATE shifts SET opened_at='invalid',closed_at=? WHERE id='shift'", [report.closedAt]);
    report.openedAt = 'invalid';
    db.run("UPDATE shifts SET close_report_json=? WHERE id='shift'", [JSON.stringify(report)]);
    expect(() => repo.getClosedShiftReport('shift')).toThrow('ANDROID_SHIFT_REPORT_INVALID'); await db.flush();
  });

  it('rolls back all closure fields if a trigger aborts snapshot persistence', async () => {
    const { db, repo } = await setup();
    const before = db.get("SELECT * FROM shifts WHERE id='shift'");
    db.run(`CREATE TRIGGER reject_close_snapshot AFTER UPDATE OF close_report_json ON shifts
      BEGIN SELECT RAISE(ABORT, 'snapshot write rejected'); END`);
    expect(() => repo.closeShift('shift', 1600)).toThrow('snapshot write rejected');
    expect(db.get("SELECT * FROM shifts WHERE id='shift'")).toEqual(before);
    db.run('DROP TRIGGER reject_close_snapshot');
    expect(repo.closeShift('shift', 1600).totalSales).toBe(1500); await db.flush();
  });

  it('rejects an unsafe computed report before finalizing the shift', async () => {
    const { db, repo } = await setup();
    const before = db.get("SELECT * FROM shifts WHERE id='shift'");
    db.run("UPDATE orders SET total=? WHERE id='order'", [Number.MAX_SAFE_INTEGER + 1024]);
    expect(() => repo.closeShift('shift', 1600)).toThrow('ANDROID_SHIFT_REPORT_INVALID');
    expect(db.get("SELECT * FROM shifts WHERE id='shift'")).toEqual(before); await db.flush();
  });
});
