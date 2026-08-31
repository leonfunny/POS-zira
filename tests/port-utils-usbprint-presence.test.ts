import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('Windows USB printer presence checks', () => {
  it('uses same-port USBPRINT presence before the legacy broad VID fallback', () => {
    const source = readSource('src/main/hardware/port-utils.ts');
    const samePortIndex = source.indexOf('const samePortPresent = await isUsbPrintPortPresent(portUpper)');
    const vidFallbackIndex = source.indexOf('const presentVids = await getPresentPrinterVids()');

    expect(source).toContain("USBPRINT\\\\*");
    expect(source).toContain('.EndsWith($port)');
    expect(samePortIndex).toBeGreaterThan(0);
    expect(vidFallbackIndex).toBeGreaterThan(samePortIndex);
  });

  it('keeps discovered USB spooler printers when a USBPRINT device exists on the same port', () => {
    const source = readSource('src/main/hardware/driver-installer.ts');
    const samePortIndex = source.indexOf('const samePortPresent = await isUsbPrintPortPresent(portUpper)');
    const vidFallbackIndex = source.indexOf('backendPresent = bp.vids.some');

    // Matched on the symbol rather than the whole import line: this test is
    // about the order of the two presence checks, and pinning the import list
    // made it fail the next time the module imported one more helper.
    expect(source).toMatch(/import \{[^}]*\bisUsbPrintPortPresent\b[^}]*\} from '\.\/port-utils'/);
    expect(samePortIndex).toBeGreaterThan(0);
    expect(vidFallbackIndex).toBeGreaterThan(samePortIndex);
  });
});
