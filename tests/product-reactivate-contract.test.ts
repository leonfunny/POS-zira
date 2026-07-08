import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('inactive product administration contract', () => {
  it('exposes a separate inactive-inclusive catalog IPC without changing sales getAll', () => {
    const types = source('src/shared/types.ts');
    const posModule = source('src/main/modules/pos.module.ts');
    const preload = source('src/preload/preload.ts');
    const electron = source('src/shared/electron.d.ts');
    const productsHook = source('src/renderer/hooks/useProducts.ts');

    expect(types).toContain("POS_PRODUCTS_GET_ALL_INCLUDING_INACTIVE: 'pos:products:getAllIncludingInactive'");
    expect(posModule).toContain('productRepo.getAllIncludingInactive()');
    expect(preload).toContain('getAllIncludingInactive: () => ipcRenderer.invoke(IPC_CHANNELS.POS_PRODUCTS_GET_ALL_INCLUDING_INACTIVE)');
    expect(electron).toContain('getAllIncludingInactive: () => Promise<PosProduct[]>');
    expect(productsHook).toContain('window.electronAPI.pos.products.getAllIncludingInactive()');
  });

  it('filters inactive products explicitly and reactivates through updateVariant', () => {
    const productsHook = source('src/renderer/hooks/useProducts.ts');
    const moduleSource = source('src/renderer/components/products/ProductModule.tsx');
    const editView = source('src/renderer/components/products/ProductEditView.tsx');

    expect(productsHook).toContain("'inactive'");
    expect(moduleSource).toContain("'inactive'");
    expect(editView).toContain('canReactivate');
    expect(editView).toContain('isActive: true');
    expect(editView).toContain('expectedUpdatedAt: product.updated_at || undefined');
    expect(editView).toContain('onProductReactivated');
  });
});
