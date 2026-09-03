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
  let saveFabricTagTemplate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    container = document.createElement('div');
    document.body.appendChild(container);
    createProduct = vi.fn(async () => created(2));
    saveFabricTagTemplate = vi.fn(async (template: any) => template);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        printPackagingSticker: vi.fn(async () => ({ success: true })),
        printFabricTag: vi.fn(async () => ({ success: true })),
        pos: {
          productAdmin: { createProduct },
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

  async function render(categories: { id: string; name: string }[] = []) {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <PrintOrderPanel
          language="en"
          active
          onPrintingChange={() => {}}
          categories={categories}
        />,
      );
    });
    await settle();
  }

  const fileButton = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="file-product"]')!;

  const fileResult = () =>
    container.querySelector('[data-testid="file-result"]')?.textContent?.trim() ?? '';

  /** Two colours across two sizes, with one cell deliberately left empty. */
  async function fillGrid() {
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'KURTKA');
    await changeInput(input(container, 'input[placeholder="114"]'), 'LOT114');
    await act(async () => buttonWithText(container, '+ S').click());
    await act(async () => buttonWithText(container, '+ M').click());
    await act(async () => buttonWithText(container, 'Add colour').click());
    await changeInput(input(container, 'input[placeholder="CZEKOLADA"]'), 'BEŻOWY');
    await changeInput(input(container, 'input[aria-label="BEŻOWY S"]'), '4');
    await changeInput(input(container, 'input[aria-label="BEŻOWY M"]'), '6');
    await act(async () => buttonWithText(container, 'Add colour').click());
    const colourInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[placeholder="CZEKOLADA"]'),
    );
    await changeInput(colourInputs[1], 'CZARNY');
    await changeInput(input(container, 'input[aria-label="CZARNY S"]'), '3');
    // "CZARNY M" stays empty on purpose.
  }

  it('stays disabled until the sheet has a name and a quantity', async () => {
    await render();
    expect(fileButton().disabled).toBe(true);

    await fillGrid();
    expect(fileButton().disabled).toBe(false);
  });

  it('sends one variant per filled cell and nothing for the empty one', async () => {
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(createProduct).toHaveBeenCalledTimes(1);
    const payload = createProduct.mock.calls[0][0];
    expect(payload.name).toBe('KURTKA');
    expect(payload.variants).toEqual([
      {
        colorName: 'BEŻOWY',
        sizeName: 'S',
        sku: 'LOT114-BEZOWY-S',
        barcode: 'LOT114-BEZOWY-S',
        initialStockQty: 4,
      },
      {
        colorName: 'BEŻOWY',
        sizeName: 'M',
        sku: 'LOT114-BEZOWY-M',
        barcode: 'LOT114-BEZOWY-M',
        initialStockQty: 6,
      },
      {
        colorName: 'CZARNY',
        sizeName: 'S',
        sku: 'LOT114-CZARNY-S',
        barcode: 'LOT114-CZARNY-S',
        initialStockQty: 3,
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

    expect(
      container.querySelector('[data-testid="order-category"]')?.textContent,
    ).toBe('Kurtki');
  });

  it('warns instead of guessing when no category carries the style name', async () => {
    await render([{ id: 'cat-other', name: 'Spodnie' }]);
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    expect(
      container.querySelector('[data-testid="order-category"]')?.textContent,
    ).toContain('No category matches');
    expect(createProduct.mock.calls[0][0].categoryId).toBeNull();
  });

  it('files a sheet with no price, because the sheet no longer asks for one', async () => {
    await render();
    await fillGrid();
    await act(async () => fileButton().click());
    await settle();

    // The workshop sews to order and does not sell these over a counter. The
    // field is gone from the sheet; the product still needs a number, and 0 is
    // the honest one rather than something inferred.
    expect(container.querySelector('[data-testid="order-price"]')).toBeNull();
    expect(createProduct.mock.calls[0][0].priceGrossGrosze).toBe(0);
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

    expect(fileButton().disabled).toBe(true);
    await act(async () => fileButton().click());
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
});
