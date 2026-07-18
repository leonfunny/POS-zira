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
 *  - Seeds posMode='retail' + a synthetic authUser so RetailTemplate mounts and
 *    resolves its per-user cart key (S1 §0.2, §5).
 */

import type { AgentConfig, AuthUser } from '../../../shared/types';

const CONFIG_STORAGE_KEY = 'zira-android-pos-config';

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

/** The S2 boot seed — retail mode, synthetic session, no secrets, no URLs. */
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
    posMode: 'retail',
    posEnabled: true,
    allowOversell: false,
    showNonFiscalOrders: true,
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
    const booksy = config.booksy as Record<string, unknown>;
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
