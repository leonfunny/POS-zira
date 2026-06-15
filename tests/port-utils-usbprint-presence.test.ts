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
});
