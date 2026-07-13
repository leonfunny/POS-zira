import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

const POS_MODULE = source('src/main/modules/pos.module.ts');
const MODULE_UI = source('src/renderer/components/products/ProductModule.tsx');
const EDIT_VIEW = source('src/renderer/components/products/ProductEditView.tsx');
const PRELOAD_POS = source('src/preload/preload-pos.ts');
const PRELOAD = source('src/preload/preload.ts');

// A draft import creates the local variant under the DRAFT id; the server
// clone gets a NEW id. Until the alias map is applied, every product-admin
// mutation PATCHes a nonexistent id and the backend answers 404
// "Variant not found" (WASABI PASTA 43G / Sot Tom Kha Kai, Wolka 2026-07-10).
describe('product-admin mutations retarget local import aliases', () => {
  it('pos.module defines a single alias resolver backed by local_variant_imports', () => {
    expect(POS_MODULE).toContain('const resolveVariantIdAlias');
    expect(POS_MODULE).toContain('localVariantImportsRepo.getServerVariantId(');
  });

  it('every variant-mutating product-admin API call resolves the alias first', () => {
    expect(POS_MODULE).toContain(
      'apiClient.updateProductVariant(\n              token,\n              resolveVariantIdAlias(variantId),',
    );
    expect(POS_MODULE).toContain(
      'apiClient.deactivateProductVariant(token, resolveVariantIdAlias(variantId)',
    );
    expect(POS_MODULE).toContain(
      'apiClient.adjustProductStock(token, resolveVariantIdAlias(variantId), input)',
    );
  });

  it('import-draft returns the SERVER variant once the immediate reconcile lands', () => {
    expect(POS_MODULE).toContain('const serverId = localVariantImportsRepo.getServerVariantId(variantId)');
    expect(POS_MODULE).toContain('resolvedVariant = serverVariant ?? variant');
    expect(POS_MODULE).toContain("outcome: 'LOCAL_IMPORT', variant: resolvedVariant, syncPending");
  });

  it('exposes the unresolved-import id list over IPC in both preloads', () => {
    expect(POS_MODULE).toContain("'pos:local-variant-imports:list-unresolved-ids'");
    expect(PRELOAD_POS).toContain('listUnresolvedIds');
    expect(PRELOAD).toContain('listUnresolvedIds');
  });
});

describe('renderer blocks edits on still-pending imports', () => {
  it('ProductModule tracks unresolved import ids and passes importPending down', () => {
    expect(MODULE_UI).toContain('listUnresolvedIds');
    expect(MODULE_UI).toContain('importPending={unresolvedImportIds.has(selectedProduct.id)}');
  });

  it('ProductEditView disables Edit + Adjust stock + Stop selling while pending, with a hint', () => {
    expect(EDIT_VIEW).toContain('importPending = false');
    expect(EDIT_VIEW).toContain('!product._isDraft && !importPending');
    expect(EDIT_VIEW).toContain('stockTracked && !importPending');
    expect(EDIT_VIEW).toContain("'products.import.pendingHint'");
  });
});
