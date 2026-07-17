import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getHistoryDisplayNumber, getRealHistoryOrderNumber } from './order-fiscal-visibility';
import { translations } from '../../i18n/translations';
import { useConfig } from '../../hooks/useConfig';
import { describeFiscalError } from '../../lib/fiscal-error-text';
import { buildRefundRequest } from './refund-request';
import {
  getRemainingRefundableItems,
  getSafeRemainingTotal,
  hasRefundOverage,
} from './refund-quantities';
import {
  compareOrdersByDisplayTimeDesc,
  parseOrderTimestampMs,
} from './order-history-time';
import { deriveReceiptOutcome } from './receipt-outcome';
import {
  getRefundEvents,
  getItemRefundBreakdowns,
  type RefundBreakdownLine,
} from './refund-breakdown';
import ConfirmActionDialog from './ConfirmActionDialog';
import Modal from '../shared/Modal';
import { buildConfirmCopy, type ConfirmActionKind } from './confirm-action-copy';
import {
  calculateRefundLineAmount,
  getRefundLineUnitPrice,
} from './refund-line-amount';
import { calculateLineTotalGrosze, formatSaleQuantity, normalizeSaleUnit, normalizeSellBy } from '../../../shared/pos-sale';

interface OrderRow {
  id: string;
  order_number: string | null;
  status: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  payment_method: string | null;
  payment_amount: number;
  change_amount: number;
  staff_name: string | null;
  created_at: string;
  backend_id?: string | null;
  synced?: number;
  refund_amount?: number;
  refund_reason?: string | null;
  refunded_at?: string | null;
  refund_lines?: string | null;
  customer_nip?: string | null;
  customer_name?: string | null;
  payment_tenders?: string | null;
  sync_error?: string | null;
  sync_attempts?: number;
  has_fiscal?: number;
  _origin?: 'server';
}

interface OrderItemRow {
  id: string;
  order_id: string;
  variant_id?: string | null;
  name: string;
  sku: string | null;
  price: number;
  quantity: number;
  sale_quantity?: number | null;
  sale_unit?: string | null;
  sell_by?: string | null;
  total: number;
  vat_rate: number;
}

interface OrderHistoryModalProps {
  onClose: () => void;
  t: (key: string) => string;
}

type RefundStatus = 'none' | 'full' | 'partial';
type ReprintStatus = { type: 'ok' | 'error'; message: string } | null;
type RefundPanelCompleteOptions = { keepRefundOpen?: boolean };
type OrderConfirmAction = Extract<ConfirmActionKind, 'void' | 'cancel' | 'deleteLocal'>;
type PendingOrderConfirm = {
  action: OrderConfirmAction;
  order: OrderRow;
  isSynced?: boolean;
  onConfirm: () => Promise<void> | void;
};
type RefundSuccessSummary = {
  amount: number;
  lines: RefundBreakdownLine[];
  remainingTotal: number;
  hasRemainingItems: boolean;
  receiptPrinted: boolean;
  printWarning: string | null;
};

const PAGE_SIZE = 20;

const PAYMENT_METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'BLIK', label: 'BLIK' },
  { value: 'TRANSFER', label: 'Transfer' },
  { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
  { value: 'SPLIT', label: 'Split' },
  { value: 'INVOICE', label: 'Invoice' },
];

const REFUND_REASONS = [
  { key: 'customerRequest', fallback: 'Customer request' },
  { key: 'damaged', fallback: 'Damaged item' },
  { key: 'wrongItem', fallback: 'Wrong item' },
  { key: 'other', fallback: 'Other' },
];

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

function confirmCopyBaseKey(titleKey: string): string {
  return titleKey.endsWith('.title') ? titleKey.slice(0, -'.title'.length) : titleKey;
}

// ── Per-document print badges ─────────────────────────────────────────────
type PrintBadgeView = { tone: 'ok' | 'warn' | 'err' | 'idle'; text: string };
type Tr = (key: string, fallback: string) => string;

function orderPrintBadgeView(
  p: { name: string | null; target: string | null; status: string; route: string | null } | null,
  tr: Tr,
): PrintBadgeView {
  if (!p) return { tone: 'idle', text: tr('pos.history.notPrinted', 'Not printed') };
  const printer = [p.name, p.target].filter(Boolean).join(' · ') || tr('pos.history.printerGeneric', 'printer');
  if (p.status === 'PRINTED') return { tone: 'ok', text: printer };
  if (p.status === 'FAILED') return { tone: 'err', text: `${printer} — ${tr('pos.history.printFailed', 'failed')}` };
  return { tone: 'idle', text: tr('pos.history.notPrinted', 'Not printed') }; // NO_PRINTER
}

function fiscalPrintBadgeView(
  p: { status: string; name: string | null; target: string | null } | null,
  tr: Tr,
): PrintBadgeView {
  if (!p) return { tone: 'idle', text: tr('pos.history.notPrinted', 'Not printed') };
  const printer = [p.name, p.target].filter(Boolean).join(' · ') || 'Fiscal';
  switch (p.status) {
    case 'SUCCESS_CONFIRMED':
      return { tone: 'ok', text: printer };
    case 'FAILED_CONFIRMED':
      return { tone: 'err', text: `${printer} — ${tr('pos.history.printFailed', 'failed')}` };
    case 'UNKNOWN_NEEDS_RECONCILIATION':
    case 'SENT':
    case 'PENDING':
      return { tone: 'warn', text: `${printer} — ${tr('pos.history.needsCheck', 'needs check')}` };
    case 'BLOCKED_BY_SAFETY_GATE':
      return { tone: 'warn', text: `${printer} — ${tr('pos.history.blocked', 'blocked')}` };
    default:
      return { tone: 'idle', text: printer };
  }
}

function PrintBadge({ label, view }: { label: string; view: PrintBadgeView }) {
  const tone =
    view.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : view.tone === 'err' ? 'border-rose-200 bg-rose-50 text-rose-800'
    : view.tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : 'border-slate-200 bg-slate-50 text-slate-500';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 shrink-0 font-bold uppercase tracking-wide text-slate-400">{label}</span>
      <span className={`inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${tone}`}>
        {view.tone === 'ok' && <span aria-hidden="true">✓</span>}
        <span className="truncate">{view.text}</span>
      </span>
    </div>
  );
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseUtcDate(iso: string): Date {
  return new Date(parseOrderTimestampMs(iso));
}

function formatTime(iso: string): string {
  try {
    const d = parseUtcDate(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

function formatDate(iso: string): string {
  try {
    const d = parseUtcDate(iso);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  } catch {
    return '';
  }
}

function formatDateInput(value: string): string {
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
}

const PERIOD_LABELS: Record<string, string> = { today: 'Today', week: 'This Week', month: 'This Month', all: 'All Time' };

function periodToDateRange(period: string): { from: string; to: string } {
  const today = todayISO();
  switch (period) {
    case 'week': { const d = new Date(); d.setDate(d.getDate() - 7); return { from: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, to: today }; }
    case 'month': { const d = new Date(); d.setMonth(d.getMonth() - 1); return { from: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, to: today }; }
    case 'all': return { from: '2000-01-01', to: '2099-12-31' };
    default: return { from: today, to: today };
  }
}

function formatMoney(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

function formatMoneyInput(amount: number): string {
  return (amount / 100).toFixed(2);
}

function parseMoneyInput(value: string): number {
  const n = parseFloat(value.replace(',', '.'));
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
}

function toGrosze(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? Math.round(n * 100) : fallback;
}

type RefundFallbackLine = {
  name?: string;
  quantity: number;
  refundAmount: number;
  vatRate?: number;
  sku?: string;
  variantId?: string;
  unit?: string;
};

function getRefundSuccessLines(result: any, fallbackLines: RefundFallbackLine[]): RefundBreakdownLine[] {
  if (Array.isArray(result?.refundedLines) && result.refundedLines.length > 0) {
    return result.refundedLines
      .map((line: any): RefundBreakdownLine => {
        const variantId = line.variantId ?? line.variant_id ?? null;
        const sku = line.sku ?? null;
        const fallback = fallbackLines.find((candidate) => (
          (variantId && candidate.variantId === variantId)
          || (sku && candidate.sku === sku)
          || (line.name && candidate.name === line.name)
        ));
        return {
          orderItemId: line.orderItemId ?? line.order_item_id ?? null,
          variantId,
          sku: sku ?? fallback?.sku ?? null,
          name: String(line.name ?? fallback?.name ?? '').trim(),
          quantity: typeof line.quantity === 'number' ? line.quantity : parseFloat(String(line.quantity ?? '')) || 0,
          refundAmount: toGrosze(line.refundAmount),
          vatRate: line.taxRate ?? line.vatRate ?? fallback?.vatRate,
          unit: line.unit ?? line.saleUnit ?? line.sale_unit ?? fallback?.unit ?? null,
          saleUnit: line.saleUnit ?? line.sale_unit ?? line.unit ?? fallback?.unit ?? null,
          sellBy: line.sellBy ?? line.sell_by ?? null,
          restock: typeof line.restock === 'boolean' ? line.restock : undefined,
          refundedAt: line.refundedAt ?? line.refunded_at ?? null,
          refundRequestId: line.refundRequestId ?? line.refund_request_id ?? null,
        };
      })
      .filter((line: RefundBreakdownLine) => line.quantity > 0 && line.refundAmount > 0);
  }

  return fallbackLines.map((line): RefundBreakdownLine => ({
    variantId: line.variantId ?? null,
    sku: line.sku ?? null,
    name: line.name || '',
    quantity: line.quantity,
    refundAmount: Math.max(0, Math.round(Number(line.refundAmount) || 0)),
    vatRate: line.vatRate,
    unit: line.unit ?? null,
    saleUnit: line.unit ?? null,
  })).filter((line: RefundBreakdownLine) => line.quantity > 0 && line.refundAmount > 0);
}

function getRefundSuccessAmount(result: any, lines: RefundBreakdownLine[], fallbackAmount: number): number {
  if (result?.refundAmount != null) return toGrosze(result.refundAmount, fallbackAmount);
  const lineTotal = lines.reduce((sum, line) => sum + line.refundAmount, 0);
  return lineTotal > 0 ? lineTotal : fallbackAmount;
}

function createRefundRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `refund-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOrderLabel(order: OrderRow): string {
  return order.order_number || order.id.substring(0, 8);
}

function paymentLabel(method: string | null | undefined, t: (key: string) => string): string {
  switch (method) {
    case 'CASH': return tOr(t, 'pos.payment.cash', 'Cash');
    case 'CARD': return tOr(t, 'pos.payment.card', 'Card');
    case 'BLIK': return tOr(t, 'pos.payment.blik', 'BLIK');
    case 'TRANSFER':
    case 'BANK_TRANSFER':
      return tOr(t, 'pos.payment.transfer', 'Transfer');
    case 'SPLIT': return tOr(t, 'pos.payment.split', 'Split');
    case 'INVOICE': return tOr(t, 'pos.payment.invoice', 'Invoice');
    case 'CREDIT': return tOr(t, 'pos.payment.credit', 'Credit');
    default: return tOr(t, 'pos.history.unknown', 'Unknown');
  }
}

function localizeRefundReason(reason: string | null | undefined, t: (key: string) => string): string {
  const value = String(reason ?? '').trim();
  if (!value) return '-';
  for (const option of REFUND_REASONS) {
    const key = `pos.refund.${option.key}`;
    const isKnownTranslation = Object.values(translations).some((dictionary) => dictionary[key] === value);
    if (value === option.key || isKnownTranslation) return tOr(t, key, option.fallback);
  }
  return value;
}

function getRefundLineSellBy(line: Pick<RefundBreakdownLine, 'sellBy' | 'unit' | 'saleUnit'>): 'PIECE' | 'WEIGHT' {
  const unit = String(line.unit ?? line.saleUnit ?? '').trim().toLowerCase();
  return normalizeSellBy(line.sellBy ?? (unit === 'kg' ? 'WEIGHT' : 'PIECE'));
}

function displaySaleUnit(unit: string | null | undefined, sellBy: 'PIECE' | 'WEIGHT', t: (key: string) => string): string {
  const raw = String(unit ?? '').trim();
  if (sellBy === 'WEIGHT') return raw || 'kg';
  if (!raw || /^(szt\.?|pcs?|pieces?)$/i.test(raw)) return tOr(t, 'pos.numpad.unit', 'pcs');
  return raw;
}

function formatRefundLineQuantity(line: Pick<RefundBreakdownLine, 'quantity' | 'sellBy' | 'unit' | 'saleUnit'>, t: (key: string) => string): string {
  const sellBy = getRefundLineSellBy(line);
  return `${formatSaleQuantity(line.quantity, sellBy)} ${displaySaleUnit(line.unit ?? line.saleUnit, sellBy, t)}`;
}

function getRefundLineName(line: Pick<RefundBreakdownLine, 'name' | 'sku'>, t: (key: string) => string): string {
  return line.name || line.sku || tOr(t, 'pos.refund.unknownProduct', 'Unknown product');
}

function getRefundStatus(order: OrderRow): RefundStatus {
  if (order.status === 'REFUNDED') return 'full';
  if (order.status === 'PARTIAL_REFUND') return 'partial';
  const refundAmount = order.refund_amount ?? 0;
  if (refundAmount >= order.total && order.total > 0) return 'full';
  if (refundAmount > 0) return 'partial';
  return 'none';
}

// Catches both shapes: server orders use payment_method='SPLIT' literal,
// local orders save the primary tender (CASH/CARD/etc.) with details in
// payment_tenders JSON. The filter dropdown's "Split" option needs to match
// both — equality alone misses local splits.
function isSplit(order: OrderRow): boolean {
  if (order.payment_method === 'SPLIT') return true;
  try {
    const t = order.payment_tenders ? JSON.parse(order.payment_tenders) : null;
    return Array.isArray(t) && t.length > 1;
  } catch {
    return false;
  }
}

function normalizePaymentMethod(method: string | null | undefined): string | null {
  if (!method) return null;
  return method === 'TRANSFER' ? 'BANK_TRANSFER' : method;
}

function orderMatchesPaymentFilter(order: OrderRow, paymentMethod: string): boolean {
  const split = isSplit(order);
  if (paymentMethod === 'SPLIT') return split;
  if (paymentMethod === 'INVOICE') return Boolean(order.customer_nip);
  return !split && normalizePaymentMethod(order.payment_method) === normalizePaymentMethod(paymentMethod);
}

function StatusBadge({ order, t }: { order: OrderRow; t: (key: string) => string }) {
  const refundStatus = getRefundStatus(order);

  if (refundStatus === 'full') {
    return (
      <span className="inline-flex h-7 items-center rounded-full border border-red-200 bg-red-50 px-2.5 text-xs font-bold text-red-700">
        {tOr(t, 'pos.history.refunded', 'Refunded')}
      </span>
    );
  }

  if (refundStatus === 'partial') {
    return (
      <span className="inline-flex h-7 items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 text-xs font-bold text-amber-800">
        {tOr(t, 'pos.history.partialRefund', 'Partial refund')}
      </span>
    );
  }

  return (
    <span className="inline-flex h-7 items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-bold text-emerald-700">
      {tOr(t, 'pos.history.completed', 'Completed')}
    </span>
  );
}

function DialogShell({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-3" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="flex h-[calc(100vh-24px)] max-h-[860px] w-[calc(100vw-24px)] max-w-[1180px] flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      aria-label="Close"
      className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
    >
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );
}

function RefundPanel({
  order,
  items,
  currency,
  t,
  onCancel,
  onComplete,
}: {
  order: OrderRow;
  items: OrderItemRow[];
  currency: string;
  t: (key: string) => string;
  onCancel: () => void;
  onComplete: (options?: RefundPanelCompleteOptions) => void;
}) {
  const [refundType, setRefundType] = useState<'FULL' | 'PARTIAL'>('FULL');
  const [selectedQtys, setSelectedQtys] = useState<Record<string, number>>({});
  const [weightQtyDrafts, setWeightQtyDrafts] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState('customerRequest');
  const [customReason, setCustomReason] = useState('');
  const [confirmStep, setConfirmStep] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successSummary, setSuccessSummary] = useState<RefundSuccessSummary | null>(null);
  const [reprintingRefundReceipt, setReprintingRefundReceipt] = useState(false);
  const [refundReprintStatus, setRefundReprintStatus] = useState<ReprintStatus>(null);
  const refundRequestIdRef = useRef<string | null>(null);

  const resetRefundRequestId = () => {
    refundRequestIdRef.current = null;
  };

  const remainingTotal = getSafeRemainingTotal(order);
  const refundOverage = hasRefundOverage(order);
  const refundableResult = getRemainingRefundableItems(order, items);
  const refundableItems = refundableResult.items;
  const refundBlockedByMissingLines = refundableResult.unsafeMissingRefundLines;
  const refundBreakdownById = useMemo(
    () => new Map(getItemRefundBreakdowns(order, items).map((entry) => [entry.item.id, entry])),
    [order, items],
  );
  const getRefundAmountItem = (item: typeof refundableItems[number]) => {
    const breakdown = refundBreakdownById.get(item.id);
    return {
      price: item.price,
      quantity: item.maxQty,
      total: breakdown?.remainingAmount ?? item.total,
      sell_by: item.sell_by,
    };
  };

  const selectedRefundLines = refundableItems
    .filter(item => (selectedQtys[item.id] ?? 0) > 0)
    .map(item => {
      const refundAmountItem = getRefundAmountItem(item);
      return {
        variantId: item.variant_id ?? undefined,
        sku: item.sku ?? undefined,
        name: item.name,
        quantity: selectedQtys[item.id],
        unit: normalizeSaleUnit({ sale_unit: item.sale_unit, sellBy: normalizeSellBy(item.sell_by) }),
        unitPrice: getRefundLineUnitPrice(refundAmountItem),
        refundAmount: calculateRefundLineAmount(refundAmountItem, selectedQtys[item.id]),
        restock,
        vatRate: item.vat_rate,
      };
    });

  const computedRefundTotal = refundType === 'FULL'
    ? remainingTotal
    : selectedRefundLines.reduce((sum, l) => sum + l.refundAmount, 0);

  const isValid = !refundOverage && !refundBlockedByMissingLines && (refundType === 'FULL'
    ? remainingTotal > 0 && refundableItems.some(item => item.maxQty > 0)
    : selectedRefundLines.length > 0 && computedRefundTotal > 0)
    && (reason !== 'other' || customReason.trim().length > 0);

  const setType = (next: 'FULL' | 'PARTIAL') => {
    resetRefundRequestId();
    setRefundType(next);
    setConfirmStep(false);
    setError(null);
    if (next === 'FULL') {
      const allQtys: Record<string, number> = {};
      refundableItems.forEach(item => { allQtys[item.id] = item.maxQty; });
      setSelectedQtys(allQtys);
    } else {
      setSelectedQtys({});
    }
    setWeightQtyDrafts({});
  };

  const setItemQty = (itemId: string, qty: number, max: number) => {
    resetRefundRequestId();
    setSelectedQtys(prev => ({ ...prev, [itemId]: Math.max(0, Math.min(qty, max)) }));
    setConfirmStep(false);
    setError(null);
  };

  const setWeightItemQtyDraft = (itemId: string, rawValue: string, max: number) => {
    const draft = rawValue.trim();
    if (!/^\d*(?:[.,]\d{0,3})?$/.test(draft)) return;

    const normalized = draft.replace(',', '.');
    const parsed = normalized === '' || normalized === '.' ? 0 : Number(normalized);
    if (!Number.isFinite(parsed)) return;

    const bounded = Math.max(0, Math.min(parsed, max));
    setWeightQtyDrafts((previous) => ({
      ...previous,
      [itemId]: parsed > max ? formatSaleQuantity(max, 'WEIGHT') : draft,
    }));
    setItemQty(itemId, bounded, max);
  };

  const commitWeightItemQtyDraft = (itemId: string) => {
    const quantity = selectedQtys[itemId] ?? 0;
    setWeightQtyDrafts((previous) => ({
      ...previous,
      [itemId]: quantity > 0 ? formatSaleQuantity(quantity, 'WEIGHT') : '',
    }));
  };

  const handleConfirm = async () => {
    if (!isValid || loading) return;
    if (!confirmStep) { setConfirmStep(true); return; }

    setLoading(true);
    setError(null);
    setRefundReprintStatus(null);
    try {
      const reasonText = reason === 'other' && customReason.trim()
        ? customReason.trim()
        : tOr(t, `pos.refund.${reason}`, reason);
      let refundItems = selectedRefundLines as any[];
      if (refundType === 'FULL') {
        refundItems = refundableItems.filter(item => item.maxQty > 0).map(item => {
          const refundAmountItem = getRefundAmountItem(item);
          return {
            variantId: item.variant_id ?? undefined,
            sku: item.sku ?? undefined,
            name: item.name,
            quantity: item.maxQty,
            unit: normalizeSaleUnit({ sale_unit: item.sale_unit, sellBy: normalizeSellBy(item.sell_by) }),
            unitPrice: getRefundLineUnitPrice(refundAmountItem),
            refundAmount: calculateRefundLineAmount(refundAmountItem, item.maxQty),
            restock,
            vatRate: item.vat_rate,
          };
        });
      }
      const refundRequestId = refundRequestIdRef.current ?? createRefundRequestId();
      refundRequestIdRef.current = refundRequestId;

      const result = await window.electronAPI.pos.orders.refund(order.id, buildRefundRequest({
        type: refundType,
        refundRequestId,
        reason: reasonText,
        computedRefundTotal,
        lines: refundItems,
      }));
      if (result.success) {
        resetRefundRequestId();
        const refundLines = getRefundSuccessLines(result, refundItems);
        const refundAmount = getRefundSuccessAmount(result, refundLines, computedRefundTotal);
        const outcome = deriveReceiptOutcome(result, t);
        const hasRemainingItems = refundType === 'PARTIAL' && refundableItems.some(
          (item) => item.maxQty - (selectedQtys[item.id] ?? 0) > 0.000001,
        );
        setSuccessSummary({
          amount: refundAmount,
          lines: refundLines,
          remainingTotal: Math.max(0, remainingTotal - refundAmount),
          hasRemainingItems,
          receiptPrinted: outcome.receiptPrinted,
          printWarning: outcome.warning,
        });
      } else if ((result as any).mutationDetected || (result as any).requiresRefresh) {
        resetRefundRequestId();
        onComplete();
      } else {
        setError(result.error || 'Refund failed');
        setConfirmStep(false);
      }
    } catch (e: any) {
      setError(e.message || 'Refund failed');
      setConfirmStep(false);
    } finally {
      setLoading(false);
    }
  };

  const handlePrintRefundReceipt = async () => {
    if (reprintingRefundReceipt) return;
    setReprintingRefundReceipt(true);
    setRefundReprintStatus(null);
    try {
      const result = await window.electronAPI.pos.payment.printRefundReceipt(order.id);
      const outcome = deriveReceiptOutcome(result, t);
      if (outcome.receiptPrinted) {
        setSuccessSummary(prev => prev ? { ...prev, receiptPrinted: true, printWarning: null } : prev);
        setRefundReprintStatus({ type: 'ok', message: tOr(t, 'pos.history.reprinted', 'Receipt sent to printer') });
      } else {
        setRefundReprintStatus({ type: 'error', message: outcome.warning || tOr(t, 'pos.history.reprintFailed', 'Printer not connected') });
      }
    } catch (e: any) {
      setRefundReprintStatus({ type: 'error', message: e?.message || tOr(t, 'pos.history.reprintFailed', 'Printer not connected') });
    } finally {
      setReprintingRefundReceipt(false);
    }
  };

  if (successSummary) {
    const canRefundMore = successSummary.remainingTotal > 0 && successSummary.hasRemainingItems;
    return (
      <Modal
        title={tOr(t, 'pos.refund.success', 'Refund processed')}
        onClose={() => onComplete()}
        size="full"
        zLayer="nested"
        busy={reprintingRefundReceipt}
        closeLabel={tOr(t, 'pos.refund.close', 'Close')}
        panelClassName="sm:max-w-[760px]"
        bodyClassName="bg-slate-50 p-5"
      >
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5">
          <div className="text-xs font-bold uppercase tracking-wide text-emerald-700">
            {tOr(t, 'pos.refund.refundedNow', 'Refunded now')}
          </div>
          <div className="mt-2 text-3xl font-extrabold tabular-nums text-emerald-900">-{formatMoney(successSummary.amount, currency)}</div>
        </div>

        {successSummary.lines.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-600">
              {tOr(t, 'pos.refund.refundedItems', 'Refunded items')}
            </div>
            <div className="divide-y divide-slate-100">
              {successSummary.lines.map((line, index) => (
                <div key={`${line.variantId || line.sku || line.name}-${index}`} className="grid grid-cols-[minmax(0,1fr)_120px_130px] items-center gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="whitespace-normal break-words text-sm font-bold text-slate-950">{getRefundLineName(line, t)}</div>
                    {line.sku && <div className="mt-1 text-xs font-medium text-slate-500">{line.sku}</div>}
                  </div>
                  <div className="text-right text-sm font-bold tabular-nums text-slate-700">
                    {formatRefundLineQuantity(line, t)}
                  </div>
                  <div className="text-right text-sm font-extrabold tabular-nums text-red-700">
                    -{formatMoney(line.refundAmount, currency)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3">
          <span className="text-sm font-bold text-slate-600">{tOr(t, 'pos.history.remainingTotal', 'Remaining')}</span>
          <span className="text-xl font-extrabold tabular-nums text-slate-950">{formatMoney(successSummary.remainingTotal, currency)}</span>
        </div>

        <div
          className={`mt-4 rounded-lg border px-4 py-3 text-sm font-bold ${
            successSummary.receiptPrinted
              ? 'border-emerald-200 bg-white text-emerald-800'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          {successSummary.receiptPrinted
            ? tOr(t, 'pos.history.reprinted', 'Receipt sent to printer')
            : successSummary.printWarning || tOr(t, 'pos.history.reprintFailed', 'Printer not connected')}
        </div>

        {!successSummary.receiptPrinted && (
          <button
            onClick={handlePrintRefundReceipt}
            disabled={reprintingRefundReceipt}
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg border border-amber-300 bg-white px-4 text-sm font-extrabold text-amber-800 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reprintingRefundReceipt
              ? tOr(t, 'pos.refund.sending', 'Sending...')
              : tOr(t, 'pos.refund.printReceipt', 'Print refund receipt')}
          </button>
        )}

        {refundReprintStatus && (
          <div
            className={`mt-3 rounded-md border px-3 py-2 text-xs font-bold ${
              refundReprintStatus.type === 'ok'
                ? 'border-emerald-200 bg-white text-emerald-800'
                : 'border-red-200 bg-red-50 text-red-800'
            }`}
          >
            {refundReprintStatus.message}
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 gap-3">
          {canRefundMore && (
            <button
              onClick={() => onComplete({ keepRefundOpen: true })}
              className="min-h-11 rounded-lg border border-emerald-300 bg-white px-4 text-sm font-extrabold text-emerald-800 hover:bg-emerald-50"
            >
              {tOr(t, 'pos.refund.refundNext', 'Refund next')}
            </button>
          )}
          <button
            onClick={() => onComplete()}
            className={`${canRefundMore ? '' : 'col-span-2'} min-h-11 rounded-lg bg-emerald-700 px-4 text-sm font-extrabold text-white hover:bg-emerald-800`}
          >
            {tOr(t, 'pos.refund.close', 'Close')}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={tOr(t, 'pos.refund.title', 'Refund Order')}
      onClose={() => { resetRefundRequestId(); onCancel(); }}
      size="full"
      zLayer="nested"
      busy={loading}
      closeLabel={tOr(t, 'pos.cancel', 'Cancel')}
      panelClassName="sm:max-w-[820px]"
      bodyClassName="bg-slate-50 p-5"
      keyboardAware
    >
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-500">{tOr(t, 'pos.history.originalTotal', 'Original total')}</div>
          <div className="mt-2 text-xl font-extrabold tabular-nums text-slate-950">{formatMoney(order.total, currency)}</div>
        </div>
        <div className="rounded-lg border border-red-200 bg-white p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-red-600">{tOr(t, 'pos.history.refundedTotal', 'Refunded')}</div>
          <div className="mt-2 text-xl font-extrabold tabular-nums text-red-700">-{formatMoney(order.refund_amount ?? 0, currency)}</div>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-amber-700">{tOr(t, 'pos.refund.maximum', 'Maximum')}</div>
          <div className="mt-2 text-xl font-extrabold tabular-nums text-amber-900">{formatMoney(remainingTotal, currency)}</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <button onClick={() => setType('FULL')}
          className={`min-h-14 rounded-lg border px-4 text-left text-sm font-extrabold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200 ${
            refundType === 'FULL' ? 'border-red-600 bg-red-600 text-white' : 'border-slate-300 bg-white text-slate-800 hover:border-red-300 hover:bg-red-50'
          }`}>
          <span className="block">{tOr(t, 'pos.refund.full', 'Full Refund')}</span>
          <span className="mt-0.5 block text-xs opacity-85">{formatMoney(remainingTotal, currency)}</span>
        </button>
        <button onClick={() => setType('PARTIAL')}
          className={`min-h-14 rounded-lg border px-4 text-left text-sm font-extrabold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 ${
            refundType === 'PARTIAL' ? 'border-amber-500 bg-amber-500 text-white' : 'border-slate-300 bg-white text-slate-800 hover:border-amber-300 hover:bg-amber-50'
          }`}>
          <span className="block">{tOr(t, 'pos.refund.partial', 'Partial Refund')}</span>
          <span className="mt-0.5 block text-xs opacity-85">{tOr(t, 'pos.refund.selectItems', 'Select items')}</span>
        </button>
      </div>

      <section className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-4 py-3">
          <div className="text-xs font-bold uppercase tracking-wide text-slate-600">{tOr(t, 'pos.refund.selectItemsTitle', 'Items to refund')}</div>
          <div className="text-xs font-bold text-slate-500">{refundableItems.filter((item) => item.maxQty > 0).length}</div>
        </div>
        <div className="divide-y divide-slate-100">
          {refundableItems.filter((item) => item.maxQty > 0).map(item => {
            const qty = selectedQtys[item.id] ?? 0;
            const sellBy = normalizeSellBy(item.sell_by);
            const unit = normalizeSaleUnit({ sale_unit: item.sale_unit, sellBy });
            const refundAmountItem = getRefundAmountItem(item);
            const effectiveQty = refundType === 'FULL' ? item.maxQty : qty;
            return (
              <div key={item.id} className="grid min-h-[72px] grid-cols-[minmax(0,1fr)_170px_120px] items-center gap-4 px-4 py-3">
                <div className="min-w-0">
                  <div className="whitespace-normal break-words text-sm font-bold leading-5 text-slate-950">{item.name}</div>
                  <div className="mt-1 text-xs font-medium text-slate-500">
                    {item.sku ? `${item.sku} · ` : ''}{formatMoney(getRefundLineUnitPrice(refundAmountItem), currency)} / {displaySaleUnit(unit, sellBy, t)} · {tOr(t, 'pos.refund.available', 'Available')} {formatSaleQuantity(item.maxQty, sellBy)} {displaySaleUnit(unit, sellBy, t)}
                  </div>
                </div>
                {refundType === 'FULL' ? (
                  <div className="text-right text-sm font-extrabold tabular-nums text-slate-800">
                    {formatSaleQuantity(item.maxQty, sellBy)} {displaySaleUnit(unit, sellBy, t)}
                  </div>
                ) : sellBy === 'WEIGHT' ? (
                  <input
                    value={weightQtyDrafts[item.id] ?? (qty > 0 ? formatSaleQuantity(qty, sellBy) : '')}
                    onChange={(e) => setWeightItemQtyDraft(item.id, e.target.value, item.maxQty)}
                    onBlur={() => commitWeightItemQtyDraft(item.id)}
                    inputMode="decimal"
                    aria-label={`${tOr(t, 'pos.refund.quantity', 'Quantity')} ${item.name}`}
                    className="ml-auto h-11 w-28 rounded-md border border-slate-300 bg-white px-3 text-right text-sm font-extrabold tabular-nums text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  />
                ) : (
                  <div className="ml-auto flex items-center gap-2">
                    <button onClick={() => setItemQty(item.id, qty - 1, item.maxQty)}
                      disabled={qty <= 0}
                      className="w-11 h-11 rounded-md border border-slate-300 bg-white text-slate-700 font-bold text-lg disabled:opacity-30 hover:bg-slate-50">
                      -
                    </button>
                    <span className="w-10 text-center text-sm font-extrabold tabular-nums">{qty}</span>
                    <button onClick={() => setItemQty(item.id, qty + 1, item.maxQty)}
                      disabled={qty >= item.maxQty}
                      className="w-11 h-11 rounded-md border border-slate-300 bg-white text-slate-700 font-bold text-lg disabled:opacity-30 hover:bg-slate-50">
                      +
                    </button>
                  </div>
                )}
                <div className="text-right text-sm font-extrabold tabular-nums text-slate-950">
                  {effectiveQty > 0 ? formatMoney(calculateRefundLineAmount(refundAmountItem, effectiveQty), currency) : '-'}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {refundOverage && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-bold text-red-800">
          {tOr(t, 'pos.refund.overageBlocked', 'Refund data exceeds the order total. Further refunds are blocked.')}
        </div>
      )}

      {refundBlockedByMissingLines && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
          {tOr(t, 'pos.refund.missingDetailsBlocked', 'Refund details are incomplete. Refresh the order before refunding again.')}
        </div>
      )}

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)] gap-4 rounded-lg border border-slate-200 bg-white p-4">
        <div>
          <label htmlFor="refund-reason" className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-600">
            {tOr(t, 'pos.refund.reason', 'Reason')}
          </label>
          <select id="refund-reason" value={reason}
            onChange={(e) => { resetRefundRequestId(); setReason(e.target.value); setCustomReason(''); setConfirmStep(false); setError(null); }}
            className="h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100">
            {REFUND_REASONS.map((r) => (
              <option key={r.key} value={r.key}>{tOr(t, `pos.refund.${r.key}`, r.fallback)}</option>
            ))}
          </select>
        </div>
        <label className="flex min-h-12 cursor-pointer items-center gap-3 self-end rounded-lg border border-slate-200 bg-slate-50 px-4 text-sm font-bold text-slate-700">
          <input type="checkbox" checked={restock} onChange={e => { resetRefundRequestId(); setRestock(e.target.checked); }}
            className="h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand-200" />
          {tOr(t, 'pos.refund.restock', 'Restock items to inventory')}
        </label>
      </div>

      {reason === 'other' && (
        <div className="mt-3">
          <textarea
            value={customReason}
            onChange={(e) => { resetRefundRequestId(); setCustomReason(e.target.value); setConfirmStep(false); setError(null); }}
            placeholder={tOr(t, 'pos.refund.otherPlaceholder', 'Describe the reason...')}
            maxLength={200}
            className="min-h-[80px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
          <div className="mt-1 text-right text-xs font-medium text-slate-400">
            {customReason.length}/200
          </div>
        </div>
      )}

      {confirmStep && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-bold text-red-800">
          {tOr(t, 'pos.refund.confirmAsk', 'Are you sure?')} · {tOr(t, 'pos.refund.amount', 'Refund amount')}: {formatMoney(computedRefundTotal, currency)} · {restock
            ? tOr(t, 'pos.refund.willRestock', 'Items will be restocked')
            : tOr(t, 'pos.refund.willNotRestock', 'Items will not be restocked')}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-300 bg-white px-3 py-3 text-sm font-bold text-red-800">{error}</div>
      )}

      <div className="mt-5 grid grid-cols-[160px_minmax(0,1fr)] gap-3">
        <button
          onClick={() => { resetRefundRequestId(); onCancel(); }}
          disabled={loading}
          className="min-h-12 rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {tOr(t, 'pos.cancel', 'Cancel')}
        </button>
        <button onClick={handleConfirm} disabled={!isValid || loading}
          className={`flex min-h-12 items-center justify-center rounded-lg px-4 text-sm font-extrabold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200 ${
            loading ? 'cursor-not-allowed bg-slate-200 text-slate-500'
              : confirmStep ? 'bg-red-700 text-white hover:bg-red-800'
              : 'bg-red-600 text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500'
          }`}>
          {loading
            ? tOr(t, 'pos.refund.processing', 'Processing...')
            : confirmStep
              ? `${tOr(t, 'pos.refund.confirm', 'Confirm Refund')} (${formatMoney(computedRefundTotal, currency)})`
              : `${tOr(t, 'pos.refund.review', 'Review refund')} (${formatMoney(computedRefundTotal, currency)})`}
        </button>
      </div>
    </Modal>
  );
}

function SyncFailurePanel({
  order,
  onRetried,
  t,
}: {
  order: OrderRow;
  onRetried: () => void;
  t: (key: string) => string;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryResult, setRetryResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const err = order.sync_error;
  const isShelved = order.synced === -1;
  const isStockError = err ? /insufficient stock/i.test(err) : false;

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryResult(null);
    try {
      const res = await window.electronAPI.pos.orders.retrySync(order.id);
      if (res.success && res.result?.status === 'synced') {
        setRetryResult({ ok: true, msg: 'Order synced successfully' });
        setTimeout(onRetried, 400);
      } else {
        const errMsg = res.result?.error || res.error || 'Retry failed — check backend stock';
        setRetryResult({ ok: false, msg: errMsg });
      }
    } catch (e: any) {
      setRetryResult({ ok: false, msg: e.message || 'Retry failed' });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 space-y-2">
      <div className="flex items-start gap-2">
        <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <div className="flex-1 text-sm">
          <div className="font-bold text-amber-900">
            {isShelved ? (isStockError ? 'Backend rejected: insufficient stock' : 'Sync failed') : 'Order not synced yet'}
          </div>
          {err && (
            <div className="mt-1 text-amber-800 font-medium break-words">{err}</div>
          )}
          {isStockError && (
            <div className="mt-2 text-xs text-amber-700 font-medium">
              Fix backend stock first, then click Retry. Refund/cancel unavailable until synced.
            </div>
          )}
        </div>
      </div>
      {isShelved && (
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="w-full flex items-center justify-center gap-2 rounded-md border border-amber-400 bg-white px-3 py-2 text-sm font-bold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
        >
          {retrying ? 'Retrying...' : 'Retry sync'}
        </button>
      )}
      {retryResult && (
        <div className={`text-xs font-bold ${retryResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>
          {retryResult.msg}
        </div>
      )}
    </div>
  );
}

function ServerActionsPanel({
  order,
  t,
  onOrderUpdated,
  ensureMirrored,
  isMirroring = false,
}: {
  order: OrderRow & { customer_nip?: string | null };
  t: (key: string) => string;
  onOrderUpdated: () => void;
  ensureMirrored?: () => Promise<boolean>;
  isMirroring?: boolean;
}) {
  const [nip, setNip] = useState((order as any).customer_nip || '');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: 'ok' | 'error'; message: string } | null>(null);
  const [gusPreview, setGusPreview] = useState<{ name?: string; address?: string } | null>(null);

  const hasInvoice = Boolean((order as any).customer_nip);
  const kind: 'receipt' | 'invoice' = hasInvoice ? 'invoice' : 'receipt';

  const run = async (key: string, fn: () => Promise<{ success: boolean; error?: string; message?: string }>) => {
    if (busy) return;
    setBusy(key);
    setStatus(null);
    try {
      const res = await fn();
      if (res.success) {
        setStatus({ type: 'ok', message: res.message || tOr(t, 'pos.history.server.ok', 'Done') });
      } else {
        setStatus({ type: 'error', message: res.error || 'Failed' });
      }
    } catch (e: any) {
      setStatus({ type: 'error', message: e?.message || 'Failed' });
    } finally {
      setBusy(null);
    }
  };

  const handleDownload = async () => {
    if (ensureMirrored && !(await ensureMirrored())) return;
    run('download', async () => {
      const res = await window.electronAPI.pos.orders.downloadPdf(order.id, kind, 'VAT');
      return res.success
        ? { success: true, message: tOr(t, 'pos.history.server.pdfSaved', 'PDF saved') }
        : { success: false, error: res.error };
    });
  };

  const handleLookupNip = () =>
    run('nip', async () => {
      const res = await window.electronAPI.pos.customers.lookupNip(nip);
      if (!res.success) return { success: false, error: res.error };
      const gus = res.data?.gusData || res.data?.customer || null;
      if (gus) setGusPreview({ name: gus.name, address: gus.address });
      return { success: true, message: tOr(t, 'pos.history.server.nipFound', 'Company found') };
    });

  const handleAddInvoice = async () => {
    if (ensureMirrored && !(await ensureMirrored())) return;
    run('invoice', async () => {
      const res = await window.electronAPI.pos.orders.addInvoice(order.id, { customerNip: nip, invoiceType: 'VAT' });
      if (res.success) onOrderUpdated();
      return res.success
        ? { success: true, message: tOr(t, 'pos.history.server.invoiceAdded', 'Invoice attached') }
        : { success: false, error: res.error };
    });
  };

  const handleProforma = async () => {
    if (ensureMirrored && !(await ensureMirrored())) return;
    run('proforma', async () => {
      const res = await window.electronAPI.pos.orders.generateProforma(order.id);
      if (res.success) onOrderUpdated();
      return res.success
        ? { success: true, message: tOr(t, 'pos.history.server.proformaOk', 'Proforma generated') }
        : { success: false, error: res.error };
    });
  };

  const nipDigits = nip.replace(/\D/g, '');
  const nipValid = nipDigits.length === 10;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-extrabold text-slate-900">{tOr(t, 'pos.history.server.title', 'Server documents')}</h3>
      <p className="mt-1 text-xs font-medium text-slate-500">
        {tOr(t, 'pos.history.server.subtitle', 'Actions performed on the server for this order.')}
      </p>

      <button
        onClick={handleDownload}
        disabled={busy !== null || isMirroring}
        className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-800 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
      >
        {busy === 'download' ? '...' : tOr(t, hasInvoice ? 'pos.history.server.downloadInvoice' : 'pos.history.server.downloadReceipt', hasInvoice ? 'Download Invoice PDF' : 'Download Receipt PDF')}
      </button>

      {!hasInvoice && (
        <div className="mt-4 border-t border-slate-200 pt-3">
          <label className="block text-xs font-bold uppercase tracking-wide text-slate-500">
            {tOr(t, 'pos.history.server.nipLabel', 'Add VAT invoice (NIP)')}
          </label>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={nip}
              onChange={(e) => { setNip(e.target.value); setGusPreview(null); }}
              placeholder="10 digits"
              className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
            <button
              onClick={handleLookupNip}
              disabled={!nipValid || busy !== null || isMirroring}
              className="h-11 shrink-0 rounded-lg border border-slate-300 bg-slate-50 px-3 text-xs font-extrabold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'nip' ? '...' : 'GUS'}
            </button>
          </div>

          {gusPreview && (
            <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              <div className="font-bold text-slate-900">{gusPreview.name}</div>
              {gusPreview.address && <div>{gusPreview.address}</div>}
            </div>
          )}

          <button
            onClick={handleAddInvoice}
            disabled={!nipValid || busy !== null || isMirroring}
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg bg-brand-600 px-4 text-sm font-extrabold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
          >
            {busy === 'invoice' ? '...' : tOr(t, 'pos.history.server.attachInvoice', 'Attach invoice')}
          </button>
        </div>
      )}

      <button
        onClick={handleProforma}
        disabled={busy !== null || isMirroring}
        className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-800 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
      >
        {busy === 'proforma' ? '...' : tOr(t, 'pos.history.server.proforma', 'Generate Proforma')}
      </button>

      {status && (
        <div
          className={`mt-3 rounded-lg border px-3 py-2 text-xs font-bold ${
            status.type === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {status.message}
        </div>
      )}
    </section>
  );
}

function OrderMutationPanel({
  order,
  items,
  currency,
  t,
  onUpdated,
  ensureMirrored,
  isMirroring,
  onRequestConfirm,
}: {
  order: OrderRow;
  items: OrderItemRow[];
  currency: string;
  t: (key: string) => string;
  onUpdated: (closed?: boolean) => void;
  ensureMirrored: () => Promise<boolean>;
  isMirroring: boolean;
  onRequestConfirm: (request: PendingOrderConfirm) => void;
}) {
  const [paymentMethod, setPaymentMethod] = useState(order.payment_method || 'CASH');
  const [paidText, setPaidText] = useState(formatMoneyInput(order.payment_amount || order.total));
  const [changeText, setChangeText] = useState(formatMoneyInput(order.change_amount || 0));
  const [reason, setReason] = useState('');
  const [draftItems, setDraftItems] = useState(() => items.map((item) => ({
    ...item,
    priceText: formatMoneyInput(item.price),
    quantityText: String(item.quantity),
  })));
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<ReprintStatus>(null);

  useEffect(() => {
    setPaymentMethod(order.payment_method || 'CASH');
    setPaidText(formatMoneyInput(order.payment_amount || order.total));
    setChangeText(formatMoneyInput(order.change_amount || 0));
    setDraftItems(items.map((item) => ({
      ...item,
      priceText: formatMoneyInput(item.price),
      quantityText: String(item.quantity),
    })));
    setReason('');
    setStatus(null);
  }, [order.id, order.payment_method, order.payment_amount, order.change_amount, order.total, items]);

  const isSynced = Boolean(order.backend_id);
  const isFinal = order.status === 'REFUNDED' || order.status === 'PARTIAL_REFUND' || order.status === 'CANCELLED';
  const reasonRequired = isSynced;
  const canSubmit = !isFinal && !isMirroring && (!reasonRequired || reason.trim().length >= 3);

  const runMutation = async (key: string, payload: any) => {
    if (busy || !canSubmit) return;
    if (!(await ensureMirrored())) return;
    setBusy(key);
    setStatus(null);
    try {
      const result = await window.electronAPI.pos.orders.mutate(order.id, {
        ...payload,
        reason: reason.trim() || undefined,
      });
      if (!result?.success) {
        setStatus({ type: 'error', message: result?.error || 'Order update failed' });
        return;
      }
      setStatus({ type: 'ok', message: result.localOnly ? 'Local order updated' : 'Server order updated' });
      onUpdated(payload.type === 'void');
    } catch (err: any) {
      setStatus({ type: 'error', message: err?.message || 'Order update failed' });
    } finally {
      setBusy(null);
    }
  };

  const savePayment = () => runMutation('payment', {
    type: 'payment',
    paymentMethod,
    paymentAmount: parseMoneyInput(paidText),
    changeAmount: parseMoneyInput(changeText),
  });

  const saveItems = () => runMutation('items', {
    type: 'items',
    paymentMethod,
    paymentAmount: parseMoneyInput(paidText),
    changeAmount: parseMoneyInput(changeText),
    items: draftItems.map((item) => ({
      id: item.id,
      variant_id: item.variant_id,
      name: item.name,
      sku: item.sku,
      price: parseMoneyInput(item.priceText),
      quantity: Math.max(0, parseFloat(item.quantityText.replace(',', '.')) || 0),
      sale_quantity: Math.max(0, parseFloat(item.quantityText.replace(',', '.')) || 0),
      sale_unit: item.sale_unit ?? null,
      sell_by: item.sell_by ?? 'PIECE',
      vat_rate: item.vat_rate,
    })).filter((item) => item.quantity > 0),
  });

  const voidOrder = () => {
    if (busy || !canSubmit) return;
    onRequestConfirm({
      action: 'void',
      order,
      isSynced,
      onConfirm: () => runMutation('void', { type: 'void', restock: true }),
    });
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-extrabold text-slate-900">Edit order</h3>
      <p className="mt-1 text-xs font-medium text-slate-500">
        {isSynced ? 'Synced orders are updated through the server.' : 'Unsynced local orders are updated in local database.'}
      </p>

      {isFinal && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
          Refunded or cancelled orders are read-only.
        </div>
      )}

      <label className="mt-3 block text-xs font-bold uppercase tracking-wide text-slate-500">
        Reason {reasonRequired ? '' : '(optional)'}
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={isSynced ? 'Required for server audit' : 'Reason'}
          disabled={isFinal || busy !== null}
          className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 disabled:bg-slate-100 disabled:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </label>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
          Method
          <select
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value)}
            disabled={isFinal || busy !== null}
            className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm font-bold text-slate-900 disabled:bg-slate-100 disabled:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
          >
            {PAYMENT_METHODS.filter((method) => method.value !== 'SPLIT').map((method) => (
              <option key={method.value} value={method.value}>{method.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
          Paid
          <input
            value={paidText}
            onChange={(e) => setPaidText(e.target.value)}
            inputMode="decimal"
            disabled={isFinal || busy !== null}
            className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-right text-sm font-bold tabular-nums text-slate-900 disabled:bg-slate-100 disabled:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </label>
      </div>
      <label className="mt-2 block text-xs font-bold uppercase tracking-wide text-slate-500">
        Change
        <input
          value={changeText}
          onChange={(e) => setChangeText(e.target.value)}
          inputMode="decimal"
          disabled={isFinal || busy !== null}
          className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-right text-sm font-bold tabular-nums text-slate-900 disabled:bg-slate-100 disabled:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
      </label>
      <button
        onClick={savePayment}
        disabled={!canSubmit || busy !== null}
        className="mt-3 flex min-h-10 w-full items-center justify-center rounded-lg bg-slate-900 px-4 text-sm font-extrabold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
      >
        {busy === 'payment' ? 'Saving...' : 'Save payment'}
      </button>

      <div className="mt-4 border-t border-slate-200 pt-3">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Items</div>
        <div className="mt-2 space-y-2">
          {draftItems.map((item, index) => (
            <div key={item.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="truncate text-xs font-bold text-slate-900">{item.name}</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                  Qty
                  <input
                    value={item.quantityText}
                    onChange={(e) => setDraftItems((prev) => prev.map((row, i) => i === index ? { ...row, quantityText: e.target.value } : row))}
                    inputMode={normalizeSellBy(item.sell_by) === 'WEIGHT' ? 'decimal' : 'numeric'}
                    disabled={isFinal || busy !== null}
                    className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-right text-sm font-bold tabular-nums text-slate-900 disabled:bg-slate-100"
                  />
                </label>
                <label className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                  Price
                  <input
                    value={item.priceText}
                    onChange={(e) => setDraftItems((prev) => prev.map((row, i) => i === index ? { ...row, priceText: e.target.value } : row))}
                    inputMode="decimal"
                    disabled={isFinal || busy !== null}
                    className="mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-right text-sm font-bold tabular-nums text-slate-900 disabled:bg-slate-100"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 text-right text-xs font-bold text-slate-500">
          Draft total: {formatMoney(draftItems.reduce((sum, item) => sum + calculateLineTotalGrosze(parseMoneyInput(item.priceText), parseFloat(item.quantityText.replace(',', '.')) || 0, normalizeSellBy(item.sell_by)), 0), currency)}
        </div>
        <button
          onClick={saveItems}
          disabled={!canSubmit || busy !== null}
          className="mt-3 flex min-h-10 w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        >
          {busy === 'items' ? 'Saving...' : 'Save items'}
        </button>
      </div>

      <button
        onClick={voidOrder}
        disabled={!canSubmit || busy !== null}
        className="mt-3 flex min-h-10 w-full items-center justify-center rounded-lg border border-red-300 bg-red-50 px-4 text-sm font-extrabold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy === 'void' ? 'Processing...' : isSynced ? 'Void order' : 'Delete local order'}
      </button>

      {status && (
        <div
          className={`mt-3 rounded-lg border px-3 py-2 text-xs font-bold ${
            status.type === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          {status.message}
        </div>
      )}
    </section>
  );
}

export default function OrderHistoryModal({ onClose, t }: OrderHistoryModalProps) {
  const { config } = useConfig();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [totalOrders, setTotalOrders] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<'today' | 'week' | 'month' | 'all'>('today');
  const [filterMethod, setFilterMethod] = useState('');
  const [filterStaff, setFilterStaff] = useState('');
  const [detail, setDetail] = useState<{ order: OrderRow; items: OrderItemRow[] } | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [reprintStatus, setReprintStatus] = useState<ReprintStatus>(null);
  const [reprinting, setReprinting] = useState(false);
  const [printingFiscal, setPrintingFiscal] = useState(false);
  // A prior fiscal attempt left in UNKNOWN_NEEDS_RECONCILIATION (e.g. the ELZAB
  // sidecar crashed mid-receipt). The reprint gate stays blocked until the
  // operator confirms — on the physical printer — whether it actually printed.
  const [reconcilable, setReconcilable] = useState<{ id: string; status: string } | null>(null);
  const [reconciling, setReconciling] = useState(false);
  // Per-document print badges: which printer printed the order copy + the
  // fiscal receipt, and whether each succeeded. `printBadgeNonce` is bumped
  // after any print action so the badges refresh without reopening the order.
  const [orderPrint, setOrderPrint] = useState<{ name: string | null; target: string | null; status: string; route: string | null } | null>(null);
  const [fiscalPrint, setFiscalPrint] = useState<{ status: string; name: string | null; target: string | null } | null>(null);
  const [printBadgeNonce, setPrintBadgeNonce] = useState(0);
  const [showRefund, setShowRefund] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState<ReprintStatus>(null);
  const [cancelStatus, setCancelStatus] = useState<ReprintStatus>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingOrderConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [dataSource, setDataSource] = useState<'local+server' | 'local-only' | 'server-unreachable'>('local-only');
  const [serverItemsMap, setServerItemsMap] = useState<Record<string, OrderItemRow[]>>({});
  const [mirroringId, setMirroringId] = useState<string | null>(null);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [mirrorSplit, setMirrorSplit] = useState(false);
  const detailIdRef = useRef<string | undefined>(undefined);
  const loadSeqRef = useRef(0);

  const currency = tOr(t, 'pos.currency', 'zl');
  const hideNonFiscalOrders = config?.showNonFiscalOrders === false;
  const totalPages = Math.max(1, Math.ceil(totalOrders / PAGE_SIZE));
  const hasActiveFilters = selectedPeriod !== 'today' || filterMethod !== '' || filterStaff !== '';

  const staffNames = useMemo(
    () => Array.from(new Set(orders.map((o) => o.staff_name).filter((name): name is string => Boolean(name)))).sort(),
    [orders],
  );
  const pageOriginalTotal = useMemo(() => orders.reduce((sum, o) => sum + o.total, 0), [orders]);
  const pageRefundedTotal = useMemo(() => orders.reduce((sum, o) => sum + (o.refund_amount ?? 0), 0), [orders]);
  const pageRemainingTotal = useMemo(
    () => orders.reduce((sum, order) => sum + getSafeRemainingTotal(order), 0),
    [orders],
  );

  const loadOrders = useCallback(async () => {
    const loadSeq = loadSeqRef.current + 1;
    loadSeqRef.current = loadSeq;
    setLoading(true);
    setLoadError(null);

    const { from, to } = periodToDateRange(selectedPeriod);
    const serverFilters: { paymentMethod?: string; staffName?: string; requiresInvoice?: boolean } = {};
    if (filterMethod === 'INVOICE') {
      serverFilters.requiresInvoice = true;
    } else if (filterMethod) {
      serverFilters.paymentMethod = filterMethod;
    }
    if (filterStaff) serverFilters.staffName = filterStaff;

    const localHistoryFilters = {
      from,
      to,
      page,
      limit: PAGE_SIZE,
      fiscalOnly: hideNonFiscalOrders,
      paymentMethod: filterMethod || undefined,
      staffName: filterStaff || undefined,
    };
    const serverHistoryPromise = hideNonFiscalOrders
      ? Promise.resolve({ orders: [], total: 0, page, limit: PAGE_SIZE, source: 'unconfigured' as const, items: {} })
      : window.electronAPI.pos.orders.getServerList({ period: selectedPeriod, page, limit: PAGE_SIZE, ...serverFilters });
    const [localResult, serverResult] = await Promise.allSettled([
      window.electronAPI.pos.orders.getHistory(localHistoryFilters),
      serverHistoryPromise,
    ]);
    if (loadSeq !== loadSeqRef.current) return;

    let merged: OrderRow[] = [];
    let total = 0;
    let source: 'local+server' | 'local-only' | 'server-unreachable' = 'local-only';
    let newItemsMap: Record<string, OrderItemRow[]> = {};

    if (serverResult.status === 'fulfilled') {
      const sr = serverResult.value;
      if (sr.source === 'server') {
        merged = [...sr.orders];
        total = sr.total;
        newItemsMap = sr.items || {};
        source = 'local+server';
      } else if (sr.source === 'network-error') {
        source = 'server-unreachable';
      }
    } else {
      source = 'server-unreachable';
    }

    if (localResult.status === 'fulfilled') {
      const localOrders: OrderRow[] = localResult.value?.orders || [];
      if (source === 'local+server') {
        const localIds = new Set(localOrders.map((lo) => lo.id));
        const localBackendIds = new Set(
          localOrders.map((lo) => lo.backend_id).filter((v): v is string => Boolean(v))
        );
        merged = merged.filter(
          (s) => !localIds.has(s.id) && !localBackendIds.has(s.id)
        );
        for (const lo of localOrders) merged.push(lo);
      } else {
        merged = localOrders;
        total = localResult.value?.total || localOrders.length;
      }
    }

    merged = merged.filter((o) => o.status !== 'DRAFT' && o.status !== 'POS-DRA');
    if (filterMethod) merged = merged.filter((o) => orderMatchesPaymentFilter(o, filterMethod));
    if (filterStaff) {
      const staffNeedle = filterStaff.trim().toLowerCase();
      merged = merged.filter((o) => (o.staff_name || '').toLowerCase().includes(staffNeedle));
    }
    merged.sort(compareOrdersByDisplayTimeDesc);

    setOrders(merged);
    setTotalOrders(total);
    setServerItemsMap(newItemsMap);
    setDataSource(source);
    setLoading(false);
  }, [selectedPeriod, filterMethod, filterStaff, page, hideNonFiscalOrders]);

  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { setPage(1); }, [selectedPeriod, filterMethod, filterStaff, hideNonFiscalOrders]);
  useEffect(() => {
    detailIdRef.current = detail?.order.id;
    setMirrorError(null);
    setMirrorSplit(false);
  }, [detail?.order.id]);

  useEffect(() => {
    const unsubSynced = window.electronAPI.pos.sync.onOrderSynced?.((data: any) => {
      loadOrders();
      if (detail && detail.order.id === data.orderId) {
        window.electronAPI.pos.orders.getDetail(data.orderId).then((result: any) => {
          if (result) setDetail(result);
        });
      }
    });
    const unsubFailed = window.electronAPI.pos.sync.onOrderSyncFailed?.((data: any) => {
      loadOrders();
      if (detail && detail.order.id === data.orderId) {
        window.electronAPI.pos.orders.getDetail(data.orderId).then((result: any) => {
          if (result) setDetail(result);
        });
      }
    });
    return () => { unsubSynced?.(); unsubFailed?.(); };
  }, [detail, loadOrders]);

  const handleSelectOrder = async (orderId: string) => {
    setDetailLoadingId(orderId);
    setReprintStatus(null);
    setDeleteStatus(null);
    setCancelStatus(null);
    try {
      if (serverItemsMap[orderId] && serverItemsMap[orderId].length > 0) {
        const order = orders.find((o) => o.id === orderId);
        if (order) {
          setDetail({ order, items: serverItemsMap[orderId] });
          setShowRefund(false);
          return;
        }
      }
      const result = await window.electronAPI.pos.orders.getDetail(orderId);
      if (result) {
        setDetail(result);
        setShowRefund(false);
      }
    } finally {
      setDetailLoadingId(null);
    }
  };

  const refreshLocalOrderDetail = async (orderId: string) => {
    setDetailLoadingId(orderId);
    setReprintStatus(null);
    try {
      const result = await window.electronAPI.pos.orders.getDetail(orderId);
      if (result) {
        setDetail(result);
      }
    } finally {
      setDetailLoadingId(null);
    }
  };

  const handleReprint = async (orderId: string, order: OrderRow) => {
    if (reprinting) return;
    setReprinting(true);
    setReprintStatus(null);
    try {
      const isRefunded = order.status === 'REFUNDED' || order.status === 'PARTIAL_REFUND';
      const result = isRefunded
        ? await window.electronAPI.pos.payment.printRefundReceipt(orderId)
        : await window.electronAPI.pos.payment.reprintReceipt(orderId);
      if (result?.success && result.receiptPrinted !== false) {
        setReprintStatus({ type: 'ok', message: tOr(t, 'pos.history.reprinted', 'Receipt sent to printer') });
      } else {
        setReprintStatus({
          type: 'error',
          message: result?.error || tOr(t, 'pos.history.reprintFailed', 'Printer not connected'),
        });
      }
    } catch (e: any) {
      setReprintStatus({
        type: 'error',
        message: e?.message || tOr(t, 'pos.history.reprintFailed', 'Printer not connected'),
      });
    } finally {
      setReprinting(false);
      setPrintBadgeNonce((n) => n + 1);
    }
  };

  const handlePrintFiscal = async (orderId: string) => {
    if (printingFiscal) return;
    setPrintingFiscal(true);
    setReprintStatus(null);
    try {
      const result = await window.electronAPI.pos.payment.printFiscalReceipt(orderId);
      if (result?.success && result.fiscalPrinted !== false) {
        setReprintStatus({ type: 'ok', message: 'Fiscal receipt sent to printer' });
      } else {
        setReprintStatus({
          type: 'error',
          message: describeFiscalError(result?.error, (k, f) => tOr(t, k, f)),
        });
      }
    } catch (e: any) {
      setReprintStatus({
        type: 'error',
        message: describeFiscalError(e?.message, (k, f) => tOr(t, k, f)),
      });
    } finally {
      setPrintingFiscal(false);
      setPrintBadgeNonce((n) => n + 1);
    }
  };

  // Detect a stuck fiscal attempt whenever the detail panel opens for an order,
  // so the Printing section can offer a reconcile action instead of a silently
  // blocked reprint.
  useEffect(() => {
    const orderId = detail?.order.id;
    if (!orderId) { setReconcilable(null); return; }
    let cancelled = false;
    setReconcilable(null);
    window.electronAPI.pos.payment
      .getReconcilableFiscalAttempt(orderId)
      .then((res: { attempt: { id: string; status: string } | null } | undefined) => {
        if (cancelled) return;
        setReconcilable(res?.attempt ? { id: res.attempt.id, status: res.attempt.status } : null);
      })
      .catch(() => { if (!cancelled) setReconcilable(null); });
    return () => { cancelled = true; };
  }, [detail?.order.id]);

  // Per-document print badges (which printer printed the order copy + fiscal).
  // Refetched on order change and after any print action (printBadgeNonce).
  useEffect(() => {
    const orderId = detail?.order.id;
    if (!orderId) { setOrderPrint(null); setFiscalPrint(null); return; }
    let cancelled = false;
    Promise.all([
      window.electronAPI.pos.payment.getPrintAttempts(orderId),
      window.electronAPI.pos.payment.getLatestFiscalAttempt(orderId),
    ]).then(([pa, fa]) => {
      if (cancelled) return;
      const attempts = (pa?.attempts || []) as Array<{ document_type: string; printer_name: string | null; printer_target: string | null; status: string; route: string | null }>;
      const orderAttempt = attempts.find((a) => a.document_type === 'ORDER' || a.document_type === 'REPRINT') || null;
      setOrderPrint(orderAttempt
        ? { name: orderAttempt.printer_name, target: orderAttempt.printer_target, status: orderAttempt.status, route: orderAttempt.route }
        : null);
      setFiscalPrint(fa?.attempt
        ? { status: fa.attempt.status, name: fa.printer?.name ?? null, target: fa.printer?.target ?? null }
        : null);
    }).catch(() => { if (!cancelled) { setOrderPrint(null); setFiscalPrint(null); } });
    return () => { cancelled = true; };
  }, [detail?.order.id, printBadgeNonce]);

  const handleReconcileFiscal = async (orderId: string, didPrint: boolean) => {
    if (reconciling) return;
    setReconciling(true);
    setReprintStatus(null);
    try {
      const result = await window.electronAPI.pos.payment.reconcileFiscalAttempt(orderId, didPrint);
      if (result?.success) {
        setReconcilable(null);
        setReprintStatus({
          type: 'ok',
          message: didPrint
            ? tOr(t, 'pos.history.reconciledPrinted', 'Marked as already fiscalized. No reprint needed — use "Print order" for a copy.')
            : tOr(t, 'pos.history.reconciledNotPrinted', 'Cleared. You can print the fiscal receipt now.'),
        });
      } else {
        setReprintStatus({ type: 'error', message: result?.error || tOr(t, 'pos.history.reconcileFailed', 'Could not reconcile') });
      }
    } catch (e: any) {
      setReprintStatus({ type: 'error', message: e?.message || tOr(t, 'pos.history.reconcileFailed', 'Could not reconcile') });
    } finally {
      setReconciling(false);
    }
  };

  const handleDeleteLocalOrder = async (order: OrderRow) => {
    if (deleting) return;

    setDeleting(true);
    setDeleteStatus(null);
    try {
      const result = await window.electronAPI.pos.orders.deleteLocal(order.id);
      if (!result?.success) {
        setDeleteStatus({
          type: 'error',
          message: result?.error || tOr(t, 'pos.history.deleteFailed', 'Delete failed'),
        });
        return;
      }
      setDetail(null);
      setShowRefund(false);
      setReprintStatus(null);
      setDeleteStatus(null);
      await loadOrders();
    } catch (err: any) {
      setDeleteStatus({
        type: 'error',
        message: err?.message || tOr(t, 'pos.history.deleteFailed', 'Delete failed'),
      });
    } finally {
      setDeleting(false);
    }
  };

  const resetFilters = () => {
    setSelectedPeriod('today');
    setFilterMethod('');
    setFilterStaff('');
    setPage(1);
  };

  const changePeriod = (nextPeriod: 'today' | 'week' | 'month' | 'all') => {
    setPage(1);
    setSelectedPeriod(nextPeriod);
  };

  const changePaymentFilter = (nextMethod: string) => {
    setPage(1);
    setFilterMethod(nextMethod);
  };

  const changeStaffFilter = (nextStaff: string) => {
    setPage(1);
    setFilterStaff(nextStaff);
  };

  const ensureMirrored = async (order: OrderRow): Promise<boolean> => {
    if (order._origin !== 'server') return true;
    const startId = order.id;
    setMirroringId(startId);
    setMirrorError(null);
    setMirrorSplit(false);
    try {
      const kind: 'cash' | 'invoiced' = order.customer_nip ? 'invoiced' : 'cash';
      const res = await window.electronAPI.pos.orders.mirrorFromServer(startId, kind);
      const stillFocused = () => detailIdRef.current === startId;
      if (!res.success) {
        if (stillFocused()) setMirrorError(res.error || tOr(t, 'pos.history.mirrorError', 'Could not load order from server'));
        return false;
      }
      if (res.wasSplit && stillFocused()) setMirrorSplit(true);
      setServerItemsMap((prev) => {
        const next = { ...prev };
        delete next[startId];
        return next;
      });
      setOrders((prev) =>
        prev.map((o) => (o.id === startId ? { ...o, _origin: undefined, synced: 1, backend_id: o.backend_id ?? startId } : o)),
      );
      const fresh = await window.electronAPI.pos.orders.getDetail(startId);
      if (fresh) {
        setDetail((current) => (current?.order.id === startId ? fresh : current));
      }
      return true;
    } catch (err: any) {
      if (detailIdRef.current === startId) {
        setMirrorError(err?.message || tOr(t, 'pos.history.mirrorError', 'Could not load order from server'));
      }
      return false;
    } finally {
      setMirroringId((cur) => (cur === startId ? null : cur));
    }
  };

  const requestOrderConfirm = (request: PendingOrderConfirm) => {
    if (confirmBusy) return;
    setPendingConfirm(request);
  };

  const requestDeleteLocalOrder = (order: OrderRow) => {
    if (deleting) return;
    requestOrderConfirm({
      action: 'deleteLocal',
      order,
      isSynced: false,
      onConfirm: () => handleDeleteLocalOrder(order),
    });
  };

  const cancelPendingConfirm = () => {
    if (!confirmBusy) setPendingConfirm(null);
  };

  const confirmPendingAction = async () => {
    const request = pendingConfirm;
    if (!request || confirmBusy) return;

    setConfirmBusy(true);
    try {
      await request.onConfirm();
      setPendingConfirm(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  const confirmDialog = pendingConfirm ? (() => {
    const copy = buildConfirmCopy(pendingConfirm.action, {
      label: getOrderLabel(pendingConfirm.order),
      total: formatMoney(pendingConfirm.order.total, currency),
      isSynced: pendingConfirm.isSynced ?? Boolean(pendingConfirm.order.backend_id),
    });
    const baseKey = confirmCopyBaseKey(copy.titleKey);

    return (
      <ConfirmActionDialog
        open
        tier={copy.tier}
        title={tOr(t, copy.titleKey, copy.titleFallback)}
        body={tOr(t, `${baseKey}.body`, copy.bodyFallback)}
        consequence={tOr(t, `${baseKey}.consequence`, copy.consequenceFallback)}
        itemName={getOrderLabel(pendingConfirm.order)}
        confirmLabel={tOr(t, `${baseKey}.confirm`, copy.confirmLabelFallback)}
        cancelLabel={tOr(t, 'pos.cancel', 'Cancel')}
        continueLabel={tOr(t, 'pos.confirm.continue', 'Continue')}
        backLabel={tOr(t, 'pos.confirm.back', 'Back')}
        danger
        busy={confirmBusy}
        onConfirm={confirmPendingAction}
        onCancel={cancelPendingConfirm}
      />
    );
  })() : null;

  if (detail) {
    const { order, items } = detail;
    const refundStatus = getRefundStatus(order);
    const remainingTotal = getSafeRemainingTotal(order);
    const refundOverage = hasRefundOverage(order);
    const refundSyncError = order.sync_error && /refund/i.test(order.sync_error) ? order.sync_error : null;
    const detailRefundableResult = getRemainingRefundableItems(order, items);
    const refundBlockedByMissingLines = detailRefundableResult.unsafeMissingRefundLines;
    const hasRefundableItem = detailRefundableResult.items.some((item) => item.maxQty > 0);
    const itemRefundBreakdowns = getItemRefundBreakdowns(order, items);
    const itemRefundBreakdownById = new Map(itemRefundBreakdowns.map((breakdown) => [breakdown.item.id, breakdown]));
    const refundEvents = getRefundEvents(order, items);
    const canRefund = Boolean(order.backend_id)
      && order.status !== 'CANCELLED'
      && refundStatus !== 'full'
      && !refundOverage
      && !refundSyncError
      && !refundBlockedByMissingLines
      && remainingTotal > 0
      && hasRefundableItem;
    const isMirroring = mirroringId === order.id;
    const notSynced = !order.backend_id && order.synced !== 1;
    const canDeleteLocal = order._origin !== 'server' && !order.backend_id && order.synced !== 1 && order.synced !== 2;
    const requestCancelOrder = async () => {
      if (cancelling || isMirroring) return;
      if (!(await ensureMirrored(order))) return;
      requestOrderConfirm({
        action: 'cancel',
        order,
        isSynced: Boolean(order.backend_id),
        onConfirm: async () => {
          setCancelling(true);
          setCancelStatus(null);
          try {
            const res = await window.electronAPI.pos.orders.cancel(order.id);
            if (res.success) { handleSelectOrder(order.id); loadOrders(); }
            else {
              setCancelStatus({
                type: 'error',
                message: res.error || tOr(t, 'pos.history.cancelFailed', 'Cancel failed'),
              });
            }
          } catch (err: any) {
            setCancelStatus({
              type: 'error',
              message: err?.message || tOr(t, 'pos.history.cancelFailed', 'Cancel failed'),
            });
          }
          finally { setCancelling(false); }
        },
      });
    };

    return (
      <>
      <DialogShell onClose={onClose}>
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => { setDetail(null); setShowRefund(false); setReprintStatus(null); setDeleteStatus(null); setCancelStatus(null); }}
              className="flex h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-extrabold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15 19l-7-7 7-7" />
              </svg>
              {tOr(t, 'pos.history.title', 'History')}
            </button>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-xl font-extrabold text-slate-950">{getOrderLabel(order)}</h2>
                <StatusBadge order={order} t={t} />
              </div>
              <p className="mt-1 text-sm font-medium text-slate-500">
                {formatDate(order.created_at)} {formatTime(order.created_at)} - {(() => {
                  try { const t2 = order.payment_tenders ? JSON.parse(order.payment_tenders) : null; if (Array.isArray(t2) && t2.length > 1) return paymentLabel('SPLIT', t); } catch {}
                  return paymentLabel(order.payment_method, t);
                })()}
                {order.staff_name ? ` - ${order.staff_name}` : ''}
              </p>
            </div>
          </div>
          <CloseButton onClose={onClose} />
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px] overflow-hidden bg-slate-50">
          <main className="min-h-0 overflow-y-auto p-5">
            <div className="grid grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">{tOr(t, 'pos.history.originalTotal', 'Original total')}</div>
                <div className="mt-2 text-xl font-extrabold tabular-nums text-slate-950">{formatMoney(order.total, currency)}</div>
              </div>
              <div className={`rounded-lg border bg-white p-4 shadow-sm ${(order.refund_amount ?? 0) > 0 ? 'border-red-200' : 'border-slate-200'}`}>
                <div className={`text-xs font-bold uppercase tracking-wide ${(order.refund_amount ?? 0) > 0 ? 'text-red-600' : 'text-slate-500'}`}>{tOr(t, 'pos.history.refundedTotal', 'Refunded')}</div>
                <div className={`mt-2 text-xl font-extrabold tabular-nums ${(order.refund_amount ?? 0) > 0 ? 'text-red-700' : 'text-slate-500'}`}>-{formatMoney(order.refund_amount ?? 0, currency)}</div>
              </div>
              <div className={`rounded-lg border p-4 shadow-sm ${(order.refund_amount ?? 0) > 0 ? 'border-amber-200 bg-amber-50' : 'border-brand-200 bg-brand-50'}`}>
                <div className={`text-xs font-bold uppercase tracking-wide ${(order.refund_amount ?? 0) > 0 ? 'text-amber-700' : 'text-brand-700'}`}>{tOr(t, 'pos.history.remainingTotal', 'Remaining')}</div>
                <div className={`mt-2 text-2xl font-extrabold tabular-nums ${(order.refund_amount ?? 0) > 0 ? 'text-amber-900' : 'text-brand-800'}`}>{formatMoney(remainingTotal, currency)}</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">{tOr(t, 'pos.history.staff', 'Staff')}</div>
                <div className="mt-2 truncate text-xl font-extrabold text-slate-950">{order.staff_name || '-'}</div>
              </div>
            </div>

            <section className="mt-4 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
                <h3 className="text-sm font-extrabold text-slate-900">{tOr(t, 'pos.history.items', 'Items')}</h3>
                <span className="text-xs font-bold text-slate-500">{items.length} {tOr(t, 'pos.history.itemRows', 'rows')}</span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_180px_70px_120px] gap-3 border-b border-slate-200 bg-white px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <span>{tOr(t, 'pos.history.product', 'Product')}</span>
                <span className="text-right">{tOr(t, 'pos.history.quantity', 'Qty')}</span>
                <span className="text-right">VAT</span>
                <span className="text-right">{tOr(t, 'pos.cart.total', 'Total')}</span>
              </div>
              <div className="divide-y divide-slate-100">
                {items.map((item) => {
                  const refundInfo = itemRefundBreakdownById.get(item.id);
                  const hasItemRefund = Boolean(refundInfo && refundInfo.refundedQty > 0);
                  const sellBy = normalizeSellBy(item.sell_by);
                  const unit = displaySaleUnit(item.sale_unit, sellBy, t);
                  return (
                    <div key={item.id} className={`grid min-h-14 grid-cols-[minmax(0,1fr)_180px_70px_120px] items-center gap-3 px-4 py-3 ${hasItemRefund ? 'bg-amber-50/45' : ''}`}>
                      <div className="min-w-0">
                        <div className="whitespace-normal break-words text-sm font-bold leading-5 text-slate-950">{item.name}</div>
                        <div className="mt-0.5 truncate text-xs font-medium text-slate-500">{item.sku || 'No SKU'} - {formatMoney(item.price, currency)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-bold tabular-nums text-slate-700">
                          {formatSaleQuantity(item.quantity, sellBy)} {unit}
                        </div>
                        {hasItemRefund && refundInfo && (
                          <div className="mt-1 text-[11px] font-bold leading-4 text-amber-800">
                            {tOr(t, 'pos.history.refundedShort', 'Refunded')} {formatSaleQuantity(refundInfo.refundedQty, sellBy)} {unit}
                            <span className="px-1 text-slate-300">·</span>
                            {tOr(t, 'pos.history.remainingShort', 'Remaining')} {formatSaleQuantity(refundInfo.remainingQty, sellBy)} {unit}
                          </div>
                        )}
                      </div>
                      <div className="text-right text-sm font-bold tabular-nums text-slate-700">{item.vat_rate}%</div>
                      <div className="text-right">
                        <div className="text-sm font-extrabold tabular-nums text-slate-950">{formatMoney(item.total, currency)}</div>
                        {hasItemRefund && refundInfo && (
                          <div className="mt-1 text-xs font-bold tabular-nums text-red-700">-{formatMoney(refundInfo.refundedAmount, currency)}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {(order.refund_amount ?? 0) > 0 && (
              <section className="mt-4 overflow-hidden rounded-lg border border-amber-200 bg-white shadow-sm">
                <div className="flex items-start justify-between gap-4 border-b border-amber-200 bg-amber-50 px-4 py-3">
                  <h3 className="text-sm font-extrabold text-slate-950">{tOr(t, 'pos.history.refundHistory', 'Refund history')}</h3>
                  <div className="text-right">
                    <div className="text-xs font-bold uppercase tracking-wide text-red-600">{tOr(t, 'pos.history.refundedTotal', 'Refunded')}</div>
                    <div className="mt-1 text-lg font-extrabold tabular-nums text-red-700">-{formatMoney(order.refund_amount ?? 0, currency)}</div>
                  </div>
                </div>

                {refundEvents.length > 0 ? (
                  <div className="space-y-3 p-4">
                    {refundEvents.map((event, eventIndex) => {
                      const eventTime = event.refundedAt || (refundEvents.length === 1 ? order.refunded_at ?? null : null);
                      const eventReason = event.reason || (eventIndex === refundEvents.length - 1 ? order.refund_reason : null);
                      const restockValues = event.lines.map((line) => line.restock).filter((value): value is boolean => typeof value === 'boolean');
                      return (
                        <div key={event.key} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                          <div className="flex items-start justify-between gap-4 border-b border-slate-100 bg-slate-50 px-4 py-3">
                            <div>
                              <div className="text-sm font-extrabold text-slate-900">
                                {tOr(t, 'pos.history.refundEvent', 'Refund')} #{eventIndex + 1}
                              </div>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-slate-500">
                                {eventTime && <span>{formatDate(eventTime)} {formatTime(eventTime)}</span>}
                                {event.refundMethod && <span>{paymentLabel(event.refundMethod, t)}</span>}
                                {restockValues.length > 0 && (
                                  <span>{restockValues.every(Boolean)
                                    ? tOr(t, 'pos.refund.restocked', 'Restocked')
                                    : restockValues.every((value) => !value)
                                      ? tOr(t, 'pos.refund.notRestocked', 'Not restocked')
                                      : tOr(t, 'pos.refund.mixedRestock', 'Partially restocked')}</span>
                                )}
                              </div>
                              {eventReason && (
                                <div className="mt-1 text-xs font-bold text-slate-600">
                                  {tOr(t, 'pos.refund.reason', 'Reason')}: {localizeRefundReason(eventReason, t)}
                                </div>
                              )}
                            </div>
                            <div className="text-base font-extrabold tabular-nums text-red-700">-{formatMoney(event.refundAmount, currency)}</div>
                          </div>
                          <div className="divide-y divide-slate-100">
                            {event.lines.map((line, lineIndex) => (
                              <div key={`${line.orderItemId || line.variantId || line.sku || line.name}-${lineIndex}`} className="grid grid-cols-[minmax(0,1fr)_120px_120px] items-center gap-4 px-4 py-3 text-sm">
                                <div className="min-w-0">
                                  <div className="whitespace-normal break-words font-bold text-slate-900">{getRefundLineName(line, t)}</div>
                                  {line.sku && <div className="mt-0.5 text-xs font-medium text-slate-500">{line.sku}</div>}
                                </div>
                                <div className="text-right font-bold tabular-nums text-slate-700">{formatRefundLineQuantity(line, t)}</div>
                                <div className="text-right font-extrabold tabular-nums text-red-700">-{formatMoney(line.refundAmount, currency)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-4 py-3 text-sm font-bold text-amber-800">
                    <div>{tOr(t, 'pos.refund.missingItemDetails', 'Product details are unavailable for this older refund.')}</div>
                    {order.refunded_at && <div className="mt-1 text-xs font-medium text-slate-600">{formatDate(order.refunded_at)} {formatTime(order.refunded_at)}</div>}
                    {order.refund_reason && <div className="mt-1 text-xs text-slate-700">{tOr(t, 'pos.refund.reason', 'Reason')}: {localizeRefundReason(order.refund_reason, t)}</div>}
                  </div>
                )}
              </section>
            )}

            <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-extrabold text-slate-900">{tOr(t, 'pos.history.paymentAndTotals', 'Payment and totals')}</h3>
              <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-slate-500">{tOr(t, 'pos.cart.subtotal', 'Subtotal')}</span>
                  <span className="font-bold tabular-nums text-slate-900">{formatMoney(order.subtotal, currency)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-slate-500">{tOr(t, 'pos.cart.inclVat', 'Incl. VAT')}</span>
                  <span className="font-bold tabular-nums text-slate-900">{formatMoney(order.tax, currency)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-slate-500">{tOr(t, 'pos.cart.discount', 'Discount')}</span>
                  <span className="font-bold tabular-nums text-emerald-700">
                    {order.discount > 0 ? `-${formatMoney(order.discount, currency)}` : formatMoney(0, currency)}
                  </span>
                </div>
                {(() => {
                  let tenders: Array<{ method: string; amount: number }> | null = null;
                  try { if (order.payment_tenders) tenders = JSON.parse(order.payment_tenders); } catch {}
                  if (tenders && tenders.length > 1) {
                    return (
                      <div className="space-y-1">
                        <span className="font-medium text-slate-500">{tOr(t, 'pos.history.paymentSplit', 'Payment split')}</span>
                        {tenders.map((tender, i) => (
                          <div key={i} className="flex justify-between gap-4 pl-2">
                            <span className="text-slate-600">{paymentLabel(tender.method, t)}</span>
                            <span className="font-bold tabular-nums text-slate-900">{formatMoney(tender.amount, currency)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  }
                  return (
                    <div className="flex justify-between gap-4">
                      <span className="font-medium text-slate-500">{tOr(t, 'pos.history.method', 'Method')}</span>
                      <span className="font-bold text-slate-900">{paymentLabel(order.payment_method, t)}</span>
                    </div>
                  );
                })()}
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-slate-500">{tOr(t, 'pos.history.paidAmount', 'Paid amount')}</span>
                  <span className="font-bold tabular-nums text-slate-900">{formatMoney(order.payment_amount, currency)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="font-medium text-slate-500">{tOr(t, 'pos.payment.change', 'Change')}</span>
                  <span className="font-bold tabular-nums text-slate-900">{formatMoney(order.change_amount, currency)}</span>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-slate-200 pt-3">
                <span className="text-base font-extrabold text-slate-950">
                  {(order.refund_amount ?? 0) > 0
                    ? tOr(t, 'pos.history.remainingTotal', 'Remaining')
                    : tOr(t, 'pos.cart.total', 'Total')}
                </span>
                <span className={`text-2xl font-extrabold tabular-nums ${(order.refund_amount ?? 0) > 0 ? 'text-amber-700' : 'text-brand-700'}`}>{formatMoney(remainingTotal, currency)}</span>
              </div>
            </section>
            {refundOverage && (
              <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-bold text-red-800">
                {tOr(t, 'pos.refund.overageBlocked', 'Refund data exceeds the order total. Further refunds are blocked.')}
              </div>
            )}
            {refundSyncError && (
              <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">
                {refundSyncError}
              </div>
            )}
            {refundBlockedByMissingLines && !refundSyncError && (
              <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">
                {tOr(t, 'pos.refund.missingDetailsBlocked', 'Refund details are incomplete. Refresh the order before refunding again.')}
              </div>
            )}
          </main>

          <aside className="flex min-h-0 flex-col border-l border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500">{tOr(t, 'pos.history.operations', 'Operations')}</div>
              <div className="mt-1 text-lg font-extrabold text-slate-950">{tOr(t, 'pos.history.receiptAndRefund', 'Receipt and refund')}</div>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              {showRefund && canRefund && (
                <RefundPanel
                  order={order}
                  items={items}
                  currency={currency}
                  t={t}
                  onCancel={() => setShowRefund(false)}
                  onComplete={(options) => {
                    setShowRefund(false);
                    refreshLocalOrderDetail(order.id).finally(() => {
                      if (options?.keepRefundOpen) setShowRefund(true);
                    });
                    loadOrders();
                  }}
                />
              )}

              {isMirroring && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-bold text-blue-800">
                  {tOr(t, 'pos.history.mirroring', 'Loading order details from server...')}
                </div>
              )}
              {mirrorError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-800">
                  {mirrorError}
                  <button onClick={() => { setMirrorError(null); ensureMirrored(order); }} className="ml-2 underline">
                    {tOr(t, 'pos.history.mirrorRetry', 'Retry')}
                  </button>
                </div>
              )}
              {mirrorSplit && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800">
                  {tOr(t, 'pos.history.mirrorSplitWarning', 'Original payment was split across methods. Refund will be issued as a single payment method.')}
                </div>
              )}

              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h3 className="text-sm font-extrabold text-slate-900">Printing</h3>
                <p className="mt-1 text-xs font-medium text-slate-500">Print the fiscal receipt and the order copy separately.</p>

                {/* Which printer printed each document, and whether it succeeded. */}
                <div className="mt-3 space-y-1.5">
                  <PrintBadge
                    label={tOr(t, 'pos.history.docOrder', 'Order')}
                    view={orderPrintBadgeView(orderPrint, (k, f) => tOr(t, k, f))}
                  />
                  <PrintBadge
                    label={tOr(t, 'pos.history.docFiscal', 'Fiscal')}
                    view={fiscalPrintBadgeView(fiscalPrint, (k, f) => tOr(t, k, f))}
                  />
                </div>

                <button
                  onClick={async () => { if (await ensureMirrored(order)) handleReprint(order.id, order); }}
                  disabled={reprinting || printingFiscal || isMirroring}
                  className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-slate-900 px-4 text-sm font-extrabold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-200 disabled:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
                >
                  {(reprinting || isMirroring) && (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
                  )}
                  {reprinting ? 'Sending...' : 'Print order'}
                </button>

                {reconcilable && (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
                    <p className="text-sm font-extrabold text-amber-900">
                      {tOr(t, 'pos.history.reconcileTitle', 'Hóa đơn fiskal trước bị gián đoạn')}
                    </p>
                    <p className="mt-1 text-xs font-medium text-amber-800">
                      {tOr(t, 'pos.history.reconcilePrompt', 'Lần in trước không xác nhận được. Kiểm tra MÁY fiskal: hóa đơn cho đơn này đã in ra giấy chưa? In lại có thể tạo hóa đơn trùng.')}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => handleReconcileFiscal(order.id, true)}
                        disabled={reconciling}
                        className="flex-1 min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-extrabold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                      >
                        {tOr(t, 'pos.history.reconcileDidPrint', 'Đã in trên máy')}
                      </button>
                      <button
                        onClick={() => handleReconcileFiscal(order.id, false)}
                        disabled={reconciling}
                        className="flex-1 min-h-11 rounded-lg border border-amber-400 bg-amber-500 px-3 text-sm font-extrabold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-amber-200"
                      >
                        {tOr(t, 'pos.history.reconcileNotPrinted', 'Chưa in → cho in lại')}
                      </button>
                    </div>
                  </div>
                )}

                <button
                  onClick={async () => { if (await ensureMirrored(order)) handlePrintFiscal(order.id); }}
                  disabled={printingFiscal || reprinting || isMirroring || refundStatus !== 'none' || !!reconcilable}
                  className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 text-sm font-extrabold text-emerald-800 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
                >
                  {(printingFiscal || isMirroring) && (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-300 border-t-emerald-800" aria-hidden="true" />
                  )}
                  {printingFiscal ? 'Sending...' : 'Print fiscal receipt'}
                </button>

                {refundStatus !== 'none' && (
                  <div className="mt-2 text-xs font-bold text-slate-500">
                    Fiscal sale receipt is disabled for refunded orders.
                  </div>
                )}

                {reprintStatus && (
                  <div
                    className={`mt-3 rounded-lg border px-3 py-3 text-sm font-bold ${
                      reprintStatus.type === 'ok'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-red-200 bg-red-50 text-red-800'
                    }`}
                  >
                    {reprintStatus.message}
                  </div>
                )}
              </section>

              {canRefund && !showRefund && (
                <button
                  onClick={async () => { if (await ensureMirrored(order)) setShowRefund(true); }}
                  disabled={isMirroring}
                  className="flex min-h-12 w-full items-center justify-center rounded-lg border border-red-300 bg-red-50 px-4 text-sm font-extrabold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200"
                >
                  {tOr(t, 'pos.refund.title', 'Refund Order')}
                </button>
              )}

              {!showRefund && (
                <OrderMutationPanel
                  order={order}
                  items={items}
                  currency={currency}
                  t={t}
                  onUpdated={(closed) => {
                    if (closed) {
                      loadOrders();
                      setDetail(null);
                      return;
                    }
                    refreshLocalOrderDetail(order.id);
                    loadOrders();
                  }}
                  ensureMirrored={() => ensureMirrored(order)}
                  isMirroring={isMirroring}
                  onRequestConfirm={requestOrderConfirm}
                />
              )}

              {order.backend_id && order.status !== 'CANCELLED' && refundStatus === 'none' && !showRefund && (
                <>
                  <button
                    disabled={cancelling || isMirroring}
                    onClick={requestCancelOrder}
                    className="flex min-h-10 w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-200 disabled:opacity-50"
                  >
                    {cancelling ? 'Cancelling...' : tOr(t, 'pos.history.cancelOrder', 'Cancel Order')}
                  </button>
                  {cancelStatus && (
                    <div
                      className={`rounded-lg border px-3 py-3 text-sm font-bold ${
                        cancelStatus.type === 'ok'
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                          : 'border-red-200 bg-red-50 text-red-800'
                      }`}
                    >
                      {cancelStatus.message}
                    </div>
                  )}
                </>
              )}

              {canDeleteLocal && !showRefund && (
                <section className="rounded-lg border border-red-200 bg-red-50 p-4">
                  <h3 className="text-sm font-extrabold text-red-900">{tOr(t, 'pos.history.deleteLocalTitle', 'Delete local order')}</h3>
                  <p className="mt-1 text-xs font-bold text-red-700">
                    {tOr(t, 'pos.history.deleteLocalHint', 'Only unsynced local orders can be deleted. Stock will be restored.')}
                  </p>
                  <button
                    onClick={() => requestDeleteLocalOrder(order)}
                    disabled={deleting || isMirroring}
                    className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg border border-red-300 bg-white px-4 text-sm font-extrabold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200"
                  >
                    {deleting ? tOr(t, 'pos.history.deleting', 'Deleting...') : tOr(t, 'pos.history.deleteOrder', 'Delete Order')}
                  </button>
                  {deleteStatus && (
                    <div className="mt-3 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-bold text-red-800">
                      {deleteStatus.message}
                    </div>
                  )}
                </section>
              )}

              {notSynced && (
                <SyncFailurePanel
                  order={order}
                  onRetried={() => { handleSelectOrder(order.id); loadOrders(); }}
                  t={t}
                />
              )}

              {refundStatus !== 'none' && !canRefund && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700">
                  {refundStatus === 'full'
                    ? tOr(t, 'pos.refund.alreadyRefunded', 'Already refunded')
                    : tOr(t, 'pos.refund.noFurtherRefund', 'No further refund is currently available for this order.')}
                </div>
              )}

              {order.backend_id && (
                <ServerActionsPanel
                  order={order as any}
                  t={t}
                  onOrderUpdated={() => { handleSelectOrder(order.id); loadOrders(); }}
                  ensureMirrored={() => ensureMirrored(order)}
                  isMirroring={isMirroring}
                />
              )}

            </div>
          </aside>
        </div>
      </DialogShell>
      {confirmDialog}
      </>
    );
  }

  return (
    <>
    <DialogShell onClose={onClose}>
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-extrabold text-slate-950">{tOr(t, 'pos.history.title', 'Order History')}</h2>
          <p className="mt-1 text-sm font-medium text-slate-500">
            {PERIOD_LABELS[selectedPeriod] || 'Today'} — {totalOrders} {tOr(t, 'pos.history.orders', 'orders')}
            <span className="ml-2 font-bold text-slate-600">
              {tOr(t, 'pos.history.originalShort', 'Original')} {formatMoney(pageOriginalTotal, currency)} · {tOr(t, 'pos.history.refundedShort', 'Refunded')} -{formatMoney(pageRefundedTotal, currency)} · {tOr(t, 'pos.history.remainingShort', 'Remaining')} {formatMoney(pageRemainingTotal, currency)}
            </span>
            <span className={`ml-2 inline-flex items-center gap-1 text-xs font-bold ${dataSource === 'local+server' ? 'text-emerald-600' : dataSource === 'server-unreachable' ? 'text-amber-600' : 'text-slate-400'}`}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
              {dataSource === 'local+server' ? 'Local + Server' : dataSource === 'server-unreachable' ? 'Server unreachable — showing local data' : 'Local only (offline)'}
            </span>
          </p>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-5 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[168px] flex-1 text-xs font-bold uppercase tracking-wide text-slate-600">
            Period
            <select
              value={selectedPeriod}
              onChange={(e) => changePeriod(e.target.value as 'today' | 'week' | 'month' | 'all')}
              className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="all">All Time</option>
            </select>
          </label>

          <label className="min-w-[184px] flex-1 text-xs font-bold uppercase tracking-wide text-slate-600">
            Payment
            <select
              value={filterMethod}
              onChange={(e) => changePaymentFilter(e.target.value)}
              className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">{tOr(t, 'pos.history.allMethods', 'All Methods')}</option>
              {PAYMENT_METHODS.map((method) => (
                <option key={method.value} value={method.value}>{method.label}</option>
              ))}
            </select>
          </label>

          <label className="min-w-[184px] flex-1 text-xs font-bold uppercase tracking-wide text-slate-600">
            Staff
            <select
              value={filterStaff}
              onChange={(e) => changeStaffFilter(e.target.value)}
              disabled={staffNames.length === 0}
              className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-900 shadow-sm disabled:bg-slate-100 disabled:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            >
              <option value="">{tOr(t, 'pos.history.allStaff', 'All Staff')}</option>
              {staffNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>

          <button
            onClick={resetFilters}
            disabled={!hasActiveFilters}
            className="h-11 min-w-[112px] rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col bg-white">
        <div className="grid h-11 shrink-0 grid-cols-[minmax(180px,1.2fr)_80px_175px_105px_110px_125px_44px] items-center gap-3 border-b border-slate-200 bg-slate-100 px-5 text-xs font-extrabold uppercase tracking-wide text-slate-600">
          <span>{tOr(t, 'pos.history.order', 'Order')}</span>
          <span>{tOr(t, 'pos.history.time', 'Time')}</span>
          <span className="text-right">{tOr(t, 'pos.history.amounts', 'Amounts')}</span>
          <span>{tOr(t, 'pos.history.payment', 'Payment')}</span>
          <span>{tOr(t, 'pos.history.staff', 'Staff')}</span>
          <span>{tOr(t, 'pos.history.status', 'Status')}</span>
          <span />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full min-h-[260px] items-center justify-center">
              <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-600 shadow-sm">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" aria-hidden="true" />
                Loading orders...
              </div>
            </div>
          ) : loadError ? (
            <div className="flex h-full min-h-[260px] items-center justify-center px-6 text-center">
              <div className="rounded-lg border border-red-200 bg-red-50 px-5 py-4 text-sm font-bold text-red-800">
                {loadError}
              </div>
            </div>
          ) : orders.length === 0 ? (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center px-6 text-center">
              <div className="text-base font-extrabold text-slate-900">{tOr(t, 'pos.history.noOrders', 'No orders found')}</div>
              <div className="mt-1 text-sm font-medium text-slate-500">Adjust the date, payment method, or staff filter.</div>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {orders.map((order, index) => {
                const refundStatus = getRefundStatus(order);
                const displayNumber = getHistoryDisplayNumber(order, (page - 1) * PAGE_SIZE + index, hideNonFiscalOrders, totalOrders);
                const realOrderNumber = getRealHistoryOrderNumber(order);
                const previewItems = serverItemsMap[order.id] || (order.backend_id ? serverItemsMap[order.backend_id] : undefined) || [];
                const itemPreview = previewItems.length > 0
                  ? `${previewItems[0].name}${previewItems.length > 1 ? ` +${previewItems.length - 1}` : ''}`
                  : '';
                const identityPreview = order.customer_name || itemPreview;
                const dateLabel = hideNonFiscalOrders ? `${realOrderNumber} - ${formatDate(order.created_at)}` : formatDate(order.created_at);
                const orderRemaining = getSafeRemainingTotal(order);
                return (
                  <button
                    key={order.id}
                    onClick={() => handleSelectOrder(order.id)}
                    className="grid min-h-[76px] w-full grid-cols-[minmax(180px,1.2fr)_80px_175px_105px_110px_125px_44px] items-center gap-3 px-5 text-left transition-colors hover:bg-brand-50 focus:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-extrabold text-slate-950" title={hideNonFiscalOrders ? `Real order number: ${realOrderNumber}` : undefined}>
                        {displayNumber}
                      </span>
                      <span className="mt-0.5 block truncate text-xs font-medium text-slate-500">
                        {dateLabel}{identityPreview ? ` · ${identityPreview}` : ''}
                      </span>
                    </span>
                    <span className="text-sm font-bold tabular-nums text-slate-700">{formatTime(order.created_at)}</span>
                    <span className="text-right tabular-nums">
                      {refundStatus === 'none' ? (
                        <span className="text-base font-extrabold text-slate-950">{formatMoney(order.total, currency)}</span>
                      ) : (
                        <span className="space-y-0.5">
                          <span className="block text-xs font-bold text-slate-500">{tOr(t, 'pos.history.originalShort', 'Original')} {formatMoney(order.total, currency)}</span>
                          <span className="block text-xs font-bold text-red-700">{tOr(t, 'pos.history.refundedShort', 'Refunded')} -{formatMoney(order.refund_amount ?? 0, currency)}</span>
                          <span className="block text-sm font-extrabold text-amber-800">{tOr(t, 'pos.history.remainingShort', 'Remaining')} {formatMoney(orderRemaining, currency)}</span>
                        </span>
                      )}
                    </span>
                    <span className="inline-flex h-8 max-w-full items-center justify-center truncate rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-extrabold text-slate-700">
                      {(() => {
                        try {
                          const t2 = order.payment_tenders ? JSON.parse(order.payment_tenders) : null;
                          if (Array.isArray(t2) && t2.length > 1) return paymentLabel('SPLIT', t);
                        } catch {}
                        return paymentLabel(order.payment_method, t);
                      })()}
                    </span>
                    <span className="truncate text-sm font-bold text-slate-700">{order.staff_name || '-'}</span>
                    <span className="min-w-0">
                      <StatusBadge order={order} t={t} />
                      {refundStatus !== 'none' && order.refunded_at && (
                        <span className="mt-1 block truncate text-[11px] font-medium text-slate-500">{formatDate(order.refunded_at)} {formatTime(order.refunded_at)}</span>
                      )}
                    </span>
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400">
                      {detailLoadingId === order.id ? (
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" aria-hidden="true" />
                      ) : (
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 5l7 7-7 7" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <div className="text-sm font-bold text-slate-600">
            {tOr(t, 'pos.history.pageTotals', 'This page')}: {tOr(t, 'pos.history.originalShort', 'Original')} {formatMoney(pageOriginalTotal, currency)} · {tOr(t, 'pos.history.refundedShort', 'Refunded')} -{formatMoney(pageRefundedTotal, currency)} · {tOr(t, 'pos.history.remainingShort', 'Remaining')} {formatMoney(pageRemainingTotal, currency)}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="h-11 min-w-[84px] rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
            >
              Prev
            </button>
            <span className="min-w-[88px] text-center text-sm font-extrabold tabular-nums text-slate-700">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="h-11 min-w-[84px] rounded-lg border border-slate-300 bg-white px-4 text-sm font-extrabold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </DialogShell>
    {confirmDialog}
    </>
  );
}
