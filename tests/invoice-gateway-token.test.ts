import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ZIRA_INVOICE_BRIDGE_DEFAULT_APP_IDENTIFIER,
  ZIRA_INVOICE_BRIDGE_E2E_APP_IDENTIFIER,
  createZiraInvoiceBridgeFileTokenProvider,
  ziraInvoiceBridgeTokenPath,
} from '../src/main/invoice-gateway/token';

describe('dependency-light Zira Invoice bridge token helper', () => {
  it('keeps the production identifier as the default', () => {
    expect(ziraInvoiceBridgeTokenPath('/roaming')).toBe(
      join('/roaming', ZIRA_INVOICE_BRIDGE_DEFAULT_APP_IDENTIFIER, 'pos-bridge-token'),
    );
  });

  it('supports the isolated E2E identifier and an exact caller-supplied path', () => {
    expect(ziraInvoiceBridgeTokenPath('/e2e', {
      appIdentifier: ZIRA_INVOICE_BRIDGE_E2E_APP_IDENTIFIER,
    })).toBe(join('/e2e', ZIRA_INVOICE_BRIDGE_E2E_APP_IDENTIFIER, 'pos-bridge-token'));
    expect(ziraInvoiceBridgeTokenPath('/ignored', {
      tokenPath: '/isolated/token',
    })).toBe('/isolated/token');
  });

  it('reads and validates an explicit path without exposing token content in errors', async () => {
    const secret = 'e2e-secret-0123456789abcdef0123456789abcdef';
    const readText = vi.fn(async () => ` ${secret}\r\n`);
    const provider = createZiraInvoiceBridgeFileTokenProvider({
      tokenPath: '/isolated/token',
      readText,
    });

    await expect(provider()).resolves.toBe(secret);
    expect(readText).toHaveBeenCalledWith('/isolated/token');

    const invalid = createZiraInvoiceBridgeFileTokenProvider({
      tokenPath: '/isolated/token',
      readText: vi.fn(async () => 'short'),
    });
    try {
      await invalid();
      throw new Error('Expected invalid token provider to reject');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(error).toEqual(expect.objectContaining({
        code: 'BRIDGE_TOKEN_INVALID',
        retryable: false,
      }));
    }
  });

  it('rejects identifiers that could escape the app-data root', () => {
    expect(() => ziraInvoiceBridgeTokenPath('/roaming', { appIdentifier: '../foreign' }))
      .toThrowError(expect.objectContaining({ code: 'BRIDGE_TOKEN_PATH_INVALID' }));
  });
});
