// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMutate,
  updateMutate,
  removeMutate,
  sessionRefetch,
} = vi.hoisted(() => ({
  addMutate: vi.fn(async () => ({ id: 'added' })),
  updateMutate: vi.fn(async () => ({ id: 'updated' })),
  removeMutate: vi.fn(async () => ({ id: 'removed' })),
  sessionRefetch: vi.fn(async () => undefined),
}));

vi.mock('../src/renderer/hooks/useBilliardData', () => ({
  useAddItem: () => ({ mutate: addMutate, isPending: false }),
  useUpdateItem: () => ({ mutate: updateMutate, isPending: false }),
  useRemoveItem: () => ({ mutate: removeMutate, isPending: false }),
  useSession: () => ({
    data: {
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
    },
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
      root.render(
        <AddItemToTabModal
          sessionId="session-1"
          open
          onOpenChange={vi.fn()}
          onRefetch={vi.fn(async () => undefined)}
          language="en"
        />,
      );
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
  });

  it('decrements the newest grouped raw line instead of another price row', async () => {
    await renderModal();
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
  });
});
