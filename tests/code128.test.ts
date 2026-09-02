import { describe, it, expect } from 'vitest';
import { encodeCode128, CODE128_QUIET_ZONE_MODULES } from '../src/shared/code128';

/**
 * Reference vectors come from the GS1 General Specifications Code 128 symbology
 * definition. A symbol is: quiet zone, start code, data, checksum, stop pattern
 * (which carries its own 2-module bar), quiet zone.
 *
 * We assert on the module pattern (a run-length string of bar/space widths)
 * rather than pixels, so the encoder can be checked without a renderer.
 */
describe('encodeCode128', () => {
  it('encodes an alphanumeric SKU, switching to Code C for the digit tail', () => {
    // "SP006290" — the sticker code photographed at the factory.
    // S,P in Code B (char code - 32), then 00 62 90 packed two digits per code.
    const symbol = encodeCode128('SP006290');
    const expectedData = [51, 48, /* switch to C */ 99, 0, 62, 90];

    expect(symbol.values[0]).toBe(104); // Start B
    expect(symbol.values.slice(1, 7)).toEqual(expectedData);

    // Checksum = (start + sum(value * position)) mod 103.
    const expectedChecksum =
      (104 + expectedData.reduce((sum, v, i) => sum + v * (i + 1), 0)) % 103;
    expect(symbol.checksum).toBe(expectedChecksum);
    expect(symbol.values[7]).toBe(expectedChecksum);

    // Stop pattern is always the final code.
    expect(symbol.values[8]).toBe(106);
  });

  it('starts every pattern with a bar and ends the stop code with a bar', () => {
    const symbol = encodeCode128('SP006250');
    expect(symbol.modules[0]).toBe(1);
    expect(symbol.modules[symbol.modules.length - 1]).toBe(1);
  });

  it('produces the documented module count: 11 per code, 13 for stop', () => {
    const symbol = encodeCode128('SP006290');
    // 8 codes before the stop (start, S, P, switch-C, 00, 62, 90, checksum).
    expect(symbol.values.length).toBe(9);
    expect(symbol.modules.length).toBe((symbol.values.length - 1) * 11 + 13);
  });

  it('keeps the Code C switch worthwhile — never longer than plain Code B', () => {
    // A mode switch costs a whole code; the heuristic must not lose that bet.
    for (const code of ['SP006290', 'SP006250', '114', 'A1', 'KURTKA-114', '5901234123457']) {
      const actual = encodeCode128(code).modules.length;
      const plainCodeB = (2 + code.length) * 11 + 13; // start + data + checksum + stop
      expect(actual).toBeLessThanOrEqual(plainCodeB);
    }
  });

  it('emits the canonical start-B pattern 11010010000', () => {
    const symbol = encodeCode128('A');
    expect(symbol.modules.slice(0, 11).join('')).toBe('11010010000');
  });

  it('emits the canonical stop pattern 1100011101011', () => {
    const symbol = encodeCode128('A');
    expect(symbol.modules.slice(-13).join('')).toBe('1100011101011');
  });

  it('switches to Code C for long digit runs to keep the symbol narrow', () => {
    // 10 digits: Code C packs them two per code, so it must be shorter than Code B.
    const codeC = encodeCode128('0123456789');
    const codeB = encodeCode128('ABCDEFGHIJ');
    expect(codeC.modules.length).toBeLessThan(codeB.modules.length);
    // Start C = 105.
    expect(codeC.values[0]).toBe(105);
    // Digit pairs 01,23,45,67,89 become values 1,23,45,67,89.
    expect(codeC.values.slice(1, 6)).toEqual([1, 23, 45, 67, 89]);
  });

  it('keeps an odd digit run valid by encoding the leftover digit in Code B', () => {
    const symbol = encodeCode128('12345');
    // Round-trips through the decoder below rather than asserting an exact mode plan.
    expect(decodeValues(symbol.values)).toBe('12345');
  });

  it('round-trips every sample the factory uses', () => {
    for (const code of ['SP006290', 'SP006250', 'KURTKA-114', '114', 'A1', '5901234123457']) {
      expect(decodeValues(encodeCode128(code).values)).toBe(code);
    }
  });

  it('round-trips a broad corpus, so no mode-switch heuristic can corrupt a code', () => {
    const alphabet = 'ABCXYZ0123456789-. ';
    let seed = 20260902;
    const random = () => {
      // Deterministic LCG: a failure here must be reproducible, not flaky.
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 500; i++) {
      const length = 1 + Math.floor(random() * 16);
      let code = '';
      for (let c = 0; c < length; c++) {
        code += alphabet[Math.floor(random() * alphabet.length)];
      }
      expect(decodeValues(encodeCode128(code).values)).toBe(code);
    }
  });

  it('rejects characters outside printable ASCII rather than printing a wrong code', () => {
    expect(() => encodeCode128('CZEKOLADĄ')).toThrow(/ASCII/i);
    expect(() => encodeCode128('a\tb')).toThrow(/ASCII/i);
  });

  it('rejects an empty code', () => {
    expect(() => encodeCode128('')).toThrow(/empty/i);
  });

  it('exposes a quiet zone of at least 10 modules per side', () => {
    // GS1 requires 10x the narrow module; scanners fail intermittently below that.
    expect(CODE128_QUIET_ZONE_MODULES).toBeGreaterThanOrEqual(10);
  });
});

/** Minimal Code 128 decoder used only to prove the encoder round-trips. */
function decodeValues(values: number[]): string {
  const codes = values.slice(0, -2); // drop checksum + stop
  let mode: 'B' | 'C' = codes[0] === 105 ? 'C' : 'B';
  let out = '';
  for (const value of codes.slice(1)) {
    // 99 and 100 are switch codes only in the mode that can leave for the other:
    // inside Code C, 99 is the digit pair "99" and 100 is the switch back to B.
    if (mode === 'C' && value === 100) {
      mode = 'B';
      continue;
    }
    if (mode === 'B' && value === 99) {
      mode = 'C';
      continue;
    }
    out += mode === 'C' ? String(value).padStart(2, '0') : String.fromCharCode(value + 32);
  }
  return out;
}
