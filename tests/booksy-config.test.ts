import { describe, expect, it } from 'vitest';

import {
  applyBooksyConfigUpdate,
  decodeJwtPayload,
  extractJwtSalonId,
  sanitizeBooksyConfigForRenderer,
} from '../src/main/modules/booksy-config';

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

const appConfig = {
  salonId: 'salon-app',
  salonName: 'Dzai Sukcesja',
  authUser: {
    id: 'user-1',
    email: 'owner@example.com',
    firstName: 'Owner',
    lastName: 'User',
    role: 'OWNER',
    salonId: 'salon-app',
  },
} as any;

describe('Booksy config JWT helpers', () => {
  it('decodes JWT payloads without validating signatures', () => {
    expect(decodeJwtPayload(jwt({ salon_id: 'salon-1' }))).toEqual({ salon_id: 'salon-1' });
  });

  it('extracts likely salon claims from flat and nested payloads', () => {
    expect(extractJwtSalonId({ salonId: 'flat-camel' })).toBe('flat-camel');
    expect(extractJwtSalonId({ salon: { id: 'nested-id' } })).toBe('nested-id');
    expect(extractJwtSalonId({ user: { salon_id: 'nested-snake' } })).toBe('nested-snake');
  });

  it('preserves the existing encrypted JWT when unrelated settings are saved', () => {
    const result = applyBooksyConfigUpdate(
      { enabled: true, encryptedEnailJwt: 'encrypted-old', syncIntervalMin: 30 } as any,
      { syncIntervalMin: 15, enailJwt: undefined } as any,
      appConfig,
      (value) => `encrypted:${value}`,
    );

    expect(result.updated.encryptedEnailJwt).toBe('encrypted-old');
    expect(result.updated.syncIntervalMin).toBe(15);
    expect(result.response.hasJwt).toBe(true);
  });

  it('clears stored JWT only through the explicit clearJwt sentinel', () => {
    const result = applyBooksyConfigUpdate(
      { enabled: true, encryptedEnailJwt: 'encrypted-old', enailJwt: 'plain-old' } as any,
      { clearJwt: true } as any,
      appConfig,
      (value) => `encrypted:${value}`,
    );

    expect(result.updated.encryptedEnailJwt).toBeUndefined();
    expect(result.updated.enailJwt).toBeUndefined();
    expect(result.response.hasJwt).toBe(false);
    expect(sanitizeBooksyConfigForRenderer(result.updated, appConfig).hasJwt).toBe(false);
  });

  it('rejects a new JWT whose salon claim mismatches the current app salon', () => {
    const result = applyBooksyConfigUpdate(
      { enabled: true, encryptedEnailJwt: 'encrypted-old' } as any,
      { enailJwt: jwt({ salon_id: 'other-salon' }) } as any,
      appConfig,
      (value) => `encrypted:${value}`,
    );

    expect(result.updated.encryptedEnailJwt).toBe('encrypted-old');
    expect(result.response.jwtSalonMismatch).toBe(true);
    expect(result.response.jwtSalonId).toBe('other-salon');
    expect(result.response.appSalonId).toBe('salon-app');
  });

  it('returns app identity and Booksy business metadata without exposing the JWT', () => {
    const response = sanitizeBooksyConfigForRenderer(
      { businessId: '170219', encryptedEnailJwt: 'encrypted' } as any,
      appConfig,
      jwt({ salon_id: 'salon-app' }),
    );

    expect(response.enailJwt).toBeUndefined();
    expect(response.encryptedEnailJwt).toBeUndefined();
    expect(response.hasJwt).toBe(true);
    expect(response.appSalonName).toBe('Dzai Sukcesja');
    expect(response.appAuthEmail).toBe('owner@example.com');
    expect(response.businessId).toBe('170219');
    expect(response.jwtSalonMismatch).toBe(false);
  });

  it('warns when an existing stored JWT belongs to a different salon on GET-style sanitize', () => {
    const response = sanitizeBooksyConfigForRenderer(
      { businessId: '170219', encryptedEnailJwt: 'encrypted' } as any,
      appConfig,
      jwt({ salon_id: 'other-salon' }),
    );

    expect(response.hasJwt).toBe(true);
    expect(response.jwtSalonMismatch).toBe(true);
    expect(response.jwtSalonId).toBe('other-salon');
    expect(response.appSalonId).toBe('salon-app');
  });

  it('preserves an existing stored JWT mismatch warning when unrelated settings are saved', () => {
    const result = applyBooksyConfigUpdate(
      { enabled: true, encryptedEnailJwt: 'encrypted-old', syncIntervalMin: 30 } as any,
      { syncIntervalMin: 15, enailJwt: undefined } as any,
      appConfig,
      (value) => `encrypted:${value}`,
      jwt({ salon_id: 'other-salon' }),
    );

    expect(result.updated.encryptedEnailJwt).toBe('encrypted-old');
    expect(result.updated.syncIntervalMin).toBe(15);
    expect(result.response.hasJwt).toBe(true);
    expect(result.response.jwtSalonMismatch).toBe(true);
    expect(result.response.jwtSalonId).toBe('other-salon');
  });
});
