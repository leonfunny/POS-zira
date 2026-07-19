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
 * real transport by calling `installShim({ transport })` (or
 * `setShimTransport`) — the shim surface the renderer sees never changes.
 *
 * Every method is OPTIONAL. A transport only implements the ports it owns; the
 * shim fills the rest with synthetic behavior. This keeps S2 self-contained
 * (install with no transport) and lets later packets land incrementally.
 *
 * Windows behavior stays the reference (PARITY_PORT_PLAN §2): when a real
 * transport method is present, its DTOs/headers/semantics must match the
 * Windows main-process handler cited in S1 for that method.
 */

import type { AgentConfig, AuthUser } from '../../../shared/types';

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
 * The transport seam. Implementations: `SyntheticTransport` (S2 default) and a
 * future fetch-based transport (S3+). The shim never imports a transport
 * directly; it receives one via `installShim({ transport })`.
 */
export interface ShimTransport {
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
  searchProducts?(query: string): Promise<ShimPosProduct[]>;
  getCategories?(): Promise<ShimPosCategory[]>;

  /** CASH order create (local-first; S8 ports the exact DTO + order-sync). */
  createOrder?(order: any, items: any[]): Promise<{ success: boolean; id?: string; error?: string }>;
  /** Order history (local + server) — S9. */
  getOrderHistory?(filters: any): Promise<{ orders: any[]; total: number; page: number; limit: number }>;
  getOrderDetail?(orderId: string): Promise<{ order: any; items: any[] } | null>;

  /** Sync pull/push (S6 catalog / S8 orders). */
  syncProducts?(): Promise<{ success: boolean; productsCount?: number; error?: string }>;
  syncOrders?(): Promise<void>;

  /** Shift open/close — POST /api/v1/pos/shifts/* (S9). */
  openShift?(data: { staffId: string; staffName: string; openingCash: number }): Promise<{ success: boolean; shiftId?: string; error?: string }>;
  closeShift?(data: { shiftId: string; closingCash: number; fiscalOnly?: boolean }): Promise<{ success: boolean; report?: any; error?: string }>;
  /** Active-shift lookup for boot session recovery (S9). Returns the open local
   *  shift so the shell can re-dispatch session/open after a restart. */
  getActiveShift?(): Promise<{ success: boolean; shift?: { id: string; staff_id: string | null; staff_name: string | null; opened_at: string } | null; error?: string }>;

  /** Staff picker for shift open (S5 staff repo mirror). */
  getStaff?(): Promise<Array<{ id: string; user_id?: string | null; name: string; commission_rate: number; is_active: number; role?: string | null }>>;

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
}

/** Shape persisted by the config store — a subset of AgentConfig (S1 §2.A). */
export type PersistedConfig = Partial<AgentConfig>;
