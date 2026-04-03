/**
 * Test printing a PDF to Zebra via Electron's BrowserWindow.print()
 *
 * Run: npx electron scripts/test-print-pdf-electron.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const PRINTER_NAME = 'ZDesigner GK420d';
const PDF_FILE = path.join(__dirname, 'test-output', 'label-50x30.pdf');
const LABEL_WIDTH_MM = 50;
const LABEL_HEIGHT_MM = 30;

app.whenReady().then(async () => {
  if (!fs.existsSync(PDF_FILE)) {
    console.error(`PDF not found: ${PDF_FILE}\nRun "node scripts/test-pdf-label.js" first.`);
    app.quit();
    return;
  }

  console.log(`Printer: ${PRINTER_NAME}`);
  console.log(`PDF:     ${PDF_FILE}`);
  console.log(`Label:   ${LABEL_WIDTH_MM}x${LABEL_HEIGHT_MM}mm`);
  console.log('');

  // List available printers
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  const printers = win.webContents.getPrintersAsync
    ? await win.webContents.getPrintersAsync()
    : win.webContents.getPrinters();

  console.log('Available printers:');
  for (const p of printers) {
    const marker = p.name === PRINTER_NAME ? ' <<<' : '';
    console.log(`  - ${p.name} (${p.status === 0 ? 'OK' : 'status:' + p.status})${marker}`);
  }
  console.log('');

  const target = printers.find(p => p.name === PRINTER_NAME);
  if (!target) {
    console.error(`Printer "${PRINTER_NAME}" not found!`);
    win.destroy();
    app.quit();
    return;
  }

  console.log('Loading PDF...');
  await win.loadFile(PDF_FILE);

  // Wait for Chromium PDF renderer
  await new Promise(r => setTimeout(r, 1500));

  console.log('Sending print job...');
  win.webContents.print(
    {
      silent: true,
      deviceName: PRINTER_NAME,
      printBackground: true,
      margins: { marginType: 'none' },
      pageSize: {
        width: LABEL_WIDTH_MM * 1000,  // microns
        height: LABEL_HEIGHT_MM * 1000,
      },
    },
    (success, failureReason) => {
      if (success) {
        console.log('Print job sent successfully!');
      } else {
        console.error(`Print failed: ${failureReason}`);
      }
      win.destroy();
      app.quit();
    },
  );
});

app.on('window-all-closed', () => {
  app.quit();
});
