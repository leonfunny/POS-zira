/**
 * Remote receipt-print coordinator — packet E1a of the Android parity port.
 *
 * Replaces the Wave-1 `payment.printReceipt` stub (`{ success:true,
 * receiptPrinted:true }`) with a REAL remote-print coordinator that submits a
 * receipt COPY print job to the Windows agent over the existing STAFF-JWT print
 * routes, polls it to a terminal state, and returns the real
 * printed / failed / skipped outcome — WITHOUT regressing the pilot UX for
 * salons that have no Windows agent (no printer → Wave-1 skip, no recovery
 * overlay).
 *
 * See docs/android-pos/EXPANSION_PLAN_2026-07-19.md (Wave E1a) and
 * docs/android-pos/SHIM_CONTRACT_S1.md §2.F / §2.I.
 *
 * ─── Source parity (Windows is the reference) ─────────────────────────────
 * The coordinator is a faithful, fetch-only port of the Windows shared-receipt
 * route (the path `paymentController.printReceipt` takes when this device has no
 * LOCAL receipt printer — exactly the Android situation). Citations reference
 * the Windows source of truth:
 *   - submit flow:              src/main/printing/shared-receipt-printer.ts:266-412
 *   - receipt role resolution:  shared-receipt-printer.ts:25,296 (SELF_CHECKOUT_RECEIPT)
 *   - negative-TTL assignment:  shared-receipt-printer.ts:26-28,298-302
 *   - idempotency key:          shared-print-retry-policy.ts:99-111
 *   - resume-instead-of-recreate: shared-receipt-printer.ts:38-54,331-344
 *   - status classification:    shared-print-retry-policy.ts:24-97
 *   - poll loop + budgets:      shared-receipt-printer.ts:159-187,202,236
 *   - receipt payload build:    src/main/pos/payment-controller.ts:373-423,184-203
 *
 * ─── Hard rails (unchanged) ───────────────────────────────────────────────
 * Staff JWT only — NEVER the `pa_` API key, NEVER `/print-agent/connect`, NEVER
 * the agent socket. Fiscal print stays DISABLED (backend-gated P0-FISCAL); this
 * coordinator is receipt COPY only. The api-client methods it calls
 * (listPrinterAssignments / createPrintJob / getPrintJobStatus) are the staff-JWT
 * variants, never the `*WithApiKey` ones.
 *
 * ─── Deliberate divergences from Windows (documented) ─────────────────────
 * 1. NO safe-retry. Windows auto-retries a SAFE_BEFORE_PRINT failure once via
 *    safeRetryPrintJob (shared-receipt-printer.ts:241-263). E1a does NOT port
 *    safe-retry (it is not in the enumerated port surface, and the packet says
 *    "NEVER auto-retry an uncertain job"). A safe-before-print failure surfaces
 *    as `receiptPrinted:false, reason:'safe-before-print'` so the cashier can
 *    tap Reprint (a fresh job) — nothing printed yet, so a manual reprint is
 *    safe and idempotent.
 * 2. The no-printer outcome reports `receiptPrinted:true` (Wave-1 skip), NOT
 *    `false` like Windows. A Windows till always has a receipt printer, so
 *    `false` is correct there; on Android most pilot salons have no agent, and
 *    `false` would throw the recovery overlay on every CASH sale. This is the
 *    central E1a UX decision (EXPANSION_PLAN E1a).
 * 3. The assignment lookup is cached for BOTH the positive and the negative
 *    result (Windows only negative-caches an unavailable endpoint). A
 *    battery-constrained mobile device should not make an HTTP round-trip on
 *    every sale for a printer assignment that rarely changes mid-shift.
 * 4. The receipt payload uses the stored order-item name (no PL-translation
 *    resolution) and omits the catalog-reprice fallback — both are Windows
 *    refinements that depend on catalog data this port does not carry on the
 *    receipt path. The net→gross correction (orderItemsLookNetPriced) IS ported
 *    because it is a totals-correctness issue, not cosmetic.
 */

import {
  PrinterType,
  PrintJobType,
} from '../../../shared/types';
import type {
  AgentConfig,
  CreatePrintJobRequest,
  CreatePrintJobResponse,
  PrintJobFailureClass,
  ReceiptData,
  ReceiptItem,
  SalonPrinterRole,
} from '../../../shared/types';
import type { PosApiClient } from '../port/api-client';
import type { AndroidDatabase } from './db/db';
import { createOrderRepo } from './db/order-repo';
import type { ShimConfigStore } from './config-store';
import type { RemoteFiscalPrintResult, RemotePrinterStatus, RemoteReceiptPrintResult } from './transport';

// ─── Constants (ported from shared-receipt-printer.ts / shared-print-retry-policy.ts) ─

/** The salon printer role the Windows shared-receipt route binds to
 *  (shared-receipt-printer.ts:25). The Android device is in the same "no local
 *  printer, print on the salon's shared agent printer" situation, so it resolves
 *  the same role. */
const RECEIPT_PRINTER_ROLE: SalonPrinterRole = 'SELF_CHECKOUT_RECEIPT';

/** The salon printer role the Windows shared-FISCAL route binds to
 *  (shared-fiscal-printer.ts:24 — `FISCAL_RECEIPT`). A Sunmi submits a fiscal
 *  job to the salon's print-agent (ELZAB) exactly like a second Windows POS:
 *  staff JWT, the SAME `/print-agent/jobs` route E1a uses. No Android fiscal
 *  driver, no ELZAB on the device — Plan A (the ELZAB stays on the agent box). */
const FISCAL_PRINTER_ROLE: SalonPrinterRole = 'FISCAL_RECEIPT';

/** Negative-TTL on the assignment endpoint / lookup result
 *  (shared-receipt-printer.ts:26 — Windows uses 60s for an unavailable endpoint;
 *  E1a caches BOTH the positive and negative result for this window). */
const DEFAULT_ASSIGNMENT_CACHE_TTL_MS = 60_000;
/** Backend hold passed as `timeoutMs` on the create body
 *  (shared-print-retry-policy.ts:13). */
const DEFAULT_COMPLETION_TIMEOUT_MS = 10_000;
/** Total client-side budget for ONE receipt submission
 *  (shared-print-retry-policy.ts:21 — real shared-till jobs run 9–20s). */
const DEFAULT_TOTAL_WAIT_MS = 30_000;
/** Poll interval while a job is still in flight (shared-receipt-printer.ts:176). */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Cap the resume registry so a long session cannot leak memory
 *  (shared-receipt-printer.ts:38 KNOWN_RECEIPT_JOBS_MAX). */
const KNOWN_JOBS_MAX = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Status helpers (ported from shared-print-retry-policy.ts:24-47) ─────────

function normalizeStatus(result?: CreatePrintJobResponse | null): string {
  return String(result?.status || (result as { finalStatus?: string } | null)?.finalStatus || '').toUpperCase();
}

function getJobId(result?: CreatePrintJobResponse | null): string | undefined {
  const value = result?.jobId || result?.id;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getFailureClass(result?: CreatePrintJobResponse | null): PrintJobFailureClass | null {
  const value = String(result?.failureClass || '').toUpperCase();
  if (value === 'SAFE_BEFORE_PRINT' || value === 'UNCERTAIN_AFTER_PRINT' || value === 'FINAL') {
    return value;
  }
  return null;
}

/** ported from shared-print-retry-policy.ts:99-111 (kind always 'receipt', purpose 'order'). */
function buildReceiptIdempotencyKey(machineId: string | undefined, orderId: string): string | undefined {
  const cleanMachineId = String(machineId || '').trim();
  const cleanOrderId = String(orderId || '').trim();
  if (!cleanMachineId || !cleanOrderId) return undefined;
  return `pos-receipt:${cleanMachineId}:${cleanOrderId}:order:v1`;
}

/** ported from shared-print-retry-policy.ts:99-111 + shared-fiscal-printer.ts:321
 *  (kind 'fiscal', purpose 'default'). The `fiscal` prefix + `default` purpose
 *  keep this key disjoint from the receipt-COPY key for the SAME order
 *  (buildReceiptIdempotencyKey → `pos-receipt:…:order:v1`), so an order that
 *  prints BOTH a receipt copy AND a fiscal receipt gets two independent jobs —
 *  a repeated fiscal tap resumes the fiscal job, never the receipt job, and a
 *  duplicate fiscal document is never created. */
function buildFiscalIdempotencyKey(machineId: string | undefined, orderId: string): string | undefined {
  const cleanMachineId = String(machineId || '').trim();
  const cleanOrderId = String(orderId || '').trim();
  if (!cleanMachineId || !cleanOrderId) return undefined;
  return `pos-fiscal:${cleanMachineId}:${cleanOrderId}:default:v1`;
}

// ─── Receipt payload build (ported from payment-controller.ts) ──────────────

/** payment-controller.ts:159-162 — net grosze → gross grosze for a VAT rate. */
function grossFromNet(netGrosze: number, vatRate: number): number {
  if (netGrosze <= 0 || vatRate <= 0) return netGrosze;
  return Math.round((netGrosze * (100 + vatRate)) / 100);
}

/** payment-controller.ts:164-174 — the order row stored net-priced lines + tax,
 *  so the receipt must gross them up or the line totals would not sum to total. */
function orderItemsLookNetPriced(
  order: { subtotal?: number; tax?: number; total?: number; discount?: number },
  items: Array<{ total?: number }>,
): boolean {
  const itemTotal = items.reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  const grossSubtotal = (Number(order.total) || 0) + (Number(order.discount) || 0);
  return (
    itemTotal > 0 &&
    (Number(order.tax) || 0) > 0 &&
    grossSubtotal > 0 &&
    Math.abs(itemTotal + (Number(order.tax) || 0) - grossSubtotal) <= 1
  );
}

/** payment-controller.ts:184-203 (minus the PL-name resolution + catalog reprice
 *  fallback — see divergence #4). Items are integer grosze; net-priced orders
 *  are grossed up so the printed line totals match `total`. */
function buildReceiptItems(
  orderItems: Array<Record<string, unknown>>,
  itemsLookNetPriced: boolean,
): ReceiptItem[] {
  return orderItems.map((i) => {
    const price = Number(i.price) || 0;
    const lineTotal = Number(i.total) || 0;
    const vatRate = Number(i.vat_rate) || 0;
    const unitPrice = itemsLookNetPriced ? grossFromNet(price, vatRate) : price;
    const totalPrice = itemsLookNetPriced ? grossFromNet(lineTotal, vatRate) : lineTotal;
    const unit = typeof i.sale_unit === 'string' && i.sale_unit ? i.sale_unit : undefined;
    const sku = typeof i.sku === 'string' && i.sku ? i.sku : undefined;
    return {
      name: String(i.name ?? ''),
      quantity: Number(i.quantity) || 0,
      unitPrice,
      totalPrice,
      vatRate,
      ...(sku ? { sku } : {}),
      ...(unit ? { unit } : {}),
    };
  });
}

/** payment-controller.ts:124-130 — surface split tenders only when >1. */
function parseTenders(order: { payment_tenders?: string | null }): Array<{ method: string; amount: number }> | undefined {
  if (!order.payment_tenders) return undefined;
  try {
    const tenders = JSON.parse(order.payment_tenders);
    return Array.isArray(tenders) && tenders.length > 1 ? tenders : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the ReceiptData for a local order — ported from
 * payment-controller.ts:373-423 (buildSaleReceiptData). Returns null when the
 * order is absent (the coordinator maps that to a `no-order` outcome).
 */
function buildSaleReceiptData(
  orderId: string,
  order: Record<string, any> | null,
  items: Array<Record<string, any>>,
  salonName: string | undefined,
): ReceiptData | null {
  if (!order) return null;
  const itemsLookNetPriced = orderItemsLookNetPriced(order, items);
  const subtotal = itemsLookNetPriced
    ? (Number(order.total) || 0) + (Number(order.discount) || 0)
    : Number(order.subtotal) || 0;
  const discount = Number(order.discount) || 0;
  return {
    orderId,
    orderNumber: order.order_number || orderId.substring(0, 8),
    salonName,
    items: buildReceiptItems(items, itemsLookNetPriced),
    payment: {
      method: order.payment_method || 'CASH',
      amount: Number(order.payment_amount) || 0,
    },
    subtotal,
    ...(discount > 0 ? { discount } : {}),
    total: Number(order.total) || 0,
    ...(order.staff_name ? { cashierName: order.staff_name } : {}),
    ...(order.customer_name ? { customerName: order.customer_name } : {}),
    ...(order.customer_nip ? { customerNip: order.customer_nip } : {}),
    ...(parseTenders(order) ? { tenders: parseTenders(order) } : {}),
  };
}

// ─── Terminal-status mapping ───────────────────────────────────────────────

interface StatusMapping {
  terminal: boolean;
  result: RemoteReceiptPrintResult;
}

/** A cached assignment-lookup result, per role (divergence #3 — cached in BOTH
 *  the positive and the negative direction for the TTL window). */
interface AssignmentCacheEntry {
  printerId: string | null;
  error?: string;
  expiresAt: number;
}

/**
 * Map a CreatePrintJobResponse to a coordinator outcome. Ported from
 * classifySharedPrintResponse (shared-print-retry-policy.ts:49-97), simplified
 * for receipt COPY with NO auto-retry (divergence #1):
 *  - COMPLETED / PRINTED / receiptPrinted:true → PRINTED.
 *  - a still-in-flight status (SENT/PRINTING/PENDING/RESERVED/empty) → not
 *    terminal (the caller keeps polling until the budget expires, then it
 *    becomes UNCERTAIN).
 *  - TIMEOUT / timedOut / UNCERTAIN_AFTER_PRINT → UNCERTAIN (reason 'unknown').
 *  - FAILED + SAFE_BEFORE_PRINT → reason 'safe-before-print' (no auto-retry).
 *  - FAILED (other) / CANCELLED → reason 'failed'.
 */
function mapStatus(
  result: CreatePrintJobResponse | null | undefined,
  jobId: string | undefined,
  printerId: string | undefined,
): StatusMapping {
  const status = normalizeStatus(result);
  const failureClass = getFailureClass(result);
  const ok = (r: RemoteReceiptPrintResult): StatusMapping => ({ terminal: true, result: r });

  if (status === 'COMPLETED' || status === 'PRINTED' || (result as { receiptPrinted?: boolean } | null)?.receiptPrinted === true) {
    return ok({ success: true, receiptPrinted: true, jobId, ...(printerId ? { printerId } : {}) });
  }

  if (status === 'TIMEOUT' || result?.timedOut === true || failureClass === 'UNCERTAIN_AFTER_PRINT') {
    return ok({
      success: true,
      receiptPrinted: false,
      reason: 'unknown',
      jobId,
      error: 'print outcome uncertain (timeout / after-print)',
      ...(printerId ? { printerId } : {}),
    });
  }

  if (status === 'FAILED' || status === 'CANCELLED') {
    const errorMessage = String(result?.errorMessage || result?.message || result?.retryBlockedReason || status);
    if (failureClass === 'SAFE_BEFORE_PRINT') {
      return ok({
        success: true,
        receiptPrinted: false,
        reason: 'safe-before-print',
        jobId,
        error: errorMessage,
        ...(printerId ? { printerId } : {}),
      });
    }
    return ok({
      success: true,
      receiptPrinted: false,
      reason: 'failed',
      jobId,
      error: errorMessage,
      ...(printerId ? { printerId } : {}),
    });
  }

  // SENT / PRINTING / PENDING / RESERVED / unrecognized / empty → still in flight.
  return {
    terminal: false,
    result: { success: true, receiptPrinted: false, reason: 'unknown', jobId, ...(printerId ? { printerId } : {}) },
  };
}

/**
 * Map a CreatePrintJobResponse to a FISCAL coordinator outcome — the fiscal twin
 * of `mapStatus`. Ported from classifySharedPrintResponse('FISCAL_RECEIPT', …)
 * (shared-print-retry-policy.ts:49-97) with the FISCAL retry decision collapsed
 * to "NEVER auto-retry" (divergence #1): Windows auto-retries a SAFE_BEFORE_PRINT
 * fiscal failure via safeRetryPrintJob (shared-fiscal-printer.ts:113-128,184-217),
 * but the packet forbids auto-retrying an uncertain fiscal job, so E-FISCAL does
 * NOT port safe-retry. FISCAL is legal/money, so the table is explicit:
 *
 *  ──────────────────────────────────────────────────────────────────────────
 *   terminal status / signal              →  fiscalPrinted   reason
 *  ──────────────────────────────────────────────────────────────────────────
 *   COMPLETED / PRINTED / *Printed:true   →  true            —
 *   FAILED + SAFE_BEFORE_PRINT            →  false           'safe-before-print'
 *   FAILED (other) / CANCELLED            →  false           'failed'
 *   TIMEOUT / timedOut                    →  false           'unknown' (STOP_RECONCILE)
 *   UNCERTAIN_AFTER_PRINT                 →  false           'unknown' (STOP_RECONCILE)
 *   SENT/PRINTING/PENDING/RESERVED/∅      →  (not terminal — keep polling)
 *  ──────────────────────────────────────────────────────────────────────────
 *
 * `success` is ALWAYS true on a terminal mapping (mirrors the Windows IPC
 * try/catch — the coordinator ran to completion; `fiscalPrinted` carries the
 * legal outcome). The only `success:false` is a create that threw before the
 * agent accepted the job (handled in runRequestFiscalPrint, not here).
 */
function mapFiscalStatus(
  result: CreatePrintJobResponse | null | undefined,
  jobId: string | undefined,
  printerId: string | undefined,
): { terminal: boolean; result: RemoteFiscalPrintResult } {
  const status = normalizeStatus(result);
  const failureClass = getFailureClass(result);
  const ok = (r: RemoteFiscalPrintResult): { terminal: true; result: RemoteFiscalPrintResult } => ({ terminal: true, result: r });
  const printedFlag =
    (result as { receiptPrinted?: boolean } | null)?.receiptPrinted === true
    || (result as { fiscalPrinted?: boolean } | null)?.fiscalPrinted === true;

  if (status === 'COMPLETED' || status === 'PRINTED' || printedFlag) {
    return ok({ success: true, fiscalPrinted: true, jobId, ...(printerId ? { printerId } : {}) });
  }

  // TIMEOUT / timedOut / UNCERTAIN_AFTER_PRINT → UNKNOWN. NEVER auto-retry an
  // uncertain fiscal job (shared-print-retry-policy.ts:65-77 FISCAL →
  // STOP_RECONCILE_REQUIRED): the fiscal paper may already have come out, so a
  // re-submit could print a SECOND fiscal document. The cashier must reconcile
  // the till manually before any reissue.
  if (status === 'TIMEOUT' || result?.timedOut === true || failureClass === 'UNCERTAIN_AFTER_PRINT') {
    return ok({
      success: true,
      fiscalPrinted: false,
      reason: 'unknown',
      jobId,
      error: 'fiscal print outcome uncertain (timeout / after-print) — reconcile before retrying',
      ...(printerId ? { printerId } : {}),
    });
  }

  if (status === 'FAILED' || status === 'CANCELLED') {
    const errorMessage = String(result?.errorMessage || result?.message || result?.retryBlockedReason || status);
    if (failureClass === 'SAFE_BEFORE_PRINT') {
      // Nothing fiscal printed yet — a fresh fiscal reissue is the cashier's
      // MANUAL action (a safe reprint; NOT an auto-retry of the uncertain path).
      return ok({
        success: true,
        fiscalPrinted: false,
        reason: 'safe-before-print',
        jobId,
        error: errorMessage,
        ...(printerId ? { printerId } : {}),
      });
    }
    return ok({
      success: true,
      fiscalPrinted: false,
      reason: 'failed',
      jobId,
      error: errorMessage,
      ...(printerId ? { printerId } : {}),
    });
  }

  // SENT / PRINTING / PENDING / RESERVED / unrecognized / empty → still in flight.
  return {
    terminal: false,
    result: { success: true, fiscalPrinted: false, reason: 'unknown', jobId, ...(printerId ? { printerId } : {}) },
  };
}

// ─── Coordinator ───────────────────────────────────────────────────────────

export interface RemotePrintCoordinatorOptions {
  /** The staff-JWT api-client (owns token refresh-on-401). */
  client: PosApiClient;
  /** Lazy SQL.js handle (the coordinator reads the local order + items). */
  db: () => Promise<AndroidDatabase>;
  /** Config store — salonName for the receipt header, machineId for the idempotency key. */
  configStore: ShimConfigStore;
  /** Override the device id used in the idempotency key (defaults to the configured machineId). */
  machineId?: string;
  assignmentCacheTtlMs?: number;
  completionTimeoutMs?: number;
  totalWaitMs?: number;
  pollIntervalMs?: number;
}

export interface RemotePrintCoordinator {
  requestReceiptPrint(orderId: string, options?: { isReprint?: boolean; openDrawer?: boolean }): Promise<RemoteReceiptPrintResult>;
  /** Submit (or resume) a FISCAL receipt print — the fiscal twin of
   *  requestReceiptPrint (packet E-FISCAL). Same staff-JWT `/print-agent/jobs`
   *  route, role FISCAL_RECEIPT, printerType FISCAL. NEVER auto-retries an
   *  uncertain outcome (legal/money). */
  requestFiscalPrint(orderId: string): Promise<RemoteFiscalPrintResult>;
  getPrinterStatus(forceRefresh?: boolean): Promise<RemotePrinterStatus>;
  /** Resolve the salon's FISCAL printer (diagnostics / `hasFiscalPrinter`). */
  getFiscalPrinterStatus(forceRefresh?: boolean): Promise<RemotePrinterStatus>;
}

/**
 * Build the remote receipt-print coordinator. Owns: the assignment-lookup cache
 * (positive + negative, TTL-bounded), the per-order job-resume registry +
 * in-flight coalescing (idempotency), and the bounded poll loop that maps a job
 * to a terminal printed/failed/unknown outcome.
 */
export function createRemotePrintCoordinator(options: RemotePrintCoordinatorOptions): RemotePrintCoordinator {
  const { client, db, configStore } = options;
  const assignmentCacheTtlMs = options.assignmentCacheTtlMs ?? DEFAULT_ASSIGNMENT_CACHE_TTL_MS;
  const completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
  const totalWaitMs = options.totalWaitMs ?? DEFAULT_TOTAL_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  /** Cached assignment lookup, PER ROLE (printerId found OR null with an error).
   *  Keyed by role so the RECEIPT cache (E1a) and the FISCAL cache (E-FISCAL)
   *  stay independent — a salon can have one and not the other, and each is
   *  negative-cached for the TTL without the other's lookup poisoning it. The
   *  RECEIPT entry behaves identically to the pre-fiscal single-slot cache
   *  (it is now just `resolvePrinterByRole(RECEIPT_PRINTER_ROLE)`). */
  const assignmentCacheByRole = new Map<string, AssignmentCacheEntry>();

  /** orderId → jobId resume registry (initial POS receipts only; divergence: keyed
   *  by orderId since one device has one initial-receipt job per order). */
  const knownJobs = new Map<string, string>();
  /** E-FISCAL: orderId → fiscal jobId resume registry. SEPARATE from knownJobs so
   *  a receipt-copy tap and a fiscal tap for the SAME order each resume their OWN
   *  job — a repeated printFiscalReceipt reuses the fiscal job and never creates a
   *  duplicate fiscal document (shared-fiscal-printer.ts resume parity). */
  const knownFiscalJobs = new Map<string, string>();

  /** Coalesces concurrent/repeated prints for the same order+op so they share ONE
   *  create+poll cycle (the single-flight pattern used for refresh + order-sync). */
  const inFlight = new Map<string, Promise<RemoteReceiptPrintResult>>();
  /** E-FISCAL: single-flight for fiscal prints (key `${orderId}#fiscal`). */
  const inFlightFiscal = new Map<string, Promise<RemoteFiscalPrintResult>>();

  const salonName = (): string | undefined => configStore.getRawConfig().salonName ?? undefined;
  const machineId = (): string | undefined => {
    const configured = String(
      (configStore.getRawConfig() as AgentConfig & { machineId?: string | null }).machineId ?? '',
    ).trim();
    return configured || options.machineId || undefined;
  };

  /** Remember an orderId → jobId binding (LRU-bounded, shared-receipt-printer.ts:46-54). */
  const rememberJob = (orderId: string, jobId: string): void => {
    if (knownJobs.has(orderId)) knownJobs.delete(orderId);
    knownJobs.set(orderId, jobId);
    while (knownJobs.size > KNOWN_JOBS_MAX) {
      const oldest = knownJobs.keys().next().value;
      if (oldest === undefined) break;
      knownJobs.delete(oldest);
    }
  };
  /** E-FISCAL: remember an orderId → fiscal jobId binding (same LRU bound, own map). */
  const rememberFiscalJob = (orderId: string, jobId: string): void => {
    if (knownFiscalJobs.has(orderId)) knownFiscalJobs.delete(orderId);
    knownFiscalJobs.set(orderId, jobId);
    while (knownFiscalJobs.size > KNOWN_JOBS_MAX) {
      const oldest = knownFiscalJobs.keys().next().value;
      if (oldest === undefined) break;
      knownFiscalJobs.delete(oldest);
    }
  };

  /**
   * Resolve the salon printer bound to `role` via the assignment endpoint, cached
   * for `assignmentCacheTtlMs` in BOTH directions (divergence #3). A 404/501
   * (endpoint not deployed for this salon), an empty assignment list, or any
   * network error all resolve to `printerId:null` → the coordinator skips with no
   * job. The per-role cache makes the repeat no-printer path zero-HTTP for the TTL
   * window. Generalized from the E1a receipt-only `resolveReceiptPrinter` — the
   * RECEIPT behavior + cache are unchanged (it is now `resolvePrinterByRole(
   * RECEIPT_PRINTER_ROLE)`); the FISCAL path resolves `FISCAL_RECEIPT`
   * (shared-fiscal-printer.ts:24,250) into its OWN cache slot.
   */
  const resolvePrinterByRole = async (
    role: SalonPrinterRole,
    forceRefresh = false,
  ): Promise<{ printerId: string | null; error?: string; cached: boolean }> => {
    const now = Date.now();
    const cached = assignmentCacheByRole.get(role);
    if (!forceRefresh && cached && cached.expiresAt > now) {
      return { printerId: cached.printerId, error: cached.error, cached: true };
    }
    let printerId: string | null = null;
    let error: string | undefined;
    try {
      const response = await client.listPrinterAssignments();
      const match = response.assignments.find(
        (a) => String(a?.role || '').toUpperCase() === String(role).toUpperCase(),
      );
      printerId = match?.printerId ?? null;
    } catch (e: unknown) {
      // 404/501 (endpoint not deployed), network, 5xx, or auth → no remote
      // printer resolvable THIS attempt. Cache the negative result so a flaky
      // endpoint does not get hammered on every sale (shared-receipt-printer.ts:298-302).
      error = e instanceof Error ? e.message : String(e);
    }
    assignmentCacheByRole.set(role, { printerId, error, expiresAt: now + assignmentCacheTtlMs });
    return { printerId, error, cached: false };
  };

  /**
   * Poll a job to a terminal status within `totalWaitMs` (shared-receipt-printer.ts:159-187).
   * `initial` is the create-response (or a resumed status); the loop polls
   * getPrintJobStatus every `pollIntervalMs` until terminal or the budget is
   * exhausted. A budget exhaustion while still in flight → UNCERTAIN (reason
   * 'unknown'); a status-poll network failure → UNCERTAIN. NEVER auto-retries
   * (divergence #1).
   */
  const resolveFinal = async (
    initial: CreatePrintJobResponse,
    jobId: string | undefined,
    printerId: string | undefined,
  ): Promise<RemoteReceiptPrintResult> => {
    let current = initial;
    const deadline = Date.now() + totalWaitMs;
    for (;;) {
      const { terminal, result } = mapStatus(current, jobId, printerId);
      if (terminal) return result;
      // Still in flight. No jobId to poll, or budget exhausted → uncertain.
      if (!jobId || Date.now() >= deadline) {
        return {
          success: true,
          receiptPrinted: false,
          reason: 'unknown',
          jobId,
          error: 'receipt job did not reach a terminal state before the wait budget elapsed',
          ...(printerId ? { printerId } : {}),
        };
      }
      await delay(pollIntervalMs);
      try {
        current = await client.getPrintJobStatus(jobId);
      } catch (e: unknown) {
        // A status-poll failure (network/5xx) is UNCERTAIN — the paper may yet
        // come out. Do not auto-retry; surface reason 'unknown'.
        return {
          success: true,
          receiptPrinted: false,
          reason: 'unknown',
          jobId,
          error: e instanceof Error ? e.message : String(e),
          ...(printerId ? { printerId } : {}),
        };
      }
    }
  };

  /** Resume a known job by polling its status (idempotent reuse). */
  const resumeJob = async (jobId: string, printerId: string | undefined): Promise<RemoteReceiptPrintResult> => {
    try {
      const status = await client.getPrintJobStatus(jobId);
      return await resolveFinal(status, jobId, printerId);
    } catch (e: unknown) {
      return {
        success: true,
        receiptPrinted: false,
        reason: 'unknown',
        jobId,
        error: e instanceof Error ? e.message : String(e),
        ...(printerId ? { printerId } : {}),
      };
    }
  };

  /** The actual print workflow (runs under the in-flight coalescer). */
  const runRequestPrint = async (
    orderId: string,
    isReprint: boolean,
    openDrawer: boolean,
  ): Promise<RemoteReceiptPrintResult> => {
    const { printerId } = await resolvePrinterByRole(RECEIPT_PRINTER_ROLE);
    if (!printerId) {
      // No remote receipt printer for this salon → Wave-1 skip. The receipt COPY
      // is reported PRINTED so PaymentModal does not enter the recovery overlay
      // on every CASH sale (divergence #2 / EXPANSION_PLAN E1a).
      return { success: true, receiptPrinted: true, skipped: true, reason: 'no-printer' };
    }

    const orderRepo = createOrderRepo(await db());
    const order = orderRepo.getById(orderId);
    const items = orderRepo.getItemsByOrderId(orderId);
    const receiptData = buildSaleReceiptData(orderId, order, items, salonName());
    if (!receiptData) {
      return { success: true, receiptPrinted: false, reason: 'no-order', error: `order ${orderId} not found` };
    }
    if (isReprint) {
      receiptData.isReprint = true;
      if (order?.created_at) receiptData.originalDate = order.created_at;
    }

    // Idempotent resume — INITIAL POS receipt only. A known job for this order
    // is polled, not re-created, so a repeated tap (or the modal's own retry)
    // never creates a duplicate job (shared-receipt-printer.ts:331-344).
    if (!isReprint) {
      const knownJobId = knownJobs.get(orderId);
      if (knownJobId) {
        return await resumeJob(knownJobId, printerId);
      }
    }

    const referenceType = isReprint ? 'POS_RECEIPT_REPRINT' : 'POS_RECEIPT';
    const idempotencyKey = isReprint ? undefined : buildReceiptIdempotencyKey(machineId(), orderId);
    const body: CreatePrintJobRequest = {
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.RECEIPT,
      printerId,
      payload: receiptData,
      referenceType,
      referenceId: orderId,
      ...(openDrawer ? { openDrawer: true } : {}),
      // Only the initial POS receipt asks the backend to hold for completion +
      // carries the idempotency key (shared-receipt-printer.ts:310-323). Reprints
      // are fire-and-forget fresh jobs.
      ...(isReprint ? {} : { waitForCompletion: true, timeoutMs: completionTimeoutMs }),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };

    let createResp: CreatePrintJobResponse;
    try {
      createResp = await client.createPrintJob(body);
    } catch (e: unknown) {
      // Create failed before the agent accepted the job (network / 4xx / 5xx).
      // Nothing printed; the cashier can retry. Surface as a plain failure.
      return {
        success: false,
        receiptPrinted: false,
        reason: 'failed',
        error: e instanceof Error ? e.message : String(e),
        ...(printerId ? { printerId } : {}),
      };
    }

    const jobId = getJobId(createResp);
    if (!isReprint && jobId) rememberJob(orderId, jobId);
    return await resolveFinal(createResp, jobId, printerId);
  };

  // ─── Fiscal receipt print (E-FISCAL) ──────────────────────────────────────
  // The fiscal twin of runRequestPrint. SAME staff-JWT `/print-agent/jobs` route,
  // SAME order payload (buildSaleReceiptData), but: role FISCAL_RECEIPT,
  // printerType FISCAL, referenceType POS_FISCAL_RECEIPT, a 'fiscal' idempotency
  // key (disjoint from the receipt-copy key), and a fiscal status mapping that
  // NEVER auto-retries an uncertain outcome (shared-fiscal-printer.ts:301-369
  // parity, minus the safe-retry loop — divergence #1 / packet rail).

  /** Poll a fiscal job to a terminal status within `totalWaitMs`. Identical
   *  plumbing to resolveFinal, but via mapFiscalStatus → RemoteFiscalPrintResult.
   *  NEVER auto-retries (a fiscal re-submit on an uncertain job could print a
   *  SECOND fiscal document — STOP_RECONCILE_REQUIRED). */
  const resolveFinalFiscal = async (
    initial: CreatePrintJobResponse,
    jobId: string | undefined,
    printerId: string | undefined,
  ): Promise<RemoteFiscalPrintResult> => {
    let current = initial;
    const deadline = Date.now() + totalWaitMs;
    for (;;) {
      const { terminal, result } = mapFiscalStatus(current, jobId, printerId);
      if (terminal) return result;
      // Still in flight. No jobId to poll, or budget exhausted → uncertain.
      if (!jobId || Date.now() >= deadline) {
        return {
          success: true,
          fiscalPrinted: false,
          reason: 'unknown',
          jobId,
          error: 'fiscal job did not reach a terminal state before the wait budget elapsed',
          ...(printerId ? { printerId } : {}),
        };
      }
      await delay(pollIntervalMs);
      try {
        current = await client.getPrintJobStatus(jobId);
      } catch (e: unknown) {
        // A status-poll failure is UNCERTAIN — the fiscal paper may yet come
        // out. NEVER auto-retry; surface reason 'unknown' for manual reconcile.
        return {
          success: true,
          fiscalPrinted: false,
          reason: 'unknown',
          jobId,
          error: e instanceof Error ? e.message : String(e),
          ...(printerId ? { printerId } : {}),
        };
      }
    }
  };

  /** Resume a known fiscal job by polling its status (idempotent reuse — a
   *  repeated printFiscalReceipt tap reuses the SAME fiscal job, never creates a
   *  duplicate fiscal document). */
  const resumeFiscalJob = async (jobId: string, printerId: string | undefined): Promise<RemoteFiscalPrintResult> => {
    try {
      const status = await client.getPrintJobStatus(jobId);
      return await resolveFinalFiscal(status, jobId, printerId);
    } catch (e: unknown) {
      return {
        success: true,
        fiscalPrinted: false,
        reason: 'unknown',
        jobId,
        error: e instanceof Error ? e.message : String(e),
        ...(printerId ? { printerId } : {}),
      };
    }
  };

  /** The actual fiscal print workflow (runs under the fiscal in-flight coalescer). */
  const runRequestFiscalPrint = async (orderId: string): Promise<RemoteFiscalPrintResult> => {
    const { printerId } = await resolvePrinterByRole(FISCAL_PRINTER_ROLE);
    if (!printerId) {
      // No fiscal printer assigned → skip (hasFiscalPrinter gates this call
      // anyway). fiscalPrinted:false — a FALSE fiscal claim is a legal issue, so
      // unlike the receipt COPY (which reports printed on no-printer), the
      // fiscal skip stays fiscalPrinted:false (EXPANSION_PLAN E-FISCAL).
      return { success: true, fiscalPrinted: false, skipped: true, reason: 'no-fiscal-printer' };
    }

    const orderRepo = createOrderRepo(await db());
    const order = orderRepo.getById(orderId);
    const items = orderRepo.getItemsByOrderId(orderId);
    // SAME payload the receipt COPY uses (buildSaleReceiptData) — the fiscal
    // printer renders the same sale data into a legal fiscal receipt
    // (shared-fiscal-printer.ts:302-304 submits the same ReceiptData).
    const receiptData = buildSaleReceiptData(orderId, order, items, salonName());
    if (!receiptData) {
      return { success: true, fiscalPrinted: false, reason: 'no-order', error: `order ${orderId} not found` };
    }

    // Idempotent resume — a known fiscal job for this order is polled, not
    // re-created, so a repeated tap never creates a duplicate fiscal document.
    const knownJobId = knownFiscalJobs.get(orderId);
    if (knownJobId) {
      return await resumeFiscalJob(knownJobId, printerId);
    }

    // shared-fiscal-printer.ts:319-332 — referenceType POS_FISCAL_RECEIPT, the
    // 'fiscal' idempotency key, printerType FISCAL, waitForCompletion hold.
    const idempotencyKey = buildFiscalIdempotencyKey(machineId(), orderId);
    const body: CreatePrintJobRequest = {
      jobType: PrintJobType.RECEIPT,
      printerType: PrinterType.FISCAL,
      printerId,
      payload: receiptData,
      referenceType: 'POS_FISCAL_RECEIPT',
      referenceId: orderId,
      waitForCompletion: true,
      timeoutMs: completionTimeoutMs,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };

    let createResp: CreatePrintJobResponse;
    try {
      createResp = await client.createPrintJob(body);
    } catch (e: unknown) {
      // Create failed before the agent accepted the job. Nothing fiscal printed;
      // the cashier can retry. Surface as a plain failure (fiscalPrinted:false).
      return {
        success: false,
        fiscalPrinted: false,
        reason: 'failed',
        error: e instanceof Error ? e.message : String(e),
        ...(printerId ? { printerId } : {}),
      };
    }

    const jobId = getJobId(createResp);
    if (jobId) rememberFiscalJob(orderId, jobId);
    return await resolveFinalFiscal(createResp, jobId, printerId);
  };

  return {
    /**
     * Submit (or resume) a receipt COPY print. Concurrent/repeated calls for the
     * same order+op share one create+poll cycle (idempotent — one createPrintJob).
     */
    requestReceiptPrint(orderId, opts): Promise<RemoteReceiptPrintResult> {
      const isReprint = !!opts?.isReprint;
      const openDrawer = !!opts?.openDrawer;
      const opKey = `${orderId}#${isReprint ? 'reprint' : 'print'}`;
      const cached = inFlight.get(opKey);
      if (cached) return cached;
      const promise = runRequestPrint(orderId, isReprint, openDrawer).finally(() => {
        inFlight.delete(opKey);
      });
      inFlight.set(opKey, promise);
      return promise;
    },

    /**
     * Submit (or resume) a FISCAL receipt print (E-FISCAL). Concurrent/repeated
     * calls for the same order share ONE create+poll cycle (idempotent — one
     * createPrintJob, never a duplicate fiscal document). NEVER auto-retries an
     * uncertain outcome.
     */
    requestFiscalPrint(orderId): Promise<RemoteFiscalPrintResult> {
      const opKey = `${orderId}#fiscal`;
      const cached = inFlightFiscal.get(opKey);
      if (cached) return cached;
      const promise = runRequestFiscalPrint(orderId).finally(() => {
        inFlightFiscal.delete(opKey);
      });
      inFlightFiscal.set(opKey, promise);
      return promise;
    },

    /** Resolve the salon's receipt printer (diagnostics / cache prime). */
    async getPrinterStatus(forceRefresh = false): Promise<RemotePrinterStatus> {
      const { printerId, error, cached } = await resolvePrinterByRole(RECEIPT_PRINTER_ROLE, forceRefresh);
      if (!printerId) return { assigned: false, cached, error };
      return { assigned: true, printerId, cached };
    },
    /** Resolve the salon's FISCAL printer (E-FISCAL) — same assignment lookup,
     *  FISCAL_RECEIPT role, its own cache slot. Drives `hasFiscalPrinter`
     *  (`assigned` → configured + connected). */
    async getFiscalPrinterStatus(forceRefresh = false): Promise<RemotePrinterStatus> {
      const { printerId, error, cached } = await resolvePrinterByRole(FISCAL_PRINTER_ROLE, forceRefresh);
      if (!printerId) return { assigned: false, cached, error };
      return { assigned: true, printerId, cached };
    },
  };
}
