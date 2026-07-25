/**
 * Real salon entitlements for the Android POS shim.
 *
 * Before this module the Android shim answered every entitlement question with
 * a synthetic all-enabled object (stubs.ts syntheticEntitlements) — so the Bi-a
 * tab rendered for EVERY salon regardless of plan. The Windows counterpart
 * (src/main/entitlements/entitlements-controller.ts) fetches
 * `GET /api/v1/admin/desktop/entitlements` with the salon-user JWT and caches
 * the result for 1h; that endpoint accepts STAFF/MANAGER/OWNER
 * (admin/controllers/desktop-entitlements.controller.ts:96-97), so the whole
 * flow is portable client-side with no backend change.
 *
 * Parity notes vs Windows:
 *  - normalize(): identical — start from DEFAULT_ENTITLEMENTS, override with
 *    the server's `features`, ignore keys the app does not know, and accept
 *    only POS modes the renderer has templates for.
 *  - 1h cache TTL (CACHE_TTL_MS) and the same validUntil bookkeeping.
 *  - DELIBERATE DIVERGENCE (narrow, safety-positive): when a fetch fails we
 *    prefer this salon's LAST KNOWN entitlements (persisted, any age) and only
 *    fall back to DEFAULT_ENTITLEMENTS when we have never seen this salon.
 *    Windows falls straight to defaults, and since DEFAULT_ENTITLEMENTS.billiard
 *    is `true`, an offline tablet at a salon WITHOUT billiard would otherwise
 *    show a Bi-a tab whose floor plan cannot load (Android billiard is
 *    online-only in P1). Last-known is both truer and quieter.
 *  - Tenant safety (lesson from the billiard-transport review): the persisted
 *    record is keyed by salonId and is never served to a different salon, and
 *    `clear()` wipes memory + storage on logout / dead session.
 */

import {
  DEFAULT_ENTITLEMENTS,
  type FeatureEntitlement,
  type FeatureKey,
  type SalonEntitlements,
} from '../../../shared/types';
import type { ShimConfigStore } from './config-store';
import type { KvStorage } from './config-store';

/** Same 1h validity Windows uses (entitlements-controller.ts:27). */
const CACHE_TTL_MS = 60 * 60 * 1000;
const STORAGE_KEY = 'zira-android-pos-entitlements';
/** Only POS modes the renderer actually has templates for (Windows parity). */
const VALID_POS_MODES = ['retail', 'salon', 'b2b', 'restaurant'] as const;

export interface EntitlementsDeps {
  configStore: ShimConfigStore;
  /** Authenticated JSON seam bound to PosApiClient.request (staff JWT). */
  request: (method: string, path: string, body?: any) => Promise<any>;
  /** Injectable for tests; defaults to localStorage when available. */
  storage?: KvStorage;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface EntitlementsController {
  get: () => Promise<SalonEntitlements>;
  fetch: () => Promise<SalonEntitlements>;
  isEnabled: (feature: FeatureKey | string) => Promise<boolean>;
  onChanged: (cb: (e: SalonEntitlements) => void) => () => void;
  /** Logout / dead session: drop memory + persisted record (tenant boundary). */
  clear: () => void;
}

function memoryOnlyStorage(): KvStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

function resolveStorage(injected?: KvStorage): KvStorage {
  if (injected) return injected;
  const g = globalThis as unknown as { localStorage?: KvStorage };
  return g.localStorage ?? memoryOnlyStorage();
}

/** Build the feature map from DEFAULT_ENTITLEMENTS, then apply server overrides
 *  for keys this app knows (Windows normalizeEntitlements, same rules). */
function normalize(data: any, fallbackSalonId: string, nowMs: number): SalonEntitlements {
  const features = {} as Record<FeatureKey, FeatureEntitlement>;
  for (const [key, enabled] of Object.entries(DEFAULT_ENTITLEMENTS)) {
    features[key as FeatureKey] = { featureKey: key as FeatureKey, enabled };
  }
  if (data?.features && typeof data.features === 'object') {
    for (const [key, value] of Object.entries(data.features)) {
      if (!(key in DEFAULT_ENTITLEMENTS)) continue; // unknown server key — ignore
      const entitlement = value as any;
      features[key as FeatureKey] = {
        featureKey: key as FeatureKey,
        enabled: entitlement?.enabled ?? DEFAULT_ENTITLEMENTS[key as FeatureKey],
        expiresAt: entitlement?.expiresAt,
        trialEndsAt: entitlement?.trialEndsAt,
      };
    }
  }
  const suggested = VALID_POS_MODES.includes(data?.suggestedPosMode)
    ? (data.suggestedPosMode as SalonEntitlements['suggestedPosMode'])
    : null;
  return {
    salonId: data?.salonId || fallbackSalonId || '',
    salonCode: data?.salonCode || '',
    salonName: data?.salonName || '',
    plan: data?.plan || 'free',
    suggestedPosMode: suggested,
    features,
    fetchedAt: new Date(nowMs).toISOString(),
    validUntil: new Date(nowMs + CACHE_TTL_MS).toISOString(),
  };
}

/** Windows defaults, used only when this salon has never been fetched. */
function defaults(salonId: string, salonName: string, nowMs: number): SalonEntitlements {
  return normalize({ salonId, salonName, plan: 'free' }, salonId, nowMs);
}

function featuresSignature(e: SalonEntitlements): string {
  return Object.keys(DEFAULT_ENTITLEMENTS)
    .sort()
    .map((k) => `${k}:${e.features[k as FeatureKey]?.enabled ? 1 : 0}`)
    .join('|');
}

export function createEntitlementsController(
  { configStore, request, storage, now = () => Date.now() }: EntitlementsDeps,
): EntitlementsController {
  const store = resolveStorage(storage);
  let cached: SalonEntitlements | null = null;
  const listeners = new Set<(e: SalonEntitlements) => void>();

  const currentSalonId = () => configStore.getRawConfig().salonId ?? '';
  const currentSalonName = () => configStore.getRawConfig().salonName ?? '';

  /** Persisted last-known record — ONLY returned for the matching salon. */
  function readPersisted(salonId: string): SalonEntitlements | null {
    if (!salonId) return null;
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SalonEntitlements;
      if (!parsed?.features || parsed.salonId !== salonId) return null;
      return parsed;
    } catch {
      return null; // corrupt record — treat as absent
    }
  }

  function persist(e: SalonEntitlements): void {
    try { store.setItem(STORAGE_KEY, JSON.stringify(e)); } catch { /* storage full/disabled */ }
  }

  function emitIfChanged(next: SalonEntitlements, previous: SalonEntitlements | null): void {
    if (previous && featuresSignature(previous) === featuresSignature(next)) return;
    for (const cb of [...listeners]) {
      try { cb(next); } catch { /* a listener throwing must not break others */ }
    }
  }

  function isFresh(e: SalonEntitlements | null, salonId: string): boolean {
    if (!e || e.salonId !== salonId) return false;
    return new Date(e.validUntil).getTime() > now();
  }

  async function doFetch(): Promise<SalonEntitlements> {
    const salonId = currentSalonId();
    const previous = cached ?? readPersisted(salonId);
    // Windows hits GET /api/v1/admin/desktop/entitlements with the salon-user
    // JWT; the injected request prepends the base + '/api/v1'.
    const payload = await request('GET', '/admin/desktop/entitlements');
    const next = normalize(payload, salonId, now());
    cached = next;
    persist(next);
    emitIfChanged(next, previous);
    return next;
  }

  return {
    fetch: doFetch,

    get: async () => {
      const salonId = currentSalonId();
      if (isFresh(cached, salonId)) return cached as SalonEntitlements;
      // Adopt a persisted record for THIS salon while it is still fresh —
      // survives an app restart without a network round-trip.
      const persisted = readPersisted(salonId);
      if (isFresh(persisted, salonId)) {
        cached = persisted;
        return persisted as SalonEntitlements;
      }
      try {
        return await doFetch();
      } catch {
        // Offline / server error: this salon's last known answer beats the
        // all-on defaults (see header — Bi-a is online-only on Android).
        if (persisted) {
          cached = persisted;
          return persisted;
        }
        return defaults(salonId, currentSalonName(), now());
      }
    },

    isEnabled: async (feature: FeatureKey | string) => {
      const salonId = currentSalonId();
      const e = isFresh(cached, salonId)
        ? (cached as SalonEntitlements)
        : await (async () => {
          try { return await doFetch(); } catch {
            return readPersisted(salonId) ?? defaults(salonId, currentSalonName(), now());
          }
        })();
      const entry = e.features[feature as FeatureKey];
      if (!entry) return DEFAULT_ENTITLEMENTS[feature as FeatureKey] ?? false;
      return !!entry.enabled;
    },

    onChanged: (cb: (e: SalonEntitlements) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    clear: () => {
      cached = null;
      listeners.clear();
      try { store.removeItem(STORAGE_KEY); } catch { /* storage disabled */ }
    },
  };
}
