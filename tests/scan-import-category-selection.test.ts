import { describe, expect, it } from 'vitest';
import {
  hasScanImportCategoryOptions,
  resolveInitialScanImportCategoryId,
  type ScanImportCategoryOption,
  type ScanImportDraftPreview,
} from '../src/renderer/components/pos/ScanImportModal';

const categories: ScanImportCategoryOption[] = [
  { id: 'cat-snacks', name: 'Snacks', icon: null, color: null, sort_order: 1, updated_at: null },
  { id: 'cat-drinks', name: 'Drinks', icon: null, color: null, sort_order: 2, updated_at: null },
];

function preview(suggestedCategoryId: string | null | undefined): ScanImportDraftPreview {
  return {
    id: 'draft-1',
    name: 'Draft product',
    barcode: '5901234567890',
    retail_price: 1299,
    vat_rate: 23,
    image_url: null,
    source: 'draft',
    suggestedCategoryId,
  };
}

describe('ScanImportModal category selection', () => {
  it('preselects a suggested category only when it exists in the local category list', () => {
    expect(resolveInitialScanImportCategoryId(preview('cat-drinks'), categories)).toBe('cat-drinks');
  });

  it('falls back to default when suggested category is missing or null', () => {
    expect(resolveInitialScanImportCategoryId(preview('deleted-cat'), categories)).toBe('');
    expect(resolveInitialScanImportCategoryId(preview(null), categories)).toBe('');
  });

  it('hides the dropdown when the local category cache is empty', () => {
    expect(hasScanImportCategoryOptions([])).toBe(false);
    expect(resolveInitialScanImportCategoryId(preview('cat-drinks'), [])).toBe('');
  });
});
