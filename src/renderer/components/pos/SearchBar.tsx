import React, { useCallback, useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

export interface SearchBarHandle {
  focus: () => void;
}

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onBarcodeScanned?: (barcode: string) => void;
  commandBarcodes?: string[];
  placeholder?: string;
  pending?: boolean;
}

const SearchBar = forwardRef<SearchBarHandle, SearchBarProps>(function SearchBar(
  { value, onChange, onBarcodeScanned, commandBarcodes = [], placeholder, pending = false },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const barcodeCallbackRef = useRef(onBarcodeScanned);
  const commandBarcodeSetRef = useRef(new Set(commandBarcodes.map((code) => code.trim()).filter(Boolean)));
  const searchId = 'pos-product-search';
  barcodeCallbackRef.current = onBarcodeScanned;
  commandBarcodeSetRef.current = new Set(commandBarcodes.map((code) => code.trim()).filter(Boolean));

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }), []);

  const submitBarcode = useCallback((rawValue: string, inputEl = inputRef.current): boolean => {
    const barcode = rawValue.trim();
    const onScan = barcodeCallbackRef.current;
    if (!barcode || !onScan) return false;

    if (inputEl) inputEl.value = '';
    if (inputRef.current && inputRef.current !== inputEl) inputRef.current.value = '';
    onChange('');
    onScan(barcode);
    return true;
  }, [onChange]);

  const handleInputChange = useCallback((nextValue: string) => {
    const code = nextValue.trim();
    if (code && commandBarcodeSetRef.current.has(code)) {
      submitBarcode(code);
      return;
    }
    onChange(nextValue);
  }, [onChange, submitBarcode]);

  useEffect(() => {
    const unsub = window.electronAPI.onBarcodeScanned((barcode: string) => {
      if (document.body.dataset.posAddProductOpen === 'true') return;
      if (document.body.dataset.posPaymentOpen === 'true') return;
      submitBarcode(barcode);
    });
    return unsub;
  }, [submitBarcode]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Listen for a global "focus the POS search" request so other surfaces
  // (cart add, scan-import modal close) can return focus here without
  // prop-drilling a ref. Fires synchronously, so callers can rely on focus
  // being restored before the next paint.
  useEffect(() => {
    const handler = () => inputRef.current?.focus();
    document.addEventListener('pos:focus-search', handler);
    return () => document.removeEventListener('pos:focus-search', handler);
  }, []);

  // Default-focus when mounted so the cashier can scan/type immediately
  // without clicking anywhere first.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyboardToggle = () => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    document.dispatchEvent(
      new CustomEvent('pos:keyboard:request-toggle', { detail: { el } }),
    );
  };

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleKeyboardToggle}
        aria-label="Toggle on-screen keyboard"
        title="Toggle on-screen keyboard"
        className="shrink-0 h-12 w-12 flex items-center justify-center rounded-md bg-white border border-slate-300 text-slate-600 hover:border-brand-400 hover:text-brand-700 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 shadow-sm cursor-pointer touch-manipulation"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="6" width="18" height="12" rx="2" strokeWidth={1.8} />
          <path strokeLinecap="round" strokeWidth={1.8} d="M7 10h.01M11 10h.01M15 10h.01M7 14h.01M11 14h.01M15 14h.01M8 17h8" />
        </svg>
      </button>
      <div className="relative flex-1">
        <label htmlFor={searchId} className="sr-only">{placeholder || 'Search products'}</label>
        <svg
          className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          id={searchId}
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== 'Tab') return;
            if (submitBarcode(e.currentTarget.value, e.currentTarget)) {
              e.preventDefault();
            }
          }}
          placeholder={placeholder || 'Search or scan barcode'}
          inputMode="none"
          data-keyboard="false"
          autoComplete="off"
          className={`w-full h-12 pl-11 ${pending && value ? 'pr-24' : 'pr-12'} bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-900 placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-shadow shadow-sm`}
        />
        {pending && (
          <span
            role="status"
            aria-label="Searching products"
            className={`absolute ${value ? 'right-14' : 'right-3.5'} top-1/2 -translate-y-1/2 text-brand-600 pointer-events-none`}
          >
            <Loader2 size={20} className="animate-spin" aria-hidden="true" />
          </span>
        )}
        {value && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200 cursor-pointer"
            aria-label="Clear search"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
});

export default SearchBar;
