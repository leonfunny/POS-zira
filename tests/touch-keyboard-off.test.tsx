// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TOUCH_KEYBOARD_ENABLED, useKeyboardManager } from '../src/renderer/hooks/useKeyboardManager';
import SearchBar from '../src/renderer/components/pos/SearchBar';

let container: HTMLDivElement;
let root: Root | null = null;
let seen: { visible: boolean } = { visible: false };

function Probe() {
  const manager = useKeyboardManager();
  seen = { visible: manager.visible };
  return <input data-testid="field" />;
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  seen = { visible: false };
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container.remove();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});

describe('the on-screen keyboard on a keyboard-driven machine', () => {
  it('is off, so nothing slides up over the sheet being typed', () => {
    expect(TOUCH_KEYBOARD_ENABLED).toBe(false);
  });

  it('stays hidden when a field takes focus', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<Probe />);
    });
    const field = container.querySelector<HTMLInputElement>('[data-testid="field"]')!;

    await act(async () => {
      field.focus();
      field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });

    expect(seen.visible).toBe(false);
  });

  it('still selects the field value on focus, which is what typing over a cell needs', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<Probe />);
    });
    const field = container.querySelector<HTMLInputElement>('[data-testid="field"]')!;
    field.value = '40';

    await act(async () => {
      field.focus();
      field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });

    // Turning the panel off must not take the rest of the manager with it:
    // without select-on-focus, tabbing into a filled quantity cell and typing
    // appends to the old number instead of replacing it.
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(2);
  });

  it('takes the POS toggle button away with it, rather than leaving a dead key', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { onBarcodeScanned: () => () => {} },
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<SearchBar value="" onChange={() => {}} />);
    });

    expect(container.querySelector('[aria-label="Toggle on-screen keyboard"]')).toBeNull();
    // The search field itself is untouched — the till still scans and types.
    expect(container.querySelector('input')).not.toBeNull();
  });
});
