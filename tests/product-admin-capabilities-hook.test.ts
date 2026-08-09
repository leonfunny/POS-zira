import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

describe('product-admin capabilities hook', () => {
  it('does not run or cache capabilities before authentication', () => {
    const hook = source('src/renderer/hooks/useProductAdminCapabilities.ts');

    expect(hook).toContain('useProductAdminCapabilities(enabled = true, authScope?: string)');
    expect(hook).toContain('if (!enabled)');
    expect(hook).toContain('const cache = new Map<string, ProductAdminCapabilitiesResult>()');
    expect(hook).toContain('if (!next.error && scope) cache.set(scope, next)');
    expect(hook).toContain('state.scope === scope');
  });

  it('exposes an explicit retry that clears the cache and repeats the request', () => {
    const hook = source('src/renderer/hooks/useProductAdminCapabilities.ts');

    expect(hook).toContain('retry: () => void');
    expect(hook).toContain('const retry = useCallback(() => {');
    expect(hook).toContain('if (scope) cache.delete(scope)');
    expect(hook).toContain('setRequestVersion((version) => version + 1)');
    expect(hook).toContain('[enabled, requestVersion, scope]');
  });

  it('can synchronously revoke the current scope after a definitive denial without refetching it', () => {
    const hook = source('src/renderer/hooks/useProductAdminCapabilities.ts');

    expect(hook).toContain('invalidate: (reason?: string) => void');
    expect(hook).toContain("const invalidate = useCallback((reason = 'UNAUTHORIZED_PRODUCT_ADMIN') => {");
    expect(hook).toContain('setState({ scope, value: { capabilities: null, error: reason, loading: false } });');
    expect(hook).toContain('requestEpoch.current += 1');
    expect(hook).toContain('return { ...visible, retry, invalidate };');
  });
});
