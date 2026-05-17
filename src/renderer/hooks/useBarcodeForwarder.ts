/**
 * useBarcodeForwarder – forwards keystrokes to the main-process HID scanner
 * so it can detect keyboard-wedge barcodes even when no text input is focused.
 *
 * Skips keystrokes whose target is already a form input — those go directly
 * into the input and are handled by its own Enter handler, avoiding duplicate
 * scan processing.
 */

import { useEffect } from 'react';

function isTextEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

export function useBarcodeForwarder(enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    const api = (window as any).electronAPI;
    if (!api || typeof api.sendKeyboardInput !== 'function') return;

    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (isTextEditableTarget(event.target)) return;

      const key = event.key;
      if (key === 'Enter') {
        api.sendKeyboardInput('Enter');
        return;
      }
      if (key.length !== 1) return;
      if (key < ' ' || key > '~') return;
      api.sendKeyboardInput(key);
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [enabled]);
}
