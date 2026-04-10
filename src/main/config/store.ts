import Store from 'electron-store';
import { AgentConfig, TelegramConfig, BooksySyncConfig, SecurityConfig, AuthUser } from '../../shared/types';

// Default Telegram configuration (moltbot-style)
const defaultTelegramConfig: TelegramConfig = {
  enabled: false,
  dmPolicy: 'allowlist',
  groupPolicy: 'disabled',
  allowFrom: [],
  groupAllowFrom: [],
  groups: {},
  dms: {},
  replyToMode: 'first',
  streamMode: 'off',
  mediaMaxMb: 5,
  historyLimit: 50,
  reactionNotifications: 'off',
  reactionLevel: 'off',
  enableInput: false,
  enableBrowser: false,
  debounceMs: 500,
};

// Default configuration
const defaultConfig: AgentConfig = {
  name: 'Zira AI',
  printerProtocol: 'THERMAL',
  printerBaudRate: 9600,
  multiPrinterMode: false,
  serverUrl: process.env.NODE_ENV === 'development'
    ? 'http://localhost:3003'
    : 'https://api.enail.pro',
  isPaired: false,
  autoStart: true,
  telegram: defaultTelegramConfig,
};

// Printer config schema
const printerConfigSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: false },
    protocol: { type: 'string', enum: ['THERMAL', 'POSNET', 'ZEBRA', 'WINDOWS'], default: 'THERMAL' },
    port: { type: 'string' },
    baudRate: { type: 'number', default: 9600 },
    windowsPrinter: { type: 'string' },
    labelWidth: { type: 'number', default: 100 },
    labelHeight: { type: 'number', default: 50 },
    paperWidth: { type: 'number', default: 80 },
    charsPerLine: { type: 'number', default: 48 },
    supportsCut: { type: 'boolean', default: true },
    supportsCashDrawer: { type: 'boolean', default: false },
  },
};

// Printers dictionary schema (by PrinterType)
const printersConfigSchema = {
  type: 'object',
  properties: {
    RECEIPT: printerConfigSchema,
    LABEL: printerConfigSchema,
    A4: printerConfigSchema,
    TICKET: printerConfigSchema,
    KITCHEN: printerConfigSchema,
  },
};

// Telegram group config schema
const telegramGroupConfigSchema = {
  type: 'object',
  properties: {
    requireMention: { type: 'boolean' },
    historyLimit: { type: 'number' },
    systemPrompt: { type: 'string' },
    allowedUserIds: { type: 'array', items: { type: 'number' } },
    aiEnabled: { type: 'boolean' },
    topics: { type: 'object' },
  },
};

// Telegram DM config schema
const telegramDMConfigSchema = {
  type: 'object',
  properties: {
    historyLimit: { type: 'number' },
    systemPrompt: { type: 'string' },
    aiEnabled: { type: 'boolean' },
  },
};

// Full Telegram config schema (moltbot-style)
const telegramConfigSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: false },
    botToken: { type: 'string' },
    encryptedBotToken: { type: 'string' },
    dmPolicy: { type: 'string', enum: ['pairing', 'allowlist', 'open', 'disabled'], default: 'allowlist' },
    groupPolicy: { type: 'string', enum: ['open', 'allowlist', 'disabled'], default: 'disabled' },
    allowFrom: { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] }, default: [] },
    groupAllowFrom: { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] }, default: [] },
    groups: { type: 'object', default: {} },
    dms: { type: 'object', default: {} },
    replyToMode: { type: 'string', enum: ['off', 'first', 'all'], default: 'first' },
    streamMode: { type: 'string', enum: ['off', 'partial', 'block'], default: 'off' },
    draftChunk: {
      type: 'object',
      properties: {
        minChars: { type: 'number', default: 200 },
        maxChars: { type: 'number', default: 800 },
        breakPreference: { type: 'string', enum: ['paragraph', 'sentence', 'word'], default: 'paragraph' },
      },
    },
    mediaMaxMb: { type: 'number', default: 5 },
    historyLimit: { type: 'number', default: 50 },
    dmHistoryLimit: { type: 'number' },
    reactionNotifications: { type: 'string', enum: ['off', 'own', 'all'], default: 'off' },
    reactionLevel: { type: 'string', enum: ['off', 'ack', 'minimal', 'extensive'], default: 'off' },
    enableInput: { type: 'boolean', default: false },
    enableBrowser: { type: 'boolean', default: false },
    debounceMs: { type: 'number', default: 500 },
    customCommands: { type: 'array', items: { type: 'object' }, default: [] },
  },
  default: {},
};

// Configuration store
const store = new Store<AgentConfig>({
  name: 'config',
  defaults: defaultConfig,
  schema: {
    agentId: { type: 'string' },
    salonId: { type: 'string' },
    salonName: { type: 'string' },
    machineId: { type: 'string' },
    registerCode: { type: 'string' },
    name: { type: 'string', default: 'Zira AI' },
    language: { type: 'string', enum: ['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl'], default: 'en' },
    apiKey: { type: 'string' },
    // Multi-printer dictionary config (NEW)
    printers: printersConfigSchema,
    multiPrinterMode: { type: 'boolean', default: false },
    // Legacy multi-printer config
    receiptPrinter: printerConfigSchema,
    labelPrinter: printerConfigSchema,
    // Legacy single printer settings
    printerPort: { type: 'string' },
    printerProtocol: { type: 'string', enum: ['THERMAL', 'POSNET', 'ZEBRA', 'WINDOWS'], default: 'THERMAL' },
    printerBaudRate: { type: 'number', default: 9600 },
    zebraPrinter: { type: 'string' },
    labelWidth: { type: 'number', default: 100 },
    labelHeight: { type: 'number', default: 50 },
    serverUrl: { type: 'string', default: 'https://api.enail.pro' },
    isPaired: { type: 'boolean', default: false },
    autoStart: { type: 'boolean', default: true },
    encryptedToken: { type: 'string' },
    // Telegram Remote Control settings (Moltbot-style)
    telegram: telegramConfigSchema,
    // Legacy Telegram settings (for migration)
    telegramEnabled: { type: 'boolean', default: false },
    telegramToken: { type: 'string', default: '' },
    encryptedTelegramToken: { type: 'string', default: '' },
    telegramAllowedIds: { type: 'array', items: { type: 'number' }, default: [] },
    telegramEnableInput: { type: 'boolean', default: false },
    telegramEnableBrowser: { type: 'boolean', default: false },
    // Zira AI settings
    aiEnabled: { type: 'boolean', default: false },
    aiApiKey: { type: 'string', default: '' },
    encryptedAiApiKey: { type: 'string', default: '' },
    aiLocalMode: { type: 'boolean', default: false }, // Enable local AI with tools (requires API key)
    aiProxyMode: { type: 'boolean', default: true }, // Use server proxy (secure, no tools)
    aiModel: { type: 'string', default: 'x-ai/grok-4.1-fast' },
    aiMaxTokens: { type: 'number', default: 1024 },
    aiTemperature: { type: 'number', default: 0.7 },
    aiProvider: { type: 'string', enum: ['openrouter', 'openai', 'anthropic', 'google', 'local'], default: 'openrouter' },
    aiSystemPrompt: { type: 'string', default: '' },
    // POS settings
    posEnabled: { type: 'boolean', default: true },
    posMode: { type: 'string', enum: ['retail', 'salon', 'b2b', 'restaurant'], default: 'retail' },
    posLanguage: { type: 'string', enum: ['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl'] },
    customerDisplayLanguage: { type: 'string', enum: ['en', 'vi', 'tr', 'zh', 'uk', 'ru', 'pl', ''] },
    customerDisplayEnabled: { type: 'boolean', default: true },
    customerDisplayMonitor: { type: 'number', default: 0 },
    // When true (default), customer display opens in true fullscreen kiosk even on
    // single-monitor setups. Set to false on dev machines to keep the old windowed
    // fallback so the screen isn't fully taken over. Esc and 3-finger swipe-down still exit.
    customerDisplayForceKiosk: { type: 'boolean', default: true },
    customerDisplayPromoFolder: { type: 'string', default: '' },
    customerDisplayPromoInterval: { type: 'number', default: 5000 },
    customerDisplayIdleTimeout: { type: 'number', default: 120000 },
    // Booksy Sync settings
    booksy: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: false },
        businessId: { type: 'string', default: '304504' },
        cdpPort: { type: 'number', default: 9222 },
        enailApiUrl: { type: 'string', default: '' },
        enailJwt: { type: 'string', default: '' },
        encryptedEnailJwt: { type: 'string', default: '' },
        telegramBotToken: { type: 'string', default: '' },
        telegramChatId: { type: 'string', default: '' },
        syncIntervalMin: { type: 'number', default: 30 },
        workStartHour: { type: 'number', default: 7 },
        workStartMin: { type: 'number', default: 30 },
        workEndHour: { type: 'number', default: 18 },
        workEndMin: { type: 'number', default: 30 },
        workDays: { type: 'array', items: { type: 'number' }, default: [1, 2, 3, 4, 5, 6] },
      },
      default: {},
    },
    // Auth (Telegram Login)
    // SECURITY: authToken should be stored encrypted, plain text for migration only
    authToken: { type: 'string', default: '' },
    encryptedAuthToken: { type: 'string', default: '' },
    authUser: { type: 'object', default: {} },
    // API Key (for print-agent connection) - Note: apiKey schema is at line 137
    encryptedApiKey: { type: 'string', default: '' },
    // Security Camera AI
    security: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: false },
        cameras: { type: 'array', items: { type: 'object' }, default: [] },
        modelSize: { type: 'string', default: 'yolov8n' },
        fireModelPath: { type: 'string' },
        cooldownSeconds: { type: 'number', default: 300 },
        snapshotOnAlert: { type: 'boolean', default: true },
        clipOnAlert: { type: 'boolean', default: true },
        clipDurationSeconds: { type: 'number', default: 20 },
        evidenceRetentionDays: { type: 'number', default: 30 },
        evidencePath: { type: 'string' },
        telegramAlertEnabled: { type: 'boolean', default: false },
        telegramChatId: { type: 'string', default: '' },
        mjpegPort: { type: 'number', default: 9090 },
        analyticsEnabled: { type: 'boolean', default: false },
        analyticsReportHour: { type: 'number', default: 23 },
        businessHoursStart: { type: 'string', default: '09:00' },
        businessHoursEnd: { type: 'string', default: '21:00' },
        businessDays: { type: 'array', items: { type: 'number' }, default: [1, 2, 3, 4, 5, 6] },
      },
      default: {},
    },
    // SSH Remote Support
    sshTunnelEnabled: { type: 'boolean', default: false },
    // Unattended Remote Access
    remoteAccessEnabled: { type: 'boolean', default: false },
    remoteAccessPin: { type: 'string', default: '' },
    encryptedRemotePin: { type: 'string', default: '' },
    // UI sidebar state
    sidebarCollapsed: { type: 'boolean', default: false },
    // User-hidden tabs
    hiddenTabs: { type: 'array', items: { type: 'string' }, default: [] },
    // Check-in display toggles
    checkinShowStatsBar: { type: 'boolean', default: true },
    checkinShowQueue: { type: 'boolean', default: true },
  } as any,
});

function inferMultiPrinterMode(config: Partial<AgentConfig>): boolean {
  return !!(
    (config.printers && Object.keys(config.printers).length > 0) ||
    config.receiptPrinter?.enabled ||
    config.labelPrinter?.enabled
  );
}

if (!store.has('multiPrinterMode')) {
  store.set('multiPrinterMode', inferMultiPrinterMode(store.store));
}

/**
 * Get configuration
 */
export function getConfig(): AgentConfig {
  return store.store;
}

/**
 * Update configuration
 */
export function setConfig(config: Partial<AgentConfig>): AgentConfig {
  store.set(config);
  return store.store;
}

/**
 * Reset to defaults
 */
export function resetConfig(): AgentConfig {
  store.clear();
  return store.store;
}

/**
 * Get specific value
 */
export function getConfigValue<K extends keyof AgentConfig>(key: K): AgentConfig[K] {
  return store.get(key);
}

/**
 * Set specific value
 */
export function setConfigValue<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]): void {
  store.set(key, value);
}

// Import safeStorage for encryption (lazy import to avoid circular dependency)
let safeStorageModule: typeof import('electron').safeStorage | null = null;
function getSafeStorage() {
  if (!safeStorageModule) {
    safeStorageModule = require('electron').safeStorage;
  }
  return safeStorageModule;
}

/**
 * SECURITY: Securely store auth token using Windows DPAPI encryption
 * This prevents token theft from config file
 */
export function setSecureAuthToken(token: string): boolean {
  const safeStorage = getSafeStorage();

  // Always clear plain text for security
  store.set('authToken', '');

  if (!token) {
    store.set('encryptedAuthToken', '');
    return true;
  }

  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(token).toString('base64');
      store.set('encryptedAuthToken', encrypted);
      return true;
    } catch (error) {
      console.error('[Config] Failed to encrypt auth token:', error);
      return false;
    }
  } else {
    // SECURITY: If encryption not available, reject token
    console.error('[Config] SECURITY: Encryption not available - auth token REJECTED');
    store.set('encryptedAuthToken', '');
    return false;
  }
}

/**
 * SECURITY: Securely retrieve auth token (decrypted)
 * Returns null if token not available or decryption fails
 */
export function getSecureAuthToken(): string | null {
  const safeStorage = getSafeStorage();

  // Try encrypted token first
  const encryptedToken = store.get('encryptedAuthToken') as string | undefined;
  if (encryptedToken && safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encryptedToken, 'base64'));
    } catch (error) {
      console.error('[Config] Failed to decrypt auth token:', error);
    }
  }

  // Migration: Check for legacy plain text token and encrypt it
  const plainToken = store.get('authToken') as string | undefined;
  if (plainToken) {
    console.warn('[Config] Migrating plain text auth token to encrypted storage...');
    if (setSecureAuthToken(plainToken)) {
      console.info('[Config] Auth token migrated successfully');
      return plainToken;
    }
  }

  return null;
}

/**
 * SECURITY: Securely store API key using Windows DPAPI encryption
 */
export function setSecureApiKey(apiKey: string): boolean {
  const safeStorage = getSafeStorage();

  // Always clear plain text for security
  store.set('apiKey', '');

  if (!apiKey) {
    store.set('encryptedApiKey', '');
    return true;
  }

  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(apiKey).toString('base64');
      store.set('encryptedApiKey', encrypted);
      return true;
    } catch (error) {
      console.error('[Config] Failed to encrypt API key:', error);
      return false;
    }
  } else {
    console.error('[Config] SECURITY: Encryption not available - API key REJECTED');
    store.set('encryptedApiKey', '');
    return false;
  }
}

/**
 * SECURITY: Securely retrieve API key (decrypted)
 */
export function getSecureApiKey(): string | null {
  const safeStorage = getSafeStorage();

  // Try encrypted key first
  const encryptedKey = store.get('encryptedApiKey') as string | undefined;
  if (encryptedKey && safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'));
    } catch (error) {
      console.error('[Config] Failed to decrypt API key:', error);
    }
  }

  // Migration: Check for legacy plain text key and encrypt it
  const plainKey = store.get('apiKey') as string | undefined;
  if (plainKey) {
    console.warn('[Config] Migrating plain text API key to encrypted storage...');
    if (setSecureApiKey(plainKey)) {
      console.info('[Config] API key migrated successfully');
      return plainKey;
    }
  }

  return null;
}

/**
 * SECURITY: Securely store AI API key (OpenRouter) using Windows DPAPI encryption
 */
export function setSecureAiApiKey(aiApiKey: string): boolean {
  const safeStorage = getSafeStorage();

  // Always clear plain text for security
  store.set('aiApiKey', '');

  if (!aiApiKey) {
    store.set('encryptedAiApiKey', '');
    return true;
  }

  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(aiApiKey).toString('base64');
      store.set('encryptedAiApiKey', encrypted);
      return true;
    } catch (error) {
      console.error('[Config] Failed to encrypt AI API key:', error);
      return false;
    }
  } else {
    console.error('[Config] SECURITY: Encryption not available - AI API key REJECTED');
    store.set('encryptedAiApiKey', '');
    return false;
  }
}

/**
 * SECURITY: Securely retrieve AI API key (decrypted)
 */
export function getSecureAiApiKey(): string | null {
  const safeStorage = getSafeStorage();

  // Try encrypted key first
  const encryptedKey = store.get('encryptedAiApiKey') as string | undefined;
  if (encryptedKey && safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'));
    } catch (error) {
      console.error('[Config] Failed to decrypt AI API key:', error);
    }
  }

  // Migration: Check for legacy plain text key and encrypt it
  const plainKey = store.get('aiApiKey') as string | undefined;
  if (plainKey) {
    console.warn('[Config] Migrating plain text AI API key to encrypted storage...');
    if (setSecureAiApiKey(plainKey)) {
      console.info('[Config] AI API key migrated successfully');
      return plainKey;
    }
  }

  return null;
}

/**
 * SECURITY: Securely store remote access PIN using Windows DPAPI encryption
 */
export function setSecureRemotePin(pin: string): boolean {
  const safeStorage = getSafeStorage();

  // Always clear plain text for security
  store.set('remoteAccessPin', '');

  if (!pin) {
    store.set('encryptedRemotePin', '');
    return true;
  }

  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = safeStorage.encryptString(pin).toString('base64');
      store.set('encryptedRemotePin', encrypted);
      return true;
    } catch (error) {
      console.error('[Config] Failed to encrypt remote PIN:', error);
      return false;
    }
  } else {
    console.error('[Config] SECURITY: Encryption not available - remote PIN REJECTED');
    store.set('encryptedRemotePin', '');
    return false;
  }
}

/**
 * SECURITY: Securely retrieve remote access PIN (decrypted)
 */
export function getSecureRemotePin(): string | null {
  const safeStorage = getSafeStorage();

  // Try encrypted PIN first
  const encryptedPin = store.get('encryptedRemotePin') as string | undefined;
  if (encryptedPin && safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encryptedPin, 'base64'));
    } catch (error) {
      console.error('[Config] Failed to decrypt remote PIN:', error);
    }
  }

  // Migration: Check for legacy plain text PIN and encrypt it
  const plainPin = store.get('remoteAccessPin') as string | undefined;
  if (plainPin) {
    console.warn('[Config] Migrating plain text remote PIN to encrypted storage...');
    if (setSecureRemotePin(plainPin)) {
      console.info('[Config] Remote PIN migrated successfully');
      return plainPin;
    }
  }

  return null;
}

/**
 * SECURITY: Clear all sensitive tokens (for logout)
 */
export function clearSecureTokens(): void {
  store.set('authToken', '');
  store.set('encryptedAuthToken', '');
  store.set('apiKey', '');
  store.set('encryptedApiKey', '');
  store.set('aiApiKey', '');
  store.set('encryptedAiApiKey', '');
}

export default store;
