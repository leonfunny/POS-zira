// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  config: {} as any,
  products: [] as any[],
  listTemplateIds: vi.fn(),
  getTemplate: vi.fn(),
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
    categories: [],
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

  it('does not invoke the retired catalog-template loader and keeps EAN one explicit tab away', async () => {
    harness.listTemplateIds.mockRejectedValueOnce(new Error('template store unavailable'));

    await expect(renderLabelModule()).resolves.toBeUndefined();

    expect(harness.listTemplateIds).not.toHaveBeenCalled();
    expect(harness.getTemplate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Fabric run remains visible');
    expect(container.querySelector<HTMLElement>('[data-label-mode-panel="ean"]')?.hidden).toBe(true);

    await chooseLabelMode('Tem mã sản phẩm / EAN');

    expect(container.textContent).toContain('First EAN product');
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
    expect(container.textContent).toContain('First EAN product');
    expect(container.textContent).toContain('5901234123457');
    expect(harness.loggerWarn).not.toHaveBeenCalled();
  });

  it('keeps the mounted fabric form state while hiding and disabling it in EAN mode', async () => {
    await renderLabelModule();

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

    const secondProduct = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Second EAN product'));
    expect(secondProduct).not.toBeUndefined();
    await act(async () => secondProduct?.click());

    expect(container.textContent).toContain('Second EAN product');

    await chooseLabelMode('Mác vải từ file khách');
    expect(fabricPanel?.hidden).toBe(false);
    expect(eanPanel?.hidden).toBe(true);
    expect(fabricInput?.disabled).toBe(false);
    expect(fabricInput?.value).toBe('S/M');
  });

  it('does not allow a mode switch while a fabric print run is active', async () => {
    await renderLabelModule();

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
