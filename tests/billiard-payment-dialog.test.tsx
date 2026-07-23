// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hookMocks = vi.hoisted(() => ({
  endSession: vi.fn(),
  reconcileSession: vi.fn(),
}));

vi.mock('../src/renderer/hooks/useBilliardData', () => ({
  useEndSession: () => ({
    mutate: hookMocks.endSession,
    isPending: false,
  }),
}));

import { PaymentDialog } from '../src/renderer/components/billiard/PaymentDialog';

const activeSession = {
  id: 'session-active',
  status: 'ACTIVE',
  paymentStatus: 'UNPAID',
  currentTimeCharge: 25,
  resource: { name: 'Table 1' },
};

const frozenSession = {
  ...activeSession,
  status: 'COMPLETED',
  totalCharge: 25,
  posCheckout: {
    checkoutId: 'checkout-1',
    sessionId: 'session-active',
    lines: [],
    totalGrosze: 2500,
  },
};

describe('PaymentDialog one-action POS handoff', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    hookMocks.endSession.mockReset();
    hookMocks.reconcileSession.mockReset();
    hookMocks.reconcileSession.mockResolvedValue({
      ...frozenSession,
      posCheckout: undefined,
    });
    (window as any).electronAPI = {
      billiard: {
        mutate: hookMocks.reconcileSession,
      },
    };
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = undefined;
    }
    delete (window as any).electronAPI;
    container.remove();
  });

  async function renderDialog(
    session: any,
    onPayInPos = vi.fn(async () => undefined),
    onOpenChange = vi.fn(),
  ) {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <PaymentDialog
          session={session}
          open
          onOpenChange={onOpenChange}
          language="vi"
          onPayInPos={onPayInPos}
        />,
      );
    });
    return { onPayInPos, onOpenChange };
  }

  function primaryButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="billiard-pos-handoff"]',
    );
    expect(button).not.toBeNull();
    return button!;
  }

  it('ends an active session and hands its frozen checkout to POS from one click', async () => {
    hookMocks.endSession.mockResolvedValue(frozenSession);
    const { onPayInPos, onOpenChange } = await renderDialog(activeSession);

    await act(async () => {
      primaryButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookMocks.endSession).toHaveBeenCalledOnce();
    expect(hookMocks.endSession).toHaveBeenCalledWith('session-active');
    expect(onPayInPos).toHaveBeenCalledOnce();
    expect(onPayInPos).toHaveBeenCalledWith({
      posCheckout: frozenSession.posCheckout,
      tableName: 'Table 1',
    });
    expect(hookMocks.endSession.mock.invocationCallOrder[0])
      .toBeLessThan(onPayInPos.mock.invocationCallOrder[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('hands an already-ended unsettled session to POS without ending it again', async () => {
    const { onPayInPos } = await renderDialog(frozenSession);

    await act(async () => {
      primaryButton().click();
      await Promise.resolve();
    });

    expect(hookMocks.endSession).not.toHaveBeenCalled();
    expect(onPayInPos).toHaveBeenCalledOnce();
    expect(onPayInPos).toHaveBeenCalledWith({
      posCheckout: frozenSession.posCheckout,
      tableName: 'Table 1',
    });
  });

  it('recovers when the end committed but its response was lost', async () => {
    hookMocks.endSession.mockRejectedValue(new Error('Network connection was lost'));
    hookMocks.reconcileSession.mockResolvedValue(frozenSession);
    const { onPayInPos } = await renderDialog(activeSession);

    await act(async () => {
      primaryButton().click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookMocks.endSession).toHaveBeenCalledOnce();
    expect(hookMocks.reconcileSession).toHaveBeenCalledOnce();
    expect(onPayInPos).toHaveBeenCalledWith({
      posCheckout: frozenSession.posCheckout,
      tableName: 'Table 1',
    });
  });

  it('retries ending when reconciliation confirms the session is still active', async () => {
    hookMocks.endSession
      .mockRejectedValueOnce(new Error('Network connection was lost'))
      .mockResolvedValueOnce(frozenSession);
    hookMocks.reconcileSession.mockResolvedValue(activeSession);
    const { onPayInPos } = await renderDialog(activeSession);

    await act(async () => {
      primaryButton().click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookMocks.endSession).toHaveBeenCalledOnce();
    expect(onPayInPos).not.toHaveBeenCalled();
    expect(primaryButton().disabled).toBe(false);

    await act(async () => {
      primaryButton().click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookMocks.endSession).toHaveBeenCalledTimes(2);
    expect(onPayInPos).toHaveBeenCalledWith({
      posCheckout: frozenSession.posCheckout,
      tableName: 'Table 1',
    });
  });

  it('rejects a non-frozen end response and never opens POS payment', async () => {
    hookMocks.endSession.mockResolvedValue({
      ...frozenSession,
      posCheckout: undefined,
    });
    const { onPayInPos, onOpenChange } = await renderDialog(activeSession);

    await act(async () => {
      primaryButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookMocks.endSession).toHaveBeenCalledOnce();
    expect(onPayInPos).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(hookMocks.reconcileSession).toHaveBeenCalledWith(
      'online_api',
      'GET',
      '/billiard/sessions/session-active',
    );
    expect(container.textContent).toContain('final POS checkout is not ready');
    expect(primaryButton().disabled).toBe(false);
  });

  it('reconciles a delayed frozen checkout on retry without ending twice', async () => {
    hookMocks.endSession.mockResolvedValue({
      ...frozenSession,
      posCheckout: undefined,
    });
    hookMocks.reconcileSession
      .mockResolvedValueOnce({ ...frozenSession, posCheckout: undefined })
      .mockResolvedValueOnce(frozenSession);
    const { onPayInPos } = await renderDialog(activeSession);

    await act(async () => {
      primaryButton().click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onPayInPos).not.toHaveBeenCalled();

    await act(async () => {
      primaryButton().click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookMocks.endSession).toHaveBeenCalledOnce();
    expect(hookMocks.reconcileSession).toHaveBeenCalledTimes(2);
    expect(onPayInPos).toHaveBeenCalledWith({
      posCheckout: frozenSession.posCheckout,
      tableName: 'Table 1',
    });
  });

  it('rejects a queued end response and never opens POS payment', async () => {
    hookMocks.endSession.mockResolvedValue({ queued: true });
    const { onPayInPos } = await renderDialog(activeSession);

    await act(async () => {
      primaryButton().click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookMocks.endSession).toHaveBeenCalledOnce();
    expect(onPayInPos).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Could not freeze the final billiard total');
  });

  it('guards duplicate clicks and parent refreshes while the handoff is in flight', async () => {
    let resolveEnd!: (session: any) => void;
    let resolveHandoff!: () => void;
    hookMocks.endSession.mockImplementation(() => new Promise((resolve) => {
      resolveEnd = resolve;
    }));
    const onPayInPos = vi.fn(() => new Promise<void>((resolve) => {
      resolveHandoff = resolve;
    }));
    const onOpenChange = vi.fn();
    await renderDialog(activeSession, onPayInPos, onOpenChange);
    const button = primaryButton();

    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });
    expect(hookMocks.endSession).toHaveBeenCalledOnce();
    expect(onPayInPos).not.toHaveBeenCalled();

    await act(async () => {
      resolveEnd(frozenSession);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onPayInPos).toHaveBeenCalledOnce();

    await act(async () => {
      root?.render(
        <PaymentDialog
          session={frozenSession}
          open
          onOpenChange={onOpenChange}
          language="vi"
          onPayInPos={onPayInPos}
        />,
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="billiard-pos-handoff"]')).toBeNull();

    await act(async () => {
      resolveHandoff();
      await Promise.resolve();
    });
    expect(onPayInPos).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    {
      label: 'zero-balance',
      session: {
        ...frozenSession,
        paymentStatus: 'UNPAID',
        totalCharge: 0,
        posCheckout: undefined,
      },
    },
    {
      label: 'voided',
      session: {
        ...frozenSession,
        paymentStatus: 'VOID',
        totalCharge: 25,
        posCheckout: undefined,
      },
    },
  ])('closes a finalized $label session without opening a POS tender', async ({ session }) => {
    const { onPayInPos, onOpenChange } = await renderDialog(session);

    expect(hookMocks.endSession).not.toHaveBeenCalled();
    expect(onPayInPos).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(container.querySelector('[data-testid="billiard-pos-handoff"]')).toBeNull();
  });

  it('uses touch-sized payment actions', async () => {
    await renderDialog(frozenSession);
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.border-t button'));

    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.className.includes('h-11'))).toBe(true);
  });
});
