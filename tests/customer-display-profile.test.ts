import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CUSTOMER_DISPLAY_LIVE_PROFILES,
  CUSTOMER_DISPLAY_RESERVED_PROFILES,
  isLiveCustomerDisplayProfile,
  resolveCustomerDisplayProfile,
} from '../src/shared/customer-display-profile';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('customer display profile contract', () => {
  it('keeps live profiles separate from reserved profiles', () => {
    expect(CUSTOMER_DISPLAY_LIVE_PROFILES).toEqual([
      'retail_assisted',
      'salon_checkin',
      'promo_only',
    ]);
    expect(CUSTOMER_DISPLAY_RESERVED_PROFILES).toEqual([
      'retail_self_checkout',
      'restaurant_table_display',
    ]);
  });

  it('accepts only live profiles for first-slice routing', () => {
    expect(isLiveCustomerDisplayProfile('retail_assisted')).toBe(true);
    expect(isLiveCustomerDisplayProfile('salon_checkin')).toBe(true);
    expect(isLiveCustomerDisplayProfile('promo_only')).toBe(true);
    expect(isLiveCustomerDisplayProfile('retail_self_checkout')).toBe(false);
    expect(isLiveCustomerDisplayProfile('restaurant_table_display')).toBe(false);
    expect(isLiveCustomerDisplayProfile('unknown')).toBe(false);
  });

  it('uses an explicit live profile over posMode defaults', () => {
    expect(resolveCustomerDisplayProfile({
      customerDisplayProfile: 'promo_only',
      posMode: 'salon',
    })).toBe('promo_only');
  });

  it('maps missing or reserved profile values from posMode', () => {
    expect(resolveCustomerDisplayProfile({ posMode: 'salon' })).toBe('salon_checkin');
    expect(resolveCustomerDisplayProfile({ posMode: 'retail' })).toBe('retail_assisted');
    expect(resolveCustomerDisplayProfile({ posMode: 'b2b' })).toBe('retail_assisted');
    expect(resolveCustomerDisplayProfile({ posMode: 'restaurant' })).toBe('retail_assisted');
    expect(resolveCustomerDisplayProfile({
      customerDisplayProfile: 'retail_self_checkout',
      posMode: 'retail',
    })).toBe('retail_assisted');
  });
});

describe('customer display profile runtime wiring', () => {
  it('flushes the selected Settings profile before opening the customer display', () => {
    const settingsSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/Settings.tsx'),
      'utf8',
    );
    const openCallIndex = settingsSource.indexOf("window.electronAPI.window.open('customer')");
    const handlerStartIndex = settingsSource.lastIndexOf('onClick={async () =>', openCallIndex);

    expect(openCallIndex).toBeGreaterThan(-1);
    expect(handlerStartIndex).toBeGreaterThan(-1);

    const openCall = "window.electronAPI.window.open('customer')";
    const openHandlerSource = settingsSource.slice(handlerStartIndex, openCallIndex + openCall.length);

    expect(settingsSource).toContain('customerDisplayProfileRef.current = nextProfile;');
    expect(settingsSource).toContain('customerDisplayProfileSelectRef');
    expect(openHandlerSource).toContain('const payload = buildGeneralConfigPayload({');
    expect(openHandlerSource).toContain('customerDisplayProfile: currentCustomerDisplayProfile');
    expect(openHandlerSource).toContain('customerDisplayProfileSelectRef.current?.value');
    expect(openHandlerSource).toContain('await Promise.resolve(onConfigChange(payload));');
    expect(openHandlerSource.indexOf('onConfigChange(payload)')).toBeLessThan(
      openHandlerSource.indexOf(openCall),
    );
  });

  it('allows blank POS language while saving the customer display profile payload', () => {
    const storeSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/main/config/store.ts'),
      'utf8',
    );

    expect(storeSource).toContain("posLanguage: { type: 'string', enum: ['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl', ''] }");
  });

  it('reloads customer display profile config when the customer window receives a refresh event', () => {
    const appSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/windows/customer/CustomerApp.tsx'),
      'utf8',
    );

    expect(appSource).toContain('loadCustomerDisplayConfig');
    expect(appSource).toContain('onRefreshConfig');
    expect(appSource).toContain('resolveCustomerDisplayProfile(config)');
  });

  it('normalizes retail customer display mode immediately after opening', () => {
    const retailSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/pos/templates/retail/RetailTemplate.tsx'),
      'utf8',
    );
    const handlerStart = retailSource.indexOf('const handleOpenCustomerDisplay');
    const handlerEnd = retailSource.indexOf('const handleCloseCustomerDisplay', handlerStart);
    const handler = retailSource.slice(handlerStart, handlerEnd);

    expect(handler).toContain("window.electronAPI.window.open('customer')");
    expect(handler).toContain("type: 'display/setMode'");
    expect(handler).toContain("mode: cart.items.length > 0 ? 'cart' : 'idle'");
  });
});
