// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const labelHarness = vi.hoisted(() => ({
  config: {} as any,
  products: [] as any[],
  listTemplates: vi.fn(),
  syncProducts: vi.fn(),
}));

vi.mock('../src/renderer/hooks/useConfig', () => ({
  useConfig: () => ({ config: labelHarness.config, saveConfig: vi.fn() }),
}));

vi.mock('../src/renderer/hooks/useProducts', () => ({
  useProducts: () => ({
    allProducts: labelHarness.products,
    categories: [],
    loading: false,
    error: null,
    syncProducts: labelHarness.syncProducts,
    syncing: false,
  }),
}));

import { PrinterType, type FabricTagTemplate, type PrinterConfig } from '../src/shared/types';
import FabricTagPrintPanel, {
  FABRIC_TAG_CONFIRM_THRESHOLD,
  MAX_FABRIC_TAGS_PER_RUN,
} from '../src/renderer/components/label/FabricTagPrintPanel';
import LabelModule from '../src/renderer/components/label/LabelModule';
import {
  isFabricTagPrinterReady,
  supportsLabelMediaCalibration,
} from '../src/renderer/components/label/fabric-tag-printer';

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

const rows = [
  { id: 'size-s', name: 'Small' },
  { id: 'size-m', name: 'Medium' },
];

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function changeInput(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not rendered: ${text}`);
  return button;
}

describe('Fabric Label UI hardening', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  const printFabricTag = vi.fn();
  const onStatus = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    root = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printFabricTag,
        printLabel: vi.fn(),
        pos: {
          fabricTagTemplates: {
            list: labelHarness.listTemplates,
          },
        },
      },
    });
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
  });

  async function render(node: React.ReactNode) {
    await act(async () => {
      root = createRoot(container);
      root.render(node);
    });
    await settle();
  }

  it('requires an enabled TSPL slot with a real Windows printer target', () => {
    const configured: PrinterConfig = {
      enabled: true,
      protocol: 'TSPL',
      windowsPrinter: 'TSC MB241',
    };

    expect(isFabricTagPrinterReady(configured)).toBe(true);
    expect(isFabricTagPrinterReady({ ...configured, enabled: false })).toBe(false);
    expect(isFabricTagPrinterReady({ ...configured, protocol: 'WINDOWS' })).toBe(false);
    expect(isFabricTagPrinterReady({ ...configured, windowsPrinter: '  ' })).toBe(false);
  });

  it('blocks gap calibration for continuous media', () => {
    expect(supportsLabelMediaCalibration(
      { enabled: true, protocol: 'TSPL', mediaSensor: 'gap' },
      PrinterType.FABRIC_TAG,
    )).toBe(true);
    expect(supportsLabelMediaCalibration(
      { enabled: true, protocol: 'TSPL', mediaSensor: 'none' },
      PrinterType.FABRIC_TAG,
    )).toBe(false);
    expect(supportsLabelMediaCalibration(
      { enabled: true, protocol: 'TSPL' },
      PrinterType.FABRIC_TAG,
    )).toBe(false);
    expect(supportsLabelMediaCalibration(
      { enabled: true, protocol: 'TSPL' },
      PrinterType.LABEL,
    )).toBe(true);
    expect(supportsLabelMediaCalibration(
      { enabled: true, protocol: 'THERMAL' },
      PrinterType.FABRIC_TAG,
    )).toBe(false);
  });

  it('loads care templates without a POS trade gate and never turns LOTUS colours into size rows', async () => {
    labelHarness.config = {
      labelModuleProductIds: ['lotus-beige'],
      labelModuleCategoryIds: [],
      printers: {
        FABRIC_TAG: { enabled: false, protocol: 'TSPL', windowsPrinter: '' },
      },
    };
    labelHarness.products = [
      {
        id: 'lotus-beige',
        name: 'LOTUS beżowy',
        barcode: null,
        ean: null,
        template_id: 'LOTUS',
        is_active: 1,
        retail_price: 0,
      },
      {
        id: 'lotus-black',
        name: 'LOTUS czarny',
        barcode: null,
        ean: null,
        template_id: 'LOTUS',
        is_active: 1,
        retail_price: 0,
      },
    ];
    labelHarness.listTemplates.mockResolvedValue([template]);

    await render(<LabelModule language="vi" />);

    expect(labelHarness.listTemplates).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Thiếu EAN');
    expect(container.textContent).toContain('Mác hướng dẫn sử dụng vải');
    expect(container.textContent).toContain('Chưa cấu hình size cho mẫu mác vải này.');
    expect(container.textContent).toContain('Hãy cấu hình máy in mác vải trong Cài đặt trước.');
    expect(container.textContent).not.toContain('LOTUS czarny');
    expect(container.querySelectorAll('input[placeholder="Size"]')).toHaveLength(0);
  });

  it('requires confirmation before a large batch reaches the printer', async () => {
    printFabricTag.mockResolvedValue({ success: true });
    await render(
      <FabricTagPrintPanel
        template={template}
        styleName="LOTUS"
        variants={rows}
        ready
        t={(_key, fallback) => fallback}
        onStatus={onStatus}
      />,
    );

    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    await changeInput(inputs[0], 'S');
    await changeInput(inputs[1], String(FABRIC_TAG_CONFIRM_THRESHOLD + 1));
    await act(async () => buttonWithText(container, `Print fabric labels (${FABRIC_TAG_CONFIRM_THRESHOLD + 1})`).click());

    expect(printFabricTag).not.toHaveBeenCalled();
    expect(container.textContent).toContain(`You are about to print ${FABRIC_TAG_CONFIRM_THRESHOLD + 1} fabric labels.`);

    await act(async () => buttonWithText(container, 'Confirm').click());
    await settle();

    expect(printFabricTag).toHaveBeenCalledTimes(1);
    expect(printFabricTag).toHaveBeenCalledWith(expect.objectContaining({ size: 'S', quantity: FABRIC_TAG_CONFIRM_THRESHOLD + 1 }));
  });

  it('hard-caps the total run even when each size is individually below the limit', async () => {
    await render(
      <FabricTagPrintPanel
        template={template}
        styleName="LOTUS"
        variants={rows}
        ready
        t={(_key, fallback) => fallback}
        onStatus={onStatus}
      />,
    );

    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    await changeInput(inputs[0], 'S');
    await changeInput(inputs[1], '600');
    await changeInput(inputs[2], 'M');
    await changeInput(inputs[3], '600');

    expect(container.textContent).toContain(`cannot exceed ${MAX_FABRIC_TAGS_PER_RUN} labels`);
    expect(buttonWithText(container, 'Print fabric labels (1200)').disabled).toBe(true);
    expect(printFabricTag).not.toHaveBeenCalled();
  });

  it('reports how many labels completed before a partial failure', async () => {
    printFabricTag
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'Printer offline' });
    await render(
      <FabricTagPrintPanel
        template={template}
        styleName="LOTUS"
        variants={rows}
        ready
        t={(_key, fallback) => fallback}
        onStatus={onStatus}
      />,
    );

    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    await changeInput(inputs[0], 'S');
    await changeInput(inputs[1], '10');
    await changeInput(inputs[2], 'M');
    await changeInput(inputs[3], '10');
    await act(async () => buttonWithText(container, 'Print fabric labels (20)').click());
    await settle();

    expect(printFabricTag).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenLastCalledWith({ type: 'error', message: 'Printer offline (10/20)' });
  });
});
