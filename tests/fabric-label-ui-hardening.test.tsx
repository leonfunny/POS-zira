// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const labelHarness = vi.hoisted(() => ({
  config: {} as any,
  products: [] as any[],
  listTemplateIds: vi.fn(),
  getTemplate: vi.fn(),
  listArtworks: vi.fn(),
  importArtwork: vi.fn(),
  attachProduction: vi.fn(),
  getArtworkPreview: vi.fn(),
  retireArtwork: vi.fn(),
  printArtwork: vi.fn(),
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

import {
  PrinterType,
  type FabricTagArtwork,
  type FabricTagTemplate,
  type PrinterConfig,
} from '../src/shared/types';
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

const receivedArtwork: FabricTagArtwork = {
  id: 'artwork-1',
  salonId: 'salon-a',
  customerName: 'Customer A',
  orderCode: 'ORDER-7',
  variant: 'S/M',
  revision: 'r1',
  originalFilename: 'customer-label.btw',
  sourceType: 'BTW',
  status: 'NEEDS_CONVERSION',
  sourceSha256: 'a'.repeat(64),
  productionFilename: null,
  productionSha256: null,
  widthPx: null,
  heightPx: null,
  physicalWidthMm: null,
  physicalLengthMm: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  retiredAt: null,
};

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
    labelHarness.listTemplateIds.mockResolvedValue([]);
    labelHarness.getTemplate.mockResolvedValue(null);
    labelHarness.listArtworks.mockResolvedValue([]);
    labelHarness.importArtwork.mockResolvedValue(null);
    labelHarness.attachProduction.mockResolvedValue(null);
    labelHarness.getArtworkPreview.mockResolvedValue(null);
    labelHarness.retireArtwork.mockResolvedValue(null);
    labelHarness.printArtwork.mockResolvedValue({ success: true });
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
            listIds: labelHarness.listTemplateIds,
            get: labelHarness.getTemplate,
          },
          fabricTagArtworks: {
            list: labelHarness.listArtworks,
            importSource: labelHarness.importArtwork,
            attachProduction: labelHarness.attachProduction,
            getPreview: labelHarness.getArtworkPreview,
            retire: labelHarness.retireArtwork,
            print: labelHarness.printArtwork,
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

  it('loads customer artwork without POS/EAN setup and never turns LOTUS colours into size rows', async () => {
    labelHarness.config = {
      labelModuleProductIds: [],
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
    labelHarness.listArtworks.mockResolvedValue([receivedArtwork]);

    await render(<LabelModule language="vi" />);

    expect(labelHarness.listArtworks).toHaveBeenCalledTimes(1);
    expect(labelHarness.listTemplateIds).not.toHaveBeenCalled();
    expect(labelHarness.getTemplate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Mác vải từ file khách');
    expect(container.textContent).toContain('Customer A');
    expect(container.textContent).toContain('ORDER-7');
    expect(container.textContent).toContain('S/M');
    expect(container.textContent).toContain('customer-label.btw');
    expect(container.textContent).toContain('.btw đã được lưu an toàn nhưng chưa thể in');
    expect(container.textContent).not.toContain('LOTUS beżowy');
    expect(container.textContent).not.toContain('LOTUS czarny');
    const select = container.querySelector<HTMLInputElement>(
      'input[aria-label="Chọn để in: S/M"]',
    );
    expect(select?.disabled).toBe(true);
  });

  it('keeps the EAN label workflow alive when the optional fabric bridge is missing', async () => {
    labelHarness.config = {
      labelModuleProductIds: ['ean-product'],
      labelModuleCategoryIds: [],
      printers: {},
    };
    labelHarness.products = [{
      id: 'ean-product',
      name: 'EAN product',
      barcode: '5901234123457',
      template_id: null,
      is_active: 1,
      retail_price: 1299,
    }];
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printFabricTag,
        printLabel: vi.fn(),
        pos: {},
      },
    });

    await expect(render(<LabelModule language="vi" />)).resolves.toBeUndefined();

    expect(labelHarness.listTemplateIds).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Chưa có kết nối quản lý file mác vải');

    await act(async () => buttonWithText(container, 'Tem mã sản phẩm / EAN').click());
    await settle();

    expect(container.textContent).toContain('EAN product');
    // The card carries the style and its lot code; the per-piece barcode moved
    // into the variant rows, which is where a reprint is actually chosen.
    expect(container.querySelector('[data-testid="style-card"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Mác hướng dẫn sử dụng vải');
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

  it('fails closed when normalized variant IDs are duplicated', async () => {
    await render(
      <FabricTagPrintPanel
        template={template}
        styleName="LOTUS"
        variants={[
          { id: 'duplicate-size', name: 'Small' },
          { id: ' duplicate-size ', name: 'Medium' },
        ]}
        ready
        t={(_key, fallback) => fallback}
        onStatus={onStatus}
      />,
    );

    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    expect(inputs).toHaveLength(4);
    expect(Array.from(inputs).every((input) => input.disabled)).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('duplicate ID');

    const printButton = buttonWithText(container, 'Print fabric labels');
    expect(printButton.disabled).toBe(true);
    await act(async () => printButton.click());
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

  it('uses a synchronous latch so rapid clicks cannot enqueue the same physical run twice', async () => {
    let completePrint!: (result: { success: boolean }) => void;
    printFabricTag.mockReturnValue(
      new Promise((resolve) => {
        completePrint = resolve;
      }),
    );
    await render(
      <FabricTagPrintPanel
        template={template}
        styleName="LOTUS"
        variants={[rows[0]]}
        ready
        t={(_key, fallback) => fallback}
        onStatus={onStatus}
      />,
    );

    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    await changeInput(inputs[0], 'S');
    await changeInput(inputs[1], '1');
    const button = buttonWithText(container, 'Print fabric labels (1)');
    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });

    expect(printFabricTag).toHaveBeenCalledTimes(1);
    await act(async () => {
      completePrint({ success: true });
    });
    await settle();
  });
});
