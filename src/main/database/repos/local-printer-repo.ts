import { LocalPrinterMirrorRow, PrinterConfig, PrinterProtocol, PrinterType } from '../../../shared/types';
import { database } from '../database';

export interface LocalPrinterRow extends LocalPrinterMirrorRow {}

export interface LocalPrinterUpsert {
  id: string;
  agentId?: string | null;
  printerType?: PrinterType | string | null;
  displayName?: string | null;
  name?: string | null;
  protocol: PrinterProtocol;
  windowsPrinterName?: string | null;
  address?: string | null;
  port?: string | null;
  baudRate?: number;
  paperWidth?: number;
  paperHeight?: number | null;
  charsPerLine?: number;
  supportsCut?: boolean;
  supportsCashDrawer?: boolean;
  isEnabled?: boolean;
  isOnline?: boolean;
}

function boolToInt(value: boolean | undefined, fallback: number): number {
  return value === undefined ? fallback : value ? 1 : 0;
}

function windowsPrinterTarget(row: LocalPrinterRow): string | undefined {
  if (row.windows_printer_name) return row.windows_printer_name;
  if (row.protocol === 'WINDOWS' || row.protocol === 'ZEBRA') return row.address || undefined;
  return undefined;
}

export function rowToPrinterConfig(row: LocalPrinterRow): PrinterConfig {
  const config: PrinterConfig = {
    enabled: row.is_enabled === 1,
    protocol: row.protocol,
    serverPrinterId: row.id,
    displayName: row.display_name || row.name || row.printer_type || row.id,
    port: row.port || undefined,
    address: row.address || undefined,
    windowsPrinter: windowsPrinterTarget(row),
    baudRate: row.baud_rate || 9600,
    paperWidth: row.paper_width || 80,
    charsPerLine: row.chars_per_line || 48,
    supportsCut: row.supports_cut === 1,
    supportsCashDrawer: row.supports_cash_drawer === 1,
  };

  if (row.printer_type === PrinterType.LABEL) {
    if (row.paper_width > 0) config.labelWidth = row.paper_width;
    if (row.paper_height && row.paper_height > 0) config.labelHeight = row.paper_height;
  }

  return config;
}

export const localPrinterRepo = {
  upsertMany(agentId: string | null, printers: LocalPrinterUpsert[]): void {
    const seenIds = new Set(printers.map((printer) => printer.id));
    const now = new Date().toISOString();

    database.transaction(() => {
      for (const printer of printers) {
        database.run(
           `INSERT INTO local_printers (
              id, agent_id, printer_type, display_name, name, protocol,
              windows_printer_name, address, port, baud_rate, paper_width,
              paper_height, chars_per_line, supports_cut, supports_cash_drawer, is_enabled, is_online,
              last_seen_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              agent_id = excluded.agent_id,
              printer_type = excluded.printer_type,
             display_name = excluded.display_name,
             name = excluded.name,
             protocol = excluded.protocol,
             windows_printer_name = excluded.windows_printer_name,
             address = excluded.address,
              port = excluded.port,
              baud_rate = excluded.baud_rate,
              paper_width = excluded.paper_width,
              paper_height = excluded.paper_height,
              chars_per_line = excluded.chars_per_line,
              supports_cut = excluded.supports_cut,
             supports_cash_drawer = excluded.supports_cash_drawer,
             is_enabled = excluded.is_enabled,
             last_seen_at = excluded.last_seen_at,
             updated_at = excluded.updated_at`,
          [
            printer.id,
            printer.agentId ?? agentId,
            printer.printerType ?? null,
            printer.displayName ?? printer.name ?? null,
            printer.name ?? printer.displayName ?? null,
            printer.protocol,
            printer.windowsPrinterName ?? null,
            printer.address ?? null,
            printer.port ?? null,
            printer.baudRate ?? 9600,
            printer.paperWidth ?? 80,
            printer.paperHeight ?? null,
            printer.charsPerLine ?? 48,
            boolToInt(printer.supportsCut, 1),
            boolToInt(printer.supportsCashDrawer, 0),
            boolToInt(printer.isEnabled, 0),
            boolToInt(printer.isOnline, 0),
            now,
            now,
          ],
        );
      }

      if (agentId && seenIds.size > 0) {
        const placeholders = [...seenIds].map(() => '?').join(', ');
        database.run(
          `UPDATE local_printers
           SET is_enabled = 0, updated_at = ?
           WHERE agent_id = ? AND id NOT IN (${placeholders})`,
          [now, agentId, ...seenIds],
        );
      }
    });
    database.save();
  },

  getById(id: string): LocalPrinterRow | null {
    return database.get<LocalPrinterRow>('SELECT * FROM local_printers WHERE id = ?', [id]);
  },

  getEnabled(): LocalPrinterRow[] {
    return database.all<LocalPrinterRow>(
      'SELECT * FROM local_printers WHERE is_enabled = 1 ORDER BY printer_type, display_name, id',
    );
  },

  getAll(): LocalPrinterRow[] {
    return database.all<LocalPrinterRow>(
      `SELECT * FROM local_printers
       ORDER BY is_online DESC, is_enabled DESC, printer_type, display_name, id`,
    );
  },

  markOnline(id: string, isOnline: boolean): void {
    database.run(
      `UPDATE local_printers SET is_online = ?, updated_at = ? WHERE id = ?`,
      [isOnline ? 1 : 0, new Date().toISOString(), id],
    );
  },

  markUsed(id: string): void {
    const now = new Date().toISOString();
    database.run(
      `UPDATE local_printers SET last_used_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
    database.save();
  },
};
