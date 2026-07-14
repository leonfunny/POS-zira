interface StableMutationKeyStore {
  get: (intent: string) => string;
  clear: () => void;
}

export interface ImmutableMutationAttemptStore<TPayload extends object> {
  current: () => Readonly<TPayload & { idempotencyKey: string }> | null;
  dispatch: (payload: TPayload) => Readonly<TPayload & { idempotencyKey: string }>;
  clear: () => void;
}

interface MutationRejection {
  ok?: boolean;
  status?: number;
  code?: string;
  error?: string;
}

export interface MutationOutcomeTracker {
  shouldRelease: (result: MutationRejection | null | undefined) => boolean;
  markAmbiguous: () => void;
  isUncertain: () => boolean;
  clear: () => void;
}

const AMBIGUOUS_MUTATION_CODES = new Set([
  'ABORT_ERR',
  'CONNECTION_LOST',
  'IDEMPOTENCY_IN_PROGRESS',
  'MUTATION_IN_PROGRESS',
  'NETWORK_ERROR',
  'REQUEST_IN_PROGRESS',
  'REQUEST_TIMEOUT',
  'TIMEOUT',
]);

const DEFINITIVE_PRODUCT_MUTATION_CODES = new Set([
  'CATEGORY_NOT_FOUND',
  'DUPLICATE_BARCODE',
  'DUPLICATE_PRODUCT',
  'DUPLICATE_SKU',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IMAGE_TOO_LARGE',
  'INSUFFICIENT_STOCK',
  'INVALID_CATEGORY',
  'INVALID_EXPIRATION_DATE',
  'INVALID_IMAGE',
  'INVALID_LOT_NUMBER',
  'INVALID_PRICE',
  'INVALID_REASON',
  'INVALID_STOCK_QUANTITY',
  'INVALID_VAT_RATE',
  'LOT_RECEIVING_REQUIRED',
  'PRICE_MINOR_UNIT_MISMATCH',
  'PRODUCT_NOT_FOUND',
  'SALON_CONTEXT_MISMATCH',
  'STALE_PRODUCT',
  'STOCK_MUST_BE_ZERO',
  'STOCK_NOT_TRACKED',
  'UNAUTHORIZED_PRODUCT_ADMIN',
  'UNSUPPORTED_CAPABILITY',
  'VARIANT_IMPORT_ALIAS_BLOCKED',
  'VARIANT_IMPORT_PENDING',
]);

function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `product-mutation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createStableMutationKeyStore(
  createKey: () => string = makeIdempotencyKey,
): StableMutationKeyStore {
  let current: { intent: string; key: string } | null = null;

  return {
    get(intent) {
      if (!current || current.intent !== intent) {
        current = { intent, key: createKey() };
      }
      return current.key;
    },
    clear() {
      current = null;
    },
  };
}

/**
 * Only a confirmed rejection may release an immutable attempt. Missing HTTP
 * status is ambiguous because main-process network failures use the same
 * `{ ok: false }` envelope. Domain validation produced before fetch is the
 * narrow exception. 408 and timeout/in-flight signals always stay locked.
 */
export function isDefinitiveMutationRejection(result: MutationRejection | null | undefined): boolean {
  if (result?.ok !== false) return false;
  const code = String(result.code || '').trim().toUpperCase();
  if (AMBIGUOUS_MUTATION_CODES.has(code)) return false;
  const status = typeof result.status === 'number' && Number.isInteger(result.status)
    ? result.status
    : undefined;
  if (status !== undefined) {
    if (status === 408) return false;
    return status >= 400 && status < 500;
  }
  return DEFINITIVE_PRODUCT_MUTATION_CODES.has(code);
}

/**
 * Once a dispatched request has produced an ambiguous result, a later local
 * auth/capability/validation rejection cannot prove that the original request
 * did not commit. Keep the original attempt sticky until a success is replayed.
 */
export function createMutationOutcomeTracker(): MutationOutcomeTracker {
  let uncertain = false;

  return {
    shouldRelease(result) {
      if (uncertain) return false;
      if (isDefinitiveMutationRejection(result)) return true;
      uncertain = true;
      return false;
    },
    markAmbiguous() {
      uncertain = true;
    },
    isUncertain() {
      return uncertain;
    },
    clear() {
      uncertain = false;
    },
  };
}

/**
 * A mutation that may have reached the server must retry the exact same body
 * and key. Form edits or a background product refresh must not silently turn
 * an uncertain request into a second logical mutation.
 */
export function createImmutableMutationAttemptStore<TPayload extends object>(
  createKey: () => string = makeIdempotencyKey,
): ImmutableMutationAttemptStore<TPayload> {
  const keys = createStableMutationKeyStore(createKey);
  let dispatched: Readonly<TPayload & { idempotencyKey: string }> | null = null;

  return {
    current() {
      return dispatched;
    },
    dispatch(payload) {
      if (!dispatched) {
        const snapshot = { ...payload };
        dispatched = Object.freeze({
          ...snapshot,
          idempotencyKey: keys.get(JSON.stringify(snapshot)),
        });
      }
      return dispatched;
    },
    clear() {
      dispatched = null;
      keys.clear();
    },
  };
}

/**
 * Once the server has confirmed a mutation, a best-effort local refresh is not
 * allowed to turn that success into a retryable mutation failure.
 */
export async function completeCommittedMutation(
  afterCommit: () => Promise<void> | void,
  close: () => void,
): Promise<void> {
  try {
    await afterCommit();
  } catch {
    // Main-process mirroring and the next catalog sync can repair the view.
  } finally {
    close();
  }
}
