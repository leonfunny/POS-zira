// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config: { fiscalOnCashSale: 'NEVER' } }),
}));

import PaymentModal from '../src/renderer/components/pos/PaymentModal';
import {
  PosCapabilityProvider,
  RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
  resolveWindowsPosCapabilityManifest,
  type PosCapabilityHost,
} from '../src/renderer/components/pos/capabilities/PosCapabilityProvider';

const host: PosCapabilityHost = {
  session: {
    authenticated: true,
    salonId: 'salon-1',
    userId: 'owner-1',
    registerId: 'register-1',
    authRevision: 1,
    roleRevision: 'OWNER',
    entitlementRevision: 'entitlements-1',
    configRevision: 'config-1',
    platformRevision: 'windows-test',
  },
  policyInputs: RUNTIME_ONLY_POS_CAPABILITY_POLICY_INPUTS,
  resolvePlatformManifest: resolveWindowsPosCapabilityManifest,
};

async function settle(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

describe('PaymentModal protected recovery-required result', () => {
  let container: HTMLDivElement;
  let root: Root;
  const previousApi = (globalThis as any).electronAPI;
  const createOrder = vi.fn();
  const onTenderOutcomeUncertain = vi.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    createOrder.mockReset();
    onTenderOutcomeUncertain.mockReset();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).electronAPI = {
      onBarcodeScanned: () => () => {},
      pos: {
        payment: {
          hasFiscalPrinter: async () => ({ configured: false }),
          preflight: async () => ({ success: true, token: 'preflight-1' }),
        },
        billiardCheckout: {
          beginTender: async () => ({ success: true }),
          beginRestoredTender: async () => ({ success: true }),
        },
        orders: { create: createOrder },
        sync: { orders: async () => {} },
        customers: { increaseDebt: async () => ({ success: true }) },
      },
    };
    (globalThis as any).window = globalThis;
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    container.remove();
    (globalThis as any).electronAPI = previousApi;
  });

  async function renderAndComplete(): Promise<HTMLButtonElement> {
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(
        PosCapabilityProvider,
        { host },
        createElement(PaymentModal, {
          cart: {
            items: [{
              id: 'line-1', variantId: 'variant-1', name: 'Item', price: 1000,
              quantity: 1, total: 1000, vatRate: 23,
            }],
            subtotal: 1000,
            discount: 0,
            tax: 187,
            total: 1000,
          },
          checkoutDraft: {
            restoredInterruption: {
              holdId: 'protected-hold-1',
              checkoutId: 'checkout-1',
              orderId: 'restored-order-1',
              clientAttemptId: 'restored:restored-order-1',
              tenderState: 'READY',
            },
          },
          dispatch: vi.fn(),
          onClose: vi.fn(),
          onTenderOutcomeUncertain,
          t: (key: string) => key,
          shiftId: 'shift-1',
          staffId: 'staff-1',
          staffName: 'Cashier',
          initialCashAmountGrosze: 1000,
          initialPaymentPreflightToken: 'preflight-1',
        } as any),
      ));
    });
    await settle();
    const complete = Array.from(container.querySelectorAll('button')).find(
      (entry) => entry.textContent?.includes('pos.payment.complete'),
    ) as HTMLButtonElement | undefined;
    expect(complete).toBeTruthy();
    expect(complete!.disabled).toBe(false);
    await act(async () => { complete!.click(); });
    await settle();
    return complete!;
  }

  test('surfaces exact diagnostic, locks the attempt, and never fabricates uncertain reconciliation', async () => {
    const diagnostic = 'Recovery required: this COMMITTING cart belongs to another register. Do not charge it.';
    createOrder.mockResolvedValue({
      success: false,
      paymentCommitted: true,
      outcomeUncertain: true,
      error: 'generic crossed-boundary error must not replace the diagnostic',
      protectedInterruptionRecoveryRequired: {
        durable: true,
        count: 1,
        holdId: 'protected-hold-1',
        checkoutId: 'checkout-1',
        message: diagnostic,
      },
    });

    const complete = await renderAndComplete();

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(diagnostic);
    expect(container.textContent).not.toContain('generic crossed-boundary error');
    expect(onTenderOutcomeUncertain).not.toHaveBeenCalled();
    expect(complete.disabled).toBe(true);

    await act(async () => { complete.click(); });
    await settle();
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  test('invokes uncertain reconciliation only for an explicit outcomeUncertain result', async () => {
    createOrder.mockResolvedValue({
      success: false,
      outcomeUncertain: true,
      error: 'Exact uncertain outcome from the durable owner',
      restoredCartReconciliation: {
        holdId: 'protected-hold-1',
        checkoutId: 'checkout-1',
        orderId: 'restored-order-1',
        clientAttemptId: 'restored:restored-order-1',
        reason: 'TENDER_OUTCOME_UNCERTAIN',
        message: 'Exact uncertain outcome from the durable owner',
      },
    });

    await renderAndComplete();
    expect(onTenderOutcomeUncertain).toHaveBeenCalledTimes(1);
    expect(onTenderOutcomeUncertain).toHaveBeenCalledWith(
      'Exact uncertain outcome from the durable owner',
      expect.objectContaining({ holdId: 'protected-hold-1' }),
    );
  });
});
