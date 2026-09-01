// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  config: {} as any,
  products: [] as any[],
  listTemplates: vi.fn(),
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

vi.mock('../src/renderer/components/label/FabricTagPrintPanel', () => ({
  default: ({ onStatus }: { onStatus: (status: { type: 'success'; message: string }) => void }) =>
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'emit-fabric-status',
        onClick: () => onStatus({ type: 'success', message: 'Fabric run remains visible' }),
      },
      'Emit fabric status',
    ),
}));

import type { FabricTagTemplate } from '../src/shared/types';
import LabelModule from '../src/renderer/components/label/LabelModule';

const settingsSource = readFileSync(
  join(__dirname, '../src/renderer/components/Settings.tsx'),
  'utf8',
);

const template: FabricTagTemplate = {
  templateId: 'LOTUS',
  brandName: 'Royal Fashion',
  logoDataUrl: null,
  composition: '100% polyester',
  careSymbols: [],
  careText: null,
  fabric: null,
  layout: 'default',
};

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
    harness.listTemplates.mockResolvedValue([template]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printLabel: vi.fn(),
        pos: {
          fabricTagTemplates: {
            list: harness.listTemplates,
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

  it('shows a localized operator alert when template loading fails without breaking EAN labels', async () => {
    harness.listTemplates.mockRejectedValueOnce(new Error('template store unavailable'));

    await expect(renderLabelModule()).resolves.toBeUndefined();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Không tải được danh sách mẫu mác vải');
    expect(alert?.textContent).toContain('mở lại tab Label');
    expect(container.textContent).toContain('First EAN product');
    expect(harness.loggerError).toHaveBeenCalledWith(
      '[LabelModule] Failed to load fabric tag templates:',
      expect.any(Error),
    );
  });

  it('keeps the EAN workflow graceful when the optional template bridge is absent', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printLabel: vi.fn(),
        pos: {},
      },
    });

    await expect(renderLabelModule()).resolves.toBeUndefined();

    expect(harness.listTemplates).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('First EAN product');
    expect(harness.loggerWarn).toHaveBeenCalledTimes(1);
  });

  it('does not erase the fabric print status when another EAN product is selected', async () => {
    await renderLabelModule();

    const emitStatus = container.querySelector<HTMLButtonElement>('[data-testid="emit-fabric-status"]');
    expect(emitStatus).not.toBeNull();
    await act(async () => emitStatus?.click());
    expect(container.textContent).toContain('Fabric run remains visible');

    const secondProduct = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Second EAN product'));
    expect(secondProduct).not.toBeUndefined();
    await act(async () => secondProduct?.click());

    expect(container.textContent).toContain('Fabric run remains visible');
  });
});
