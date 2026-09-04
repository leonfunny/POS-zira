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
  let getCapabilities: ReturnType<typeof vi.fn>;
  let listCategories: ReturnType<typeof vi.fn>;

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
    getCapabilities = vi.fn(async () => ({
      ok: true,
      capabilities: { canCreateCategory: true, canUpdateCategory: true, canDeleteCategory: true },
    }));
    listCategories = vi.fn(async () => ({ ok: true, data: { categories: [] } }));
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
          productAdmin: { createProduct, createCategory, getCapabilities, listCategories },
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
    await changeInput(input(container, 'input[aria-label="Fabric tags S"]'), '2');
    await changeInput(input(container, '[data-testid="order-price"]'), '99');
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

  it('recognises a style filed from this sheet by its rows alone, with no template row on the till', async () => {
    // What the server actually gives a POS-filed style: rows named after the
    // style, SKUs built from its code, and no row for the template itself.
    harness.products = [
      {
        id: 'row-0', template_id: 'template-115', name: 'KOMPLET DRESOWY - CZARNY / S',
        sku: '115-CZARNY-S', barcode: '115-CZARNY-S', category_id: 'cat-old',
        color_name: 'CZARNY', size_name: 'S', retail_price: 100,
      },
    ];
    (window as any).electronAPI.pos.products.getByIds = vi.fn(async () => []);
    await renderModule();
    await fillSheet('KOMPLET DRESOWY');
    await changeInput(input(container, 'input[placeholder="114"]'), '115');

    const attach = container.querySelector<HTMLButtonElement>('[data-testid="attach-product"]');
    expect(attach?.textContent).toContain('KOMPLET DRESOWY');
    expect(container.querySelector('[data-testid="file-product"]')).toBeNull();

    // A code that merely starts the same is a different style.
    await changeInput(input(container, 'input[placeholder="114"]'), '11');
    expect(container.querySelector('[data-testid="attach-product"]')).toBeNull();
    expect(container.querySelector('[data-testid="file-product"]')).not.toBeNull();
  });

  it('opens a picked style as a sheet filled from its rows, and comes back to the list', async () => {
    harness.products = [
      {
        id: 'row-0', template_id: 'template-115', name: 'KOMPLET DRESOWY - CZARNY / S',
        sku: '115-CZARNY-S', barcode: '115-CZARNY-S', category_id: 'cat-old',
        color_name: 'CZARNY', size_name: 'S', retail_price: 4000, image_url: 'https://cdn/115.jpg',
      },
      {
        id: 'row-1', template_id: 'template-115', name: 'KOMPLET DRESOWY - BORDO / M',
        sku: '115-BORDO-M', barcode: '115-BORDO-M', category_id: 'cat-old',
        color_name: 'BORDO', size_name: 'M', retail_price: 4000,
      },
    ];
    (window as any).electronAPI.pos.fabricTagTemplates.get = vi.fn(async () => ({
      templateId: 'template-115', brandName: 'MOON', logoDataUrl: null, composition: '100% BAWEŁNA',
      careSymbols: [], careText: null, materials: [], fabric: null, layout: 'default',
    }));
    await renderModule();
    const ean = container.querySelector<HTMLElement>('[data-label-mode-panel="ean"]')!;
    // Nothing is opened by itself: the list is the tab until a style is picked.
    expect(ean.querySelector('[data-testid="style-sheet"]')).toBeNull();

    const card = Array.from(ean.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('KOMPLET DRESOWY'),
    );
    expect(card).toBeTruthy();
    await act(async () => card!.click());
    await settle();

    const sheet = ean.querySelector<HTMLElement>('[data-testid="style-sheet"] [data-testid="print-order-panel"]');
    expect(sheet).not.toBeNull();
    expect(input(sheet!, 'input[placeholder="114"]').value).toBe('115');
    expect(input(sheet!, 'input[placeholder="KURTKA"]').value).toBe('KOMPLET DRESOWY');
    expect(input(sheet!, 'input[placeholder="MoonCollection"]').value).toBe('MOON');
    expect(sheet!.querySelector('input[aria-label="Fabric tags S"]')).not.toBeNull();
    expect(sheet!.querySelector('input[aria-label="Fabric tags M"]')).not.toBeNull();
    expect(Array.from(sheet!.querySelectorAll<HTMLInputElement>('input[aria-label^="Fabric tags"]')).every((box) => box.value === '')).toBe(true);
    expect(sheet!.querySelector<HTMLImageElement>('[data-testid="order-image-preview"]')?.getAttribute('src')).toBe('https://cdn/115.jpg');
    // A style's sheet is not an order: no order date, no saved-sheet list, and
    // the style is already a product, so the button updates it.
    expect(sheet!.querySelector('[data-testid="order-date"]')).toBeNull();
    expect(sheet!.querySelector('[data-testid="update-product"]')).not.toBeNull();
    // Nor did opening it touch the order tab's own draft: the sheet the other
    // tab keeps is still its own empty one, not this style.
    expect(localStorage.getItem('zira.labelPrintOrder.draft') ?? '').not.toContain('"styleCode":"115"');

    await act(async () => ean.querySelector<HTMLButtonElement>('[data-testid="back-to-list"]')!.click());
    await settle();
    expect(ean.querySelector('[data-testid="style-sheet"]')).toBeNull();
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

  describe('managing categories from the label tab', () => {
    // The workshop lives in this tab; adding, renaming or deleting a group
    // must not mean finding the product tab.
    it('opens the product tab\'s category manager with the rights the server grants', async () => {
      await renderModule();
      expect(container.textContent).not.toContain('Manage categories');

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="manage-categories"]')!.click();
      });
      await settle();

      expect(getCapabilities).toHaveBeenCalledTimes(1);
      expect(listCategories).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('Manage categories');
    });

    it('says so, and opens nothing, when the till cannot manage categories', async () => {
      getCapabilities.mockResolvedValue({ ok: false, capabilities: null, error: 'offline' });
      await renderModule();
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="manage-categories"]')!.click();
      });
      await settle();

      expect(listCategories).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain('Manage categories');
      expect(container.querySelector('[data-testid="manage-categories-error"]')?.textContent)
        .toContain('cannot be managed');
    });
  });
});
