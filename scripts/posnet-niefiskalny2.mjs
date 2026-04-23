#!/usr/bin/env node
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
function posnetHex(cmd, ...p) { return hex(buildPosnet(cmd, ...p)); }

async function run(label, baud, byteHexStrings, waitMs = 1200) {
  let ps = `$ErrorActionPreference='Continue'\n$ProgressPreference='SilentlyContinue'\n`;
  ps += `try{\n`;
  ps += `$p=New-Object System.IO.Ports.SerialPort('${PORT}',${baud},'None',8,'One')\n`;
  ps += `$p.WriteTimeout=5000;$p.ReadTimeout=5000;$p.DtrEnable=$true;$p.RtsEnable=$true\n`;
  ps += `$p.Open()\n`;
  for (let i = 0; i < byteHexStrings.length; i++) {
    ps += `$f=[byte[]]@(${byteHexStrings[i]})\n`;
    ps += `$p.Write($f,0,$f.Length)\n`;
    ps += `Start-Sleep -Milliseconds ${waitMs}\n`;
    ps += `$n=$p.BytesToRead\n`;
    ps += `if($n -gt 0){$b=New-Object byte[] $n;[void]$p.Read($b,0,$n)\n`;
    ps += `$txt=[System.Text.Encoding]::GetEncoding(1250).GetString($b)\n`;
    ps += `Write-Output "RESP[$i]: $txt"}else{Write-Output "RESP[$i]: <no reply>"}\n`;
  }
  ps += `$p.Close()\n`;
  ps += `}catch{Write-Output "EXCEPTION: $($_.Exception.Message)"}\n`;
  ps += `finally{if($p -and $p.IsOpen){$p.Close()}}\n`;

  const f = join(tmpdir(), `pn2-${Date.now()}.ps1`);
  writeFileSync(f, ps, 'utf8');
  try {
    const { stdout, stderr } = await execFileP('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
      { encoding: 'utf8', timeout: 30000 });
    return stdout.trim() || stderr?.trim() || '<empty>';
  } finally {
    try { unlinkSync(f); } catch {}
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n═══ POSNET Niefiskalny Tests — ${PORT} ═══\n`);

// Test 1: Baseline rtcget
console.log('── 1. Baseline rtcget @ 9600 ──');
console.log(await run('rtcget', 9600, [posnetHex('rtcget')]));
await delay(500);

// Test 2: prncancel then trinit bm1 (non-fiscal)
console.log('\n── 2. prncancel → trinit bm1 @ 9600 ──');
console.log(await run('cancel+trinit', 9600, [posnetHex('prncancel'), posnetHex('trinit', 'bm1')]));
await delay(500);

// Test 3: trinit bm1 then trline then trend (full non-fiscal attempt)
console.log('\n── 3. Full non-fiscal: trinit bm1 → trline → trend @ 9600 ──');
console.log(await run('full-nf', 9600, [
  posnetHex('trinit', 'bm1'),
  posnetHex('trline', 'naTest Zira AI', 'vt0', 'pr100', 'il1.000'),
  posnetHex('trend', 'to100'),
]));
await delay(500);

// Test 4: rtcget at 115200
console.log('\n── 4. rtcget @ 115200 ──');
console.log(await run('rtcget-115200', 115200, [posnetHex('rtcget')]));
await delay(500);

// Test 5: ESC/POS raw at 9600
console.log('\n── 5. ESC/POS raw @ 9600 ──');
const escInit = '0x1B,0x40';
const escText = Array.from(Buffer.from('ZIRA AI SANDBOX TEST\r\n', 'ascii')).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(',');
const escFeed = '0x0A,0x0A,0x0A';
console.log(await run('escpos', 9600, [`${escInit},${escText},${escFeed}`], 2000));
await delay(500);

// Test 6: ESC/POS raw at 115200
console.log('\n── 6. ESC/POS raw @ 115200 ──');
console.log(await run('escpos-115200', 115200, [`${escInit},${escText},${escFeed}`], 2000));
await delay(500);

// Test 7: trinit bm3..bm9 undocumented
console.log('\n── 7. trinit bm3..bm9 @ 9600 ──');
for (let bm = 3; bm <= 9; bm++) {
  const r = await run(`bm${bm}`, 9600, [posnetHex('trinit', `bm${bm}`)]);
  const short = r.split('\n').map(l => l.replace(/[\x00-\x08\x0B-\x1F]/g, '·')).join(' | ');
  console.log(`  bm${bm}: ${short}`);
  await delay(300);
}

// Test 8: More POSNET commands that might exist
console.log('\n── 8. More POSNET commands @ 9600 ──');
const moreCmds = [
  ['fiscst',   []],        // fiscal status
  ['dspoff',   []],        // display off (test if display commands work)
  ['dspon',    []],        // display on
  ['dspclr',   []],        // display clear
  ['dsptxt',   ['ln1', 'txHello from Zira']],
  ['prninit',  ['tp1']],   // prninit with type param
  ['prninit',  ['tp0']],
  ['trinit',   ['bm1', 'tp0']],  // trinit bm1 with type
  ['trnlncl',  []],        // clear transaction lines
  ['cashst',   []],        // cash status
  ['prntst',   []],        // print test
  ['selftest', []],
  ['tst',      []],
  ['test',     []],
];
for (const [cmd, params] of moreCmds) {
  const label = params.length ? `${cmd} ${params.join(' ')}` : cmd;
  const r = await run(label, 9600, [posnetHex(cmd, ...params)]);
  const short = r.split('\n').map(l => l.replace(/[\x00-\x08\x0B-\x1F]/g, '·')).join(' | ');
  console.log(`  ${label.padEnd(30)} ${short}`);
  await delay(300);
}

console.log('\n═══ Done ═══\n');
