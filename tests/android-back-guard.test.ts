// @vitest-environment happy-dom
/**
 * Task 6 of docs/superpowers/plans/2026-07-25-android-pos-device-readiness-fixes.md.
 *
 * Verified against the real Capacitor 8 source: BridgeActivity extends
 * AppCompatActivity and nothing in `com.getcapacitor` touches the back press,
 * so the plain Android default applies and the activity just finishes. With no
 * guard, one accidental press ends the app mid-sale.
 *
 * The decision function fails SAFE in every uncertain case: if it cannot ask,
 * it stays.
 */
import { describe, expect, test, vi } from 'vitest';

import { handleBackPress, installBackGuard } from '../src/renderer/android-pos/shim/back-guard';
import {
  isCustomerCheckinKioskActive,
  setCustomerCheckinKioskActive,
} from '../src/renderer/android-pos/shim/kiosk-state';

describe('handleBackPress', () => {
  test('exits without asking when the cart is empty', () => {
    const exitApp = vi.fn();
    const confirm = vi.fn(() => true);
    const outcome = handleBackPress({ getCartItemCount: () => 0, confirm, exitApp });
    expect(outcome).toBe('exited');
    expect(confirm).not.toHaveBeenCalled();
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  test('never exits while the customer check-in kiosk owns the screen', () => {
    const exitApp = vi.fn();
    const confirm = vi.fn(() => true);
    setCustomerCheckinKioskActive(true);
    try {
      const outcome = handleBackPress({
        isExitBlocked: isCustomerCheckinKioskActive,
        getCartItemCount: () => 0,
        confirm,
        exitApp,
      });
      expect(outcome).toBe('kept');
      expect(confirm).not.toHaveBeenCalled();
      expect(exitApp).not.toHaveBeenCalled();
    } finally {
      setCustomerCheckinKioskActive(false);
    }
  });

  test('fails closed when kiosk ownership cannot be read', () => {
    const exitApp = vi.fn();
    const outcome = handleBackPress({
      isExitBlocked: () => { throw new Error('shell state unavailable'); },
      getCartItemCount: () => 0,
      confirm: () => true,
      exitApp,
    });
    expect(outcome).toBe('kept');
    expect(exitApp).not.toHaveBeenCalled();
  });

  test('asks before exiting when the cart has lines', () => {
    const exitApp = vi.fn();
    const confirm = vi.fn(() => true);
    const outcome = handleBackPress({ getCartItemCount: () => 3, confirm, exitApp });
    expect(outcome).toBe('exited');
    expect(confirm).toHaveBeenCalledTimes(1);
    // The cashier is told HOW MANY lines are at stake, not just "are you sure".
    expect(String(confirm.mock.calls[0][0])).toContain('3');
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  test('stays in the app when the cashier declines', () => {
    const exitApp = vi.fn();
    const outcome = handleBackPress({
      getCartItemCount: () => 2,
      confirm: () => false,
      exitApp,
    });
    expect(outcome).toBe('kept');
    expect(exitApp).not.toHaveBeenCalled();
  });

  test('never exits when the confirm dialog itself throws', () => {
    // A WebView that cannot show a dialog must not be a licence to exit.
    const exitApp = vi.fn();
    const outcome = handleBackPress({
      getCartItemCount: () => 1,
      confirm: () => { throw new Error('no dialog in this WebView'); },
      exitApp,
    });
    expect(outcome).toBe('kept');
    expect(exitApp).not.toHaveBeenCalled();
  });

  test('a cart-count read that throws is treated as "has work" and never exits', () => {
    const exitApp = vi.fn();
    const outcome = handleBackPress({
      getCartItemCount: () => { throw new Error('store not ready'); },
      confirm: () => true,
      exitApp,
    });
    expect(outcome).toBe('kept');
    expect(exitApp).not.toHaveBeenCalled();
  });
});

describe('installBackGuard', () => {
  test('reacts to the native ziraBackPressed event', () => {
    const exitApp = vi.fn();
    const dispose = installBackGuard(window as any, { getCartItemCount: () => 0, confirm: () => true, exitApp });
    window.dispatchEvent(new Event('ziraBackPressed'));
    expect(exitApp).toHaveBeenCalledTimes(1);
    dispose();
  });

  test('the returned disposer stops handling further presses', () => {
    const exitApp = vi.fn();
    const dispose = installBackGuard(window as any, {
      getCartItemCount: () => 0, confirm: () => true, exitApp,
    });
    dispose();
    window.dispatchEvent(new Event('ziraBackPressed'));
    expect(exitApp).not.toHaveBeenCalled();
  });
});
