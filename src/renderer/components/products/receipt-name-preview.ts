import { RECEIPT_NAME_LOCALE, resolveName, type NameTranslations } from '../../../shared/catalog-names';
import { toFiscalSafeItemName } from '../../../shared/fiscal-text';

export type ReceiptNamePreviewSource = typeof RECEIPT_NAME_LOCALE | 'canonical';

export interface ReceiptNamePreview {
  value: string;
  source: ReceiptNamePreviewSource;
  fiscalSafe: string;
}

export function receiptNamePreview(
  canonicalName: string,
  displayNames: NameTranslations,
): ReceiptNamePreview {
  const value = resolveName(
    { name: canonicalName, name_translations: displayNames },
    RECEIPT_NAME_LOCALE,
  );
  const translated = (displayNames[RECEIPT_NAME_LOCALE] ?? '').trim();
  return {
    value,
    source: translated ? RECEIPT_NAME_LOCALE : 'canonical',
    fiscalSafe: toFiscalSafeItemName(value),
  };
}
