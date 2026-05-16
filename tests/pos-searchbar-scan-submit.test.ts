import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SEARCH_BAR = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/components/pos/SearchBar.tsx'),
  'utf8',
);

describe('POS SearchBar keyboard-wedge scan handoff', () => {
  it('treats Enter in the focused search field as a barcode submit', () => {
    expect(SEARCH_BAR).toContain("if (e.key !== 'Enter') return;");
    expect(SEARCH_BAR).toContain('const barcode = value.trim();');
    expect(SEARCH_BAR).toContain('onBarcodeScanned(barcode);');
  });

  it('clears the code after forwarding the scan so the next barcode starts fresh', () => {
    expect(SEARCH_BAR).toContain("onChange('');");
  });
});
