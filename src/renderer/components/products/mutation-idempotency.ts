interface StableMutationKeyStore {
  get: (intent: string) => string;
  clear: () => void;
}

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
