import { getConfigValue } from '../config/store';
import logger from '../logger';
import {
  posEventOutboxRepo,
  PosEventReliabilityClass,
  PosEventType,
} from '../database/repos/pos-event-outbox-repo';
import type { OrderRow, OrderItemRow } from '../database/repos/order-repo';
import type { ShiftReport } from '../pos/shift-controller';

const RELIABILITY: Record<PosEventType, PosEventReliabilityClass> = {
  SaleCompleted: 'important_business',
  PaymentCaptured: 'critical_financial',
  RefundIssued: 'critical_financial',
  ShiftOpened: 'important_business',
  ShiftClosed: 'important_business',
  FiscalReceiptEmitted: 'critical_financial',
  CashDrawerOpened: 'operational',
  ReceiptPrintAttempted: 'operational',
};

function salonId(): string | null {
  return (getConfigValue('salonId') as string | undefined) || null;
}
function deviceId(): string | null {
  return (getConfigValue('machineId') as string | undefined) || null;
}

/** POS payment method codes → POS-event contract method vocabulary. */
function normalizeMethod(method: string | null | undefined): string {
  switch (String(method || '').toUpperCase()) {
    case 'CASH':
      return 'cash';
    case 'CARD':
      return 'card';
    case 'BLIK':
      return 'blik';
    case 'TRANSFER':
    case 'BANK_TRANSFER':
      return 'bank_transfer';
    case 'SPLIT':
    case 'MIXED':
      return 'mixed';
    case '':
      return 'other';
    default:
      return String(method).toLowerCase();
  }
}

/** Cash and BLIK clear instantly; mark them settled so the cashflow read model
 *  counts them as available rather than pending settlement. */
function settlement(method: string, occurredAt: string): Record<string, unknown> {
  const instant = method === 'cash' || method === 'blik';
  return {
    expectedSettlementDate: null,
    settledAt: instant ? occurredAt : null,
    providerFeeMinor: 0,
  };
}

interface Tender {
  method: string;
  amount: number;
}

function parseTenders(order: OrderRow): Tender[] {
  if (order.payment_tenders) {
    try {
      const parsed = JSON.parse(order.payment_tenders) as Tender[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((t) => t && typeof t.amount === 'number');
      }
    } catch {
      /* fall through to single-method */
    }
  }
  // Captured amount for a single tender is the SALE total, not the cash tendered:
  // payment_amount holds cash received (change_amount is returned separately), so
  // using it would overstate revenue by the change on a cash sale.
  const amount = order.total || order.payment_amount || 0;
  if (!order.payment_method && amount <= 0) return [];
  return [{ method: order.payment_method || 'OTHER', amount }];
}

function buildTaxSummary(items: OrderItemRow[]): Array<Record<string, number>> {
  const byRate = new Map<number, number>();
  for (const it of items) {
    const rateBps = Math.round((it.vat_rate ?? 23) * 100);
    byRate.set(rateBps, (byRate.get(rateBps) || 0) + (it.total || 0));
  }
  return Array.from(byRate.entries()).map(([vatRateBps, grossMinor]) => {
    const divisor = 1 + vatRateBps / 10000;
    const netMinor = divisor > 0 ? Math.round(grossMinor / divisor) : grossMinor;
    return { vatRateBps, netMinor, taxMinor: grossMinor - netMinor, grossMinor };
  });
}

function safe(fn: () => void, context: string): void {
  try {
    fn();
  } catch (err) {
    // Emitting must never break the sale/print path — journal best-effort.
    logger.warn(`[PosEventEmitter] ${context} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const posEventEmitter = {
  /**
   * Emit SaleCompleted + one PaymentCaptured per tender for a finalized local
   * sale. Only call for locally-originated, paid orders (source === 'POS').
   */
  emitOrderFinalized(order: OrderRow, items: OrderItemRow[]): void {
    safe(() => {
      const occurredAt = toIso(order.created_at);
      const localOrderId = order.id;
      const currency = 'PLN';

      const saleRow = posEventOutboxRepo.enqueue({
        dedupeKey: `SaleCompleted:${localOrderId}`,
        eventType: 'SaleCompleted',
        reliabilityClass: RELIABILITY.SaleCompleted,
        salonId: salonId(),
        deviceId: deviceId(),
        localOrderId,
        shiftId: order.shift_id,
        correlationId: localOrderId,
        occurredAt,
        payload: {
          orderNumber: order.order_number,
          businessMode: order.mode || 'retail',
          source: 'pos',
          currency,
          subtotalGrossMinor: order.subtotal ?? order.total ?? 0,
          discountGrossMinor: order.discount ?? 0,
          totalGrossMinor: order.total ?? 0,
          taxSummary: buildTaxSummary(items),
          items: items.map((it) => ({
            lineId: it.id,
            productId: it.variant_id,
            sku: it.sku,
            name: it.name,
            quantity: it.sale_quantity ?? it.quantity,
            unitGrossMinor: it.price,
            lineGrossMinor: it.total,
            vatRateBps: Math.round((it.vat_rate ?? 23) * 100),
          })),
          customer: {
            customerId: order.customer_id,
            nip: order.customer_nip,
            name: order.customer_name,
          },
          staff: { staffId: order.staff_id, staffName: order.staff_name },
        },
      });

      const tenders = parseTenders(order);
      tenders.forEach((tender, idx) => {
        const method = normalizeMethod(tender.method);
        posEventOutboxRepo.enqueue({
          dedupeKey: `PaymentCaptured:${localOrderId}:${idx}`,
          eventType: 'PaymentCaptured',
          reliabilityClass: RELIABILITY.PaymentCaptured,
          salonId: salonId(),
          deviceId: deviceId(),
          localOrderId,
          shiftId: order.shift_id,
          correlationId: localOrderId,
          causationId: saleRow.event_id,
          occurredAt,
          payload: {
            paymentId: `${localOrderId}:tender:${idx}`,
            currency,
            amountMinor: tender.amount,
            method,
            status: 'captured',
            cashReceivedMinor: idx === 0 ? order.payment_amount || null : null,
            changeGivenMinor: idx === 0 ? order.change_amount || null : null,
            terminal: null,
            settlement: settlement(method, occurredAt),
          },
        });
      });
    }, `emitOrderFinalized(${order.id})`);
  },

  /**
   * Emit RefundIssued for a single refund action. `amountMinor` MUST be the
   * delta of THIS refund (not the order's cumulative refund_amount), because the
   * cashflow read model sums every RefundIssued.amountMinor — passing cumulative
   * would double-count on a second partial refund.
   */
  emitRefundIssued(input: {
    localOrderId: string;
    backendOrderId?: string | null;
    amountMinor: number;
    method: string | null;
    tenderAllocations?: Array<{ method: string; amount: number }>;
    reason?: string | null;
    refundRequestId?: string | null;
    refundedAt: string;
    shiftId?: string | null;
    items?: unknown;
    approvedByStaffId?: string | null;
  }): void {
    safe(() => {
      if (!input.amountMinor || input.amountMinor <= 0) return;
      const occurredAt = toIso(input.refundedAt);
      const refundFactId = input.refundRequestId || occurredAt;
      const tenderAllocations = (input.tenderAllocations ?? [])
        .map((tender) => ({
          method: normalizeMethod(tender?.method),
          amountMinor: Math.round(Number(tender?.amount)),
        }))
        .filter((tender) => tender.amountMinor > 0);
      posEventOutboxRepo.enqueue({
        dedupeKey: `RefundIssued:${input.localOrderId}:${refundFactId}`,
        eventType: 'RefundIssued',
        reliabilityClass: RELIABILITY.RefundIssued,
        salonId: salonId(),
        deviceId: deviceId(),
        localOrderId: input.localOrderId,
        shiftId: input.shiftId ?? null,
        correlationId: input.localOrderId,
        occurredAt,
        payload: {
          refundId: `${input.localOrderId}:refund:${refundFactId}`,
          originalLocalOrderId: input.localOrderId,
          originalServerOrderId: input.backendOrderId ?? null,
          currency: 'PLN',
          amountMinor: input.amountMinor,
          method: normalizeMethod(input.method),
          tenderAllocations,
          refundRequestId: input.refundRequestId ?? null,
          reason: input.reason ?? null,
          items: input.items ?? [],
          approvedByStaffId: input.approvedByStaffId ?? null,
        },
      });
    }, `emitRefundIssued(${input.localOrderId})`);
  },

  emitShiftOpened(input: {
    shiftId: string;
    staffId: string | null;
    staffName?: string | null;
    openingCashMinor: number;
    openedAt?: string;
  }): void {
    safe(() => {
      posEventOutboxRepo.enqueue({
        dedupeKey: `ShiftOpened:${input.shiftId}`,
        eventType: 'ShiftOpened',
        reliabilityClass: RELIABILITY.ShiftOpened,
        salonId: salonId(),
        deviceId: deviceId(),
        shiftId: input.shiftId,
        correlationId: input.shiftId,
        occurredAt: toIso(input.openedAt || new Date().toISOString()),
        payload: {
          localShiftId: input.shiftId,
          staffId: input.staffId,
          staffName: input.staffName ?? null,
          currency: 'PLN',
          openingCashMinor: input.openingCashMinor,
          notes: '',
        },
      });
    }, `emitShiftOpened(${input.shiftId})`);
  },

  emitShiftClosed(report: ShiftReport): void {
    safe(() => {
      const expectedCashMinor = report.openingCash + report.cashTotal;
      posEventOutboxRepo.enqueue({
        dedupeKey: `ShiftClosed:${report.shiftId}`,
        eventType: 'ShiftClosed',
        reliabilityClass: RELIABILITY.ShiftClosed,
        salonId: salonId(),
        deviceId: deviceId(),
        shiftId: report.shiftId,
        correlationId: report.shiftId,
        occurredAt: toIso(report.closedAt),
        payload: {
          localShiftId: report.shiftId,
          staffId: null,
          currency: 'PLN',
          closingCashMinor: report.closingCash,
          expectedCashMinor,
          cashDifferenceMinor: report.closingCash - expectedCashMinor,
          summary: {
            salesCount: report.totalOrders,
            grossSalesMinor: report.totalSales + report.totalRefunds + report.totalDiscounts,
            refundsMinor: report.totalRefunds,
            cashSalesMinor: report.cashTotal,
            cardSalesMinor: report.cardTotal,
          },
          notes: '',
        },
      });
    }, `emitShiftClosed(${report.shiftId})`);
  },

  emitFiscalReceiptEmitted(input: {
    orderId: string;
    backendOrderId?: string | null;
    status: 'PRINTED' | 'FAILED' | 'SKIPPED' | string;
    grossTotalMinor?: number | null;
    printerProtocol?: string | null;
    printJobId?: string | null;
    error?: string | null;
    occurredAt?: string;
  }): void {
    safe(() => {
      const status = mapFiscalStatus(input.status);
      const occurredAt = toIso(input.occurredAt || new Date().toISOString());
      posEventOutboxRepo.enqueue({
        dedupeKey: `FiscalReceiptEmitted:${input.orderId}:${input.printJobId || status}`,
        eventType: 'FiscalReceiptEmitted',
        reliabilityClass: RELIABILITY.FiscalReceiptEmitted,
        salonId: salonId(),
        deviceId: deviceId(),
        localOrderId: input.orderId,
        correlationId: input.orderId,
        occurredAt,
        payload: {
          fiscalEventId: `${input.orderId}:fiscal:${input.printJobId || status}`,
          status,
          printerProtocol: input.printerProtocol ?? null,
          totalGrossMinor: input.grossTotalMinor ?? null,
          currency: 'PLN',
          attemptedAt: occurredAt,
          printedAt: status === 'printed' ? occurredAt : null,
          errorMessage: input.error ?? null,
          serverOrderId: input.backendOrderId ?? null,
        },
      });
    }, `emitFiscalReceiptEmitted(${input.orderId})`);
  },

  emitCashDrawerOpened(input: { orderId?: string | null; reason?: string; success: boolean; occurredAt?: string }): void {
    safe(() => {
      const occurredAt = toIso(input.occurredAt || new Date().toISOString());
      posEventOutboxRepo.enqueue({
        dedupeKey: `CashDrawerOpened:${input.orderId || 'manual'}:${occurredAt}`,
        eventType: 'CashDrawerOpened',
        reliabilityClass: RELIABILITY.CashDrawerOpened,
        salonId: salonId(),
        deviceId: deviceId(),
        localOrderId: input.orderId ?? null,
        occurredAt,
        payload: {
          orderId: input.orderId ?? null,
          reason: input.reason ?? 'payment',
          success: !!input.success,
        },
      });
    }, 'emitCashDrawerOpened');
  },

  emitReceiptPrintAttempted(input: {
    printAttemptId: string;
    orderId: string;
    documentType: string;
    printerType: string;
    route?: string | null;
    status: string;
    error?: string | null;
    occurredAt?: string;
  }): void {
    safe(() => {
      posEventOutboxRepo.enqueue({
        dedupeKey: `ReceiptPrintAttempted:${input.printAttemptId}`,
        eventType: 'ReceiptPrintAttempted',
        reliabilityClass: RELIABILITY.ReceiptPrintAttempted,
        salonId: salonId(),
        deviceId: deviceId(),
        localOrderId: input.orderId,
        correlationId: input.orderId,
        occurredAt: toIso(input.occurredAt || new Date().toISOString()),
        payload: {
          documentType: input.documentType,
          printerType: input.printerType,
          route: input.route ?? null,
          status: input.status,
          errorMessage: input.error ?? null,
        },
      });
    }, `emitReceiptPrintAttempted(${input.orderId})`);
  },
};

function mapFiscalStatus(status: string): string {
  switch (String(status || '').toUpperCase()) {
    case 'PRINTED':
      return 'printed';
    case 'FAILED':
      return 'failed';
    case 'SKIPPED':
      return 'skipped';
    case 'NOT_PRINTED':
    case 'NOT_REQUIRED':
      return 'not_required';
    default:
      return 'unknown';
  }
}

function toIso(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  // SQLite datetime('now') stores 'YYYY-MM-DD HH:MM:SS' (UTC, no tz) — normalize.
  const candidate = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
