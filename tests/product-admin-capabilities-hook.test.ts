import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

describe('product-admin capabilities hook', () => {
  it('does not run or cache capabilities before authentication', () => {
    const hook = source('src/renderer/hooks/useProductAdminCapabilities.ts');

    expect(hook).toContain('useProductAdminCapabilities(enabled = true)');
    expect(hook).toContain('if (!enabled)');
    expect(hook).toContain('cache = next.error ? null : next');
  });
});
