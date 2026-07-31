import { describe, expect, it } from 'vitest';
import { isFeatureEnabled, isFeatureEnabledStrict } from '../src/main/entitlements/entitlements-controller';

function entitlements(billiard?: { enabled: boolean; expiresAt?: string }) {
  return {
    salonId: 's1',
    salonCode: '',
    salonName: 'Test',
    plan: 'free',
    suggestedPosMode: null,
    features: billiard ? { billiard: { featureKey: 'billiard', ...billiard } } : {},
    fetchedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  } as any;
}

describe('isFeatureEnabledStrict (billiard side-effect gate)', () => {
  it('never fires off missing/offline entitlements, unlike the permissive default', () => {
    // The permissive default keeps the POS usable offline…
    expect(isFeatureEnabled('billiard' as any, undefined)).toBe(true);
    // …but cross-ledger side effects must stay silent at that point.
    expect(isFeatureEnabledStrict('billiard' as any, undefined)).toBe(false);
    expect(isFeatureEnabledStrict('billiard' as any, entitlements(undefined))).toBe(false);
  });

  it('fires only on an explicit server-side enable', () => {
    expect(isFeatureEnabledStrict('billiard' as any, entitlements({ enabled: true }))).toBe(true);
    expect(isFeatureEnabledStrict('billiard' as any, entitlements({ enabled: false }))).toBe(false);
  });

  it('respects expiry', () => {
    expect(isFeatureEnabledStrict('billiard' as any, entitlements({
      enabled: true,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }))).toBe(false);
  });
});
