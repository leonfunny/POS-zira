import React, { useEffect, useRef } from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onBarcodeScanned?: (barcode: string) => void;
  placeholder?: string;
}

export default function SearchBar({ value, onChange, onBarcodeScanned, placeholder }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const barcodeCallbackRef = useRef(onBarcodeScanned);
  const searchId = 'pos-product-search';
  barcodeCallbackRef.current = onBarcodeScanned;

  useEffect(() => {
    const unsub = window.electronAPI.onBarcodeScanned((barcode: string) => {
      barcodeCallbackRef.current?.(barcode);
    });
    return unsub;
  }, []);

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

  return (
    <div className="relative">
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
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const barcode = value.trim();
          if (!barcode || !onBarcodeScanned) return;
          e.preventDefault();
          onBarcodeScanned(barcode);
          onChange('');
        }}
        placeholder={placeholder || 'Search or scan barcode'}
        className="w-full h-12 pl-11 pr-12 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-900 placeholder-slate-500 focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-shadow shadow-sm"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-200 cursor-pointer"
          aria-label="Clear search"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
