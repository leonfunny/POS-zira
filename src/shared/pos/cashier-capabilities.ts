/**
 * Versioned cashier capability contract.
 *
 * A manifest reports only what the current platform/runtime can do. Salon
 * configuration, entitlements and role access are deliberately separate
 * inputs so none of them can be mistaken for a native runtime capability.
 */

export const CASHIER_CAPABILITY_MANIFEST_VERSION = 1 as const;

export const CASHIER_CAPABILITY_KEYS = [
  'loyaltyLookup',
  'restoredCartTender',
  'customerDisplay',
  'nativeProductCreate',
  'debtLedgerExternal',
  'quickAddRecognition',
  'pickupOrders',
  'labelPrint',
  'scale',
] as const;

export type CashierCapabilityKey = (typeof CASHIER_CAPABILITY_KEYS)[number];

export interface CashierCapabilityIdentity {
  salonId: string;
  userId: string;
  registerId: string;
  authEpoch: number;
}

export const CASHIER_CAPABILITY_REASON_CODES = [
  'AVAILABLE',
  'RUNTIME_DEGRADED',
  'REMOTE_ONLY',
  'EXTERNAL_ONLY',
  'NOT_DECLARED',
  'PLATFORM_UNSUPPORTED',
  'RUNTIME_UNAVAILABLE',
  'MANIFEST_MISSING',
  'MANIFEST_VERSION_UNSUPPORTED',
  'MANIFEST_INVALID',
  'UNKNOWN_OUTCOME_STATE',
  'IDENTITY_INVALID',
  'IDENTITY_MISMATCH',
  'PROVIDER_ERROR',
] as const;

export type CashierCapabilityReasonCode =
  (typeof CASHIER_CAPABILITY_REASON_CODES)[number];

export type CashierCapabilityOutcome =
  | { state: 'supported'; reasonCode: 'AVAILABLE' }
  | {
      state: 'degraded';
      reasonCode: 'RUNTIME_DEGRADED' | 'REMOTE_ONLY' | 'EXTERNAL_ONLY';
    }
  | {
      state: 'unsupported';
      reasonCode: Exclude<
        CashierCapabilityReasonCode,
        'AVAILABLE' | 'RUNTIME_DEGRADED' | 'REMOTE_ONLY' | 'EXTERNAL_ONLY'
      >;
    };

export type CashierCapabilityOutcomes = Record<
  CashierCapabilityKey,
  CashierCapabilityOutcome
>;

export interface CashierCapabilityManifest {
  version: typeof CASHIER_CAPABILITY_MANIFEST_VERSION;
  identity: CashierCapabilityIdentity;
  outcomes: CashierCapabilityOutcomes;
}

export type CashierSalonConfigDecision =
  | 'enabled'
  | 'disabled'
  | 'not-required'
  | 'unknown';

export type CashierEntitlementDecision =
  | 'granted'
  | 'denied'
  | 'not-required'
  | 'unknown';

export type CashierRoleDecision =
  | 'allowed'
  | 'denied'
  | 'not-required'
  | 'unknown';

/** Policy data is intentionally not embedded in CashierCapabilityManifest. */
export interface CashierCapabilityPolicyInputs {
  salonConfig: Record<CashierCapabilityKey, CashierSalonConfigDecision>;
  entitlements: Record<CashierCapabilityKey, CashierEntitlementDecision>;
  roleAccess: Record<CashierCapabilityKey, CashierRoleDecision>;
}

const CAPABILITY_KEY_SET = new Set<string>(CASHIER_CAPABILITY_KEYS);
const REASON_CODE_SET = new Set<string>(CASHIER_CAPABILITY_REASON_CODES);
const DEGRADED_REASON_CODE_SET = new Set<string>([
  'RUNTIME_DEGRADED',
  'REMOTE_ONLY',
  'EXTERNAL_ONLY',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyIdentity(identity: CashierCapabilityIdentity): CashierCapabilityIdentity {
  return {
    salonId: identity.salonId,
    userId: identity.userId,
    registerId: identity.registerId,
    authEpoch: identity.authEpoch,
  };
}

function safeIdentity(value: unknown): CashierCapabilityIdentity {
  try {
    const candidate = isRecord(value) ? value : {};
    return {
      salonId: typeof candidate.salonId === 'string' ? candidate.salonId : '',
      userId: typeof candidate.userId === 'string' ? candidate.userId : '',
      registerId: typeof candidate.registerId === 'string' ? candidate.registerId : '',
      authEpoch:
        typeof candidate.authEpoch === 'number' && Number.isFinite(candidate.authEpoch)
          ? candidate.authEpoch
          : -1,
    };
  } catch {
    return { salonId: '', userId: '', registerId: '', authEpoch: -1 };
  }
}

export function isCashierCapabilityIdentity(
  value: unknown,
): value is CashierCapabilityIdentity {
  try {
    if (!isRecord(value)) return false;
    return (
      typeof value.salonId === 'string' && value.salonId.trim().length > 0 &&
      typeof value.userId === 'string' && value.userId.trim().length > 0 &&
      typeof value.registerId === 'string' && value.registerId.trim().length > 0 &&
      typeof value.authEpoch === 'number' &&
      Number.isInteger(value.authEpoch) &&
      value.authEpoch >= 0
    );
  } catch {
    return false;
  }
}

export function sameCashierCapabilityIdentity(
  left: CashierCapabilityIdentity,
  right: CashierCapabilityIdentity,
): boolean {
  return (
    left.salonId === right.salonId &&
    left.userId === right.userId &&
    left.registerId === right.registerId &&
    left.authEpoch === right.authEpoch
  );
}

export function createUnsupportedCashierCapabilityOutcomes(
  reasonCode: Extract<CashierCapabilityOutcome, { state: 'unsupported' }>['reasonCode'] =
    'NOT_DECLARED',
): CashierCapabilityOutcomes {
  return Object.fromEntries(
    CASHIER_CAPABILITY_KEYS.map((key) => [
      key,
      { state: 'unsupported' as const, reasonCode },
    ]),
  ) as CashierCapabilityOutcomes;
}

export function createCashierCapabilityManifest(
  identity: CashierCapabilityIdentity,
  overrides: Partial<CashierCapabilityOutcomes> = {},
): CashierCapabilityManifest {
  const defaults = createUnsupportedCashierCapabilityOutcomes();
  const outcomes = Object.fromEntries(
    CASHIER_CAPABILITY_KEYS.map((key) => [
      key,
      { ...(overrides[key] ?? defaults[key]) },
    ]),
  ) as CashierCapabilityOutcomes;

  return {
    version: CASHIER_CAPABILITY_MANIFEST_VERSION,
    identity: copyIdentity(identity),
    outcomes,
  };
}

export function createFailClosedCashierCapabilityManifest(
  identity: CashierCapabilityIdentity,
  reasonCode: Extract<CashierCapabilityOutcome, { state: 'unsupported' }>['reasonCode'],
): CashierCapabilityManifest {
  return {
    version: CASHIER_CAPABILITY_MANIFEST_VERSION,
    identity: copyIdentity(identity),
    outcomes: createUnsupportedCashierCapabilityOutcomes(reasonCode),
  };
}

/**
 * Safe defaults for policy consumers. Callers must explicitly supply known
 * decisions before treating a runtime capability as usable.
 */
export function createDefaultCashierCapabilityPolicyInputs(): CashierCapabilityPolicyInputs {
  const allUnknown = () => Object.fromEntries(
    CASHIER_CAPABILITY_KEYS.map((key) => [key, 'unknown']),
  ) as Record<CashierCapabilityKey, 'unknown'>;

  return {
    salonConfig: allUnknown(),
    entitlements: allUnknown(),
    roleAccess: allUnknown(),
  };
}

function failClosed(
  expectedIdentity: unknown,
  reasonCode: Extract<CashierCapabilityOutcome, { state: 'unsupported' }>['reasonCode'],
): CashierCapabilityManifest {
  return createFailClosedCashierCapabilityManifest(
    safeIdentity(expectedIdentity),
    reasonCode,
  );
}

function parseOutcome(value: unknown): CashierCapabilityOutcome | 'unknown-state' | null {
  if (!isRecord(value) || typeof value.state !== 'string') return null;
  if (!['supported', 'unsupported', 'degraded'].includes(value.state)) {
    return 'unknown-state';
  }
  if (
    typeof value.reasonCode !== 'string' ||
    !REASON_CODE_SET.has(value.reasonCode)
  ) {
    return null;
  }

  if (value.state === 'supported') {
    return value.reasonCode === 'AVAILABLE'
      ? { state: 'supported', reasonCode: 'AVAILABLE' }
      : null;
  }
  if (value.state === 'degraded') {
    return DEGRADED_REASON_CODE_SET.has(value.reasonCode)
      ? {
          state: 'degraded',
          reasonCode: value.reasonCode as Extract<
            CashierCapabilityOutcome,
            { state: 'degraded' }
          >['reasonCode'],
        }
      : null;
  }
  if (
    value.reasonCode === 'AVAILABLE' ||
    DEGRADED_REASON_CODE_SET.has(value.reasonCode)
  ) {
    return null;
  }
  return {
    state: 'unsupported',
    reasonCode: value.reasonCode as Extract<
      CashierCapabilityOutcome,
      { state: 'unsupported' }
    >['reasonCode'],
  };
}

/**
 * Validates an untrusted manifest and returns a complete version-1 snapshot.
 * It never throws: missing, stale, malformed, identity-mismatched and provider
 * error values all become an all-unsupported manifest bound to the expected
 * identity.
 */
export function normalizeCashierCapabilityManifest(
  input: unknown,
  expectedIdentity: CashierCapabilityIdentity,
): CashierCapabilityManifest {
  try {
    if (!isCashierCapabilityIdentity(expectedIdentity)) {
      return failClosed(expectedIdentity, 'IDENTITY_INVALID');
    }
    if (input instanceof Error) {
      return failClosed(expectedIdentity, 'PROVIDER_ERROR');
    }
    if (input === null || input === undefined) {
      return failClosed(expectedIdentity, 'MANIFEST_MISSING');
    }
    if (!isRecord(input)) {
      return failClosed(expectedIdentity, 'MANIFEST_INVALID');
    }
    if (input.version !== CASHIER_CAPABILITY_MANIFEST_VERSION) {
      return failClosed(expectedIdentity, 'MANIFEST_VERSION_UNSUPPORTED');
    }
    if (!isCashierCapabilityIdentity(input.identity)) {
      return failClosed(expectedIdentity, 'IDENTITY_INVALID');
    }
    if (!sameCashierCapabilityIdentity(input.identity, expectedIdentity)) {
      return failClosed(expectedIdentity, 'IDENTITY_MISMATCH');
    }
    if (!isRecord(input.outcomes)) {
      return failClosed(expectedIdentity, 'MANIFEST_INVALID');
    }

    const outcomeKeys = Object.keys(input.outcomes);
    if (
      outcomeKeys.length !== CASHIER_CAPABILITY_KEYS.length ||
      outcomeKeys.some((key) => !CAPABILITY_KEY_SET.has(key))
    ) {
      return failClosed(expectedIdentity, 'MANIFEST_INVALID');
    }

    const outcomes = {} as CashierCapabilityOutcomes;
    for (const key of CASHIER_CAPABILITY_KEYS) {
      const parsed = parseOutcome(input.outcomes[key]);
      if (parsed === 'unknown-state') {
        return failClosed(expectedIdentity, 'UNKNOWN_OUTCOME_STATE');
      }
      if (parsed === null) {
        return failClosed(expectedIdentity, 'MANIFEST_INVALID');
      }
      outcomes[key] = parsed;
    }

    return {
      version: CASHIER_CAPABILITY_MANIFEST_VERSION,
      identity: copyIdentity(expectedIdentity),
      outcomes,
    };
  } catch {
    return failClosed(expectedIdentity, 'PROVIDER_ERROR');
  }
}
