// @vitest-environment happy-dom
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A sheet filed from the order tab must show up on the product tab, and the
 * product tab only lists the categories it was told to. So filing tells it.
 */

const harness = vi.hoisted(() => ({
  config: {} as any,
  products: [] as any[],
  categories: [] as any[],
  saveConfig: vi.fn(),
  refresh: vi.fn(),
  syncProducts: vi.fn(),
}));

vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config: harness.config, saveConfig: harness.saveConfig }),
}));

vi.mock('../src/renderer/hooks/useProducts', () => ({
  useProducts: () => ({
    allProducts: harness.products,
    categories: harness.categories,
    loading: false,
    error: null,
    refresh: harness.refresh,
    syncProducts: harness.syncProducts,
    syncing: false,
  }),
}));

vi.mock('../src/renderer/utils/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/renderer/components/label/FabricArtworkPanel', () => ({
  default: () => createElement('div', { 'data-testid': 'fabric-artwork-panel' }),
}));

import LabelModule from '../src/renderer/components/label/LabelModule';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function changeInput(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not rendered: ${text}`);
  return button;
}

function input(container: HTMLElement, selector: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(selector);
  if (!found) throw new Error(`Input not rendered: ${selector}`);
  return found;
}

describe('LabelModule — a filed sheet reaches the product tab', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let createProduct: ReturnType<typeof vi.fn>;
  let createCategory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', memoryStorage());
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    harness.config = { labelModuleProductIds: [], labelModuleCategoryIds: ['cat-old'], printers: {} };
    harness.products = [];
    harness.categories = [
      { id: 'cat-old', name: 'Bawełniane' },
      { id: 'cat-jackets', name: 'Kurtki' },
    ];
    harness.saveConfig.mockResolvedValue(undefined);
    harness.refresh.mockResolvedValue(undefined);
    createProduct = vi.fn(async () => ({
      ok: true,
      data: {
        product: { id: 'template-1' },
        variant: { id: 'variant-1', templateId: 'template-1' },
        variants: [{ id: 'variant-1', templateId: 'template-1' }],
      },
    }));
    createCategory = vi.fn(async ({ name }: { name: string }) => ({
      ok: true,
      data: { category: { id: 'cat-new', name, isActive: true } },
    }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printLabel: vi.fn(),
        printPackagingSticker: vi.fn(async () => ({ success: true })),
        printFabricTag: vi.fn(async () => ({ success: true })),
        pos: {
          products: { getByIds: vi.fn(async () => []) },
          productAdmin: { createProduct, createCategory },
          fabricTagTemplates: {
            listIds: vi.fn(async () => []),
            get: vi.fn(async () => null),
            save: vi.fn(async (template: any) => template),
          },
        },
      },
    });
    root = null;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderModule() {
    await act(async () => {
      root = createRoot(container);
      root.render(<LabelModule language="en" />);
    });
    await settle();
  }

  async function fillSheet(styleName: string) {
    await changeInput(input(container, 'input[placeholder="MoonCollection"]'), 'MOON');
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), styleName);
    await changeInput(input(container, 'input[placeholder="114"]'), '114');
    await act(async () => buttonWithText(container, '+ S').click());
    await act(async () => buttonWithText(container, 'Add colour').click());
    await changeInput(input(container, 'input[placeholder="CZEKOLADA"]'), 'CZARNY');
    await changeInput(input(container, 'input[aria-label="CZARNY S"]'), '2');
  }

  const fileButton = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="file-product"]')!;

  it('adds the filed category to the ones the product tab shows', async () => {
    await renderModule();
    await fillSheet('KURTKA');
    await act(async () => fileButton().click());
    await settle();

    expect(createProduct).toHaveBeenCalledTimes(1);
    expect(harness.saveConfig).toHaveBeenCalledWith({
      labelModuleCategoryIds: ['cat-old', 'cat-jackets'],
    });
    // And pulls the catalogue, so the style is on the tab without a trip to Sync.
    expect(harness.syncProducts).toHaveBeenCalledTimes(1);
  });

  it('leaves the settings alone when the category is already shown', async () => {
    harness.config = { ...harness.config, labelModuleCategoryIds: ['cat-jackets'] };
    await renderModule();
    await fillSheet('KURTKA');
    await act(async () => fileButton().click());
    await settle();

    expect(createProduct).toHaveBeenCalledTimes(1);
    expect(harness.saveConfig).not.toHaveBeenCalled();
  });

  it('offers to attach a sheet whose code is a style the tab already shows', async () => {
    harness.products = [
      {
        id: 'old-0', template_id: 'template-old', name: 'KURTKA STARA - BEŻOWY / S',
        sku: 'LOT114-BEZOWY-S', barcode: 'LOT114-BEZOWY-S', category_id: 'cat-old',
        color_name: 'BEŻOWY', size_name: 'S',
      },
    ];
    (window as any).electronAPI.pos.products.getByIds = vi.fn(async () => [
      // A SKU typed in lower case on the server side, before the sheet existed.
      { id: 'template-old', name: 'KURTKA STARA', sku: 'lot114', category_id: 'cat-old' },
    ]);
    await renderModule();
    await fillSheet('KURTKA');
    await changeInput(input(container, 'input[placeholder="114"]'), 'LOT114');

    const attach = container.querySelector<HTMLButtonElement>('[data-testid="attach-product"]');
    expect(attach?.textContent).toContain('KURTKA STARA');
    expect(container.querySelector('[data-testid="file-product"]')).toBeNull();

    await act(async () => attach!.click());
    await settle();
    expect(createProduct).toHaveBeenCalledTimes(1);
    expect(createProduct.mock.calls[0][0].productId).toBe('template-old');
    expect(createProduct.mock.calls[0][0].variants.map((v: any) => v.colorName)).toEqual(['CZARNY']);
  });

  it('reloads the category list after one is created from the sheet', async () => {
    await renderModule();
    await fillSheet('SPODNIE');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="create-category"]')!.click();
    });
    await settle();

    expect(createCategory).toHaveBeenCalledTimes(1);
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });
});
