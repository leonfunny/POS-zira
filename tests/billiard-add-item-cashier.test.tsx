// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMutate,
  updateMutate,
  removeMutate,
  sessionRefetch,
  sessionState,
} = vi.hoisted(() => ({
  ...(() => {
    const state = {
      current: null as any,
      next: null as any,
    };
    return {
      addMutate: vi.fn(async () => ({ id: 'added' })),
      updateMutate: vi.fn(async () => ({ id: 'updated' })),
      removeMutate: vi.fn(async () => ({ id: 'removed' })),
      sessionRefetch: vi.fn(async () => {
        if (state.next) {
          state.current = state.next;
          state.next = null;
        }
        return state.current;
      }),
      sessionState: state,
    };
  })(),
}));

vi.mock('../src/renderer/hooks/useBilliardData', () => ({
  useAddItem: () => ({ mutate: addMutate, isPending: false }),
  useUpdateItem: () => ({ mutate: updateMutate, isPending: false }),
  useRemoveItem: () => ({ mutate: removeMutate, isPending: false }),
  useSession: () => ({
    data: sessionState.current,
    loading: false,
    error: null,
    refetch: sessionRefetch,
  }),
  useFnbCategories: () => ({
    data: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useFnbProducts: () => ({
    data: [
      {
        id: 'tea-1',
        name: 'Tea',
        retail_price: 500,
        available_qty: 10,
        in_stock: 1,
      },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useBilliardCombos: () => ({
    data: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useRestaurantCombos: () => ({
    data: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

import { AddItemToTabModal } from '../src/renderer/components/billiard/AddItemToTabModal';

async function settle(rounds = 3) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('AddItemToTabModal cashier controls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.current = {
      id: 'session-1',
      items: [
        {
          id: 'line-a',
          variantId: 'tea-1',
          name: 'Tea',
          quantity: 1,
          unitPrice: 5,
        },
        {
          id: 'line-b',
          variantId: 'tea-1',
          name: 'Tea',
          quantity: 2,
          unitPrice: 5,
        },
      ],
    };
    sessionState.next = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderModal() {
    await act(async () => {
      root = createRoot(container);
      root.render(modal());
    });
    await settle();
  }

  function modal() {
    return (
      <AddItemToTabModal
        sessionId="session-1"
        open
        onOpenChange={vi.fn()}
        onRefetch={vi.fn(async () => undefined)}
        language="en"
      />
    );
  }

  async function rerenderModal() {
    await act(async () => {
      root.render(modal());
    });
    await settle();
  }

  it('shows grouped quantity and the running-tab summary', async () => {
    await renderModal();

    expect(
      container.querySelector('[aria-label="Tea: 3"]')?.textContent,
    ).toContain('3');
    expect(container.textContent).toContain('×3');
    expect(container.textContent).toContain('15,00');
  });

  it('locks a rapid double add and refetches after the accepted mutation', async () => {
    await renderModal();
    sessionState.next = {
      ...sessionState.current,
      items: [
        ...sessionState.current.items,
        {
          id: 'line-c',
          variantId: 'tea-1',
          name: 'Tea',
          quantity: 1,
          unitPrice: 5,
        },
      ],
    };
    const plusIcon = container.querySelector('.lucide-plus');
    const plusButton = plusIcon?.closest('button') as HTMLButtonElement;

    await act(async () => {
      plusButton.click();
      plusButton.click();
    });
    await settle();

    expect(addMutate).toHaveBeenCalledTimes(1);
    expect(addMutate).toHaveBeenCalledWith({
      sessionId: 'session-1',
      data: {
        name: 'Tea',
        quantity: 1,
        unitPrice: 5,
        variantId: 'tea-1',
      },
    });
    expect(sessionRefetch).toHaveBeenCalledOnce();

    await rerenderModal();
    expect(
      container.querySelector('[aria-label="Tea: 4"]')?.textContent,
    ).toContain('4');
    expect(container.textContent).toContain('20,00');
  });

  it('decrements the deterministic grouped raw line instead of another price row', async () => {
    await renderModal();
    sessionState.next = {
      ...sessionState.current,
      items: sessionState.current.items.map((item: any) =>
        item.id === 'line-b' ? { ...item, quantity: 1 } : item),
    };
    const minusIcon = container.querySelector('.lucide-minus');
    const minusButton = minusIcon?.closest('button') as HTMLButtonElement;

    await act(async () => {
      minusButton.click();
    });
    await settle();

    expect(updateMutate).toHaveBeenCalledWith({
      sessionId: 'session-1',
      itemId: 'line-b',
      data: { quantity: 1 },
    });
    expect(removeMutate).not.toHaveBeenCalled();

    await rerenderModal();
    expect(
      container.querySelector('[aria-label="Tea: 2"]')?.textContent,
    ).toContain('2');
    expect(container.textContent).toContain('10,00');
  });
});
