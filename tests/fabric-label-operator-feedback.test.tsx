// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  config: {} as any,
  products: [] as any[],
  categories: [] as any[],
  listTemplateIds: vi.fn(),
  getTemplate: vi.fn(),
  getProductsByIds: vi.fn(),
  printLabel: vi.fn(),
  fabricAction: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config: harness.config, saveConfig: vi.fn() }),
}));

vi.mock('../src/renderer/hooks/useProducts', () => ({
  useProducts: () => ({
    allProducts: harness.products,
    categories: harness.categories,
    loading: false,
    error: null,
    syncProducts: vi.fn(),
    syncing: false,
  }),
}));

vi.mock('../src/renderer/utils/logger', () => ({
  default: {
    error: harness.loggerError,
    warn: harness.loggerWarn,
  },
}));

vi.mock('../src/renderer/components/label/FabricArtworkPanel', () => ({
  default: ({ active = true, onPrintingChange }: any) => {
    const [size, setSize] = React.useState('');
    return createElement(
      'div',
      { 'data-testid': 'fabric-artwork-panel' },
      createElement('input', {
        type: 'text',
        value: size,
        disabled: !active,
        'data-testid': 'fabric-size-input',
        onInput: (event: React.FormEvent<HTMLInputElement>) => setSize(event.currentTarget.value),
      }),
      createElement(
        'button',
        {
          type: 'button',
          disabled: !active,
          'data-testid': 'emit-fabric-status',
          onClick: harness.fabricAction,
        },
        'Fabric action',
      ),
      createElement(
        'button',
        {
          type: 'button',
          disabled: !active,
          'data-testid': 'start-fabric-print',
          onClick: () => onPrintingChange?.(true),
        },
        'Start fabric print',
      ),
      createElement(
        'button',
        {
          type: 'button',
          disabled: !active,
          'data-testid': 'finish-fabric-print',
          onClick: () => onPrintingChange?.(false),
        },
        'Finish fabric print',
      ),
      createElement('div', null, 'Fabric run remains visible'),
    );
  },
}));

import LabelModule from '../src/renderer/components/label/LabelModule';

const settingsSource = readFileSync(
  join(__dirname, '../src/renderer/components/Settings.tsx'),
  'utf8',
);

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('fabric-label operator feedback', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps a queued implementation, so the style rows are reset
    // here; otherwise one test's template name renames the styles in the next.
    harness.getProductsByIds.mockReset();
    harness.getProductsByIds.mockResolvedValue([]);
    harness.categories = [];
    root = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    harness.config = {
      labelModuleProductIds: ['ean-one', 'ean-two'],
      labelModuleCategoryIds: [],
      printers: {
        FABRIC_TAG: { enabled: true, protocol: 'TSPL', windowsPrinter: 'TSC MB241' },
      },
    };
    harness.products = [
      {
        id: 'ean-one',
        name: 'First EAN product',
        barcode: '5901234123457',
        template_id: 'LOTUS',
        is_active: 1,
        retail_price: 1299,
      },
      {
        id: 'ean-two',
        name: 'Second EAN product',
        barcode: '5901234123464',
        template_id: 'LOTUS',
        is_active: 1,
        retail_price: 1499,
      },
    ];
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printLabel: harness.printLabel,
        pos: {
          products: { getByIds: harness.getProductsByIds },
          fabricTagTemplates: {
            listIds: harness.listTemplateIds,
            get: harness.getTemplate,
          },
        },
      },
    });
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
  });

  async function renderLabelModule() {
    await act(async () => {
      root = createRoot(container);
      root.render(<LabelModule language="vi" />);
    });
    await settle();
  }

  async function chooseLabelMode(text: string) {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((candidate) => candidate.textContent?.trim() === text);
    expect(button).toBeDefined();
    await act(async () => button?.click());
    await settle();
  }

  it('uses the fabric speed default while preserving the generic printer default and hides the paper-size hint', () => {
    const printerCardsStart = settingsSource.indexOf('{PRINTER_TYPES.map((printerType) => {');
    const printerCardsEnd = settingsSource.indexOf('{/* Legacy Printer Config', printerCardsStart);
    const printerCards = settingsSource.slice(printerCardsStart, printerCardsEnd);

    expect(printerCards).toContain('const defaultTsplPrintSpeed = isFabricTag ? 2 : 3;');
    expect(printerCards).toContain('value={printerConfig.printSpeed ?? defaultTsplPrintSpeed}');
    expect(printerCards).toContain('printSpeed: defaultTsplPrintSpeed');
    expect(printerCards).toMatch(
      /\{!isFabricTag && \(\s*<p[^>]*>\s*\{t\('settings\.popularSizes'\)\}\s*<\/p>\s*\)\}/,
    );
  });

  it('names a style from its own row, not from a variant name it cut apart', async () => {
    harness.getProductsByIds.mockResolvedValue([
      { id: 'LOTUS', name: 'KOMPLET DRESOWY - ZIMOWY', sku: '115', category_id: null },
    ]);

    await renderLabelModule();
    await chooseLabelMode('Tem mã sản phẩm / EAN');
    await settle();

    // The template row carries a dash of its own. Deriving the style name by
    // trimming "First EAN product" back to a stem would have produced
    // "KOMPLET DRESOWY" and printed half a style name onto the bag.
    expect(harness.getProductsByIds).toHaveBeenCalledWith(['LOTUS']);
    const card = container.querySelector('[data-testid="style-card"]');
    expect(card?.textContent).toContain('KOMPLET DRESOWY - ZIMOWY');
    expect(card?.textContent).toContain('115');
    expect(card?.textContent).not.toContain('First EAN product');
  });

  it('drops the colourless leftover row and counts styles on the chips', async () => {
    harness.config.labelModuleProductIds = ['ean-one', 'ean-two', 'ean-parent'];
    harness.categories = [{ id: 'cat-cotton', name: 'Bawełniane' }];
    harness.products = [
      { ...harness.products[0], color_name: 'CZARNY', size_name: 'S', category_id: 'cat-cotton' },
      { ...harness.products[1], color_name: 'CZARNY', size_name: 'M', category_id: 'cat-cotton' },
      // The style's own parent, carried in by an import as if it were sellable.
      {
        id: 'ean-parent',
        name: 'Komplet LOTUS',
        template_id: 'LOTUS',
        category_id: 'cat-cotton',
        is_active: 1,
        retail_price: 0,
      },
    ];

    await renderLabelModule();
    await chooseLabelMode('Tem mã sản phẩm / EAN');
    await settle();

    // Three rows, one style: a chip promising three where one card appears is a
    // fault the operator cannot act on. Both chips count the same thing.
    const chipText = (label: string) =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes(label))
        ?.textContent ?? '';
    expect(chipText('Tất cả')).toContain('1');
    expect(chipText('Bawełniane')).toContain('1');
    expect(chipText('Bawełniane')).not.toContain('3');

    const card = container.querySelector<HTMLButtonElement>('[data-testid="style-card"]');
    await act(async () => card?.click());
    await settle();

    // The style opens as a sheet: one colour row, the two sizes across the
    // top. Printing the parent would put a tag naming no garment into the
    // bundle, so it is not a row.
    const sheet = container.querySelector<HTMLElement>('[data-testid="style-sheet"] [data-testid="print-order-panel"]');
    expect(sheet).not.toBeNull();
    const colours = Array.from(sheet!.querySelectorAll<HTMLInputElement>('input[placeholder="CZEKOLADA"]')).map((box) => box.value);
    expect(colours).toEqual(['CZARNY']);
    const sizes = Array.from(sheet!.querySelectorAll<HTMLInputElement>('input[aria-label^="Mác vải "]')).map((box) =>
      box.getAttribute('aria-label')?.replace('Mác vải ', ''),
    );
    expect(sizes).toEqual(['S', 'M']);
  });

  it('reads care content for the selected style only, never the whole template store', async () => {
    harness.listTemplateIds.mockRejectedValueOnce(new Error('template store unavailable'));

    await expect(renderLabelModule()).resolves.toBeUndefined();

    // The sheet needs the composition and washing symbols of the style in
    // front of the operator, and only once it is opened; it has never needed
    // every style on the machine, and asking for all of them was what made the
    // old loader a liability.
    expect(harness.listTemplateIds).not.toHaveBeenCalled();
    expect(harness.getTemplate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Fabric run remains visible');
    expect(container.querySelector<HTMLElement>('[data-label-mode-panel="ean"]')?.hidden).toBe(true);

    await chooseLabelMode('Tem mã sản phẩm / EAN');
    expect(container.textContent).toContain('First EAN product');

    const card = container.querySelector<HTMLButtonElement>('[data-testid="style-card"]');
    await act(async () => card?.click());
    await settle();
    expect(harness.getTemplate).toHaveBeenCalledTimes(1);
    expect(harness.getTemplate).toHaveBeenCalledWith('LOTUS');
    expect(harness.loggerError).not.toHaveBeenCalled();
  });

  it('keeps the EAN workflow available when optional fabric bridges are absent', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printLabel: vi.fn(),
        pos: {},
      },
    });

    await expect(renderLabelModule()).resolves.toBeUndefined();

    expect(harness.listTemplateIds).not.toHaveBeenCalled();
    await chooseLabelMode('Tem mã sản phẩm / EAN');
    // Both rows belong to one style, so the tab shows the style once.
    expect(container.textContent).toContain('First EAN product');
    expect(container.textContent).not.toContain('Second EAN product');

    // Without a fabric bridge there is no care content: the style still opens
    // as a sheet, with the composition blank and the sheet saying so, rather
    // than the tab going blank.
    const card = container.querySelector<HTMLButtonElement>('[data-testid="style-card"]');
    await act(async () => card?.click());
    await settle();
    const sheet = container.querySelector<HTMLElement>('[data-testid="style-sheet"] [data-testid="print-order-panel"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.textContent).toContain('Mác vải chưa có thành phần');
    expect(harness.loggerWarn).not.toHaveBeenCalled();
  });

  it('keeps the mounted fabric form state while hiding and disabling it in EAN mode', async () => {
    await renderLabelModule();
    // The Label tab now opens on the print-order sheet, which is the daily job;
    // this test is about the fabric panel, so select it explicitly.
    await chooseLabelMode('Mác vải từ file khách');

    const fabricPanel = container.querySelector<HTMLElement>('[data-label-mode-panel="fabric"]');
    const eanPanel = container.querySelector<HTMLElement>('[data-label-mode-panel="ean"]');
    const fabricInput = container.querySelector<HTMLInputElement>('[data-testid="fabric-size-input"]');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(fabricInput, 'S/M');
      fabricInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain('Fabric run remains visible');
    expect(fabricPanel?.hidden).toBe(false);
    expect(eanPanel?.hidden).toBe(true);
    await chooseLabelMode('Tem mã sản phẩm / EAN');

    expect(fabricPanel?.hidden).toBe(true);
    expect(eanPanel?.hidden).toBe(false);
    expect(fabricInput?.disabled).toBe(true);
    container.querySelector<HTMLButtonElement>('[data-testid="emit-fabric-status"]')?.click();
    expect(harness.fabricAction).not.toHaveBeenCalled();

    // One card per style now: both harness rows sit under the same template.
    const styleCard = container.querySelector<HTMLButtonElement>('[data-testid="style-card"]');
    expect(styleCard).not.toBeNull();
    await act(async () => styleCard?.click());

    expect(container.textContent).toContain('First EAN product');

    await chooseLabelMode('Mác vải từ file khách');
    expect(fabricPanel?.hidden).toBe(false);
    expect(eanPanel?.hidden).toBe(true);
    expect(fabricInput?.disabled).toBe(false);
    expect(fabricInput?.value).toBe('S/M');
  });

  it('does not allow a mode switch while a fabric print run is active', async () => {
    await renderLabelModule();
    // The Label tab now opens on the print-order sheet, which is the daily job;
    // this test is about the fabric panel, so select it explicitly.
    await chooseLabelMode('Mác vải từ file khách');

    const eanMode = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Tem mã sản phẩm / EAN');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="start-fabric-print"]')?.click();
      // The state-driven disabled attribute has not rendered yet. The
      // synchronous ref must still reject this same-frame mode click.
      eanMode?.click();
    });
    expect(eanMode?.disabled).toBe(true);
    expect(container.querySelector<HTMLElement>('[data-label-mode-panel="fabric"]')?.hidden).toBe(false);
    expect(container.querySelector<HTMLElement>('[data-label-mode-panel="ean"]')?.hidden).toBe(true);
  });

  it('does not route Enter from a fabric control into the EAN print shortcut', async () => {
    await renderLabelModule();

    const fabricButton = container.querySelector<HTMLButtonElement>('[data-testid="emit-fabric-status"]');
    expect(fabricButton).not.toBeNull();
    await act(async () => {
      fabricButton?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(harness.printLabel).not.toHaveBeenCalled();
  });

  it('leaves the slash key untouched while an operator is typing in a fabric input', async () => {
    await renderLabelModule();
    // The Label tab now opens on the print-order sheet, which is the daily job;
    // this test is about the fabric panel, so select it explicitly.
    await chooseLabelMode('Mác vải từ file khách');

    const fabricInput = container.querySelector<HTMLInputElement>('[data-testid="fabric-size-input"]');
    expect(fabricInput).not.toBeNull();
    fabricInput?.focus();
    const slash = new KeyboardEvent('keydown', {
      key: '/',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      fabricInput?.dispatchEvent(slash);
    });

    expect(slash.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(fabricInput);
    expect(harness.printLabel).not.toHaveBeenCalled();
  });
});
