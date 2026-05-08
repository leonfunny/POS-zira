import { BrowserWindow, app } from 'electron';
import QRCode from 'qrcode';
import { CheckinConfirmationData, InfoLabelData, ManufacturerRole } from '../../../shared/types';
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

export interface PrintInfoLabelOptions {
  printerName: string;
  labelWidthMm: number;
  labelHeightMm: number;
  data: InfoLabelData;
  silent?: boolean;
}

function esc(t: string): string { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtPrice(g: number): string { return (g / 100).toFixed(2); }

function formatInfoDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

const INFO_ROLE_PREFIX: Record<ManufacturerRole, string> = {
  [ManufacturerRole.PRODUCER]: 'Producent',
  [ManufacturerRole.IMPORTER]: 'Importer',
  [ManufacturerRole.DISTRIBUTOR]: 'Dystrybutor',
  [ManufacturerRole.SUPPLIER]: 'Dostawca',
};

/** Pipe-separated QR payload for booking lookup: ZIRA|<booking>|<phone>|<iso-timestamp> */
export function buildQrPayload(data: CheckinConfirmationData): string {
  const phone = (data.customerPhone || '').replace(/\|/g, '');
  const ts = data.checkinTime || new Date().toISOString();
  const booking = (data.bookingNumber || '').replace(/\|/g, '');
  return `ZIRA|${booking}|${phone}|${ts}`;
}

async function generateQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 200,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

export async function buildLabelHtml(opts: PrintLabelOptions): Promise<string> {
  const { labelWidthMm: w, labelHeightMm: h, data, salonName, pageInfo } = opts;
  const isFirstPage = !pageInfo || pageInfo.page === 1;
  const isLastPage = !pageInfo || pageInfo.page === pageInfo.total;
  const isMultiPage = pageInfo && pageInfo.total > 1;

  // Name-level size used for CHECK-IN title, customer name, and booking number
  const ns = Math.max(8, Math.min(14, h * 0.30)).toFixed(1);
  const bs = Math.max(7, Math.min(12, h * 0.26)).toFixed(1);
  // Footer (staff + time / continued indicator) — bumped for thermal legibility
  const footSz = Math.max(7, Math.min(12, h * 0.26)).toFixed(1);
  // Page tag (1/3, 2/3...) — previously too small (was 4-7pt), now 6-10pt
  const smallSz = Math.max(6, Math.min(10, h * 0.22)).toFixed(1);
  // Customer notes — bumped for thermal legibility (was 5-9pt)
  const notesSz = Math.max(7, Math.min(11, h * 0.24)).toFixed(1);
  // Big service font for non-last pages: service fills empty middle space.
  // Clamped so name-row and footer still fit above/below on small labels.
  const bigSvcSz = Math.max(10, Math.min(14, h * 0.32)).toFixed(1);

  // QR code size derived from label dimensions — scales with user's configured label size.
  // Clamped 7–14mm so very small labels stay scannable and very large labels don't waste space.
  const qrMm = Math.max(7, Math.min(14, h * 0.36, w * 0.24));
  const qrPadMm = (qrMm + 1.5).toFixed(2);
  // Notes character cap scales with label width so bigger labels allow longer notes.
  // Kept conservative (0.6x) so notes stay on a single line and don't push the footer off the label.
  const maxNotesLen = Math.max(20, Math.floor(w * 0.6));

  // Services already split by caller — render all of them
  const svcs = data.services;
  const pageTotal = data.services.reduce((s, v) => s + (v.price || 0), 0);
  // Use grand total (all services across all pages) if provided, otherwise fall back to page total
  const total = opts.grandTotal ?? pageTotal;

  // Display name: prefer name, fallback to phone
  const displayName = data.customerName && data.customerName !== 'Guest'
    ? data.customerName
    : (data.customerPhone || data.customerName || 'Guest');

  // Compact footer format so staff + date + time fit on a single line next to the QR code.
  const dt = new Date(data.checkinTime);
  const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`;
  const footerLeft = data.staffName ? esc(data.staffName) : '';
  const footerRight = esc(dateStr) + ' ' + esc(timeStr);

  const svcsHtml = svcs.map(s => {
    const price = s.price > 0 ? `<span class="price">${fmtPrice(s.price)} z\u0142</span>` : '';
    return `<div class="svc"><span>\u2022 ${esc(s.name)}</span>${price}</div>`;
  }).join('\n');

  // Customer notes — only on last page, after total. Truncate so long notes don't overflow.
  const rawNotes = isLastPage && data.customerNotes ? data.customerNotes : '';
  const notesText = rawNotes.length > maxNotesLen ? rawNotes.slice(0, maxNotesLen) + '\u2026' : rawNotes;
  const notesHtml = notesText ? `<div class="notes">\u{1F4DD} ${esc(notesText)}</div>` : '';

  // Show total only on the last page (or single page)
  const totalHtml = isLastPage && total > 0 ? `<div class="total">TOTAL: ${fmtPrice(total)} z\u0142</div>` : '';

  // Staff name already shown in the footer on the last page — no separate "Staff:" line needed.
  const staffLineHtml = '';

  // Booking number on same line as name (right-aligned)
  const bookingHtml = data.bookingNumber ? `<span class="booking">${esc(data.bookingNumber)}</span>` : '';

  // Page indicator for multi-label prints
  const pageTag = isMultiPage ? `<span class="page-tag">${pageInfo!.page}/${pageInfo!.total}</span>` : '';

  // Continuation header for pages after the first.
  // On non-first pages we still show booking# so each slip can be identified on its own.
  const headerHtml = isFirstPage
    ? `<div class="header"><span class="title">CHECK-IN</span>${salonName ? `<span class="salon">${esc(salonName)}</span>` : ''}</div>
<div class="sep"></div>
<div class="name-row"><span class="name">${esc(displayName)}</span>${bookingHtml}</div>`
    : `<div class="name-row"><span class="name">${esc(displayName)}</span>${bookingHtml}${pageTag}</div>
<div class="sep"></div>`;

  // Staff name intentionally only appears on the last (total) page to save vertical space.
  // On middle/non-last pages, omitting it lets long service names breathe without overflowing.
  const staffHintHtml = '';

  // Footer: show staff/time on last page, "continued →" on others (now black, not gray)
  const footerHtml = isLastPage
    ? `<div class="footer"><span>${footerLeft}</span><span>${footerRight}</span></div>`
    : `<div class="footer"><span>\u25B6 continued\u2026</span>${pageTag}</div>`;

  // QR code — only on the last page (or single-page). Contains booking lookup payload.
  let qrHtml = '';
  if (isLastPage) {
    try {
      const qrDataUrl = await generateQrDataUrl(buildQrPayload(data));
      qrHtml = `<img class="qr" src="${qrDataUrl}" alt="QR" />`;
    } catch (e) {
      logger.warn('[PdfPrinter] QR generation failed, printing label without QR:', e);
    }
  }

  // first-page marker lets CSS keep the footer inline on single-service labels (which already
  // carry the CHECK-IN header) and only stack it on multi-page last pages where there's more room.
  const bodyClass = [
    qrHtml ? 'has-qr' : '',
    isLastPage ? '' : 'non-last',
    isFirstPage ? 'first-page' : '',
  ].filter(Boolean).join(' ');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: ${w}mm ${h}mm; margin: 0; }
* { margin:0; padding:0; box-sizing:border-box; }
body { width:${w}mm; height:${h}mm; font-family:Helvetica,Arial,sans-serif; padding:2.5mm 3mm; display:flex; flex-direction:column; overflow:hidden; position:relative; -webkit-print-color-adjust:exact; }
.header { display:flex; justify-content:space-between; align-items:baseline; }
.title { font-size:${ns}pt; font-weight:900; }
.salon { font-size:calc(${smallSz}pt + 1pt); font-weight:900; color:#000; }
.sep { border-top:0.4mm solid #000; margin:0.3mm 0; }
.name-row { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:0.3mm; gap:1mm; white-space:nowrap; overflow:hidden; }
.name { font-size:${ns}pt; font-weight:900; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:1 1 auto; }
.booking { font-size:${ns}pt; font-weight:900; white-space:nowrap; flex:0 0 auto; }
.svc { font-size:${bs}pt; font-weight:700; padding-left:0.5mm; line-height:1.35; display:flex; justify-content:space-between; }
.svc .price { white-space:nowrap; padding-left:1mm; }
.page-tag { font-size:${smallSz}pt; font-weight:900; color:#000; }
.notes { font-size:${notesSz}pt; color:#000; margin-top:0.2mm; line-height:1.25; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.total { font-size:calc(${bs}pt + 1pt); font-weight:900; text-align:right; border-top:0.3mm solid #000; padding-top:0.2mm; }
.staff-line { font-size:${footSz}pt; font-weight:700; margin-top:0.2mm; }
.staff-hint { font-size:${footSz}pt; font-weight:700; text-align:center; margin-top:0.5mm; color:#000; }
.footer { margin-top:auto; display:flex; justify-content:space-between; align-items:baseline; gap:1.5mm; font-size:${footSz}pt; font-weight:900; color:#000; white-space:nowrap; overflow:hidden; }
.footer > span { overflow:hidden; text-overflow:ellipsis; }
/* When the QR is present AND this is a multi-page last page (no CHECK-IN header), stack
   staff + date vertically so each gets the full left-of-QR width. Single-service labels
   (has-qr + first-page) keep footer inline to avoid overflowing the already-tight layout. */
.has-qr:not(.first-page) .footer { flex-direction:column; align-items:flex-start; gap:0.3mm; line-height:1.15; }
/* Single-service fallback: staff name ellipsizes gracefully while the date is guaranteed to show. */
.has-qr.first-page .footer > span:first-child { flex:1 1 auto; min-width:0; }
.has-qr.first-page .footer > span:last-child { flex:0 0 auto; }
.non-last .svc { flex:1 1 0; min-height:0; overflow:hidden; flex-direction:column; align-items:center; justify-content:center; font-size:${bigSvcSz}pt; text-align:center; padding-left:0; line-height:1.2; gap:0.8mm; }
.non-last .svc > span:first-child { display:block; white-space:normal; }
.non-last .svc .price { padding-left:0; font-size:calc(${bigSvcSz}pt - 2pt); font-weight:900; }
.qr { position:absolute; right:1.5mm; bottom:1.5mm; width:${qrMm.toFixed(2)}mm; height:${qrMm.toFixed(2)}mm; display:block; }
.has-qr .total,
.has-qr .notes,
.has-qr .staff-line,
.has-qr .footer { padding-right:${qrPadMm}mm; }
</style></head><body class="${bodyClass}">
${headerHtml}
${svcsHtml}${staffHintHtml}${totalHtml}${staffLineHtml}${notesHtml}
${footerHtml}
${qrHtml}
</body></html>`;
}

export function buildInfoLabelHtml(opts: PrintInfoLabelOptions): string {
  const { labelWidthMm: w, labelHeightMm: h, data } = opts;
  const tall = h >= 90;
  const titlePt = tall ? 18 : 10;
  const bodyPt = tall ? 11 : 7;
  const metaPt = tall ? 12 : 8;
  const sectionGap = tall ? 8 : 3;
  const blockGap = tall ? 20 : 5;
  const paddingX = tall ? 8 : 3;
  const paddingY = tall ? 8 : 2;
  const countryHtml = data.countryOfOrigin
    ? `<div class="country">Kraj pochodzenia: ${esc(data.countryOfOrigin)}</div>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: ${w}mm ${h}mm; margin: 0; }
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:${w}mm;
  height:${h}mm;
  font-family: Arial, "Segoe UI", Helvetica, sans-serif;
  padding:${paddingY}mm ${paddingX}mm;
  color:#000;
  background:#fff;
  overflow:hidden;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}
.title {
  font-size:${titlePt}pt;
  font-weight:800;
  line-height:1.15;
  margin-bottom:${tall ? 22 : 5}px;
}
.ingredients {
  font-size:${bodyPt}pt;
  font-weight:700;
  line-height:1.28;
  margin-bottom:${blockGap}px;
  white-space:pre-wrap;
}
.best-before {
  font-size:${metaPt}pt;
  font-weight:800;
  line-height:1.2;
  margin-bottom:${sectionGap}px;
}
.manufacturer,
.country {
  font-size:${bodyPt}pt;
  font-weight:700;
  line-height:1.28;
}
.label {
  font-weight:900;
}
</style></head><body>
<div class="title">${esc(data.productName)}</div>
<div class="ingredients"><span class="label">Składniki:</span> ${esc(data.ingredients)}</div>
<div class="best-before">Najlepiej spożyć przed: ${esc(formatInfoDate(data.bestBefore))}</div>
<div class="manufacturer"><span class="label">${INFO_ROLE_PREFIX[data.manufacturerRole] || 'Producent'}:</span> ${esc(data.manufacturerInfo)}</div>
${countryHtml}
</body></html>`;
}

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function saveHtmlLabel(html: string, prefix = 'checkin'): string {
  const labelsRoot = path.join(app.getPath('userData'), 'labels');
  const dayDir = path.join(labelsRoot, todayDateStr());
  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, `${prefix}-${Date.now()}.html`);
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
  const html = await buildLabelHtml(opts);

  // Save HTML to labels/ folder for archive
  const htmlPath = saveHtmlLabel(html);
  await printHtmlToDevice({ html, printerName, labelWidthMm, labelHeightMm, silent });
  return htmlPath;
}

export async function printInfoLabelToDevice(opts: PrintInfoLabelOptions): Promise<string> {
  const { printerName, labelWidthMm, labelHeightMm, silent = true } = opts;
  logger.info(`[PdfPrinter] Printing ${labelWidthMm}x${labelHeightMm}mm info label -> "${printerName}"`);
  const html = buildInfoLabelHtml(opts);
  const htmlPath = saveHtmlLabel(html, 'info-label');
  await printHtmlToDevice({ html, printerName, labelWidthMm, labelHeightMm, silent });
  return htmlPath;
}

async function printHtmlToDevice(opts: {
  html: string;
  printerName: string;
  labelWidthMm: number;
  labelHeightMm: number;
  silent: boolean;
}): Promise<void> {
  const { html, printerName, labelWidthMm, labelHeightMm, silent } = opts;
  const win = new BrowserWindow({ show: false, width: Math.round(labelWidthMm * 4), height: Math.round(labelHeightMm * 4), webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise(r => setTimeout(r, 500));
    await new Promise<void>((resolve, reject) => {
      win.webContents.print({ silent, deviceName: printerName, printBackground: true, margins: { marginType: 'none' }, pageSize: { width: labelWidthMm * 1000, height: labelHeightMm * 1000 } },
        (success, reason) => { if (success) { logger.info(`[PdfPrinter] Label printed to "${printerName}"`); resolve(); } else { reject(new Error(`Print failed: ${reason}`)); } });
    });
  } finally { win.destroy(); }
}
