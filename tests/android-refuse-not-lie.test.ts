import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { __resetShimForTest, installShim } from '../src/renderer/android-pos/shim/index';
import type { ShimTransport } from '../src/renderer/android-pos/shim/transport';

const INVALID_ARGUMENT = () => undefined;

// Transport-backed synthetic fallbacks are intentionally outside this guard:
// they are conditional boot fakes, not unconditional stubs. Refusing transport
// methods below ensure the walk tests only methods that claim success regardless
// of whether Android actually performed an operation.
const REFUSING_TRANSPORT = {
  loginWithEmail: async () => ({ success: false, error: 'invalid-test-input' }),
  getUser: async () => ({ success: false, error: 'invalid-test-input' }),
  logout: async () => ({ success: false, error: 'invalid-test-input' }),
  requestReceiptPrint: async () => ({ success: false, receiptPrinted: false, error: 'invalid-test-input' }),
  requestFiscalPrint: async () => ({ success: false, fiscalPrinted: false, error: 'invalid-test-input' }),
  createOrder: async () => ({ success: false, error: 'invalid-test-input' }),
  retryOrderSync: async () => ({ success: false, error: 'invalid-test-input' }),
  openShift: async () => ({ success: false, error: 'invalid-test-input' }),
  closeShift: async () => ({ success: false, error: 'invalid-test-input' }),
  syncProducts: async () => ({ success: false, error: 'invalid-test-input' }),
  syncStaff: async () => ({ success: false, error: 'invalid-test-input' }),
  billiardRecover: async () => ({ success: false, error: 'invalid-test-input' }),
  billiardPrintReceipt: async () => ({ success: false, receiptPrinted: false, error: 'invalid-test-input' }),
} as unknown as ShimTransport;

// These literals report successful reads/status checks, deliberately benign
// excluded-surface no-ops, or Android's real single-window behavior. Adding a
// path requires an explicit review: mutation stubs must refuse by default.
const ALLOWED_UNCONDITIONAL_SUCCESS = new Set([
  // KNOWN GAP, not a blessing. Windows' preflight verifies the shift against
  // the server, re-checks the auth context, and issues a random single-use
  // token bound to (orderId, shiftId, authContext) that is validated again at
  // commit. Android's returns success with a token derived from the orderId and
  // verifies nothing. A local open shift IS still enforced in
  // real-transport.createOrder, which covers the common case; the hole is a
  // shift closed server-side, or the user changing mid-payment. Tracked as M1 in
  // docs/android-pos/2026-08-04-android-pos-review-fix-plan.md — delete this
  // entry when that lands, and this guard will hold the new behavior.
  'pos.payment.preflight',

  // Connection/status probes do not claim a business mutation occurred.
  'connect',
  'disconnect',
  'pos.payment.hasFiscalPrinter',
  'pos.payment.getPrintAttempts',
  'pos.payment.getLatestFiscalAttempt',
  'pos.payment.getReconcilableFiscalAttempt',
  'pos.orders.getServerHistory',
  'pos.orders.getTodayServer',
  'pos.sync.eventStatus',
  'pos.sync.flushEvents',

  // Excluded/admin no-ops that no reachable screen calls today: the renderer has
  // no caller for repairStockFailures or resolveConflict, and
  // QuickKeysLayoutManager.tsx (the only caller of the quickKeys mutations) has
  // no importer in the tree. They are allowlisted because nothing can observe
  // the lie, NOT because faking success is acceptable — wire any of these to a
  // screen and it must refuse first.
  'pos.orders.repairStockFailures',
  'pos.sync.resolveConflict',
  'pos.quickKeys.create',
  'pos.quickKeys.update',
  'pos.quickKeys.remove',
  'pos.quickKeys.assign',
  'pos.seedDemo',

  // Android is single-window, so these operations are already satisfied.
  'window.open',
  'window.close',
  'window.setFullScreen',
  'window.setKiosk',
]);

async function findUnexpectedSuccesses(
  value: unknown,
  path: string[] = [],
): Promise<string[]> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return [];

  const unexpected: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = [...path, key];
    if (typeof child === 'function') {
      try {
        const result = await child(
          INVALID_ARGUMENT,
          INVALID_ARGUMENT,
          INVALID_ARGUMENT,
          INVALID_ARGUMENT,
        );
        if (
          result
          && typeof result === 'object'
          && (result as { success?: unknown }).success === true
          && !ALLOWED_UNCONDITIONAL_SUCCESS.has(childPath.join('.'))
        ) {
          unexpected.push(childPath.join('.'));
        }
      } catch {
        // Rejection/throw is a refusal for this guard's purpose.
      }
      continue;
    }
    unexpected.push(...await findUnexpectedSuccesses(child, childPath));
  }
  return unexpected;
}

describe('Android stubs refuse instead of reporting fake success', () => {
  let api: ReturnType<typeof installShim>['api'];

  beforeEach(() => {
    __resetShimForTest();
    api = installShim({ transport: REFUSING_TRANSPORT }).api;
  });

  afterEach(() => __resetShimForTest());

  test.each([
    ['pos.orders.mutate', () => api.pos.orders.mutate('missing-order', { type: 'void' })],
    ['pos.payment.reconcileFiscalAttempt', () => api.pos.payment.reconcileFiscalAttempt('missing-order', true)],
    ['pos.hold.create', () => api.pos.hold.create({ id: 'missing-hold' })],
    ['pos.hold.remove', () => api.pos.hold.remove('missing-hold')],
  ])('%s refuses with an error', async (_path, call) => {
    const result = await call();
    expect(result.success).toBe(false);
    expect(result.error).toEqual(expect.any(String));
    expect(result.error.trim()).not.toBe('');
  });

  test('order mutation guidance preserves the working delete-local alternative', async () => {
    const result = await api.pos.orders.mutate('missing-order', { type: 'void' });
    expect(result.error).toMatch(/delete local/i);
  });

  test('no method outside the reviewed allowlist reports success for invalid arguments', async () => {
    await expect(findUnexpectedSuccesses(api)).resolves.toEqual([]);
  });
});
