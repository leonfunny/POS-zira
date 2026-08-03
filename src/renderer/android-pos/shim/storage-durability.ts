/**
 * IndexedDB durability request for the Android POS shim.
 *
 * The entire local ledger is ONE IndexedDB blob (shim/db/db.ts:52-56) — the
 * catalog, the shifts, the billiard POS-handoff journal, the protected held
 * carts, and orders that have been PAID but not yet synced to the backend. By
 * default that storage is "best-effort": Android may evict it when the device
 * runs low on space, and `allowBackup="false"` plus the data_extraction_rules
 * exclusions mean there is no second copy anywhere.
 *
 * `navigator.storage.persist()` moves the origin to "persistent" so the OS will
 * not silently reclaim it. The request can be refused; when it is, the caller
 * shows a standing warning rather than pretending the money is safe.
 *
 * Never throws: a failure here must not stop the cashier from selling.
 */

export interface StorageDurability {
  /** The StorageManager persistence API exists on this engine. */
  supported: boolean;
  /** Storage is persistent — the OS will not evict it to free space. */
  persisted: boolean;
}

export const STORAGE_AT_RISK_MESSAGE =
  'Bộ nhớ chưa được bảo vệ — đơn chưa đồng bộ có thể mất nếu máy hết dung lượng. '
  + 'Đồng bộ và đóng ca thường xuyên.';

/**
 * Ask the OS to make this origin's storage persistent. Idempotent and cheap:
 * checks `persisted()` first so a repeat boot does not re-prompt.
 */
export async function ensurePersistentStorage(scope?: unknown): Promise<StorageDurability> {
  const g = (scope ?? globalThis) as {
    navigator?: { storage?: { persisted?: () => Promise<boolean>; persist?: () => Promise<boolean> } };
  };
  const storage = g.navigator?.storage;

  if (typeof storage?.persisted !== 'function' || typeof storage?.persist !== 'function') {
    return { supported: false, persisted: false };
  }

  try {
    if (await storage.persisted()) return { supported: true, persisted: true };
    return { supported: true, persisted: (await storage.persist()) === true };
  } catch {
    // A SecurityError / disabled-storage engine must not break boot.
    return { supported: true, persisted: false };
  }
}

let durabilityPromise: Promise<StorageDurability> | null = null;

/**
 * Boot entry point. Requests persistence exactly once per process and caches the
 * promise, so the banner reads the same answer the request produced instead of
 * polling a global for it.
 */
export function initStorageDurability(scope?: unknown): Promise<StorageDurability> {
  if (!durabilityPromise) durabilityPromise = ensurePersistentStorage(scope);
  return durabilityPromise;
}

/** The cached answer; kicks off the request if boot has not yet run. */
export function getStorageDurability(): Promise<StorageDurability> {
  return durabilityPromise ?? initStorageDurability();
}

/** Test helper: drop the cached answer so a spec can exercise both branches
 *  (mirrors `__resetShimForTest` in shim/index.ts). */
export function __resetStorageDurabilityForTest(): void {
  durabilityPromise = null;
}
