// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StyleReprintPanel from '../src/renderer/components/label/StyleReprintPanel';

/**
 * Reprinting one style from the product tab.
 *
 * What these pin down is the part an operator cannot check by looking: that the
 * numbers typed beside a colour reach the two printers as the same payloads the
 * order sheet sends, that a style with no saved care content cannot put a blank
 * fabric tag into a garment, and that a large run is asked about once.
 */

const VARIANTS = [
  { id: 'v1', name: 'KOMPLET DRESOWY - CZARNY / M', color_name: 'CZARNY', size_name: 'M' },
  { id: 'v2', name: 'KOMPLET DRESOWY - CZARNY / S', color_name: 'CZARNY', size_name: 'S' },
  { id: 'v3', name: 'KOMPLET DRESOWY - BEŻOWY / S', color_name: 'BEŻOWY', size_name: 'S' },
];

const TAG = {
  templateId: 'template-1',
  brandName: 'MoonCollection',
  logoDataUrl: null,
  composition: '70% BAWEŁNA 30% POLIESTER',
  careSymbols: ['wash-30'],
  careText: 'PRAĆ NA LEWEJ STRONIE',
  fabric: null,
  layout: 'default' as const,
};

async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('StyleReprintPanel', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let printPackagingSticker: ReturnType<typeof vi.fn>;
  let printFabricTag: ReturnType<typeof vi.fn>;
  let getTemplate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    printPackagingSticker = vi.fn(async () => ({ success: true }));
    printFabricTag = vi.fn(async () => ({ success: true }));
    getTemplate = vi.fn(async () => TAG);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printPackagingSticker,
        printFabricTag,
        pos: { fabricTagTemplates: { get: getTemplate } },
      },
    });
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <StyleReprintPanel
          language="en"
          templateId="template-1"
          styleName="KOMPLET DRESOWY"
          styleCode="115"
          variants={VARIANTS}
        />,
      );
    });
    await settle();
  }

  const printButton = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="reprint-print"]')!;

  const statusText = () =>
    container.querySelector('[data-testid="reprint-status"]')?.textContent?.trim() ?? '';

  async function typeQuantity(label: string, value: string) {
    const box = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!box) throw new Error(`No quantity box for ${label}`);
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setValue?.call(box, value);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('lists the style\'s colours and sizes in the order the shop says them', async () => {
    await render();

    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).slice(0, 2).map((cell) => cell.textContent),
    );
    // BEŻOWY before CZARNY, and S before M inside a colour — not the order the
    // catalogue happens to return, and not the alphabet's idea of sizes.
    expect(rows).toEqual([
      ['BEŻOWY', 'S'],
      ['CZARNY', 'S'],
      ['CZARNY', 'M'],
    ]);
  });

  it('stays disabled until a row has a quantity', async () => {
    await render();
    expect(printButton().disabled).toBe(true);

    await typeQuantity('CZARNY S', '2');
    expect(printButton().disabled).toBe(false);
  });

  it('sends the quantities typed to both printers', async () => {
    await render();
    await typeQuantity('CZARNY S', '2');
    await typeQuantity('CZARNY M', '1');
    await act(async () => printButton().click());
    await settle();

    // One bag label per colour, covering both sizes; one fabric tag per cell.
    expect(printPackagingSticker).toHaveBeenCalledTimes(1);
    expect(printPackagingSticker.mock.calls[0][0]).toMatchObject({
      customerName: 'MoonCollection',
      styleName: 'KOMPLET DRESOWY',
      styleCode: '115',
      colorName: 'CZARNY',
      quantity: 3,
    });
    expect(printFabricTag).toHaveBeenCalledTimes(2);
    expect(printFabricTag.mock.calls.map((call) => call[0].size)).toEqual(['S', 'M']);
    expect(printFabricTag.mock.calls[0][0]).toMatchObject({
      composition: '70% BAWEŁNA 30% POLIESTER',
      careSymbols: ['wash-30'],
      careText: 'PRAĆ NA LEWEJ STRONIE',
      quantity: 2,
    });
    // Three bag labels for the colour plus one tag per garment.
    expect(statusText()).toContain('Printed 6 labels');
  });

  it('prints only the lane that is switched on', async () => {
    await render();
    await typeQuantity('CZARNY S', '2');
    const fabricLane = container.querySelector<HTMLInputElement>('[data-testid="lane-fabric"]')!;
    await act(async () => fabricLane.click());
    await act(async () => printButton().click());
    await settle();

    expect(printPackagingSticker).toHaveBeenCalledTimes(1);
    expect(printFabricTag).not.toHaveBeenCalled();
  });

  it('cannot print a fabric tag for a style with no saved care content', async () => {
    getTemplate.mockResolvedValue(null);
    await render();
    await typeQuantity('CZARNY S', '2');

    expect(container.querySelector('[data-testid="reprint-no-tag"]')).not.toBeNull();
    const fabricLane = container.querySelector<HTMLInputElement>('[data-testid="lane-fabric"]')!;
    expect(fabricLane.disabled).toBe(true);
    expect(fabricLane.checked).toBe(false);

    await act(async () => printButton().click());
    await settle();

    // A blank tag is sewn into a garment and leaves the workshop; no tag at all
    // is a bundle someone can still label by hand.
    expect(printFabricTag).not.toHaveBeenCalled();
    expect(printPackagingSticker).toHaveBeenCalledTimes(1);
  });

  it('asks a second time before a large run', async () => {
    await render();
    await typeQuantity('CZARNY S', '40');

    await act(async () => printButton().click());
    await settle();
    expect(printPackagingSticker).not.toHaveBeenCalled();
    expect(printButton().textContent).toContain('Press again to print 80 labels');

    await act(async () => printButton().click());
    await settle();
    expect(printPackagingSticker).toHaveBeenCalledTimes(1);
  });

  it('drops the confirmation when the quantity changes underneath it', async () => {
    await render();
    await typeQuantity('CZARNY S', '40');
    await act(async () => printButton().click());
    await settle();
    expect(printButton().textContent).toContain('Press again');

    // Still a large run, but no longer the one that was warned about: the
    // operator agreed to 80 labels, not to whatever is typed next.
    await typeQuantity('CZARNY S', '60');
    await act(async () => printButton().click());
    await settle();

    expect(printPackagingSticker).not.toHaveBeenCalled();
    expect(printButton().textContent).toContain('Press again to print 120 labels');

    await act(async () => printButton().click());
    await settle();
    expect(printPackagingSticker.mock.calls[0][0].quantity).toBe(60);
  });

  it('stops at the first printer failure and keeps the typed numbers', async () => {
    printFabricTag.mockResolvedValue({ success: false, error: 'out of ribbon' });
    await render();
    await typeQuantity('CZARNY S', '2');
    await act(async () => printButton().click());
    await settle();

    expect(statusText()).toContain('out of ribbon');
    const box = container.querySelector<HTMLInputElement>('input[aria-label="CZARNY S"]')!;
    expect(box.value).toBe('2');
  });

  it('survives a machine whose fabric tag store is not wired up', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { printPackagingSticker, printFabricTag, pos: {} },
    });
    await render();

    expect(container.querySelector('[data-testid="style-reprint"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="reprint-no-tag"]')).not.toBeNull();
  });
});
