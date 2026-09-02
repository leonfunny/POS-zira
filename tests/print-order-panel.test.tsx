// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PrintOrderPanel from '../src/renderer/components/label/PrintOrderPanel';
import { CARE_SYMBOLS } from '../src/shared/types';

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

describe('PrintOrderPanel', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let printSticker: ReturnType<typeof vi.fn>;
  let printFabricTag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    container = document.createElement('div');
    document.body.appendChild(container);
    printSticker = vi.fn(async () => ({ success: true }));
    printFabricTag = vi.fn(async () => ({ success: true }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { printPackagingSticker: printSticker, printFabricTag },
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
      root.render(<PrintOrderPanel language="en" active onPrintingChange={() => {}} />);
    });
    await settle();
  }

  /** Header, one size column, one colour row, one quantity. */
  async function fillMinimalOrder(quantity = 40) {
    await changeInput(input(container, 'input[placeholder="MoonCollection"]'), 'MoonCollection');
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'KURTKA');
    await changeInput(input(container, 'input[placeholder="114"]'), '114');
    await act(async () => buttonWithText(container, '+ S').click());
    await act(async () => buttonWithText(container, 'Add colour').click());
    await changeInput(input(container, 'input[placeholder="CZEKOLADA"]'), 'CZEKOLADA');
    await changeInput(input(container, 'input[placeholder="SP006290"]'), 'SP006290');
    await changeInput(input(container, 'input[aria-label="CZEKOLADA S"]'), String(quantity));
  }

  function text(selector: string): string {
    return container.querySelector(selector)?.textContent?.trim() ?? '';
  }

  const chip = (preset: string) =>
    container.querySelector<HTMLButtonElement>(`button[data-care-text-preset="${preset}"]`)!;

  const careLineInput = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Extra lines"]')!;

  /** The extra lines as the tag will print them, read off the screen. */
  const careLines = () =>
    Array.from(container.querySelectorAll('[data-care-line]')).map(
      (li) => li.querySelector('span:nth-of-type(2)')?.textContent?.trim() ?? '',
    );

  it('adds a size column from a suggestion and from free text', async () => {
    await render();
    await act(async () => buttonWithText(container, '+ 2XL').click());

    const adder = input(container, 'input[aria-label="Add size"]');
    await changeInput(adder, '44/46');
    await act(async () => {
      adder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers.some((h) => h?.includes('2XL'))).toBe(true);
    expect(headers.some((h) => h?.includes('44/46'))).toBe(true);
  });

  it('remembers a size somebody typed and offers it as a button next time', async () => {
    await render();
    const adder = input(container, 'input[aria-label="Add size"]');
    await changeInput(adder, '3xl');
    await act(async () => {
      adder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // It became a column now, and a button for next time.
    expect(container.querySelector('[data-learned-size="3XL"]')).not.toBeNull();

    // Still there on the next order, and on the next start of the app.
    await act(async () => buttonWithText(container, 'New order').click());
    expect(container.querySelector('[data-learned-size="3XL"]')).not.toBeNull();

    const first = root!;
    await act(async () => first.unmount());
    root = null;
    await render();
    expect(container.querySelector('[data-learned-size="3XL"]')).not.toBeNull();
  });

  it('adds a column from a remembered button without teaching it twice', async () => {
    await render();
    const adder = input(container, 'input[aria-label="Add size"]');
    await changeInput(adder, '3XL');
    await act(async () => {
      adder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-learned-size="3XL"] [data-size-suggestion="3XL"]')!.click());

    expect(container.querySelectorAll('[data-learned-size="3XL"]')).toHaveLength(1);
  });

  it('does not learn a size that is already a button', async () => {
    await render();
    const adder = input(container, 'input[aria-label="Add size"]');
    await changeInput(adder, 'xl');
    await act(async () => {
      adder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(container.querySelector('[data-learned-size]')).toBeNull();
  });

  it('forgets a size typed by mistake', async () => {
    await render();
    const adder = input(container, 'input[aria-label="Add size"]');
    await changeInput(adder, '3xxl');
    await act(async () => {
      adder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(container.querySelector('[data-learned-size="3XXL"]')).not.toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[aria-label="Forget size 3XXL"]')!.click());

    expect(container.querySelector('[data-learned-size="3XXL"]')).toBeNull();
    // Forgetting the button does not pull the column out of the order.
    expect(Array.from(container.querySelectorAll('th')).some((th) => th.textContent?.includes('3XXL')))
      .toBe(true);
  });

  it('totals the grid as quantities are typed', async () => {
    await render();
    await fillMinimalOrder(40);
    expect(text('[data-testid="grand-total"]')).toBe('40');
  });

  it('builds the composition line from material chips and percentages', async () => {
    await render();
    await act(async () => buttonWithText(container, 'POLIESTER').click());
    await changeInput(input(container, 'input[aria-label="POLIESTER %"]'), '70');
    await act(async () => buttonWithText(container, 'AKRYL').click());
    await changeInput(input(container, 'input[aria-label="AKRYL %"]'), '30');

    expect(text('[data-testid="composition-preview"]')).toBe('70% POLIESTER 30% AKRYL');
  });

  it('warns when the percentages do not add up, without blocking the print', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'LEN').click());
    await changeInput(input(container, 'input[aria-label="LEN %"]'), '70');

    expect(container.textContent).toContain('add up to 70%');
    expect(buttonWithText(container, 'Print').disabled).toBe(false);
  });

  it('blocks printing while the order has nothing in it', async () => {
    await render();
    expect(buttonWithText(container, 'Print').disabled).toBe(true);
    expect(text('[data-testid="order-problems"]')).toContain('No quantities entered');
  });

  it('refuses to add the same size column twice', async () => {
    await render();
    await act(async () => buttonWithText(container, '+ M').click());
    await act(async () => buttonWithText(container, '+ M').click());

    const headers = Array.from(container.querySelectorAll('thead th')).filter((th) =>
      th.textContent?.includes('M'),
    );
    expect(headers).toHaveLength(1);
  });

  it('warns on a colour with no sticker code but still allows the run', async () => {
    await render();
    await fillMinimalOrder(40);
    await changeInput(input(container, 'input[placeholder="SP006290"]'), '');

    expect(container.textContent).toContain('fabric tags only');
    expect(buttonWithText(container, 'Print').disabled).toBe(false);
  });

  it('prints the stickers and the fabric tags in one run, asking nothing', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    expect(printSticker).toHaveBeenCalledTimes(1);
    expect(printSticker.mock.calls[0][0]).toMatchObject({
      customerName: 'MOONCOLLECTION',
      styleName: 'KURTKA',
      styleCode: '114',
      colorName: 'CZEKOLADA',
      code: 'SP006290',
      quantity: 40,
    });
    // No Continue button, and the fabric lane ran without one being pressed.
    expect(printFabricTag).toHaveBeenCalledTimes(1);
    expect(printFabricTag.mock.calls[0][0]).toMatchObject({ size: 'S', quantity: 40 });
    expect(text('[data-testid="print-result"]')).toContain('Printed 80 labels');
    expect(
      Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim()),
    ).not.toContain('Continue');
  });

  it('reports the printer error and does not go on to the fabric lane', async () => {
    printSticker.mockResolvedValue({ success: false, error: 'Label printer not connected' });
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    expect(text('[data-testid="print-result"]')).toBe('Label printer not connected');
    expect(printFabricTag).not.toHaveBeenCalled();
  });

  it('stops the run when the operator presses Stop mid-print', async () => {
    // Hold the sticker lane open so Stop is pressed while a batch is in flight,
    // which is the only moment the button is on screen.
    let releaseSticker: (value: { success: boolean }) => void = () => {};
    printSticker.mockImplementation(
      () => new Promise((resolve) => { releaseSticker = resolve; }),
    );

    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    const stop = container.querySelector<HTMLButtonElement>('[data-testid="stop-print"]');
    expect(stop).not.toBeNull();
    await act(async () => stop!.click());
    await act(async () => { releaseSticker({ success: true }); });
    await settle();

    expect(text('[data-testid="print-result"]')).toContain('Stopped after');
    expect(printFabricTag).not.toHaveBeenCalled();
  });

  it('says out loud that Stop only bites after the batch already sent', async () => {
    let releaseSticker: (value: { success: boolean }) => void = () => {};
    printSticker.mockImplementation(
      () => new Promise((resolve) => { releaseSticker = resolve; }),
    );

    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    expect(text('[data-testid="stop-hint"]')).toContain('after the batch already sent');

    await act(async () => { releaseSticker({ success: true }); });
    await settle();
    expect(container.querySelector('[data-testid="stop-hint"]')).toBeNull();
  });

  it('keeps the order after a restart, so the sheet is not retyped', async () => {
    await render();
    await fillMinimalOrder(40);

    const first = root!;
    await act(async () => first.unmount());
    root = null;
    await render();

    expect(input(container, 'input[placeholder="MoonCollection"]').value).toBe('MOONCOLLECTION');
    expect(text('[data-testid="grand-total"]')).toBe('40');
  });

  it('saves an order and reopens it', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Save order').click());

    expect(container.textContent).toContain('MOONCOLLECTION · KURTKA 114');

    await act(async () => buttonWithText(container, 'New order').click());
    expect(text('[data-testid="grand-total"]')).toBe('0');

    await act(async () => buttonWithText(container, 'Open').click());
    expect(text('[data-testid="grand-total"]')).toBe('40');
  });

  it('saves an edit back into the order it was opened from', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Save order').click());

    await changeInput(input(container, 'input[aria-label="CZEKOLADA S"]'), '55');
    await act(async () => buttonWithText(container, 'Save order').click());

    expect(container.querySelectorAll('[data-saved-order]')).toHaveLength(1);
    await act(async () => buttonWithText(container, 'New order').click());
    await act(async () => buttonWithText(container, 'Open').click());
    expect(text('[data-testid="grand-total"]')).toBe('55');
  });

  it('stops claiming "Saved" as soon as the sheet is edited again', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Save order').click());
    expect(() => buttonWithText(container, 'Saved')).not.toThrow();

    await changeInput(input(container, 'input[aria-label="CZEKOLADA S"]'), '55');
    expect(() => buttonWithText(container, 'Save order')).not.toThrow();
  });

  it('still saves back into the same order after the app is restarted', async () => {
    // The bug staff hit: an order edited the next morning was filed as a twin
    // with an identical name, because the panel forgot which order it held.
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Save order').click());

    const first = root!;
    await act(async () => first.unmount());
    root = null;
    await render();

    await changeInput(input(container, 'input[aria-label="CZEKOLADA S"]'), '55');
    await act(async () => buttonWithText(container, 'Save order').click());

    expect(container.querySelectorAll('[data-saved-order]')).toHaveLength(1);
  });

  it('marks which saved order is the one on screen', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Save order').click());
    expect(container.querySelector('[data-saved-order][data-open="true"]')).not.toBeNull();

    await act(async () => buttonWithText(container, 'New order').click());
    expect(container.querySelector('[data-saved-order][data-open="true"]')).toBeNull();
  });

  it('scrolls back to the top when a sheet is swapped underneath the reader', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Save order').click());

    // The Open and New buttons sit at the bottom of a long scrolling panel.
    const panel = container.querySelector<HTMLDivElement>('[data-testid="print-order-panel"]')!;
    const scrollTo = vi.fn();
    panel.scrollTo = scrollTo as unknown as HTMLDivElement['scrollTo'];

    await act(async () => buttonWithText(container, 'New order').click());
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });

    scrollTo.mockClear();
    await act(async () => buttonWithText(container, 'Open').click());
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it('refuses to print when the bridge is missing instead of throwing', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { printFabricTag },
    });
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    expect(text('[data-testid="print-result"]')).toContain('bridge unavailable');
    expect(printFabricTag).not.toHaveBeenCalled();
  });

  it('shows the printed symbol art, not the enum name', async () => {
    await render();
    const washButton = container.querySelector<HTMLButtonElement>('button[data-symbol="WASH_30"]');
    expect(washButton).not.toBeNull();
    expect(washButton?.querySelector('svg')).not.toBeNull();
    // The art carries "30" inside the washtub; what it must not show is the
    // machine name an operator cannot read. The name a screen reader and the
    // hover tooltip get is the instruction itself, in the operator's language.
    expect(washButton?.textContent).not.toContain('WASH');
    expect(container.textContent).not.toContain('DRYCLEAN_P');
    expect(washButton?.getAttribute('aria-label')).toBe('Wash at 30°C');
    expect(washButton?.getAttribute('title')).toBe('Wash at 30°C');
  });

  it('treats the wash family as a radio group — a tag cannot say both', async () => {
    await render();
    const wash30 = container.querySelector<HTMLButtonElement>('button[data-symbol="WASH_30"]')!;
    const washNo = container.querySelector<HTMLButtonElement>('button[data-symbol="WASH_NO"]')!;

    await act(async () => wash30.click());
    expect(wash30.getAttribute('aria-pressed')).toBe('true');

    await act(async () => washNo.click());
    expect(container.querySelector('button[data-symbol="WASH_30"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('button[data-symbol="WASH_NO"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps symbols from different families together', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-symbol="WASH_30"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-symbol="IRON_LOW"]')!.click());

    expect(container.querySelector('button[data-symbol="WASH_30"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('button[data-symbol="IRON_LOW"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('[data-testid="care-preview"] svg')).toHaveLength(2);
  });

  it('offers the whole ISO set, sorted into named families', async () => {
    await render();
    const buttons = container.querySelectorAll('button[data-symbol]');
    expect(buttons).toHaveLength(CARE_SYMBOLS.length);
    // Named families, because 44 unlabelled pictograms in one block is not
    // something a non-technical operator can work through.
    for (const heading of ['Washing', 'Bleaching', 'Tumble drying', 'Natural drying',
      'Ironing', 'Dry cleaning', 'Wet cleaning']) {
      expect(container.textContent).toContain(heading);
    }
  });

  it('lets one tag say "no tumble dryer" and "dry flat" at the same time', async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-symbol="TUMBLE_NO"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-symbol="DRY_FLAT"]')!.click());

    expect(container.querySelector('button[data-symbol="TUMBLE_NO"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('button[data-symbol="DRY_FLAT"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('gives every chip its own numbered line, and takes them off again', async () => {
    await render();

    await act(async () => chip('NATURALNY LEN').click());
    expect(careLines()).toEqual(['NATURALNY LEN']);
    await act(async () => chip('MADE IN POLAND').click());
    // Two lines on screen, in the order they will print — not one joined line.
    expect(careLines()).toEqual(['NATURALNY LEN', 'MADE IN POLAND']);
    expect(container.textContent).toContain('Line 2');
    expect(chip('MADE IN POLAND').getAttribute('aria-pressed')).toBe('true');

    await act(async () => chip('NATURALNY LEN').click());
    expect(careLines()).toEqual(['MADE IN POLAND']);
    expect(chip('NATURALNY LEN').getAttribute('aria-pressed')).toBe('false');
  });

  it('adds what the operator types as a line of its own', async () => {
    await render();
    await act(async () => chip('NATURALNY LEN').click());

    await changeInput(careLineInput(), 'szyte w krakowie');
    // Typed in lower case, shown back in capitals.
    expect(careLineInput().value).toBe('SZYTE W KRAKOWIE');
    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-testid="add-care-line"]')!.click());

    expect(careLines()).toEqual(['NATURALNY LEN', 'SZYTE W KRAKOWIE']);
    // The box empties, ready for the next line.
    expect(careLineInput().value).toBe('');
  });

  it('takes one line away without touching the others', async () => {
    await render();
    await act(async () => chip('NATURALNY LEN').click());
    await act(async () => chip('MADE IN POLAND').click());

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-care-line="0"] button')!.click());

    expect(careLines()).toEqual(['MADE IN POLAND']);
  });

  it('greys out a chip that will not fit on the tag', async () => {
    await render();
    for (const preset of ['PRAĆ Z PODOBNYMI KOLORAMI', 'PRAĆ NA LEWEJ STRONIE',
      'PRAĆ PRZED PIERWSZYM UŻYCIEM', 'ZALECANY PŁYN DO PŁUKANIA DLA MIĘKKOŚCI']) {
      await act(async () => chip(preset).click());
    }
    // The printer refuses over-long wording, so the chip has to stop before
    // the run does.
    expect(chip('NATURALNY LEN').disabled).toBe(true);
    expect(chip('PRAĆ NA LEWEJ STRONIE').disabled).toBe(false);
    expect(text('[data-testid="care-lines-full"]')).toContain('No room left');
  });

  it('sends the chosen extra line to the fabric lane', async () => {
    await render();
    await fillMinimalOrder(10);
    await act(async () => container.querySelector<HTMLButtonElement>(
      'button[data-care-text-preset="NATURALNY LEN"]')!.click());
    await act(async () => {
      const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
      boxes[1].click();
    });
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    expect(printFabricTag.mock.calls[0][0]).toMatchObject({ careText: 'NATURALNY LEN' });
  });

  it('sends the extra lines to the fabric lane as separate lines', async () => {
    await render();
    await fillMinimalOrder(10);
    await act(async () => chip('NATURALNY LEN').click());
    await changeInput(careLineInput(), 'szyte w krakowie');
    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-testid="add-care-line"]')!.click());
    await act(async () => {
      const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
      boxes[1].click();
    });
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    expect(printFabricTag.mock.calls[0][0]).toMatchObject({
      careText: 'NATURALNY LEN\nSZYTE W KRAKOWIE',
    });
  });

  it('types every field in capitals, whatever the operator presses', async () => {
    await render();
    await changeInput(input(container, 'input[placeholder="MoonCollection"]'), 'moon collection');
    await act(async () => buttonWithText(container, '+ S').click());
    await act(async () => buttonWithText(container, 'Add colour').click());
    await changeInput(input(container, 'input[placeholder="CZEKOLADA"]'), 'czekolada');
    await changeInput(input(container, 'input[placeholder="SP006290"]'), 'sp006290');

    expect(input(container, 'input[placeholder="MoonCollection"]').value).toBe('MOON COLLECTION');
    expect(input(container, 'input[placeholder="CZEKOLADA"]').value).toBe('CZEKOLADA');
    expect(input(container, 'input[placeholder="SP006290"]').value).toBe('SP006290');
  });

  it('capitalises a free-text size column as it is added', async () => {
    await render();
    const adder = input(container, 'input[aria-label="Add size"]');
    await changeInput(adder, 'xs/s');
    await act(async () => {
      adder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(Array.from(container.querySelectorAll('th')).some((th) => th.textContent?.includes('XS/S')))
      .toBe(true);
  });

  it('deselects a symbol when it is clicked again', async () => {
    await render();
    const wash30 = () => container.querySelector<HTMLButtonElement>('button[data-symbol="WASH_30"]')!;
    await act(async () => wash30().click());
    await act(async () => wash30().click());
    expect(wash30().getAttribute('aria-pressed')).toBe('false');
  });

  it('sends the chosen symbols to the fabric lane', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-symbol="WASH_30"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button[data-symbol="IRON_LOW"]')!.click());
    await act(async () => {
      const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
      boxes[1].click(); // fabric tags only, so no tear pause before the first run
    });
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    expect(printFabricTag.mock.calls[0][0]).toMatchObject({
      careSymbols: ['WASH_30', 'IRON_LOW'],
    });
  });

  it('sends no sticker run when that box is unticked', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => {
      const boxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
      boxes[1].click();
    });
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    expect(printSticker).not.toHaveBeenCalled();
    expect(printFabricTag).toHaveBeenCalledTimes(1);
  });
});
