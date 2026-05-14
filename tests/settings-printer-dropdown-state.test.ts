import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = readFileSync(
  join(__dirname, '../src/renderer/components/Settings.tsx'),
  'utf8',
);
const preloadSource = readFileSync(
  join(__dirname, '../src/preload/preload.ts'),
  'utf8',
);
const electronDtsSource = readFileSync(
  join(__dirname, '../src/shared/electron.d.ts'),
  'utf8',
);
const sharedTypesSource = readFileSync(
  join(__dirname, '../src/shared/types.ts'),
  'utf8',
);
const authModuleSource = readFileSync(
  join(__dirname, '../src/main/modules/auth.module.ts'),
  'utf8',
);
const hardwareModuleSource = readFileSync(
  join(__dirname, '../src/main/modules/hardware.module.ts'),
  'utf8',
);
const socketClientSource = readFileSync(
  join(__dirname, '../src/main/network/socket-client.ts'),
  'utf8',
);
const apiClientSource = readFileSync(
  join(__dirname, '../src/main/network/api-client.ts'),
  'utf8',
);
const localPrinterRepoSource = readFileSync(
  join(__dirname, '../src/main/database/repos/local-printer-repo.ts'),
  'utf8',
);

describe('Settings printer dropdown state', () => {
  it('keeps printer settings behind a dedicated Settings tab', () => {
    expect(settingsSource).toContain("type SettingsTab = 'general' | 'pos' | 'printers'");
    expect(settingsSource).toContain("const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')");
    expect(settingsSource).toContain('role="tablist"');
    expect(settingsSource).toContain("settingsTab === 'pos'");
    expect(settingsSource).toContain("label: t('settings.pos')");
    expect(settingsSource).toContain("settingsTab === 'printers'");
    expect(settingsSource).toContain("label: t('settings.printers')");
  });

  it('keeps non-POS settings outside the POS tab', () => {
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

  it('shows SQLite local printer ids in the printer Settings tab', () => {
    expect(settingsSource).toContain('Advanced diagnostics: SQLite mirror');
    expect(settingsSource).toContain('window.electronAPI.printAgentPrinters.localList()');
    expect(settingsSource).toContain('localPrinterRows.map((printer) =>');
    expect(settingsSource).toContain('{printer.id}');
    expect(settingsSource).toContain("printer.is_online === 1 ? 'Online' : 'Offline'");
    expect(settingsSource).toContain('Debug cache only');
    expect(settingsSource).toContain('Reload backend');
  });

  it('wires the SQLite local printer list through IPC', () => {
    expect(sharedTypesSource).toContain("PRINT_AGENT_PRINTERS_LOCAL_LIST: 'print-agent-printers-local-list'");
    expect(preloadSource).toContain('localList: () => ipcRenderer.invoke(IPC_CHANNELS.PRINT_AGENT_PRINTERS_LOCAL_LIST)');
    expect(electronDtsSource).toContain('localList: () => Promise<import(\'./types\').LocalPrinterMirrorRow[]>');
    expect(authModuleSource).toContain('ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_PRINTERS_LOCAL_LIST');
    expect(authModuleSource).toContain('return localPrinterRepo.getAll()');
    expect(localPrinterRepoSource).toContain('getAll(): LocalPrinterRow[]');
  });

  it('reports per-printer online status to the backend socket', () => {
    expect(sharedTypesSource).toContain('printerStatuses?: Array<{');
    expect(socketClientSource).toContain('printerStatuses?: Array<{');
    expect(hardwareModuleSource).toContain('for (const row of localPrinterRepo.getAll())');
    expect(hardwareModuleSource).toContain('printerStatuses.push({ printerId: row.id, isOnline })');
    expect(hardwareModuleSource).toContain('socket.sendDeviceStatus(status)');
  });

  it('sends machineId with API-key socket auth and Windows printer sync', () => {
    expect(socketClientSource).toContain('async connectWithApiKey(serverUrl: string, apiKey: string, machineId?: string)');
    expect(socketClientSource).toContain('...(machineId && { machineId })');
    expect(socketClientSource).toContain('this.connectRemoteSocket(serverUrl, apiKey, machineId)');
    expect(authModuleSource).toContain("socket.connectWithApiKey(latestConfig.serverUrl || 'https://api.enail.pro', apiKey, latestConfig.machineId)");
    expect(apiClientSource).toContain('syncWindowsPrinters(apiKey: string, printers: Array<{ name: string; isDefault?: boolean }>, machineId?: string)');
    expect(apiClientSource).toContain('...(machineId && { machineId })');
    expect(authModuleSource).toContain('config.machineId');
  });

  it('wires salon-level shared printer assignments through Settings and IPC', () => {
    expect(settingsSource).toContain('Shared receipt route');
    expect(settingsSource).toContain("const SELF_CHECKOUT_RECEIPT_ROLE: SalonPrinterRole = 'SELF_CHECKOUT_RECEIPT'");
    expect(settingsSource).toContain('window.electronAPI.printAgentPrinters.salonList()');
    expect(settingsSource).toContain('window.electronAPI.printAgentPrinters.assignmentsList()');
    expect(settingsSource).toContain('window.electronAPI.printAgentPrinters.upsertAssignment(SELF_CHECKOUT_RECEIPT_ROLE, printerId)');
    expect(settingsSource).toContain('window.electronAPI.printAgentPrinters.deleteAssignment(SELF_CHECKOUT_RECEIPT_ROLE)');
    expect(settingsSource).toContain('Active shared receipt route');
    expect(settingsSource).toContain('This POS agent');
    expect(settingsSource).toContain("printer.agentIsOnline ? 'POS online' : 'POS offline'");
    expect(settingsSource).toContain("printer.isOnline ? 'Device online' : 'Device offline'");
    expect(settingsSource).toContain('Stop sharing');
    expect(settingsSource).toContain('Use as shared receipt');

    expect(sharedTypesSource).toContain("PRINT_AGENT_SALON_PRINTERS_LIST: 'print-agent-salon-printers-list'");
    expect(sharedTypesSource).toContain("PRINT_AGENT_PRINTER_ASSIGNMENTS_UPSERT: 'print-agent-printer-assignments-upsert'");
    expect(preloadSource).toContain('salonList: () => ipcRenderer.invoke(IPC_CHANNELS.PRINT_AGENT_SALON_PRINTERS_LIST)');
    expect(electronDtsSource).toContain('upsertAssignment: (role: import(\'./types\').SalonPrinterRole, printerId: string)');
    expect(authModuleSource).toContain('ipcMain.handle(IPC_CHANNELS.PRINT_AGENT_PRINTER_ASSIGNMENTS_UPSERT');
    expect(apiClientSource).toContain('/print-agent/salons/me/printer-assignments');
    expect(apiClientSource).toContain('/print-agent/salons/me/printers');
  });

  it('labels backend printer rows as this POS local config', () => {
    expect(settingsSource).toContain('Local printer config (this POS)');
    expect(settingsSource).toContain("Agent ID: {currentAgentId || 'not paired'}");
    expect(settingsSource).toContain('If two POS devices show the same agent ID');
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
