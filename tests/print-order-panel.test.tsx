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

  async function render(language = 'en') {
    await act(async () => {
      root = createRoot(container);
      root.render(<PrintOrderPanel language={language} active onPrintingChange={() => {}} />);
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
    await changeInput(input(container, 'input[aria-label="CZEKOLADA S"]'), String(quantity));
  }

  /** The two lane boxes, fabric tags first, as they sit on the sheet. */
  const laneBoxes = () =>
    Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));

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

  it.each([
    ['vi', 'vi-VN'],
    ['pl', 'pl-PL'],
    ['en', 'en-GB'],
  ])('shows the order calendar in the %s tab locale', async (language, locale) => {
    await render(language);

    expect(input(container, '[data-testid="order-date"]').getAttribute('lang')).toBe(locale);
  });

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

  it('fills the style name from the dropdown', async () => {
    await render();
    const picker = container.querySelector<HTMLSelectElement>('[data-testid="style-picker"]')!;
    expect(Array.from(picker.options).map((o) => o.value))
      .toEqual(['', 'KURTKA', 'BAWEŁNIANE', 'KOMPLET DRESOWY']);

    await act(async () => {
      picker.value = 'KOMPLET DRESOWY';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(input(container, 'input[placeholder="KURTKA"]').value).toBe('KOMPLET DRESOWY');
    // The picker springs back so it always reads as "pick one", never as state.
    expect(picker.value).toBe('');
  });

  it('remembers a style name typed by hand once the order is filed', async () => {
    await render();
    await fillMinimalOrder(40);
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'bluza z kapturem');

    const styles = () => Array.from(
      container.querySelectorAll<HTMLSelectElement>('[data-testid="style-picker"]')[0].options,
    ).map((o) => o.value);
    // Not while it is being typed — that would fill the list with "B", "BL".
    expect(styles()).not.toContain('BLUZA Z KAPTUREM');

    await act(async () => buttonWithText(container, 'Save order').click());
    expect(styles()).toContain('BLUZA Z KAPTUREM');
  });

  it('remembers a style name when the order goes to the printer', async () => {
    await render();
    await fillMinimalOrder(40);
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'bluza');
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    const picker = container.querySelector<HTMLSelectElement>('[data-testid="style-picker"]')!;
    expect(Array.from(picker.options).map((o) => o.value)).toContain('BLUZA');
  });

  it('offers a way to forget a style name typed by mistake', async () => {
    await render();
    await fillMinimalOrder(40);
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'kurtak');
    await act(async () => buttonWithText(container, 'Save order').click());

    const forget = () => container.querySelector<HTMLButtonElement>('[data-testid="forget-style"]');
    expect(forget()).not.toBeNull();
    await act(async () => forget()!.click());

    expect(forget()).toBeNull();
    const picker = container.querySelector<HTMLSelectElement>('[data-testid="style-picker"]')!;
    expect(Array.from(picker.options).map((o) => o.value)).not.toContain('KURTAK');
    // The name stays in the order — the operator was tidying the list, not the sheet.
    expect(input(container, 'input[placeholder="KURTKA"]').value).toBe('KURTAK');
  });

  it('shows no forget button for a name that shipped with the app', async () => {
    await render();
    await changeInput(input(container, 'input[placeholder="KURTKA"]'), 'KURTKA');
    expect(container.querySelector('[data-testid="forget-style"]')).toBeNull();
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

  it('blocks the print until the composition adds up to 100', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'LEN').click());
    await changeInput(input(container, 'input[aria-label="LEN %"]'), '70');

    expect(container.textContent).toContain('add up to 70%');
    expect(buttonWithText(container, 'Print').disabled).toBe(true);
    expect(text('[data-testid="order-problems"]')).toContain('add up to 100%');
    // A sample of a tag that would print a wrong composition is no use either.
    expect(container.querySelector<HTMLButtonElement>('[data-testid="print-sample"]')!.disabled)
      .toBe(true);
  });

  it('lands the composition on 100 in one press', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'LEN').click());
    await changeInput(input(container, 'input[aria-label="LEN %"]'), '70');
    await act(async () => buttonWithText(container, 'AKRYL').click());

    // The material just tapped is still at 0, so the press fills that one.
    const fix = container.querySelector<HTMLButtonElement>('[data-testid="fix-percent"]')!;
    expect(fix.textContent).toContain('Set AKRYL to 30%');

    await act(async () => fix.click());
    expect(text('[data-testid="composition-preview"]')).toBe('70% LEN 30% AKRYL');
    expect(buttonWithText(container, 'Print').disabled).toBe(false);
    expect(container.querySelector('[data-testid="fix-percent"]')).toBeNull();
  });

  it('takes the surplus back off when the total went over 100', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'LEN').click());
    await changeInput(input(container, 'input[aria-label="LEN %"]'), '80');
    await act(async () => buttonWithText(container, 'AKRYL').click());
    await changeInput(input(container, 'input[aria-label="AKRYL %"]'), '40');

    expect(container.textContent).toContain('add up to 120%');
    expect(buttonWithText(container, 'Print').disabled).toBe(true);

    const fix = container.querySelector<HTMLButtonElement>('[data-testid="fix-percent"]')!;
    expect(fix.textContent).toContain('Set AKRYL to 20%');
    await act(async () => fix.click());
    expect(text('[data-testid="composition-preview"]')).toBe('80% LEN 20% AKRYL');
    expect(buttonWithText(container, 'Print').disabled).toBe(false);
  });

  it('offers no one-press fix when one press cannot reach 100', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'LEN').click());
    await changeInput(input(container, 'input[aria-label="LEN %"]'), '90');
    await act(async () => buttonWithText(container, 'AKRYL').click());
    await changeInput(input(container, 'input[aria-label="AKRYL %"]'), '30');
    await act(async () => buttonWithText(container, 'ELASTAN').click());
    await changeInput(input(container, 'input[aria-label="ELASTAN %"]'), '10');

    // 130%: taking 30 off the last material would put it below zero, and
    // guessing a split across three materials is not the panel's business.
    expect(container.textContent).toContain('add up to 130%');
    expect(container.querySelector('[data-testid="fix-percent"]')).toBeNull();
    expect(buttonWithText(container, 'Print').disabled).toBe(true);
  });

  it('prints an order with no composition at all', async () => {
    // A tag with only a size and wash symbols is legal, and customers order it.
    await render();
    await fillMinimalOrder(40);
    expect(container.querySelector('[data-testid="fix-percent"]')).toBeNull();
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

  it('gives each colour row a sticker code nobody has to type', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Add colour').click());
    const colours = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[placeholder="CZEKOLADA"]'),
    );
    await changeInput(colours[1], 'BORDO');
    await changeInput(input(container, 'input[aria-label="BORDO S"]'), '5');

    // No code column on the sheet any more — the sticker does not print it.
    expect(container.querySelector('input[placeholder="SP006290"]')).toBeNull();
    expect(buttonWithText(container, 'Print').disabled).toBe(false);
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();
    expect(printSticker).toHaveBeenCalledTimes(2);
    const codes = printSticker.mock.calls.map((call) => call[0].code);
    expect(codes.every((code) => /^SP\d{6}$/.test(code))).toBe(true);
    expect(new Set(codes).size).toBe(2);
  });

  it('refuses to print without a customer name, and says so', async () => {
    await render();
    await fillMinimalOrder(40);
    await changeInput(input(container, 'input[placeholder="MoonCollection"]'), '  ');

    expect(buttonWithText(container, 'Print').disabled).toBe(true);
    expect(text('[data-testid="order-problems"]')).toContain('No customer name');
  });

  it('needs a style code for the bag sticker but not for a fabric-tag-only run', async () => {
    await render();
    await fillMinimalOrder(40);
    await changeInput(input(container, 'input[placeholder="114"]'), '');

    expect(buttonWithText(container, 'Print').disabled).toBe(true);
    expect(text('[data-testid="order-problems"]')).toContain('No style code');

    await act(async () => laneBoxes()[1].click());
    expect(container.querySelector('[data-testid="order-problems"]')).toBeNull();
    expect(buttonWithText(container, 'Print').disabled).toBe(false);
  });

  it('points out a fabric tag with no composition without blocking the run', async () => {
    await render();
    await fillMinimalOrder(40);

    expect(text('[data-testid="order-warnings"]')).toContain('no composition');
    expect(buttonWithText(container, 'Print').disabled).toBe(false);

    await act(async () => laneBoxes()[0].click());
    expect(container.querySelector('[data-testid="order-warnings"]')).toBeNull();
  });

  it('folds the fabric block away when no fabric tag is being printed', async () => {
    await render();
    await fillMinimalOrder(40);
    expect(container.querySelector('[data-testid="add-care-line"]')).not.toBeNull();

    await act(async () => laneBoxes()[0].click());
    expect(container.querySelector('[data-testid="add-care-line"]')).toBeNull();
    // Nothing is forgotten by folding: the lane back on shows the same block.
    await act(async () => laneBoxes()[0].click());
    expect(container.querySelector('[data-testid="add-care-line"]')).not.toBeNull();
  });

  it('dates a fresh sheet today', async () => {
    await render();
    const today = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    expect(input(container, '[data-testid="order-date"]').value).toBe(
      `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
    );
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
      // Nobody typed a code: the row got one when it was added.
      code: expect.stringMatching(/^SP\d{6}$/),
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

  it('duplicates a filed order into a second one, leaving the first alone', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Save order').click());

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-testid="duplicate-order"]')!.click());
    await changeInput(input(container, 'input[aria-label="CZEKOLADA S"]'), '55');
    await act(async () => buttonWithText(container, 'Save order').click());

    expect(container.querySelectorAll('[data-saved-order]')).toHaveLength(2);

    // The first row is still the order as it was filed, not the edited copy.
    const opens = Array.from(container.querySelectorAll('button'))
      .filter((b) => b.textContent?.trim() === 'Open');
    await act(async () => opens[opens.length - 1].click());
    expect(text('[data-testid="grand-total"]')).toBe('40');
  });

  it('files nothing until Save, so a duplicate never lands as a twin', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Save order').click());

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-testid="duplicate-order"]')!.click());

    expect(container.querySelectorAll('[data-saved-order]')).toHaveLength(1);
    // Nothing on screen belongs to a filed order any more, and the Save button
    // stops claiming the sheet is already stored.
    expect(container.querySelector('[data-saved-order][data-open="true"]')).toBeNull();
    expect(() => buttonWithText(container, 'Save order')).not.toThrow();
  });

  it('carries the sheet across untouched', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Save order').click());

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-testid="duplicate-order"]')!.click());

    expect(text('[data-testid="grand-total"]')).toBe('40');
    expect(input(container, 'input[placeholder="CZEKOLADA"]').value).toBe('CZEKOLADA');
  });

  it('offers no duplicate for a sheet that was never filed', async () => {
    await render();
    await fillMinimalOrder(40);
    expect(container.querySelector('[data-testid="duplicate-order"]')).toBeNull();

    await act(async () => buttonWithText(container, 'Save order').click());
    expect(container.querySelector('[data-testid="duplicate-order"]')).not.toBeNull();

    await act(async () => buttonWithText(container, 'New order').click());
    expect(container.querySelector('[data-testid="duplicate-order"]')).toBeNull();
  });

  it('refuses to duplicate out from under a run that is going out', async () => {
    let releaseSticker: (value: { success: boolean }) => void = () => {};
    printSticker.mockImplementation(
      () => new Promise((resolve) => { releaseSticker = resolve; }),
    );

    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Save order').click());
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    expect(container.querySelector<HTMLButtonElement>('[data-testid="duplicate-order"]')!.disabled)
      .toBe(true);

    await act(async () => { releaseSticker({ success: true }); });
    await settle();
  });

  describe('after a jam, the operator decides — the panel never carries on by itself', () => {
    /** Prints the sticker lane, then stops before the fabric lane. */
    async function stopAfterTheStickers() {
      let releaseSticker: (value: { success: boolean }) => void = () => {};
      printSticker.mockImplementation(
        () => new Promise((resolve) => { releaseSticker = resolve; }),
      );

      await render();
      await fillMinimalOrder(40);
      await act(async () => buttonWithText(container, 'Print').click());
      await settle();
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="stop-print"]')!.click());
      await act(async () => { releaseSticker({ success: true }); });
      await settle();

      printSticker.mockReset();
      printSticker.mockResolvedValue({ success: true });
    }

    it('says how much went out, in batches and in labels', async () => {
      await stopAfterTheStickers();

      expect(text('[data-testid="resume-sent"]')).toBe(
        'Last time 1/2 batches went out (40/80 labels).',
      );
      expect(container.textContent).toContain('Count the labels, then choose');
    });

    it('carries on from the batch after the last one sent', async () => {
      await stopAfterTheStickers();

      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="resume-continue"]')!.click());
      await settle();

      // The stickers already went out; only the fabric lane runs again.
      expect(printSticker).not.toHaveBeenCalled();
      expect(printFabricTag).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('prints the lot again when the operator counted and found nothing', async () => {
      await stopAfterTheStickers();

      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="resume-restart"]')!.click());
      await settle();

      expect(printSticker).toHaveBeenCalledTimes(1);
      expect(printFabricTag).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('throws the progress away without printing anything', async () => {
      await stopAfterTheStickers();

      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="resume-forget"]')!.click());
      await settle();

      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
      expect(printSticker).not.toHaveBeenCalled();
      expect(printFabricTag).not.toHaveBeenCalled();

      // Gone for good, not just hidden until the next restart.
      const first = root!;
      await act(async () => first.unmount());
      root = null;
      await render();
      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('is still there after the app is closed and reopened', async () => {
      await stopAfterTheStickers();

      const first = root!;
      await act(async () => first.unmount());
      root = null;
      await render();

      expect(text('[data-testid="resume-sent"]')).toContain('1/2 batches');
    });

    it('does not offer to resume a run that finished', async () => {
      await render();
      await fillMinimalOrder(40);
      await act(async () => buttonWithText(container, 'Print').click());
      await settle();

      expect(text('[data-testid="print-result"]')).toContain('Printed');
      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();

      const first = root!;
      await act(async () => first.unmount());
      root = null;
      await render();
      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('goes away with the sheet when a new order is started', async () => {
      await stopAfterTheStickers();
      await act(async () => buttonWithText(container, 'New order').click());

      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('belongs to one order, not to whatever is on screen', async () => {
      await stopAfterTheStickers();
      await act(async () => buttonWithText(container, 'Save order').click());
      await act(async () => buttonWithText(container, 'New order').click());
      await fillMinimalOrder(10);

      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('keeps the earlier batches when a resumed run stops again', async () => {
      await stopAfterTheStickers();
      printFabricTag.mockResolvedValue({ success: false, error: 'Out of ribbon' });

      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="resume-continue"]')!.click());
      await settle();

      // The stickers are still counted as sent; the record is not rewritten to
      // hold only what this second attempt managed.
      expect(text('[data-testid="resume-sent"]')).toContain('1/2 batches');
    });

    it('is thrown away when the sheet is put aside for a new one', async () => {
      await stopAfterTheStickers();
      await act(async () => buttonWithText(container, 'Save order').click());
      await act(async () => buttonWithText(container, 'New order').click());
      await act(async () => buttonWithText(container, 'Open').click());

      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('does not follow a duplicate, which has printed nothing', async () => {
      await stopAfterTheStickers();
      await act(async () => buttonWithText(container, 'Save order').click());
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="duplicate-order"]')!.click());

      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('says nothing when the sheet no longer holds what was sent', async () => {
      await stopAfterTheStickers();
      await act(async () => container.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete CZEKOLADA"]')!.click());

      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('offers no "carry on" when nothing is left to send', async () => {
      await stopAfterTheStickers();
      // Untick the fabric tags and the plan is the sticker batch alone, which
      // already went out: there is nothing to carry on to.
      await act(async () => {
        const boxes = Array.from(
          container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
        );
        boxes[0].click();
      });

      expect(container.querySelector('[data-testid="resume-block"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="resume-continue"]')).toBeNull();
      expect(container.querySelector('[data-testid="resume-restart"]')).not.toBeNull();
    });

    it('is written after each batch, not only when the run ends', async () => {
      // The case this exists for: the operator walks away from a jam and closes
      // the app. The run never reaches its end, so the end cannot be the only
      // place progress is written.
      printFabricTag.mockImplementation(() => new Promise(() => {}));

      await render();
      await fillMinimalOrder(40);
      await act(async () => buttonWithText(container, 'Print').click());
      await settle();

      const first = root!;
      await act(async () => first.unmount());
      root = null;
      await render();

      expect(text('[data-testid="resume-sent"]')).toContain('1/2 batches');
    });

    it('adds to the record when a resumed run stops part way as well', async () => {
      await render();
      await fillMinimalOrder(40);
      await act(async () => buttonWithText(container, '+ M').click());
      // 40 + 5 copies is one sticker batch, so the plan is three batches:
      // the stickers, then one fabric batch per size.
      await changeInput(input(container, 'input[aria-label="CZEKOLADA M"]'), '5');

      // First run: stop with the stickers out and both fabric batches to go.
      let releaseSticker: (value: { success: boolean }) => void = () => {};
      printSticker.mockImplementation(
        () => new Promise((resolve) => { releaseSticker = resolve; }),
      );
      await act(async () => buttonWithText(container, 'Print').click());
      await settle();
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="stop-print"]')!.click());
      await act(async () => { releaseSticker({ success: true }); });
      await settle();
      expect(text('[data-testid="resume-sent"]')).toContain('1/3 batches');

      // Second run: one fabric batch goes out, then Stop again.
      let releaseFabric: (value: { success: boolean }) => void = () => {};
      printFabricTag.mockImplementation(
        () => new Promise((resolve) => { releaseFabric = resolve; }),
      );
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="resume-continue"]')!.click());
      await settle();
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="stop-print"]')!.click());
      await act(async () => { releaseFabric({ success: true }); });
      await settle();

      // Both runs count: the stickers plus the one fabric batch.
      expect(text('[data-testid="resume-sent"]')).toContain('2/3 batches');
    });

    it('counts against the sheet, not the length of the record', async () => {
      await render();
      await fillMinimalOrder(40);
      await act(async () => buttonWithText(container, '+ M').click());
      // 40 + 5 copies is one sticker batch, so the plan is three batches:
      // the stickers, then one fabric batch per size.
      await changeInput(input(container, 'input[aria-label="CZEKOLADA M"]'), '5');

      let releaseFabric: (value: { success: boolean }) => void = () => {};
      printFabricTag.mockImplementation(
        () => new Promise((resolve) => { releaseFabric = resolve; }),
      );
      await act(async () => buttonWithText(container, 'Print').click());
      await settle();
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="stop-print"]')!.click());
      await act(async () => { releaseFabric({ success: true }); });
      await settle();
      expect(text('[data-testid="resume-sent"]')).toContain('2/3 batches');

      // Drop the size whose batch went out. Two batches were sent, but only one
      // of them is still on the sheet, and that is what the operator is holding.
      await act(async () => container.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete S"]')!.click());
      expect(text('[data-testid="resume-sent"]')).toContain('1/2 batches');
    });

    it('belongs to the order, not to whichever sheet holds those batches', async () => {
      // A duplicate carries the same colour and size ids, so this is the one
      // case where another sheet could match the record cell for cell.
      await stopAfterTheStickers();
      await act(async () => buttonWithText(container, 'Save order').click());
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="duplicate-order"]')!.click());
      await act(async () => buttonWithText(container, 'Save order').click());

      const opens = () => Array.from(container.querySelectorAll('button'))
        .filter((b) => b.textContent?.trim() === 'Open');

      // The order that was actually printing gets its offer back.
      await act(async () => opens()[opens().length - 1].click());
      expect(text('[data-testid="resume-sent"]')).toContain('1/2 batches');

      // The copy has printed nothing, even though every batch id matches.
      await act(async () => opens()[0].click());
      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('is out of the way while a sample is being printed', async () => {
      await stopAfterTheStickers();
      printSticker.mockImplementation(() => new Promise(() => {}));

      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="print-sample"]')!.click());
      await settle();

      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });

    it('survives a sample print in between', async () => {
      await stopAfterTheStickers();
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="print-sample"]')!.click());
      await settle();

      const first = root!;
      await act(async () => first.unmount());
      root = null;
      await render();

      expect(text('[data-testid="resume-sent"]')).toContain('1/2 batches');
    });

    it('is not written by a sample print', async () => {
      await render();
      await fillMinimalOrder(40);
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="print-sample"]')!.click());
      await settle();

      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();

      const first = root!;
      await act(async () => first.unmount());
      root = null;
      await render();
      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });
  });

  describe('the customer sheet pasted instead of retyped', () => {
    const SHEET = '\tS\tM\nCZEKOLADA\t40\t60\nBORDO\t20\t0';

    async function paste(text: string) {
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="paste-open"]')!.click());
      const box = container.querySelector<HTMLTextAreaElement>('[data-testid="paste-input"]')!;
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      await act(async () => {
        setValue?.call(box, text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    it('shows what it read before anything is replaced', async () => {
      await render();
      await fillMinimalOrder(40);
      await paste(SHEET);

      expect(text('[data-testid="paste-preview"]')).toContain(
        'Read 2 colours × 2 sizes, 120 labels in total.',
      );
      expect(text('[data-testid="paste-preview"]')).toContain(
        'Replaces the 1 colours × 1 sizes on screen.',
      );
      // Nothing has moved on the sheet yet.
      expect(text('[data-testid="grand-total"]')).toBe('40');
    });

    it('replaces the grid when the operator says so', async () => {
      await render();
      await fillMinimalOrder(40);
      await paste(SHEET);
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="paste-accept"]')!.click());

      expect(text('[data-testid="grand-total"]')).toBe('120');
      expect(container.querySelector('[data-testid="paste-box"]')).toBeNull();
      expect(input(container, 'input[placeholder="CZEKOLADA"]').value).toBe('CZEKOLADA');
      // The old single column is gone, not added to.
      expect(container.querySelectorAll('input[type=number][aria-label]')).toHaveLength(4);
    });

    it('leaves the sheet alone when the paste is dropped', async () => {
      await render();
      await fillMinimalOrder(40);
      await paste(SHEET);
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="paste-cancel"]')!.click());

      expect(text('[data-testid="grand-total"]')).toBe('40');
      expect(container.querySelector('[data-testid="paste-box"]')).toBeNull();
    });

    it('says what is wrong instead of wiping the grid with an empty one', async () => {
      await render();
      await fillMinimalOrder(40);
      await paste('prosze wydrukowac\nmetki na jutro');

      expect(text('[data-testid="paste-problem"]')).toContain('not a table');
      expect(container.querySelector<HTMLButtonElement>('[data-testid="paste-accept"]')!.disabled)
        .toBe(true);
      expect(text('[data-testid="grand-total"]')).toBe('40');
    });

    it('takes the sticker code from the sheet when it carries one', async () => {
      await render();
      await changeInput(input(container, 'input[placeholder="MoonCollection"]'), 'MOON');
      await changeInput(input(container, 'input[placeholder="114"]'), '114');
      await paste('KOLOR\tKOD\tS\nczekolada\tsp006290\t40');
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="paste-accept"]')!.click());
      await act(async () => buttonWithText(container, 'Print').click());
      await settle();

      expect(printSticker.mock.calls[0][0].code).toBe('SP006290');
    });

    it('makes up a sticker code for a pasted sheet that has none', async () => {
      await render();
      await changeInput(input(container, 'input[placeholder="MoonCollection"]'), 'MOON');
      await changeInput(input(container, 'input[placeholder="114"]'), '114');
      await paste('KOLOR\tS\nczekolada\t40');
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="paste-accept"]')!.click());
      await act(async () => buttonWithText(container, 'Print').click());
      await settle();

      expect(printSticker.mock.calls[0][0].code).toMatch(/^SP\d{6}$/);
    });

    it('does not carry an interrupted run over to the pasted sheet', async () => {
      let releaseSticker: (value: { success: boolean }) => void = () => {};
      printSticker.mockImplementation(
        () => new Promise((resolve) => { releaseSticker = resolve; }),
      );
      await render();
      await fillMinimalOrder(40);
      await act(async () => buttonWithText(container, 'Print').click());
      await settle();
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="stop-print"]')!.click());
      await act(async () => { releaseSticker({ success: true }); });
      await settle();
      expect(container.querySelector('[data-testid="resume-block"]')).not.toBeNull();

      await paste(SHEET);
      await act(async () => container.querySelector<HTMLButtonElement>(
        '[data-testid="paste-accept"]')!.click());

      expect(container.querySelector('[data-testid="resume-block"]')).toBeNull();
    });
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

  it('prints one of each when the operator asks for a sample', async () => {
    await render();
    await fillMinimalOrder(40);
    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-testid="print-sample"]')!.click());
    await settle();

    expect(printSticker).toHaveBeenCalledTimes(1);
    expect(printSticker.mock.calls[0][0]).toMatchObject({ quantity: 1 });
    expect(printFabricTag).toHaveBeenCalledTimes(1);
    expect(printFabricTag.mock.calls[0][0]).toMatchObject({ quantity: 1, size: 'S' });
  });

  it('lets a sample print before any quantity is typed', async () => {
    await render();
    await changeInput(input(container, 'input[placeholder="MoonCollection"]'), 'MOON');
    await changeInput(input(container, 'input[placeholder="114"]'), '114');
    await act(async () => buttonWithText(container, '+ S').click());
    await act(async () => buttonWithText(container, 'Add colour').click());
    await changeInput(input(container, 'input[placeholder="CZEKOLADA"]'), 'CZEKOLADA');

    // The real Print button is blocked with nothing in the grid; the sample is not.
    expect(buttonWithText(container, 'Print').disabled).toBe(true);
    const sample = container.querySelector<HTMLButtonElement>('[data-testid="print-sample"]')!;
    expect(sample.disabled).toBe(false);

    await act(async () => sample.click());
    await settle();
    expect(printFabricTag).toHaveBeenCalledTimes(1);
  });

  it('refuses a sample while the real order is still going out', async () => {
    let releaseSticker: (value: { success: boolean }) => void = () => {};
    printSticker.mockImplementation(
      () => new Promise((resolve) => { releaseSticker = resolve; }),
    );

    await render();
    await fillMinimalOrder(40);
    await act(async () => buttonWithText(container, 'Print').click());
    await settle();

    expect(container.querySelector<HTMLButtonElement>('[data-testid="print-sample"]')!.disabled)
      .toBe(true);

    await act(async () => { releaseSticker({ success: true }); });
    await settle();
  });

  it('has nothing to sample on an empty sheet', async () => {
    await render();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="print-sample"]')!.disabled)
      .toBe(true);
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

    expect(input(container, 'input[placeholder="MoonCollection"]').value).toBe('MOON COLLECTION');
    expect(input(container, 'input[placeholder="CZEKOLADA"]').value).toBe('CZEKOLADA');
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
