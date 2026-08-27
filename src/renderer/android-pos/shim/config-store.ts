/**
 * Shim config store — the Android stand-in for the Windows electron-store
 * `getRendererConfig` / SET_CONFIG path (S1 §2.A).
 *
 * Packet S2 of the Android parity port. The real Windows main process keeps
 * the full AgentConfig on disk in `%APPDATA%/Zira AI/config.json` (electron-store)
 * and returns a SECRET-STRIPPED copy to the renderer. On Android the shim owns
 * a renderer-visible subset persisted to `localStorage` (S4 later moves secrets
 * to Capacitor secure storage; S2 stores NO secrets, ever).
 *
 * Contract obligations (S1 §2.A, §7):
 *  - `getConfig()` returns sanitized config: authUser/salonId/salonName/
 *    salonSlug/posMode/posLanguage/language/allowOversell/showNonFiscalOrders/
 *    scale/booksy.hasJwt stay visible; every secret field is blanked exactly
 *    like `getRendererConfig` (auth.module.ts:77).
 *  - `setConfig`/`saveConfig` merge + persist + emit `onConfigUpdated` so every
 *    subscribed window re-`getConfig()` (matches the Windows config-updated
 *    broadcast).
 *  - Seeds posMode='salon' (E2a — the Windows default) + a synthetic authUser so
 *    SalonTemplate/RetailTemplate mount and resolve their per-user cart key
 *    (S1 §0.2, §5; SHIM_CONTRACT_SALON_E2 §0.1). `resolvePosMode` is the single
 *    source of the salon-vs-retail decision at boot + login.
 */

import type { AgentConfig, AuthUser } from '../../../shared/types';

const CONFIG_STORAGE_KEY = 'zira-android-pos-config';

// ─── posMode resolution (packet E2a — salon mode) ───────────────────────────

/**
 * The two POS modes the Android shell drives on the unmodified Windows
 * `POSLayout` (PosMode = 'retail'|'salon'|'b2b'|'restaurant', types.ts:586, but
 * Android only renders retail + salon — b2b/restaurant are EXCLUDE). Per
 * SHIM_CONTRACT_SALON_E2 §0.1 / §9.1 the Windows default is **'salon'**
 * (`POSLayout.tsx:294`); the S1 retail port seeded 'retail' because it only
 * shipped the retail template. E2a makes the salon template render, so the
 * Android shell must boot a salon in salon mode while keeping a
 * retail-configured device on retail.
 */
export type AndroidPosMode = 'retail' | 'salon';

/**
 * Resolve the effective POS mode. Precedence (SHIM_CONTRACT_SALON_E2 task #1):
 *   1. `config.posMode` when it is an Android-supported mode (the device/driver
 *      choice is authoritative — a retail-configured salon stays retail);
 *   2. else the salon entitlement's `suggestedPosMode` when it names a supported
 *      mode (a salon the backend flags retail);
 *   3. else `'salon'` — the Windows default (S1 headline #2, POSLayout.tsx:294).
 *
 * Pure + exported so the boot path (main.ts) and login (real-transport) share
 * one decision, and so the precedence is unit-testable without a window.
 */
export function resolvePosMode(
  config: { posMode?: string } | null | undefined,
  entitlement?: { suggestedPosMode?: string | null } | null,
): AndroidPosMode {
  const fromConfig = String(config?.posMode ?? '').trim().toLowerCase();
  if (fromConfig === 'retail' || fromConfig === 'salon') return fromConfig;
  const suggested = String(entitlement?.suggestedPosMode ?? '').trim().toLowerCase();
  if (suggested === 'retail' || suggested === 'salon') return suggested;
  return 'salon';
}

/**
 * The synthetic staff identity used until real login (S3/S4) lands. Marked
 * clearly so callers can tell synthetic data from a real session.
 */
export const SYNTHETIC_AUTH_USER: AuthUser = {
  id: 'android-dev',
  email: 'dev@synthetic.local',
  firstName: 'Android',
  lastName: 'Dev',
  role: 'STAFF',
  salonId: 'synthetic',
  salonName: 'Synthetic Salon',
};

/**
 * The S2 boot seed — SALON mode (the Windows default, SHIM_CONTRACT_SALON_E2
 * §0.1/§9.1), synthetic session, no secrets, no URLs. A retail-configured
 * device overrides this via the seed/config; `resolvePosMode` honors that.
 */
export function createSeedConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'Zira AI Print Agent (Android)',
    // No http URLs here — keeps the offline S2 bundle free of endpoint strings.
    serverUrl: '',
    printerProtocol: 'THERMAL' as AgentConfig['printerProtocol'],
    printerBaudRate: 9600,
    isPaired: false,
    autoStart: false,
    language: 'pl',
    posLanguage: 'pl',
    posMode: 'salon',
    posEnabled: true,
    allowOversell: false,
    showNonFiscalOrders: false,
    salonId: SYNTHETIC_AUTH_USER.salonId,
    salonName: SYNTHETIC_AUTH_USER.salonName,
    salonSlug: 'synthetic',
    authUser: SYNTHETIC_AUTH_USER,
    scale: { enabled: false, port: '' } as AgentConfig['scale'],
    ...overrides,
  } as AgentConfig;
}

/** Minimal KV adapter so the store works in a browser, under jsdom, or in pure node tests. */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): KvStorage {
  const g = globalThis as unknown as { localStorage?: KvStorage };
  if (g.localStorage) return g.localStorage;
  // Pure-node fallback (unit tests without jsdom).
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

/**
 * Blank every secret field the Windows `getRendererConfig` strips
 * (auth.module.ts:77-105). The S2 shim never stores secrets, but the renderer
 * contract requires these keys to be present-and-empty on the way out, and S4
 * must keep honoring this when real tokens arrive.
 */
export function sanitizeConfigForRenderer(config: AgentConfig): AgentConfig {
  const sanitized: AgentConfig = {
    ...config,
    apiKey: '',
    authToken: '' as AgentConfig['authToken'],
    aiApiKey: '',
    telegramToken: '',
    remoteAccessPin: '',
  } as AgentConfig;

  const writable = sanitized as AgentConfig & Record<string, unknown>;
  writable.encryptedToken = '';
  writable.encryptedAuthToken = '';
  writable.encryptedRefreshToken = '';
  writable.encryptedApiKey = '';
  writable.encryptedAiApiKey = '';
  writable.encryptedTelegramToken = '';
  writable.encryptedRemotePin = '';

  if (config.booksy) {
    const booksy = config.booksy as unknown as Record<string, unknown>;
    sanitized.booksy = {
      ...config.booksy,
      enailJwt: '',
      encryptedEnailJwt: '',
      telegramBotToken: '',
      // Derived flag mirrors Windows: true when a token exists in the private copy.
      hasJwt: !!(booksy.enailJwt || booksy.encryptedEnailJwt),
    } as AgentConfig['booksy'];
  }
  return sanitized;
}

export class ShimConfigStore {
  private readonly storage: KvStorage;
  private readonly listeners = new Set<() => void>();
  private config: AgentConfig;

  constructor(options: { storage?: KvStorage; seed?: Partial<AgentConfig> } = {}) {
    this.storage = options.storage ?? defaultStorage();
    this.config = this.load(options.seed);
  }

  private load(seed?: Partial<AgentConfig>): AgentConfig {
    const raw = this.storage.getItem(CONFIG_STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as AgentConfig;
        return { ...createSeedConfig(seed), ...parsed };
      } catch {
        // Corrupt persisted config — fall back to seed (mirrors electron-store resilience).
      }
    }
    return createSeedConfig(seed);
  }

  /** Sanitized, renderer-visible config (S1 §2.A). Never contains secrets. */
  getConfig(): AgentConfig {
    return sanitizeConfigForRenderer(this.config);
  }

  /** Private (un-sanitized) copy — only used internally / by S4 token storage. */
  getRawConfig(): AgentConfig {
    return this.config;
  }

  /** Merge + persist + broadcast. Returns the sanitized result. */
  setConfig(partial: Partial<AgentConfig>): AgentConfig {
    this.config = { ...this.config, ...partial };
    this.persist();
    this.emit();
    return this.getConfig();
  }

  /** Alias for setConfig — matches the Windows SET_CONFIG dual channel. */
  saveConfig(partial: Partial<AgentConfig>): AgentConfig {
    return this.setConfig(partial);
  }

  /** Subscribe to config-updated pings. Returns an unsubscribe. */
  onConfigUpdated(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A subscriber throwing must not break the broadcast to others.
      }
    }
  }

  private persist(): void {
    // Persist the sanitized form — secrets never reach storage on Android.
    try {
      this.storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(sanitizeConfigForRenderer(this.config)));
    } catch {
      // Storage full / disabled — config stays in-memory for this session.
    }
  }
}
