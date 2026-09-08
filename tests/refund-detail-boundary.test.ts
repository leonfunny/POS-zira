import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { validateRefundDetailIdentity } from '../src/shared/refund-authority';
import { adaptServerOrder, adaptServerOrderItem } from '../src/shared/pos-order-adapter';

// Execute the actual IPC callback without booting Electron, hardware or live DB.
const source = readFileSync(new URL('../src/main/modules/pos.module.ts', import.meta.url), 'utf8');
const start = source.indexOf("ipcMain.handle('pos:orders:getRefundDetail',");
const end = source.indexOf("ipcMain.handle('pos:orders:getTodayServer',", start);
if (start < 0 || end < 0) throw new Error('Refund detail handler boundary not found');
const executable = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(raw: any) {
  const state = { token: 'jwt', serverUrl: 'https://pos.test', current: true };
  const apiClient = { getServerOrderDetail: vi.fn(async () => raw) };
  const itemAdapter = vi.fn(adaptServerOrderItem);
  let handler: (...args: any[]) => Promise<any>;
  const register = new Function('ipcMain', 'orderRepo', 'getSecureAuthToken', 'getConfig',
    'apiClient', 'adaptServerOrder', 'adaptServerOrderItem', 'validateRefundDetailIdentity', 'logger', executable);
  register.call({ capturePosAuthContext: () => ({ scope: { salonId: 'salon-a' } }),
    isPosAuthContextCurrent: () => state.current },
  { handle: (_: string, callback: typeof handler) => { handler = callback; } },
  { getById: () => ({ id: 'local-order', backend_id: 'server-order', total: 2000 }) },
  () => state.token, () => ({ serverUrl: state.serverUrl }), apiClient,
  adaptServerOrder, itemAdapter, validateRefundDetailIdentity, { warn: vi.fn() });
  return { state, apiClient, itemAdapter, run: () => handler!(null, 'local-order') };
}
const detail = (): any => ({ id: 'server-order', salonId: 'salon-a', total: 20,
  createdAt: '2026-09-08T10:00:00.000Z', status: 'COMPLETED', paymentMethod: 'CASH',
  items: [{ id: 'item-a', orderId: 'server-order', productId: 'same-product', quantity: 1, unitPrice: 10, total: 10 },
    { id: 'item-b', orderId: 'server-order', productId: 'same-product', quantity: 1, unitPrice: 10, total: 10 }] });

describe('Windows authoritative refund detail IPC boundary', () => {
  it('retains server item identity and local order alias before opening the shared panel', async () => {
    const h = harness(detail());
    const result = await h.run();
    expect(result.success).toBe(true);
    expect(result.detail.order).toMatchObject({ id: 'local-order', backend_id: 'server-order' });
    expect(result.detail.items.map((item: any) => item.id)).toEqual(['item-a', 'item-b']);
    expect(result.detail.items.every((item: any) => item.order_id === 'local-order')).toBe(true);
  });

  it.each(['missing-id', 'duplicate-id', 'wrong-parent', 'wrong-salon', 'wrong-order'])('rejects %s before an adapter can synthesize identity', async kind => {
    const raw = detail();
    if (kind === 'missing-id') delete raw.items[0].id;
    if (kind === 'duplicate-id') raw.items[1].id = raw.items[0].id;
    if (kind === 'wrong-parent') raw.items[0].orderId = 'other-order';
    if (kind === 'wrong-salon') raw.items[0].salonId = 'other-salon';
    if (kind === 'wrong-order') raw.id = 'other-order';
    const h = harness(raw);
    expect(await h.run()).toMatchObject({ success: false });
    expect(h.itemAdapter).not.toHaveBeenCalled();
  });

  it.each(['auth', 'token', 'server'])('rejects %s change while awaiting server detail, without trying another endpoint', async kind => {
    const h = harness(null);
    h.apiClient.getServerOrderDetail.mockImplementation(async () => {
      if (kind === 'auth') h.state.current = false;
      if (kind === 'token') h.state.token = 'another-jwt';
      if (kind === 'server') h.state.serverUrl = 'https://other.test';
      return null;
    });
    expect(await h.run()).toMatchObject({ success: false, error: 'Refund detail authentication context changed' });
    expect(h.apiClient.getServerOrderDetail).toHaveBeenCalledTimes(1);
    expect(h.itemAdapter).not.toHaveBeenCalled();
  });

  it('validates the alternate cash/invoiced response as well', async () => {
    const raw = detail(); delete raw.items[0].id;
    const h = harness(raw);
    h.apiClient.getServerOrderDetail.mockResolvedValueOnce(null);
    expect(await h.run()).toMatchObject({ success: false });
    expect(h.apiClient.getServerOrderDetail).toHaveBeenCalledTimes(2);
    expect(h.itemAdapter).not.toHaveBeenCalled();
  });
});
