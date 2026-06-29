import { describe, expect, it, vi } from 'vitest';

import type { ProductListItem } from '../src/renderer/hooks/useProducts';
import { findDuplicateBarcodeSet, resolveScan } from '../src/renderer/components/products/scan-match';

function product(id: string, barcode: string | null, sku: string | null = null): ProductListItem {
  return {
    id,
    name: `Product ${id}`,
    barcode,
    sku,
  } as ProductListItem;
}

describe('product scan matching', () => {
  it('returns the authoritative exact hit', async () => {
    const hit = product('one', '5901234567890');
    const getByBarcode = vi.fn().mockResolvedValue(hit);

    await expect(resolveScan(hit.barcode!, [hit], getByBarcode)).resolves.toEqual({
      kind: 'one',
      product: hit,
    });
    expect(getByBarcode).toHaveBeenCalledWith('5901234567890');
  });

  it('returns every duplicate before trusting a single repository hit', async () => {
    const first = product('one', '5901234567890');
    const second = product('two', '5901234567890');
    const getByBarcode = vi.fn().mockResolvedValue(first);

    await expect(resolveScan(first.barcode!, [first, second], getByBarcode)).resolves.toEqual({
      kind: 'many',
      products: [first, second],
    });
    expect(getByBarcode).not.toHaveBeenCalled();
  });

  it('treats leading-zero barcode variants as duplicates', () => {
    const padded = product('padded', '0123');
    const plain = product('plain', '123');

    expect(findDuplicateBarcodeSet('0123', [padded, plain])).toEqual([padded, plain]);
  });

  it('treats POS substring barcode matches as duplicates', () => {
    const first = product('first', '1234');
    const second = product('second', '5678');

    expect(findDuplicateBarcodeSet('SCAN-1234-5678', [first, second])).toEqual([first, second]);
  });

  it('treats POS alphanumeric barcode matches as duplicates', () => {
    const withSeparator = product('with-separator', '9A30110=211106000006');
    const compact = product('compact', '9A30110211106000006');

    expect(findDuplicateBarcodeSet('0269A30110211106000006', [withSeparator, compact])).toEqual([
      withSeparator,
      compact,
    ]);
  });

  it('returns none for an unknown code', async () => {
    await expect(resolveScan('missing', [], vi.fn().mockResolvedValue(null))).resolves.toEqual({
      kind: 'none',
      code: 'missing',
    });
  });

  it('keeps SKU fallback in the authoritative repository lookup', async () => {
    const hit = product('sku', null, 'SKU-42');
    const getByBarcode = vi.fn().mockResolvedValue(hit);

    await expect(resolveScan('SKU-42', [hit], getByBarcode)).resolves.toEqual({
      kind: 'one',
      product: hit,
    });
  });
});
