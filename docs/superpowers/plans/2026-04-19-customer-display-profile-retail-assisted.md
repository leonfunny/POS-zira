# Customer Display Profile + Retail Assisted Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit customer display profiles and ship a read-only retail-assisted customer display without building self-checkout.

**Architecture:** Add one shared profile resolver, store the selected profile in config, and route display behavior by profile in `PosStore` before the renderer sees unsafe modes. Keep existing salon check-in behavior behind `salon_checkin`; render new retail-specific views for `retail_assisted`; make `promo_only` passive at the state level, not merely visually hidden in `CustomerApp`.

**Tech Stack:** Electron main process, React renderer, TypeScript, Tailwind CSS, Vitest, Vite, Playwright/Electron screenshots.

---

## Scope Guard

This plan implements only:

- Live selectable profiles: `retail_assisted`, `salon_checkin`, `promo_only`.
- Reserved profile constants: `retail_self_checkout`, `restaurant_table_display`.
- Migration defaults:
  - `posMode === 'salon'` -> `salon_checkin`
  - `posMode === 'retail'` or `posMode === 'b2b'` -> `retail_assisted`
  - `posMode === 'restaurant'` -> `retail_assisted` temporarily
- Retail-assisted display copy in English and Polish with no customer self-scan language.
- Promo-only behavior is enforced in `PosStore`: adding cart items must not force the customer display into cart/check-in UI.

Do not implement:

- Full self-checkout.
- Customer cart mutation.
- Customer pay controls.
- BLIK entry on the customer display.
- Payment creation changes.
- Receipt printing changes.
- Cash drawer changes.
- Database schema changes.
- Kiosk/window-management changes.
- Closed/out-of-service UI unless it falls out naturally from profile routing without extra state or settings.

## File Structure

Create:

- `src/shared/customer-display-profile.ts` - profile constants, live/reserved separation, type guards, and migration/default resolver.
- `src/renderer/windows/customer/views/RetailAssistedIdleView.tsx` - no-cart retail-assisted screen with assisted copy only.
- `src/renderer/windows/customer/views/RetailAssistedCartView.tsx` - read-only retail cart/payment-status screen.
- `src/renderer/windows/customer/views/RetailAssistedThankYouView.tsx` - retail thank-you screen with no salon booking QR.
- `tests/customer-display-profile.test.ts` - resolver and type-guard tests.
- `tests/e2e/screenshot-customer-display-profiles.mjs` - Electron/Playwright screenshot capture.

Modify:

- `src/shared/types.ts`
- `src/main/config/store.ts`
- `src/main/pos/pos-store.ts`
- `tests/pos-store.test.ts`
- `src/renderer/windows/customer/customer-display-model.ts`
- `src/renderer/windows/customer/CustomerApp.tsx`
- `src/renderer/hooks/usePosStore.ts`
- `src/renderer/components/Settings.tsx`
- `src/renderer/i18n/translations.ts`
- `tests/customer-display-viewport.test.ts`

## Task 1: Shared Profile Contract And Resolver

**Files:**
- Create: `tests/customer-display-profile.test.ts`
- Create: `src/shared/customer-display-profile.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/windows/customer/customer-display-model.ts`

- [ ] **Step 1: Add failing resolver tests**

Create `tests/customer-display-profile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_DISPLAY_LIVE_PROFILES,
  CUSTOMER_DISPLAY_RESERVED_PROFILES,
  isLiveCustomerDisplayProfile,
  resolveCustomerDisplayProfile,
} from '../src/shared/customer-display-profile';

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
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npm test -- tests/customer-display-profile.test.ts
```

Expected: fails because `src/shared/customer-display-profile.ts` does not exist.

- [ ] **Step 3: Add shared profile types**

In `src/shared/types.ts`, add these exports near the existing POS type area, before `AgentConfig`:

```ts
export type LiveCustomerDisplayProfile =
  | 'retail_assisted'
  | 'salon_checkin'
  | 'promo_only';

export type ReservedCustomerDisplayProfile =
  | 'retail_self_checkout'
  | 'restaurant_table_display';

export type CustomerDisplayProfile =
  | LiveCustomerDisplayProfile
  | ReservedCustomerDisplayProfile;
```

Add this field to `AgentConfig` next to the existing customer display fields:

```ts
  customerDisplayProfile?: CustomerDisplayProfile; // Live: retail_assisted, salon_checkin, promo_only. Reserved values are not selectable.
```

- [ ] **Step 4: Add the shared resolver**

Create `src/shared/customer-display-profile.ts`:

```ts
import type {
  AgentConfig,
  CustomerDisplayProfile,
  LiveCustomerDisplayProfile,
  ReservedCustomerDisplayProfile,
} from './types';

export const CUSTOMER_DISPLAY_LIVE_PROFILES: LiveCustomerDisplayProfile[] = [
  'retail_assisted',
  'salon_checkin',
  'promo_only',
];

export const CUSTOMER_DISPLAY_RESERVED_PROFILES: ReservedCustomerDisplayProfile[] = [
  'retail_self_checkout',
  'restaurant_table_display',
];

export function isCustomerDisplayProfile(value?: string): value is CustomerDisplayProfile {
  return [
    ...CUSTOMER_DISPLAY_LIVE_PROFILES,
    ...CUSTOMER_DISPLAY_RESERVED_PROFILES,
  ].includes(value as CustomerDisplayProfile);
}

export function isLiveCustomerDisplayProfile(value?: string): value is LiveCustomerDisplayProfile {
  return CUSTOMER_DISPLAY_LIVE_PROFILES.includes(value as LiveCustomerDisplayProfile);
}

export function resolveCustomerDisplayProfile(
  config?: Pick<AgentConfig, 'customerDisplayProfile' | 'posMode'> | null,
): LiveCustomerDisplayProfile {
  if (isLiveCustomerDisplayProfile(config?.customerDisplayProfile)) {
    return config.customerDisplayProfile;
  }

  if (config?.posMode === 'salon') return 'salon_checkin';
  return 'retail_assisted';
}
```

- [ ] **Step 5: Re-export profile helpers for customer display renderer code**

At the bottom of `src/renderer/windows/customer/customer-display-model.ts`, add:

```ts
export {
  CUSTOMER_DISPLAY_LIVE_PROFILES,
  CUSTOMER_DISPLAY_RESERVED_PROFILES,
  isCustomerDisplayProfile,
  isLiveCustomerDisplayProfile,
  resolveCustomerDisplayProfile,
} from '../../../shared/customer-display-profile';
export type {
  CustomerDisplayProfile,
  LiveCustomerDisplayProfile,
  ReservedCustomerDisplayProfile,
} from '../../../shared/types';
```

- [ ] **Step 6: Run the focused test to verify it passes**

Run:

```powershell
npm test -- tests/customer-display-profile.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit Task 1**

Run:

```powershell
git add src/shared/types.ts src/shared/customer-display-profile.ts src/renderer/windows/customer/customer-display-model.ts tests/customer-display-profile.test.ts
git commit -m "feat(pos): add customer display profile contract"
```

## Task 2: Config Schema And PosStore State Gating

**Files:**
- Modify: `src/main/config/store.ts`
- Modify: `src/main/pos/pos-store.ts`
- Modify: `tests/pos-store.test.ts`

- [ ] **Step 1: Make the PosStore config mock mutable**

In `tests/pos-store.test.ts`, replace the current config-store mock with:

```ts
const mockConfig: Record<string, unknown> = {};

vi.mock('../src/main/config/store', () => ({
  getConfigValue: vi.fn((key: string) => {
    if (Object.prototype.hasOwnProperty.call(mockConfig, key)) return mockConfig[key];
    if (key === 'customerDisplayIdleTimeout') return 120000;
    if (key === 'customerDisplayPromoInterval') return 5000;
    return undefined;
  }),
}));
```

Update the existing `beforeEach`:

```ts
beforeEach(async () => {
  vi.useFakeTimers();
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  const mod = await import('../src/main/pos/pos-store');
  PosStore = mod.PosStore;
});
```

- [ ] **Step 2: Add failing touch-routing and promo-only cart tests**

First, update the existing `handleTouch transitions from idle to interactive` test so the old salon behavior is explicitly under the salon profile:

```ts
  it('handleTouch transitions from idle to interactive for salon_checkin', () => {
    mockConfig.customerDisplayProfile = 'salon_checkin';
    const store = new PosStore();
    expect(store.getState().display.mode).toBe('idle');
    store.handleTouch();
    expect(store.getState().display.mode).toBe('interactive');
    store.destroy();
  });
```

Inside `describe('Display state transitions', () => { ... })`, add:

```ts
  it('does not open check-in or interactive flow when profile is retail_assisted', () => {
    mockConfig.customerDisplayProfile = 'retail_assisted';
    const store = new PosStore();
    store.setSalonDisplayInfo({ salonName: 'Retail Shop' });

    store.handleTouch();

    expect(store.getState().display.mode).toBe('idle');
    store.destroy();
  });

  it('does not open check-in or interactive flow when profile is promo_only', () => {
    mockConfig.customerDisplayProfile = 'promo_only';
    const store = new PosStore();
    store.setSalonDisplayInfo({ salonName: 'Promo Screen' });

    store.handleTouch();

    expect(store.getState().display.mode).toBe('idle');
    store.destroy();
  });

  it('preserves salon touch behavior when profile is salon_checkin', () => {
    mockConfig.customerDisplayProfile = 'salon_checkin';
    const store = new PosStore();
    store.setSalonDisplayInfo({ salonName: 'Salon' });

    store.handleTouch();

    expect(store.getState().display.mode).toBe('checkin');
    store.destroy();
  });

  it('keeps promo_only in promo mode when an item is added during promo', () => {
    mockConfig.customerDisplayProfile = 'promo_only';
    const store = new PosStore();
    store.dispatch({
      type: 'display/setMode',
      payload: { mode: 'promo', promoImages: ['promo-a.jpg'] },
    });

    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });

    expect(store.getState().cart.items).toHaveLength(1);
    expect(store.getState().display.mode).toBe('promo');
    store.destroy();
  });

  it('keeps promo_only customer-safe when an item is added during idle', () => {
    mockConfig.customerDisplayProfile = 'promo_only';
    const store = new PosStore();

    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });

    expect(store.getState().cart.items).toHaveLength(1);
    expect(store.getState().display.mode).toBe('idle');
    expect(store.getState().display.mode).not.toBe('cart');
    expect(store.getState().display.mode).not.toBe('checkin');
    store.destroy();
  });

  it('still switches retail_assisted display to cart when an item is added', () => {
    mockConfig.customerDisplayProfile = 'retail_assisted';
    const store = new PosStore();

    store.dispatch({ type: 'cart/addItem', payload: sampleItem() });

    expect(store.getState().cart.items).toHaveLength(1);
    expect(store.getState().display.mode).toBe('cart');
    store.destroy();
  });
```

- [ ] **Step 3: Run the focused test to verify it fails**

Run:

```powershell
npm test -- tests/pos-store.test.ts
```

Expected: fails because `handleTouch()` still opens check-in/interactive without checking profile, and `cart/addItem` still forces `promo_only` displays into `cart`.

- [ ] **Step 4: Add config schema entry**

In `src/main/config/store.ts`, add this schema entry next to `customerDisplayEnabled`:

```ts
    customerDisplayProfile: {
      type: 'string',
      enum: ['retail_assisted', 'salon_checkin', 'promo_only', 'retail_self_checkout', 'restaurant_table_display'],
    },
```

- [ ] **Step 5: Gate PosStore touch and cart-add behavior by live profile**

In `src/main/pos/pos-store.ts`, add:

```ts
import type { AgentConfig, LiveCustomerDisplayProfile } from '../../shared/types';
import { resolveCustomerDisplayProfile } from '../../shared/customer-display-profile';
```

Change the reducer signature so profile-dependent display routing is handled in `PosStore`, not only in `CustomerApp`:

```ts
interface PosReducerOptions {
  customerDisplayProfile?: LiveCustomerDisplayProfile;
}

function posReducer(
  state: PosState,
  action: PosAction,
  options: PosReducerOptions = {},
): PosState {
```

In the `cart/addItem` case, replace the current `nextMode` calculation with:

```ts
      const currentMode = state.display.mode;
      const nextMode = options.customerDisplayProfile === 'promo_only'
        ? (currentMode === 'promo' ? 'promo' : 'idle')
        : currentMode === 'checkin' || currentMode === 'interactive'
          ? currentMode
          : 'cart';
```

This is the core guardrail: `promo_only` remains passive at the state/routing level, while `retail_assisted` still changes to `cart` when staff adds an item.

Add this private method inside `PosStore`, near `getState()`:

```ts
  private getCustomerDisplayProfile(): LiveCustomerDisplayProfile {
    return resolveCustomerDisplayProfile({
      customerDisplayProfile: getConfigValue('customerDisplayProfile') as AgentConfig['customerDisplayProfile'],
      posMode: getConfigValue('posMode') as AgentConfig['posMode'],
    });
  }
```

In `dispatch(action: PosAction)`, replace:

```ts
    this.state = posReducer(this.state, action);
```

with:

```ts
    this.state = posReducer(this.state, action, {
      customerDisplayProfile: this.getCustomerDisplayProfile(),
    });
```

At the start of `handleTouch()`, after the existing mode guard, add:

```ts
    const profile = this.getCustomerDisplayProfile();
    if (profile !== 'salon_checkin') {
      logger.info(`[PosStore] Ignoring customer touch for profile=${profile}`);
      return;
    }
```

- [ ] **Step 6: Run the focused test to verify it passes**

Run:

```powershell
npm test -- tests/pos-store.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit Task 2**

Run:

```powershell
git add src/main/config/store.ts src/main/pos/pos-store.ts tests/pos-store.test.ts
git commit -m "feat(pos): gate customer display state by profile"
```

## Task 3: Settings Profile Selector

**Files:**
- Modify: `src/renderer/components/Settings.tsx`
- Modify: `src/renderer/i18n/translations.ts`

- [ ] **Step 1: Add Settings translation keys**

In the English `en` object in `src/renderer/i18n/translations.ts`, add these keys near the existing customer display settings keys:

```ts
    'settings.customerDisplayProfile': 'Display profile',
    'settings.customerDisplayProfileDesc': 'Choose what the customer-facing screen is allowed to do.',
    'settings.customerDisplayProfile.retail_assisted': 'Retail assisted customer display',
    'settings.customerDisplayProfile.salon_checkin': 'Salon check-in',
    'settings.customerDisplayProfile.promo_only': 'Promo only',
```

Do not add selectable labels for `retail_self_checkout` or `restaurant_table_display`.

- [ ] **Step 2: Add Settings state and config payload wiring**

In `src/renderer/components/Settings.tsx`, add:

```ts
import type { LiveCustomerDisplayProfile } from '../../shared/types';
import { resolveCustomerDisplayProfile } from '../../shared/customer-display-profile';
```

Add state near the existing customer display state:

```ts
  const [customerDisplayProfile, setCustomerDisplayProfile] = useState<LiveCustomerDisplayProfile>(
    resolveCustomerDisplayProfile(config as any),
  );
```

Add `customerDisplayProfile` to `buildGeneralConfigPayload()`:

```ts
    customerDisplayProfile,
```

Add it to the dependency array for `buildGeneralConfigPayload`.

In the config reload block, add:

```ts
      setCustomerDisplayProfile(resolveCustomerDisplayProfile(config as any));
```

- [ ] **Step 3: Add the selector UI**

In the Customer Display settings section, after the enable toggle and before the Open Customer Display button, add:

```tsx
            {customerDisplayEnabled && (
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  {t('settings.customerDisplayProfile')}
                </label>
                <select
                  value={customerDisplayProfile}
                  onChange={(e) => setCustomerDisplayProfile(e.target.value as LiveCustomerDisplayProfile)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-300 focus:border-brand-400 outline-none"
                >
                  <option value="retail_assisted">{t('settings.customerDisplayProfile.retail_assisted')}</option>
                  <option value="salon_checkin">{t('settings.customerDisplayProfile.salon_checkin')}</option>
                  <option value="promo_only">{t('settings.customerDisplayProfile.promo_only')}</option>
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  {t('settings.customerDisplayProfileDesc')}
                </p>
              </div>
            )}
```

- [ ] **Step 4: Verify the selector is typed and reserved profiles are not selectable**

Run:

```powershell
npm run typecheck:renderer
```

Expected: pass.

- [ ] **Step 5: Commit Task 3**

Run:

```powershell
git add src/renderer/components/Settings.tsx src/renderer/i18n/translations.ts
git commit -m "feat(pos): add customer display profile setting"
```

## Task 4: Retail-Assisted View Components

**Files:**
- Create: `src/renderer/windows/customer/views/RetailAssistedIdleView.tsx`
- Create: `src/renderer/windows/customer/views/RetailAssistedCartView.tsx`
- Create: `src/renderer/windows/customer/views/RetailAssistedThankYouView.tsx`
- Modify: `src/renderer/i18n/translations.ts`
- Modify: `tests/customer-display-viewport.test.ts`

- [ ] **Step 1: Add English and Polish retail-assisted copy keys**

In the English `en` object in `src/renderer/i18n/translations.ts`, add:

```ts
    'customer.retail.idleTitle': 'Staff will scan your items',
    'customer.retail.idleSubtitle': 'Your items will appear here',
    'customer.retail.cartTitle': 'Your items',
    'customer.retail.cartSubtitle': 'Staff will continue adding your items',
    'customer.retail.paymentPrompt': 'Staff will take payment when ready',
    'customer.retail.paymentStatus': 'Payment status',
    'customer.retail.total': 'Total',
    'customer.retail.thankYou': 'Thank you',
    'customer.retail.thankYouSubtitle': 'Your payment is complete',
```

In the Polish `pl` object, add the matching public-facing retail-assisted copy:

```ts
    'customer.retail.idleTitle': 'Obsługa zeskanuje Twoje produkty',
    'customer.retail.idleSubtitle': 'Twoje produkty pojawią się tutaj',
    'customer.retail.cartTitle': 'Twoje produkty',
    'customer.retail.cartSubtitle': 'Obsługa doda kolejne produkty',
    'customer.retail.paymentPrompt': 'Obsługa przyjmie płatność, gdy zamówienie będzie gotowe',
    'customer.retail.paymentStatus': 'Status płatności',
    'customer.retail.total': 'Razem',
    'customer.retail.thankYou': 'Dziękujemy',
    'customer.retail.thankYouSubtitle': 'Płatność zakończona',
```

Do not use self-scan copy such as "scan product", "touch product to start", or "pay now" for `retail_assisted`.

- [ ] **Step 2: Add viewport tests for the new retail views**

In `tests/customer-display-viewport.test.ts`, add imports:

```ts
import RetailAssistedIdleView from '../src/renderer/windows/customer/views/RetailAssistedIdleView';
import RetailAssistedCartView from '../src/renderer/windows/customer/views/RetailAssistedCartView';
import RetailAssistedThankYouView from '../src/renderer/windows/customer/views/RetailAssistedThankYouView';
```

Add these tests inside `describe('Customer display viewport contract', () => { ... })`:

```ts
  it('renders retail assisted idle copy without self-scan language', () => {
    const t = (key: string) => ({
      'customer.retail.idleTitle': 'Staff will scan your items',
      'customer.retail.idleSubtitle': 'Your items will appear here',
      'customer.retail.paymentPrompt': 'Staff will take payment when ready',
      'customer.brandName': 'Zira AI',
    }[key] || key);

    const markup = renderToStaticMarkup(
      React.createElement(RetailAssistedIdleView, {
        t,
        businessName: 'Retail Shop',
      }),
    );

    expect(markup).toContain('Staff will scan your items');
    expect(markup).toContain('Your items will appear here');
    expect(markup).not.toMatch(/scan a product|self-checkout|pay now/i);
  });

  it('renders retail assisted cart without salon upsell copy', () => {
    const t = (key: string) => ({
      'customer.retail.cartTitle': 'Your items',
      'customer.retail.cartSubtitle': 'Staff will continue adding your items',
      'customer.retail.paymentPrompt': 'Staff will take payment when ready',
      'customer.retail.paymentStatus': 'Payment status',
      'customer.retail.total': 'Total',
      'customer.discount': 'Discount',
      'customer.retail.idleSubtitle': 'Your items will appear here',
    }[key] || key);

    const markup = renderToStaticMarkup(
      React.createElement(RetailAssistedCartView, {
        t,
        language: 'en',
        cart: {
          items: [
            { id: '1', variantId: 'v1', name: 'Coffee', sku: 'COF', price: 1000, quantity: 2, total: 2000 },
          ],
          subtotal: 2000,
          discount: 0,
          tax: 0,
          total: 2000,
        },
      }),
    );

    expect(markup).toContain('Your items');
    expect(markup).toContain('Staff will continue adding your items');
    expect(markup).not.toContain('Complete your look');
    expect(markup).not.toContain('Add to my visit');
  });

  it('renders retail assisted thank-you without salon booking copy', () => {
    const t = (key: string) => ({
      'customer.retail.thankYou': 'Thank you',
      'customer.retail.thankYouSubtitle': 'Your payment is complete',
    }[key] || key);

    const markup = renderToStaticMarkup(
      React.createElement(RetailAssistedThankYouView, {
        t,
        language: 'en',
        lastOrderTotal: 2000,
      }),
    );

    expect(markup).toContain('Your payment is complete');
    expect(markup).not.toContain('Book your next visit');
    expect(markup).not.toContain('Scan to book online');
  });

  it('includes Polish public copy for retail assisted display', () => {
    const translationsSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/i18n/translations.ts'),
      'utf8',
    );

    expect(translationsSource).toContain("'customer.retail.idleTitle': 'Obsługa zeskanuje Twoje produkty'");
    expect(translationsSource).toContain("'customer.retail.idleSubtitle': 'Twoje produkty pojawią się tutaj'");
    expect(translationsSource).toContain("'customer.retail.paymentPrompt': 'Obsługa przyjmie płatność, gdy zamówienie będzie gotowe'");
    expect(translationsSource).toContain("'customer.retail.thankYouSubtitle': 'Płatność zakończona'");
  });
```

- [ ] **Step 3: Run the viewport test to verify it fails**

Run:

```powershell
npm test -- tests/customer-display-viewport.test.ts
```

Expected: fails because the retail-assisted view files do not exist.

- [ ] **Step 4: Create `RetailAssistedIdleView.tsx`**

Create `src/renderer/windows/customer/views/RetailAssistedIdleView.tsx`:

```tsx
import React, { useEffect, useState } from 'react';

interface RetailAssistedIdleViewProps {
  t: (key: string) => string;
  businessName?: string;
}

export default function RetailAssistedIdleView({ t, businessName }: RetailAssistedIdleViewProps) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 10000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-950">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-10 py-6">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            {businessName || t('customer.brandName')}
          </div>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">
            {t('customer.retail.idleTitle')}
          </h1>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-2xl font-semibold tabular-nums">
          {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 items-center justify-center px-10">
        <div className="w-full max-w-5xl rounded-lg border border-slate-200 bg-white p-12 text-center shadow-sm">
          <p className="text-6xl font-semibold tracking-tight text-slate-950">
            {t('customer.retail.idleSubtitle')}
          </p>
          <p className="mx-auto mt-8 max-w-3xl text-2xl leading-10 text-slate-600">
            {t('customer.retail.paymentPrompt')}
          </p>
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Create `RetailAssistedCartView.tsx`**

Create `src/renderer/windows/customer/views/RetailAssistedCartView.tsx`:

```tsx
import React from 'react';
import type { CartState } from '../../../hooks/usePosStore';
import type { Language } from '../../../i18n/translations';
import { formatDisplayCurrency } from '../customer-display-model';

interface RetailAssistedCartViewProps {
  cart: CartState;
  t: (key: string) => string;
  language: Language;
  paymentStatus?: string;
}

export default function RetailAssistedCartView({ cart, t, language, paymentStatus }: RetailAssistedCartViewProps) {
  const rows = cart.items.slice(-8);

  return (
    <div className="flex h-screen bg-slate-50 text-slate-950">
      <section className="flex min-w-0 flex-1 flex-col px-10 py-8">
        <header className="mb-6">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            {t('customer.retail.cartTitle')}
          </div>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">
            {t('customer.retail.cartSubtitle')}
          </h1>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          {rows.length === 0 ? (
            <div className="flex h-full items-center justify-center px-8 text-center text-3xl font-semibold text-slate-500">
              {t('customer.retail.idleSubtitle')}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {rows.map((item) => (
                <div key={item.id} className="grid grid-cols-[1fr_110px_180px] items-center gap-6 px-8 py-5">
                  <div className="min-w-0">
                    <div className="truncate text-3xl font-semibold text-slate-950">{item.name}</div>
                    {item.sku && <div className="mt-1 truncate text-base text-slate-500">{item.sku}</div>}
                  </div>
                  <div className="text-right text-3xl font-semibold tabular-nums text-slate-700">x{item.quantity}</div>
                  <div className="text-right text-3xl font-semibold tabular-nums text-slate-950">
                    {formatDisplayCurrency(item.total, language)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <aside className="flex w-[420px] shrink-0 flex-col border-l border-slate-200 bg-white px-8 py-8">
        <div className="flex-1">
          <div className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            {t('customer.retail.total')}
          </div>
          <div className="mt-4 text-right text-6xl font-bold tabular-nums text-brand-700">
            {formatDisplayCurrency(cart.total, language)}
          </div>
          {cart.discount > 0 && (
            <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-5 text-2xl font-semibold text-emerald-700">
              <span>{t('customer.discount')}</span>
              <span className="tabular-nums">-{formatDisplayCurrency(cart.discount, language)}</span>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
          <div className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            {t('customer.retail.paymentStatus')}
          </div>
          <div className="mt-3 text-2xl font-semibold text-slate-900">
            {paymentStatus || t('customer.retail.paymentPrompt')}
          </div>
        </div>
      </aside>
    </div>
  );
}
```

- [ ] **Step 6: Create `RetailAssistedThankYouView.tsx`**

Create `src/renderer/windows/customer/views/RetailAssistedThankYouView.tsx`:

```tsx
import React from 'react';
import type { Language } from '../../../i18n/translations';
import { formatDisplayCurrency } from '../customer-display-model';

interface RetailAssistedThankYouViewProps {
  lastOrderTotal?: number;
  t: (key: string) => string;
  language: Language;
}

export default function RetailAssistedThankYouView({ lastOrderTotal, t, language }: RetailAssistedThankYouViewProps) {
  return (
    <div className="flex h-screen items-center justify-center bg-slate-50 px-10 text-slate-950">
      <div className="w-full max-w-4xl rounded-lg border border-slate-200 bg-white p-12 text-center shadow-sm">
        <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border-2 border-emerald-200 bg-emerald-50 text-emerald-600">
          <svg className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="mt-8 text-6xl font-semibold tracking-tight">{t('customer.retail.thankYou')}</h1>
        <p className="mt-5 text-3xl text-slate-600">{t('customer.retail.thankYouSubtitle')}</p>
        {lastOrderTotal != null && lastOrderTotal > 0 && (
          <div className="mt-10 text-6xl font-bold tabular-nums text-brand-700">
            {formatDisplayCurrency(lastOrderTotal, language)}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Run the viewport test**

Run:

```powershell
npm test -- tests/customer-display-viewport.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit Task 4**

Run:

```powershell
git add src/renderer/windows/customer/views/RetailAssistedIdleView.tsx src/renderer/windows/customer/views/RetailAssistedCartView.tsx src/renderer/windows/customer/views/RetailAssistedThankYouView.tsx src/renderer/i18n/translations.ts tests/customer-display-viewport.test.ts
git commit -m "feat(pos): add retail assisted customer display views"
```

## Task 5: CustomerApp Profile Routing

**Files:**
- Modify: `src/renderer/windows/customer/CustomerApp.tsx`
- Modify: `src/renderer/hooks/usePosStore.ts`
- Modify: `tests/customer-display-viewport.test.ts`

- [ ] **Step 1: Add optional renderer typing for display profile**

In `src/renderer/hooks/usePosStore.ts`, add:

```ts
import type { CustomerDisplayProfile } from '../../shared/types';
```

Add this optional field to `DisplayState`:

```ts
  profile?: CustomerDisplayProfile;
```

This field is optional because runtime routing resolves from config in this slice.

- [ ] **Step 2: Add profile routing imports**

In `src/renderer/windows/customer/CustomerApp.tsx`, add:

```ts
import type { LiveCustomerDisplayProfile } from '../../../shared/types';
import { resolveCustomerDisplayProfile } from '../../../shared/customer-display-profile';
import RetailAssistedCartView from './views/RetailAssistedCartView';
import RetailAssistedIdleView from './views/RetailAssistedIdleView';
import RetailAssistedThankYouView from './views/RetailAssistedThankYouView';
```

- [ ] **Step 3: Add profile state and config resolution without startup flicker**

In `CustomerApp`, add state next to the language state. Do not default to `retail_assisted`; a default route can briefly show the wrong public screen before config resolves.

```ts
  const [displayProfile, setDisplayProfile] = useState<LiveCustomerDisplayProfile | null>(null);
```

Replace the existing `window.electronAPI.getConfig().then((config: any) => { ... })` block with:

```ts
    window.electronAPI.getConfig().then((config: any) => {
      setLang(resolveCustomerDisplayLanguage(config));
      setDisplayProfile(resolveCustomerDisplayProfile(config));
    });
```

After the callback hooks and before the first existing display-mode render branch, add this neutral loading shell:

```tsx
  if (!displayProfile) {
    return <div className="h-screen bg-slate-50" aria-label="Loading customer display" />;
  }
```

This avoids the tiny but real startup flicker from rendering the wrong profile before `getConfig()` returns.

- [ ] **Step 4: Route `promo_only` before display mode**

Before the existing `if (displayMode === 'promo')` block, add:

```tsx
  if (displayProfile === 'promo_only') {
    if (displayMode === 'promo') {
      return (
        <PromoView
          images={display?.promoImages || []}
          intervalMs={display?.promoIntervalMs || 5000}
        />
      );
    }

    return (
      <RetailAssistedIdleView
        t={t}
        businessName={display?.salonName}
      />
    );
  }
```

This is a renderer-level defense for unexpected states. Task 2 is still required because normal `cart/addItem` routing must keep `promo_only` passive in `PosStore`.

- [ ] **Step 5: Route `retail_assisted` before salon modes**

Immediately after the `promo_only` block, add:

```tsx
  if (displayProfile === 'retail_assisted') {
    if (displayMode === 'promo') {
      return (
        <div onClick={handleScreenTouch}>
          <PromoView
            images={display?.promoImages || []}
            intervalMs={display?.promoIntervalMs || 5000}
          />
        </div>
      );
    }

    if (displayMode === 'cart' && state?.cart) {
      return (
        <RetailAssistedCartView
          cart={state.cart}
          t={t}
          language={lang}
          paymentStatus={paymentStatus}
        />
      );
    }

    if (displayMode === 'thankyou') {
      return (
        <RetailAssistedThankYouView
          lastOrderTotal={display?.lastOrderTotal}
          t={t}
          language={lang}
        />
      );
    }

    return (
      <RetailAssistedIdleView
        t={t}
        businessName={display?.salonName}
      />
    );
  }
```

The existing `checkin` and `interactive` branches must stay below this block. That preserves those branches only for `salon_checkin`.

- [ ] **Step 6: Add a static routing guard test**

In `tests/customer-display-viewport.test.ts`, extend the existing source inspection test for `CustomerApp.tsx` with:

```ts
    expect(appSource).toContain("displayProfile === 'promo_only'");
    expect(appSource).toContain("displayProfile === 'retail_assisted'");
    expect(appSource).toContain('useState<LiveCustomerDisplayProfile | null>(null)');
    expect(appSource).toContain('if (!displayProfile)');
    expect(appSource.indexOf('if (!displayProfile)')).toBeLessThan(appSource.indexOf("displayProfile === 'promo_only'"));
    expect(appSource.indexOf("displayProfile === 'retail_assisted'")).toBeLessThan(appSource.indexOf("displayMode === 'checkin'"));
    expect(appSource.indexOf("displayProfile === 'promo_only'")).toBeLessThan(appSource.indexOf("displayMode === 'checkin'"));
```

- [ ] **Step 7: Run focused renderer tests**

Run:

```powershell
npm test -- tests/customer-display-viewport.test.ts tests/customer-display-profile.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit Task 5**

Run:

```powershell
git add src/renderer/windows/customer/CustomerApp.tsx src/renderer/hooks/usePosStore.ts tests/customer-display-viewport.test.ts
git commit -m "feat(pos): route customer display by profile"
```

## Task 6: Screenshot Capture Script

**Files:**
- Create: `tests/e2e/screenshot-customer-display-profiles.mjs`

- [ ] **Step 1: Create the screenshot script**

Create `tests/e2e/screenshot-customer-display-profiles.mjs` with this script:

```js
import { _electron as electron } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'docs', 'screenshots');
mkdirSync(OUT_DIR, { recursive: true });

function run(command) {
  const result = spawnSync(command, { cwd: ROOT, shell: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Command failed: ${command}`);
}

async function configure(page, profile, posMode = 'retail') {
  await page.evaluate(async ({ profile, posMode }) => {
    await window.electronAPI.setConfig({
      posEnabled: true,
      posMode,
      customerDisplayEnabled: true,
      customerDisplayForceKiosk: false,
      customerDisplayProfile: profile,
    });
  }, { profile, posMode });
}

async function openCustomerWindow(page, app) {
  await page.evaluate(async () => {
    await window.electronAPI.window.open('customer');
  });
  await page.waitForTimeout(1000);
  const customer = app.windows().find((candidate) => candidate !== page);
  if (!customer) throw new Error('Customer display window did not open');
  await customer.waitForLoadState('domcontentloaded');
  return customer;
}

async function screenshot(page, name, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(OUT_DIR, `${name}-${width}x${height}.png`),
    fullPage: true,
  });
}

async function dispatch(page, action) {
  await page.evaluate(async (action) => {
    await window.electronAPI.pos.dispatch(action);
  }, action);
  await page.waitForTimeout(400);
}

async function captureBothSizes(page, name) {
  await screenshot(page, name, 1280, 720);
  await screenshot(page, name, 1600, 900);
}

async function main() {
  run('npm run build');

  const tempUserData = mkdtempSync(join(tmpdir(), 'zira-display-profile-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${tempUserData}`],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      E2E_TEST: '1',
      ELECTRON_USER_DATA_DIR: tempUserData,
    },
    timeout: 30000,
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  await configure(page, 'retail_assisted', 'retail');
  const customer = await openCustomerWindow(page, app);
  await captureBothSizes(customer, 'display-on-retail-assisted-idle');

  await dispatch(page, {
    type: 'cart/addItem',
    payload: { id: 'shot-item-1', variantId: 'shot-var-1', name: 'Coffee Beans', sku: 'COF-001', price: 2499, quantity: 2, total: 4998, vatRate: 23 },
  });
  await dispatch(page, {
    type: 'cart/addItem',
    payload: { id: 'shot-item-2', variantId: 'shot-var-2', name: 'Chocolate Bar', sku: 'CHO-001', price: 699, quantity: 1, total: 699, vatRate: 23 },
  });
  await dispatch(page, { type: 'cart/applyDiscount', payload: { amount: 500 } });
  await captureBothSizes(customer, 'display-on-retail-assisted-cart');

  await dispatch(page, { type: 'display/setMode', payload: { mode: 'cart', paymentStatus: 'Waiting for terminal' } });
  await captureBothSizes(customer, 'display-on-retail-assisted-payment');

  await dispatch(page, { type: 'display/setMode', payload: { mode: 'thankyou', lastOrderTotal: 5197 } });
  await captureBothSizes(customer, 'display-on-retail-assisted-thankyou');

  await configure(page, 'salon_checkin', 'salon');
  await dispatch(page, { type: 'cart/clear' });
  await page.evaluate(async () => { await window.electronAPI.display.touch(); });
  await page.waitForTimeout(500);
  await captureBothSizes(customer, 'display-on-salon-checkin-route');

  await configure(page, 'promo_only', 'retail');
  await dispatch(page, {
    type: 'cart/addItem',
    payload: { id: 'promo-only-item', variantId: 'promo-only-var', name: 'Hidden Cart Item', sku: 'HID-001', price: 1000, quantity: 1, total: 1000, vatRate: 23 },
  });
  await page.evaluate(async () => { await window.electronAPI.display.touch(); });
  await page.waitForTimeout(500);
  await captureBothSizes(customer, 'display-on-promo-only-suppressed');

  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run the script after Tasks 1-5 are complete**

Run:

```powershell
node tests/e2e/screenshot-customer-display-profiles.mjs
```

Expected screenshot files under `docs/screenshots/`:

- `display-on-retail-assisted-idle-1280x720.png`
- `display-on-retail-assisted-idle-1600x900.png`
- `display-on-retail-assisted-cart-1280x720.png`
- `display-on-retail-assisted-cart-1600x900.png`
- `display-on-retail-assisted-payment-1280x720.png`
- `display-on-retail-assisted-payment-1600x900.png`
- `display-on-retail-assisted-thankyou-1280x720.png`
- `display-on-retail-assisted-thankyou-1600x900.png`
- `display-on-salon-checkin-route-1280x720.png`
- `display-on-salon-checkin-route-1600x900.png`
- `display-on-promo-only-suppressed-1280x720.png`
- `display-on-promo-only-suppressed-1600x900.png`

- [ ] **Step 3: Commit Task 6**

Run:

```powershell
git add tests/e2e/screenshot-customer-display-profiles.mjs docs/screenshots
git commit -m "test(pos): capture customer display profile screenshots"
```

## Task 7: Full Verification

**Files:**
- No code edits unless a command fails and the failure is inside the first-slice scope.

- [ ] **Step 1: Run targeted tests**

Run:

```powershell
npm test -- tests/customer-display-profile.test.ts tests/pos-store.test.ts tests/customer-display-viewport.test.ts
```

Expected: all listed test files pass.

- [ ] **Step 2: Run renderer typecheck**

Run:

```powershell
npm run typecheck:renderer
```

Expected: exit code 0.

- [ ] **Step 3: Run renderer build**

Run:

```powershell
npm run build:renderer
```

Expected: exit code 0 and Vite writes `dist/renderer`.

- [ ] **Step 4: Run whitespace diff check**

Run:

```powershell
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 5: Capture Electron/Playwright screenshots**

Run:

```powershell
node tests/e2e/screenshot-customer-display-profiles.mjs
```

Expected: all screenshot files listed in Task 6 Step 2 exist.

- [ ] **Step 6: Review diff scope**

Run:

```powershell
git diff --name-only HEAD
```

Expected changed files are limited to the files named in this plan plus generated screenshots. The diff must not include payment creation, receipt printing, cash drawer, database schema, or kiosk window-management changes.

- [ ] **Step 7: Commit verification fixes only when files changed in Task 7**

When Task 7 produces first-slice fixes, run:

```powershell
git add src tests docs/screenshots
git commit -m "fix(pos): polish customer display profile slice"
```

When Task 7 produces no file changes, do not create an empty commit.

## Self-Review Checklist

- Spec coverage:
  - `customerDisplayProfile` contract: Task 1.
  - Config schema and Settings selector: Tasks 2 and 3.
  - Live profiles only selectable: Task 3.
  - Reserved profiles not selectable: Tasks 1 and 3.
  - Migration defaults: Task 1.
  - Profile routing before display mode: Task 5.
  - Disable touch-to-check-in for `retail_assisted` and `promo_only`: Task 2.
  - Prevent `promo_only` `cart/addItem` from forcing cart/check-in modes in `PosStore`: Task 2.
  - Preserve salon behavior under `salon_checkin`: Tasks 2 and 5.
  - Retail-specific views without salon copy, upsells, nail placeholder, or self-scan copy: Task 4.
  - Polish customer-facing retail-assisted copy: Task 4.
  - Startup profile flicker avoided by waiting for config before profile routing: Task 5.
  - No self-checkout: Scope Guard and Task 4 copy tests.
  - Required verification commands and screenshots: Tasks 6 and 7.
- Placeholder scan:
  - No task uses placeholder markers or unspecified implementation instructions.
- Type consistency:
  - `CustomerDisplayProfile` includes live and reserved values.
  - `LiveCustomerDisplayProfile` is what Settings and runtime routing use.
  - `resolveCustomerDisplayProfile()` returns only a live profile.
