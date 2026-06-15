import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseKitchenSelfOrderOptionsJson,
  normalizeKitchenSelfOrderAccentColor,
  resolveKitchenSelfOrderCheckoutAction,
  sanitizeKitchenSelfOrderModifiers,
  serializeKitchenSelfOrderOptions,
  validateKitchenSelfOrderModifierSelections,
  type KitchenSelfOrderModifierGroup,
} from '../src/shared/kitchen-self-order';
import { buildKitchenSelfOrderMenu } from '../src/main/kitchen-self-order/menu-service';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const sweetnessGroup: KitchenSelfOrderModifierGroup = {
  id: 'sweetness',
  name: 'Sweetness',
  selectionMode: 'SINGLE',
  minSelections: 1,
  maxSelections: 1,
  displayOrder: 10,
  options: [
    {
      id: 'sweetness-50',
      name: '50%',
      priceDeltaGrosze: 0,
      isDefault: true,
      isAvailable: true,
    },
    {
      id: 'sweetness-100',
      name: '100%',
      priceDeltaGrosze: 100,
      isDefault: false,
      isAvailable: true,
    },
  ],
};

describe('kitchen self-order modifier contract', () => {
  it('rejects missing required selections and calculates server-snapshot price deltas', () => {
    const missing = validateKitchenSelfOrderModifierSelections([sweetnessGroup], []);
    expect(missing.valid).toBe(false);
    expect(missing.errors).toEqual([
      { groupId: 'sweetness', code: 'MIN_SELECTIONS', required: 1 },
    ]);

    const selected = validateKitchenSelfOrderModifierSelections([sweetnessGroup], [
      {
        groupId: 'sweetness',
        groupName: 'Sweetness',
        optionId: 'sweetness-100',
        optionName: '100%',
        quantity: 1,
        priceDeltaGrosze: 100,
      },
    ]);
    expect(selected.valid).toBe(true);
    expect(selected.modifierTotalGrosze).toBe(100);
  });

  it('sanitizes structured modifier snapshots without inventing options', () => {
    expect(sanitizeKitchenSelfOrderModifiers([
      {
        groupId: ' sweetness ',
        groupName: ' Sweetness ',
        optionId: ' sweetness-50 ',
        optionName: ' 50% ',
        quantity: 200,
        priceDeltaGrosze: 12.6,
      },
      {
        groupId: '',
        groupName: 'Invalid',
        optionId: 'x',
        optionName: 'Invalid',
        quantity: 1,
        priceDeltaGrosze: 0,
      },
    ])).toEqual([
      {
        groupId: 'sweetness',
        groupName: 'Sweetness',
        optionId: 'sweetness-50',
        optionName: '50%',
        quantity: 9,
        priceDeltaGrosze: 13,
      },
    ]);
  });

  it('reads legacy option arrays and the new structured persistence shape', () => {
    expect(parseKitchenSelfOrderOptionsJson(JSON.stringify(['no onion', 'less spicy']))).toEqual({
      modifiers: [],
      legacyOptions: ['no onion', 'less spicy'],
    });

    const json = serializeKitchenSelfOrderOptions([
      {
        groupId: 'ice',
        groupName: 'Ice',
        optionId: 'ice-less',
        optionName: 'Less ice',
        quantity: 1,
        priceDeltaGrosze: 0,
      },
    ], []);
    expect(parseKitchenSelfOrderOptionsJson(json)).toEqual({
      modifiers: [
        {
          groupId: 'ice',
          groupName: 'Ice',
          optionId: 'ice-less',
          optionName: 'Less ice',
          quantity: 1,
          priceDeltaGrosze: 0,
        },
      ],
      legacyOptions: [],
    });
  });
});

describe('kitchen self-order menu contract', () => {
  it('builds a customer menu from cached server fields with category inheritance and product override', () => {
    const menu = buildKitchenSelfOrderMenu({
      config: {
        kitchenSelfOrderBrandName: 'Tenant Tea',
        kitchenSelfOrderAccentColor: '#156B55',
        kitchenSelfOrderCheckoutMode: 'PAY_AT_COUNTER',
        kitchenSelfOrderReleasePolicy: 'ON_SUBMIT',
      },
      categories: [
        {
          id: 'drinks',
          name: 'Drinks',
          icon: null,
          color: null,
          sort_order: 1,
          updated_at: null,
          kitchen_print: 1,
          kiosk_modifier_groups_json: JSON.stringify([sweetnessGroup]),
        },
      ],
      products: [
        {
          id: 'tea-1',
          template_id: 'tea-template',
          name: 'Peach tea',
          sku: 'TEA-1',
          barcode: null,
          retail_price: 2390,
          category_id: 'drinks',
          image_url: 'https://img.example/legacy.png',
          in_stock: 10,
          vat_rate: 23,
          is_active: 1,
          updated_at: null,
          available_qty: 10,
          price_gross: 2390,
          price_net: 0,
          vat_amount: 0,
          is_on_sale: 0,
          thumbnail_url: null,
          sale_unit: 'piece',
          sell_by: 'PIECE',
          kiosk_media_json: JSON.stringify({
            url: 'https://img.example/kiosk.jpg',
            fit: 'COVER',
            focalPoint: { x: 0.5, y: 0.35 },
            zoom: 1.15,
          }),
          kiosk_modifier_groups_json: JSON.stringify([
            {
              ...sweetnessGroup,
              name: 'Sugar level',
            },
          ]),
          kiosk_note_enabled: 1,
        },
        {
          id: 'tea-2',
          template_id: 'tea-template-2',
          name: 'Classic tea',
          sku: 'TEA-2',
          barcode: null,
          retail_price: 1990,
          category_id: 'drinks',
          image_url: 'https://img.example/classic.png',
          in_stock: 10,
          vat_rate: 23,
          is_active: 1,
          updated_at: null,
          available_qty: 10,
          price_gross: 1990,
          price_net: 0,
          vat_amount: 0,
          is_on_sale: 0,
          thumbnail_url: null,
          sale_unit: 'piece',
          sell_by: 'PIECE',
          kiosk_media_json: null,
          kiosk_modifier_groups_json: null,
          kiosk_note_enabled: 0,
        },
      ],
    });

    expect(menu.brand).toEqual({
      name: 'Tenant Tea',
      logoUrl: null,
      accentColor: '#156B55',
    });
    expect(menu.policies).toEqual({
      checkoutMode: 'PAY_AT_COUNTER',
      kitchenReleasePolicy: 'ON_SUBMIT',
      fulfillmentOptions: ['DINE_IN', 'TAKEAWAY'],
    });
    const overriddenProduct = menu.products.find((product) => product.id === 'tea-1')!;
    const inheritedProduct = menu.products.find((product) => product.id === 'tea-2')!;
    expect(overriddenProduct).toMatchObject({
      id: 'tea-1',
      priceGrosze: 2390,
      noteEnabled: true,
      media: {
        url: 'https://img.example/kiosk.jpg',
        fit: 'COVER',
        focalPoint: { x: 0.5, y: 0.35 },
        zoom: 1.15,
      },
    });
    const overriddenGroup = menu.modifierGroups.find((group) =>
      group.attachmentId === overriddenProduct.modifierGroupAttachmentIds[0]);
    const inheritedGroup = menu.modifierGroups.find((group) =>
      group.attachmentId === inheritedProduct.modifierGroupAttachmentIds[0]);
    expect(overriddenGroup?.name).toBe('Sugar level');
    expect(inheritedGroup?.name).toBe('Sweetness');
  });

  it('falls back to legacy contain media and empty modifier groups', () => {
    const menu = buildKitchenSelfOrderMenu({
      config: {},
      categories: [
        {
          id: 'food',
          name: 'Food',
          icon: null,
          color: null,
          sort_order: 1,
          updated_at: null,
          kitchen_print: 1,
        },
      ],
      products: [
        {
          id: 'food-1',
          template_id: null,
          name: 'Simple item',
          sku: null,
          barcode: null,
          retail_price: 1000,
          category_id: 'food',
          image_url: 'https://img.example/item.png',
          in_stock: 1,
          vat_rate: 23,
          is_active: 1,
          updated_at: null,
          available_qty: 1,
          price_gross: 1000,
          price_net: 0,
          vat_amount: 0,
          is_on_sale: 0,
          thumbnail_url: null,
          sale_unit: null,
          sell_by: 'PIECE',
        },
      ],
    });

    expect(menu.products[0].media).toEqual({
      url: 'https://img.example/item.png',
      fit: 'CONTAIN',
      focalPoint: null,
      zoom: 1,
    });
    expect(menu.products[0].modifierGroupAttachmentIds).toEqual([]);
    expect(menu.modifierGroups).toEqual([]);
  });
});

describe('kitchen self-order checkout routing', () => {
  it('submits counter/order-only flows and fails closed without a terminal integration', () => {
    expect(resolveKitchenSelfOrderCheckoutAction('PAY_AT_COUNTER')).toBe('SUBMIT_ORDER');
    expect(resolveKitchenSelfOrderCheckoutAction('ORDER_ONLY')).toBe('SUBMIT_ORDER');
    expect(resolveKitchenSelfOrderCheckoutAction('KIOSK_TERMINAL')).toBe('REQUIRE_TERMINAL');
    expect(resolveKitchenSelfOrderCheckoutAction('PAY_AT_COUNTER', 'ON_PAYMENT_CONFIRMED'))
      .toBe('REQUIRE_TERMINAL');
  });

  it('rejects malformed or low-contrast tenant accents', () => {
    expect(normalizeKitchenSelfOrderAccentColor('#156b55')).toBe('#156B55');
    expect(normalizeKitchenSelfOrderAccentColor('#F2CDBF')).toBe('#DA7756');
    expect(normalizeKitchenSelfOrderAccentColor('orange')).toBe('#DA7756');
  });

  it('limits fulfillment controls to tenant-enabled modes', () => {
    const menu = buildKitchenSelfOrderMenu({
      config: {
        kitchenSelfOrderFulfillmentOptions: ['TAKEAWAY'],
      },
      categories: [],
      products: [],
    });

    expect(menu.policies.fulfillmentOptions).toEqual(['TAKEAWAY']);
  });
});

describe('kitchen self-order IPC and cache wiring', () => {
  it('uses a dedicated menu IPC instead of renderer-side generic catalog assembly', () => {
    const preload = readSource('src/preload/preload-kitchen-self-order.ts');
    const posModule = readSource('src/main/modules/pos.module.ts');
    const app = readSource('src/renderer/windows/kitchen-self-order/KitchenSelfOrderApp.tsx');

    expect(preload).toContain("ipcRenderer.invoke('kitchen-self-order:getMenu')");
    expect(posModule).toContain("ipcMain.handle('kitchen-self-order:getMenu'");
    expect(posModule).toContain('buildKitchenSelfOrderMenu');
    expect(app).toContain('kitchenSelfOrder?.getMenu');
    expect(app).not.toContain('pos?.products?.getAll');
    expect(app).not.toContain('pos?.categories?.getAll');
  });

  it('caches server-owned kiosk media and modifier metadata without local defaults', () => {
    const migrations = readSource('src/main/database/migrations.ts');
    const repo = readSource('src/main/database/repos/product-repo.ts');
    const apiClient = readSource('src/main/network/api-client.ts');
    const applicators = readSource('src/main/sync/entity-applicators.ts');

    expect(migrations).toContain('kiosk_media_json');
    expect(migrations).toContain('kiosk_modifier_groups_json');
    expect(migrations).toContain('kiosk_note_enabled');
    expect(repo).toContain('p.kiosk_media_json');
    expect(apiClient).toContain('kiosk_modifier_groups_json');
    expect(applicators).toContain('kiosk_modifier_groups_json');
  });

  it('persists structured modifier snapshots while keeping legacy option support', () => {
    const repo = readSource('src/main/database/repos/kitchen-self-order-repo.ts');
    const posModule = readSource('src/main/modules/pos.module.ts');

    expect(repo).toContain('serializeKitchenSelfOrderOptions');
    expect(repo).toContain('item.modifiers');
    expect(posModule).toContain('parseKitchenSelfOrderOptionsJson');
    expect(posModule).toContain('formatKitchenSelfOrderModifierLabels');
  });
});
