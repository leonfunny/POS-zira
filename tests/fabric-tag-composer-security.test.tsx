// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FABRIC_TAG_CONFIRM_THRESHOLD } from '../src/shared/types';
import FabricTagComposer from '../src/renderer/components/label/FabricTagComposer';

let container: HTMLDivElement;
let root: Root;
const printFabricTag = vi.fn();

const translations: Record<string, string> = {
  'fabricTag.brand': 'Brand',
  'fabricTag.quantity': 'Quantity',
  'fabricTag.print': 'Print tag',
  'fabricTag.printing': 'Printing',
  'fabricTag.printed': 'Printed',
  'fabricTag.largeBatchWarning': 'Large batch requires confirmation',
  'fabricTag.largeBatchConfirm': 'Print {count} fabric labels?',
  'common.confirmTitle': 'Confirm print',
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
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
  await act(async () => root.unmount());
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
});
