import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('retail product grid layout', () => {
  it('uses tighter grid gutters without shrinking product columns', () => {
    const gridSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/pos/ProductGrid.tsx'),
      'utf8',
    );

    expect(gridSource).toContain('[grid-template-columns:repeat(auto-fill,minmax(154px,1fr))]');
    expect(gridSource).toContain('2xl:[grid-template-columns:repeat(auto-fill,minmax(172px,1fr))]');
    expect(gridSource).toContain('gap-2 p-1 pb-2');
    expect(gridSource).not.toContain('gap-3 p-1.5 pb-3');
  });

  it('keeps product cards compact while preserving the add button touch target', () => {
    const cardSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/pos/ProductCard.tsx'),
      'utf8',
    );

    expect(cardSource).toContain('p-1.5 h-full min-h-[184px]');
    expect(cardSource).not.toContain('p-2 h-full min-h-[190px]');
    expect(cardSource).toContain('className="w-11 h-11');
  });

  it('passes the optional long-press product action into each product card', () => {
    const gridSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/pos/ProductGrid.tsx'),
      'utf8',
    );

    expect(gridSource).toContain('onLongPressProduct?: (product: Product)');
    expect(gridSource).toContain('onLongPress={onLongPressProduct}');
  });
});
