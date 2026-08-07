/**
 * Server → POS-UI mapping for billiard history and the daily report.
 *
 * The web dashboard and desktop POS must show identical numbers, so both read
 * the same backend endpoints (`GET /billiard/sessions/history`,
 * `GET /billiard/analytics`). The POS renderer components were written against
 * the local SQLite snake_case shape; these pure mappers translate the server's
 * camelCase rows into that shape so the UI stays untouched, and they are the
 * single place the two vocabularies meet (electron + android shim share it).
 */

export interface HistorySessionItemRow {
  id: string;
  name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export interface HistorySessionPaymentRow {
  id: string;
  method: string;
  amount: number;
  createdAt: string;
}

export interface HistorySessionRow {
  id: string;
  resource_id: string | null;
  status: string;
  payment_status: string;
  billing_mode: string;
  guest_count: number;
  started_at: string | null;
  ended_at: string | null;
  total_minutes: number;
  total_charge: number;
  time_charge: number;
  fnb_charge: number;
  package_mode: number;
  package_price: number | null;
  customer_name: string | null;
  tableName: string;
  items: HistorySessionItemRow[];
  payments: HistorySessionPaymentRow[];
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function serverCustomerName(row: any): string | null {
  if (row?.customerName) return String(row.customerName);
  const first = row?.customer?.firstName ?? '';
  const last = row?.customer?.lastName ?? '';
  const joined = `${first} ${last}`.trim();
  return joined || null;
}

export function mapServerHistorySession(row: any): HistorySessionRow {
  const items: HistorySessionItemRow[] = Array.isArray(row?.items)
    ? row.items.map((item: any, index: number) => ({
        id: String(item?.id ?? `${row?.id}-i${index}`),
        name: String(item?.name ?? ''),
        quantity: num(item?.quantity),
        unit_price: num(item?.unitPrice),
        total_price: num(item?.totalPrice ?? num(item?.quantity) * num(item?.unitPrice)),
      }))
    : [];

  const details: any[] = Array.isArray(row?.splitPaymentDetails)
    ? row.splitPaymentDetails
    : [];
  const payments: HistorySessionPaymentRow[] = details.length > 0
    ? details.map((detail: any, index: number) => ({
        id: String(detail?.paymentAttemptId ?? `${row?.id}-p${index}`),
        method: String(detail?.paymentMethod ?? row?.paymentMethod ?? ''),
        amount: num(detail?.amount),
        createdAt: String(detail?.paidAt ?? row?.endedAt ?? ''),
      }))
    : (num(row?.paidAmount) > 0
        ? [{
            id: `${row?.id}-p0`,
            method: String(row?.paymentMethod ?? ''),
            amount: num(row?.paidAmount),
            createdAt: String(row?.endedAt ?? ''),
          }]
        : []);

  return {
    id: String(row?.id ?? ''),
    resource_id: row?.resourceId ?? null,
    status: String(row?.status ?? ''),
    payment_status: String(row?.paymentStatus ?? ''),
    billing_mode: String(row?.billingMode ?? ''),
    guest_count: num(row?.guestCount),
    started_at: row?.startedAt ?? null,
    ended_at: row?.endedAt ?? null,
    total_minutes: num(row?.durationMinutes),
    total_charge: num(row?.totalCharge),
    time_charge: num(row?.timeCharge),
    fnb_charge: num(row?.fnbCharge),
    package_mode: row?.packageMode ? 1 : 0,
    package_price: row?.packagePrice == null ? null : num(row?.packagePrice),
    customer_name: serverCustomerName(row),
    // fnb_only walk-in sales carry the synthetic Walk-in resource; the web
    // shows them as "Retail" — the POS list labels via tableName directly.
    tableName: String(row?.resource?.name ?? ''),
    items,
    payments,
  };
}

/** Shape consumed by DailyReport.tsx (originally written for the local repo). */
export interface DailyReportData {
  summary: {
    totalRevenue: number;
    timeRevenue: number;
    fnbRevenue: number;
    sessionCount: number;
    avgDurationMinutes: number;
    totalGuests: number;
    packageSessionCount: number;
    perMinuteSessionCount: number;
  };
  tableUtilization: Array<{
    resourceId: string;
    tableName: string;
    sessionCount: number;
    totalMinutes: number;
    totalRevenue: number;
  }>;
  topFnbItems: Array<{ name: string; totalQuantity: number; totalRevenue: number }>;
  hourlyBreakdown: Array<{ hour: number; sessionCount: number; revenue: number }>;
  /** Extra (server-only) figures the POS report can surface verbatim. */
  retailRevenue: number;
  retailSessions: number;
  utilizationPercent: number;
}

export function mapServerAnalyticsToDailyReport(a: any): DailyReportData {
  const totalRevenue = num(a?.totalRevenue);
  const fnbRevenue = num(a?.fnbRevenue);
  const retailRevenue = num(a?.retailRevenue);
  return {
    summary: {
      totalRevenue,
      // The server has no explicit time bucket; fnbRevenue already CONTAINS
      // walk-in retail (retail sessions are fnb_only), so time = total − fnb.
      timeRevenue: Math.max(0, totalRevenue - fnbRevenue),
      fnbRevenue,
      sessionCount: num(a?.totalSessions),
      avgDurationMinutes: num(a?.avgSessionDuration),
      // Not reported by the analytics endpoint — shown as 0 on the POS.
      totalGuests: 0,
      packageSessionCount: 0,
      perMinuteSessionCount: 0,
    },
    tableUtilization: (Array.isArray(a?.revenueByTable) ? a.revenueByTable : []).map(
      (table: any) => ({
        resourceId: String(table?.resourceId ?? ''),
        tableName: String(table?.resourceName ?? ''),
        sessionCount: num(table?.sessions),
        totalMinutes: Math.round(num(table?.avgDuration) * num(table?.sessions)),
        totalRevenue: num(table?.revenue),
      }),
    ),
    topFnbItems: (Array.isArray(a?.topFnbItems) ? a.topFnbItems : []).map((item: any) => ({
      name: String(item?.name ?? ''),
      totalQuantity: num(item?.quantity),
      totalRevenue: num(item?.revenue),
    })),
    hourlyBreakdown: (Array.isArray(a?.peakHours) ? a.peakHours : []).map((slot: any) => ({
      hour: num(slot?.hour),
      sessionCount: num(slot?.sessions),
      // peakHours carries no revenue; the chart falls back to session bars.
      revenue: 0,
    })),
    retailRevenue,
    retailSessions: num(a?.retailSessions),
    utilizationPercent: num(a?.utilizationPercent),
  };
}
