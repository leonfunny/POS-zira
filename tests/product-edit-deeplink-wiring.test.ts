import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

const APP = source('src/renderer/App.tsx');
const POS_LAYOUT = source('src/renderer/components/pos/POSLayout.tsx');
const RETAIL = source('src/renderer/components/pos/templates/retail/RetailTemplate.tsx');
const CART = source('src/renderer/components/pos/Cart.tsx');
const CART_ITEM = source('src/renderer/components/pos/CartItem.tsx');
const ORDERS = source('src/renderer/components/OrdersTab.tsx');
const PRODUCT_MODULE = source('src/renderer/components/products/ProductModule.tsx');
const CAPABILITIES_HOOK = source('src/renderer/hooks/useProductAdminCapabilities.ts');

describe('deep-link plumbing', () => {
  it('App owns the request and hands it to ProductModule', () => {
    expect(APP).toContain('productEditRequest');
    expect(APP).toContain('openVariantId={productEditRequest?.variantId}');
    expect(APP).toContain('onExitExternal={exitProductEdit}');
  });

  it('App clears a stale request when the user leaves the products tab', () => {
    expect(APP).toMatch(/activeTab !== 'products'/);
  });

  it('App drops the capabilities cache when the user changes', () => {
    expect(APP).toContain('resetProductAdminCapabilitiesCache()');
  });

  it('App does not cache a pre-login no-auth capabilities response', () => {
    expect(APP).toContain('useProductAdminCapabilities(isAuthenticated)');
    expect(CAPABILITIES_HOOK).toContain('if (!enabled)');
    expect(CAPABILITIES_HOOK).toContain('cache = next.error ? null : next');
  });

  it('gates the pencil on the products tab being reachable, not just the capability', () => {
    // canUpdateProduct is a backend role flag; visibleTabs is entitlements +
    // Module Manager overrides. Hide the Products tab while keeping the role and
    // the capability-only guard renders a pencil that bounces the operator onto
    // visibleTabs[0] and edits nothing.
    const guard = APP.slice(
      APP.indexOf('const canEditProductsFromSale'),
      APP.indexOf('const requestProductEdit'),
    );
    expect(guard.length).toBeGreaterThan(0);
    expect(guard).toContain('canUpdateProduct === true');
    expect(guard).toContain("visibleTabs.includes('products')");
  });

  it('the kiosk fullscreen POS branch never receives onEditProduct', () => {
    const kioskBranch = APP.slice(
      APP.indexOf('if (isPosFullscreen'),
      APP.indexOf('// Fullscreen check-in mode'),
    );
    expect(kioskBranch.length).toBeGreaterThan(0);
    expect(kioskBranch).not.toContain('onEditProduct');
  });

  it('the prop is threaded POSLayout -> RetailTemplate -> Cart -> CartItem', () => {
    expect(POS_LAYOUT).toContain('onEditProduct?: (variantId: string) => void');
    expect(POS_LAYOUT).toContain('onEditProduct={onEditProduct}');
    expect(RETAIL).toContain('handleEditCartProduct');
    expect(CART).toContain('onEditProduct?: (item: CartItem) => void');
    expect(CART).toContain('onEditProduct={onEditProduct}');
    expect(CART_ITEM).toContain('onEditProduct && item.variantId');
  });

  it('keeps the cart pencil icon-only so the quantity stepper is not clipped', () => {
    // Print + Remove already carry text. A third label pushes the button row past
    // the 296px cart column; the right group is shrink-0, so the stepper (which is
    // overflow-hidden) loses its -/+ buttons instead.
    const editBlock = CART_ITEM.slice(CART_ITEM.indexOf('{onEditProduct && item.variantId'));
    const markup = editBlock.slice(0, editBlock.indexOf('</button>'));
    expect(markup.length).toBeGreaterThan(0);
    expect(markup).toContain('h-11 w-11');
    expect(markup).toContain("aria-label={tOr('pos.cart.editProduct', 'Edit product')}");
    expect(markup).not.toContain('<span>');
  });

  it('Orders lines expose variant_id and the pencil', () => {
    expect(ORDERS).toContain('variant_id?: string | null');
    expect(ORDERS).toContain("'orders.item.editProduct'");
  });

  it('ProductModule never calls getCapabilities directly any more', () => {
    expect(PRODUCT_MODULE).not.toContain('pos.productAdmin.getCapabilities');
    expect(PRODUCT_MODULE).toContain('useProductAdminCapabilities');
  });
});
