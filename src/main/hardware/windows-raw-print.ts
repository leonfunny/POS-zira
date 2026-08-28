/**
 * Send raw bytes straight to a Windows printer, bypassing the driver's page
 * renderer.
 *
 * Label languages (TSPL, ZPL, ESC/POS) are byte streams the firmware parses
 * itself. Handing them to the spooler as a *document* makes the vendor driver
 * rasterise them at whatever page size it defaults to, which is why a label
 * that looks right in a preview comes out shifted or blank. Opening the
 * printer with pDataType = "RAW" hands the bytes over untouched.
 *
 * Node has no binding for winspool, so this goes through PowerShell with an
 * inline P/Invoke shim. The script is passed via -EncodedCommand and run with
 * execFile (no shell), so nothing here is interpolated into a command line.
 *
 * NOTE: ZebraDriver carries its own copy of this shim. It is left alone
 * deliberately — it also owns Zebra-specific queue diagnostics, and rewiring
 * the fiscal/label print path is not in scope for adding a new driver.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import logger from '../logger';

const execFileAsync = promisify(execFile);

export interface RawPrintOptions {
  /** Job name shown in the Windows print queue. */
  docName?: string;
  /** Milliseconds before the PowerShell call is abandoned. */
  timeoutMs?: number;
  /** Prefix for the temp spool file, for easier log forensics. */
  tempPrefix?: string;
}

/** Single-quote escaping for a PowerShell literal string. */
function psLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

const RAW_PRINTER_HELPER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class ZiraRawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, Int32 dwCount, out Int32 dwWritten);

    public static string SendBytesToPrinter(string szPrinterName, string szDocName, byte[] bytes) {
        IntPtr hPrinter = IntPtr.Zero;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = szDocName;
        di.pDataType = "RAW";

        if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {
            int err = Marshal.GetLastWin32Error();
            return "OpenPrinter failed for '" + szPrinterName + "' (Win32 error " + err + ")";
        }

        try {
            if (!StartDocPrinter(hPrinter, 1, di)) {
                int err = Marshal.GetLastWin32Error();
                return "StartDocPrinter failed (Win32 error " + err + ")";
            }
            try {
                if (!StartPagePrinter(hPrinter)) {
                    int err = Marshal.GetLastWin32Error();
                    return "StartPagePrinter failed (Win32 error " + err + ")";
                }
                try {
                    int dwWritten = 0;
                    if (!WritePrinter(hPrinter, bytes, bytes.Length, out dwWritten)) {
                        int err = Marshal.GetLastWin32Error();
                        return "WritePrinter failed (Win32 error " + err + ")";
                    }
                    if (dwWritten != bytes.Length) {
                        return "WritePrinter wrote " + dwWritten + " of " + bytes.Length + " bytes";
                    }
                    return "OK";
                } finally {
                    EndPagePrinter(hPrinter);
                }
            } finally {
                EndDocPrinter(hPrinter);
            }
        } finally {
            ClosePrinter(hPrinter);
        }
    }
}
"@
`;

/**
 * Reduce a PowerShell failure to one line worth showing a cashier.
 * Prefers the structured message the shim returns over CLIXML noise.
 */
export function cleanRawPrintError(error: any): string {
  const raw = error?.stderr || error?.message || String(error);
  const structured = raw.match(/(OpenPrinter|StartDocPrinter|StartPagePrinter|WritePrinter) failed[^"'\r\n]*/);
  if (structured) return structured[0];
  const cleaned = raw.replace(/#< CLIXML[\s\S]*$/m, '').replace(/<[^>]+>/g, '').trim();
  const firstLine = cleaned.split(/[\r\n]+/).find((l: string) => l.trim().length > 10) || cleaned;
  return firstLine.slice(0, 200) || 'Print command failed';
}

/**
 * Write `payload` to `printerName` as a RAW spool job.
 * Resolves when the bytes have been accepted by the spooler; throws otherwise.
 */
export async function sendRawToPrinter(
  printerName: string,
  payload: Buffer,
  options: RawPrintOptions = {},
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Raw printing is only supported on Windows');
  }
  if (!payload.length) {
    throw new Error('Refusing to send an empty print job');
  }

  const docName = options.docName || 'Zira Raw Job';
  const tempFile = path.join(
    os.tmpdir(),
    `${options.tempPrefix || 'zira_raw'}_${process.pid}_${Date.now()}.bin`,
  );

  try {
    fs.writeFileSync(tempFile, payload);
    logger.debug(`[RawPrint] ${payload.length} bytes staged at ${tempFile} for "${printerName}"`);

    const psScript = `
$ErrorActionPreference = "Stop"
${RAW_PRINTER_HELPER}
$printerName = '${psLiteral(printerName)}'
$docName = '${psLiteral(docName)}'
$payloadFile = '${psLiteral(tempFile)}'
$bytes = [System.IO.File]::ReadAllBytes($payloadFile)
$result = [ZiraRawPrinter]::SendBytesToPrinter($printerName, $docName, $bytes)
if ($result -ne "OK") { throw $result }
Write-Output "OK"
`;

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: options.timeoutMs ?? 30_000 },
    );

    if (stderr && stderr.trim()) {
      logger.warn(`[RawPrint] PowerShell stderr: ${stderr.trim()}`);
    }
    if (!stdout || !stdout.includes('OK')) {
      throw new Error(`Unexpected output from raw print: ${stdout}`);
    }
    logger.debug(`[RawPrint] Job accepted by "${printerName}"`);
  } catch (error: any) {
    throw new Error(cleanRawPrintError(error));
  } finally {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (cleanupError) {
      logger.warn(`[RawPrint] Failed to clean up ${tempFile}:`, cleanupError);
    }
  }
}
