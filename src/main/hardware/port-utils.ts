/**
 * Shared utilities for serial port and Windows printer detection.
 * Single source of truth — used by all drivers and IPC handlers.
 *
 * SECURITY: Uses execFile() (not exec()) to avoid shell metacharacter injection.
 * All PowerShell calls pass arguments as arrays, never interpolated strings.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import logger from '../logger';

const execFileAsync = promisify(execFile);

/** Regex that matches valid COM port names (COM1–COM256) */
const COM_PORT_RE = /^COM\d{1,3}$/;

/** Regex that matches valid Windows printer names (alphanumeric, spaces, dashes, parens) */
const SAFE_PRINTER_NAME_RE = /^[\w\s\-().#]+$/;

/**
 * Sanitize a COM port name to prevent command injection.
 * Only allows COMn format (e.g. COM3, COM12).
 */
export function sanitizePortName(port: string): string | null {
  const trimmed = port.trim().toUpperCase();
  return COM_PORT_RE.test(trimmed) ? trimmed : null;
}

/**
 * Sanitize a Windows printer name to prevent command injection.
 * Allows typical printer name characters only.
 */
export function sanitizePrinterName(name: string): string | null {
  const trimmed = name.trim();
  return SAFE_PRINTER_NAME_RE.test(trimmed) ? trimmed : null;
}

/**
 * Run a PowerShell command safely via execFile (no shell).
 * Returns stdout as a string.
 */
async function runPowerShell(command: string, timeoutMs = 10000): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', timeout: timeoutMs },
  );
  return stdout;
}

/**
 * List available serial COM ports via PowerShell.
 * Falls back to the `mode` command if PowerShell fails.
 */
export async function listSerialPorts(): Promise<string[]> {
  try {
    const stdout = await runPowerShell('[System.IO.Ports.SerialPort]::getportnames()');
    const ports = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => COM_PORT_RE.test(l));
    logger.info(`[PortUtils] Found ${ports.length} COM ports: ${ports.join(', ') || 'none'}`);
    return ports;
  } catch (error) {
    logger.warn('[PortUtils] PowerShell port list failed, trying mode fallback:', error);
    try {
      const { stdout } = await execFileAsync(
        'mode.com',
        [],
        { encoding: 'utf8', timeout: 10000 },
      );
      const matches = stdout.match(/COM\d+/g) || [];
      const unique = [...new Set(matches)].filter((p) => COM_PORT_RE.test(p));
      logger.info(`[PortUtils] mode fallback found ${unique.length} ports: ${unique.join(', ') || 'none'}`);
      return unique;
    } catch {
      return [];
    }
  }
}

/** Printer info returned by detailed listing */
export interface WindowsPrinterInfo {
  name: string;
  portName: string;
}

/**
 * List available Windows printers with port names via PowerShell.
 * Port names help identify ghost printers vs. real connected devices.
 * Falls back to Get-CimInstance if Get-Printer fails.
 */
export async function listWindowsPrintersDetailed(): Promise<WindowsPrinterInfo[]> {
  if (process.platform !== 'win32') {
    logger.warn('[PortUtils] listWindowsPrintersDetailed only supported on Windows');
    return [];
  }

  try {
    const stdout = await runPowerShell(
      'Get-Printer | ForEach-Object { "$($_.Name)|$($_.PortName)" }',
    );
    const printers = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('|'))
      .map((l) => {
        const sep = l.indexOf('|');
        return { name: l.slice(0, sep).trim(), portName: l.slice(sep + 1).trim() };
      })
      .filter((p) => p.name.length > 0);
    logger.info(`[PortUtils] Found ${printers.length} printers (detailed)`);
    return printers;
  } catch (error) {
    logger.warn('[PortUtils] Get-Printer detailed failed, trying CimInstance fallback:', error);
    try {
      const stdout = await runPowerShell(
        'Get-CimInstance -ClassName Win32_Printer | ForEach-Object { "$($_.Name)|$($_.PortName)" }',
      );
      const printers = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('|'))
        .map((l) => {
          const sep = l.indexOf('|');
          return { name: l.slice(0, sep).trim(), portName: l.slice(sep + 1).trim() };
        })
        .filter((p) => p.name.length > 0);
      logger.info(`[PortUtils] CimInstance fallback found ${printers.length} printers (detailed)`);
      return printers;
    } catch {
      return [];
    }
  }
}

/**
 * List available Windows printers via PowerShell (names only).
 * Falls back to Get-CimInstance if Get-Printer fails.
 */
export async function listWindowsPrinters(): Promise<string[]> {
  const detailed = await listWindowsPrintersDetailed();
  return detailed.map((p) => p.name);
}

/**
 * Check if a specific Windows printer exists (case-insensitive).
 */
export async function windowsPrinterExists(printerName: string): Promise<boolean> {
  const printers = await listWindowsPrinters();
  return printers.some((p) => p.toLowerCase() === printerName.toLowerCase());
}

/**
 * Check if a specific COM port exists.
 */
export async function serialPortExists(port: string): Promise<boolean> {
  const ports = await listSerialPorts();
  return ports.includes(port.toUpperCase());
}
