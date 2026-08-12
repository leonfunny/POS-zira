/**
 * Device-local kiosk exit PIN for the Android customer check-in mode.
 *
 * This is deliberately separate from `salonCode`: salonCode identifies a
 * salon/device pairing and can be returned by ordinary configuration APIs. A
 * kiosk exit PIN is an operator secret. Its salted digest and the local
 * lockout state are stored only in the Keystore-backed SecureKV plugin.
 *
 * There is intentionally no localStorage fallback. A browser build, an unset
 * plugin, an unreadable value, or a failed write all fail closed: the customer
 * kiosk remains active until a staff member can use the native Android build
 * with working secure storage.
 */

import { getNativeSecureKv, type SecureKVPlugin } from './token-store';

export const KIOSK_EXIT_PIN_KEY = 'kiosk_exit_pin_v1';
export const KIOSK_EXIT_PIN_LOCKOUT_MS = 5 * 60 * 1000;
export const KIOSK_EXIT_PIN_MAX_ATTEMPTS = 5;

type StoredPinRecord = {
  version: 1;
  salt: string;
  digest: string;
  failedAttempts: number;
  lockedUntil: number | null;
};

export type KioskExitPinCode =
  | 'OK'
  | 'INVALID_PIN'
  | 'UNSET'
  | 'LOCKED'
  | 'SECURE_STORAGE_UNAVAILABLE';

export type KioskExitPinResult = {
  success: boolean;
  code: KioskExitPinCode;
  lockedUntil?: number;
  attemptsRemaining?: number;
};

export type KioskExitPinStatus = {
  available: boolean;
  configured: boolean;
  lockedUntil: number | null;
  attemptsRemaining: number;
};

export interface KioskExitPinStoreOptions {
  /** Test seam only. Production resolves the Keystore-backed Capacitor plugin. */
  secureKv?: SecureKVPlugin | null;
  /** Test seam only. Never persisted as a clock value. */
  now?: () => number;
}

function validPin(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isStoredRecord(value: unknown): value is StoredPinRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<StoredPinRecord>;
  const failedAttempts = record.failedAttempts;
  const lockedUntil = record.lockedUntil;
  return record.version === 1
    && typeof record.salt === 'string'
    && record.salt.length >= 16
    && typeof record.digest === 'string'
    && record.digest.length >= 16
    && Number.isInteger(failedAttempts)
    && (failedAttempts as number) >= 0
    && (failedAttempts as number) <= KIOSK_EXIT_PIN_MAX_ATTEMPTS
    && (lockedUntil === null || (Number.isFinite(lockedUntil) && (lockedUntil as number) > 0));
}

function equalDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function digestPin(pin: string, salt: string, secureKv: SecureKVPlugin | null): Promise<string | null> {
  const cryptoApi = globalThis.crypto;
  const value = `${salt}:${pin}`;
  if (cryptoApi?.subtle && typeof TextEncoder !== 'undefined') {
    try {
      const payload = new TextEncoder().encode(value);
      const digest = await cryptoApi.subtle.digest('SHA-256', payload);
      return bytesToBase64(new Uint8Array(digest));
    } catch {
      // Continue to the native fallback. WebView 83 may expose SubtleCrypto
      // while refusing it on a non-secure live-debug origin.
    }
  }
  if (typeof secureKv?.sha256 === 'function') {
    try {
      const result = await secureKv.sha256({ value });
      return typeof result?.value === 'string' && result.value.length >= 16 ? result.value : null;
    } catch {
      return null;
    }
  }
  return null;
}

function createSalt(): string | null {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) return null;
  try {
    return bytesToBase64(cryptoApi.getRandomValues(new Uint8Array(16)));
  } catch {
    return null;
  }
}

/**
 * Uses only Android SecureKV. The stored payload is a salted SHA-256 digest,
 * never a plaintext PIN. It is a device-local gate, not an account credential.
 */
export class KioskExitPinStore {
  private readonly secureKv: SecureKVPlugin | null;
  private readonly now: () => number;

  constructor(options: KioskExitPinStoreOptions = {}) {
    this.secureKv = options.secureKv === undefined ? getNativeSecureKv() : options.secureKv;
    this.now = options.now ?? (() => Date.now());
  }

  async status(): Promise<KioskExitPinStatus> {
    const loaded = await this.load();
    if (loaded.code !== 'OK' || !loaded.record) {
      return { available: loaded.code !== 'SECURE_STORAGE_UNAVAILABLE', configured: false, lockedUntil: null, attemptsRemaining: 0 };
    }
    const lockedUntil = this.activeLock(loaded.record);
    return {
      available: true,
      configured: true,
      lockedUntil,
      attemptsRemaining: lockedUntil ? 0 : Math.max(0, KIOSK_EXIT_PIN_MAX_ATTEMPTS - loaded.record.failedAttempts),
    };
  }

  /** Set or replace the dedicated PIN. Invalid input is rejected without storage I/O. */
  async configure(pin: string): Promise<KioskExitPinResult> {
    if (!validPin(pin)) return { success: false, code: 'INVALID_PIN' };
    if (!this.secureKv) return { success: false, code: 'SECURE_STORAGE_UNAVAILABLE' };
    const salt = createSalt();
    if (!salt) return { success: false, code: 'SECURE_STORAGE_UNAVAILABLE' };
    const digest = await digestPin(pin, salt, this.secureKv);
    if (!digest) return { success: false, code: 'SECURE_STORAGE_UNAVAILABLE' };
    const next: StoredPinRecord = {
      version: 1,
      salt,
      digest,
      failedAttempts: 0,
      lockedUntil: null,
    };
    if (!await this.save(next)) return { success: false, code: 'SECURE_STORAGE_UNAVAILABLE' };
    return { success: true, code: 'OK', attemptsRemaining: KIOSK_EXIT_PIN_MAX_ATTEMPTS };
  }

  /** Verify one exit attempt and durably record the result before allowing exit. */
  async verify(pin: string): Promise<KioskExitPinResult> {
    if (!validPin(pin)) return { success: false, code: 'INVALID_PIN' };
    const loaded = await this.load();
    if (loaded.code !== 'OK' || !loaded.record) return { success: false, code: loaded.code };

    const lock = this.activeLock(loaded.record);
    if (lock) return { success: false, code: 'LOCKED', lockedUntil: lock, attemptsRemaining: 0 };

    const record = loaded.record.lockedUntil === null
      ? loaded.record
      : { ...loaded.record, lockedUntil: null, failedAttempts: 0 };
    const digest = await digestPin(pin, record.salt, this.secureKv);
    if (!digest) return { success: false, code: 'SECURE_STORAGE_UNAVAILABLE' };

    if (equalDigest(record.digest, digest)) {
      const reset = record.failedAttempts === 0 ? record : { ...record, failedAttempts: 0, lockedUntil: null };
      if (!await this.save(reset)) return { success: false, code: 'SECURE_STORAGE_UNAVAILABLE' };
      return { success: true, code: 'OK', attemptsRemaining: KIOSK_EXIT_PIN_MAX_ATTEMPTS };
    }

    const failedAttempts = Math.min(KIOSK_EXIT_PIN_MAX_ATTEMPTS, record.failedAttempts + 1);
    const lockedUntil = failedAttempts >= KIOSK_EXIT_PIN_MAX_ATTEMPTS
      ? this.now() + KIOSK_EXIT_PIN_LOCKOUT_MS
      : null;
    const next = { ...record, failedAttempts, lockedUntil };
    if (!await this.save(next)) return { success: false, code: 'SECURE_STORAGE_UNAVAILABLE' };
    return lockedUntil
      ? { success: false, code: 'LOCKED', lockedUntil, attemptsRemaining: 0 }
      : { success: false, code: 'INVALID_PIN', attemptsRemaining: KIOSK_EXIT_PIN_MAX_ATTEMPTS - failedAttempts };
  }

  private activeLock(record: StoredPinRecord): number | null {
    return record.lockedUntil && record.lockedUntil > this.now() ? record.lockedUntil : null;
  }

  private async load(): Promise<{ code: Exclude<KioskExitPinCode, 'INVALID_PIN' | 'LOCKED'>; record?: StoredPinRecord }> {
    if (!this.secureKv) return { code: 'SECURE_STORAGE_UNAVAILABLE' };
    try {
      const result = await this.secureKv.get({ key: KIOSK_EXIT_PIN_KEY });
      if (!result || result.value === null) return { code: 'UNSET' };
      const parsed = JSON.parse(result.value);
      return isStoredRecord(parsed)
        ? { code: 'OK', record: parsed }
        : { code: 'SECURE_STORAGE_UNAVAILABLE' };
    } catch {
      return { code: 'SECURE_STORAGE_UNAVAILABLE' };
    }
  }

  private async save(record: StoredPinRecord): Promise<boolean> {
    if (!this.secureKv) return false;
    try {
      await this.secureKv.set({ key: KIOSK_EXIT_PIN_KEY, value: JSON.stringify(record) });
      return true;
    } catch {
      return false;
    }
  }
}
