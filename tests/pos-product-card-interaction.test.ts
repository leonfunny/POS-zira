import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

function productCardSource() {
  return fs.readFileSync(
    path.join(REPO_ROOT, 'src/renderer/components/pos/ProductCard.tsx'),
    'utf8',
  );
}

describe('POS product card interaction', () => {
  it('makes the full product card the add target with keyboard support', () => {
    const cardSource = productCardSource();

    expect(cardSource).toContain('if (!soldOut) onAdd(product)');
    expect(cardSource).toContain('const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {');
    expect(cardSource).toContain("event.key === 'Enter' || event.key === ' '");
    expect(cardSource).toContain('role="button"');
    expect(cardSource).toContain('onClick={handleAdd}');
    expect(cardSource).toContain('onKeyDown={handleKeyDown}');
  });

  it('keeps the plus affordance visible without making it a nested button', () => {
    const cardSource = productCardSource();

    expect(cardSource).not.toContain('<button');
    expect(cardSource).toContain('aria-hidden="true"');
    expect(cardSource).toContain('bg-brand-600');
  });

  it('sold-out products are disabled and show overlay', () => {
    const cardSource = productCardSource();

    expect(cardSource).toContain('const soldOut = !isService && stockQty <= 0');
    expect(cardSource).toContain('aria-disabled={soldOut || undefined}');
    expect(cardSource).toContain("tabIndex={soldOut ? -1 : 0}");
    expect(cardSource).toContain("cursor-not-allowed");
    expect(cardSource).toContain("pos.product.soldOut");
    expect(cardSource).toContain('grayscale');
  });

  it('exports isProductSoldOut guard for use by templates', () => {
    const cardSource = productCardSource();
    expect(cardSource).toContain('export function isProductSoldOut');
  });
});
