/**
 * ShimTransport — the injectable backend-port seam for the Android POS shim.
 *
 * Packet S2 of the Android parity port — see
 * docs/android-pos/PARITY_PORT_PLAN_2026-07-18.md (§5) and the full contract in
 * docs/android-pos/SHIM_CONTRACT_S1.md.
 *
 * Why this exists: the shim implements the `window.electronAPI` surface the
 * real (unmodified) Windows POS renderer calls. Some of those methods are
 * PORT-disposition (S1) and need real backend/DB behavior — staff-JWT auth,
 * catalog pull, CASH order push, shift open/close. In S2 that behavior is
 * SYNTHETIC (in-memory/local fakes) so the renderer boots and the cart works
 * with no network. Later packets swap the fakes for real ports:
 *
 *   S3 → fetch-based api-client (staff login, refresh, /auth/me, catalog,
 *        orders, shifts, print) implementing the auth/catalog/orders/shift
 *        methods below.
 *   S4 → Capacitor secure storage supplies the tokenProvider.
 *   S6 → catalog sync worker implementing getProducts/getCategories.
 *   S8 → order-sync DTO builder + retry implementing createOrder + order push.
 *
 * The contract is: the shim's electronAPI methods call `transport.X` when the
 * transport provides X, otherwise fall back to the synthetic fake. S7 wires a
 * real transport by passing it to the FIRST `installShim({ transport })` call
 * (the transport is fixed at install) — the shim surface the renderer sees
 * never changes.
 *
 * Every method is OPTIONAL. A transport only implements the ports it owns; the
 * shim fills the rest with synthetic behavior. This keeps S2 self-contained
 * (install with no transport) and lets later packets land incrementally.
 *
 * Windows behavior stays the reference (PARITY_PORT_PLAN §2): when a real
 * transport method is present, its DTOs/headers/semantics must match the
 * Windows main-process handler cited in S1 for that method.
 */

import type { AgentConfig, AuthUser, PosLoyaltyLookupIpcResult, SalonEntitlements } from '../../../shared/types';
import type {
  NailTurnBoardIpcResult,
  PosScheduleAssignNextPayload,
  PosScheduleDayIpcResult,
  PosScheduleRequestStaffPayload,
  PosScheduleStaffStatusPayload,
  PosScheduleWeekIpcResult,
} from '../../../shared/types';
import type { ProductAdminSurface } from './product-admin';

/** A sanitized product row (mirrors the SQL.js PosProduct; see S1 §2.D). */
export interface ShimPosProduct {
  id: string;
  template_id: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  retail_price: number;
  category_id: string | null;
  image_url: string | null;
  in_stock: number;
  available_qty: number;
  vat_rate: number;
  is_active: number;
  is_on_sale: number;
  thumbnail_url: string | null;
  sale_unit: string | null;
  sell_by?: 'PIECE' | 'WEIGHT' | string | null;
  updated_at: string | null;
}

/** A sanitized category row (mirrors PosCategory; see S1 §2.D). */
export interface ShimPosCategory {
  id: string;
  name: string;
  image_url: string | null;
  icon: string | null;
  color: string | null;
  sort_order: number;
  updated_at: string | null;
  kitchen_print?: number | null;
}

/** Staff-JWT token access — injected by S4 (Capacitor secure storage). */
export interface ShimTokenProvider {
  /** Current staff access token, or null when logged out. */
  getAccessToken(): Promise<string | null>;
  /**
   * Refresh the session. Resolve true on success (caller retries with the new
   * token from getAccessToken), false when the session is unrecoverable
   * (caller fires AUTH_EXPIRED). Mirrors the collapsed boolean form of the
   * Windows three-valued RefreshResult (see port/api-client.ts header).
   */
  refresh(): Promise<boolean>;
}

/** Result of email login — matches `auth.loginWithEmail` (S1 §2.B). */
export interface ShimLoginResult {
  success: boolean;
  data?: { user: AuthUser };
  error?: string;
  restarting?: boolean;
}

/** Result of `auth.getUser` boot verify — matches S1 §2.B. */
export interface ShimGetUserResult {
  success: boolean;
  data?: { isAuthenticated: boolean; user?: AuthUser };
  error?: string;
}

/**
 * Outcome of a remote receipt COPY print — packet E1a. Receipt COPY only: the
 * fiscal receipt stays backend-gated (P0-FISCAL) and `printFiscalReceipt` keeps
 * returning `fiscalPrinted:false`.
 *
 * `receiptPrinted` is the ONLY field `deriveReceiptOutcome` (receipt-outcome.ts)
 * reads — true → PaymentModal closes cleanly (no recovery overlay); false → the
 * cashier sees the "receipt not printed" warning + recovery path. The no-printer
 * skip deliberately reports `receiptPrinted:true` so a salon with no Windows
 * agent is not stopped by the overlay on every CASH sale (Wave-1 pilot UX).
 */
export interface RemoteReceiptPrintResult {
  /** The coordinator ran to completion (mirrors the Windows IPC try/catch —
   *  `success:true` even when `receiptPrinted:false`). False only on an
   *  unexpected internal failure or no auth token. */
  success: boolean;
  /** Did the receipt paper emit? Drives the PaymentModal recovery overlay. */
  receiptPrinted: boolean;
  /** No remote receipt printer is configured/online for this salon — the
   *  Wave-1 "skip" outcome (receiptPrinted:true) so the overlay never shows. */
  skipped?: boolean;
  /** Machine-readable outcome for diagnostics / future UI. */
  reason?: 'no-printer' | 'no-order' | 'no-auth' | 'safe-before-print' | 'failed' | 'unknown';
  /** The backend print-job id (when one was created or resumed). */
  jobId?: string;
  error?: string;
}

/**
 * Outcome of a remote FISCAL receipt print — packet E-FISCAL (the fiscal twin of
 * RemoteReceiptPrintResult). Same staff-JWT `/print-agent/jobs` route as the
 * receipt COPY, but role FISCAL_RECEIPT + printerType FISCAL, and a status
 * mapping that NEVER auto-retries an uncertain outcome (legal/money — an
 * uncertain fiscal job is STOP_RECONCILE_REQUIRED; a re-submit could print a
 * SECOND fiscal document).
 *
 * `fiscalPrinted` is the LEGAL outcome: true ONLY when the agent returned a
 * terminal COMPLETED/PRINTED. A false fiscal claim is a legal issue, so unlike
 * the receipt COPY the no-printer skip stays `fiscalPrinted:false` (it does not
 * pretend success). The renderer's `printFiscalReceipt` already gates on
 * `hasFiscalPrinter`, so the skip is normally reached only when that gate is
 * bypassed.
 */
export interface RemoteFiscalPrintResult {
  /** The coordinator ran to completion (mirrors the Windows IPC try/catch —
   *  `success:true` even when `fiscalPrinted:false`). False only on a create
   *  that threw before the agent accepted the job, or no auth token. */
  success: boolean;
  /** Did the fiscal receipt LEGALLY print? true ONLY on terminal COMPLETED. */
  fiscalPrinted: boolean;
  /** No fiscal printer is assigned to this salon — the skip outcome
   *  (fiscalPrinted:false). `hasFiscalPrinter` normally gates this call. */
  skipped?: boolean;
  /** Machine-readable outcome for diagnostics / reconciliation UI. */
  reason?: 'no-fiscal-printer' | 'no-order' | 'safe-before-print' | 'failed' | 'unknown';
  /** The backend fiscal print-job id (when one was created or resumed). */
  jobId?: string;
  printerId?: string;
  error?: string;
}

/** Result of `getPrinterStatus` — whether a remote receipt printer is assigned
 *  to this salon (E1a). Used for diagnostics and to prime the assignment cache;
 *  `requestReceiptPrint` resolves the assignment lazily too. */
export interface RemotePrinterStatus {
  assigned: boolean;
  printerId?: string;
  /** The cached lookup is still within its TTL (a print right now skips the
   *  assignment HTTP round-trip). */
  cached?: boolean;
  error?: string;
}

/**
 * The transport seam. Implementations: `SyntheticTransport` (S2 default) and a
 * future fetch-based transport (S3+). The shim never imports a transport
 * directly; it receives one via `installShim({ transport })`.
 */
export interface ShimTransport {
  /** Explicit host-owned facts; renderer must not infer support from method names. */
  runtimeCapabilities?: { loyaltyLookup?: boolean; restoredCartTender?: boolean };
  /** Product/stock/category admin surface (E-PARITY-3, owner-only). */
  productAdmin?: ProductAdminSurface;

  /** Staff email login → POST /api/v1/auth/login (S3). */
  loginWithEmail?(email: string, password: string): Promise<ShimLoginResult>;
  /** Boot session verify → GET /api/v1/auth/me (S3). */
  getUser?(): Promise<ShimGetUserResult>;
  /** Clear tokens + authUser (S4 storage). */
  logout?(): Promise<{ success: boolean }>;

  /** Catalog read ports (S5/S6 SQL.js mirror). */
  getProducts?(): Promise<ShimPosProduct[]>;
  getProductById?(id: string): Promise<ShimPosProduct | null>;
  getProductByBarcode?(barcode: string): Promise<ShimPosProduct | null>;
  getByCategory?(categoryId: string): Promise<ShimPosProduct[]>;
  searchProducts?(query: string): Promise<ShimPosProduct[]>;
  getCategories?(): Promise<ShimPosCategory[]>;
  loyaltyLookupCustomer?(phone: string): Promise<PosLoyaltyLookupIpcResult>;

  /** CASH order create (local-first; S8 ports the exact DTO + order-sync). */
  createOrder?(order: any, items: any[]): Promise<{
    success: boolean;
    id?: string;
    error?: string;
    duplicate?: boolean;
    paymentCommitted?: boolean;
    outcomeUncertain?: boolean;
    durabilityError?: string;
    rollbackDurabilityError?: string;
    restoredCartReconciliation?: unknown;
    protectedInterruptionRecoveryRequired?: {
      durable: boolean;
      count: number;
      holdId: string;
      checkoutId?: string;
      message: string;
    };
  }>;
  /** Order history (local + server) — S9. */
  getOrderHistory?(filters: any): Promise<{ orders: any[]; total: number; page: number; limit: number }>;
  getOrderDetail?(orderId: string): Promise<{ order: any; items: any[] } | null>;
  /**
   * Server-side order list for Order History (S1 §2.G getServerList). Windows:
   * pos.module.ts:6970 → GET /api/v1/b2b/pos/orders (staff JWT), rows adapted
   * via adaptServerOrder/-Item. Never throws — network/auth failures map to
   * source:'network-error' / 'unconfigured' exactly like Windows.
   */
  getServerOrders?(params: any): Promise<{
    orders: any[];
    items: Record<string, any[]>;
    total: number;
    page: number;
    limit: number;
    source: 'server' | 'unconfigured' | 'network-error';
    error?: string;
  }>;
  /** Cancel/delete a not-yet-synced local order (+restock) so it never syncs. */
  cancelOrder?(orderId: string): Promise<{ success: boolean; restocked?: number; error?: string }>;
  deleteLocalOrder?(orderId: string): Promise<{ success: boolean; restocked?: number; error?: string }>;
  /** Reset a shelved order and re-drain (recover from a business rejection). */
  retryOrderSync?(orderId: string): Promise<{ success: boolean; result?: { status: string; error?: string }; error?: string }>;
  /**
   * Refund a SYNCED order (E1b). POSTs the renderer-built refund DTO to the
   * backend (POST /b2b/pos/orders/:id/refund, staff JWT), then marks the local
   * order refunded + restocks the restock:true lines. An UNSYNCED order is
   * refused (refund a not-yet-synced order = cancel it, not a server refund).
   * Returns the renderer-shaped result OrderHistoryModal consumes
   * ({success, refundedLines?, refundAmount?, receiptPrinted?, mutationDetected?,
   * requiresRefresh?, error?}).
   */
  refundOrder?(orderId: string, dto: any): Promise<{
    success: boolean;
    refundedLines?: any[];
    refundAmount?: number;
    receiptPrinted?: boolean;
    mutationDetected?: boolean;
    requiresRefresh?: boolean;
    error?: string;
  }>;

  // ── E3 invoicing (Polish VAT) — SHIM_CONTRACT_S1 §2.G (invoice extras). NIP/
  //    GUS lookup + attach-invoice + generate-proforma. All staff-JWT over the
  //    b2b/pos routes; the order-scoped calls require a SYNCED order
  //    (backend_id present). PDF download stays out of scope (Android
  //    FileProvider/share) — downloadPdf keeps its stub.
  /**
   * NIP → customer/GUS registry lookup → GET /api/v1/b2b/pos/customers/nip/:nip
   * (E3a). Staff JWT. Returns {success, data?, error?}; `data` is the GUS /
   * existing-customer row. A 404 (no such NIP) → {success:false}.
   */
  lookupNip?(nip: string): Promise<{ success: boolean; data?: any; error?: string }>;
  /**
   * Attach a VAT invoice to a SYNCED order → PATCH .../orders/:id/add-invoice
   * (E3a). Staff JWT. The renderer-built {customerNip, invoiceType?} DTO is
   * passed through unchanged. An unsynced order is refused (no backend identity
   * to invoice against). On success the local order's customer_nip (+ status if
   * the response carries one) is updated so getDetail reflects it. Returns
   * {success, order?, error?}.
   */
  addInvoice?(orderId: string, data: { customerNip: string; invoiceType?: 'VAT' | 'PROFORMA' }): Promise<{ success: boolean; order?: any; error?: string }>;
  /**
   * Generate a proforma from a SYNCED order → POST .../orders/:id/generate-proforma
   * (E3a). Staff JWT. An unsynced order is refused. Returns {success, proforma?, error?}.
   */
  generateProforma?(orderId: string): Promise<{ success: boolean; proforma?: any; error?: string }>;

  /** Sync pull/push (S6 catalog / S8 orders). */
  syncProducts?(): Promise<{ success: boolean; productsCount?: number; error?: string }>;
  syncOrders?(): Promise<void>;

  // ── Billiard POS-handoff (L5). Present only on the real transport; the
  //    shim falls back to its desktop-only refusals when they are absent.
  /** Everything that must hold BEFORE the server session is ended. */
  billiardPreflight?(): Promise<{ success: boolean; error?: string }>;
  /** Freeze the server's bill into the POS cart. */
  billiardPrepare?(input: { posCheckout?: unknown; tableName?: string | null }): Promise<any>;
  /** Pick the journal back up after the app was killed. */
  billiardRecover?(): Promise<any>;
  /** The cashier opened the payment modal on a frozen bill. */
  billiardMarkPaymentOpened?(checkoutId: string): Promise<any>;
  /** The last gate before money is collected. */
  /** Hold / Recall — parking a customer's basket (pos.module.ts `pos:hold:*`). */
  holdCreateCurrent?(id: string, title: string): Promise<{ success: boolean; error?: string }>;
  holdRecall?(id: string): Promise<{ success: boolean; error?: string; rollbackDurabilityError?: string }>;
  holdList?(): Promise<any[]>;
  holdGet?(id: string): Promise<any | null>;
  holdRemove?(id: string): Promise<{ success: boolean; error?: string }>;
  /** Ordinary payment boundary — verifies the shift locally AND against the server. */
  paymentPreflight?(orderId: string): Promise<{ success: boolean; token?: string; expiresAt?: number; error?: string }>;
  billiardBeginTender?(checkoutId: string, paymentPreflightToken: string): Promise<any>;
  billiardBeginRestoredTender?(holdId: string, paymentPreflightToken: string): Promise<any>;
  /** Settle the handoff once the order is committed locally. */
  billiardComplete?(checkoutId: string, orderId: string): Promise<any>;
  /** OWNER-only exit from an uncertain tender outcome. */
  billiardResolveUncertainTender?(input: unknown): Promise<any>;
  /** Abandon in-flight handoff work when the session ends. */
  billiardInvalidateAuth?(): void;
  /** installShim hands over the POS store it owns; the handoff needs both it
   *  and the transport's platform signals. */
  attachPosStore?(posStore: unknown): void;
  /** Route POS mutations through the protected restored-cart durability owner. */
  posDispatch?(action: unknown): Promise<void>;

  /** Persist the serialized in-progress cart (Android crash/back-press survival). */
  posSnapshotSave?(json: string): Promise<void>;
  /** Read the persisted cart snapshot, or null when there is none. */
  posSnapshotLoad?(): Promise<string | null>;
  /** Drop the persisted cart snapshot (checkout done, logout, tenant switch). */
  posSnapshotClear?(): Promise<void>;

  /** Shift open/close — POST /api/v1/pos/shifts/* (S9). */
  openShift?(data: { staffId: string; staffName: string; openingCash: number }): Promise<{ success: boolean; shiftId?: string; error?: string }>;
  closeShift?(data: { shiftId: string; closingCash: number; fiscalOnly?: boolean }): Promise<{ success: boolean; report?: any; error?: string }>;
  /** Active-shift lookup for boot session recovery (S9). Returns the open local
   *  shift so the shell can re-dispatch session/open after a restart. */
  getActiveShift?(): Promise<{ success: boolean; shift?: { id: string; staff_id: string | null; staff_name: string | null; opened_at: string } | null; error?: string }>;

  /** Staff picker for shift open (S5 staff repo mirror). */
  getStaff?(): Promise<Array<{ id: string; user_id?: string | null; name: string; commission_rate: number; is_active: number; role?: string | null }>>;

  /**
   * Remote receipt COPY print (E1a). Submits a print job to the Windows agent
   * over the existing staff-JWT routes (POST /print-agent/jobs + poll
   * GET /print-agent/jobs/:id), then returns the real printed/failed/skipped
   * outcome. Receipt COPY only — fiscal stays disabled. When no remote printer
   * is assigned the coordinator returns the Wave-1 skip (`receiptPrinted:true,
   * skipped:true`) so the checkout is not interrupted.
   *
   * `isReprint` builds a POS_RECEIPT_REPRINT job (no idempotency key — each
   * reprint is a fresh job, matching Windows). `openDrawer` is accepted for API
   * symmetry with `printReceiptAndOpenDrawer` but the drawer is always reported
   * closed on Android (no drawer hardware).
   */
  requestReceiptPrint?(orderId: string, options?: { isReprint?: boolean; openDrawer?: boolean }): Promise<RemoteReceiptPrintResult>;
  /** Resolve the salon's remote receipt printer (E1a). Diagnostic / cache-prime. */
  getPrinterStatus?(): Promise<RemotePrinterStatus>;
  /**
   * Remote FISCAL receipt print (E-FISCAL). Submits a FISCAL_RECEIPT job to the
   * salon's print-agent (ELZAB) over the SAME staff-JWT `/print-agent/jobs` route
   * as the receipt COPY, then returns the legal printed/skipped/failed/unknown
   * outcome. NEVER auto-retries an uncertain job. When no fiscal printer is
   * assigned the coordinator returns the skip (`fiscalPrinted:false,
   * skipped:true, reason:'no-fiscal-printer'`).
   */
  requestFiscalPrint?(orderId: string): Promise<RemoteFiscalPrintResult>;
  /** Resolve the salon's remote FISCAL printer (E-FISCAL). Diagnostic /
   *  cache-prime; drives `hasFiscalPrinter` (`assigned` → configured+connected). */
  getFiscalPrinterStatus?(forceRefresh?: boolean): Promise<RemotePrinterStatus>;

  /**
   * Event subscriptions the transport OWNS (it knows when these fire). S6+S7:
   * a real transport implements these so the shim's `auth.onExpired` /
   * `pos.sync.onProductsSynced` subscriptions actually deliver. The S2
   * SYNTHETIC_TRANSPORT omits them → the shim falls back to a no-op unsubscribe
   * that never emits (the S2 default). S7's createRealTransport implements both.
   */
  /** Event: refresh rejected → drop to login (S1 §2.B, §3). Returns unsubscribe. */
  onAuthExpired?(cb: () => void): () => void;
  /** Event: catalog reloaded after a sync (S1 §2.E, §3). Returns unsubscribe. */
  onProductsSynced?(cb: () => void): () => void;
  /** Event: an order landed on the backend (S1 §2.E pos:order-synced). */
  onOrderSynced?(cb: (payload: { orderId: string; backendId: string }) => void): () => void;
  /** Event: an order was shelved by a business rule (S1 §2.E pos:order-sync-failed). */
  onOrderSyncFailed?(cb: (payload: { orderId: string; orderNumber: string | null; error: string; code?: string }) => void): () => void;

  // ── E2a salon surface (SHIM_CONTRACT_SALON_E2) ───────────────────────────
  // Staff sync + the schedule/nail-turn dark-launch reads/writes. All staff-JWT
  // (schedule reads have NO `pa_` agent fallback on Android — hard rail).

  /** Staff sync pull → GET /api/v1/staff (E2a §2.B). Upserts the staff table +
   *  emits onStaffUpdated. Returns {success, count, error}. */
  syncStaff?(): Promise<{ success: boolean; count?: number; error?: string }>;
  /** Event: staff table refreshed after a pull / remote change
   *  (E2a §2.B, pos:staff-updated). Payload {count?}. */
  onStaffUpdated?(cb: (data?: { count?: number } | undefined) => void): () => void;
  /** Event: a nail-turn checkout closed a technician's turn
   *  (E2a §2.D, pos:nail-turns-updated). Payload {orderId?, checkedOut?}. */
  onNailTurnsUpdated?(cb: (data: { orderId?: string; checkedOut?: number }) => void): () => void;

  /** Nail-turn board → GET /api/v1/nail-turns/today (E2a §2.D). Dark-launch:
   *  {success:false, unavailable:true} when the route is absent. */
  getNailTurnBoard?(): Promise<NailTurnBoardIpcResult>;
  /** Schedule day → GET /api/v1/pos/schedule/today?date= (E2a §2.C). */
  getPosScheduleToday?(date?: string): Promise<PosScheduleDayIpcResult>;
  /** Schedule week → GET /api/v1/pos/schedule/week?from=&days= (E2a §2.C). */
  getPosScheduleWeek?(from?: string, days?: number): Promise<PosScheduleWeekIpcResult>;
  /** Toggle a technician's turn status → PATCH .../staff/:id/status (E2a §2.C). */
  setPosScheduleStaffStatus?(payload: PosScheduleStaffStatusPayload): Promise<PosScheduleDayIpcResult>;
  /** Assign next-in-queue → POST .../checkins/:id/assign-next (E2a §2.C). */
  assignPosScheduleNext?(payload: PosScheduleAssignNextPayload): Promise<PosScheduleDayIpcResult>;
  /** Assign a specific technician → POST .../checkins/:id/request-staff (E2a §2.C). */
  requestPosScheduleStaff?(payload: PosScheduleRequestStaffPayload): Promise<PosScheduleDayIpcResult>;

  // ── Billiard (Bi-a) online-only surface — SHIM_CONTRACT_S1 §2.N ──────────────
  //  P1 reads hit the backend (no local SQLite cache / offline queue — the
  //  Windows counterpart caches in src/main/sync/billiard-sync.ts) and writes
  //  go straight through with the real error surfaced. The server is the source
  //  of truth for every charge, so `billiardMutate` MUST reject when no transport
  //  is injected rather than fake success (money path). All optional: S2 leaves
  //  them absent so the shim degrades to benign empty/offline defaults.

  /** Floor overview (tables + floorPlans + layouts + sessions). */
  billiardGetOverview?(): Promise<any>;
  /** Single session by id. */
  billiardGetSession?(id: string): Promise<any>;
  /** Active/visible combos. */
  billiardGetCombos?(activeOnly?: boolean): Promise<any[]>;
  /** Floor-plan list. */
  billiardGetFloorPlans?(): Promise<any[]>;
  /** F&B product list (filtered). */
  billiardGetFnbProducts?(search?: string, categoryId?: string): Promise<any[]>;
  /** F&B category list. */
  billiardGetFnbCategories?(): Promise<any[]>;
  /** Resource-type descriptor by code. */
  billiardGetResourceType?(code: string): Promise<any>;
  /** Restaurant combos. */
  billiardGetRestaurantCombos?(): Promise<any[]>;
  /** Generic billiard write — the queue-aware `billiard.mutate` IPC. Rejects
   *  when no transport is present (money path: never fake success). */
  billiardMutate?(op: string, method: string, path: string, body?: any): Promise<any>;
  /** Sync/cache status. */
  billiardSyncStatus?(): Promise<{
    pending: number;
    lastSync: string | null;
    online: boolean;
    apiReachable?: boolean | null;
  }>;
  /** Event: cached data refreshed (poll / post-mutation). Returns unsubscribe. */
  billiardOnDataUpdated?(cb: (d: { type: string }) => void): () => void;
  /** Receipt print for a billiard session payment. Mirrors the Windows
   *  no-receipt-printer return literal when no transport is present. */
  billiardPrintReceipt?(sessionId: string, payment: { method: string; amount: number }): Promise<{ success: boolean; receiptPrinted: boolean }>;

  /** Generic REST API proxy used by the billiard UI (origin/main's
   *  useBilliardApi routes ALL online reads through `billiard.mutate` with
   *  op 'online_api', but the typed surface still declares this). Rejects when
   *  no transport is present. */
  apiCall?(method: string, path: string, body?: any): Promise<any>;

  // ── Real salon entitlements (shim/entitlements.ts) ─────────────────────────
  // Without these the shim answers with syntheticEntitlements (all features
  // enabled), which showed the Bi-a tab to every salon regardless of plan.
  // Backed by GET /api/v1/admin/desktop/entitlements (staff JWT, 1h cache).
  /** Cached-then-network read (Windows entitlements:get). */
  entitlementsGet?(): Promise<SalonEntitlements>;
  /** Force a network refresh (Windows entitlements:fetch). */
  entitlementsFetch?(): Promise<SalonEntitlements>;
  /** Single-feature check (Windows entitlements:is-enabled). */
  entitlementsIsEnabled?(feature: string): Promise<boolean>;
  /** Fires when the feature set actually changes (Windows entitlements:changed). */
  entitlementsOnChanged?(cb: (entitlements: SalonEntitlements) => void): () => void;
}

/** Shape persisted by the config store — a subset of AgentConfig (S1 §2.A). */
export type PersistedConfig = Partial<AgentConfig>;
