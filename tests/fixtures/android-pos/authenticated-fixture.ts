// This fixture is consumed only by external Playwright/ADB verification scripts.
// It must never be imported by the Android renderer production graph.
export const ANDROID_AUTHENTICATED_FIXTURE_MARKER = 'ANDROID_E2E_AUTH_FIXTURE_V1';

export const authenticatedFixture = Object.freeze({
  credentials: Object.freeze({
    identifier: 'android-e2e@example.invalid',
    password: 'route-mocked-password',
  }),
  login: Object.freeze({
    access_token: 'fixture-staff-access-token',
    refresh_token: 'fixture-staff-refresh-token',
    user: Object.freeze({
      id: 'fixture-owner-1',
      email: 'android-e2e@example.invalid',
      firstName: 'Fixture',
      lastName: 'Owner',
      role: 'OWNER',
      salonId: 'fixture-salon-1',
      salon: Object.freeze({ id: 'fixture-salon-1', name: 'Fixture Salon', slug: 'fixture-salon' }),
    }),
  }),
  entitlements: Object.freeze({
    salonId: 'fixture-salon-1', salonCode: '9001', salonName: 'Fixture Salon', plan: 'pro',
    suggestedPosMode: 'salon', features: Object.freeze({ billiard: Object.freeze({ enabled: true }) }),
  }),
  products: Object.freeze({
    items: Object.freeze([
      Object.freeze({ id: 'fixture-product-1', name: 'Test manicure', sku: 'FIX-001', barcode: '5900000000001', retail_price: 4900, priceGrossGrosze: 4900, vat_rate: 23, stock_qty: 20, available_qty: 20, is_active: true }),
    ]),
    hasMore: false, nextSyncCursor: 'fixture-cursor-1', deletedIds: Object.freeze([]), serverTime: '2026-08-10T00:00:00.000Z',
  }),
  categories: Object.freeze({ items: Object.freeze([]) }),
  billiard: Object.freeze({
    floorPlan: Object.freeze({
      id: 'fixture-floor-1', salonId: 'fixture-salon-1', name: 'Fixture Floor',
      floorNumber: 1, isDefault: true, isActive: true, roomWidthM: 16,
      roomHeightM: 10, displayOrder: 1,
      layouts: Object.freeze([
        Object.freeze({
          id: 'fixture-layout-1', resourceId: 'fixture-table-1', floorPlanId: 'fixture-floor-1',
          positionX: 50, positionY: 50, rotation: 0, widthPct: 16, heightPct: 13,
        }),
      ]),
    }),
    dashboard: Object.freeze([
      Object.freeze({
        resource: Object.freeze({
          id: 'fixture-table-1', name: 'Fixture Table 1', salonId: 'fixture-salon-1',
          resourceType: Object.freeze({ id: 'fixture-pool-type', code: 'POOL_TABLE', name: 'Pool table' }),
          pricingRules: Object.freeze({ hourlyRate: 5000 }), metadata: Object.freeze({}),
        }),
        status: 'free', session: null,
        layout: Object.freeze({
          id: 'fixture-layout-1', resourceId: 'fixture-table-1', floorPlanId: 'fixture-floor-1',
          positionX: 50, positionY: 50, rotation: 0, widthPct: 16, heightPct: 13,
          floorPlan: Object.freeze({ id: 'fixture-floor-1', name: 'Fixture Floor', floorNumber: 1 }),
        }),
      }),
    ]),
  }),
});
