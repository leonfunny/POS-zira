// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FABRIC_TAG_CONFIRM_THRESHOLD } from '../src/shared/types';
import FabricTagComposer from '../src/renderer/components/label/FabricTagComposer';

let container: HTMLDivElement;
let root: Root | null;
const printFabricTag = vi.fn();

const translations: Record<string, string> = {
  'fabricTag.brand': 'Brand',
  'fabricTag.logo': 'Choose logo',
  'fabricTag.removeLogo': 'Remove logo',
  'fabricTag.price': 'Price',
  'fabricTag.quantity': 'Quantity',
  'fabricTag.print': 'Print tag',
  'fabricTag.printing': 'Printing',
  'fabricTag.printed': 'Printed',
  'fabricTag.largeBatchWarning': 'Large batch requires confirmation',
  'fabricTag.largeBatchConfirm': 'Print {count} fabric labels?',
  'common.confirmTitle': 'Confirm print',
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
  'products.edit.priceInvalid': 'Enter a valid price',
};

function t(key: string): string {
  return translations[key] || key;
}

async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

const PNG_1X1 = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));

function pngFile(name: string): File {
  const file = new File([PNG_1X1], name, { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: vi.fn(async () => PNG_1X1.slice().buffer),
  });
  return file;
}

function setSelectedFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [file],
  });
}

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  printFabricTag.mockReset();
  printFabricTag.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { printFabricTag },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <FabricTagComposer
        t={t}
        labelWidthMm={20}
        labelHeightMm={60}
        ready
      />,
    );
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container.remove();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('FabricTagComposer safety policy', () => {
  it('behaves like radio buttons inside exclusive care families', async () => {
    const wash30 = container.querySelector<HTMLButtonElement>('button[title="WASH_30"]')!;
    const wash40 = container.querySelector<HTMLButtonElement>('button[title="WASH_40"]')!;
    const dryLine = container.querySelector<HTMLButtonElement>('button[title="DRY_LINE"]')!;
    const dryFlat = container.querySelector<HTMLButtonElement>('button[title="DRY_FLAT"]')!;

    await act(async () => wash30.click());
    expect(wash30.getAttribute('aria-pressed')).toBe('true');
    await act(async () => wash40.click());
    expect(wash30.getAttribute('aria-pressed')).toBe('false');
    expect(wash40.getAttribute('aria-pressed')).toBe('true');

    // Workshop policy for these two drying methods remains intentionally open.
    await act(async () => {
      dryLine.click();
      dryFlat.click();
    });
    expect(dryLine.getAttribute('aria-pressed')).toBe('true');
    expect(dryFlat.getAttribute('aria-pressed')).toBe('true');
  });

  it('requires explicit confirmation above the shared physical-run threshold', async () => {
    const brand = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    const quantity = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    await changeInput(brand, 'Zira');
    await changeInput(quantity, String(FABRIC_TAG_CONFIRM_THRESHOLD + 1));

    await act(async () => buttonWithText('Print tag').click());
    expect(printFabricTag).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      `Print ${FABRIC_TAG_CONFIRM_THRESHOLD + 1} fabric labels?`,
    );

    await act(async () => buttonWithText('Confirm').click());
    await settle();
    expect(printFabricTag).toHaveBeenCalledTimes(1);
    expect(printFabricTag).toHaveBeenCalledWith(expect.objectContaining({
      brandName: 'Zira',
      quantity: FABRIC_TAG_CONFIRM_THRESHOLD + 1,
    }));
  });

  it('rejects malformed or out-of-range prices and accepts a decimal comma', async () => {
    const textInputs = container.querySelectorAll<HTMLInputElement>('input[type="text"]');
    const brand = textInputs[0];
    const price = textInputs[2];
    await changeInput(brand, 'Zira');

    for (const invalid of ['12abc', '12.999', '1,234.56', '10000000.00']) {
      await changeInput(price, invalid);
      expect(price.getAttribute('aria-invalid')).toBe('true');
      expect(container.textContent).toContain('Enter a valid price');
      expect(buttonWithText('Print tag').disabled).toBe(true);
      await act(async () => buttonWithText('Print tag').click());
    }
    expect(printFabricTag).not.toHaveBeenCalled();

    await changeInput(price, '12,34');
    expect(price.getAttribute('aria-invalid')).toBe('false');
    expect(buttonWithText('Print tag').disabled).toBe(false);
    await act(async () => buttonWithText('Print tag').click());
    await settle();

    expect(printFabricTag).toHaveBeenCalledTimes(1);
    expect(printFabricTag).toHaveBeenCalledWith(expect.objectContaining({ priceGrosze: 1234 }));
  });

  it('keeps only the latest logo read and blocks printing until it completes', async () => {
    class ControlledFileReader {
      static readonly LOADING = 1;
      readyState = 0;
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      abort = vi.fn(() => { this.readyState = 2; });
      readAsDataURL = vi.fn(() => {
        this.readyState = ControlledFileReader.LOADING;
        readers.push(this);
      });
      complete(result: string): void {
        this.readyState = 2;
        this.result = result;
        this.onload?.();
      }
    }
    const readers: ControlledFileReader[] = [];
    const nativeFileReader = globalThis.FileReader;
    Object.defineProperty(globalThis, 'FileReader', {
      configurable: true,
      value: ControlledFileReader,
    });

    try {
      const brand = container.querySelector<HTMLInputElement>('input[type="text"]')!;
      const logoInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      await changeInput(brand, 'Zira');
      const printButton = buttonWithText('Print tag');
      expect(printButton.disabled).toBe(false);

      setSelectedFile(logoInput, pngFile('first.png'));
      await act(async () => {
        logoInput.dispatchEvent(new Event('change', { bubbles: true }));
        // React has not rendered logoLoading yet; the synchronous ref must
        // still keep this same-turn click away from physical print IPC.
        printButton.click();
        await Promise.resolve();
      });
      await settle();
      expect(printFabricTag).not.toHaveBeenCalled();
      expect(buttonWithText('Print tag').disabled).toBe(true);
      expect(readers).toHaveLength(1);

      setSelectedFile(logoInput, pngFile('second.png'));
      await act(async () => {
        logoInput.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });
      await settle();
      expect(readers).toHaveLength(2);
      expect(readers[0].abort).toHaveBeenCalledTimes(1);

      await act(async () => readers[1].complete('data:image/png;base64,second'));
      const preview = container.querySelector<HTMLImageElement>('img');
      expect(preview?.src).toContain('base64,second');

      await act(async () => readers[0].complete('data:image/png;base64,stale-first'));
      expect(container.querySelector<HTMLImageElement>('img')?.src).toContain('base64,second');
      expect(buttonWithText('Print tag').disabled).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'FileReader', {
        configurable: true,
        value: nativeFileReader,
      });
    }
  });

  it('cancels a pending logo read on removal and unmount', async () => {
    class ControlledFileReader {
      static readonly LOADING = 1;
      readyState = 0;
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      abort = vi.fn(() => { this.readyState = 2; });
      readAsDataURL = vi.fn(() => {
        this.readyState = ControlledFileReader.LOADING;
        readers.push(this);
      });
      complete(result: string): void {
        this.readyState = 2;
        this.result = result;
        this.onload?.();
      }
    }
    const readers: ControlledFileReader[] = [];
    const nativeFileReader = globalThis.FileReader;
    Object.defineProperty(globalThis, 'FileReader', {
      configurable: true,
      value: ControlledFileReader,
    });

    try {
      const logoInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      setSelectedFile(logoInput, pngFile('remove.png'));
      await act(async () => {
        logoInput.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });
      await settle();
      expect(readers).toHaveLength(1);

      await act(async () => buttonWithText('Remove logo').click());
      expect(readers[0].abort).toHaveBeenCalledTimes(1);
      await act(async () => readers[0].complete('data:image/png;base64,removed'));
      expect(container.querySelector('img')).toBeNull();

      setSelectedFile(logoInput, pngFile('unmount.png'));
      await act(async () => {
        logoInput.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
      });
      await settle();
      expect(readers).toHaveLength(2);
      await act(async () => root?.unmount());
      expect(readers[1].abort).toHaveBeenCalledTimes(1);
      root = null;
      readers[1].complete('data:image/png;base64,after-unmount');
    } finally {
      Object.defineProperty(globalThis, 'FileReader', {
        configurable: true,
        value: nativeFileReader,
      });
    }
  });
});
