/**
 * Dry-run test for PDF label generation — compact layout.
 * Run: node scripts/test-pdf-label.js
 */
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const MM_TO_PT = 2.83465;
function fmtPrice(g) { return (g / 100).toFixed(2); }

async function generateTestLabel(widthMm, heightMm) {
  const wPt = widthMm * MM_TO_PT, hPt = heightMm * MM_TO_PT;
  const doc = await PDFDocument.create();
  const page = doc.addPage([wPt, hPt]);
  const fb = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 2.5 * MM_TO_PT;
  let y = hPt - margin;
  const black = rgb(0, 0, 0), dg = rgb(0.25, 0.25, 0.25);

  // Font sizes — big & bold for 30mm label
  const titleSize = Math.max(8, Math.min(14, heightMm * 0.32));
  const nameSize = Math.max(7, Math.min(13, heightMm * 0.28));
  const bodySize = Math.max(6, Math.min(11, heightMm * 0.24));
  const footSize = Math.max(4, Math.min(7, heightMm * 0.15));
  const gap = bodySize * 0.35;

  const data = {
    customerName: 'Nguyen Thi Mai',
    services: [
      { name: 'Acrylic Full Set', price: 5000 },
      { name: 'Gel Polish', price: 3500 },
      { name: 'Nail Art Design', price: 2500 },
    ],
    staffName: 'Linh',
    checkinTime: new Date().toISOString(),
  };
  const salon = 'Zira Nail Spa';
  const total = data.services.reduce((s, v) => s + v.price, 0);

  // Row 1: CHECK-IN · Salon (one line)
  y -= titleSize;
  page.drawText('CHECK-IN', { x: margin, y, size: titleSize, font: fb, color: black });
  const sw = fb.widthOfTextAtSize(salon, footSize + 1);
  page.drawText(salon, { x: wPt - margin - sw, y: y + 1, size: footSize + 1, font: fb, color: dg });
  y -= gap;

  // Separator
  page.drawLine({ start: { x: margin, y }, end: { x: wPt - margin, y }, thickness: 0.6, color: black });
  y -= gap + 1;

  // Row 2: Customer name
  y -= nameSize;
  page.drawText(data.customerName, { x: margin, y, size: nameSize, font: fb, color: black });
  y -= gap + 1;

  // Rows 3-N: Services + prices
  for (const svc of data.services.slice(0, 4)) {
    y -= bodySize;
    page.drawText('\u2022 ' + svc.name, { x: margin + 0.5 * MM_TO_PT, y, size: bodySize, font: fb, color: black });
    if (svc.price > 0) {
      const ps = fmtPrice(svc.price) + ' PLN';
      page.drawText(ps, { x: wPt - margin - fb.widthOfTextAtSize(ps, bodySize), y, size: bodySize, font: fb, color: black });
    }
    y -= gap;
  }

  // Total line
  if (total > 0) {
    page.drawLine({ start: { x: margin, y }, end: { x: wPt - margin, y }, thickness: 0.4, color: black });
    y -= bodySize + 1;
    const tStr = 'TOTAL: ' + fmtPrice(total) + ' PLN';
    page.drawText(tStr, { x: wPt - margin - fb.widthOfTextAtSize(tStr, bodySize + 1), y, size: bodySize + 1, font: fb, color: black });
  }

  // Footer: Staff · DateTime · Welcome! (one line at bottom)
  const dt = new Date(data.checkinTime);
  const timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const footerLeft = (data.staffName ? data.staffName + ' | ' : '') + dt.toLocaleDateString() + ' ' + timeStr;
  const bottomY = margin;
  page.drawText(footerLeft, { x: margin, y: bottomY, size: footSize, font: fb, color: dg });
  const wt = 'Welcome!';
  page.drawText(wt, { x: wPt - margin - fb.widthOfTextAtSize(wt, footSize), y: bottomY, size: footSize, font: fb, color: black });

  return doc.save();
}

async function main() {
  const outDir = path.join(__dirname, 'test-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const bytes = await generateTestLabel(50, 30);
  const fp = path.join(outDir, 'label-50x30.pdf');
  fs.writeFileSync(fp, bytes);
  console.log(`[OK] 50x30mm -> ${fp} (${(bytes.length / 1024).toFixed(1)} KB)`);
}
main().catch(console.error);
