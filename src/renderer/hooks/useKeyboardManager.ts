import { useState, useEffect, useRef } from 'react';
import type { KeyboardMode } from '../components/shared/TouchKeyboard';

interface KeyboardManager {
  visible: boolean;
  mode: KeyboardMode;
  onKey: (key: string) => void;
  onBackspace: () => void;
  onDone: () => void;
}

export function useKeyboardManager(): KeyboardManager {
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<KeyboardMode>('full');
  const activeElRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

      // Mode detection
      const inputMode = el.getAttribute('inputmode');
      if (type === 'number' || inputMode === 'numeric' || inputMode === 'decimal') {
        setMode('numeric');
      } else {
        setMode('full');
      }
      setVisible(true);
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

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
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
      // Number input — append
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(el, el.value + key);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
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
      nativeSetter?.call(el, el.value.slice(0, -1));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  const onDone = () => {
    activeElRef.current?.blur();
    setVisible(false);
    activeElRef.current = null;
  };

  return { visible, mode, onKey, onBackspace, onDone };
}
