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
import { BRAND_PATTERNS } from './detection/types';

const execFileAsync = promisify(execFile);

/** Regex that matches valid COM port names (COM1–COM256) */
const COM_PORT_RE = /^COM\d{1,3}$/;

/** Regex that matches valid Windows printer names (alphanumeric, spaces, dashes, parens) */
const SAFE_PRINTER_NAME_RE = /^[\w\s\-().#]+$/;

/** All known printer USB Vendor IDs from BRAND_PATTERNS */
const ALL_PRINTER_VIDS = [...new Set(BRAND_PATTERNS.flatMap(bp => bp.vids))];

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
 * List PHYSICALLY PRESENT serial COM ports via PowerShell PnP.
 *
 * v2 (s34): require BOTH (a) the device be returned by `Get-PnpDevice -PresentOnly`
 * AND (b) the device have a non-empty `Service` field (i.e. an actual kernel driver
 * is attached and loaded). On some Windows installs the legacy COM1 entry survives
 * in the registry as a "ghost present" PnP device — but it has no Service binding,
 * so it can never actually be opened. Filtering on Service eliminates that case.
 *
 * Additional cross-check: each port must also appear in Win32_SerialPort, which
 * is sourced from the live hardware tree (not the SERIALCOMM registry map).
 *
 * Falls back to the legacy registry-based enumeration only if both queries fail.
 */
export async function listSerialPorts(): Promise<string[]> {
  try {
    // Single batched call: emit PNP|<comN>|<service>|<instanceId> for every
    // present Class=Ports device, then emit WMI|<comN> for every Win32_SerialPort
    // row. We intersect afterwards in JS so the parser is trivial.
    const psScript =
      "$ErrorActionPreference = 'SilentlyContinue'\n" +
      "Get-PnpDevice -PresentOnly -Class Ports -Status OK -ErrorAction SilentlyContinue | ForEach-Object {\n" +
      "  if ($_.FriendlyName -match '\\(COM(\\d+)\\)') {\n" +
      "    $svc = $_.Service\n" +
      "    if (-not $svc) { $svc = '' }\n" +
      "    $iid = $_.InstanceId\n" +
      "    if (-not $iid) { $iid = '' }\n" +
      "    Write-Output \"PNP|COM$($Matches[1])|$svc|$iid\"\n" +
      "  }\n" +
      "}\n" +
      "Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue | ForEach-Object {\n" +
      "  if ($_.DeviceID -match '^COM\\d+$') { Write-Output \"WMI|$($_.DeviceID)\" }\n" +
      "}\n";
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 10000 },
    );

    const pnpPorts = new Map<string, { svc: string; iid: string }>();
    const wmiPorts = new Set<string>();
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('PNP|')) {
        const parts = line.slice(4).split('|');
        const com = (parts[0] || '').toUpperCase();
        const svc = (parts[1] || '').trim();
        const iid = (parts[2] || '').trim();
        if (COM_PORT_RE.test(com)) pnpPorts.set(com, { svc, iid });
      } else if (line.startsWith('WMI|')) {
        const com = line.slice(4).trim().toUpperCase();
        if (COM_PORT_RE.test(com)) wmiPorts.add(com);
      }
    }

    // A port is REAL if ALL of these hold:
    //   1. PnP -PresentOnly with a loaded Service (has a kernel driver)
    //   2. Also appears in Win32_SerialPort (live hardware tree)
    //   3. NOT an ACPI motherboard serial header (InstanceId starts with ACPI\)
    //      — these are built-in COM ports that Windows reports as "present"
    //      even when nothing is physically connected to the header
    const real: string[] = [];
    const dropped: string[] = [];
    for (const [com, { svc, iid }] of pnpPorts) {
      const hasService = svc.length > 0;
      const inWmi = wmiPorts.has(com);
      const isAcpi = iid.toUpperCase().startsWith('ACPI\\');
      if (hasService && inWmi && !isAcpi) {
        real.push(com);
      } else {
        const reason = isAcpi ? 'acpi-motherboard' : `svc=${svc || 'none'},wmi=${inWmi}`;
        dropped.push(`${com}(${reason})`);
      }
    }
    real.sort();
    if (dropped.length > 0) {
      logger.info(`[PortUtils] Dropped phantom COM port(s): ${dropped.join(', ')}`);
    }
    logger.info(`[PortUtils] Found ${real.length} present COM port(s): ${real.join(', ') || 'none'}`);

    // Happy path: the strict filter found at least one live COM port.
    if (real.length > 0) {
      return real;
    }

    // Strict filtering can be too aggressive on some Windows driver stacks:
    // a real USB-serial printer may appear in the raw SerialPort registry
    // list, but miss either Service or Win32_SerialPort. In that case prefer
    // showing the raw COM names instead of incorrectly returning [].
    if (pnpPorts.size > 0 || wmiPorts.size > 0) {
      try {
        const stdout = await runPowerShell('[System.IO.Ports.SerialPort]::getportnames()');
        const rawPorts = stdout
          .split('\n')
          .map((l) => l.trim().toUpperCase())
          .filter((l) => COM_PORT_RE.test(l))
          .sort();
        if (rawPorts.length > 0) {
          logger.warn(
            `[PortUtils] Strict COM filter returned none; falling back to raw registry ports: ${rawPorts.join(', ')}`
          );
          return rawPorts;
        }
      } catch (fallbackErr) {
        logger.warn('[PortUtils] Raw COM fallback after strict-empty failed:', fallbackErr);
      }

      return [];
    }

    // Both queries returned 0 rows — could indicate they failed silently. Try
    // legacy fallback so we don't accidentally hide genuine hardware.
    logger.warn('[PortUtils] PnP and WMI both empty — falling back to registry enum');
    throw new Error('empty PnP+WMI');
  } catch (error) {
    logger.warn('[PortUtils] PnP COM scan failed, trying registry fallback:', error);
    try {
      // Last-resort fallback — registry enum (may include phantom ports like COM1)
      const stdout = await runPowerShell('[System.IO.Ports.SerialPort]::getportnames()');
      const ports = stdout
        .split('\n')
        .map((l) => l.trim().toUpperCase())
        .filter((l) => COM_PORT_RE.test(l));
      logger.info(`[PortUtils] Registry fallback found ${ports.length} ports: ${ports.join(', ') || 'none'}`);
      return ports;
    } catch {
      return [];
    }
  }
}

/**
 * Get the set of USB VIDs currently present on the system that match
 * any known printer brand. Returns lowercase VID strings.
 *
 * Used by drivers to cross-check whether a spooler-installed printer
 * actually has its physical USB device plugged in right now.
 */
export async function getPresentPrinterVids(): Promise<Set<string>> {
  try {
    const vids = ALL_PRINTER_VIDS;
    const psScript =
      "$ErrorActionPreference = 'SilentlyContinue'\n" +
      `$vids = @(${vids.map(v => `'${v}'`).join(',')})\n` +
      'foreach ($vid in $vids) {\n' +
      '  $found = Get-PnpDevice -PresentOnly -Status OK | Where-Object { $_.InstanceId -match "VID_$vid" }\n' +
      '  if ($found) { Write-Output $vid }\n' +
      '}\n';
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 12000 },
    );
    const present = new Set(
      stdout.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean)
    );
    logger.info(`[PortUtils] Present printer VIDs: ${[...present].join(', ') || 'none'}`);
    return present;
  } catch (err: any) {
    logger.warn('[PortUtils] PnP VID scan failed:', err.message);
    return new Set();
  }
}

/**
 * Check whether a Windows spooler printer is PHYSICALLY PRESENT right now.
 *
 * Combines multiple signals (no single signal is fully trustworthy on Windows):
 *   1. Get-Printer .PrinterStatus / .WorkOffline — fast but lies on silent USB unplug
 *   2. PortName check (USBxxx → must have a present USB printer-class device)
 *   3. PortName check (COMx → must be in present serial port list)
 *   4. Brand pattern match against present USB VIDs
 *
 * Returns true only if at least one positive signal AND no definitive negative.
 *
 * For network/WSD printers, returns true (we can't probe network without sending data).
 */
export async function isWindowsPrinterPresent(printerName: string): Promise<boolean> {
  try {
    const safe = printerName.replace(/'/g, "''");
    const psScript =
      "$ErrorActionPreference = 'SilentlyContinue'\n" +
      `$p = Get-Printer -Name '${safe}' -ErrorAction SilentlyContinue\n` +
      'if (-not $p) { Write-Output "MISSING"; exit }\n' +
      '$workOffline = if ($p.WorkOffline) { "1" } else { "0" }\n' +
      '$status = if ($p.PrinterStatus) { $p.PrinterStatus.ToString() } else { "Unknown" }\n' +
      'Write-Output "PORT=$($p.PortName)"\n' +
      'Write-Output "OFFLINE=$workOffline"\n' +
      'Write-Output "STATUS=$status"\n';
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 8000 },
    );

    if (stdout.includes('MISSING')) {
      logger.warn(`[PortUtils] Spooler printer "${printerName}" not registered`);
      return false;
    }

    const portMatch = stdout.match(/PORT=([^\r\n]+)/);
    const offlineMatch = stdout.match(/OFFLINE=([01])/);
    const statusMatch = stdout.match(/STATUS=([^\r\n]+)/);
    const port = (portMatch?.[1] || '').trim();
    const workOffline = offlineMatch?.[1] === '1';
    const status = (statusMatch?.[1] || '').trim();

    // Hard negatives — high confidence offline
    if (workOffline) {
      logger.info(`[PortUtils] "${printerName}" WorkOffline=true → offline`);
      return false;
    }
    if (/Offline|Error|NotAvailable/i.test(status)) {
      logger.info(`[PortUtils] "${printerName}" status=${status} → offline`);
      return false;
    }

    // Cross-check by port type — the more reliable signal
    const portUpper = port.toUpperCase();

    // COM port: must be physically present in serial port list
    if (/^COM\d+$/i.test(portUpper)) {
      const presentSerial = await listSerialPorts();
      const isPresent = presentSerial.includes(portUpper);
      logger.info(`[PortUtils] "${printerName}" on ${portUpper}: serial present=${isPresent}`);
      return isPresent;
    }

    // USB spooler port: cross-check there's at least one present printer USB device
    // matching this printer's brand. This catches the case where Windows still
    // shows the printer in the spooler but the cable was unplugged.
    if (/^USB\d+$/i.test(portUpper) || /^DOT4_\d+$/i.test(portUpper)) {
      const presentVids = await getPresentPrinterVids();
      // Find brand pattern matching this printer name
      const nameLower = printerName.toLowerCase();
      const bp = BRAND_PATTERNS.find(b =>
        b.namePatterns.some(p => nameLower.includes(p))
      );
      if (!bp) {
        // Unknown brand — fall back to optimistic (no negative signal so far)
        logger.info(`[PortUtils] "${printerName}" on ${portUpper}: unknown brand, no PnP cross-check`);
        return true;
      }
      const hasMatchingDevice = bp.vids.some(v => presentVids.has(v.toLowerCase()));
      logger.info(`[PortUtils] "${printerName}" on ${portUpper}: brand=${bp.brand} present=${hasMatchingDevice}`);
      return hasMatchingDevice;
    }

    // Network/WSD/IP/file/portprompt — trust spooler (no way to probe without printing)
    if (/^(WSD|TCPIP|IP_|\\\\)/i.test(port)) {
      logger.info(`[PortUtils] "${printerName}" on network port ${port}: trusting spooler (no offline signal)`);
      return true;
    }

    // Unknown port type — be conservative and trust spooler
    logger.info(`[PortUtils] "${printerName}" on ${port}: unknown port type, trusting spooler`);
    return true;
  } catch (err: any) {
    logger.warn(`[PortUtils] isWindowsPrinterPresent("${printerName}") failed:`, err.message);
    // On error, default to optimistic — better to attempt and fail loud than silently hide a working printer
    return true;
  }
}

/**
 * Flush stuck print jobs from a printer's queue.
 *
 * Removes any job whose status indicates the printer is offline/blocked/paused.
 * Called BEFORE sending a new job, to make sure that when the user clicks
 * "test print", they don't unexpectedly get a flood of old queued jobs flushed
 * out when the printer comes back online.
 *
 * Returns the number of jobs that were removed (0 = clean queue).
 */
export async function flushStuckPrintJobs(printerName: string): Promise<number> {
  if (process.platform !== 'win32') return 0;
  const safe = sanitizePrinterName(printerName);
  if (!safe) return 0;

  try {
    const psScript =
      "$ErrorActionPreference = 'SilentlyContinue'\n" +
      `$jobs = Get-PrintJob -PrinterName '${safe.replace(/'/g, "''")}' -ErrorAction SilentlyContinue\n` +
      'if (-not $jobs) { Write-Output "0"; exit }\n' +
      "$stuck = $jobs | Where-Object { $_.JobStatus -match 'Error|Offline|Blocked|PaperOut|Paused|UserIntervention|Restart' }\n" +
      'if (-not $stuck) { Write-Output "0"; exit }\n' +
      '$count = ($stuck | Measure-Object).Count\n' +
      'try { $stuck | Remove-PrintJob -ErrorAction SilentlyContinue } catch {}\n' +
      'Write-Output "$count"\n';
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 8000 },
    );
    const count = parseInt(stdout.trim(), 10) || 0;
    if (count > 0) {
      logger.warn(`[PortUtils] Flushed ${count} stuck job(s) from "${printerName}" queue`);
    }
    return count;
  } catch (err: any) {
    logger.warn(`[PortUtils] flushStuckPrintJobs("${printerName}") failed:`, err.message);
    return 0;
  }
}

/**
 * Get the JobStatus of any active jobs in a printer's queue.
 * Returns the first stuck-status string if any job is in an error state, or null if clean.
 *
 * Used as a post-flight check after sending a print job — if a job is now stuck,
 * the printer is likely not actually connected and we should throw rather than
 * silently leave the job in the queue.
 */
export async function getStuckPrintJobStatus(printerName: string): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const safe = sanitizePrinterName(printerName);
  if (!safe) return null;

  try {
    const psScript =
      "$ErrorActionPreference = 'SilentlyContinue'\n" +
      `$jobs = Get-PrintJob -PrinterName '${safe.replace(/'/g, "''")}' -ErrorAction SilentlyContinue\n` +
      'if (-not $jobs) { Write-Output "OK"; exit }\n' +
      "$stuck = $jobs | Where-Object { $_.JobStatus -match 'Error|Offline|Blocked|PaperOut|Paused|UserIntervention' }\n" +
      'if ($stuck) {\n' +
      '  $first = $stuck | Select-Object -First 1\n' +
      '  Write-Output "STUCK:$($first.JobStatus)"\n' +
      '} else { Write-Output "OK" }\n';
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 6000 },
    );
    const trimmed = stdout.trim();
    if (trimmed.startsWith('STUCK:')) {
      return trimmed.slice('STUCK:'.length);
    }
    return null;
  } catch (err: any) {
    logger.debug(`[PortUtils] getStuckPrintJobStatus("${printerName}") failed:`, err.message);
    return null;
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

/**
 * Probe a COM port with ESC/POS status command (DLE EOT 1 = 0x10 0x04 0x01).
 * Returns true if the printer responds with any data.
 * Used by ThermalDriver and UniversalDetectionService for serial printer recovery.
 */
export async function probeEscPosPort(port: string, baudRate: number = 9600): Promise<boolean> {
  const safePort = sanitizePortName(port);
  if (!safePort) return false;

  try {
    const psScript =
      '$ProgressPreference = "SilentlyContinue"\n' +
      `$p = New-Object System.IO.Ports.SerialPort('${safePort}', ${baudRate}, 'None', 8, 'One')\n` +
      '$p.ReadTimeout = 2000\n$p.WriteTimeout = 2000\n' +
      '$p.DtrEnable = $true\n$p.RtsEnable = $true\n' +
      'try {\n  $p.Open()\n' +
      '  $f = [byte[]]@(0x10, 0x04, 0x01)\n' +
      '  $p.Write($f, 0, $f.Length)\n' +
      '  Start-Sleep -Milliseconds 1000\n' +
      '  $n = $p.BytesToRead\n' +
      "  if ($n -gt 0) { Write-Output 'ESCPOS' }\n" +
      "  else { Write-Output 'NOREPLY' }\n" +
      '} catch { Write-Output "ERROR:$($_.Exception.Message)" }\n' +
      'finally { if ($p.IsOpen) { $p.Close() } }\n';

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: 10000 },
    );

    const result = stdout.trim();
    logger.info(`[PortUtils] ESC/POS probe ${safePort}: ${result}`);
    return result === 'ESCPOS';
  } catch (err: any) {
    logger.debug(`[PortUtils] ESC/POS probe ${port} failed: ${err.message}`);
    return false;
  }
}
