/**
 * Feature Entitlements Controller
 *
 * Handles feature access control per salon.
 * Entitlements are fetched from backend and cached locally.
 * SuperAdmin can control which features are available for each salon via admin panel.
 */

import { ipcMain, BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  SalonEntitlements,
  FeatureKey,
  FeatureEntitlement,
  DEFAULT_ENTITLEMENTS,
  DeleteConfirmConfig,
} from '../../shared/types';
import { getConfig, setConfig } from '../config/store';

// Default delete confirmation config
const DEFAULT_DELETE_CONFIRM: DeleteConfirmConfig = {
  enabled: true,
  code: '123456',
};

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION_MS = 60 * 60 * 1000;

/**
 * Fetch entitlements from backend API
 */
async function fetchEntitlementsFromBackend(salonId: string): Promise<SalonEntitlements | null> {
  const config = getConfig();
  if (!config.serverUrl || !config.authToken) {
    console.log('[Entitlements] No server URL or auth token, cannot fetch entitlements');
    return null;
  }

  try {
    const response = await fetch(`${config.serverUrl}/api/v1/admin/desktop/entitlements`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.authToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      // If API returns 404 or error, use defaults
      console.log('[Entitlements] API returned', response.status, ', using defaults');
      return createDefaultEntitlements(salonId, config.salonName || '');
    }

    const data = await response.json();

    // Validate and normalize response
    if (data.success && data.data) {
      return normalizeEntitlements(data.data);
    }

    return createDefaultEntitlements(salonId, config.salonName || '');
  } catch (error) {
    console.error('[Entitlements] Failed to fetch from backend:', error);
    // Return defaults on network error
    return createDefaultEntitlements(salonId, config.salonName || '');
  }
}

/**
 * Create default entitlements (for offline/error cases)
 */
function createDefaultEntitlements(salonId: string, salonName: string): SalonEntitlements {
  const features: Record<FeatureKey, FeatureEntitlement> = {} as any;

  for (const [key, enabled] of Object.entries(DEFAULT_ENTITLEMENTS)) {
    features[key as FeatureKey] = {
      featureKey: key as FeatureKey,
      enabled,
    };
  }

  return {
    salonId,
    salonCode: '',
    salonName,
    plan: 'free',
    features,
    fetchedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
  };
}

/**
 * Normalize entitlements response from backend
 */
function normalizeEntitlements(data: any): SalonEntitlements {
  const features: Record<FeatureKey, FeatureEntitlement> = {} as any;

  // Start with defaults
  for (const [key, enabled] of Object.entries(DEFAULT_ENTITLEMENTS)) {
    features[key as FeatureKey] = {
      featureKey: key as FeatureKey,
      enabled,
    };
  }

  // Override with server data
  if (data.features) {
    for (const [key, value] of Object.entries(data.features)) {
      if (key in DEFAULT_ENTITLEMENTS) {
        const entitlement = value as any;
        features[key as FeatureKey] = {
          featureKey: key as FeatureKey,
          enabled: entitlement.enabled ?? DEFAULT_ENTITLEMENTS[key as FeatureKey],
          expiresAt: entitlement.expiresAt,
          trialEndsAt: entitlement.trialEndsAt,
        };
      }
    }
  }

  return {
    salonId: data.salonId || '',
    salonCode: data.salonCode || '',
    salonName: data.salonName || '',
    plan: data.plan || 'free',
    features,
    fetchedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
  };
}

/**
 * Check if cached entitlements are still valid
 */
function isCacheValid(entitlements: SalonEntitlements | undefined): boolean {
  if (!entitlements) return false;

  const validUntil = new Date(entitlements.validUntil);
  return validUntil > new Date();
}

/**
 * Check if a specific feature is enabled
 */
function isFeatureEnabled(feature: FeatureKey, entitlements: SalonEntitlements | undefined): boolean {
  if (!entitlements) {
    return DEFAULT_ENTITLEMENTS[feature];
  }

  const entitlement = entitlements.features[feature];
  if (!entitlement) {
    return DEFAULT_ENTITLEMENTS[feature];
  }

  if (!entitlement.enabled) {
    return false;
  }

  // Check expiry
  if (entitlement.expiresAt) {
    const now = new Date();
    const expiry = new Date(entitlement.expiresAt);
    if (now > expiry) {
      return false;
    }
  }

  return true;
}

/**
 * Notify renderer about entitlements change
 */
function notifyEntitlementsChanged(mainWindow: BrowserWindow | null, entitlements: SalonEntitlements) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.ENTITLEMENTS_CHANGED, entitlements);
  }
}

/**
 * Register IPC handlers for entitlements
 */
export function registerEntitlementsHandlers(mainWindow: BrowserWindow | null) {
  console.log('[Entitlements] Registering IPC handlers');

  // Fetch entitlements from backend (and update cache)
  ipcMain.handle(IPC_CHANNELS.ENTITLEMENTS_FETCH, async () => {
    const config = getConfig();
    const salonId = config.salonId || config.authUser?.salonId || '';

    console.log('[Entitlements] Fetching entitlements for salon:', salonId);

    const entitlements = await fetchEntitlementsFromBackend(salonId);

    if (entitlements) {
      // Save to config cache
      setConfig({ entitlements });
      // Notify renderer
      notifyEntitlementsChanged(mainWindow, entitlements);
    }

    return entitlements;
  });

  // Get cached entitlements (or fetch if expired)
  ipcMain.handle(IPC_CHANNELS.ENTITLEMENTS_GET, async () => {
    const config = getConfig();

    // Check if cache is valid
    if (config.entitlements && isCacheValid(config.entitlements)) {
      return config.entitlements;
    }

    // Cache expired or missing, fetch from backend
    const salonId = config.salonId || config.authUser?.salonId || '';
    const entitlements = await fetchEntitlementsFromBackend(salonId);

    if (entitlements) {
      setConfig({ entitlements });
    }

    return entitlements || config.entitlements || null;
  });

  // Check if a specific feature is enabled
  ipcMain.handle(IPC_CHANNELS.ENTITLEMENTS_IS_ENABLED, async (_event, feature: FeatureKey) => {
    const config = getConfig();
    return isFeatureEnabled(feature, config.entitlements);
  });

  // Get delete confirmation config
  ipcMain.handle(IPC_CHANNELS.DELETE_CONFIRM_GET_CONFIG, async () => {
    const config = getConfig();
    return config.deleteConfirm || DEFAULT_DELETE_CONFIRM;
  });

  // Verify delete confirmation code
  ipcMain.handle(IPC_CHANNELS.DELETE_CONFIRM_VERIFY, async (_event, code: string) => {
    const config = getConfig();
    const deleteConfig = config.deleteConfirm || DEFAULT_DELETE_CONFIRM;

    if (!deleteConfig.enabled) {
      return { valid: true };
    }

    return { valid: code === deleteConfig.code };
  });

  console.log('[Entitlements] IPC handlers registered');
}

/**
 * Export for use in guards
 */
export { isFeatureEnabled, isCacheValid, fetchEntitlementsFromBackend };
