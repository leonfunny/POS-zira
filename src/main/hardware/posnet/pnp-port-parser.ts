export interface PosnetVidPort {
  port: string;
  pidHex: string;
  pid: number;
}

function normalizeVid(vid: string): string {
  return vid.replace(/^0x/i, '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
}

function hasPowerShellError(text?: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#< CLIXML')) return true;
  return /Cannot overwrite variable|CategoryInfo|FullyQualifiedErrorId|Exception|ErrorRecord|At line:/i.test(trimmed);
}

function summarizePowerShellError(text?: string): string {
  return (text || '')
    .replace(/#< CLIXML/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export function buildFindPosnetVidPortsScript(vid: string = '1424'): string {
  const safeVid = normalizeVid(vid) || '1424';
  return `
Get-CimInstance Win32_PnPEntity |
  Where-Object { $_.DeviceID -match 'VID_${safeVid}' -and $_.Name -match 'COM\\d+' } |
  ForEach-Object {
    $port = if ($_.Name -match '\\(COM(\\d+)\\)') { "COM$($Matches[1])" } else { '' }
    $usbPid = if ($_.DeviceID -match 'PID_([0-9A-Fa-f]+)') { $Matches[1] } else { '' }
    if ($port -and $usbPid) { Write-Output "$port|$usbPid" }
  }
`.trim();
}

export function parsePosnetVidPortOutput(stdout: string, stderr: string = ''): PosnetVidPort[] {
  if (hasPowerShellError(stderr) || hasPowerShellError(stdout)) {
    const summary = summarizePowerShellError(stderr) || summarizePowerShellError(stdout) || 'unknown PowerShell error';
    throw new Error(`PowerShell error while scanning POSNET VID/PID ports: ${summary}`);
  }

  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [portRaw, pidRaw] = line.split('|');
      const port = (portRaw || '').trim().toUpperCase();
      const pidHex = (pidRaw || '').trim().toUpperCase();
      if (!/^COM\d+$/.test(port) || !/^[0-9A-F]+$/.test(pidHex)) return null;
      const pid = parseInt(pidHex, 16);
      if (Number.isNaN(pid)) return null;
      return { port, pidHex, pid };
    })
    .filter((entry): entry is PosnetVidPort => entry !== null);
}
