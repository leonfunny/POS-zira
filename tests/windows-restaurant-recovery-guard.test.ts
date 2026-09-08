import { readFileSync } from 'node:fs';
import initSqlJs, { type Database as SqlDatabase } from 'sql.js';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESTAURANT_CHECK_SCHEMA } from '../src/shared/restaurant-check';

// Execute actual main-process methods without loading Electron or hardware.
const source = readFileSync(new URL('../src/main/modules/pos.module.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('pos.module.ts', source, ts.ScriptTarget.Latest, true);
const moduleClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'PosModule') as ts.ClassDeclaration;
const method = (name: string) => {
  const found = moduleClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  if (!found) throw new Error(`Missing actual PosModule method: ${name}`);
  return found.getText(ast);
};
const executable = ts.transpileModule(`class Probe {
  ${['assertNoUnownedRestaurantCheck', 'assertRestaurantCheckReleased', 'prepareOrdinaryPosPayment', 'assertOrdinaryPosPaymentPreflight'].map(method).join('\n')}
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let sql: SqlDatabase;
const scope = { salonId: 'salon', userId: 'staff', registerId: 'windows-register' };
const orderId = '11111111-1111-4111-8111-111111111111';
function harness() {
  const database = { get: (query: string, params: any[]) => {
    const statement = sql.prepare(query);
    try { statement.bind(params); return statement.step() ? statement.getAsObject() : null; }
    finally { statement.free(); }
  } };
  const Probe = new Function('database', 'UUID_RE', 'assertLocalOpenShiftMatchesSession', 'randomUUID',
    'POS_PAYMENT_PREFLIGHT_TTL_MS', executable + '\nreturn Probe;')(
    database, /^[0-9a-f-]{36}$/i, () => ({ id: 'shift' }), () => 'preflight-token', 60000);
  const probe = new Probe();
  probe.capturePosAuthContext = () => ({ scope, epoch: 1 });
  probe.isPosAuthContextCurrent = () => true;
  probe.restaurantCheckController = null;
  probe.assertServerShiftConsistentForPayment = vi.fn();
  probe.scheduleShiftVerification = vi.fn(async () => {});
  probe.pruneOrdinaryPaymentPreflights = vi.fn();
  probe.ordinaryPaymentPreflights = new Map();
  return probe;
}
function seed(status: string, salonId = scope.salonId, registerId = scope.registerId, userId = scope.userId) {
  sql.run(`INSERT INTO pos_restaurant_checks (id,salon_id,user_id,register_id,revision,status,covers,snapshot_json,created_at,updated_at)
    VALUES ('saved-check',?,?,?,1,?,0,'{}','2026-09-08T10:00:00Z','2026-09-08T10:00:00Z')`, [salonId, userId, registerId, status]);
}
beforeEach(async () => { sql = new (await initSqlJs()).Database(); sql.run(RESTAURANT_CHECK_SCHEMA); });
afterEach(() => { sql.close(); vi.restoreAllMocks(); });

describe('Windows persisted restaurant recovery guard', () => {
  it.each(['OPEN', 'PAYMENT_PENDING', 'PAYMENT_UNCERTAIN'])('blocks fresh payment and workflow change after restart with %s', async status => {
    seed(status);
    const SQL = await initSqlJs(); const restored = new SQL.Database(sql.export()); sql.close(); sql = restored;
    const probe = harness();
    expect(() => probe.assertNoUnownedRestaurantCheck()).toThrow('Recover or reconcile');
    expect(() => probe.assertRestaurantCheckReleased()).toThrow('Recover or reconcile');
    await expect(probe.prepareOrdinaryPosPayment(orderId)).rejects.toThrow('Recover or reconcile');
    expect(probe.scheduleShiftVerification).not.toHaveBeenCalled();
    expect(probe.ordinaryPaymentPreflights.size).toBe(0);
  });
  it('blocks another operator on the same salon/register', () => {
    seed('PAYMENT_PENDING', scope.salonId, scope.registerId, 'previous-staff');
    expect(() => harness().assertNoUnownedRestaurantCheck()).toThrow('Recover or reconcile');
  });
  it.each([['other-salon', scope.registerId], [scope.salonId, 'other-register']])('does not block unrelated scope %s/%s', async (salonId, registerId) => {
    seed('PAYMENT_PENDING', salonId, registerId);
    expect(await harness().prepareOrdinaryPosPayment(orderId)).toMatchObject({ token: 'preflight-token' });
  });
  it.each(['SAVED', 'PAID', 'CANCELLED'])('allows fresh payment for a non-active %s check', async status => {
    seed(status);
    expect(await harness().prepareOrdinaryPosPayment(orderId)).toMatchObject({ token: 'preflight-token' });
  });
  it('allows owned recovery flow while still prohibiting unrelated workflow switches', async () => {
    seed('OPEN'); const probe = harness();
    probe.restaurantCheckController = { activeId: 'saved-check', hasActive: true, busy: false, blocked: false };
    expect(() => probe.assertNoUnownedRestaurantCheck()).not.toThrow();
    const proof = await probe.prepareOrdinaryPosPayment(orderId);
    expect(() => probe.assertOrdinaryPosPaymentPreflight(proof.token, orderId, probe.capturePosAuthContext())).not.toThrow();
    expect(() => probe.assertRestaurantCheckReleased()).toThrow('Save the active restaurant check');
  });
  it('rechecks persisted ownership when consuming a previously issued payment preflight', async () => {
    const probe = harness(); const proof = await probe.prepareOrdinaryPosPayment(orderId);
    seed('PAYMENT_UNCERTAIN');
    expect(() => probe.assertOrdinaryPosPaymentPreflight(proof.token, orderId, probe.capturePosAuthContext())).toThrow('Recover or reconcile');
  });
  it('releases the restart gate only after durable recovery changes the row to PAID', async () => {
    seed('PAYMENT_PENDING'); const probe = harness();
    await expect(probe.prepareOrdinaryPosPayment(orderId)).rejects.toThrow('Recover or reconcile');
    sql.run("UPDATE pos_restaurant_checks SET status='PAID' WHERE id='saved-check'");
    expect(await probe.prepareOrdinaryPosPayment(orderId)).toMatchObject({ token: 'preflight-token' });
  });
  it('wires the guard before direct order creation and new-check save, while leaving recovery open/list available', () => {
    const createStart = source.indexOf("ipcMain.handle('pos:orders:create'");
    const createEnd = source.indexOf("ipcMain.handle('pos:orders:", createStart + 30);
    const create = source.slice(createStart, createEnd);
    expect(createStart).toBeGreaterThan(0);
    expect(create.indexOf('this.assertNoUnownedRestaurantCheck()')).toBeGreaterThan(0);
    expect(create.indexOf('this.assertNoUnownedRestaurantCheck()')).toBeLessThan(create.indexOf('orderRepo.create('));
    const saveStart = source.indexOf("ipcMain.handle('pos:restaurant-checks:save-current'");
    const openStart = source.indexOf("ipcMain.handle('pos:restaurant-checks:open'", saveStart);
    expect(source.slice(saveStart, openStart)).toContain('this.assertNoUnownedRestaurantCheck()');
    const paymentStart = source.indexOf("ipcMain.handle('pos:restaurant-checks:begin-payment'", openStart);
    expect(source.slice(openStart, paymentStart)).not.toContain('assertNoUnownedRestaurantCheck');
    const dispatch = source.slice(source.indexOf("ipcMain.handle('pos:dispatch'"), source.indexOf("ipcMain.handle('pos:billiard:", source.indexOf("ipcMain.handle('pos:dispatch'")));
    expect(dispatch).toContain("action?.type !== 'display/setMode' && action?.type !== 'session/open'");
    expect(dispatch.indexOf('this.assertNoUnownedRestaurantCheck()')).toBeLessThan(dispatch.indexOf('posStore.dispatch(action)'));
  });
});
