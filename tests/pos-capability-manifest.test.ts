import { describe, expect, test } from 'vitest';

import {
  CASHIER_CAPABILITY_KEYS,
  CASHIER_CAPABILITY_MANIFEST_VERSION,
  createCashierCapabilityManifest,
  createDefaultCashierCapabilityPolicyInputs,
  normalizeCashierCapabilityManifest,
  type CashierCapabilityIdentity,
} from '../src/shared/pos/cashier-capabilities';

const IDENTITY: CashierCapabilityIdentity = {
  salonId: 'salon-1',
  userId: 'user-1',
  registerId: 'register-1',
  authEpoch: 7,
};

function expectAllUnsupported(
  manifest: ReturnType<typeof normalizeCashierCapabilityManifest>,
  reasonCode: string,
) {
  expect(Object.keys(manifest.outcomes)).toEqual([...CASHIER_CAPABILITY_KEYS]);
  for (const outcome of Object.values(manifest.outcomes)) {
    expect(outcome).toEqual({ state: 'unsupported', reasonCode });
  }
}

describe('cashier platform/runtime capability manifest', () => {
  test('has the complete v1 surface and defaults every capability to unsupported', () => {
    expect(CASHIER_CAPABILITY_KEYS).toEqual([
      'loyaltyLookup',
      'restoredCartTender',
      'customerDisplay',
      'nativeProductCreate',
      'debtLedgerExternal',
      'quickAddRecognition',
      'pickupOrders',
      'labelPrint',
      'scale',
    ]);

    const first = createCashierCapabilityManifest(IDENTITY);
    const second = createCashierCapabilityManifest(IDENTITY);

    expect(first.version).toBe(CASHIER_CAPABILITY_MANIFEST_VERSION);
    expect(first.identity).toEqual(IDENTITY);
    expectAllUnsupported(first, 'NOT_DECLARED');
    expect(first.outcomes).not.toBe(second.outcomes);
    expect(first.outcomes.loyaltyLookup).not.toBe(second.outcomes.loyaltyLookup);
  });

  test('accepts and canonically copies a valid complete manifest', () => {
    const input = createCashierCapabilityManifest(IDENTITY, {
      loyaltyLookup: { state: 'supported', reasonCode: 'AVAILABLE' },
      customerDisplay: { state: 'degraded', reasonCode: 'REMOTE_ONLY' },
      nativeProductCreate: {
        state: 'unsupported',
        reasonCode: 'PLATFORM_UNSUPPORTED',
      },
    });

    const normalized = normalizeCashierCapabilityManifest(input, IDENTITY);

    expect(normalized).toEqual(input);
    expect(normalized).not.toBe(input);
    expect(normalized.identity).not.toBe(input.identity);
    expect(normalized.outcomes).not.toBe(input.outcomes);
  });

  test('owns override outcomes instead of retaining caller-mutable references', () => {
    const loyaltyLookup = { state: 'supported', reasonCode: 'AVAILABLE' } as const;
    const manifest = createCashierCapabilityManifest(IDENTITY, { loyaltyLookup });

    (loyaltyLookup as { state: string }).state = 'unsupported';

    expect(manifest.outcomes.loyaltyLookup).toEqual({
      state: 'supported',
      reasonCode: 'AVAILABLE',
    });
    expect(manifest.outcomes.loyaltyLookup).not.toBe(loyaltyLookup);
  });

  test('policy inputs are separate and default unknown instead of granting access', () => {
    const manifest = createCashierCapabilityManifest(IDENTITY, {
      loyaltyLookup: { state: 'supported', reasonCode: 'AVAILABLE' },
    });
    const policy = createDefaultCashierCapabilityPolicyInputs();

    expect(manifest).not.toHaveProperty('salonConfig');
    expect(manifest).not.toHaveProperty('entitlements');
    expect(manifest).not.toHaveProperty('roleAccess');
    for (const key of CASHIER_CAPABILITY_KEYS) {
      expect(policy.salonConfig[key]).toBe('unknown');
      expect(policy.entitlements[key]).toBe('unknown');
      expect(policy.roleAccess[key]).toBe('unknown');
    }
    expect(policy.salonConfig).not.toBe(policy.entitlements);
    expect(policy.entitlements).not.toBe(policy.roleAccess);
  });
});

describe('fail-closed normalization', () => {
  test('unknown versions fail closed', () => {
    const input = { ...createCashierCapabilityManifest(IDENTITY), version: 99 };

    const result = normalizeCashierCapabilityManifest(input, IDENTITY);

    expectAllUnsupported(result, 'MANIFEST_VERSION_UNSUPPORTED');
  });

  test('an unknown outcome state fails the entire snapshot closed', () => {
    const input: any = createCashierCapabilityManifest(IDENTITY);
    input.outcomes.scale = { state: 'sometimes', reasonCode: 'AVAILABLE' };

    const result = normalizeCashierCapabilityManifest(input, IDENTITY);

    expectAllUnsupported(result, 'UNKNOWN_OUTCOME_STATE');
  });

  test('provider errors and throwing provider values fail closed without throwing', () => {
    expectAllUnsupported(
      normalizeCashierCapabilityManifest(new Error('provider unavailable'), IDENTITY),
      'PROVIDER_ERROR',
    );

    const throwingProviderValue = new Proxy({}, {
      get() {
        throw new Error('provider getter failed');
      },
    });
    expectAllUnsupported(
      normalizeCashierCapabilityManifest(throwingProviderValue, IDENTITY),
      'PROVIDER_ERROR',
    );
  });

  test('missing and malformed manifests fail closed', () => {
    expectAllUnsupported(
      normalizeCashierCapabilityManifest(undefined, IDENTITY),
      'MANIFEST_MISSING',
    );

    const missingCapability: any = createCashierCapabilityManifest(IDENTITY);
    delete missingCapability.outcomes.labelPrint;
    expectAllUnsupported(
      normalizeCashierCapabilityManifest(missingCapability, IDENTITY),
      'MANIFEST_INVALID',
    );

    const mismatchedReason: any = createCashierCapabilityManifest(IDENTITY);
    mismatchedReason.outcomes.scale = {
      state: 'supported',
      reasonCode: 'PLATFORM_UNSUPPORTED',
    };
    expectAllUnsupported(
      normalizeCashierCapabilityManifest(mismatchedReason, IDENTITY),
      'MANIFEST_INVALID',
    );
  });

  test('identity is bound to salon, user, register and auth epoch', () => {
    for (const identity of [
      { ...IDENTITY, salonId: 'salon-2' },
      { ...IDENTITY, userId: 'user-2' },
      { ...IDENTITY, registerId: 'register-2' },
      { ...IDENTITY, authEpoch: IDENTITY.authEpoch + 1 },
    ]) {
      const result = normalizeCashierCapabilityManifest(
        createCashierCapabilityManifest(identity),
        IDENTITY,
      );
      expect(result.identity).toEqual(IDENTITY);
      expectAllUnsupported(result, 'IDENTITY_MISMATCH');
    }
  });

  test('invalid expected or supplied identities fail closed', () => {
    const invalidExpected = { ...IDENTITY, registerId: '' };
    expectAllUnsupported(
      normalizeCashierCapabilityManifest(
        createCashierCapabilityManifest(IDENTITY),
        invalidExpected,
      ),
      'IDENTITY_INVALID',
    );

    const invalidManifest: any = createCashierCapabilityManifest(IDENTITY);
    invalidManifest.identity.authEpoch = -1;
    expectAllUnsupported(
      normalizeCashierCapabilityManifest(invalidManifest, IDENTITY),
      'IDENTITY_INVALID',
    );
  });
});
