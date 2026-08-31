import { describe, expect, it, vi } from 'vitest';

/**
 * The settings printer dropdown is fed by getPosnetDriverStatus(). That
 * function's device scan is one large PowerShell batch, and on a slow desktop
 * it times out -- which used to take the whole printer list down with it, so a
 * printer that was plugged in and printing could not be selected. Nothing
 * surfaced: the failure was logged as a warning and the renderer's caller
 * swallowed it.
 */

vi.mock('electron', () => ({ app: { getPath: () => 'C:\\tmp', isPackaged: false, getAppPath: () => 'C:\\app' } }));

vi.mock('../src/main/logger', () => ({
  default: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

vi.mock('child_process', () => ({
  // Callback-style, because the module promisifies it. Always fails, standing
  // in for the PnP enumeration timing out.
  execFile: (_cmd: string, _args: string[], _opts: any, cb: any) => {
    cb(new Error('Command failed: powershell.exe (timeout)'), '', '');
  },
}));

vi.mock('../src/main/hardware/port-utils', () => ({
  listSerialPorts: async () => ['COM1'],
  isUsbPrintPortPresent: async () => true,
  listWindowsPrintersDetailed: async () => [
    { name: 'TSC MB241', portName: 'USB001', isDefault: false },
    { name: 'Honeywell PC42E-D 203dpi', portName: 'USB002', isDefault: false },
    { name: 'Microsoft Print to PDF', portName: 'PORTPROMPT:', isDefault: false },
  ],
}));

const { getPosnetDriverStatus } = await import('../src/main/hardware/driver-installer');

describe('printer discovery survives a failed device scan', () => {
  it('still lists spooler printers when the PnP batch fails', async () => {
    const status = await getPosnetDriverStatus();
    const names = status.windowsPrinters.map((p) => p.name);

    expect(names, 'an empty list is what made the printer unselectable').not.toHaveLength(0);
    expect(names).toContain('TSC MB241');
  });

  it('keeps the port with the name, so the dropdown can tell two units apart', async () => {
    const status = await getPosnetDriverStatus();
    const tsc = status.windowsPrinters.find((p) => p.name === 'TSC MB241');
    expect(tsc?.port).toBe('USB001');
  });
});
