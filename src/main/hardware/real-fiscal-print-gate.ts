import { existsSync, readFileSync } from 'fs';
import path from 'path';

function getElectronUserDataPath(): string | undefined {
  try {
    const electron = require('electron');
    return electron?.app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

function resolveConfigPath(): string | undefined {
  const userData = getElectronUserDataPath();
  if (userData) return path.join(userData, 'config.json');
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'zira-ai', 'config.json');
  return undefined;
}

/**
 * Shared production kill switch for every driver that can send a real fiscal
 * command. The legacy ELZAB-specific override remains supported so existing
 * service tooling keeps failing closed.
 */
export function isRealFiscalPrintEnabled(): boolean {
  if (process.env.ALLOW_REAL_FISCAL_PRINT === 'true') return true;
  if (process.env.ZIRA_ELZAB_IGNORE_CONFIG_ALLOW_REAL === 'true') return false;
  try {
    const cfgPath = resolveConfigPath();
    if (!cfgPath || !existsSync(cfgPath)) return false;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    return cfg?.allowRealFiscalPrint === true;
  } catch {
    return false;
  }
}
