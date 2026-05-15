import { describe, expect, it } from 'vitest';
import {
  lookupVid,
  validateProtocolAgainstVid,
} from '../src/main/hardware/detection/vid-protocol-registry';

describe('VID protocol registry', () => {
  describe('lookupVid', () => {
    it('returns POSNET for VID 1424', () => {
      const entry = lookupVid('1424');
      expect(entry?.brand).toBe('POSNET');
      expect(entry?.knownProtocols).toEqual(['POSNET']);
      expect(entry?.preferredProtocol).toBe('POSNET');
    });

    it('returns ELZAB for VID C1CA', () => {
      const entry = lookupVid('C1CA');
      expect(entry?.brand).toBe('ELZAB');
      expect(entry?.knownProtocols).toEqual(['ELZAB_STX']);
      expect(entry?.preferredProtocol).toBe('ELZAB_STX');
    });

    it('returns Zebra for VID 0A5F', () => {
      const entry = lookupVid('0A5F');
      expect(entry?.brand).toBe('Zebra');
      expect(entry?.knownProtocols).toEqual(['ZEBRA']);
    });

    it('returns Epson multi-protocol (THERMAL + WINDOWS) for VID 04B8', () => {
      const entry = lookupVid('04B8');
      expect(entry?.brand).toBe('Epson');
      expect(entry?.knownProtocols).toContain('THERMAL');
      expect(entry?.knownProtocols).toContain('WINDOWS');
    });

    it('returns null for unknown VID', () => {
      expect(lookupVid('FFFF')).toBeNull();
      expect(lookupVid('0000')).toBeNull();
    });

    it('returns null for empty / null', () => {
      expect(lookupVid('')).toBeNull();
      expect(lookupVid(null)).toBeNull();
      expect(lookupVid(undefined)).toBeNull();
    });

    it('handles lowercase input', () => {
      expect(lookupVid('c1ca')?.brand).toBe('ELZAB');
      expect(lookupVid('1424')?.brand).toBe('POSNET');
    });

    it('handles 0x prefix', () => {
      expect(lookupVid('0xC1CA')?.brand).toBe('ELZAB');
    });

    it('pads short VID to 4 chars', () => {
      expect(lookupVid('123')).toBeNull(); // 0123 not in registry
    });
  });

  describe('validateProtocolAgainstVid', () => {
    it('returns OK when ELZAB device matches ELZAB_STX protocol', () => {
      const r = validateProtocolAgainstVid('C1CA', 'ELZAB_STX');
      expect(r.ok).toBe(true);
      expect(r.code).toBe('OK');
      expect(r.detectedBrand).toBe('ELZAB');
    });

    it('returns OK when POSNET device matches POSNET protocol', () => {
      const r = validateProtocolAgainstVid('1424', 'POSNET');
      expect(r.ok).toBe(true);
      expect(r.code).toBe('OK');
    });

    it('rejects POSNET protocol on ELZAB device with mismatch + suggestion', () => {
      const r = validateProtocolAgainstVid('C1CA', 'POSNET');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('PROTOCOL_DEVICE_MISMATCH');
      expect(r.detectedBrand).toBe('ELZAB');
      expect(r.suggestedProtocol).toBe('ELZAB_STX');
      expect(r.detail).toMatch(/ELZAB/);
      expect(r.detail).toMatch(/POSNET/);
      expect(r.detail).toMatch(/ELZAB_STX/);
    });

    it('rejects ELZAB_STX on POSNET device', () => {
      const r = validateProtocolAgainstVid('1424', 'ELZAB_STX');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('PROTOCOL_DEVICE_MISMATCH');
      expect(r.suggestedProtocol).toBe('POSNET');
    });

    it('rejects THERMAL on Zebra device', () => {
      const r = validateProtocolAgainstVid('0A5F', 'THERMAL');
      expect(r.ok).toBe(false);
      expect(r.suggestedProtocol).toBe('ZEBRA');
    });

    it('allows multi-protocol device (Epson) for THERMAL', () => {
      const r = validateProtocolAgainstVid('04B8', 'THERMAL');
      expect(r.ok).toBe(true);
    });

    it('allows multi-protocol device (Epson) for WINDOWS', () => {
      const r = validateProtocolAgainstVid('04B8', 'WINDOWS');
      expect(r.ok).toBe(true);
    });

    it('rejects Epson for POSNET (not in Epson knownProtocols)', () => {
      const r = validateProtocolAgainstVid('04B8', 'POSNET');
      expect(r.ok).toBe(false);
      expect(r.detectedBrand).toBe('Epson');
    });

    it('allows unknown VID (silent pass — UNKNOWN_DEVICE)', () => {
      const r = validateProtocolAgainstVid('FFFF', 'POSNET');
      expect(r.ok).toBe(true);
      expect(r.code).toBe('UNKNOWN_DEVICE');
    });

    it('allows null VID (no USB device — NO_DEVICE_ON_PORT, e.g. ACPI motherboard COM1)', () => {
      const r = validateProtocolAgainstVid(null, 'POSNET');
      expect(r.ok).toBe(true);
      expect(r.code).toBe('NO_DEVICE_ON_PORT');
    });

    it('user real-world case: COM3 has ELZAB but slot is POSNET', () => {
      const r = validateProtocolAgainstVid('C1CA', 'POSNET');
      expect(r.ok).toBe(false);
      expect(r.detectedBrand).toBe('ELZAB');
      expect(r.suggestedProtocol).toBe('ELZAB_STX');
      expect(r.detail).toMatch(/VID_C1CA/);
    });
  });
});
