import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildBilliardInterruptionHoldPayload,
  capturePosCheckoutSnapshot,
  withRestoredInterruptionMarker,
  withoutRestoredInterruptionMarker,
  restoredCartRecoveryDisposition,
} from '../src/main/pos/billiard-pos-handoff';
import { requiresBilliardTenderReconciliation } from '../src/shared/billiard-pos-handoff';
import { buildLegacyHeldCartImport } from '../src/main/pos/legacy-held-cart';
import type { PosState } from '../src/main/pos/pos-store';
import {
  containsProtectedCheckoutLine,
  shouldPersistLegacyActiveCart,
} from '../src/renderer/components/pos/active-cart-persistence';
import { buildImmediateRestoredCartReconciliation } from '../src/renderer/components/pos/restored-cart-reconciliation';

const scope = { salonId: 'salon-1', userId: 'owner-1', registerId: 'register-1' };

function state(): PosState {
  return {
    cart: {
      items: [{
        id: 'line-1',
        variantId: 'variant-1',
        name: 'Coffee',
        sku: 'COFFEE',
        price: 1200,
        quantity: 2,
        total: 2400,
        vatRate: 23,
      }],
      subtotal: 2400,
      discount: 400,
      discountType: 'fixed',
      tax: 449,
      total: 2000,
    },
    checkoutDraft: { customerNip: '1234567890', customerName: 'Test Sp. z o.o.' },
    session: {
      shiftId: 'shift-1',
      staffId: 'staff-1',
      staffName: 'Owner',
      isOpen: true,
      openedAt: '2026-07-22T10:00:00.000Z',
    },
    display: { mode: 'cart' },
    activeTable: 'table-7',
    activeCustomer: { id: 'customer-1', name: 'Test Sp. z o.o.', nip: '1234567890' },
    tip: 300,
  };
}

describe('Billiard interrupted-cart crash ownership', () => {
  it('registers a durable main-process handoff preflight before the server end path', () => {
    const mainSource = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    const preloadSource = readFileSync(
      new URL('../src/preload/preload.ts', import.meta.url),
      'utf8',
    );
    const paymentSource = readFileSync(
      new URL('../src/renderer/components/billiard/PaymentDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(mainSource).toContain("ipcMain.handle('pos:billiard:preflight-handoff'");
    expect(mainSource).toContain('assertLocalOpenShiftMatchesSession(database, this.posStore)');
    expect(mainSource).toContain('this.assertNewBilliardHandoffReadiness(scope)');
    expect(mainSource).toContain('const flush = await database.saveCoalesced()');
    expect(preloadSource).toContain("preflight: () => ipcRenderer.invoke('pos:billiard:preflight-handoff')");
    expect(paymentSource.indexOf('await onPreflightPos()'))
      .toBeLessThan(paymentSource.indexOf('endedSnapshot ?? await ensureEnded()'));
  });

  it('never classifies a persisted tender boundary as a resumable payment', () => {
    expect(requiresBilliardTenderReconciliation('POS_TENDER_COMMITTING')).toBe(true);
    expect(requiresBilliardTenderReconciliation('POS_TENDER_UNCERTAIN')).toBe(true);
    expect(requiresBilliardTenderReconciliation('POS_PAYMENT_OPEN')).toBe(false);

    const paymentSource = readFileSync(
      new URL('../src/renderer/components/pos/PaymentModal.tsx', import.meta.url),
      'utf8',
    );
    expect(paymentSource).toContain('billiardCheckout.beginTender(');
    expect(paymentSource).toContain('billiardCheckout.beginRestoredTender(');
    expect(paymentSource).toContain('protectedBoundaryPreparationStartedRef.current = true');
    expect(paymentSource).toContain("setProtectedBoundaryStatus('ready')");
    expect(paymentSource).toContain('Do not charge again. Reconcile');

    const mainSource = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    expect(mainSource).not.toContain("ipcMain.handle('pos:billiard:rollback-tender'");
    expect(mainSource).not.toContain('billiardTenderRollbackAuthorizations');
    expect(mainSource).toContain("ipcMain.handle('pos:restored-cart:begin-tender'");
  });

  it('keeps the full protected snapshot and can rehydrate it after a crash', () => {
    const original = capturePosCheckoutSnapshot(state(), scope, 'retail');
    const waiting = buildBilliardInterruptionHoldPayload({
      snapshot: original,
      checkoutId: 'checkout-1',
      sessionId: 'session-1',
    });
    const journal = {
      orderId: 'restored-order-1',
      clientAttemptId: 'restored:restored-order-1',
      state: 'READY' as const,
      updatedAt: '2026-07-22T10:01:00.000Z',
    };
    const active = { ...waiting, restoreState: 'ACTIVE_CART_BACKUP' as const, restoredCheckout: journal };

    // Simulated process restart: live state is gone; the protected payload is
    // still enough to restore every field plus main's ownership marker.
    const restored = withRestoredInterruptionMarker(active.snapshot, 'hold-1', 'checkout-1', journal);
    expect(restored.state.cart).toEqual(state().cart);
    expect(restored.state.checkoutDraft).toMatchObject({
      customerNip: '1234567890',
      restoredInterruption: {
        holdId: 'hold-1',
        checkoutId: 'checkout-1',
        orderId: 'restored-order-1',
        clientAttemptId: 'restored:restored-order-1',
        tenderState: 'READY',
      },
    });
    expect(restored.state.activeCustomer).toEqual(state().activeCustomer);
    expect(restored.state.activeTable).toBe('table-7');
    expect(restored.state.tip).toBe(300);

    const nextDurableSnapshot = withoutRestoredInterruptionMarker(restored);
    expect(nextDurableSnapshot.state.checkoutDraft.restoredInterruption).toBeUndefined();
    expect(nextDurableSnapshot.state.checkoutDraft.customerNip).toBe('1234567890');
  });

  it('never re-materializes a payable cart after a tender boundary survives a failed order export', () => {
    const original = capturePosCheckoutSnapshot(state(), scope, 'retail');
    const committing = {
      ...buildBilliardInterruptionHoldPayload({
        snapshot: original,
        checkoutId: 'checkout-1',
        sessionId: 'session-1',
      }),
      restoreState: 'ACTIVE_CART_BACKUP' as const,
      restoredCheckout: {
        orderId: 'restored-order-1',
        clientAttemptId: 'restored:restored-order-1',
        state: 'TENDER_COMMITTING' as const,
        updatedAt: '2026-07-22T10:02:00.000Z',
      },
    };

    // This is exactly the last durable image when sql.js creates the order in
    // RAM but atomic export fails. Every repeated restart stays fail-closed.
    expect(restoredCartRecoveryDisposition(committing, false)).toBe('RECONCILE');
    expect(restoredCartRecoveryDisposition(committing, false)).not.toBe('RESTORE');
    const uncertain = {
      ...committing,
      restoredCheckout: { ...committing.restoredCheckout, state: 'TENDER_UNCERTAIN' as const },
    };
    expect(restoredCartRecoveryDisposition(uncertain, false)).toBe('RECONCILE');
    expect(restoredCartRecoveryDisposition(uncertain, false)).not.toBe('RESTORE');
  });

  it('surfaces restored-cart uncertainty and owner reconciliation without an app restart', () => {
    const context = {
      holdId: 'hold-1',
      checkoutId: 'checkout-1',
      orderId: 'restored-order-1',
      clientAttemptId: 'restored:restored-order-1',
      tenderState: 'TENDER_UNCERTAIN' as const,
    };
    expect(buildImmediateRestoredCartReconciliation(context, 'Do not charge again.')).toEqual({
      holdId: 'hold-1',
      checkoutId: 'checkout-1',
      orderId: 'restored-order-1',
      clientAttemptId: 'restored:restored-order-1',
      reason: 'TENDER_OUTCOME_UNCERTAIN',
      message: 'Do not charge again.',
    });

    const templatePaths = [
      'retail/RetailTemplate.tsx',
      'salon/SalonTemplate.tsx',
      'b2b/B2BTemplate.tsx',
      'restaurant/RestaurantTemplate.tsx',
    ];
    for (const relativePath of templatePaths) {
      const source = readFileSync(
        new URL(`../src/renderer/components/pos/templates/${relativePath}`, import.meta.url),
        'utf8',
      );
      expect(source, relativePath).toContain('onTenderOutcomeUncertain=');
      expect(source, relativePath).toContain('onRestoredTenderOutcomeUncertain?.(reconciliation)');
    }
    const layoutSource = readFileSync(
      new URL('../src/renderer/components/pos/POSLayout.tsx', import.meta.url),
      'utf8',
    );
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(layoutSource).toContain('onRestoredCartTenderOutcomeUncertain');
    expect(layoutSource).toContain('Billiard total locked · ready for payment');
    expect(layoutSource).not.toContain('Frozen checkout ready');
    expect(appSource).toContain('setRestoredCartReconciliation(reconciliation)');

    const mainSource = readFileSync(
      new URL('../src/main/modules/pos.module.ts', import.meta.url),
      'utf8',
    );
    expect(mainSource).toContain('tenderedBilliardCart');
    expect(mainSource).toContain('billiardPosHandoffRepo.markTenderUncertain(tenderedBilliardCart.checkoutId)');
    expect(mainSource).toContain('restoredCartReconciliation: uncertain.reconciliation');
    expect(mainSource).toContain('billiardPosHandoffRepo.getUncertainForOwner(scope)');
    expect(mainSource).toContain('if (unresolved || registerUncertain)');
    expect(mainSource).toContain('discoverOwnerUncertainRestoredCart(scope)');
    expect(mainSource).toContain('samePosSalonRegister(payload.snapshot, scope)');
    expect(mainSource).toContain('snapshot: adoptPosCheckoutSnapshotScope(payload.snapshot, scope)');
  });

  it('purges frozen Billiard items from the legacy active-cart lane', () => {
    const frozen = [{ id: 'frozen', locked: true, billiard: { lineKey: 'time-1' } }];
    expect(containsProtectedCheckoutLine(frozen)).toBe(true);
    expect(shouldPersistLegacyActiveCart({ items: frozen, hasDurableCheckout: true })).toBe(false);
    expect(shouldPersistLegacyActiveCart({ items: state().cart.items, hasDurableCheckout: false })).toBe(true);

    const retailSource = readFileSync(
      new URL('../src/renderer/components/pos/templates/retail/RetailTemplate.tsx', import.meta.url),
      'utf8',
    );
    expect(retailSource).toContain('containsProtectedCheckoutLine(items)');
    expect(retailSource).toContain('window.localStorage.removeItem(cartStorageKey)');
    expect(retailSource).toContain('state.checkoutDraft.billiard || state.checkoutDraft.restoredInterruption');
  });
});

describe('legacy renderer Hold rollout', () => {
  it('imports the full best-effort legacy shape deterministically without protected lines', () => {
    const raw = {
      id: 'old-hold-1',
      createdAt: '2026-07-21T12:34:00.000Z',
      total: 2000,
      items: state().cart.items,
    };
    const first = buildLegacyHeldCartImport({ raw, index: 0, currentState: state(), scope, posMode: 'retail' });
    const retry = buildLegacyHeldCartImport({ raw, index: 0, currentState: state(), scope, posMode: 'retail' });

    expect(retry.id).toBe(first.id);
    expect(first.payload).toMatchObject({ holdReason: 'MANUAL', protected: false });
    expect(first.payload.snapshot.state.cart).toMatchObject({
      subtotal: 2400,
      discount: 400,
      total: 2000,
    });
    expect(first.payload.snapshot.state.checkoutDraft).toEqual({});
    expect(first.payload.snapshot.state.activeCustomer).toBeNull();
  });

  it('rejects a stale protected checkout instead of importing it as a manual Hold', () => {
    expect(() => buildLegacyHeldCartImport({
      raw: {
        id: 'bad-hold',
        total: 1000,
        items: [{ ...state().cart.items[0], locked: true }],
      },
      index: 0,
      currentState: state(),
      scope,
      posMode: 'retail',
    })).toThrow('protected checkout line');
  });

  it('never deletes legacy Holds on logout and deletes them only after import success', () => {
    const appSource = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const retailSource = readFileSync(
      new URL('../src/renderer/components/pos/templates/retail/RetailTemplate.tsx', import.meta.url),
      'utf8',
    );
    expect(appSource).not.toContain("removeItem('pos.heldCarts')");
    const successGuard = retailSource.indexOf('if (!result?.success)');
    const deletion = retailSource.indexOf("removeItem('pos.heldCarts')");
    expect(successGuard).toBeGreaterThan(-1);
    expect(deletion).toBeGreaterThan(successGuard);
  });
});
