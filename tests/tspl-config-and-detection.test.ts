import { describe, expect, it } from 'vitest';

import { ALLOWED_PROTOCOLS_BY_TYPE, PrinterType } from '../src/shared/types';
import { BRAND_PATTERNS, matchBrand } from '../src/main/hardware/detection/types';

/**
 * Regression cover for the two ways a TSPL printer went missing:
 * the electron-store schema rejecting the protocol, and brand detection
 * mistaking an office inkjet for a TSC label printer.
 */

describe('TSPL is a first-class protocol end to end', () => {
  it('is offered for the slots that can drive a TSC', () => {
    expect(ALLOWED_PROTOCOLS_BY_TYPE[PrinterType.LABEL]).toContain('TSPL');
    expect(ALLOWED_PROTOCOLS_BY_TYPE[PrinterType.FABRIC_TAG]).toEqual(['TSPL']);
  });

  it('every protocol the UI can offer is accepted by the config schema', async () => {
    // The schema is a plain literal in store.ts; reading it through the module
    // would boot electron-store, so assert against the source of truth instead.
    const fs = await import('node:fs/promises');
    const source = await fs.readFile('src/main/config/store.ts', 'utf8');

    // Both the per-slot `protocol` and the legacy single-printer
    // `printerProtocol` gate what can be saved.
    const enums = [...source.matchAll(/(?:printerP|p)rotocol: \{ type: 'string', enum: \[([^\]]+)\]/g)]
      .map((m) => m[1].split(',').map((s) => s.trim().replace(/'/g, '')));
    expect(enums.length).toBeGreaterThanOrEqual(2);

    const offered = new Set(Object.values(ALLOWED_PROTOCOLS_BY_TYPE).flat());
    const printerEnums = enums.filter((e) => e.includes('THERMAL'));
    expect(printerEnums.length).toBe(2);
    for (const accepted of printerEnums) {
      for (const protocol of offered) {
        expect(accepted, `schema rejects ${protocol}`).toContain(protocol);
      }
    }
  });

  it('stores a FABRIC_TAG slot under schema validation like every other slot', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile('src/main/config/store.ts', 'utf8');
    const block = /const printersConfigSchema = \{[\s\S]*?\n\};/.exec(source);
    expect(block).not.toBeNull();
    for (const type of Object.values(PrinterType)) {
      expect(block![0], `printersConfigSchema is missing ${type}`).toContain(`${type}: printerConfigSchema`);
    }
  });
});

describe('matchBrand prefers a brand name over a model fragment', () => {
  it('does not read a Canon MAXIFY MB2750 as a TSC label printer', () => {
    const brand = matchBrand('Canon MAXIFY MB2750');
    expect(brand?.brand).toBe('Canon');
    expect(brand?.defaultType).toBe('A4');
  });

  it('still identifies a real TSC by name', () => {
    expect(matchBrand('TSC MB241')?.brand).toBe('TSC');
    expect(matchBrand('TSC MB241')?.defaultProtocol).toBe('TSPL');
  });

  it('still identifies a TSC by a bare model number', () => {
    expect(matchBrand('MB240')?.brand).toBe('TSC');
    expect(matchBrand('TTP-244 Pro')?.brand).toBe('TSC');
  });

  it('keeps other brands matching their own names', () => {
    expect(matchBrand('ZDesigner GK420d')?.brand).toBe('Zebra');
    expect(matchBrand('EPSON TM-T20III')?.brand).toBe('Epson');
    expect(matchBrand('Honeywell PC42E-D 203dpi')?.brand).toBe('Honeywell');
    expect(matchBrand('HP LaserJet 1020')?.brand).toBe('HP');
  });

  it('returns null for a name no pattern covers', () => {
    expect(matchBrand('Microsoft Print to PDF')).toBeNull();
  });

  it('has no brand whose only patterns are digit-bearing fragments', () => {
    // Such a brand could only ever be reached in the second pass, which is
    // exactly the collision-prone path this ordering exists to avoid.
    for (const bp of BRAND_PATTERNS) {
      expect(bp.namePatterns.some((p) => !/\d/.test(p)), `${bp.brand} has no brand-name pattern`).toBe(true);
    }
  });
});
