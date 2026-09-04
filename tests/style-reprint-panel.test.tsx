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
  { id: 'v1', name: 'KOMPLET DRESOWY - CZARNY / M', color_name: 'CZARNY', size_name: 'M', sku: '115-CZARNY-M', retail_price: 12900 },
  { id: 'v2', name: 'KOMPLET DRESOWY - CZARNY / S', color_name: 'CZARNY', size_name: 'S', sku: '115-CZARNY-S', retail_price: 12900 },
  { id: 'v3', name: 'KOMPLET DRESOWY - BEŻOWY / S', color_name: 'BEŻOWY', size_name: 'S', sku: '115-BEZOWY-S', retail_price: 12900 },
];

const TAG = {
  templateId: 'template-1',
  brandName: 'MoonCollection',
  logoDataUrl: null,
  composition: '70% BAWEŁNA 30% POLIESTER',
  careSymbols: ['wash-30'],
  careText: 'PRAĆ NA LEWEJ STRONIE',
  materials: [
    { name: 'BAWEŁNA', percent: 70 },
    { name: 'POLIESTER', percent: 30 },
  ],
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
  let saveTemplate: ReturnType<typeof vi.fn>;
  let createProduct: ReturnType<typeof vi.fn>;
  let updateVariant: ReturnType<typeof vi.fn>;
  let deactivateVariant: ReturnType<typeof vi.fn>;
  let uploadMainImage: ReturnType<typeof vi.fn>;
  let onCatalogChanged: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    printPackagingSticker = vi.fn(async () => ({ success: true }));
    printFabricTag = vi.fn(async () => ({ success: true }));
    getTemplate = vi.fn(async () => TAG);
    saveTemplate = vi.fn(async (template: any) => template);
    createProduct = vi.fn(async () => ({ ok: true, data: { variants: [{ id: 'v-new' }] } }));
    updateVariant = vi.fn(async () => ({ ok: true, data: { variant: { id: 'v1' } } }));
    deactivateVariant = vi.fn(async () => ({ ok: true, data: { variant: { id: 'v1' } } }));
    uploadMainImage = vi.fn(async () => ({ ok: true, data: {} }));
    vi.stubGlobal('Image', class {
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    onCatalogChanged = vi.fn(async () => undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printPackagingSticker,
        printFabricTag,
        pos: {
          fabricTagTemplates: { get: getTemplate, save: saveTemplate },
          productAdmin: { createProduct, updateVariant, deactivateVariant, uploadMainImage },
        },
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

  const CATEGORIES = [
    { id: 'cat-tracksuits', name: 'Komplety dresowe' },
    { id: 'cat-jackets', name: 'Kurtki' },
  ];

  async function render(overrides: Partial<Parameters<typeof StyleReprintPanel>[0]> = {}) {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <StyleReprintPanel
          language="en"
          templateId="template-1"
          styleName="KOMPLET DRESOWY"
          styleCode="115"
          variants={VARIANTS}
          categoryId="cat-tracksuits"
          categories={CATEGORIES}
          onCatalogChanged={onCatalogChanged}
          {...overrides}
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

  const openTagEditor = async () => {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="tag-edit-toggle"]')!.click(),
    );
    await settle();
  };

  it('opens the tag editor on what the machine would print, not on blank', async () => {
    await render();
    await openTagEditor();

    expect(container.querySelector<HTMLInputElement>('[data-testid="tag-brand"]')!.value)
      .toBe('MoonCollection');
    // The saved parts come back as the picker's own state, so a correction
    // starts from 70/30 rather than from an empty composition.
    expect(container.querySelector<HTMLInputElement>('input[aria-label="BAWEŁNA %"]')!.value)
      .toBe('70');
    expect(container.querySelector('[data-testid="composition-preview"]')?.textContent)
      .toBe('70% BAWEŁNA 30% POLIESTER');
    expect(container.querySelector('[data-testid="care-lines"]')?.textContent)
      .toContain('PRAĆ NA LEWEJ STRONIE');
  });

  it('saves a corrected composition and prints the corrected one', async () => {
    await render();
    await openTagEditor();

    // Drop polyester: the style turned out to be pure cotton.
    const materialButton = (name: string) =>
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === name,
      )!;
    await act(async () => materialButton('POLIESTER').click());
    // Re-queried after the toggle: the earlier node is detached, and typing
    // into a detached input would pass here while doing nothing on screen.
    await typeQuantity('BAWEŁNA %', '100');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="tag-save"]')!.click(),
    );
    await settle();

    expect(saveTemplate).toHaveBeenCalledTimes(1);
    expect(saveTemplate.mock.calls[0][0]).toMatchObject({
      templateId: 'template-1',
      composition: '100% BAWEŁNA',
      materials: [{ name: 'BAWEŁNA', percent: 100 }],
    });

    // The saved row is what the panel prints from, without a reload: a
    // correction the operator just made must reach the next tag.
    await typeQuantity('CZARNY S', '1');
    await act(async () => printButton().click());
    await settle();
    expect(printFabricTag.mock.calls[0][0].composition).toBe('100% BAWEŁNA');
  });

  it('fills in a style that had no care content, and unlocks the fabric lane', async () => {
    getTemplate.mockResolvedValue(null);
    await render();

    const fabricLane = () =>
      container.querySelector<HTMLInputElement>('[data-testid="lane-fabric"]')!;
    expect(fabricLane().disabled).toBe(true);

    await openTagEditor();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-symbol="WASH_30"]')!.click(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="tag-save"]')!.click(),
    );
    await settle();

    expect(saveTemplate.mock.calls[0][0].careSymbols).toEqual(['WASH_30']);
    expect(fabricLane().disabled).toBe(false);
  });

  it('keeps a stored composition line it cannot take apart', async () => {
    // Written by hand, or by an older version that stored only the line. Losing
    // it because someone edited the care symbols would change what a garment
    // says about its fabric.
    getTemplate.mockResolvedValue({ ...TAG, materials: [], composition: '70% BAWEŁNA + dodatki' });
    await render();
    await openTagEditor();

    expect(container.querySelector('[data-testid="tag-kept-composition"]')?.textContent)
      .toContain('70% BAWEŁNA + dodatki');

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="tag-save"]')!.click(),
    );
    await settle();

    expect(saveTemplate.mock.calls[0][0].composition).toBe('70% BAWEŁNA + dodatki');
  });

  it('keeps the typed correction on screen when the save fails', async () => {
    saveTemplate.mockRejectedValue(new Error('database is locked'));
    await render();
    await openTagEditor();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="tag-save"]')!.click(),
    );
    await settle();

    expect(statusText()).toContain('Could not save');
    // Still open, still holding what was typed — a failed write must not throw
    // the correction away.
    expect(container.querySelector('[data-testid="tag-brand"]')).not.toBeNull();
  });

  const typeCell = async (colour: string, size: string) => {
    await typeQuantity('Colour', colour);
    await typeQuantity('Size', size);
  };

  const addButton = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="add-submit"]')!;

  it('adds a colour to the style that is open, under its existing product', async () => {
    await render();
    await typeCell('ZIELONY', 'L');
    await act(async () => addButton().click());
    await settle();

    expect(createProduct).toHaveBeenCalledTimes(1);
    const payload = createProduct.mock.calls[0][0];
    expect(payload).toMatchObject({
      productId: 'template-1',
      name: 'KOMPLET DRESOWY',
      // Sibling rows set the price: a new colour of a style the till sells
      // must not ring up at a different number.
      priceGrossGrosze: 12900,
    });
    expect(payload.variants).toEqual([
      {
        colorName: 'ZIELONY',
        sizeName: 'L',
        sku: '115-ZIELONY-L',
        barcode: '115-ZIELONY-L',
        initialStockQty: 0,
      },
    ]);

    // The row exists on the server; it reaches the list on screen through a sync.
    expect(onCatalogChanged).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain('Added ZIELONY / L');
  });

  it('will not add a colour and size the style already has', async () => {
    await render();
    await typeCell('CZARNY', 'S');

    expect(addButton().disabled).toBe(true);
    expect(container.querySelector('[data-testid="add-problem"]')?.textContent)
      .toContain('already has');

    await act(async () => addButton().click());
    await settle();
    expect(createProduct).not.toHaveBeenCalled();
  });

  it('keeps the typed cell and does not claim success when the server refuses', async () => {
    createProduct.mockResolvedValue({ ok: false, error: 'VARIANT_COMBINATION_EXISTS' });
    await render();
    await typeCell('ZIELONY', 'L');
    await act(async () => addButton().click());
    await settle();

    expect(statusText()).toContain('VARIANT_COMBINATION_EXISTS');
    expect(onCatalogChanged).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="add-color"]')!.value,
    ).toBe('ZIELONY');
  });

  it('retries a failed add under the same key so a lost answer adds it once', async () => {
    createProduct.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await render();
    await typeCell('ZIELONY', 'L');
    await act(async () => addButton().click());
    await settle();
    await act(async () => addButton().click());
    await settle();

    const [first, second] = createProduct.mock.calls.map((call) => call[0].idempotencyKey);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
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

  describe('style profile', () => {
    const categorySelect = () =>
      container.querySelector<HTMLSelectElement>('[data-testid="style-category"]')!;

    async function pick(id: string) {
      const select = categorySelect();
      await act(async () => {
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await settle();
    }

    it('shows the style as the catalogue holds it', async () => {
      await render();
      expect(container.querySelector('[data-testid="profile-name"]')?.textContent).toBe('KOMPLET DRESOWY');
      expect(container.querySelector('[data-testid="profile-code"]')?.textContent).toBe('115');
      expect(categorySelect().value).toBe('cat-tracksuits');
    });

    it('moves the whole style through one of its rows and pulls the catalogue', async () => {
      await render();
      await pick('cat-jackets');

      expect(updateVariant).toHaveBeenCalledTimes(1);
      expect(updateVariant.mock.calls[0][0]).toBe('v3'); // the first row as sorted
      expect(updateVariant.mock.calls[0][1]).toEqual({ categoryId: 'cat-jackets' });
      expect(onCatalogChanged).toHaveBeenCalledTimes(1);
      expect(statusText()).toContain('Kurtki');
    });

    it('does nothing when the same category is picked again', async () => {
      await render();
      await pick('cat-tracksuits');
      expect(updateVariant).not.toHaveBeenCalled();
    });

    it('reports a refused move and leaves the catalogue alone', async () => {
      updateVariant.mockResolvedValue({ ok: false, error: 'stale' });
      await render();
      await pick('cat-jackets');

      expect(statusText()).toContain('stale');
      expect(onCatalogChanged).not.toHaveBeenCalled();
      // Controlled by the catalogue, so the select shows what is still true.
      expect(categorySelect().value).toBe('cat-tracksuits');
    });
  });

  describe('hiding a row', () => {
    const hideButtons = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="hide-variant"]'));

    it('takes two presses, and the first can be taken back', async () => {
      await render();
      expect(hideButtons()).toHaveLength(3);
      await act(async () => hideButtons()[0].click());
      expect(container.querySelector('[data-testid="hide-confirm"]')).not.toBeNull();
      expect(deactivateVariant).not.toHaveBeenCalled();

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="hide-cancel"]')!.click();
      });
      expect(container.querySelector('[data-testid="hide-confirm"]')).toBeNull();
      expect(deactivateVariant).not.toHaveBeenCalled();
    });

    it('deactivates the row on the second press and pulls the catalogue', async () => {
      await render();
      const target = hideButtons().find((button) => button.dataset.variantId === 'v2')!;
      await act(async () => target.click());
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="hide-confirm"]')!.click();
      });
      await settle();

      expect(deactivateVariant).toHaveBeenCalledTimes(1);
      expect(deactivateVariant.mock.calls[0][0]).toBe('v2');
      expect(deactivateVariant.mock.calls[0][1]).toMatchObject({ reason: expect.any(String) });
      expect(onCatalogChanged).toHaveBeenCalledTimes(1);
      expect(statusText()).toContain('CZARNY / S');
    });

    it('reports a refused hide and keeps the row', async () => {
      deactivateVariant.mockResolvedValue({ ok: false, code: 'VARIANT_IN_USE' });
      await render();
      await act(async () => hideButtons()[0].click());
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="hide-confirm"]')!.click();
      });
      await settle();

      expect(statusText()).toContain('VARIANT_IN_USE');
      expect(onCatalogChanged).not.toHaveBeenCalled();
      expect(hideButtons()).toHaveLength(2);
      expect(container.querySelector('[data-testid="hide-confirm"]')).not.toBeNull();
    });
  });

  describe('the style photo', () => {
    async function pickPhoto(name = 'moon.jpg', type = 'image/jpeg') {
      const file = new File(['abc'], name, { type });
      const picker = container.querySelector<HTMLInputElement>('[data-testid="style-image"]')!;
      Object.defineProperty(picker, 'files', { value: [file], configurable: true });
      await act(async () => {
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // The file is read off the event loop, not the microtask queue.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await settle();
    }

    it('shows the picture a row already carries', async () => {
      await render({
        variants: [{ ...VARIANTS[0], thumbnail_url: 'https://img/thumb.jpg' }, VARIANTS[1]],
      });
      expect(
        container.querySelector<HTMLImageElement>('[data-testid="style-image-preview"]')?.src,
      ).toBe('https://img/thumb.jpg');
    });

    it('puts a picked photo on every row and pulls the catalogue', async () => {
      await render();
      expect(container.querySelector('[data-testid="style-image-preview"]')).toBeNull();
      await pickPhoto();

      expect(uploadMainImage).toHaveBeenCalledTimes(3);
      expect(new Set(uploadMainImage.mock.calls.map((call) => call[0]))).toEqual(
        new Set(['v1', 'v2', 'v3']),
      );
      expect(uploadMainImage.mock.calls[0][1]).toMatchObject({ dataUrl: 'data:image/jpeg;base64,YWJj' });
      expect(onCatalogChanged).toHaveBeenCalledTimes(1);
      expect(statusText()).toContain('Photo set');
    });

    it('says how many rows took the photo when one refuses it', async () => {
      uploadMainImage.mockImplementation(async (variantId: string) =>
        variantId === 'v2' ? { ok: false, error: 'stale' } : { ok: true, data: {} },
      );
      await render();
      await pickPhoto();

      expect(statusText()).toContain('2/3');
      expect(onCatalogChanged).toHaveBeenCalledTimes(1);
    });

    it('reports a photo no row would take, and pulls nothing', async () => {
      uploadMainImage.mockResolvedValue({ ok: false, error: 'offline' });
      await render();
      await pickPhoto();

      expect(statusText()).toContain('Could not attach');
      expect(onCatalogChanged).not.toHaveBeenCalled();
    });

    it('refuses a file that is not a picture before uploading anything', async () => {
      await render();
      await pickPhoto('sheet.pdf', 'application/pdf');

      expect(uploadMainImage).not.toHaveBeenCalled();
      expect(statusText()).toContain('JPG');
    });
  });
});
