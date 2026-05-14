import { describe, expect, it, vi } from 'vitest';
import { database } from '../src/main/database/database';
import { localPrinterRepo, rowToPrinterConfig, type LocalPrinterRow } from '../src/main/database/repos/local-printer-repo';
import { PrinterType } from '../src/shared/types';

vi.mock('../src/main/database/database', () => ({
  database: {
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
    transaction: (fn: () => void) => fn(),
    save: vi.fn(),
  },
}));

describe('local printer mirror paper dimensions', () => {
  it('lists all mirrored printer rows for the Settings online-printer table', () => {
    const rows = [
      {
        id: 'printer-online',
        agent_id: 'agent-1',
        printer_type: PrinterType.RECEIPT,
        display_name: 'Receipt printer',
        name: 'Receipt printer',
        protocol: 'THERMAL',
        windows_printer_name: 'Xprinter',
        address: null,
        port: null,
        baud_rate: 9600,
        paper_width: 80,
        paper_height: null,
        chars_per_line: 48,
        supports_cut: 1,
        supports_cash_drawer: 0,
        is_enabled: 1,
        is_online: 1,
        last_seen_at: null,
        last_used_at: null,
        updated_at: null,
      },
    ] as LocalPrinterRow[];

    (database.all as any).mockReturnValue(rows);

    expect(localPrinterRepo.getAll()).toBe(rows);
    expect(database.all).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM local_printers'));
    expect(database.all).toHaveBeenCalledWith(expect.stringContaining('ORDER BY is_online DESC, is_enabled DESC'));
  });

  it('maps LABEL paper_width/paper_height to Zebra label dimensions', () => {
    const row: LocalPrinterRow = {
      id: 'xprinter-1',
      agent_id: 'agent-1',
      printer_type: PrinterType.LABEL,
      display_name: 'Xprinter 100x150',
      name: 'Xprinter 100x150',
      protocol: 'WINDOWS',
      windows_printer_name: 'Xprinter XP-423B',
      address: null,
      port: null,
      baud_rate: 9600,
      paper_width: 100,
      paper_height: 150,
      chars_per_line: 48,
      supports_cut: 1,
      supports_cash_drawer: 0,
      is_enabled: 1,
      is_online: 0,
      last_seen_at: null,
      last_used_at: null,
      updated_at: null,
    };

    expect(rowToPrinterConfig(row)).toMatchObject({
      serverPrinterId: 'xprinter-1',
      windowsPrinter: 'Xprinter XP-423B',
      paperWidth: 100,
      labelWidth: 100,
      labelHeight: 150,
    });
  });
});
