// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFnbProducts } from '../src/renderer/hooks/useBilliardData';

function ProductQueryProbe({
  search,
  categoryId,
}: {
  search?: string;
  categoryId?: string;
}) {
  const query = useFnbProducts({ search, categoryId });
  return (
    <div>
      <output>{JSON.stringify(query.data ?? null)}</output>
      <button type="button" onClick={() => void query.refetch()}>
        Refetch
      </button>
    </div>
  );
}

async function settle(rounds = 3) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('useFnbProducts query identity', () => {
  let container: HTMLDivElement;
  let root: Root;
  let getFnbProducts: ReturnType<typeof vi.fn>;
  const previousElectronApi = (globalThis as any).electronAPI;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    getFnbProducts = vi.fn(
      async (search?: string, categoryId?: string) => [
        `${search ?? 'all'}:${categoryId ?? 'all'}`,
      ],
    );
    (globalThis as any).electronAPI = {
      billiard: { getFnbProducts },
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    (globalThis as any).electronAPI = previousElectronApi;
  });

  it('does not let the previous stale window suppress a category change', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<ProductQueryProbe />);
    });
    await settle();

    expect(getFnbProducts).toHaveBeenCalledTimes(1);
    expect(getFnbProducts).toHaveBeenLastCalledWith(undefined, undefined);

    await act(async () => {
      root.render(<ProductQueryProbe categoryId="cat-tea" />);
    });
    await settle();

    expect(getFnbProducts).toHaveBeenCalledTimes(2);
    expect(getFnbProducts).toHaveBeenLastCalledWith(undefined, 'cat-tea');
    expect(container.textContent).toContain('all:cat-tea');
  });

  it('forwards search and category together and allows an explicit refetch', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <ProductQueryProbe search="tra sua" categoryId="cat-m2" />,
      );
    });
    await settle();

    expect(getFnbProducts).toHaveBeenLastCalledWith('tra sua', 'cat-m2');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
    });
    await settle();

    expect(getFnbProducts).toHaveBeenCalledTimes(2);
    expect(getFnbProducts).toHaveBeenLastCalledWith('tra sua', 'cat-m2');
  });

  it('never exposes the previous query data while the next category is pending', async () => {
    let resolveAll!: (value: string[]) => void;
    let resolveTea!: (value: string[]) => void;
    getFnbProducts.mockImplementation((search?: string, categoryId?: string) => {
      if (categoryId === 'cat-tea') {
        return new Promise((resolve) => { resolveTea = resolve; });
      }
      return new Promise((resolve) => { resolveAll = resolve; });
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<ProductQueryProbe />);
    });
    await act(async () => {
      resolveAll(['all-products']);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('all-products');

    await act(async () => {
      root.render(<ProductQueryProbe categoryId="cat-tea" />);
    });
    expect(container.querySelector('output')?.textContent).toBe('null');
    expect(container.textContent).not.toContain('all-products');

    await act(async () => {
      resolveTea(['tea-only']);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('tea-only');
  });
});
