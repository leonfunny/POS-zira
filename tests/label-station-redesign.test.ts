import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/renderer/components/LabelStationTab.tsx'), 'utf8');

describe('Label Station redesign', () => {
  it('uses the requested two-column label-station layout', () => {
    expect(SOURCE).toContain('grid-cols-[minmax(0,1fr),400px] gap-3');
    expect(SOURCE).toContain('sticky top-3');
    expect(SOURCE).toContain('border-l border-l-slate-300');
  });

  it('keeps the station language consistently Vietnamese', () => {
    expect(SOURCE).toContain("title: 'Trạm in nhãn'");
    expect(SOURCE).toContain("search: 'Tìm theo tên, SKU, EAN, danh mục'");
    expect(SOURCE).toContain("allCategories: 'Tất cả danh mục'");
    expect(SOURCE).toContain("copies: 'Số bản in'");
    expect(SOURCE).toContain("recent: 'Lịch sử in gần đây'");
    expect(SOURCE).toContain("exit: 'Thoát'");
  });

  it('adds a visible label preview with barcode preview before printing', () => {
    expect(SOURCE).toContain('function BarcodePreview');
    expect(SOURCE).toContain("labelPreview: 'Xem trước nhãn'");
    expect(SOURCE).toContain('<BarcodePreview barcode={selectedBarcode} />');
    expect(SOURCE).toContain('barcodeBars(barcode)');
  });

  it('prevents accidental high-copy mass printing', () => {
    expect(SOURCE).toContain('const HIGH_COPY_CONFIRM_THRESHOLD = 10');
    expect(SOURCE).toContain('window.confirm(TEXT.highCopyConfirm(quantity))');
    expect(SOURCE).toContain('quantity > HIGH_COPY_CONFIRM_THRESHOLD');
  });

  it('supports useful recent prints and keyboard shortcuts', () => {
    expect(SOURCE).toContain('const RECENT_PRINT_LIMIT = 5');
    expect(SOURCE).toContain('function formatRecentTime');
    expect(SOURCE).toContain('const handleQuickReprint');
    expect(SOURCE).toContain("window.addEventListener('keydown', onKeyDown)");
    expect(SOURCE).toContain("event.key === 'Enter'");
    expect(SOURCE).toContain("event.key === '/'");
    expect(SOURCE).toContain("event.key === 'Escape'");
  });
});
