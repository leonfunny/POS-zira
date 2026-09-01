import { describe, expect, it } from 'vitest';

import { ALLOWED_PROTOCOLS_BY_TYPE, PrinterType } from '../src/shared/types';
import { BRAND_PATTERNS, matchBrand } from '../src/main/hardware/detection/types';
import { repairLegacyFabricTagPrinterConfig } from '../src/shared/fabric-tag-printer-config';
import {
  maxLabelOriginInsetMm,
  normalizePrintersConfig,
  sanitizePrinterConfigForPersistence,
  updatePrinterConfigState,
} from '../src/renderer/components/settings-printer-config';

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

  it('opens every slot on a protocol that slot accepts', async () => {
    // The shared default was THERMAL for all slots. FABRIC_TAG rejects it, and
    // because the protocol <select> lists only the allowed values, it rendered
    // as TSPL while the value underneath stayed THERMAL -- so every save was
    // refused by the backend and the screen gave no sign of it.
    const fs = await import('node:fs/promises');
    const settings = await fs.readFile('src/renderer/components/Settings.tsx', 'utf8');

    expect(settings).toContain('resolvePrinterConfigForType(');
    expect(settings).toContain('updatePrinterConfigState(prev, printerType, updates)');
  });

  it('stores normalized fabric defaults on the first real Settings edit', () => {
    const next = updatePrinterConfigState({}, PrinterType.FABRIC_TAG, {
      enabled: true,
      windowsPrinter: 'TSC MB241',
    });

    expect(next[PrinterType.FABRIC_TAG]).toMatchObject({
      enabled: true,
      protocol: 'TSPL',
      windowsPrinter: 'TSC MB241',
      labelWidth: 20,
      labelHeight: 60,
      mediaSensor: 'none',
      printSpeed: 2,
      printDensity: 12,
    });
  });

  it('normalizes an existing stale fabric slot when Settings hydrates it', () => {
    const normalized = normalizePrintersConfig({
      [PrinterType.FABRIC_TAG]: {
        enabled: true,
        protocol: 'THERMAL',
        windowsPrinter: 'TSC MB241',
      },
    });

    expect(normalized[PrinterType.FABRIC_TAG]).toMatchObject({
      enabled: true,
      protocol: 'TSPL',
      windowsPrinter: 'TSC MB241',
      labelWidth: 20,
      labelHeight: 60,
      mediaSensor: 'none',
      printSpeed: 2,
      printDensity: 12,
    });
  });

  it('repairs the fully materialized legacy THERMAL 50x30 sentinel only', () => {
    expect(repairLegacyFabricTagPrinterConfig({
      enabled: true,
      protocol: 'THERMAL',
      windowsPrinter: 'TSC MB241',
      labelWidth: 50,
      labelHeight: 30,
      paperWidth: 80,
      charsPerLine: 48,
    })).toMatchObject({
      protocol: 'TSPL',
      labelWidth: 20,
      labelHeight: 60,
      paperWidth: 20,
      charsPerLine: 32,
      labelGapMm: 0,
      mediaSensor: 'none',
      printSpeed: 2,
      printDensity: 12,
    });

    const intentional = {
      enabled: true,
      protocol: 'TSPL' as const,
      labelWidth: 25,
      labelHeight: 80,
    };
    expect(repairLegacyFabricTagPrinterConfig(intentional)).toBe(intentional);
  });

  it('does not create absent printer slots while normalizing Settings state', () => {
    const normalized = normalizePrintersConfig({
      [PrinterType.RECEIPT]: {
        enabled: true,
        protocol: 'THERMAL',
      },
    });

    expect(normalized[PrinterType.RECEIPT]).toBeDefined();
    expect(normalized[PrinterType.FABRIC_TAG]).toBeUndefined();
  });

  it('keeps the backend paper-width alias synchronized with the local label width', () => {
    const sanitized = sanitizePrinterConfigForPersistence(PrinterType.FABRIC_TAG, {
      enabled: true,
      protocol: 'TSPL',
      windowsPrinter: 'TSC MB241',
      paperWidth: 20,
      labelWidth: 25,
      labelHeight: 60,
    });

    expect(sanitized.labelWidth).toBe(25);
    expect(sanitized.paperWidth).toBe(25);
  });

  it('uses fabric-specific persistence defaults instead of generic 50x30 defaults', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile('src/main/config/store.ts', 'utf8');
    const schema = /const fabricTagPrinterConfigSchema = \{[\s\S]*?\n\};/.exec(source)?.[0] || '';

    expect(schema).toContain("default: 'TSPL'");
    expect(schema).toContain("labelWidth: { type: 'number', default: 20 }");
    expect(schema).toContain("labelHeight: { type: 'number', default: 60 }");
    expect(source).toContain('FABRIC_TAG: fabricTagPrinterConfigSchema');
  });

  it('clamps autosaved TSPL values to formatter invariants', () => {
    const sanitized = sanitizePrinterConfigForPersistence(PrinterType.FABRIC_TAG, {
      enabled: true,
      protocol: 'TSPL',
      windowsPrinter: 'TSC MB241',
      labelWidth: 20,
      labelHeight: 2000,
      labelGapMm: 26,
      printSpeed: 0,
      printDensity: 99,
      labelOriginInsetMm: 10,
    });

    expect(maxLabelOriginInsetMm(20)).toBe(9.9);
    expect(sanitized).toMatchObject({
      labelWidth: 20,
      labelHeight: 1000,
      labelGapMm: 25,
      printSpeed: 1,
      printDensity: 15,
      labelOriginInsetMm: 9.9,
    });
  });

  it('recommends TSPL for a TSC, the only protocol that can reach a fabric tag slot', async () => {
    // FABRIC_TAG accepts TSPL and nothing else, so a detected TSC that comes
    // back as WINDOWS can never be routed to it -- which is how a garment-tag
    // printer stayed invisible in settings while sitting on USB001. WINDOWS
    // also sent it down the ZebraDriver path, and TSPL-EZD emulates enough ZPL
    // that the mistake printed instead of failing.
    const { classifyPrinterCategory } = await import('../src/main/hardware/driver-installer');
    const tsc = classifyPrinterCategory({
      brand: 'TSC',
      model: 'TSC MB241',
      windowsPrinterName: 'TSC MB241',
      vid: '',
    } as any);

    expect(tsc.protocol).toBe('TSPL');
    expect(ALLOWED_PROTOCOLS_BY_TYPE[PrinterType.FABRIC_TAG]).toContain(tsc.protocol);
  });

  it('carries the measured origin inset from saved config through to the driver', async () => {
    // The inset is per-installation -- it depends on where the media sits
    // under the head -- so it has to survive being saved and reach the
    // formatter. A value the schema drops, or a driver call that forgets it,
    // both show up as a tag printed off-centre with no error anywhere.
    const fs = await import('node:fs/promises');

    const schema = await fs.readFile('src/main/config/store.ts', 'utf8');
    expect(schema, 'schema would silently drop the inset').toMatch(
      /labelOriginInsetMm: \{ type: 'number' \}/,
    );

    const hardware = await fs.readFile('src/main/modules/hardware.module.ts', 'utf8');
    expect(hardware, 'driver never receives the inset').toMatch(
      /originInsetMm:\s*config\.labelOriginInsetMm/,
    );
  });

  it('stores a FABRIC_TAG slot under schema validation like every other slot', async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile('src/main/config/store.ts', 'utf8');
    const block = /const printersConfigSchema = \{[\s\S]*?\n\};/.exec(source);
    expect(block).not.toBeNull();
    for (const type of Object.values(PrinterType)) {
      const schemaName = type === PrinterType.FABRIC_TAG
        ? 'fabricTagPrinterConfigSchema'
        : 'printerConfigSchema';
      expect(block![0], `printersConfigSchema is missing ${type}`).toContain(`${type}: ${schemaName}`);
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
