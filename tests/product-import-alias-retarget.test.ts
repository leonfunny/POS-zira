import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/database/database', () => ({
  database: {
    all: vi.fn(),
  },
}));

import { database } from '../src/main/database/database';
import { localVariantImportsRepo } from '../src/main/database/repos/local-variant-imports-repo';

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
describe('product-admin mutations fail closed for local import aliases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes SYNCED aliases in the product-admin mutation blocklist', () => {
    vi.mocked(database.all).mockReturnValueOnce([
      { variant_id: 'pending-local-id' },
      { variant_id: 'synced-local-alias-id' },
    ]);

    expect(localVariantImportsRepo.getAdminMutationBlockedVariantIds())
      .toContain('synced-local-alias-id');

    const [sql] = vi.mocked(database.all).mock.calls[0];
    expect(sql).toContain('SELECT variant_id FROM local_variant_imports');
    expect(sql).not.toContain("status IN ('PENDING', 'FAILED')");
  });

  it('pos.module defines a single fail-closed alias guard backed by local_variant_imports', () => {
    expect(POS_MODULE).toContain('const resolveVariantIdAlias');
    expect(POS_MODULE).toContain('localVariantImportsRepo.getAdminMutationBlockedVariantIds().has(normalizedId)');
    expect(POS_MODULE).toContain("error.code = 'VARIANT_IMPORT_ALIAS_BLOCKED'");
  });

  it('every variant-mutating product-admin API call resolves the alias first', () => {
    expect(POS_MODULE).toContain('const resolvedVariantId = resolveVariantIdAlias(variantId);');
    expect(POS_MODULE).toContain(
      'apiClient.updateProductVariant(\n              token,\n              resolvedVariantId,',
    );
    expect(POS_MODULE).toContain(
      'apiClient.deactivateProductVariant(token, resolveVariantIdAlias(variantId)',
    );
    expect(POS_MODULE).toContain(
      "mutationType: 'ADJUST_STOCK',\n              targetVariantId: resolvedVariantId",
    );
    expect(POS_MODULE).toContain(
      "mutationType: 'RECEIVE_STOCK',\n              targetVariantId: resolvedVariantId",
    );
    expect(POS_MODULE).toContain(
      "mutationType: 'UPLOAD_MAIN_IMAGE',\n              targetVariantId: resolveVariantIdAlias(variantId)",
    );
  });

  it('import-draft returns the SERVER variant once the immediate reconcile lands', () => {
    expect(POS_MODULE).toContain('reconcileLocalVariantImports?.(1, variantId)');
    expect(POS_MODULE).toContain('const serverId = localVariantImportsRepo.getServerVariantId(variantId)');
    expect(POS_MODULE).toContain('resolvedVariant = serverVariant ?? variant');
    expect(POS_MODULE).toContain("outcome: 'LOCAL_IMPORT', variant: resolvedVariant, syncPending");
  });

  it('exposes the mutation-blocked import id list over IPC in both preloads', () => {
    expect(POS_MODULE).toContain("'pos:local-variant-imports:list-unresolved-ids'");
    expect(POS_MODULE).toContain('localVariantImportsRepo.getAdminMutationBlockedVariantIds()');
    expect(PRELOAD_POS).toContain('listUnresolvedIds');
    expect(PRELOAD).toContain('listUnresolvedIds');
  });
});

describe('renderer blocks edits on every local import alias', () => {
  it('ProductModule tracks mutation-blocked import ids and passes importPending down', () => {
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
