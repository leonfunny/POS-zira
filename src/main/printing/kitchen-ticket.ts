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

function formatTimeHHMM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
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

export function buildKitchenTicketLines(data: KitchenTicketData): EscPosPlainLine[] {
  const lines: EscPosPlainLine[] = [];

  lines.push({ text: '*** KUCHNIA ***', bold: true, center: true, textSize: 'double-size' });
  if (data.isReprint) {
    lines.push({ text: '(KOPIA / IN LAI)', bold: true, center: true });
  }
  lines.push({ text: `#${data.orderNumber}`, bold: true, center: true, textSize: 'double-size' });
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
      lines.push({ text: `   >> ${notes}` });
    }
  }

  lines.push({ text: '', separator: true });
  return lines;
}
