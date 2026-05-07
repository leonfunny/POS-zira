import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(
  join(__dirname, '../src/renderer/components/Settings.tsx'),
  'utf8',
);

describe('Settings ELZAB_STX target UI', () => {
  it('has an explicit ELZAB_STX branch before the generic Windows-printer branch', () => {
    const elzabIdx = settingsSource.indexOf(") : printerConfig.protocol === 'ELZAB_STX' ? (");
    const thermalIdx = settingsSource.indexOf("printerConfig.protocol === 'THERMAL'");
    const genericWindowsIdx = settingsSource.indexOf("t('settings.windowsPrinter')");

    expect(elzabIdx).toBeGreaterThan(-1);
    expect(thermalIdx).toBeGreaterThan(elzabIdx);
    expect(genericWindowsIdx).toBeGreaterThan(thermalIdx);
  });

  it('collects COM port and address for ELZAB_STX without saving a Windows printer target', () => {
    const elzabIdx = settingsSource.indexOf(") : printerConfig.protocol === 'ELZAB_STX' ? (");
    const thermalIdx = settingsSource.indexOf("printerConfig.protocol === 'THERMAL'", elzabIdx);
    const elzabBranch = settingsSource.slice(elzabIdx, thermalIdx);

    expect(elzabBranch).toContain("value={printerConfig.port || ''}");
    expect(elzabBranch).toContain("port: e.target.value");
    expect(elzabBranch).toContain("value={printerConfig.address || ''}");
    expect(elzabBranch).toContain('address,');
    expect(elzabBranch).not.toContain("value={printerConfig.windowsPrinter || ''}");
  });

  it('clears stale Windows-printer targets when switching into ELZAB_STX', () => {
    const updateProtocolIdx = settingsSource.indexOf('const updateProtocol =');
    const renderStartIdx = settingsSource.indexOf('return (', updateProtocolIdx);
    const updateProtocolBlock = settingsSource.slice(updateProtocolIdx, renderStartIdx);

    expect(updateProtocolBlock).toContain("protocol === 'ELZAB_STX'");
    expect(updateProtocolBlock).toContain("windowsPrinter: ''");
  });
});
