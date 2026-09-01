import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InvoiceGatewayTokenProvider } from './client';
import { InvoiceGatewayBridgeError } from './errors';

export const ZIRA_INVOICE_BRIDGE_DEFAULT_APP_IDENTIFIER = 'com.zira.invoice';
export const ZIRA_INVOICE_BRIDGE_E2E_APP_IDENTIFIER = 'com.zira.invoice.bridge-e2e';
export const ZIRA_INVOICE_BRIDGE_TOKEN_FILENAME = 'pos-bridge-token';

const MAX_TOKEN_BYTES = 512;

export interface ZiraInvoiceBridgeTokenPathOptions {
  appIdentifier?: string;
  tokenPath?: string;
}

export interface ZiraInvoiceBridgeFileTokenProviderOptions
  extends ZiraInvoiceBridgeTokenPathOptions {
  appDataDir?: () => string;
  readText?: (path: string) => Promise<string>;
}

function cleanAppIdentifier(value: string | undefined): string {
  const identifier = String(value || ZIRA_INVOICE_BRIDGE_DEFAULT_APP_IDENTIFIER).trim();
  if (!/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(identifier)) {
    throw new InvoiceGatewayBridgeError(
      'Zira Invoice bridge application identifier is invalid',
      'BRIDGE_TOKEN_PATH_INVALID',
      false,
    );
  }
  return identifier;
}

/**
 * Resolve the companion token without importing Electron or any POS runtime.
 * Production callers omit options and retain the historical
 * `com.zira.invoice/pos-bridge-token` location. Isolated runners must pass an
 * explicit E2E identifier or exact token path.
 */
export function ziraInvoiceBridgeTokenPath(
  appDataDir: string,
  options: ZiraInvoiceBridgeTokenPathOptions = {},
): string {
  if (options.tokenPath !== undefined) {
    const explicitPath = String(options.tokenPath).trim();
    if (!explicitPath) {
      throw new InvoiceGatewayBridgeError(
        'Zira Invoice bridge token path is invalid',
        'BRIDGE_TOKEN_PATH_INVALID',
        false,
      );
    }
    return explicitPath;
  }

  const root = String(appDataDir || '').trim();
  if (!root) {
    throw new InvoiceGatewayBridgeError(
      'Zira Invoice bridge app data path is invalid',
      'BRIDGE_TOKEN_PATH_INVALID',
      false,
    );
  }
  return join(
    root,
    cleanAppIdentifier(options.appIdentifier),
    ZIRA_INVOICE_BRIDGE_TOKEN_FILENAME,
  );
}

export function createZiraInvoiceBridgeFileTokenProvider(
  options: ZiraInvoiceBridgeFileTokenProviderOptions,
): InvoiceGatewayTokenProvider {
  const readText = options.readText ?? ((path) => readFile(path, 'utf8'));
  return async () => {
    const tokenPath = ziraInvoiceBridgeTokenPath(
      options.appDataDir?.() ?? '',
      options,
    );
    let raw: string;
    try {
      raw = await readText(tokenPath);
    } catch {
      throw new InvoiceGatewayBridgeError(
        'Zira Invoice bridge token is not available yet',
        'BRIDGE_TOKEN_UNAVAILABLE',
        true,
      );
    }
    const token = raw.trim();
    if (token.length < 32 || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
      throw new InvoiceGatewayBridgeError(
        'Zira Invoice bridge token is missing, truncated, or oversized',
        'BRIDGE_TOKEN_INVALID',
        false,
      );
    }
    return token;
  };
}
