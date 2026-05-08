import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(
  join(__dirname, '../src/renderer/components/Settings.tsx'),
  'utf8',
);

describe('Settings printer dropdown state', () => {
  it('hydrates Windows printer options from cached detection and saved config', () => {
    expect(settingsSource).toContain('function readCachedPrinterDetectionStatus()');
    expect(settingsSource).toContain('readCachedPrinterDetectionStatus()?.windowsPrinters');
    expect(settingsSource).toContain('function getConfiguredWindowsPrinterOptions');
    expect(settingsSource).toContain('() => getInitialWindowsPrinterOptions(config)');
    expect(settingsSource).toContain('setWindowsPrinters(prev => mergeWindowsPrinterOptions(prev, getConfiguredWindowsPrinterOptions(config)))');
  });

  it('keeps the selected saved printer in each select while fresh detection is pending', () => {
    expect(settingsSource).toContain('function getWindowsPrinterOptionsForSelect');
    expect(settingsSource).toContain('getWindowsPrinterOptionsForSelect(windowsPrinters, printerConfig.windowsPrinter).map');
    expect(settingsSource).toContain('getWindowsPrinterOptionsForSelect(windowsPrinters, zebraPrinter).map');
  });
});
