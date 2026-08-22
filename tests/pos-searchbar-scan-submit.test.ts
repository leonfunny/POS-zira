import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SEARCH_BAR = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/SearchBar.tsx'),
  'utf8',
);

function blockFrom(startText: string, endText: string): string {
  const start = SEARCH_BAR.indexOf(startText);
  expect(start, `${startText} not found`).toBeGreaterThan(-1);
  const end = SEARCH_BAR.indexOf(endText, start);
  expect(end, `${endText} not found after ${startText}`).toBeGreaterThan(-1);
  return SEARCH_BAR.slice(start, end + endText.length);
}

describe('POS SearchBar keyboard-wedge scan handoff', () => {
  it('centralizes barcode submit and clear behavior', () => {
    const helper = blockFrom('const submitBarcode = useCallback', '}, [onChange]);');

    expect(helper).toContain('const barcode = rawValue.trim();');
    expect(helper).toContain("if (inputEl) inputEl.value = '';");
    expect(helper).toContain("if (inputRef.current && inputRef.current !== inputEl) inputRef.current.value = '';");
    expect(helper).toContain("onChange('');");
    expect(helper).toContain('onScan(barcode);');
  });

  it('discriminates Enter and Tab submissions instead of submitting the raw field value', () => {
    expect(SEARCH_BAR).toContain("if (e.key !== 'Enter' && e.key !== 'Tab') return;");
    // The whole-field submit is what turned leftover search text into a fake
    // barcode (bare-create modal named after the query, 2026-08-22).
    expect(SEARCH_BAR).not.toContain('submitBarcode(e.currentTarget.value, e.currentTarget)');
    expect(SEARCH_BAR).toContain('resolveEnterSubmission(');
    expect(SEARCH_BAR).toContain('e.currentTarget.value,');
    expect(SEARCH_BAR).toContain('submitBarcode(resolution.code, e.currentTarget)');
    expect(SEARCH_BAR).not.toContain('const barcode = value.trim();');
    expect(SEARCH_BAR).not.toContain('onBarcodeScanned(barcode);');
  });

  it('clears IPC barcode scans through the same submit helper', () => {
    const ipcHandler = blockFrom(
      'window.electronAPI.onBarcodeScanned((barcode: string) => {',
      '});',
    );

    expect(ipcHandler).toContain('submitBarcode(barcode);');
    expect(ipcHandler).not.toContain('barcodeCallbackRef.current?.(barcode)');
  });

  it('focus requests only focus the field and do not clear manual search text', () => {
    const focusHandler = blockFrom(
      "document.addEventListener('pos:focus-search', handler);",
      "document.removeEventListener('pos:focus-search', handler);",
    );

    expect(SEARCH_BAR).toContain('const handler = () => inputRef.current?.focus();');
    expect(focusHandler).not.toContain("onChange('');");
    expect(focusHandler).not.toContain("value = ''");
  });
});
