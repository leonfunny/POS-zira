// Kitchen ticket: what the cooks see when a paid order contains items from a
// kitchen-flagged category (categories.kitchen_print = 1). Deliberately NO
// prices — the kitchen needs order number, time, source, items, quantities,
// and notes, in a large readable font. Rendering goes through the thermal
// driver's plain-line path so Vietnamese/Polish names fall back to raster
// instead of printing mangled code-page text.
import type { EscPosPlainLine } from '../hardware/thermal/escpos-formatter';
import type { KitchenTicketData, KitchenTicketItem } from '../../shared/types';

export type { KitchenTicketData, KitchenTicketItem };

function sourceLabel(source: string): string {
  const normalized = String(source || '').toUpperCase();
  if (normalized === 'SELF_CHECKOUT') return 'KIOSK';
  if (normalized === 'POS') return 'KASA';
  return normalized || 'KASA';
}

function ticketLanguage(data: KitchenTicketData): 'pl' | 'vi' | 'en' {
  const lang = String(data.kitchenLanguage || '').toLowerCase();
  return lang === 'vi' || lang === 'en' ? lang : 'pl';
}

function customerSlipLanguage(data: KitchenTicketData): 'pl' | 'vi' | 'en' {
  const lang = String(data.customerLanguage || '').toLowerCase();
  return lang === 'vi' || lang === 'en' ? lang : 'pl';
}

function fulfillmentLabel(value: KitchenTicketData['fulfillmentType'], lang: 'pl' | 'vi' | 'en'): string | null {
  const normalized = String(value || '').toUpperCase();
  if (normalized !== 'DINE_IN' && normalized !== 'TAKEAWAY') return null;
  if (lang === 'vi') return normalized === 'TAKEAWAY' ? 'MANG DI' : 'AN TAI QUAN';
  if (lang === 'en') return normalized === 'TAKEAWAY' ? 'TAKEAWAY' : 'DINE IN';
  return normalized === 'TAKEAWAY' ? 'NA WYNOS' : 'NA MIEJSCU';
}

function orderNumberLabel(orderNumber: string): string {
  const normalized = String(orderNumber || '').trim();
  if (!normalized) return '#--------';
  return normalized.toUpperCase().startsWith('K-') ? normalized : `#${normalized}`;
}

function formatTimeHHMM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function pickupSlipBrandName(data: KitchenTicketData): string {
  const text = String(data.brandName || '').replace(/\s+/g, ' ').trim();
  return text || 'Zira POS';
}

function formatQuantity(item: KitchenTicketItem): string {
  const unit = (item.unit || '').trim().toLowerCase();
  const isWeighted = unit && unit !== 'szt' && unit !== 'pcs';
  if (isWeighted) {
    // Weighted items keep up to 3 decimals, trimmed (0.500 -> 0.5).
    const qty = Number(item.quantity);
    const text = Number.isFinite(qty) ? String(parseFloat(qty.toFixed(3))) : String(item.quantity);
    return `${text} ${item.unit}`;
  }
  return `${Math.max(1, Math.round(Number(item.quantity) || 1))}x`;
}

export function kitchenItemCount(items: KitchenTicketItem[]): number {
  return items.reduce((sum, item) => {
    const unit = (item.unit || '').trim().toLowerCase();
    const weighted = unit !== '' && unit !== 'szt' && unit !== 'pcs';
    return sum + (weighted ? 1 : Math.max(1, Math.round(Number(item.quantity) || 1)));
  }, 0);
}

function formatMoney(grosze: unknown): string {
  const amount = Math.max(0, Math.round(Number(grosze) || 0));
  return `${(amount / 100).toFixed(2).replace('.', ',')} zl`;
}

function lineTotal(item: KitchenTicketItem): number {
  const explicit = Math.round(Number(item.lineTotalGrosze) || 0);
  if (explicit > 0) return explicit;
  const unit = Math.round(Number(item.unitPriceGrosze) || 0);
  const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
  return unit * quantity;
}

export function buildKitchenTicketLines(data: KitchenTicketData): EscPosPlainLine[] {
  const lines: EscPosPlainLine[] = [];
  const lang = ticketLanguage(data);
  const fulfillment = fulfillmentLabel(data.fulfillmentType, lang);

  lines.push({ text: lang === 'vi' ? '*** BEP ***' : '*** KUCHNIA ***', bold: true, center: true, textSize: 'double-size' });
  if (data.isReprint) {
    lines.push({ text: '(KOPIA / IN LAI)', bold: true, center: true });
  }
  lines.push({ text: orderNumberLabel(data.orderNumber), bold: true, center: true, textSize: 'double-size' });
  if (String(data.paymentStatus || '').toUpperCase() === 'UNPAID') {
    lines.push({ text: 'NIEOPLACONE / CHUA TRA TIEN', bold: true, center: true, textSize: 'double-height' });
  }
  if (fulfillment) {
    lines.push({ text: fulfillment, bold: true, center: true, textSize: 'double-height' });
  }
  lines.push({
    text: `${formatTimeHHMM(data.createdAt)}  ·  ${sourceLabel(data.source)}`,
    center: true,
  });
  lines.push({ text: '', separator: true });

  for (const item of data.items) {
    lines.push({
      text: `${formatQuantity(item)} ${item.name}`,
      bold: true,
      textSize: 'double-height',
    });
    const notes = (item.notes || '').trim();
    if (notes) {
      lines.push({ text: lang === 'vi' ? `   Ghi chu: ${notes}` : `   >> ${notes}` });
    }
  }

  lines.push({ text: '', separator: true });
  if (data.pickupNumber) {
    // Hand-over matching: the same number prints on the customer's pickup
    // slip; the kitchen gives the food to the matching number.
    lines.push({ text: 'NR / SO:', bold: true, center: true });
    lines.push({ text: data.pickupNumber, bold: true, center: true, textSize: 'double-size' });
    lines.push({ text: '', separator: true });
  }
  return lines;
}

/**
 * Customer pickup slip: a short strip printed right after the paragon with
 * the SAME daily number as the kitchen ticket, in the biggest font the
 * printer has. The customer shows it to the kitchen to collect the food.
 */
export function buildPickupSlipLines(data: KitchenTicketData): EscPosPlainLine[] {
  const lang = customerSlipLanguage(data);
  const fulfillment = fulfillmentLabel(data.fulfillmentType, lang);
  const number = data.pickupNumber || data.orderNumber || '----';
  const copy = {
    pl: {
      title: 'NUMER ZAMOWIENIA',
      keep: 'Zachowaj ten numer.',
      scan: 'Zeskanuj przy kasie.',
    },
    vi: {
      title: 'SO DON',
      keep: 'Giu so nay de nhan mon.',
      scan: 'Quet tai quay thu ngan.',
    },
    en: {
      title: 'ORDER NUMBER',
      keep: 'Keep this number for pickup.',
      scan: 'Scan at cashier.',
    },
  }[lang];
  const lines: EscPosPlainLine[] = [];
  lines.push({ text: pickupSlipBrandName(data), bold: true, center: true });
  lines.push({ text: `${copy.title} / NR ODBIORU`, bold: true, center: true });
  lines.push({ text: number, bold: true, center: true, textSize: 'double-size' });
  if (fulfillment) {
    lines.push({ text: fulfillment, bold: true, center: true });
  }
  lines.push({ text: `${orderNumberLabel(data.orderNumber)}  ·  ${formatTimeHHMM(data.createdAt)}`, center: true });
  if (data.qrPayload) {
    lines.push({ text: copy.scan, bold: true, center: true });
    lines.push({ text: '', qrData: data.qrPayload, qrSize: 5 });
  }
  lines.push({ text: copy.keep, center: true });
  lines.push({ text: '', separator: true });
  return lines;
}

/**
 * Kitchen self-order payment slip: the customer takes this unpaid order to the
 * cashier. It keeps the QR recall payload from the pickup slip and adds prices.
 */
export function buildKitchenPaymentSlipLines(data: KitchenTicketData): EscPosPlainLine[] {
  const lang = customerSlipLanguage(data);
  const fulfillment = fulfillmentLabel(data.fulfillmentType, lang);
  const number = data.pickupNumber || data.orderNumber || '----';
  const copy = {
    pl: {
      title: 'DO ZAPLATY PRZY KASIE',
      order: 'NUMER ZAMOWIENIA',
      total: 'RAZEM',
      pay: 'Pokaz ten slip przy kasie.',
      scan: 'Zeskanuj przy kasie.',
    },
    vi: {
      title: 'THANH TOAN TAI QUAY',
      order: 'SO DON',
      total: 'TONG CONG',
      pay: 'Dua phieu nay cho thu ngan.',
      scan: 'Quet tai quay thu ngan.',
    },
    en: {
      title: 'PAY AT COUNTER',
      order: 'ORDER NUMBER',
      total: 'TOTAL',
      pay: 'Show this slip to the cashier.',
      scan: 'Scan at cashier.',
    },
  }[lang];
  const lines: EscPosPlainLine[] = [];
  const total = Math.max(
    0,
    Math.round(Number(data.totalGrosze) || data.items.reduce((sum, item) => sum + lineTotal(item), 0)),
  );

  lines.push({ text: pickupSlipBrandName(data), bold: true, center: true });
  lines.push({ text: copy.title, bold: true, center: true });
  lines.push({ text: copy.order, bold: true, center: true });
  lines.push({ text: number, bold: true, center: true, textSize: 'double-size' });
  if (fulfillment) {
    lines.push({ text: fulfillment, bold: true, center: true });
  }
  lines.push({ text: `${orderNumberLabel(data.orderNumber)}  ·  ${formatTimeHHMM(data.createdAt)}`, center: true });
  lines.push({ text: '', separator: true });

  for (const item of data.items) {
    const quantity = Math.max(1, Math.round(Number(item.quantity) || 1));
    const unitPrice = Math.max(0, Math.round(Number(item.unitPriceGrosze) || 0));
    lines.push({ text: `${quantity}x ${item.name}`, rightText: formatMoney(lineTotal(item)), bold: true });
    if (unitPrice > 0 && quantity > 1) {
      lines.push({ text: `   ${formatMoney(unitPrice)} / szt` });
    }
    const notes = (item.notes || '').trim();
    if (notes) {
      lines.push({ text: lang === 'vi' ? `   Ghi chu: ${notes}` : `   >> ${notes}` });
    }
  }

  lines.push({ text: '', separator: true, separatorChar: '=' });
  lines.push({ text: copy.total, rightText: formatMoney(total), bold: true, textSize: 'double-height' });
  if (data.qrPayload) {
    lines.push({ text: copy.scan, bold: true, center: true });
    lines.push({ text: '', qrData: data.qrPayload, qrSize: 5 });
  }
  lines.push({ text: copy.pay, center: true });
  lines.push({ text: '', separator: true });
  return lines;
}
