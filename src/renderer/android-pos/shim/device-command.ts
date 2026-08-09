import type { AgentConfig } from '../../../shared/types';
import type { ShimConfigStore } from './config-store';
import type { AndroidDatabase } from './db/db';
import { createSyncMeta } from './db/sync-meta';
import type { ShimPosStore } from './pos-store';

export type DeviceCommandType =
  | 'DEVICE_STATE'
  | 'SETTINGS_PATCH'
  | 'DATABASE_RESYNC'
  | 'APP_RELOAD'
  | 'APP_UPDATE';

export interface DeviceCommandEvent {
  commandId: string;
  type: DeviceCommandType;
  payload: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string;
}

export interface DeviceCommandResult {
  status: 'COMPLETED' | 'FAILED' | 'USER_ACTION_REQUIRED';
  result?: Record<string, unknown>;
  error?: string;
}

interface AppUpdaterPlugin {
  getInfo(): Promise<Record<string, unknown>>;
  installFromUrl(input: { version: string; apkUrl: string; sha256: string }): Promise<Record<string, unknown>>;
}

export interface DeviceCommandHandlerDeps {
  configStore: ShimConfigStore;
  db(): Promise<AndroidDatabase>;
  getPosStore(): ShimPosStore | null;
  syncProducts(): Promise<Record<string, unknown>>;
  syncStaff(): Promise<Record<string, unknown>>;
  updater?: AppUpdaterPlugin | null;
  reload?: () => void;
}

const BOOLEAN_SETTING_KEYS = new Set([
  'allowOversell',
  'showNonFiscalOrders',
  'customerDisplayEnabled',
  'selfCheckoutEnabled',
  'kitchenSelfOrderEnabled',
  'tvAdEnabled',
  'remoteAccessEnabled',
]);
const SAFE_LANGUAGES = new Set(['pl', 'en', 'vi', 'de', 'cs', 'sk', 'uk']);

function appUpdaterPlugin(): AppUpdaterPlugin | null {
  const plugin = (globalThis as any)?.Capacitor?.Plugins?.AppUpdater;
  return plugin?.getInfo && plugin?.installFromUrl ? plugin as AppUpdaterPlugin : null;
}

function safeSettingsPatch(raw: unknown): Partial<AgentConfig> {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('settings-object-required');
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (BOOLEAN_SETTING_KEYS.has(key)) {
      if (typeof value !== 'boolean') throw new Error(`invalid-setting:${key}`);
      patch[key] = value;
      continue;
    }
    if (key === 'posMode') {
      if (value !== 'salon' && value !== 'retail') throw new Error('invalid-setting:posMode');
      patch[key] = value;
      continue;
    }
    if (key === 'language' || key === 'posLanguage') {
      const language = String(value || '').toLowerCase();
      if (!SAFE_LANGUAGES.has(language)) throw new Error(`invalid-setting:${key}`);
      patch[key] = language;
      continue;
    }
    if (key === 'moduleOverrides') {
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid-setting:moduleOverrides');
      const flags: Record<string, boolean> = {};
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > 64) throw new Error('invalid-setting:moduleOverrides');
      for (const [name, enabled] of entries) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || typeof enabled !== 'boolean') {
          throw new Error('invalid-setting:moduleOverrides');
        }
        flags[name] = enabled;
      }
      patch[key] = flags;
      continue;
    }
    throw new Error(`setting-not-remote-manageable:${key}`);
  }
  if (Object.keys(patch).length === 0) throw new Error('settings-patch-empty');
  return patch as Partial<AgentConfig>;
}

function selectedDeviceConfig(config: AgentConfig): Record<string, unknown> {
  return {
    salonId: config.salonId ?? null,
    salonName: config.salonName ?? null,
    salonSlug: config.salonSlug ?? null,
    machineId: config.machineId ?? null,
    agentId: config.agentId ?? null,
    posMode: config.posMode ?? null,
    posLanguage: config.posLanguage ?? null,
    language: config.language ?? null,
    moduleOverrides: config.moduleOverrides ?? {},
    allowOversell: config.allowOversell === true,
    showNonFiscalOrders: config.showNonFiscalOrders !== false,
    customerDisplayEnabled: config.customerDisplayEnabled === true,
    selfCheckoutEnabled: config.selfCheckoutEnabled === true,
    kitchenSelfOrderEnabled: config.kitchenSelfOrderEnabled === true,
    tvAdEnabled: config.tvAdEnabled === true,
    remoteAccessEnabled: config.remoteAccessEnabled === true,
  };
}

export function createDeviceCommandHandler(deps: DeviceCommandHandlerDeps) {
  return async (command: DeviceCommandEvent): Promise<DeviceCommandResult> => {
    if (!command?.commandId || !command.type) return { status: 'FAILED', error: 'invalid-command' };
    const expiresAt = Date.parse(command.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return { status: 'FAILED', error: 'command-expired' };
    }

    try {
      if (command.type === 'DEVICE_STATE') {
        const config = deps.configStore.getConfig();
        const pos = deps.getPosStore()?.getState();
        const database = await deps.db();
        const counts = {
          products: database.get<{ count: number }>('SELECT COUNT(*) AS count FROM product_variants')?.count ?? 0,
          categories: database.get<{ count: number }>('SELECT COUNT(*) AS count FROM categories')?.count ?? 0,
          staff: database.get<{ count: number }>('SELECT COUNT(*) AS count FROM staff')?.count ?? 0,
          // `synced` (0 pending / 1 done / 2 in flight), not `sync_status` —
          // that column has never existed in the Android schema, so this query
          // threw and took the whole DEVICE_STATE reply down with it. It went
          // unnoticed because the test faked `database.get` to answer any SQL
          // string with a count.
          pendingOrders: database.get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM orders WHERE synced != 1',
          )?.count ?? 0,
        };
        const updater = deps.updater === undefined ? appUpdaterPlugin() : deps.updater;
        const app = updater ? await updater.getInfo().catch(() => ({ available: false })) : { available: false };
        return {
          status: 'COMPLETED',
          result: {
            config: selectedDeviceConfig(config),
            database: counts,
            shiftOpen: pos?.session?.isOpen === true,
            cartItems: pos?.cart?.items?.length ?? 0,
            app,
          },
        };
      }

      if (command.type === 'SETTINGS_PATCH') {
        const patch = safeSettingsPatch(command.payload?.settings);
        deps.configStore.setConfig(patch);
        return { status: 'COMPLETED', result: { applied: Object.keys(patch) } };
      }

      if (command.type === 'DATABASE_RESYNC') {
        const scope = String(command.payload?.scope ?? 'ALL').toUpperCase();
        if (!['CATALOG', 'STAFF', 'ALL'].includes(scope)) throw new Error('invalid-database-scope');
        const database = await deps.db();
        if (command.payload?.full === true && (scope === 'CATALOG' || scope === 'ALL')) {
          createSyncMeta(database).setSyncMeta(null);
          await database.flush();
        }
        const result: Record<string, unknown> = {};
        if (scope === 'CATALOG' || scope === 'ALL') result.catalog = await deps.syncProducts();
        if (scope === 'STAFF' || scope === 'ALL') result.staff = await deps.syncStaff();
        return { status: 'COMPLETED', result };
      }

      if (command.type === 'APP_RELOAD') {
        const reload = deps.reload ?? (() => globalThis.location?.reload());
        setTimeout(reload, 250);
        return { status: 'COMPLETED', result: { scheduled: true } };
      }

      if (command.type === 'APP_UPDATE') {
        const updater = deps.updater === undefined ? appUpdaterPlugin() : deps.updater;
        if (!updater) return { status: 'FAILED', error: 'native-updater-unavailable' };
        const version = String(command.payload?.version || '');
        const apkUrl = String(command.payload?.apkUrl || '');
        const sha256 = String(command.payload?.sha256 || '').toLowerCase();
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !/^[a-f0-9]{64}$/.test(sha256)) {
          throw new Error('invalid-update-manifest');
        }
        const url = new URL(apkUrl);
        const allowed = url.protocol === 'https:'
          && (url.hostname === 'img.zira.pl' || url.hostname === 'releases.enail.pro' || url.hostname.endsWith('.enail.pro'))
          && url.pathname.toLowerCase().endsWith('.apk');
        if (!allowed) throw new Error('untrusted-update-url');
        const result = await updater.installFromUrl({ version, apkUrl: url.toString(), sha256 });
        return {
          status: result?.userActionRequired === false ? 'COMPLETED' : 'USER_ACTION_REQUIRED',
          result,
        };
      }

      return { status: 'FAILED', error: 'unsupported-command' };
    } catch (error: any) {
      return { status: 'FAILED', error: String(error?.message || error).slice(0, 500) };
    }
  };
}
