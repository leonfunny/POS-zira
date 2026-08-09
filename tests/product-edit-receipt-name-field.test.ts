import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

const FORM = source('src/renderer/components/products/ProductEditForm.tsx');
const EDIT_VIEW = source('src/renderer/components/products/ProductEditView.tsx');
const CREATE_DIALOG = source('src/renderer/components/products/ProductCreateDialog.tsx');
const ADVANCED_GUARD = '{advancedOpen && canEditDisplayName ?';
const PL_INPUT = 'current, pl: event.target.value';

describe('the field that prints is always visible', () => {
  it('the Polish input sits above the Advanced accordion', () => {
    const advancedIndex = FORM.indexOf(ADVANCED_GUARD);
    const polishIndex = FORM.indexOf(PL_INPUT);
    expect(advancedIndex, 'Advanced guard not found').toBeGreaterThanOrEqual(0);
    expect(polishIndex, 'Polish input not found').toBeGreaterThanOrEqual(0);
    expect(polishIndex).toBeLessThan(advancedIndex);
  });

  it('the Advanced accordion no longer owns the Polish input', () => {
    const advancedBlock = FORM.slice(FORM.indexOf(ADVANCED_GUARD));
    expect(advancedBlock).not.toContain(PL_INPUT);
  });

  it('a server without display-name support gets a read-only field, never a hidden one', () => {
    expect(FORM).toContain('readOnly={!canEditDisplayName}');
    expect(FORM).toContain("'products.edit.displayNameUnavailable'");
  });

  it('the form previews what the receipt will print', () => {
    expect(FORM).toContain("import { receiptNamePreview } from './receipt-name-preview'");
    expect(FORM).toContain('receiptNamePreview(name, displayNames)');
    expect(FORM).toContain("'products.edit.receiptFallbackWarning'");
    expect(FORM).toContain("'products.edit.receiptFiscalFold'");
  });

  it('the multi-variant warning travels with the Polish field', () => {
    const advancedIndex = FORM.indexOf(ADVANCED_GUARD);
    const warningIndex = FORM.indexOf("'products.edit.displayNameAllVariants'");
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(advancedIndex);
  });
});

describe('the product detail view surfaces the receipt name before editing', () => {
  it('replaces the duplicated display-name row with the shared receipt preview', () => {
    expect(EDIT_VIEW).toContain('parseTranslations, resolveName, resolveProductLabelName');
    expect(EDIT_VIEW).toContain("import { receiptNamePreview } from './receipt-name-preview'");
    expect(EDIT_VIEW).toContain('receiptNamePreview(\n    product.name,\n    parseTranslations(product.name_translations),\n  )');
    expect(EDIT_VIEW).toContain("'products.edit.displayNamePl'");
    expect(EDIT_VIEW).not.toContain("'products.drawer.displayName'");
    expect(EDIT_VIEW).toContain("'products.drawer.canonicalName'");
  });

  it('shows printer-safe text only when it differs and warns on canonical fallback', () => {
    expect(EDIT_VIEW).toContain('{receiptPreview.fiscalSafe !== receiptPreview.value ? (');
    expect(EDIT_VIEW).not.toContain('receiptPreview.fiscalSafe && receiptPreview.fiscalSafe !== receiptPreview.value');
    expect(EDIT_VIEW).toContain("{receiptPreview.fiscalSafe || '-'}");
    expect(EDIT_VIEW).toContain("'products.edit.receiptFiscalFold'");
    expect(EDIT_VIEW).toContain("receiptPreview.source === 'canonical'");
    expect(EDIT_VIEW).toContain("'products.edit.receiptFallbackWarning'");
  });
});

describe('the create dialog admits the new product has no Polish name', () => {
  it('warns that the canonical name is what will print', () => {
    expect(CREATE_DIALOG).toContain("'products.create.receiptNameHint'");
  });

  it('shows the ELZAB-folded string so diacritics are not a surprise', () => {
    expect(CREATE_DIALOG).toContain("import { receiptNamePreview } from './receipt-name-preview'");
    expect(CREATE_DIALOG).toContain('receiptNamePreview(name, {})');
  });
});
