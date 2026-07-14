import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as catalogNames from '../src/shared/catalog-names';

type DiffNameTranslations = (
  original: Record<string, string>,
  current: Record<string, string>,
  locales: readonly string[],
) => Record<string, string>;

const diffNameTranslations = (
  catalogNames as unknown as { diffNameTranslations?: DiffNameTranslations }
).diffNameTranslations;

const root = resolve(__dirname, '..');

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');
}

describe('Product Admin display-name contract', () => {
  it('builds a trimmed merge patch only for changed VI, PL, and EN values', () => {
    expect(diffNameTranslations).toBeTypeOf('function');
    expect(diffNameTranslations!(
      { vi: 'Dau vai', pl: 'Karkowka', en: 'Pork shoulder', de: 'Schweinenacken' },
      { vi: '  Dau vai gion  ', pl: 'Karkowka', en: '', de: 'Changed but unsupported' },
      ['vi', 'pl', 'en'],
    )).toEqual({
      vi: 'Dau vai gion',
      en: '',
    });
  });

  it('returns no patch when editable display names are unchanged', () => {
    expect(diffNameTranslations).toBeTypeOf('function');
    expect(diffNameTranslations!(
      { vi: 'Dau vai', pl: 'Karkowka' },
      { vi: ' Dau vai ', pl: 'Karkowka', en: '' },
      ['vi', 'pl', 'en'],
    )).toEqual({});
  });

  it('gates display-name editing on capability v2 through renderer and main process', () => {
    const sharedTypes = source('src/shared/types.ts');
    const apiClient = source('src/main/network/api-client.ts');
    const posModule = source('src/main/modules/pos.module.ts');
    const productModule = source('src/renderer/components/products/ProductModule.tsx');
    const editView = source('src/renderer/components/products/ProductEditView.tsx');
    const editForm = source('src/renderer/components/products/ProductEditForm.tsx');

    expect(sharedTypes).toContain('canEditDisplayName: boolean;');
    expect(sharedTypes).toContain('nameTranslations?: Record<string, string | null>;');
    expect(apiClient).toContain('canEditDisplayName: raw?.canEditDisplayName === true');
    expect(posModule).toContain('canEditDisplayName: false');
    expect(productModule).toContain('adminCapabilities.version >= 2 && adminCapabilities.canEditDisplayName === true');
    expect(productModule).toContain('canEditDisplayName={canEditDisplayName}');
    expect(editView).toContain('canEditDisplayName={canEditDisplayName}');
    expect(editForm).toContain('canEditDisplayName: boolean;');
    expect(posModule).toContain('capabilities.version >= 2 && capabilities.canEditDisplayName === true');
    expect(posModule).toContain('if (nameTranslations !== undefined && !canSendDisplayName)');
    expect(posModule).toContain("error.code = 'UNSUPPORTED_CAPABILITY'");
  });

  it('keeps translation-only PATCH payloads free of canonical product fields', () => {
    const editForm = source('src/renderer/components/products/ProductEditForm.tsx');

    expect(editForm).toContain("const DISPLAY_NAME_LOCALES = ['vi', 'pl', 'en'] as const;");
    expect(editForm).toContain('const variantFieldsDirty = useMemo');
    expect(editForm).toContain('const translationsDirty = Object.keys(nameTranslationsPatch).length > 0;');
    expect(editForm).toContain('if (variantFieldsDirty) {');
    expect(editForm).toContain('if (translationsDirty && canEditDisplayName) {');
    expect(editForm).toContain('payload.nameTranslations = nameTranslationsPatch;');

    const initialPayload = editForm.match(
      /const payload: ProductAdminUpdateVariantInput = \{[\s\S]*?\n    \};/,
    )?.[0] ?? '';
    expect(editForm).toContain('const expectedUpdatedAt = editBaseline.expectedUpdatedAt;');
    expect(initialPayload).toContain('expectedUpdatedAt,');
    expect(initialPayload).not.toContain('name:');
    expect(initialPayload).not.toContain('barcode:');
  });

  it('shows only Vietnamese, Polish, and optional English display-name fields', () => {
    const editForm = source('src/renderer/components/products/ProductEditForm.tsx');
    const translations = source('src/renderer/i18n/translations.ts');

    expect(editForm).toContain("products.edit.displayNameVi");
    expect(editForm).toContain("products.edit.displayNamePl");
    expect(editForm).toContain("products.edit.displayNameEn");
    expect(editForm).not.toContain("products.edit.displayNameDe");
    expect(translations).toContain("'products.edit.displayNameVi': 'Tên hiển thị tiếng Việt'");
    expect(translations).toContain("'products.edit.displayNamePl': 'Tên trên hóa đơn / fiscal (Ba Lan)'");
  });
});
