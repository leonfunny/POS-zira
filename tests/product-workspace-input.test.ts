import { describe, expect, it, vi } from 'vitest';
import {
  decodeProductImageDataUrl,
  captureProductAdminSessionContext,
  isProductAdminSessionContextCurrent,
  mergeProductAdminNullableMirrorFields,
  normalizeProductReceiptInput,
  productAdminCanonicalUpdatedAt,
  productAdminCategoryToRow,
  redactProductAdminPurchaseData,
  requireProductAdminExpectedUpdatedAt,
  sanitizeExistingProductInventoryModeUpdate,
  shouldApplyProductAdminVariantMirror,
} from '../src/main/pos/product-workspace-input';

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error: any) {
    return error?.code;
  }
}

describe('product workspace IPC input boundary', () => {
  it('rejects existing inventory-mode transitions and omits unchanged dangerous fields', () => {
    const trackedPiece = {
      sell_by: 'PIECE',
      item_type: 'stockable',
      track_inventory: 1,
    } as any;

    expect(() => sanitizeExistingProductInventoryModeUpdate(
      { sellBy: 'WEIGHT' },
      trackedPiece,
    )).toThrow('existing-product-inventory-mode-transition-unavailable');
    expect(errorCode(() => sanitizeExistingProductInventoryModeUpdate(
      { itemType: 'service' },
      trackedPiece,
    ))).toBe('INVENTORY_MODE_TRANSITION_UNSUPPORTED');
    expect(errorCode(() => sanitizeExistingProductInventoryModeUpdate(
      { trackInventory: false },
      trackedPiece,
    ))).toBe('INVENTORY_MODE_TRANSITION_UNSUPPORTED');

    const untrackedPiece = {
      sell_by: 'PIECE',
      item_type: 'stockable',
      track_inventory: 0,
    } as any;
    expect(errorCode(() => sanitizeExistingProductInventoryModeUpdate(
      { trackInventory: true },
      untrackedPiece,
    ))).toBe('INVENTORY_MODE_TRANSITION_UNSUPPORTED');

    const untrackedService = {
      sell_by: 'PIECE',
      item_type: 'service',
      track_inventory: 1,
    } as any;
    expect(errorCode(() => sanitizeExistingProductInventoryModeUpdate(
      { itemType: 'stockable' },
      untrackedService,
    ))).toBe('INVENTORY_MODE_TRANSITION_UNSUPPORTED');

    expect(sanitizeExistingProductInventoryModeUpdate({
      name: 'Renamed',
      sellBy: 'PIECE',
      itemType: 'stockable',
      trackInventory: true,
    }, trackedPiece)).toEqual({ name: 'Renamed' });
  });

  it('clears canonical nullable fields on explicit null but preserves absent legacy fields', () => {
    const existing = {
      template_id: 'template-old',
      sku: 'SKU-OLD',
      barcode: '5900000000017',
      category_id: 'category-old',
      sale_unit: 'szt',
      sell_by: 'PIECE',
      name_translations: JSON.stringify({ pl: 'Stara nazwa' }),
    } as any;

    expect(mergeProductAdminNullableMirrorFields({
      templateId: null,
      sku: null,
      barcode: null,
      categoryId: null,
      saleUnit: null,
      sellBy: null,
      nameTranslations: null,
    } as any, existing)).toEqual({
      template_id: null,
      sku: null,
      barcode: null,
      category_id: null,
      sale_unit: null,
      sell_by: null,
      name_translations: null,
    });

    expect(mergeProductAdminNullableMirrorFields({} as any, existing)).toEqual(existing);
  });

  it('rejects an older or unversioned product-admin mirror without blocking a newer canonical revision', () => {
    const existing = { updated_at: '2026-07-14T10:00:03.000Z' } as any;

    expect(shouldApplyProductAdminVariantMirror(
      { updatedAt: '2026-07-14T10:00:02.000Z' },
      existing,
    )).toBe(false);
    expect(shouldApplyProductAdminVariantMirror(
      { updatedAt: '2026-07-14T10:00:03.000Z' },
      existing,
    )).toBe(true);
    expect(shouldApplyProductAdminVariantMirror(
      { updatedAt: '2026-07-14T10:00:04.000Z' },
      existing,
    )).toBe(true);
    expect(shouldApplyProductAdminVariantMirror({}, existing)).toBe(false);
    expect(shouldApplyProductAdminVariantMirror({ updatedAt: 'not-a-date' }, existing)).toBe(false);
    expect(shouldApplyProductAdminVariantMirror(
      { updatedAt: '2026-07-14T10:00:04.000Z' },
      { updated_at: 'not-a-date' } as any,
    )).toBe(true);
    expect(shouldApplyProductAdminVariantMirror({}, null)).toBe(true);
    expect(productAdminCanonicalUpdatedAt({
      updatedAt: '2026-07-14T10:00:01.000Z',
      canonicalUpdatedAt: '2026-07-14T10:00:05.000Z',
    } as any)).toBe('2026-07-14T10:00:05.000Z');
    expect(shouldApplyProductAdminVariantMirror({
      updatedAt: '2026-07-14T10:00:01.000Z',
      canonicalUpdatedAt: '2026-07-14T10:00:05.000Z',
    } as any, existing)).toBe(true);
  });

  it('maps a created category response directly into the local catalog shape', () => {
    expect(productAdminCategoryToRow({
      id: 'category-1',
      name: ' Tea ',
      icon: 'DR',
      color: '#2563eb',
      sortOrder: 4,
      isActive: true,
      kitchenPrint: true,
      updatedAt: '2026-07-14T10:00:05.000Z',
    })).toEqual({
      id: 'category-1',
      name: 'Tea',
      icon: 'DR',
      color: '#2563eb',
      sort_order: 4,
      updated_at: '2026-07-14T10:00:05.000Z',
      kitchen_print: 1,
    });
  });

  it('merges a partial reorder response without erasing catalog-only category fields', () => {
    const existing = {
      id: 'category-1',
      name: 'Tea',
      icon: 'DR',
      color: '#2563eb',
      sort_order: 7,
      updated_at: '2026-07-14T10:00:00.000Z',
      name_translations: JSON.stringify({ vi: 'Trà' }),
      customer_display_enabled: 0,
      customer_display_section: 'cold-drinks',
      customer_display_sort_order: 12,
      kitchen_print: 1,
      kiosk_modifier_groups_json: '[{"id":"size"}]',
    } as any;

    expect(productAdminCategoryToRow({
      id: 'category-1',
      name: 'Tea',
      isActive: true,
      updatedAt: '2026-07-14T10:01:00.000Z',
    } as any, existing)).toEqual({
      ...existing,
      updated_at: '2026-07-14T10:01:00.000Z',
    });
  });

  it('fails closed before an existing-variant API call when OCC requires a revision token', () => {
    const apiCall = vi.fn();
    const capabilities = { supportsOptimisticConcurrency: true } as any;

    for (const token of [undefined, null, '', 'not-an-iso-date']) {
      expect(() => {
        const expectedUpdatedAt = requireProductAdminExpectedUpdatedAt(capabilities, token);
        apiCall(expectedUpdatedAt);
      }).toThrowError(expect.objectContaining({ code: 'STALE_PRODUCT', status: 409 }));
    }
    expect(apiCall).not.toHaveBeenCalled();
    expect(requireProductAdminExpectedUpdatedAt(
      capabilities,
      '2026-07-14T10:00:03.123Z',
    )).toBe('2026-07-14T10:00:03.123Z');
    expect(requireProductAdminExpectedUpdatedAt(
      { supportsOptimisticConcurrency: false } as any,
      undefined,
    )).toBeUndefined();
  });

  it('detects product-admin auth or tenant context changes without retaining config references', () => {
    const config = {
      serverUrl: 'https://api.example.test',
      salonSlug: 'salon-a',
      salonCode: '1001',
      agentId: 'agent-a',
    };
    const captured = captureProductAdminSessionContext('token-a', config);
    config.salonSlug = 'salon-b';

    expect(captured.salonSlug).toBe('salon-a');
    expect(isProductAdminSessionContextCurrent(captured, 'token-a', {
      ...config,
      salonSlug: 'salon-a',
    })).toBe(true);
    expect(isProductAdminSessionContextCurrent(captured, 'token-b', {
      ...config,
      salonSlug: 'salon-a',
    })).toBe(false);
    expect(isProductAdminSessionContextCurrent(captured, 'token-a', config)).toBe(false);
    expect(isProductAdminSessionContextCurrent(captured, 'token-a', {
      ...config,
      salonSlug: 'salon-a',
      serverUrl: 'https://other.example.test',
    })).toBe(false);
  });

  it('accepts a real PNG signature and sanitizes the multipart filename', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    const decoded = decodeProductImageDataUrl({
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      mimeType: 'image/png',
      fileName: '..\\unsafe name.exe',
    });

    expect(decoded.mimeType).toBe('image/png');
    expect(decoded.fileName).toBe('unsafe-name.png');
    expect(Buffer.from(decoded.bytes)).toEqual(png);
  });

  it('rejects a MIME label that does not match the image magic bytes', () => {
    const fake = Buffer.from('not actually a png');
    expect(errorCode(() => decodeProductImageDataUrl({
      dataUrl: `data:image/png;base64,${fake.toString('base64')}`,
      mimeType: 'image/png',
    }))).toBe('INVALID_IMAGE');
  });

  it('normalizes receipt text, preserves the stable key, and omits null cost', () => {
    const normalized = normalizeProductReceiptInput({
      quantity: 1.125,
      unitCostGrosze: null,
      lotNumber: ' LOT-7 ',
      expirationDate: '2027-01-31',
      reason: ' delivery ',
      idempotencyKey: ' receipt-stable-key ',
    } as any);

    expect(normalized).toEqual({
      quantity: 1.125,
      unitCostGrosze: undefined,
      lotNumber: 'LOT-7',
      expirationDate: '2027-01-31',
      reason: 'delivery',
      expectedUpdatedAt: undefined,
      idempotencyKey: 'receipt-stable-key',
    });
  });

  it.each([0, 0.0009, 1.0001, 10_000_000])(
    'rejects quantity outside the backend 0.001..9,999,999 / 3-decimal contract: %s',
    (quantity) => {
      expect(errorCode(() => normalizeProductReceiptInput({
        quantity,
        idempotencyKey: 'receipt-key',
      }))).toBe('INVALID_STOCK_QUANTITY');
    },
  );

  it.each([true, '1', [1]])(
    'rejects non-number runtime receipt quantity: %j',
    (quantity) => {
      expect(errorCode(() => normalizeProductReceiptInput({
        quantity,
        idempotencyKey: 'receipt-key',
      } as any))).toBe('INVALID_STOCK_QUANTITY');
    },
  );

  it.each([true, '125', [125]])(
    'rejects non-number runtime receipt unit cost: %j',
    (unitCostGrosze) => {
      expect(errorCode(() => normalizeProductReceiptInput({
        quantity: 1,
        unitCostGrosze,
        idempotencyKey: 'receipt-key',
      } as any))).toBe('INVALID_PRICE');
    },
  );

  it('matches backend text limits and requires a stable idempotency key', () => {
    expect(errorCode(() => normalizeProductReceiptInput({
      quantity: 1,
      lotNumber: 'L'.repeat(101),
      idempotencyKey: 'receipt-key',
    }))).toBe('INVALID_LOT_NUMBER');
    expect(errorCode(() => normalizeProductReceiptInput({
      quantity: 1,
      reason: 'R'.repeat(256),
      idempotencyKey: 'receipt-key',
    }))).toBe('INVALID_REASON');
    expect(errorCode(() => normalizeProductReceiptInput({
      quantity: 1,
      idempotencyKey: '',
    }))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(errorCode(() => normalizeProductReceiptInput({
      quantity: 1,
      idempotencyKey: 'K'.repeat(81),
    }))).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('rejects impossible calendar dates', () => {
    expect(errorCode(() => normalizeProductReceiptInput({
      quantity: 1,
      expirationDate: '2027-02-30',
      idempotencyKey: 'receipt-key',
    }))).toBe('INVALID_EXPIRATION_DATE');
  });

  it('redacts purchase cost from every product-admin response shape without mutating it', () => {
    const original = {
      variant: { id: 'variant-1', purchasePrice: 12.34, purchasePriceGrosze: 1234, name: 'Tea' },
      template: { id: 'template-1', purchasePrice: 12.34, purchasePriceGrosze: 1234, name: 'Tea' },
      product: { id: 'product-1', purchasePrice: 12.34, purchasePriceGrosze: 1234, name: 'Tea' },
      receipt: { moveId: 'move-1', unitCost: 12.34, unitCostGrosze: 1234, quantity: 2 },
      items: [
        { id: 'lot-1', unitCost: 12.34, unitCostGrosze: 1234, quantity: 2 },
        { id: 'lot-2', quantity: 1 },
      ],
      details: {
        purchasePrice: 12.34,
        unitCostGrosze: 1234,
        variant: { id: 'variant-1', purchasePriceGrosze: 1234, name: 'Tea' },
        reason: 'duplicate',
      },
      serverTime: '2026-07-13T00:00:00.000Z',
    };

    const redacted = redactProductAdminPurchaseData(original);

    expect(redacted).toEqual({
      variant: { id: 'variant-1', name: 'Tea' },
      template: { id: 'template-1', name: 'Tea' },
      product: { id: 'product-1', name: 'Tea' },
      receipt: { moveId: 'move-1', quantity: 2 },
      items: [
        { id: 'lot-1', quantity: 2 },
        { id: 'lot-2', quantity: 1 },
      ],
      details: {
        variant: { id: 'variant-1', name: 'Tea' },
        reason: 'duplicate',
      },
      serverTime: '2026-07-13T00:00:00.000Z',
    });
    expect(original.variant.purchasePriceGrosze).toBe(1234);
    expect(original.template.purchasePriceGrosze).toBe(1234);
    expect(original.product.purchasePriceGrosze).toBe(1234);
    expect(original.receipt.unitCostGrosze).toBe(1234);
    expect(original.items[0].unitCostGrosze).toBe(1234);
    expect(original.details.unitCostGrosze).toBe(1234);
    expect(original.details.variant.purchasePriceGrosze).toBe(1234);
  });

  it('redacts nested snake-case purchase cost fields from raw backend JSON', () => {
    const original = {
      details: {
        purchase_price: 12.34,
        nested: {
          purchase_price_grosze: 1234,
          rows: [
            { unit_cost: 6.17, unit_cost_grosze: 617, quantity: 2 },
          ],
        },
        reason: 'duplicate',
      },
    };

    expect(redactProductAdminPurchaseData(original)).toEqual({
      details: {
        nested: { rows: [{ quantity: 2 }] },
        reason: 'duplicate',
      },
    });
    expect(original.details.nested.rows[0].unit_cost_grosze).toBe(617);
  });
});
