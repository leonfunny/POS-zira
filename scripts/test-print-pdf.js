/**
 * Test printing a PDF to Zebra printer.
 * Run: node scripts/test-print-pdf.js
 *
 * Uses the same ShellExecute "print" approach as ZebraDriver.printPdf()
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const PRINTER_NAME = 'ZDesigner GK420d';
const PDF_FILE = path.join(__dirname, 'test-output', 'label-50x30.pdf');

if (!fs.existsSync(PDF_FILE)) {
  console.error(`PDF not found: ${PDF_FILE}\nRun "node scripts/test-pdf-label.js" first.`);
  process.exit(1);
}

console.log(`Printer: ${PRINTER_NAME}`);
console.log(`PDF:     ${PDF_FILE}`);
console.log(`Size:    ${(fs.statSync(PDF_FILE).size / 1024).toFixed(1)} KB`);
console.log('');
console.log('Sending to printer...');

const psScript = `
$ErrorActionPreference = "Stop"
$pdfPath = '${PDF_FILE.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$printerName = '${PRINTER_NAME.replace(/'/g, "''")}'

# Find the target printer
$wmi = Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Name = '$($printerName.Replace("\\","\\\\"))'"
if (-not $wmi) { throw "Printer '$printerName' not found" }

# Save current default
$currentDefault = (Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Default=TRUE").Name
Write-Output "Current default: $currentDefault"

# Set Zebra as default
$wmi.SetDefaultPrinter() | Out-Null
Write-Output "Set default to: $printerName"

try {
    # Print via ShellExecute
    $process = Start-Process -FilePath $pdfPath -Verb Print -PassThru -WindowStyle Hidden
    Write-Output "Print process started (PID: $($process.Id))"

    # Wait up to 15 seconds
    $process | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
    if (-not $process.HasExited) {
        $process | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Output "WARN: Process timed out, force killed"
    } else {
        Write-Output "Process exited with code: $($process.ExitCode)"
    }
    Write-Output "OK"
} finally {
    # Restore previous default printer
    if ($currentDefault) {
        $restore = Get-WmiObject -Query "SELECT * FROM Win32_Printer WHERE Name = '$($currentDefault.Replace("\\","\\\\"))'"
        if ($restore) {
            $restore.SetDefaultPrinter() | Out-Null
            Write-Output "Restored default: $currentDefault"
        }
    }
}
`;

const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

execFile(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
  { timeout: 30000 },
  (error, stdout, stderr) => {
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error('STDERR:', stderr.trim());
    if (error) {
      console.error('ERROR:', error.message);
      process.exit(1);
    }
    console.log('\nDone! Check the Zebra printer for output.');
  }
);
