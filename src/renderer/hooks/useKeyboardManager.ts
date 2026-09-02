import { useState, useEffect, useRef } from 'react';
import type { KeyboardMode } from '../components/shared/TouchKeyboard';
import { nextNumberAppend, nextNumberBackspace } from './keyboard-value';

/**
 * Whether the on-screen keyboard may appear at all.
 *
 * Off for the garment factory: that machine is a laptop driven from its own
 * keyboard, with no touchscreen, so the panel only ever covered the bottom of
 * the sheet being typed. Everything else the manager does — selecting a field's
 * value on focus so typing replaces it, scrolling the focused field into view —
 * stays on, because that is what makes tabbing through the order grid work.
 *
 * Flip this back to true for a touchscreen till.
 */
export const TOUCH_KEYBOARD_ENABLED = false;

interface KeyboardManager {
  visible: boolean;
  mode: KeyboardMode;
  onKey: (key: string) => void;
  onBackspace: () => void;
  onDone: () => void;
}

function keyboardModeForInput(type: string, inputMode: string | null): KeyboardMode {
  return inputMode === 'numeric' ? 'integer'
    : type === 'number' || inputMode === 'decimal' ? 'numeric'
      : 'full';
}

export function useKeyboardManager(): KeyboardManager {
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<KeyboardMode>('full');
  const activeElRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True until the first numpad key after a focus: that key REPLACES the
  // whole value (number inputs expose no selection API to do it natively).
  const freshFocusRef = useRef(false);

  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') return;

      const el = target as HTMLInputElement | HTMLTextAreaElement;
      const type = (el as HTMLInputElement).type || 'text';

      // Skip non-text input types
      if (['checkbox', 'radio', 'hidden', 'file', 'date', 'time'].includes(type)) return;
      // Allow opt-out via data attribute
      if (el.dataset.keyboard === 'false') return;

      // Cancel any pending hide
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }

      activeElRef.current = el;
      freshFocusRef.current = true;
      // Text inputs: selecting the old value makes any typing (hardware or
      // touch) replace it — the same type-over behavior as the numpad flag.
      try { el.select(); } catch { /* some input types refuse selection */ }

      // Mode detection
      const inputMode = el.getAttribute('inputmode');
      setMode(keyboardModeForInput(type, inputMode));
      setVisible(true);

      // Once the keyboard's slide-up (300ms) settles and the layout inset
      // applies, make sure the field being typed is not hidden behind it.
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => {
        if (activeElRef.current === el && document.activeElement === el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }, 350);
    };

    const handleFocusOut = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') return;

      // Small delay so keyboard key presses (onPointerDown + preventDefault) don't trigger hide
      hideTimerRef.current = setTimeout(() => {
        setVisible(false);
        activeElRef.current = null;
      }, 150);
    };

    // Manual toggle from a UI button. Bypasses the data-keyboard="false"
    // opt-out so inputs that suppress auto-show (e.g. the POS search bar)
    // can still summon the keyboard on demand. Toggles when re-fired for
    // the same element.
    const handleManualToggle = (e: Event) => {
      const ev = e as CustomEvent<{ el: HTMLInputElement | HTMLTextAreaElement }>;
      const el = ev.detail?.el;
      if (!el) return;

      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }

      const type = (el as HTMLInputElement).type || 'text';
      const inputMode = el.getAttribute('inputmode');
      const nextMode = keyboardModeForInput(type, inputMode);

      setVisible((prev) => {
        if (prev && activeElRef.current === el) {
          activeElRef.current = null;
          return false;
        }
        activeElRef.current = el;
        freshFocusRef.current = true;
        setMode(nextMode);
        return true;
      });
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('pos:keyboard:request-toggle', handleManualToggle);
    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('pos:keyboard:request-toggle', handleManualToggle);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  const onKey = (key: string) => {
    const el = activeElRef.current;
    if (!el) return;

    const isNumber = el instanceof HTMLInputElement && el.type === 'number';

    if (!isNumber) {
      // Text / textarea — insert at cursor position
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      nativeSetter?.call(el, el.value.slice(0, start) + key + el.value.slice(end));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      requestAnimationFrame(() => {
        try { el.setSelectionRange(start + key.length, start + key.length); } catch {}
      });
    } else {
      // Number input — first key after focus types over, then append
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(el, nextNumberAppend(el.value, key, freshFocusRef.current));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    freshFocusRef.current = false;
  };

  const onBackspace = () => {
    const el = activeElRef.current;
    if (!el) return;

    const isNumber = el instanceof HTMLInputElement && el.type === 'number';

    if (!isNumber) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      if (start !== end) {
        // Delete selection
        nativeSetter?.call(el, el.value.slice(0, start) + el.value.slice(end));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        requestAnimationFrame(() => {
          try { el.setSelectionRange(start, start); } catch {}
        });
      } else if (start > 0) {
        // Delete char before cursor
        nativeSetter?.call(el, el.value.slice(0, start - 1) + el.value.slice(end));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        requestAnimationFrame(() => {
          try { el.setSelectionRange(start - 1, start - 1); } catch {}
        });
      }
    } else {
      // Number input — remove last char
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(el, nextNumberBackspace(el.value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    freshFocusRef.current = false;
  };

  const onDone = () => {
    activeElRef.current?.blur();
    setVisible(false);
    activeElRef.current = null;
  };

  return { visible: visible && TOUCH_KEYBOARD_ENABLED, mode, onKey, onBackspace, onDone };
}
