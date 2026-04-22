#!/usr/bin/env node
/**
 * Send a non-fiscal printout to a real Posnet printer via the legacy
 * `prninit / prnline / prnend` path. Works even when the printer's fiscal
 * memory is locked (read-only after fiscal decommission).
 *
 * Bypasses the Electron driver; opens the serial port directly via
 * PowerShell using the same frame format the driver builds.
 *
 * Usage: node scripts/posnet-real-print.mjs [COM6] [9600]
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

const PORT = process.argv[2] || 'COM6';
const BAUD = Number(process.argv[3]) || 9600;

const STX = 0x02;
const ETX = 0x03;

function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function buildFrame(cmd, ...params) {
  let body = cmd + '\t';
  for (const p of params) body += p + '\t';
  const bodyBuf = Buffer.from(body, 'ascii');
  const crc = crc16(bodyBuf);
  const frame = Buffer.alloc(1 + bodyBuf.length + 1 + 4 + 1);
  let o = 0;
  frame[o++] = STX;
  bodyBuf.copy(frame, o); o += bodyBuf.length;
  frame[o++] = 0x23;
  Buffer.from(crc, 'ascii').copy(frame, o); o += 4;
  frame[o++] = ETX;
  return frame;
}

function hex(buf) {
  return Array.from(buf).map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(',');
}

async function sendFrames(commands) {
  const frames = commands.map(([cmd, ...p]) => ({ cmd, hex: hex(buildFrame(cmd, ...p)) }));

  let ps = '$ProgressPreference = "SilentlyContinue"\n';
  ps += `$p = New-Object System.IO.Ports.SerialPort('${PORT}', ${BAUD}, 'None', 8, 'One')\n`;
  ps += '$p.WriteTimeout = 5000\n$p.ReadTimeout = 5000\n';
  ps += '$p.DtrEnable = $true\n$p.RtsEnable = $true\n';
  ps += '$results = @()\n';
  ps += 'try {\n  $p.Open()\n';
  for (let i = 0; i < frames.length; i++) {
    ps += `  $f${i} = [byte[]]@(${frames[i].hex})\n`;
    ps += `  $p.Write($f${i}, 0, $f${i}.Length)\n`;
    ps += '  Start-Sleep -Milliseconds 1200\n';
    ps += '  $n = $p.BytesToRead\n';
    ps += '  if ($n -gt 0) {\n';
    ps += '    $buf = New-Object byte[] $n\n';
    ps += '    $p.Read($buf, 0, $n) | Out-Null\n';
    ps += '    $results += [System.Text.Encoding]::ASCII.GetString($buf)\n';
    ps += '  } else { $results += "NOREPLY" }\n';
  }
  ps += '  $results -join "|||"\n';
  ps += '} catch {\n  Write-Error $_.Exception.Message\n';
  ps += '} finally {\n  if ($p.IsOpen) { $p.Close() }\n}\n';

  const scriptPath = join(tmpdir(), `posnet-print-${Date.now()}.ps1`);
  writeFileSync(scriptPath, '﻿' + ps, 'utf8');

  let stdout = '', stderr = '';
  try {
    const result = await execFileP(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { encoding: 'utf8', timeout: frames.length * 3000 + 30000, maxBuffer: 10 * 1024 * 1024 },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }

  if (stderr?.trim()) {
    const cliXml = stderr.match(/<S S="Error">([^<]+)<\/S>/);
    if (cliXml) throw new Error(cliXml[1].replace(/&#xD;&#xA;/g, '').trim());
    const filtered = stderr.replace(/#< CLIXML[\s\S]*?Preparing modules[\s\S]*?<\/Objs>/gi, '').trim();
    if (filtered) throw new Error(filtered);
  }

  if (!stdout.trim()) throw new Error('Empty response — printer not accepting data (check power/paper/cable)');
  return { responses: stdout.trim().split('|||'), commands: frames.map((f) => f.cmd) };
}

// ─── Build receipt text (ASCII-only to avoid cp1250 encoding issues) ──────
const W = 40;
const pad = (s) => s.length >= W ? s : s + ' '.repeat(W - s.length);
const center = (s) => {
  const p = Math.max(0, Math.floor((W - s.length) / 2));
  return ' '.repeat(p) + s;
};
const row = (l, r) => {
  const sp = Math.max(1, W - l.length - r.length);
  return l + ' '.repeat(sp) + r;
};
const line = (c = '-') => c.repeat(W);
const money = (g) => (g / 100).toFixed(2).replace('.', ',');

const now = new Date();
const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

const items = [
  { name: 'Sukienka wieczorowa czerwona',  qty: 1, price: 29900, vat: 'A' },
  { name: 'Szpilki skorzane czarne r.38',  qty: 1, price: 24900, vat: 'A' },
  { name: 'Torebka Paris mini',            qty: 1, price: 15900, vat: 'A' },
  { name: 'Skarpetki bawelniane 3-pack',   qty: 2, price: 2500,  vat: 'B' },
];
const total = items.reduce((s, i) => s + i.qty * i.price, 0);

const lines = [
  '',
  center('*** ZIRA AI SANDBOX ***'),
  center('TEST WYDRUKU NIEFISKALNEGO'),
  line('='),
  center('ROYAL FASHION VIPOL Sp. z o.o.'),
  center('Aleje Jerozolimskie 214'),
  center('02-486 Warszawa'),
  center('NIP 5223103395'),
  '',
  row(ts, '#SANDBOX-01'),
  line(),
  ...items.flatMap((it, i) => [
    `${i + 1}. ${it.name}`,
    row(`   ${it.qty.toFixed(3)} x ${money(it.price)} ${it.vat}`, money(it.qty * it.price)),
  ]),
  line('='),
  row('RAZEM PLN', money(total)),
  line('='),
  row('Karta platnicza', money(total)),
  '',
  center('Dziekujemy za zakupy!'),
  center('www.royalfashion.pl'),
  '',
  center('--- WYDRUK NIEFISKALNY ---'),
  center('Drukarka w trybie tylko-odczyt'),
  center('Wygenerowano przez Zira AI'),
  '',
  '',
  '',
];

// ─── Execute ──────────────────────────────────────────────────────────────
console.log(`\n▶ Connecting to POSNET on ${PORT} @ ${BAUD} baud…\n`);

try {
  // Step 1: verify printer is alive
  const probe = await sendFrames([['rtcget']]);
  console.log(`✓ rtcget response: ${probe.responses[0].trim()}`);

  // Step 2: send non-fiscal printout
  console.log(`\n▶ Sending ${lines.length} lines via prninit → prnline × N → prnend …\n`);
  const cmds = [['prninit']];
  for (const txt of lines) {
    // prnline accepts tx<text>; empty lines sent as single space to avoid blank-arg issues
    cmds.push(['prnline', `tx${txt || ' '}`]);
  }
  cmds.push(['prnend']);

  const result = await sendFrames(cmds);

  const errors = result.responses.filter((r) => r.includes('ERR') || r === 'NOREPLY');
  console.log(`✓ Sent ${result.commands.length} frames`);
  console.log(`  First response:  ${result.responses[0]?.trim()}`);
  console.log(`  Last response :  ${result.responses[result.responses.length - 1]?.trim()}`);
  if (errors.length) {
    console.log(`\n⚠ ${errors.length} error responses:`);
    errors.slice(0, 5).forEach((e, i) => console.log(`   ${i + 1}. ${e.trim()}`));
  } else {
    console.log('\n✅ Success — check the printer for paper output!');
  }
} catch (err) {
  console.error(`\n✗ FAILED: ${err.message}`);
  if (/access.*denied|denied.*access/i.test(err.message)) {
    console.error('\n  → COM port is locked. Another process (likely the running Zira AI');
    console.error('    Electron app) owns it. Close the app or stop its dev server, then rerun.');
  }
  if (/no response|NOREPLY|accepting data/i.test(err.message)) {
    console.error('\n  → Printer did not respond. Verify:');
    console.error('    • Printer is powered on');
    console.error('    • USB cable is connected');
    console.error('    • Paper is loaded');
    console.error('    • Printer menu "Interfejs PC → Protokół" is set to POSNET');
  }
  process.exit(1);
}
