import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(
  join(__dirname, '../src/renderer/components/Settings.tsx'),
  'utf8',
);

describe('Settings printer dropdown state', () => {
  it('keeps Settings sections behind dedicated tabs and POS scoped to POS controls', () => {
    expect(settingsSource).toContain("type SettingsTab = 'general' | 'pos' | 'printers'");
    expect(settingsSource).toContain("const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')");
    expect(settingsSource).toContain('role="tablist"');
    expect(settingsSource).toContain("id: 'pos' as const");
    expect(settingsSource).toContain("settingsTab === 'pos'");
    expect(settingsSource).toContain("settingsTab === 'printers'");

    const posTabStart = settingsSource.indexOf("{settingsTab === 'pos' &&");
    const nextGeneralTab = settingsSource.indexOf("{settingsTab === 'general' &&", posTabStart + 1);
    const posTabSource = settingsSource.slice(posTabStart, nextGeneralTab);

    expect(posTabStart).toBeGreaterThan(-1);
    expect(nextGeneralTab).toBeGreaterThan(posTabStart);
    expect(posTabSource).toContain("{t('settings.pos')}");
    expect(posTabSource).not.toContain('Pairing Card');
    expect(posTabSource).not.toContain('Telegram Remote Control');
    expect(posTabSource).not.toContain('Zira AI Tools');
    expect(posTabSource).not.toContain('App Updates');
    expect(posTabSource).not.toContain('SSH Tunnel Status');
    expect(posTabSource).not.toContain('Tab Visibility');
  });
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
