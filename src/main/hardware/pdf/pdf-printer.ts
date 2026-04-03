import { BrowserWindow, app } from 'electron';
import { CheckinConfirmationData } from '../../../shared/types';
import path from 'path';
import fs from 'fs';
import logger from '../../logger';

export interface PrintLabelOptions {
  printerName: string;
  labelWidthMm: number;
  labelHeightMm: number;
  data: CheckinConfirmationData;
  salonName?: string;
  silent?: boolean;
  /** When printing multi-label, indicates current page and total */
  pageInfo?: { page: number; total: number };
  /** Grand total of ALL services across all pages (grosze). Used so the summary page shows the correct total, not just one page's subtotal. */
  grandTotal?: number;
}

/**
 * How many services fit on a single label given the label height in mm.
 */
export function getMaxServicesPerLabel(heightMm: number): number {
  return heightMm <= 25 ? 2 : heightMm <= 35 ? 3 : heightMm <= 50 ? 4 : 6;
}

function esc(t: string): string { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtPrice(g: number): string { return (g / 100).toFixed(2); }

function buildLabelHtml(opts: PrintLabelOptions): string {
  const { labelWidthMm: w, labelHeightMm: h, data, salonName, pageInfo } = opts;
  const isFirstPage = !pageInfo || pageInfo.page === 1;
  const isLastPage = !pageInfo || pageInfo.page === pageInfo.total;
  const isMultiPage = pageInfo && pageInfo.total > 1;

  // Name-level size used for CHECK-IN title, customer name, and booking number
  const ns = Math.max(7, Math.min(13, h * 0.28)).toFixed(1);
  const bs = Math.max(6, Math.min(11, h * 0.24)).toFixed(1);
  // Footer (staff + time) — bigger than before
  const footSz = Math.max(6, Math.min(10, h * 0.22)).toFixed(1);
  const smallSz = Math.max(4, Math.min(7, h * 0.15)).toFixed(1);

  // Services already split by caller — render all of them
  const svcs = data.services;
  const pageTotal = data.services.reduce((s, v) => s + (v.price || 0), 0);
  // Use grand total (all services across all pages) if provided, otherwise fall back to page total
  const total = opts.grandTotal ?? pageTotal;

  // Display name: prefer name, fallback to phone
  const displayName = data.customerName && data.customerName !== 'Guest'
    ? data.customerName
    : (data.customerPhone || data.customerName || 'Guest');

  const dt = new Date(data.checkinTime);
  const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = dt.toLocaleDateString();
  const footerLeft = data.staffName ? esc(data.staffName) : '';
  const footerRight = esc(dateStr) + ' ' + esc(timeStr);

  const svcsHtml = svcs.map(s => {
    const price = s.price > 0 ? `<span class="price">${fmtPrice(s.price)} z\u0142</span>` : '';
    return `<div class="svc"><span>\u2022 ${esc(s.name)}</span>${price}</div>`;
  }).join('\n');

  // Show total only on the last page (or single page)
  const totalHtml = isLastPage && total > 0 ? `<div class="total">TOTAL: ${fmtPrice(total)} z\u0142</div>` : '';

  // Booking number on same line as name (right-aligned)
  const bookingHtml = data.bookingNumber ? `<span class="booking">${esc(data.bookingNumber)}</span>` : '';

  // Page indicator for multi-label prints
  const pageTag = isMultiPage ? `<span class="page-tag">${pageInfo!.page}/${pageInfo!.total}</span>` : '';

  // Continuation header for pages after the first
  const headerHtml = isFirstPage
    ? `<div class="header"><span class="title">CHECK-IN</span>${salonName ? `<span class="salon">${esc(salonName)}</span>` : ''}</div>
<div class="sep"></div>
<div class="name-row"><span class="name">${esc(displayName)}</span>${bookingHtml}</div>`
    : `<div class="header"><span class="title">${esc(displayName)}</span>${pageTag}</div>
<div class="sep"></div>`;

  // Footer: show staff/time on last page, "continued →" on others
  const footerHtml = isLastPage
    ? `<div class="footer"><span>${footerLeft}</span><span>${footerRight}</span></div>`
    : `<div class="footer"><span style="color:#666">\u25B6 continued\u2026</span>${pageTag}</div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: ${w}mm ${h}mm; margin: 0; }
* { margin:0; padding:0; box-sizing:border-box; }
body { width:${w}mm; height:${h}mm; font-family:Helvetica,Arial,sans-serif; padding:2.5mm 3mm; display:flex; flex-direction:column; overflow:hidden; -webkit-print-color-adjust:exact; }
.header { display:flex; justify-content:space-between; align-items:baseline; }
.title { font-size:${ns}pt; font-weight:900; }
.salon { font-size:calc(${smallSz}pt + 1pt); font-weight:700; color:#444; }
.sep { border-top:0.4mm solid #000; margin:0.3mm 0; }
.name-row { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:0.3mm; }
.name { font-size:${ns}pt; font-weight:900; }
.booking { font-size:${ns}pt; font-weight:900; white-space:nowrap; padding-left:1mm; }
.svc { font-size:${bs}pt; font-weight:700; padding-left:0.5mm; line-height:1.45; display:flex; justify-content:space-between; }
.svc .price { white-space:nowrap; padding-left:1mm; }
.page-tag { font-size:${smallSz}pt; font-weight:700; color:#666; }
.total { font-size:calc(${bs}pt + 1pt); font-weight:900; text-align:right; border-top:0.3mm solid #000; padding-top:0.2mm; }
.footer { margin-top:auto; display:flex; justify-content:space-between; align-items:baseline; font-size:${footSz}pt; font-weight:700; }
</style></head><body>
${headerHtml}
${svcsHtml}${totalHtml}
${footerHtml}
</body></html>`;
}

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function saveHtmlLabel(html: string): string {
  const labelsRoot = path.join(app.getPath('userData'), 'labels');
  const dayDir = path.join(labelsRoot, todayDateStr());
  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, `checkin-${Date.now()}.html`);
  fs.writeFileSync(filePath, html, 'utf-8');
  logger.info(`[PdfPrinter] Saved HTML label -> ${filePath}`);
  return filePath;
}

export async function cleanupOldLabels(): Promise<number> {
  const labelsRoot = path.join(app.getPath('userData'), 'labels');
  if (!fs.existsSync(labelsRoot)) return 0;
  const today = todayDateStr();
  let removed = 0;
  for (const entry of fs.readdirSync(labelsRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry) || entry >= today) continue;
    try { fs.rmSync(path.join(labelsRoot, entry), { recursive: true, force: true }); removed++; logger.info(`[PdfPrinter] Cleaned up old labels: ${entry}`); } catch (e) { logger.warn(`[PdfPrinter] Cleanup fail ${entry}:`, e); }
  }
  if (removed > 0) logger.info(`[PdfPrinter] Daily cleanup: removed ${removed} old folder(s)`);
  return removed;
}

export async function printLabelToDevice(opts: PrintLabelOptions): Promise<string> {
  const { printerName, labelWidthMm, labelHeightMm, silent = true } = opts;
  logger.info(`[PdfPrinter] Printing ${labelWidthMm}x${labelHeightMm}mm label -> "${printerName}"`);
  const html = buildLabelHtml(opts);

  // Save HTML to labels/ folder for archive
  const htmlPath = saveHtmlLabel(html);

  const win = new BrowserWindow({ show: false, width: Math.round(labelWidthMm * 4), height: Math.round(labelHeightMm * 4), webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise(r => setTimeout(r, 500));
    await new Promise<void>((resolve, reject) => {
      win.webContents.print({ silent, deviceName: printerName, printBackground: true, margins: { marginType: 'none' }, pageSize: { width: labelWidthMm * 1000, height: labelHeightMm * 1000 } },
        (success, reason) => { if (success) { logger.info(`[PdfPrinter] Label printed to "${printerName}"`); resolve(); } else { reject(new Error(`Print failed: ${reason}`)); } });
    });
  } finally { win.destroy(); }
  return htmlPath;
}
