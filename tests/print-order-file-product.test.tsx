// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PrintOrderPanel from '../src/renderer/components/label/PrintOrderPanel';

/**
 * Filing a print order as a product. The sheet is already a colour x size grid,
 * so what these tests pin down is that the grid on screen and the payload that
 * leaves the machine are the same grid — and that pressing twice, or pressing
 * after a dropped connection, cannot make a second product.
 */

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

/** What the server answers for a grid of `count` cells. */
function created(count: number) {
  const variants = Array.from({ length: count }, (_, index) => ({
    id: `variant-${index}`,
    templateId: 'template-1',
    name: `KURTKA ${index}`,
  }));
  return {
    ok: true,
    data: { product: { id: 'template-1' }, variant: variants[0], variants },
  };
}

describe('PrintOrderPanel — filing a sheet as a product', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let createProduct: ReturnType<typeof vi.fn>;
  let createCategory: ReturnType<typeof vi.fn>;
  let uploadMainImage: ReturnType<typeof vi.fn>;
  let updateVariant: ReturnType<typeof vi.fn>;
  let styleById: ReturnType<typeof vi.fn>;
  let styleByCode: ReturnType<typeof vi.fn>;
  let saveFabricTagTemplate: ReturnType<typeof vi.fn>;
  let onCategoriesChanged: ReturnType<typeof vi.fn>;
  let onProductFiled: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    container = document.createElement('div');
    document.body.appendChild(container);
    createProduct = vi.fn(async () => created(2));
    createCategory = vi.fn(async ({ name }: { name: string }) => ({
      ok: true,
      data: { category: { id: 'cat-new', name, isActive: true } },
    }));
    saveFabricTagTemplate = vi.fn(async (template: any) => template);
    uploadMainImage = vi.fn(async () => ({ ok: true, data: {} }));
    updateVariant = vi.fn(async () => ({ ok: true, data: {} }));
    styleById = vi.fn(() => null);
    styleByCode = vi.fn(() => null);
    // No decoder in the harness: the picture is sent as it was picked.
    vi.stubGlobal('Image', class {
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    onCategoriesChanged = vi.fn(async () => {});
    onProductFiled = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printPackagingSticker: vi.fn(async () => ({ success: true })),
        printFabricTag: vi.fn(async () => ({ success: true })),
        pos: {
          productAdmin: { createProduct, createCategory, uploadMainImage, updateVariant },
          fabricTagTemplates: { save: saveFabricTagTemplate },
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

  /** The label tab's categories, as `LabelModule` passes them down. */
  const CATEGORIES = [
    { id: 'cat-jackets', name: 'Kurtki' },
    { id: 'cat-tracksuits', name: 'KOMPLETY DRESOWE' },
  ];

  /**
   * Every test mounts with the jackets category present: filing is refused
   * without one, and most of what is pinned down here is the grid, not the
   * category.
   */
  async function render(categories: { id: string; name: string }[] = CATEGORIES) {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <PrintOrderPanel
          language="en"
          active
          onPrintingChange={() => {}}
          categories={categories}
          onCategoriesChanged={onCategoriesChanged}
          onProductFiled={onProductFiled}
          styleById={styleById}
          styleByCode={styleByCode}
        />,
      );
    });
    await settle();
  }

  const categorySelect = () =>
    container.querySelector<HTMLSelectElement>('[data-testid="order-category"]')!;

  async function pickCategory(id: string) {
    const select = categorySelect();
    await act(async () => {
      select.value = id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  const fileButton = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="file-product"]')!;

  const fileResult = () =>
    container.querySelector('[data-testid="file-result"]')?.textContent?.trim() ?? '';

  /** Adds a colour row and names it. */
  async function addColour(name: string) {
    await act(async () => buttonWithText(container, 'Add colour').click());
    const colourInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[placeholder="CZEKOLADA"]'),
    );
    await changeInput(colourInputs[colourInputs.length - 1], name);
  }

  /**
   * Two colours across two sizes. The sheet counts garments per size on its
   * top row and knows nothing about how many of each colour, so every colour
   * becomes a variant in every size.
   */
  async function fillGrid() {
    await changeInput(input(container, 'input[placeholder="MoonCollection"]'), 'MOON');
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'KURTKA');
    await changeInput(input(container, 'input[placeholder="114"]'), 'LOT114');
    await act(async () => buttonWithText(container, '+ S').click());
    await act(async () => buttonWithText(container, '+ M').click());
    await changeInput(input(container, 'input[aria-label="Fabric tags S"]'), '7');
    await changeInput(input(container, 'input[aria-label="Fabric tags M"]'), '6');
    await addColour('BEŻOWY');
    await addColour('CZARNY');
    await changeInput(input(container, '[data-testid="order-price"]'), '129');
  }

  it('stays disabled until the sheet has a name and a colour', async () => {
    await render();
    expect(fileButton().disabled).toBe(true);

    await fillGrid();
    expect(fileButton().disabled).toBe(false);
  });

  it('sends every colour in every size, with the stock opened at zero', async () => {
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(createProduct).toHaveBeenCalledTimes(1);
    const payload = createProduct.mock.calls[0][0];
    expect(payload.name).toBe('KURTKA');
    // Sewn to order: the till must sell the style at zero stock, so no count is kept.
    expect(payload.trackInventory).toBe(false);
    expect(payload.variants).toEqual([
      {
        colorName: 'BEŻOWY',
        sizeName: 'S',
        sku: 'LOT114-BEZOWY-S',
        barcode: 'LOT114-BEZOWY-S',
        initialStockQty: 0,
      },
      {
        colorName: 'BEŻOWY',
        sizeName: 'M',
        sku: 'LOT114-BEZOWY-M',
        barcode: 'LOT114-BEZOWY-M',
        initialStockQty: 0,
      },
      {
        colorName: 'CZARNY',
        sizeName: 'S',
        sku: 'LOT114-CZARNY-S',
        barcode: 'LOT114-CZARNY-S',
        initialStockQty: 0,
      },
      {
        colorName: 'CZARNY',
        sizeName: 'M',
        sku: 'LOT114-CZARNY-M',
        barcode: 'LOT114-CZARNY-M',
        initialStockQty: 0,
      },
    ]);
  });

  // Without a category the filed product never reaches the label tab, and
  // without a barcode the tab refuses to print it — the two reasons the first
  // real sheet went in and came out invisible.
  it('files the sheet into the category its style belongs to', async () => {
    await render(CATEGORIES);
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(createProduct.mock.calls[0][0].categoryId).toBe('cat-jackets');
  });

  it('shows the resolved category before the sheet is filed', async () => {
    await render(CATEGORIES);
    await fillGrid();

    expect(categorySelect().value).toBe('cat-jackets');
    expect(categorySelect().selectedOptions[0]?.textContent).toBe('Kurtki');
  });

  it('refuses to file when no category carries the style name', async () => {
    await render([{ id: 'cat-other', name: 'Spodnie' }]);
    await fillGrid();

    expect(categorySelect().value).toBe('');
    expect(
      container.querySelector('[data-testid="order-category-none"]')?.textContent,
    ).toContain('No category');
    expect(fileButton().disabled).toBe(true);
    await act(async () => fileButton().click());
    await settle();
    expect(createProduct).not.toHaveBeenCalled();
  });

  it('files into the category picked by hand, over the guess', async () => {
    await render([...CATEGORIES, { id: 'cat-other', name: 'Spodnie' }]);
    await fillGrid();
    await pickCategory('cat-other');
    await act(async () => fileButton().click());
    await settle();

    expect(createProduct.mock.calls[0][0].categoryId).toBe('cat-other');
    expect(onProductFiled).toHaveBeenCalledWith({ categoryId: 'cat-other' });
  });

  it('creates a category named after the style and files into it', async () => {
    await render([{ id: 'cat-other', name: 'Kurtki' }]);
    await fillGrid();
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'SPODNIE');

    const create = container.querySelector<HTMLButtonElement>('[data-testid="create-category"]')!;
    expect(create.textContent).toContain('SPODNIE');
    await act(async () => create.click());
    await settle();

    // Named like the categories the shop already has, not shouted.
    expect(createCategory.mock.calls[0][0].name).toBe('Spodnie');
    expect(onCategoriesChanged).toHaveBeenCalledTimes(1);
    expect(categorySelect().value).toBe('cat-new');
    expect(categorySelect().selectedOptions[0]?.textContent).toBe('Spodnie');
    expect(fileButton().disabled).toBe(false);

    await act(async () => fileButton().click());
    await settle();
    expect(createProduct.mock.calls[0][0].categoryId).toBe('cat-new');
  });

  it('keeps the sheet unfiled and says why when the category cannot be created', async () => {
    createCategory.mockResolvedValue({ ok: false, error: 'offline' });
    await render([]);
    await fillGrid();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="create-category"]')!.click();
    });
    await settle();

    expect(fileResult()).toContain('offline');
    expect(fileButton().disabled).toBe(true);
    expect(onCategoriesChanged).not.toHaveBeenCalled();
  });

  it('remembers the category for the style name once the sheet is filed', async () => {
    const categories = [...CATEGORIES, { id: 'cat-other', name: 'Spodnie' }];
    await render(categories);
    await fillGrid();
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'SPODNIE');
    await pickCategory('cat-other');
    await act(async () => fileButton().click());
    await settle();

    // A fresh sheet with the same style name: nothing picked, yet it lands
    // where the last one went.
    await act(async () => root!.unmount());
    root = null;
    localStorage.removeItem('zira.labelPrintOrder.draft');
    await render(categories);
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'spodnie');
    expect(categorySelect().value).toBe('cat-other');
  });

  it('does not remember a category that was only picked, never filed', async () => {
    const categories = [...CATEGORIES, { id: 'cat-other', name: 'Spodnie' }];
    await render(categories);
    await fillGrid();
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'SPODNIE');
    await pickCategory('cat-other');

    await act(async () => root!.unmount());
    root = null;
    localStorage.removeItem('zira.labelPrintOrder.draft');
    await render(categories);
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'SPODNIE');
    expect(categorySelect().value).toBe('');
  });

  it('files the whole style at the one price typed on the sheet', async () => {
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(createProduct.mock.calls[0][0].priceGrossGrosze).toBe(12900);
  });

  it('will not file a sheet without a price, and says so', async () => {
    await render();
    await fillGrid();
    await changeInput(input(container, '[data-testid="order-price"]'), '');
    expect(fileButton().disabled).toBe(true);
    expect(fileButton().title).toContain('No price yet');
  });

  it('keeps "12," under the cursor and reads it as 12 zł', async () => {
    await render();
    await fillGrid();
    const price = () => input(container, '[data-testid="order-price"]');
    await changeInput(price(), '12,');
    expect(price().value).toBe('12,');
    await act(async () => { price().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(price().value).toBe('12,00');
  });

  async function pickPhoto(name = 'moon.jpg', type = 'image/jpeg') {
    const file = new File(['abc'], name, { type });
    const picker = container.querySelector<HTMLInputElement>('[data-testid="order-image"]')!;
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

  it('keeps a picked photo on the sheet and puts it on every row it files', async () => {
    await render();
    await fillGrid();
    await pickPhoto();
    expect(container.querySelector('[data-testid="order-image-preview"]')).not.toBeNull();

    await act(async () => fileButton().click());
    await settle();

    expect(uploadMainImage).toHaveBeenCalledTimes(2);
    expect(uploadMainImage.mock.calls.map((call) => call[0])).toEqual(['variant-0', 'variant-1']);
    expect(uploadMainImage.mock.calls[0][1]).toMatchObject({
      dataUrl: 'data:image/jpeg;base64,YWJj',
      mimeType: 'image/jpeg',
    });
    expect(fileResult()).toContain('photo attached');
  });

  it('says how many rows got the photo when some refuse it', async () => {
    uploadMainImage.mockImplementation(async (variantId: string) =>
      variantId === 'variant-1' ? { ok: false, error: 'stale' } : { ok: true, data: {} },
    );
    await render();
    await fillGrid();
    await pickPhoto();
    await act(async () => fileButton().click());
    await settle();

    expect(fileResult()).toContain('1/2');
  });

  it('files without a photo when none was picked, and uploads nothing', async () => {
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(uploadMainImage).not.toHaveBeenCalled();
    expect(fileResult()).not.toContain('photo');
  });

  it('refuses a file that is not a picture and keeps the sheet as it was', async () => {
    await render();
    await fillGrid();
    await pickPhoto('sheet.pdf', 'application/pdf');

    expect(container.querySelector('[data-testid="order-image-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="order-image-error"]')?.textContent).toContain('JPG');
  });

  it('lets the photo be taken off the sheet again', async () => {
    await render();
    await fillGrid();
    await pickPhoto();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="order-image-clear"]')!.click();
    });

    expect(container.querySelector('[data-testid="order-image-preview"]')).toBeNull();
    await act(async () => fileButton().click());
    await settle();
    expect(uploadMainImage).not.toHaveBeenCalled();
  });

  it('reports how many rows were created', async () => {
    createProduct.mockResolvedValue(created(3));
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(fileResult()).toBe('Saved — 3 variants');
  });

  // The care content lives on the sheet and nowhere else in the catalogue, so
  // filing has to copy it across or the product tab can never print a tag.
  it('saves the care content against the new style', async () => {
    await render(CATEGORIES);
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(saveFabricTagTemplate).toHaveBeenCalledTimes(1);
    expect(saveFabricTagTemplate.mock.calls[0][0]).toMatchObject({
      templateId: 'template-1',
      layout: 'default',
    });
  });

  it('says so when the product was created but its care content was not', async () => {
    saveFabricTagTemplate.mockRejectedValue(new Error('disk full'));
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    // The server has already made the product; reporting a plain failure would
    // send the operator back to file it a second time.
    expect(fileResult()).toContain('Saved 2 variants');
    expect(fileResult()).toContain('care content did not save');
  });

  it('will not file the same sheet twice', async () => {
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    // The Save button is gone: the sheet now offers Update, which never creates
    // a second product for the same sheet.
    expect(fileButton()).toBeNull();
    const update = container.querySelector<HTMLButtonElement>('[data-testid="update-product"]')!;
    expect(update).not.toBeNull();
    await act(async () => update.click());
    await settle();
    expect(createProduct).toHaveBeenCalledTimes(1);
  });

  it('keeps the sheet fileable when the create fails', async () => {
    createProduct.mockResolvedValue({ ok: false, error: 'network unreachable' });
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(fileResult()).toBe('Not saved: network unreachable');
    expect(fileButton().disabled).toBe(false);
  });

  it('reuses the idempotency key after a failure, so a retry cannot make a twin', async () => {
    createProduct.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    createProduct.mockResolvedValueOnce(created(3));
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();
    await act(async () => fileButton().click());
    await settle();

    const [first] = createProduct.mock.calls[0];
    const [second] = createProduct.mock.calls[1];
    expect(first.idempotencyKey).toBeTruthy();
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('survives the create throwing outright', async () => {
    createProduct.mockRejectedValue(new Error('bridge closed'));
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(fileResult()).toBe('Not saved: bridge closed');
    expect(fileButton().disabled).toBe(false);
  });

  it('does not file a sheet that answered without any row', async () => {
    createProduct.mockResolvedValue({ ok: true, data: { product: { id: 't' } } });
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(fileButton().disabled).toBe(false);
    expect(fileResult()).toContain('Not saved');
  });

  describe('after the sheet is a product', () => {
    /** What the product tab holds for the filed style: the four rows created. */
    const STYLE = {
      name: 'KURTKA',
      categoryId: 'cat-jackets',
      variants: [
        { id: 'variant-0', color_name: 'BEŻOWY', size_name: 'S', sku: 'LOT114-BEZOWY-S', retail_price: 12900 },
        { id: 'variant-1', color_name: 'BEŻOWY', size_name: 'M', sku: 'LOT114-BEZOWY-M', retail_price: 12900 },
        { id: 'variant-2', color_name: 'CZARNY', size_name: 'S', sku: 'LOT114-CZARNY-S', retail_price: 12900 },
        { id: 'variant-3', color_name: 'CZARNY', size_name: 'M', sku: 'LOT114-CZARNY-M', retail_price: 12900 },
      ],
    };

    const updateButton = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="update-product"]')!;

    async function fileSheet() {
      await render();
      await fillGrid();
      await act(async () => fileButton().click());
      await settle();
      createProduct.mockClear();
      styleById.mockReturnValue(STYLE);
    }

    it('offers Update instead of Save, and says which product the sheet is', async () => {
      await fileSheet();
      expect(fileButton()).toBeNull();
      expect(updateButton().disabled).toBe(false);
      expect(container.querySelector('[data-testid="filed-hint"]')?.textContent).toContain('KURTKA');
    });

    it('adds only the colours and sizes the product does not have yet', async () => {
      await fileSheet();
      // A third colour comes in; the two sizes it needs are the only new rows.
      await addColour('BIAŁY');
      createProduct.mockResolvedValue({ ok: true, data: { variants: [{ id: 'variant-4' }, { id: 'variant-5' }] } });
      await act(async () => updateButton().click());
      await settle();

      expect(createProduct).toHaveBeenCalledTimes(1);
      const payload = createProduct.mock.calls[0][0];
      expect(payload.productId).toBe('template-1');
      expect(payload.variants).toEqual([
        { colorName: 'BIAŁY', sizeName: 'S', sku: 'LOT114-BIALY-S', barcode: 'LOT114-BIALY-S', initialStockQty: 0 },
        { colorName: 'BIAŁY', sizeName: 'M', sku: 'LOT114-BIALY-M', barcode: 'LOT114-BIALY-M', initialStockQty: 0 },
      ]);
      expect(saveFabricTagTemplate).toHaveBeenCalledTimes(2);
      expect(fileResult()).toContain('2 new');
      expect(onProductFiled).toHaveBeenLastCalledWith({ categoryId: 'cat-jackets' });
    });

    it('creates nothing when every colour and size is already on the product', async () => {
      await fileSheet();
      await act(async () => updateButton().click());
      await settle();

      expect(createProduct).not.toHaveBeenCalled();
      expect(updateVariant).not.toHaveBeenCalled();
      expect(fileResult()).toContain('Product updated');
    });

    it('brings the rows the product already had to the price now on the sheet', async () => {
      await fileSheet();
      styleById.mockReturnValue({
        ...STYLE,
        variants: STYLE.variants.map((row, index) => ({ ...row, retail_price: index === 0 ? 12900 : 9900 })),
      });
      await act(async () => updateButton().click());
      await settle();

      expect(updateVariant.mock.calls).toEqual([
        ['variant-1', { priceGrossGrosze: 12900 }],
        ['variant-2', { priceGrossGrosze: 12900 }],
        ['variant-3', { priceGrossGrosze: 12900 }],
      ]);
      expect(fileResult()).toContain('3 existing rows');
    });

    it('stops and says so when an old row will not take the price', async () => {
      await fileSheet();
      styleById.mockReturnValue({
        ...STYLE,
        variants: STYLE.variants.map((row) => ({ ...row, retail_price: 9900 })),
      });
      updateVariant.mockResolvedValueOnce({ ok: false, error: 'stale' });
      await act(async () => updateButton().click());
      await settle();

      expect(updateVariant).toHaveBeenCalledTimes(1);
      expect(fileResult()).toContain('stale');
      expect(uploadMainImage).not.toHaveBeenCalled();
    });

    it('moves the product when the sheet picked another category', async () => {
      await fileSheet();
      await pickCategory('cat-tracksuits');
      await act(async () => updateButton().click());
      await settle();

      expect(updateVariant).toHaveBeenCalledTimes(1);
      expect(updateVariant.mock.calls[0][0]).toBe('variant-0');
      expect(updateVariant.mock.calls[0][1]).toEqual({ categoryId: 'cat-tracksuits' });
    });

    it('puts a photo added later on every row, old and new', async () => {
      await fileSheet();
      await addColour('BIAŁY');
      createProduct.mockResolvedValue({ ok: true, data: { variants: [{ id: 'variant-4' }, { id: 'variant-5' }] } });
      await pickPhoto();
      await act(async () => updateButton().click());
      await settle();

      expect(uploadMainImage.mock.calls.map((call) => call[0])).toEqual([
        'variant-0', 'variant-1', 'variant-2', 'variant-3', 'variant-4', 'variant-5',
      ]);
    });

    it('refuses to push when the catalogue on this machine has not caught up', async () => {
      await fileSheet();
      styleById.mockReturnValue(null);
      await act(async () => updateButton().click());
      await settle();

      expect(createProduct).not.toHaveBeenCalled();
      expect(fileResult()).toContain('Sync');
    });

    it('keeps the sheet editable but never files it twice', async () => {
      await fileSheet();
      await act(async () => updateButton().click());
      await settle();
      expect(createProduct).not.toHaveBeenCalled();
      expect(fileButton()).toBeNull();
    });

    describe('when the code typed is already a style on the product tab', () => {
      /** The style the tab holds under LOT114: one colour, one size. */
      const EXISTING = {
        id: 'template-9',
        name: 'KURTKA STARA',
        categoryId: 'cat-tracksuits',
        variants: [{ id: 'old-0', color_name: 'BEŻOWY', size_name: 'S', sku: 'LOT114-BEZOWY-S', retail_price: 100 }],
      };

      const attachButton = () =>
        container.querySelector<HTMLButtonElement>('[data-testid="attach-product"]');

      async function fillMatchingSheet(categories = CATEGORIES) {
        styleByCode.mockImplementation((code: string) => (code === 'LOT114' ? EXISTING : null));
        styleById.mockImplementation((id: string) => (id === 'template-9' ? EXISTING : null));
        await render(categories);
        await fillGrid();
      }

      it('offers to attach to that style, by name, instead of saving a twin', async () => {
        await fillMatchingSheet();
        expect(fileButton()).toBeNull();
        expect(attachButton()?.textContent).toContain('KURTKA STARA');
        expect(attachButton()?.disabled).toBe(false);
      });

      it('needs no category of its own: the style already has one', async () => {
        await fillMatchingSheet([]);
        expect(attachButton()?.disabled).toBe(false);
      });

      it('adds only the missing colours and sizes to that style and makes the sheet its sheet', async () => {
        await fillMatchingSheet();
        createProduct.mockResolvedValue({
          ok: true,
          data: { variants: [{ id: 'new-1' }, { id: 'new-2' }, { id: 'new-3' }] },
        });
        await act(async () => attachButton()!.click());
        await settle();

        expect(createProduct).toHaveBeenCalledTimes(1);
        const payload = createProduct.mock.calls[0][0];
        expect(payload.productId).toBe('template-9');
        expect(payload.trackInventory).toBe(false);
        expect(payload.variants.map((v: any) => `${v.colorName} ${v.sizeName}`)).toEqual([
          'BEŻOWY M', 'CZARNY S', 'CZARNY M',
        ]);
        // The style keeps its category; the sheet takes it over. Its one old
        // row, filed at 1 zł, is brought to the sheet's price.
        expect(updateVariant.mock.calls).toEqual([['old-0', { priceGrossGrosze: 12900 }]]);
        expect(onProductFiled).toHaveBeenLastCalledWith({ categoryId: 'cat-tracksuits' });
        expect(categorySelect().value).toBe('cat-tracksuits');
        expect(attachButton()).toBeNull();
        expect(container.querySelector('[data-testid="update-product"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="filed-hint"]')?.textContent).toContain('KURTKA STARA');
        expect(fileResult()).toContain('3 new');
        expect(saveFabricTagTemplate).toHaveBeenCalledTimes(1);
      });

      it('stays a fresh sheet when the server refuses the rows', async () => {
        await fillMatchingSheet();
        createProduct.mockResolvedValue({ ok: false, error: 'boom' });
        await act(async () => attachButton()!.click());
        await settle();

        expect(attachButton()).not.toBeNull();
        expect(container.querySelector('[data-testid="update-product"]')).toBeNull();
        expect(fileResult()).toContain('boom');
      });

      it('goes back to Save as product once the code no longer matches', async () => {
        await fillMatchingSheet();
        await changeInput(input(container, 'input[placeholder="114"]'), 'LOT115');
        expect(attachButton()).toBeNull();
        expect(fileButton()).not.toBeNull();
      });
    });

    it('lets a duplicate become a new product, keeping the photo', async () => {
      await render();
      await fillGrid();
      await pickPhoto();
      await act(async () => fileButton().click());
      await settle();
      await act(async () => buttonWithText(container, 'Save order').click());
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="duplicate-order"]')!.click();
      });

      expect(container.querySelector('[data-testid="update-product"]')).toBeNull();
      expect(fileButton().disabled).toBe(false);
      expect(container.querySelector('[data-testid="order-image-preview"]')).not.toBeNull();
      await act(async () => fileButton().click());
      await settle();
      expect(createProduct).toHaveBeenCalledTimes(2);
      expect(createProduct.mock.calls[1][0].idempotencyKey).not.toBe(
        createProduct.mock.calls[0][0].idempotencyKey,
      );
    });
  });
});
