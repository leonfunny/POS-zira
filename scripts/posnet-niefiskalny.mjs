#!/usr/bin/env node
/**
 * Attempt non-fiscal (niefiskalny) printing on POSNET Thermal XL.
 *
 * Strategies:
 * 1. prncancel first → trinit bm1 (non-fiscal mode)
 * 2. Try 115200 baud (printer config shows COM1 at 115200)
 * 3. Try trinit with different bm values
 * 4. Try THERMAL protocol ESC/POS commands instead of POSNET
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);
const PORT = process.argv[2] || 'COM3';

const STX = 0x02, ETX = 0x03;
function crc16(b) { let c = 0; for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c.toString(16).toUpperCase().padStart(4, '0'); }
function buildPosnet(cmd, ...p) { let body = cmd + '\t'; for (const x of p) body += x + '\t'; const bb = Buffer.from(body, 'ascii'); const crc = crc16(bb); const f = Buffer.alloc(1 + bb.length + 5 + 1); let o = 0; f[o++] = STX; bb.copy(f, o); o += bb.length; f[o++] = 0x23; Buffer.from(crc, 'ascii').copy(f, o); o += 4; f[o++] = ETX; return f; }
function hex(b) { return Array.from(b).map((x) => `0x${x.toString(16).padStart(2, '0')}`).join(','); }

async function sendRaw(port, baud, byteArrays, labels, waitMs = 1000) {
  let ps = '$ProgressPreference="SilentlyContinue"\n' +
    `$p=New-Object System.IO.Ports.SerialPort('${port}',${baud},'None',8,'One')\n` +
    '$p.WriteTimeout=5000;$p.ReadTimeout=5000;$p.DtrEnable=$true;$p.RtsEnable=$true\n' +
    '$r=@();try{$p.Open()\n';
  for (let i = 0; i < byteArrays.length; i++) {
    ps += `$f=[byte[]]@(${byteArrays[i]});$p.Write($f,0,$f.Length);Start-Sleep -Milliseconds ${waitMs}\n`;
    ps += '$n=$p.BytesToRead;if($n -gt 0){$b=New-Object byte[] $n;$p.Read($b,0,$n)|Out-Null\n';
    ps += '$hex=($b|ForEach-Object{$_.ToString("X2")}) -join " "\n';
    ps += '$ascii=[System.Text.Encoding]::ASCII.GetString($b)\n';
    ps += '$r+="HEX:$hex|ASCII:$ascii"}else{$r+="NOREPLY"}\n';
  }
  ps += '$r -join "\\n"\n}catch{Write-Error $_.Exception.Message}finally{if($p.IsOpen){$p.Close()}}\n';

  const f = join(tmpdir(), `pn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.ps1`);
  writeFileSync(f, '﻿' + ps, 'utf8');
  try {
    const { stdout, stderr } = await execFileP('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
      { encoding: 'utf8', timeout: 30000 });
    if (stderr) {
      const err = stderr.match(/<S S="Error">([^<]*Exception[^<]*)<\/S>/);
      if (err) return { error: err[1].replace(/&#xD;&#xA;/g, '').trim() };
    }
    return { lines: stdout.trim().split('\\n') };
  } finally {
    try { unlinkSync(f); } catch {}
  }
}

function posnetHex(cmd, ...p) { return hex(buildPosnet(cmd, ...p)); }

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n═══ POSNET Niefiskalny Probe — ${PORT} ═══\n`);

// ── Test 1: prncancel then trinit bm1 (clear state first) ──────────────
console.log('── Test 1: prncancel → trinit bm1 (non-fiscal) @ 9600 ──');
let r = await sendRaw(PORT, 9600, [
  posnetHex('prncancel'),
  posnetHex('trinit', 'bm1'),
], ['prncancel', 'trinit bm1']);
console.log(r.error || r.lines?.join('\n'));
await delay(500);

// ── Test 2: Try at 115200 baud (printer's own COM1 is 115200) ──────────
console.log('\n── Test 2: rtcget @ 115200 baud ──');
r = await sendRaw(PORT, 115200, [posnetHex('rtcget')], ['rtcget']);
console.log(r.error || r.lines?.join('\n'));
await delay(500);

// ── Test 3: trinit bm1 at 115200 ──────────────────────────────────────
console.log('\n── Test 3: trinit bm1 @ 115200 ──');
r = await sendRaw(PORT, 115200, [
  posnetHex('prncancel'),
  posnetHex('trinit', 'bm1'),
], ['prncancel', 'trinit bm1']);
console.log(r.error || r.lines?.join('\n'));
await delay(500);

// ── Test 4: Raw ESC/POS thermal commands (maybe Thermal XL accepts ESC/POS too) ──
console.log('\n── Test 4: ESC/POS init + text @ 9600 ──');
const ESC = 0x1B, GS = 0x1D, LF = 0x0A;
const escInit = [ESC, 0x40]; // ESC @ = initialize
const escText = [...Buffer.from('ZIRA AI SANDBOX TEST\n', 'ascii')];
const escCut = [GS, 0x56, 0x00]; // GS V 0 = full cut
r = await sendRaw(PORT, 9600, [
  [...escInit, ...escText, LF, LF, LF, ...escCut].map(b => `0x${b.toString(16).padStart(2, '0')}`).join(','),
], ['ESC/POS init+text+cut'], 2000);
console.log(r.error || r.lines?.join('\n'));
await delay(500);

// ── Test 5: ESC/POS at 115200 ─────────────────────────────────────────
console.log('\n── Test 5: ESC/POS init + text @ 115200 ──');
r = await sendRaw(PORT, 115200, [
  [...escInit, ...escText, LF, LF, LF, ...escCut].map(b => `0x${b.toString(16).padStart(2, '0')}`).join(','),
], ['ESC/POS init+text+cut'], 2000);
console.log(r.error || r.lines?.join('\n'));
await delay(500);

// ── Test 6: trinit with bm values 3-7 (undocumented modes?) ───────────
console.log('\n── Test 6: trinit bm3..bm7 @ 9600 (undocumented modes) ──');
for (let bm = 3; bm <= 7; bm++) {
  r = await sendRaw(PORT, 9600, [posnetHex('trinit', `bm${bm}`)], [`trinit bm${bm}`]);
  const resp = r.error || r.lines?.[0]?.replace(/.*ASCII:/,'').replace(/[\x00-\x1f]/g, '·').trim();
  console.log(`  bm${bm}: ${resp}`);
  await delay(400);
}

// ── Test 7: Try POSNET "formfeed" and "beep" commands ──────────────────
console.log('\n── Test 7: Misc commands @ 9600 ──');
const misc = [
  ['beep', [['beep']]],
  ['bell', [['bell']]],
  ['sndbeep', [['sndbeep']]],
  ['cut', [['cut']]],
  ['feed', [['feed']]],
  ['formfeed', [['formfeed']]],
  ['status', [['status']]],
  ['strget', [['strget']]],
  ['getst', [['getst']]],
  ['fiscget', [['fiscget']]],
  ['prnraw tx HELLO', [['prnraw', 'tx HELLO']]],
  ['dsptxtset', [['dsptxtset', 'ln1', 'txHELLO ZIRA']]],
];
for (const [label, cmds] of misc) {
  r = await sendRaw(PORT, 9600, cmds.map(([c, ...p]) => posnetHex(c, ...p)), [label]);
  const resp = r.error || r.lines?.[0]?.replace(/.*ASCII:/,'').replace(/[\x00-\x1f]/g, '·').trim();
  console.log(`  ${label.padEnd(24)} ${resp}`);
  await delay(300);
}

console.log('\n═══ Done ═══\n');
