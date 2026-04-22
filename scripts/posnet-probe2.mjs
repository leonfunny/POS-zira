#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);
const PORT = process.argv[2] || 'COM3';
const BAUD = 9600;

const STX = 0x02, ETX = 0x03;
function crc16(b) { let c = 0; for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c.toString(16).toUpperCase().padStart(4, '0'); }
function build(cmd, ...p) { let body = cmd + '\t'; for (const x of p) body += x + '\t'; const bb = Buffer.from(body, 'ascii'); const crc = crc16(bb); const f = Buffer.alloc(1 + bb.length + 5 + 1); let o = 0; f[o++] = STX; bb.copy(f, o); o += bb.length; f[o++] = 0x23; Buffer.from(crc, 'ascii').copy(f, o); o += 4; f[o++] = ETX; return f; }
function hex(b) { return Array.from(b).map((x) => `0x${x.toString(16).padStart(2, '0')}`).join(','); }

async function send(cmds) {
  const frames = cmds.map(([c, ...p]) => hex(build(c, ...p)));
  let ps = '$ProgressPreference="SilentlyContinue"\n' +
    `$p=New-Object System.IO.Ports.SerialPort('${PORT}',${BAUD},'None',8,'One')\n` +
    '$p.WriteTimeout=5000;$p.ReadTimeout=5000;$p.DtrEnable=$true;$p.RtsEnable=$true\n' +
    '$r=@();try{$p.Open()\n';
  for (const h of frames) {
    ps += `$f=[byte[]]@(${h});$p.Write($f,0,$f.Length);Start-Sleep -Milliseconds 1000\n` +
      '$n=$p.BytesToRead;if($n -gt 0){$b=New-Object byte[] $n;$p.Read($b,0,$n)|Out-Null;$r+=[System.Text.Encoding]::ASCII.GetString($b)}else{$r+="NOREPLY"}\n';
  }
  ps += '$r -join "|||"\n}catch{Write-Error $_.Exception.Message}finally{if($p.IsOpen){$p.Close()}}\n';
  const f = join(tmpdir(), `pp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.ps1`);
  writeFileSync(f, '﻿' + ps, 'utf8');
  try {
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8', timeout: 30000 });
    return stdout.trim().split('|||');
  } finally {
    try { unlinkSync(f); } catch {}
  }
}

// Non-fiscal printout command variants for POSNET Thermal family
const tests = [
  ['prn',                   [['prn']]],
  ['prnadd',                [['prnadd']]],
  ['prnstart',              [['prnstart']]],
  ['nfpbeg',                [['nfpbeg']]],
  ['prntxt',                [['prntxt', 'tx HELLO FROM ZIRA']]],
  ['prnprint',              [['prnprint']]],
  ['prnform',               [['prnform']]],
  ['prnnon',                [['prnnon']]],
  ['prncpy',                [['prncpy']]],
  ['prnopen',               [['prnopen']]],
  ['invbeg (invoice begin)',[['invbeg']]],
  ['dmpfi',                 [['dmpfi']]],
  ['rptcsh (cash report)',  [['rptcsh']]],
  ['dayrep',                [['dayrep']]],
  ['prntemp',               [['prntemp']]],
  ['trinit bm2 (alt mode)', [['trinit', 'bm2']]],
  ['trinit bm1',            [['trinit', 'bm1']]],
];

console.log(`\nProbing more variants on ${PORT}…\n`);
for (const [label, cmds] of tests) {
  try {
    const r = await send(cmds);
    const out = r[0]?.replace(/[\x00-\x1f]/g, '·').trim();
    console.log(label.padEnd(32) + ' ' + out);
  } catch (e) {
    console.log(label.padEnd(32) + ' ERR: ' + e.message.slice(0, 60));
  }
  await new Promise((r) => setTimeout(r, 400));
}
