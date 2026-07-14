import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

describe('POS templates preserve the active catalog view after product sync', () => {
  it.each([
    'restaurant/RestaurantTemplate.tsx',
    'b2b/B2BTemplate.tsx',
    'salon/SalonTemplate.tsx',
  ])('reloads categories and the current filtered query in %s', (file) => {
    const template = source(`src/renderer/components/pos/templates/${file}`);

    expect(template).toContain('const [catalogRevision, setCatalogRevision] = useState(0);');
    expect(template).toContain('onProductsSynced(() => {');
    expect(template).toContain('setCatalogRevision((revision) => revision + 1);');
    expect(template).toContain('[catalogRevision]');
    expect(template).toContain('[activeCategoryId, catalogRevision, searchQuery]');
    expect(template).toContain('!categories.some((category) => category.id === activeCategoryId)');
    expect(template).toContain('setActiveCategoryId(null);');
    expect(template).toContain('[activeCategoryId, categories]');
  });
});
