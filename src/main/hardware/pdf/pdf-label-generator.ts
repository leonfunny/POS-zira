import { PDFDocument, rgb, StandardFonts, PDFFont } from 'pdf-lib';
import { CheckinConfirmationData } from '../../../shared/types';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import logger from '../../logger';

const MM_TO_PT = 2.83465;

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatPrice(grosze: number): string {
  return (grosze / 100).toFixed(2);
}

export interface LabelDimensions { widthMm: number; heightMm: number; }
export interface PdfLabelOptions { dimensions: LabelDimensions; salonName?: string; }

export class PdfLabelGenerator {
  private widthPt: number;
  private heightPt: number;
  private salonName: string;
  private labelsRoot: string;

  constructor(private options: PdfLabelOptions) {
    this.widthPt = options.dimensions.widthMm * MM_TO_PT;
    this.heightPt = options.dimensions.heightMm * MM_TO_PT;
    this.salonName = options.salonName || '';
    this.labelsRoot = path.join(app.getPath('userData'), 'labels');
    this.cleanupOldLabels().catch((e) => logger.warn('[PdfLabel] Cleanup failed:', e));
  }

  setDimensions(dims: LabelDimensions): void {
    this.options.dimensions = dims;
    this.widthPt = dims.widthMm * MM_TO_PT;
    this.heightPt = dims.heightMm * MM_TO_PT;
  }

  async generateCheckinLabel(data: CheckinConfirmationData): Promise<string> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([this.widthPt, this.heightPt]);
    const fb = await doc.embedFont(StandardFonts.HelveticaBold);

    const margin = 2.5 * MM_TO_PT;
    const usable = this.widthPt - margin * 2;
    let y = this.heightPt - margin;
    const black = rgb(0, 0, 0);
    const dg = rgb(0.25, 0.25, 0.25);

    const h = this.options.dimensions.heightMm;
    const titleSize = Math.max(8, Math.min(14, h * 0.32));
    const nameSize = Math.max(7, Math.min(13, h * 0.28));
    const bodySize = Math.max(6, Math.min(11, h * 0.24));
    const footSize = Math.max(4, Math.min(7, h * 0.15));
    const gap = bodySize * 0.35;

    // Row 1: CHECK-IN · Salon
    y -= titleSize;
    page.drawText('CHECK-IN', { x: margin, y, size: titleSize, font: fb, color: black });
    if (this.salonName) {
      const sw = fb.widthOfTextAtSize(this.salonName, footSize + 1);
      page.drawText(this.salonName, { x: this.widthPt - margin - sw, y: y + 1, size: footSize + 1, font: fb, color: dg });
    }
    y -= gap;

    // Separator
    page.drawLine({ start: { x: margin, y }, end: { x: this.widthPt - margin, y }, thickness: 0.6, color: black });
    y -= gap + 1;

    // Row 2: Customer name
    y -= nameSize;
    page.drawText(this.truncate(data.customerName, fb, nameSize, usable), { x: margin, y, size: nameSize, font: fb, color: black });
    y -= gap + 1;

    // Services + prices
    const maxSvcs = h <= 25 ? 2 : h <= 35 ? 3 : h <= 50 ? 4 : 6;
    const svcs = data.services.slice(0, maxSvcs);
    for (const svc of svcs) {
      y -= bodySize;
      page.drawText('\u2022 ' + this.truncate(svc.name, fb, bodySize, usable * 0.6), { x: margin + 0.5 * MM_TO_PT, y, size: bodySize, font: fb, color: black });
      if (svc.price > 0) {
        const ps = formatPrice(svc.price) + ' PLN';
        page.drawText(ps, { x: this.widthPt - margin - fb.widthOfTextAtSize(ps, bodySize), y, size: bodySize, font: fb, color: black });
      }
      y -= gap;
    }
    if (data.services.length > maxSvcs) {
      y -= footSize;
      page.drawText(`  +${data.services.length - maxSvcs} more`, { x: margin + 0.5 * MM_TO_PT, y, size: footSize, font: fb, color: dg });
      y -= gap;
    }

    // Total
    const total = data.services.reduce((sum, s) => sum + (s.price || 0), 0);
    if (total > 0) {
      page.drawLine({ start: { x: margin, y }, end: { x: this.widthPt - margin, y }, thickness: 0.4, color: black });
      y -= bodySize + 1;
      const tStr = 'TOTAL: ' + formatPrice(total) + ' PLN';
      page.drawText(tStr, { x: this.widthPt - margin - fb.widthOfTextAtSize(tStr, bodySize + 1), y, size: bodySize + 1, font: fb, color: black });
    }

    // Footer: Staff | DateTime   Welcome!
    const dt = new Date(data.checkinTime);
    const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const footerLeft = (data.staffName ? data.staffName + ' | ' : '') + dt.toLocaleDateString() + ' ' + timeStr;
    const bottomY = margin;
    page.drawText(footerLeft, { x: margin, y: bottomY, size: footSize, font: fb, color: dg });
    const wt = 'Welcome!';
    page.drawText(wt, { x: this.widthPt - margin - fb.widthOfTextAtSize(wt, footSize), y: bottomY, size: footSize, font: fb, color: black });

    // Save
    const dayDir = path.join(this.labelsRoot, todayDateStr());
    if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });
    const pdfBytes = await doc.save();
    const filePath = path.join(dayDir, `checkin-${Date.now()}.pdf`);
    fs.writeFileSync(filePath, pdfBytes);
    logger.info(`[PdfLabel] Generated ${this.options.dimensions.widthMm}x${this.options.dimensions.heightMm}mm -> ${filePath}`);
    return filePath;
  }

  async cleanupOldLabels(): Promise<number> {
    if (!fs.existsSync(this.labelsRoot)) return 0;
    const today = todayDateStr();
    let removed = 0;
    for (const entry of fs.readdirSync(this.labelsRoot)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry) || entry >= today) continue;
      try { fs.rmSync(path.join(this.labelsRoot, entry), { recursive: true, force: true }); removed++; logger.info(`[PdfLabel] Cleaned up: ${entry}`); } catch (e) { logger.warn(`[PdfLabel] Cleanup fail ${entry}:`, e); }
    }
    if (removed > 0) logger.info(`[PdfLabel] Daily cleanup: removed ${removed} old folder(s)`);
    return removed;
  }

  private calcMaxServices(heightMm: number): number { return heightMm <= 25 ? 2 : heightMm <= 35 ? 3 : heightMm <= 50 ? 4 : 6; }

  private truncate(text: string, font: PDFFont, fontSize: number, maxWidthPt: number): string {
    if (font.widthOfTextAtSize(text, fontSize) <= maxWidthPt) return text;
    let t = text;
    while (t.length > 1 && font.widthOfTextAtSize(t + '\u2026', fontSize) > maxWidthPt) t = t.slice(0, -1);
    return t + '\u2026';
  }
}
