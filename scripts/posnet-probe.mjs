#!/usr/bin/env node
/**
 * Probe Posnet printer capabilities in read-only fiscal mode.
 * Tries a battery of commands to learn what the printer will and won't accept.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);
const PORT = process.argv[2] || 'COM3';
const BAUD = Number(process.argv[3]) || 9600;

const STX = 0x02, ETX = 0x03;
function crc16(b) { let c = 0; for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c.toString(16).toUpperCase().padStart(4, '0'); }
function build(cmd, ...p) { let body = cmd + '\t'; for (const x of p) body += x + '\t'; const bb = Buffer.from(body, 'ascii'); const crc = crc16(bb); const f = Buffer.alloc(1 + bb.length + 5 + 1); let o = 0; f[o++] = STX; bb.copy(f, o); o += bb.length; f[o++] = 0x23; Buffer.from(crc, 'ascii').copy(f, o); o += 4; f[o++] = ETX; return f; }
function hex(b) { return Array.from(b).map((x) => `0x${x.toString(16).padStart(2, '0')}`).join(','); }

async function send(commands, label) {
  const frames = commands.map(([c, ...p]) => ({ cmd: c, hex: hex(build(c, ...p)) }));
  let ps = '$ProgressPreference="SilentlyContinue"\n' +
    `$p=New-Object System.IO.Ports.SerialPort('${PORT}',${BAUD},'None',8,'One')\n` +
    '$p.WriteTimeout=5000;$p.ReadTimeout=5000;$p.DtrEnable=$true;$p.RtsEnable=$true\n' +
    '$r=@();try{$p.Open()\n';
  for (let i = 0; i < frames.length; i++) {
    ps += `$f=[byte[]]@(${frames[i].hex});$p.Write($f,0,$f.Length);Start-Sleep -Milliseconds 800\n` +
      '$n=$p.BytesToRead;if($n -gt 0){$b=New-Object byte[] $n;$p.Read($b,0,$n)|Out-Null;$r+=[System.Text.Encoding]::ASCII.GetString($b)}else{$r+="NOREPLY"}\n';
  }
  ps += '$r -join "|||"\n}catch{Write-Error $_.Exception.Message}finally{if($p.IsOpen){$p.Close()}}\n';

  const f = join(tmpdir(), `posnet-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  writeFileSync(f, '﻿' + ps, 'utf8');
  try {
    const { stdout, stderr } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8', timeout: 30000 });
    const err = stderr?.match(/<S S="Error">([^<]+)<\/S>/)?.[1];
    if (err && !err.startsWith('$') && !err.includes('Start-Sleep')) return { label, error: err.replace(/&#xD;&#xA;/g, '').trim() };
    return { label, responses: stdout.trim().split('|||') };
  } finally {
    try { unlinkSync(f); } catch {}
  }
}

const tests = [
  { label: 'rtcget (baseline)',        cmds: [['rtcget']] },
  { label: 'modinf (model info)',      cmds: [['modinf']] },
  { label: 'sernr (serial)',           cmds: [['sernr']] },
  { label: 'prninit (start non-fiscal)', cmds: [['prninit']] },
  { label: 'prnbeg',                   cmds: [['prnbeg']] },
  { label: 'prnfhdr (fiscal header)',  cmds: [['prnfhdr']] },
  { label: 'dsptxtline (display)',     cmds: [['dsptxtline', 'id0', 'no1', 'lnHello']] },
  { label: 'opendrwr (cash drawer)',   cmds: [['opendrwr']] },
  { label: 'trinit bm0',               cmds: [['trinit', 'bm0']] },
  { label: 'prnhdr',                   cmds: [['prnhdr']] },
  { label: 'hdsget (head status)',     cmds: [['hdsget']] },
  { label: 'prtflg (printer flags)',   cmds: [['prtflg']] },
];

console.log(`\nProbing POSNET on ${PORT} @ ${BAUD}…\n`);
console.log('CMD                                    RESPONSE');
console.log('─'.repeat(78));

for (const t of tests) {
  const r = await send(t.cmds, t.label);
  const resp = r.error ? `[ERROR] ${r.error}` : (r.responses?.[0] || '').replace(/[\x00-\x1f]/g, '·').trim();
  console.log(t.label.padEnd(38) + ' ' + resp);
  await new Promise((res) => setTimeout(res, 300));
}
console.log();
