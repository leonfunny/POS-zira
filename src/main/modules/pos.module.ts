/**
 * PosModule
 *
 * Owns PosStore, PaymentController, ShiftController, and all POS IPC handlers.
 */

import { ipcMain, dialog, shell, BrowserWindow, app, type IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import { repairOrphanBookings } from '../sync/booking-sync';
import { PosStore } from '../pos/pos-store';
import { PaymentController, FiscalReceiptJournalInput, ReceiptPrintJournalInput } from '../pos/payment-controller';
import {
  assertBilliardRealFiscalGate,
  assertTenderFiscalCompatibilityForProtocol,
  hasTenderFiscalDiscount,
  requiresBilliardFiscalPrinterReadiness,
  type TenderFiscalLine,
} from '../pos/fiscal-tender-preflight';
import { buildBackendOrderItem, getLineSaleQuantity, getLineSaleUnit, getLineSellBy, getLineTotalGrosze, shouldDecrementStockAtCheckout } from '../pos/order-line-contract';
import { submitSharedReceiptPrint } from '../printing/shared-receipt-printer';
import { getSharedFiscalPrinterStatus, submitSharedFiscalPrint } from '../printing/shared-fiscal-printer';
import { toCashDrawerIpcResult } from '../pos/cash-drawer-ipc-result';
import {
  buildRefundMutationError,
  getRefundBackendResponseSummary,
  allocateRefundTenders,
  getRefundLinesForRequest,
  mergeRefundLines,
  shouldApplyRefundRequestLocally,
  toRefundBackendPayload,
  validateRefundBackendResponse,
  type RefundBackendValidationResult,
  type RefundIpcPayload,
} from '../pos/refund-backend-payload';
import { sanitizeBilliardRefundRequest } from '../pos/billiard-refund-policy';
import { assertPosPaymentAccounting, assertProtectedPosPaymentMethods } from '../pos/payment-accounting';
import { ShiftController } from '../pos/shift-controller';
import { toQuickAddVariantRow } from '../pos/quick-add-product';
import {
  captureProductAdminSessionContext,
  decodeCategoryImageDataUrl,
  decodeProductImageDataUrl,
  assertProductStockQuantity,
  isProductAdminSessionContextCurrent,
  mergeProductAdminNullableMirrorFields,
  normalizeProductReceiptInput,
  redactProductAdminPurchaseData,
  requireProductAdminExpectedUpdatedAt,
  sanitizeProductAdminCategoryJsonMutation,
  shouldApplyProductAdminVariantMirror,
  shouldApplyProductAdminCategoryMirror,
  productAdminCanonicalUpdatedAt,
  productAdminCategoryToRow,
  sanitizeExistingProductInventoryModeUpdate,
} from '../pos/product-workspace-input';
import {
  ProductAdminMutationOutbox,
  productAdminMutationTenantKey,
} from '../pos/product-admin-mutation-outbox';
import type { ProductAdminMutationOutboxRow } from '../database/repos/product-admin-mutation-outbox-repo';
import { isValidProductMoneyGrosze } from '../../shared/product-money';
import { classifyProductSale } from '../../shared/product-sale-classifier';
import {
  lookupExternalProductByEan,
  normalizeEan,
  type ExternalProductLookupOptions,
} from '../pos/external-product-lookup';
import { WindowManager } from '../windows/window-manager';
import { productRepo, type ProductVariantRow } from '../database/repos/product-repo';
import { draftProductRepo } from '../database/repos/draft-product-repo';
import { draftProductSync } from '../sync/draft-product-sync';
import { buildLocalImportMutationKey } from '../sync/product-sync';
import { kitchenSelfOrderCategoryPrefsRepo } from '../database/repos/kitchen-self-order-category-prefs-repo';
import { StaffSync } from '../sync/staff-sync';
import {
  getSavedLocalVariantImportIntentIdentity,
  isExactLegacyUncertainImportRetry,
  LocalVariantImportOutcomeUncertainError,
  localVariantImportsRepo,
} from '../database/repos/local-variant-imports-repo';
import { orderRepo } from '../database/repos/order-repo';
import { kitchenSelfOrderRepo, type KitchenSelfOrderWithItems } from '../database/repos/kitchen-self-order-repo';
import { buildKitchenSelfOrderMenu } from '../kitchen-self-order/menu-service';
import {
  pushPickupOrderBestEffort,
  updatePickupKitchenPrintStatusBestEffort,
  drainPickupOutboxesInOrder,
  type PickupOrderKitchenPrintStatus,
} from '../kitchen-self-order/pickup-queue-client';
import { settlePickupOrderForSale, drainPickupSettleOutbox } from '../kitchen-self-order/pickup-settle';
import { fiscalAttemptRepo } from '../database/repos/fiscal-attempt-repo';
import {
  FiscalReceiptOrderPendingSyncError,
  fiscalReceiptSyncRepo,
  prepareFiscalReceiptSyncBody,
  type FiscalReceiptSyncRow,
} from '../database/repos/fiscal-receipt-sync-repo';
import {
  buildKitchenTicketLines,
  buildPickupSlipLines,
  type KitchenTicketData,
} from '../printing/kitchen-ticket';
import { printKitchenSelfOrderCustomerSlipToPrinter } from '../printing/kitchen-payment-slip-printer';
import { submitSharedKitchenPrint, submitSharedPickupSlip } from '../printing/shared-kitchen-printer';
import { printAttemptRepo } from '../database/repos/print-attempt-repo';
import { posEventEmitter } from '../events/pos-event-emitter';
import { tableRepo } from '../database/repos/table-repo';
import { customerRepo } from '../database/repos/customer-repo';
import { staffRepo } from '../database/repos/staff-repo';
import { holdOrderRepo } from '../database/repos/hold-repo';
import { billiardPosHandoffRepo } from '../database/repos/billiard-pos-handoff-repo';
import {
  assertBilliardCheckoutSnapshotIntegrity,
  assertBilliardCorrectionHandoffPreflight,
  adoptPosCheckoutSnapshotScope,
  buildBilliardInterruptionHoldPayload,
  buildBilliardCheckoutSnapshot,
  capturePosCheckoutSnapshot,
  currentPosSnapshotScope,
  hasEquivalentOrdinaryCart,
  isActiveBilliardCheckoutSnapshot,
  isActiveRestoredCartSnapshot,
  isValidRestoredCartCheckoutJournal,
  getRestorableBilliardInterruptionSnapshot,
  restoredCartRecoveryDisposition,
  sameRestoredCartCheckoutIdentity,
  samePosSalonRegister,
  samePosSnapshotScope,
  withRestoredInterruptionMarker,
  withoutRestoredInterruptionMarker,
  type PosSnapshotScope,
} from '../pos/billiard-pos-handoff';
import { PosAuthEpochGuard, type PosAuthContext } from '../pos/pos-auth-epoch';
import {
  isBilliardCorrectionSourceForOwner,
  resolveBilliardCorrectionCommand,
} from '../pos/billiard-correction-journal';
import { buildLegacyHeldCartImport } from '../pos/legacy-held-cart';
import { quickKeyLayoutRepo } from '../database/repos/quickkey-layout-repo';
import { checkinRepo } from '../database/repos/checkin-repo';
import { bookingRepo } from '../database/repos/booking-repo';
import { serviceRepo } from '../database/repos/service-repo';
import { serviceRuleRepo } from '../database/repos/service-rule-repo';
import { database } from '../database/database';
import SocketClient from '../network/socket-client';
import {
  apiClient,
  type NailTurnBoardResponse,
  type ServerOrderListParams,
} from '../network/api-client';
import {
  getConfig,
  getSecureAuthToken,
  getConfigValue,
  setConfigValue,
  getSecureApiKey,
} from '../config/store';
import type {
  ProductAdminCategoryListResponse,
  ProductAdminCategoryDeleteInput,
  ProductAdminCategoryDeleteResponse,
  ProductAdminCategoryImageUploadInput,
  ProductAdminCategoryImageUploadResponse,
  ProductAdminCategoryMutationInput,
  ProductAdminCategoryMutationResponse,
  ProductAdminCategoryOrderUpdate,
  ProductAdminCategoryOrderUpdateResponse,
  ProductAdminCategory,
  ProductAdminCapabilities,
  ProductAdminCreateProductInput,
  ProductAdminDeactivateVariantInput,
  ProductAdminIpcResult,
  ProductAdminLotListResponse,
  ProductAdminMainImageUploadInput,
  ProductAdminMainImageUploadResponse,
  ProductAdminProductMutationResponse,
  ProductAdminReceiveStockInput,
  ProductAdminReceiveStockResponse,
  ProductAdminStockAdjustmentInput,
  ProductAdminStockAdjustmentResponse,
  ProductAdminUpdateVariantInput,
  ProductAdminVariant,
  ProductAdminVariantDetailResponse,
  ProductAdminVariantMutationResponse,
  PosLoyaltyLookupIpcResult,
  PosScheduleAssignNextPayload,
  PosScheduleDayResponse,
  PosScheduleRequestStaffPayload,
  PosScheduleStaffStatusPayload,
  SelectedService,
  LiveCustomerDisplayProfile,
} from '../../shared/types';
import { PrinterType, IPC_CHANNELS } from '../../shared/types';
import {
  KITCHEN_SELF_ORDER_QR_PREFIX,
  buildKitchenSelfOrderRefQr,
  encodeKitchenSelfOrderUuidToken,
  formatKitchenSelfOrderModifierLabels,
  normalizeKitchenSelfOrderFulfillment,
  normalizeKitchenSelfOrderLanguage,
  normalizeKitchenSelfOrderPriceGrosze,
  normalizeKitchenSelfOrderCheckoutMode,
  parseKitchenSelfOrderOptionsJson,
  resolveKitchenSelfOrderBrandName,
  resolveKitchenSelfOrderCheckoutAction,
  resolveKitchenSelfOrderRetryAction,
  validateKitchenSelfOrderModifierSelections,
  type KitchenSelfOrderSubmitInput,
} from '../../shared/kitchen-self-order';
import { resolveCustomerDisplayProfile } from '../../shared/customer-display-profile';
import { seedIfEmpty } from '../database/seed';
import { adaptServerOrder, adaptServerOrderItem, normalizeRefundLinesJson, toGrosze } from '../sync/pos-order-adapter';
import type { SyncLogService } from '../sync/sync-log-service';
import { notifyPosRenderers } from '../windows/notify-pos-renderers';
import {
  writeBookingStatusChanged,
  writeBookingCancelled,
  writeBookingUpdated,
  writeBookingCreated,
  type BookingUpdatePatch,
  type WalkInBookingInput,
} from '../sync/booking-sync';
import logger from '../logger';
import {
  normalizeBilliardPosCheckout,
  POS_CHECKOUT_SNAPSHOT_VERSION,
  requiresBilliardTenderReconciliation,
  type BilliardCartLineMetadata,
  type BilliardPaymentIntent,
  type BilliardPosCheckoutLine,
  type PosHoldPayload,
  type ResolveUncertainTenderInput,
  type RestoredCartCheckoutJournal,
  type RestoredCartReconciliation,
  type TenderNoPaymentResolutionAudit,
} from '../../shared/billiard-pos-handoff';
import {
  assertLocalOpenShiftMatchesSession,
  getVerifiedServerShiftMismatch,
  recoverOpenShiftFromLocal,
} from '../pos/open-shift-recovery';

type BilliardHandoffRecord = NonNullable<ReturnType<typeof billiardPosHandoffRepo.get>>;

function billiardLineMetadata(line: BilliardPosCheckoutLine): BilliardCartLineMetadata {
  return {
    kind: line.kind,
    sessionItemId: line.sessionItemId,
    lineKey: line.lineKey,
    durationMinutes: line.durationMinutes,
    displayName: line.displayName,
    inventoryPolicy: line.inventoryPolicy,
    refundPolicy: line.refundPolicy,
    sellBy: line.sellBy,
    saleUnit: line.saleUnit,
    grossTotalGrosze: line.grossTotalGrosze,
    allocatedDiscountGrosze: line.allocatedDiscountGrosze,
    payableGrosze: line.payableGrosze,
  };
}

function parseBilliardJson(value: unknown, label: string): Record<string, any> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed as Record<string, any>;
  } catch {
    throw new Error(`Invalid ${label} Billiard metadata.`);
  }
}

function getExternalProductLookupOptions(): ExternalProductLookupOptions {
  return {
    google: {
      apiKey: getConfigValue('googleCustomSearchApiKey') as string | undefined,
      cx: getConfigValue('googleCustomSearchCx') as string | undefined,
    },
  };
}

const BACKEND_CATEGORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeScanCreateEan(value: unknown): string | null {
  const code = String(value ?? '').trim().replace(/[\s-]+/g, '');
  return /^\d{4,14}$/.test(code) ? code : null;
}

function resolveBackendScanCategoryId(requestedCategoryId: string | null): { ok: boolean; categoryId: string | null } {
  const categoryId = String(requestedCategoryId ?? '').trim();
  if (!categoryId) return { ok: true, categoryId: null };

  const categoryExists = productRepo.getAllCategories().some((category) => category.id === categoryId);
  if (!categoryExists) return { ok: false, categoryId: null };

  return {
    ok: true,
    categoryId: BACKEND_CATEGORY_ID_RE.test(categoryId) ? categoryId : null,
  };
}

const PHOWHISPER_DEFAULT_BASE_URL = 'http://100.111.221.25:8088';
const PHOWHISPER_TRANSCRIBE_TIMEOUT_MS = 45_000;
const PHOWHISPER_MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const PHOWHISPER_MAX_BASE64_CHARS = Math.ceil(PHOWHISPER_MAX_AUDIO_BYTES * 4 / 3) + 512;
const PHOWHISPER_MODELS = new Set(['tiny', 'base', 'small', 'medium', 'large']);
const PHOWHISPER_ALLOWED_MIME_TYPES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/m4a',
  'video/mp4',
]);

type PhoWhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large';

interface PosVoiceTranscribePayload {
  audioBase64?: string;
  mimeType?: string;
  model?: PhoWhisperModel | string;
  timestamps?: boolean;
  chunkSeconds?: number;
}

function getPhoWhisperBaseUrl(): string {
  const cfg = getConfig() as any;
  const configured = cfg?.phowhisperBaseUrl
    || cfg?.phoWhisperBaseUrl
    || cfg?.voice?.phowhisperBaseUrl
    || cfg?.voice?.phoWhisperBaseUrl;
  return String(configured || PHOWHISPER_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function audioExtensionForMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp4')) return 'mp4';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('m4a')) return 'm4a';
  return 'webm';
}

function normalizePhoWhisperMimeType(mimeType: string | undefined): string | null {
  const normalized = String(mimeType || 'audio/webm').split(';')[0].trim().toLowerCase();
  return PHOWHISPER_ALLOWED_MIME_TYPES.has(normalized) ? normalized : null;
}

async function transcribeWithPhoWhisper(payload: PosVoiceTranscribePayload): Promise<{
  ok: boolean;
  text?: string;
  model?: string;
  filename?: string;
  processingSeconds?: number;
  error?: string;
}> {
  const rawBase64 = String(payload?.audioBase64 || '').trim();
  const audioBase64 = rawBase64.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
  if (!audioBase64) return { ok: false, error: 'missing-audio' };
  if (audioBase64.length > PHOWHISPER_MAX_BASE64_CHARS) return { ok: false, error: 'audio-too-large' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(audioBase64)) return { ok: false, error: 'invalid-audio-base64' };

  const buffer = Buffer.from(audioBase64, 'base64');
  if (buffer.length < 128) return { ok: false, error: 'audio-too-short' };
  if (buffer.length > PHOWHISPER_MAX_AUDIO_BYTES) return { ok: false, error: 'audio-too-large' };

  const requestedModel = String(payload?.model || 'small').trim().toLowerCase();
  const model = PHOWHISPER_MODELS.has(requestedModel) ? requestedModel : 'small';
  const mimeType = normalizePhoWhisperMimeType(payload?.mimeType);
  if (!mimeType) return { ok: false, error: 'unsupported-audio-type' };
  const extension = audioExtensionForMime(mimeType);
  const filename = `pos-voice-${Date.now()}.${extension}`;
  const baseUrl = getPhoWhisperBaseUrl();

  const form = new FormData();
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  form.append('file', new Blob([arrayBuffer], { type: mimeType }), filename);
  form.append('model', model);
  if (payload?.timestamps != null) form.append('timestamps', payload.timestamps ? 'true' : 'false');
  if (payload?.chunkSeconds != null) {
    const chunkSeconds = Math.max(5, Math.min(120, Math.round(Number(payload.chunkSeconds) || 0)));
    form.append('chunk_seconds', String(chunkSeconds));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOWHISPER_TRANSCRIBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/v1/transcribe`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    const body = await response.text();
    let data: any = null;
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      data = { error: body };
    }

    if (!response.ok) {
      return {
        ok: false,
        error: data?.error || data?.detail || `phowhisper-http-${response.status}`,
      };
    }

    return {
      ok: true,
      text: String(data?.text || '').trim(),
      model: data?.model,
      filename: data?.filename || filename,
      processingSeconds: Number(data?.processing_seconds) || undefined,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.name === 'AbortError' ? 'phowhisper-timeout' : (err?.message || 'phowhisper-failed'),
    };
  } finally {
    clearTimeout(timeout);
  }
}

type NailTurnCheckoutGroup = {
  staffId: string;
  staffName: string | null;
  amountGrosze: number;
  tipGrosze: number;
};

function moneyGroszeToPln(grosze: number): number {
  return Math.max(0, Math.round(grosze)) / 100;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POS_PAYMENT_PREFLIGHT_TTL_MS = 15 * 60 * 1000;

function positiveGrosze(value: unknown): number {
  const amount = Math.round(Number(value) || 0);
  return amount > 0 ? amount : 0;
}

function base64UrlEncodeUtf8(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function parseKitchenSelfOrderOptions(value: string | null): string[] {
  const parsed = parseKitchenSelfOrderOptionsJson(value);
  return formatKitchenSelfOrderModifierLabels(parsed.modifiers, parsed.legacyOptions);
}

function compactKitchenSelfOrderQrText(value: string | null): string | undefined {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 80) : undefined;
}

function compactKitchenSelfOrderQrOptions(value: string | null): string[] | undefined {
  const options = parseKitchenSelfOrderOptions(value)
    .slice(0, 4)
    .map((item) => item.slice(0, 60))
    .filter(Boolean);
  return options.length > 0 ? options : undefined;
}

const KITCHEN_SELF_ORDER_QR_WITH_NOTES_MAX_LENGTH = 600;

function buildKitchenSelfOrderCompactQrPayload(
  order: KitchenSelfOrderWithItems,
  includeNotes: boolean,
  kitchenAlreadyReleased: boolean,
) {
  return {
    t: 'KSO',
    v: 1,
    id: order.id,
    n: order.order_number,
    f: order.fulfillment_type,
    s: order.source_label || null,
    kr: kitchenAlreadyReleased ? 1 : 0,
    i: order.items.map((item) => {
      const qrItem: [string | null, number, string?, string[]?, number?] = [item.variant_id, item.quantity];
      if (includeNotes) {
        const note = compactKitchenSelfOrderQrText(item.note);
        const options = compactKitchenSelfOrderQrOptions(item.options_json);
        if (note || options) {
          qrItem[2] = note || '';
          if (options) qrItem[3] = options;
        }
      }
      if (item.unit_price_grosze > 0) qrItem[4] = item.unit_price_grosze;
      return qrItem;
    }),
  };
}

function buildKitchenSelfOrderLabelQrPayload(
  order: KitchenSelfOrderWithItems,
  kitchenAlreadyReleased: boolean,
) {
  const encodeId = (value: string | null): string | null =>
    encodeKitchenSelfOrderUuidToken(value) || value || null;

  return {
    t: 'K',
    v: 1,
    id: encodeId(order.id),
    n: order.order_number,
    f: order.fulfillment_type === 'TAKEAWAY' ? 'T' : 'D',
    s: order.source_label || null,
    k: kitchenAlreadyReleased ? 1 : 0,
    i: order.items.map((item) => {
      const qrItem: [string | null, number, number?] = [encodeId(item.variant_id), item.quantity];
      if (item.unit_price_grosze > 0) qrItem[2] = item.unit_price_grosze;
      return qrItem;
    }),
  };
}

function buildKitchenSelfOrderQrPayload(
  order: KitchenSelfOrderWithItems,
  options: { kitchenAlreadyReleased?: boolean; includeNotes?: boolean } = {},
): string {
  const kitchenAlreadyReleased = options.kitchenAlreadyReleased !== false;
  if (options.includeNotes === false) {
    return `${KITCHEN_SELF_ORDER_QR_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(
      buildKitchenSelfOrderLabelQrPayload(order, kitchenAlreadyReleased),
    ))}`;
  }
  const withNotes = `${KITCHEN_SELF_ORDER_QR_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(
    buildKitchenSelfOrderCompactQrPayload(order, true, kitchenAlreadyReleased),
  ))}`;
  if (withNotes.length <= KITCHEN_SELF_ORDER_QR_WITH_NOTES_MAX_LENGTH) return withNotes;

  return `${KITCHEN_SELF_ORDER_QR_PREFIX}${base64UrlEncodeUtf8(JSON.stringify(
    buildKitchenSelfOrderLabelQrPayload(order, kitchenAlreadyReleased),
  ))}`;
}

function buildKitchenSelfOrderTicket(
  order: KitchenSelfOrderWithItems,
  brandName: string,
  qrPayload: string | null,
  fallbackSourceLabel = '',
): KitchenTicketData {
  return {
    orderId: order.id,
    orderNumber: order.order_number,
    createdAt: order.created_at,
    source: (() => { const l = (order.source_label || fallbackSourceLabel || '').trim(); return l ? `KIOSK ${l}` : 'KIOSK'; })(),
    fulfillmentType: order.fulfillment_type,
    kitchenLanguage: 'vi',
    customerLanguage: order.customer_language,
    pickupNumber: order.order_number,
    paymentStatus: 'UNPAID',
    qrPayload,
    brandName,
    totalGrosze: order.total_grosze,
    items: order.items.map((item) => ({
      name: item.name_snapshot,
      quantity: item.quantity,
      unitPriceGrosze: item.unit_price_grosze,
      lineTotalGrosze: item.line_total_grosze,
      modifiers: parseKitchenSelfOrderOptions(item.options_json),
      notes: item.note || null,
    })),
  };
}

function getRefundExpectedDeltaCandidates(data: RefundIpcPayload, requestedAmountGrosze: number, order: any): number[] {
  const candidates: number[] = [];
  const lines = data.lines ?? [];
  if (lines.length > 0 && lines.every((line) => typeof line.vatRate === 'number')) {
    const lineGrossTotal = lines.reduce((sum, line) => {
      const vatRate = typeof line.vatRate === 'number' ? line.vatRate : 0;
      return sum + Math.round(line.refundAmount * (1 + Math.max(0, vatRate) / 100));
    }, 0);
    if (lineGrossTotal > 0 && lineGrossTotal !== requestedAmountGrosze) {
      candidates.push(lineGrossTotal);
    }
  }

  const subtotalGrosze = Number(order?.subtotal) || 0;
  const taxGrosze = Number(order?.tax) || 0;
  const netSubtotalGrosze = subtotalGrosze - taxGrosze;
  if (requestedAmountGrosze > 0 && taxGrosze > 0 && netSubtotalGrosze > 0) {
    candidates.push(Math.round(requestedAmountGrosze * (subtotalGrosze / netSubtotalGrosze)));
  }

  return candidates;
}

export class PosModule extends BaseModule {
  readonly name = 'pos';

  private posStore: PosStore | null = null;
  private windowManager: WindowManager | null = null;
  private paymentController: PaymentController | null = null;
  private shiftController: ShiftController | null = null;
  private fiscalReceiptSyncTimer: ReturnType<typeof setInterval> | null = null;
  private fiscalReceiptSyncInFlight = false;
  private productAdminMutationOutbox: ProductAdminMutationOutbox | null = null;
  private productAdminMutationReplayTimer: ReturnType<typeof setInterval> | null = null;
  private billiardHandoffInFlight = new Map<string, Promise<any>>();
  private billiardTenderBoundaryInFlight = new Set<string>();
  private restoredCartDispatchQueue: Promise<void> = Promise.resolve();
  private frozenRestoredCartHolds = new Set<string>();
  private posAuthEpoch = new PosAuthEpochGuard();
  private holdRecallInFlight: { holdId: string; authContext: PosAuthContext } | null = null;
  private serverShiftMismatchError: string | null = null;
  private shiftVerificationGeneration = 0;
  private shiftVerificationInFlight: Promise<void> | null = null;
  private ordinaryPaymentPreflights = new Map<string, {
    orderId: string;
    shiftId: string;
    authContext: PosAuthContext;
    expiresAt: number;
  }>();

  constructor(private container: ServiceContainer) {
    super();
  }

  private capturePosAuthContext(scope = currentPosSnapshotScope(getConfig())): PosAuthContext {
    return this.posAuthEpoch.capture(scope);
  }

  private isPosAuthContextCurrent(context: PosAuthContext): boolean {
    try {
      const current = currentPosSnapshotScope(getConfig());
      return this.posAuthEpoch.isCurrent(context, current);
    } catch {
      return false;
    }
  }

  private assertServerShiftConsistentForPayment(): void {
    if (this.serverShiftMismatchError) {
      throw new Error(this.serverShiftMismatchError);
    }
  }

  private async awaitServerShiftConsistencyForPayment(): Promise<void> {
    // Auth/login/shift events can supersede a verification while it is in
    // flight. Loop until the generation remains unchanged across the await;
    // one stale promise is never enough to release a payment boundary.
    for (;;) {
      const generation = this.shiftVerificationGeneration;
      const inFlight = this.shiftVerificationInFlight;
      if (inFlight) await inFlight;
      if (
        generation === this.shiftVerificationGeneration
        && (!this.shiftVerificationInFlight || this.shiftVerificationInFlight === inFlight)
      ) {
        break;
      }
    }
    this.assertServerShiftConsistentForPayment();
  }

  private scheduleShiftVerification(localShiftId: string | null): Promise<void> {
    const generation = ++this.shiftVerificationGeneration;
    const work = this.verifyShiftWithServer(localShiftId, generation)
      .finally(() => {
        if (this.shiftVerificationGeneration === generation) {
          this.shiftVerificationInFlight = null;
        }
      });
    this.shiftVerificationInFlight = work;
    return work;
  }

  private async refreshServerShiftConsistencyForPayment(localShiftId: string): Promise<void> {
    await this.scheduleShiftVerification(localShiftId);
    // A concurrent, newer auth/shift verification supersedes the request
    // above. Await that latest result too before releasing a payment boundary.
    await this.awaitServerShiftConsistencyForPayment();
  }

  private pruneOrdinaryPaymentPreflights(now = Date.now()): void {
    for (const [token, entry] of this.ordinaryPaymentPreflights) {
      if (entry.expiresAt <= now) this.ordinaryPaymentPreflights.delete(token);
    }
    while (this.ordinaryPaymentPreflights.size > 50) {
      const oldest = this.ordinaryPaymentPreflights.keys().next().value;
      if (!oldest) break;
      this.ordinaryPaymentPreflights.delete(oldest);
    }
  }

  private async prepareOrdinaryPosPayment(orderId: string): Promise<{ token: string; expiresAt: number }> {
    const normalizedOrderId = String(orderId || '').trim();
    if (!UUID_RE.test(normalizedOrderId)) {
      throw new Error('A stable POS order ID is required before payment preflight.');
    }
    const authContext = this.capturePosAuthContext();
    const openShift = assertLocalOpenShiftMatchesSession(database, this.posStore);
    await this.refreshServerShiftConsistencyForPayment(openShift.id);
    if (!this.isPosAuthContextCurrent(authContext)) {
      throw new Error('POS user changed while payment safety was being verified.');
    }
    const verifiedShift = assertLocalOpenShiftMatchesSession(database, this.posStore);
    if (verifiedShift.id !== openShift.id) {
      throw new Error('The POS shift changed while payment safety was being verified.');
    }

    const token = randomUUID();
    const expiresAt = Date.now() + POS_PAYMENT_PREFLIGHT_TTL_MS;
    this.pruneOrdinaryPaymentPreflights();
    this.ordinaryPaymentPreflights.set(token, {
      orderId: normalizedOrderId,
      shiftId: verifiedShift.id,
      authContext,
      expiresAt,
    });
    return { token, expiresAt };
  }

  private assertOrdinaryPosPaymentPreflight(
    token: string,
    orderId: string,
    authContext: PosAuthContext,
  ): void {
    this.pruneOrdinaryPaymentPreflights();
    const entry = this.ordinaryPaymentPreflights.get(String(token || '').trim());
    if (!entry) {
      throw new Error('POS payment preflight is missing or expired. Reopen payment before collecting money.');
    }
    if (entry.orderId !== String(orderId || '').trim()) {
      throw new Error('POS payment preflight belongs to a different order.');
    }
    if (
      entry.authContext.epoch !== authContext.epoch
      || entry.authContext.scope.salonId !== authContext.scope.salonId
      || entry.authContext.scope.userId !== authContext.scope.userId
      || entry.authContext.scope.registerId !== authContext.scope.registerId
      || !this.isPosAuthContextCurrent(entry.authContext)
    ) {
      throw new Error('POS user changed after payment preflight. Reopen payment.');
    }
    const openShift = assertLocalOpenShiftMatchesSession(database, this.posStore);
    if (openShift.id !== entry.shiftId) {
      throw new Error('The POS shift changed after payment preflight. Reopen payment.');
    }
    this.assertServerShiftConsistentForPayment();
  }

  private invalidateShiftVerification(): void {
    this.shiftVerificationGeneration += 1;
    this.shiftVerificationInFlight = null;
    this.ordinaryPaymentPreflights.clear();
  }

  private setServerShiftMismatch(error: string | null): void {
    this.serverShiftMismatchError = error;
    if (error) {
      this.ordinaryPaymentPreflights.clear();
      logger.error(`[PosModule] Payment blocked by verified shift mismatch: ${error}`);
    }
  }

  /** Must match PaymentController's local-first fiscal route selection. */
  private getLocalPrinterForType(type: string): any | null {
    const hardware = this.container.getOptional<any>(SERVICE_TOKENS.HARDWARE_MODULE);
    const printer = typeof hardware?.getPrinterForType === 'function'
      ? hardware.getPrinterForType(type as PrinterType)
      : null;
    if (printer) return printer;

    const printers = this.container.getOptional<Record<string, any>>(SERVICE_TOKENS.PRINTERS) || {};
    return printers[type] || null;
  }

  async init(): Promise<void> {
    logger.info('[PosModule] Initializing...');

    this.posStore = new PosStore();
    this.windowManager = new WindowManager(this.posStore);

    // Get printer accessor from hardware module
    const getPrinterForType = (type: string) => this.getLocalPrinterForType(type);
    const isConnected = () => {
      const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
      return socket?.isConnected() || false;
    };

    // Persist a print_attempts row for each non-fiscal receipt print. Resolves
    // the configured printer's display name + target (COM port / Windows
    // printer / shared id) so Order History can show "Order: Xprinter XP-80T".
    const resolvePrinterMeta = (input: ReceiptPrintJournalInput): { name: string | null; target: string | null } => {
      if (input.route === 'SHARED_NETWORK') {
        return { name: input.printerId ? `Shared · ${input.printerId}` : 'Shared printer', target: input.printerId ?? null };
      }
      const cfg = getConfig();
      const dict = (cfg.printers || {}) as Record<string, any>;
      const p = dict[input.printerType] || (input.printerType === PrinterType.RECEIPT ? cfg.receiptPrinter : undefined);
      if (!p) return { name: null, target: null };
      const name = p.displayName || p.windowsPrinter || p.protocol || null;
      const target = p.port || p.windowsPrinter || p.address || null;
      return { name, target };
    };
    const recordPrintAttempt = (input: ReceiptPrintJournalInput) => {
      const meta = resolvePrinterMeta(input);
      const row = printAttemptRepo.record({
        orderId: input.orderId,
        documentType: input.documentType,
        printerType: input.printerType,
        printerName: meta.name,
        printerTarget: meta.target,
        route: input.route,
        status: input.status,
        error: input.error,
      });
      posEventEmitter.emitReceiptPrintAttempted({
        printAttemptId: row.id,
        orderId: input.orderId,
        documentType: input.documentType,
        printerType: String(input.printerType),
        route: input.route,
        status: input.status,
        error: input.error,
      });
    };
    const recordFiscalReceipt = (input: FiscalReceiptJournalInput) => {
      void (async () => {
        const order = orderRepo.getById(input.orderId);
        const backendOrderId = order?.backend_id || null;
        const queueOrderId = backendOrderId || input.orderId;
        const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidLike.test(queueOrderId)) {
          logger.warn(`[PosModule] Cannot queue fiscal event for ${input.orderId}: invalid local order UUID`);
          return;
        }

        try {
          const eventAt = new Date().toISOString();
          const body = {
            b2bOrderId: backendOrderId || undefined,
            printJobId: input.printJobId && uuidLike.test(input.printJobId) ? input.printJobId : undefined,
            status: input.status,
            source: 'POS_SYNC' as const,
            paymentMethod: input.paymentMethod ? input.paymentMethod.toUpperCase() : order?.payment_method || undefined,
            grossTotal: input.grossTotal ?? (order ? order.total / 100 : undefined),
            currency: 'PLN',
            printerType: 'FISCAL',
            printerDisplayName: input.printerId || undefined,
            errorMessage: input.error || undefined,
            printedAt: input.status === 'PRINTED' ? eventAt : undefined,
            failedAt: input.status === 'FAILED' ? eventAt : undefined,
            metadata: {
              localOrderId: input.orderId,
              localOrderNumber: order?.order_number || null,
              route: input.route,
              printerId: input.printerId || null,
              printJobId: input.printJobId || null,
            },
          };

          fiscalReceiptSyncRepo.enqueue({
            localOrderId: input.orderId,
            backendOrderId: queueOrderId,
            status: input.status,
            body,
          });
          posEventEmitter.emitFiscalReceiptEmitted({
            orderId: input.orderId,
            backendOrderId,
            status: input.status,
            grossTotalMinor:
              input.grossTotal != null
                ? Math.round(input.grossTotal * 100)
                : order?.total ?? null,
            printerProtocol: 'FISCAL',
            printJobId: input.printJobId || null,
            error: input.error || null,
            occurredAt: eventAt,
          });
          const flush = await database.save();
          if (!flush.success) {
            logger.warn(`[PosModule] Fiscal receipt event queued for ${input.orderId} but disk flush failed: ${flush.error || 'unknown error'}`);
          }
          void this.flushFiscalReceiptSyncQueue('record');
        } catch (err: any) {
          logger.warn(`[PosModule] Failed to queue fiscal receipt event for ${input.orderId}: ${err?.message || err}`);
        }
      })();
    };

    this.paymentController = new PaymentController(
      getPrinterForType,
      isConnected,
      () => getConfig().salonName,
      () => getConfig().receiptSellerName,
      () => getConfig().receiptSellerAddress,
      () => getConfig().receiptSellerNip,
      submitSharedReceiptPrint,
      submitSharedFiscalPrint,
      getSharedFiscalPrinterStatus,
      recordPrintAttempt,
      recordFiscalReceipt,
    );
    this.shiftController = new ShiftController(
      getPrinterForType,
      isConnected,
    );

    this.container.set(SERVICE_TOKENS.POS_STORE, this.posStore);
    this.container.set(SERVICE_TOKENS.WINDOW_MANAGER, this.windowManager);
    this.container.set(SERVICE_TOKENS.PAYMENT_CONTROLLER, this.paymentController);
    this.container.set(SERVICE_TOKENS.SHIFT_CONTROLLER, this.shiftController);

    // If a second-instance/focus event created the main window before POS init,
    // the orchestrator could not register it with PosStore yet. Register any
    // existing windows here so cart state broadcasts still reach the renderer.
    const existingWindows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
    for (const win of existingWindows) {
      this.posStore.registerWindow(win);
    }
    if (existingWindows.length > 0) {
      logger.info(`[PosModule] Registered ${existingWindows.length} existing window(s) with PosStore`);
    }

    // Crash recovery: orders marked synced=2 (in-flight) when the app crashed → reset to 0
    database.run('UPDATE orders SET synced = 0 WHERE synced = 2');
    // Repair corrupted state: synced=1 but no backend_id (response-shape bug fix side-effect)
    const corruptedCount = database.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM orders WHERE synced = 1 AND (backend_id IS NULL OR backend_id = '')",
    )?.cnt ?? 0;
    if (corruptedCount > 0) {
      database.run("UPDATE orders SET synced = 0, sync_attempts = 0, sync_error = NULL WHERE synced = 1 AND (backend_id IS NULL OR backend_id = '')");
      database.markDirty();
      logger.warn(`[PosModule] Reset ${corruptedCount} orders with missing backend_id for re-sync`);
    }
    try {
      const grossRepair = orderRepo.repairServerMirroredGrossItemPrices();
      if (grossRepair.repaired > 0) {
        logger.warn(
          `[PosModule] Server-mirrored gross item price repair: ` +
          `scanned=${grossRepair.scanned} repaired=${grossRepair.repaired} ` +
          `skipped=${grossRepair.skipped} reasons=${JSON.stringify(grossRepair.skipped_reasons)}`,
        );
      }
    } catch (err: any) {
      logger.error(`[PosModule] Server-mirrored gross item price repair failed: ${err?.message ?? err}`);
    }
    // NOTE: shelved orders (synced = -1) are NOT auto-reset. They require an explicit
    // retry via `pos:orders:retrySync` or one-time repair via `pos:orders:repairStockFailures`.

    // Orphan booking repair: bookings created via the Booking tab BEFORE
    // the atomic write fix (TEST123 / 5KOL on 2026-04-30) ended up in
    // `bookings` with no matching `local_sync_log` entry of
    // event='created', so the server never received them. Detect those
    // rows at boot and enqueue a fresh `booking/created` (plus a
    // follow-up `status_changed` for non-BOOKED orphans) so the next
    // push cycle delivers them.
    //
    // Idempotent: the SQL filters on
    //   NOT EXISTS (SELECT FROM local_sync_log WHERE event='created')
    // so a booking that already has a created log — even if its
    // companion status_changed got rejected — is left alone.
    try {
      const syncLog = this.container.getOptional<SyncLogService>(SERVICE_TOKENS.SYNC_LOG_SERVICE);
      if (syncLog) {
        const repair = repairOrphanBookings(syncLog);
        if (repair.scanned > 0) {
          logger.warn(
            `[PosModule] Orphan booking repair: scanned=${repair.scanned} enqueued=${repair.enqueued} enqueued_status=${repair.enqueued_status} skipped=${repair.skipped} reasons=${JSON.stringify(repair.skipped_reasons)}`,
          );
        }
      }
    } catch (err: any) {
      // Non-fatal — repair is a best-effort cleanup. A failure here must
      // not block the rest of POS init.
      logger.error(`[PosModule] Orphan booking repair failed: ${err?.message ?? err}`);
    }

    // Recover open shift from local DB (app restart during active shift).
    let openShift: ReturnType<typeof recoverOpenShiftFromLocal> = null;
    let localShiftRecoverySafe = true;
    try {
      openShift = recoverOpenShiftFromLocal(database, this.posStore);
      if (openShift) {
        logger.info(`[PosModule] Recovered open shift ${openShift.id} (${openShift.staff_name})`);
      }
    } catch (error: any) {
      localShiftRecoverySafe = false;
      logger.error(`[PosModule] Local shift recovery blocked: ${error?.message || String(error)}`);
    }

    // Cross-verify with server (async, non-blocking)
    if (localShiftRecoverySafe) this.scheduleShiftVerification(openShift?.id ?? null);

    this.setState(ModuleState.READY);
    logger.info('[PosModule] Initialized');
  }

  private async verifyShiftWithServer(localShiftId: string | null, generation: number): Promise<void> {
    try {
      const token = getSecureAuthToken();
      if (!token) return;
      const configuredMachineId = String(getConfigValue('machineId') ?? '').trim();
      if (!configuredMachineId) {
        if (generation === this.shiftVerificationGeneration) {
          this.setServerShiftMismatch(
            'This POS register has no machineId, so its server shift cannot be verified safely. Configure the register before taking payment.',
          );
        }
        return;
      }
      const serverShift = await apiClient.getActiveShift(token, configuredMachineId);
      if (generation !== this.shiftVerificationGeneration) {
        logger.debug('[PosModule] Ignoring stale server shift verification result');
        return;
      }
      if (serverShift && !localShiftId) {
        logger.warn(`[PosModule] Server has active shift ${serverShift.id} but local DB has none — restoring`);
        const existingShift = database.get<{
          id: string;
          staff_id: string | null;
          staff_name: string | null;
          closed_at: string | null;
        }>(
          'SELECT id, staff_id, staff_name, closed_at FROM shifts WHERE id = ?',
          [serverShift.id],
        );
        if (!existingShift) {
          database.run(
            `INSERT INTO shifts (id, staff_id, staff_name, opened_at, opening_cash, synced, backend_id)
             VALUES (?, ?, ?, ?, ?, 1, ?)`,
            [
              serverShift.id,
              serverShift.staffId ?? null,
              serverShift.staffName ?? null,
              serverShift.openedAt || new Date().toISOString(),
              Number(serverShift.openingCash) || 0,
              serverShift.id,
            ],
          );
          database.markDirty();
          logger.info(`[PosModule] Materialized server shift ${serverShift.id} in local DB`);
        } else if (existingShift.closed_at) {
          this.setServerShiftMismatch(
            `Server shift ${serverShift.id} is active, but its local payment journal is closed. Close the server shift and reopen it before taking payment.`,
          );
          return;
        }
        const restoredShift = database.get<{
          id: string;
          staff_id: string | null;
          staff_name: string | null;
          opened_at: string;
        }>(
          'SELECT id, staff_id, staff_name, opened_at FROM shifts WHERE id = ? AND closed_at IS NULL',
          [serverShift.id],
        );
        if (
          !restoredShift
          || !String(restoredShift.staff_id || '').trim()
          || !String(restoredShift.staff_name || '').trim()
        ) {
          this.setServerShiftMismatch(
            `Server shift ${serverShift.id} has no complete local cashier journal. Reconcile it before taking payment.`,
          );
          return;
        }
        this.posStore?.dispatch({
          type: 'session/open',
          payload: {
            shiftId: restoredShift.id,
            staffId: restoredShift.staff_id,
            staffName: restoredShift.staff_name,
            openedAt: restoredShift.opened_at,
          },
        });
        this.setServerShiftMismatch(null);
        return;
      }

      const localShift = localShiftId
        ? database.get<{
          id: string;
          staff_id: string | null;
          backend_id: string | null;
        }>(
          'SELECT id, staff_id, backend_id FROM shifts WHERE id = ? AND closed_at IS NULL',
          [localShiftId],
        )
        : null;
      if (localShiftId && !localShift) {
        this.setServerShiftMismatch(
          `POS shift ${localShiftId} is no longer open in the local payment journal. Close and reopen the shift before taking payment.`,
        );
        return;
      }

      const localBackendShiftId = localShift?.backend_id ?? null;

      this.setServerShiftMismatch(getVerifiedServerShiftMismatch({
        localShiftId,
        localBackendShiftId,
        serverShiftId: serverShift?.id ?? null,
      }));
    } catch (error: any) {
      // A transport/HTTP failure is not proof of a mismatch. Keep the last
      // verified state and preserve the existing offline-payment behavior.
      logger.debug(`[PosModule] Server shift verification skipped (offline or error): ${error?.message || error}`);
    }
  }

  private allowCustomerDisplayIpc(
    event: IpcMainInvokeEvent,
    channel: string,
    requiredProfile?: LiveCustomerDisplayProfile,
  ): boolean {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    const customerWin = this.windowManager?.getWindow('customer');
    if (!senderWin || !customerWin || senderWin !== customerWin) {
      logger.warn(`[PosModule] Rejected ${channel} from non-customer window`);
      return false;
    }

    if (requiredProfile) {
      const profile = resolveCustomerDisplayProfile(getConfig());
      if (profile !== requiredProfile) {
        logger.warn(`[PosModule] Rejected ${channel} for profile=${profile}; required=${requiredProfile}`);
        return false;
      }
    }

    return true;
  }

  private buildNailTurnCheckoutGroups(order: any, items: any[]): NailTurnCheckoutGroup[] {
    if (String(order?.mode || '').toLowerCase() !== 'salon') return [];

    const staffedItems = (items || [])
      .map((item: any) => ({
        staffId: String(item?.staff_id || '').trim(),
        staffName: item?.staff_name ? String(item.staff_name) : null,
        totalGrosze: positiveGrosze(item?.total),
      }))
      .filter((item) => item.staffId && item.totalGrosze > 0);
    if (staffedItems.length === 0) return [];

    const grossTotal = staffedItems.reduce((sum, item) => sum + item.totalGrosze, 0);
    const discount = Math.min(positiveGrosze(order?.discount), grossTotal);
    const tip = positiveGrosze(order?.tip);
    const netTotal = Math.max(0, grossTotal - discount);
    const groups = new Map<string, NailTurnCheckoutGroup>();

    let remainingNet = netTotal;
    staffedItems.forEach((item, index) => {
      const netLine = index === staffedItems.length - 1
        ? remainingNet
        : Math.max(0, item.totalGrosze - Math.round((item.totalGrosze / grossTotal) * discount));
      remainingNet = Math.max(0, remainingNet - netLine);

      const group = groups.get(item.staffId) || {
        staffId: item.staffId,
        staffName: item.staffName,
        amountGrosze: 0,
        tipGrosze: 0,
      };
      group.amountGrosze += netLine;
      if (!group.staffName && item.staffName) group.staffName = item.staffName;
      groups.set(item.staffId, group);
    });

    const result = Array.from(groups.values());
    if (tip > 0 && result.length > 0) {
      let remainingTip = tip;
      result.forEach((group, index) => {
        const share = index === result.length - 1
          ? remainingTip
          : netTotal > 0
            ? Math.round(tip * (group.amountGrosze / netTotal))
            : Math.round(tip / result.length);
        group.tipGrosze = Math.max(0, share);
        remainingTip = Math.max(0, remainingTip - group.tipGrosze);
      });
    }

    return result.filter((group) => group.amountGrosze > 0 || group.tipGrosze > 0);
  }

  private resolveNailTurnStaffProfileId(board: NailTurnBoardResponse, staffId: string): string | null {
    const staff = (board.staff || []).find((s: any) => s.staff_profile_id === staffId || s.user_id === staffId);
    return staff?.staff_profile_id || staffId || null;
  }

  private async syncNailTurnCheckoutForOrder(orderId: string, order: any, items: any[]): Promise<void> {
    const groups = this.buildNailTurnCheckoutGroups(order, items);
    if (groups.length === 0) return;

    const token = getSecureAuthToken();
    if (!token) {
      logger.debug(`[PosModule] Nail turn checkout skipped for ${orderId}: no auth token`);
      return;
    }

    const board = await apiClient.getNailTurnBoard(token);
    if (!board) {
      logger.debug(`[PosModule] Nail turn checkout skipped for ${orderId}: board unavailable`);
      return;
    }

    const usedAssignments = new Set<string>();
    let checkedOut = 0;
    for (const group of groups) {
      const staffProfileId = this.resolveNailTurnStaffProfileId(board, group.staffId);
      if (!staffProfileId) continue;

      const assignment = (board.active_assignments || []).find((item: any) =>
        item.staff_profile_id === staffProfileId
        && item.status === 'ASSIGNED'
        && !usedAssignments.has(item.id),
      );
      if (!assignment?.id) {
        logger.warn(
          `[PosModule] Nail turn checkout skipped for order ${orderId}: no active assignment for ${group.staffName || group.staffId}`,
        );
        continue;
      }

      const idempotencyKey = `pos-zira:nail-turn-checkout:${orderId}:${assignment.id}`;
      const result = await apiClient.checkoutNailTurnAssignment(token, assignment.id, {
        amount_pln: moneyGroszeToPln(group.amountGrosze),
        tip_pln: moneyGroszeToPln(group.tipGrosze),
        idempotency_key: idempotencyKey,
      });
      if (!result) {
        logger.debug(`[PosModule] Nail turn checkout unavailable for order ${orderId}, assignment ${assignment.id}`);
        continue;
      }

      checkedOut += 1;
      usedAssignments.add(assignment.id);
      logger.info(
        `[PosModule] Nail turn checked out for order ${orderId}: ${group.staffName || staffProfileId}, amount=${moneyGroszeToPln(group.amountGrosze).toFixed(2)} tip=${moneyGroszeToPln(group.tipGrosze).toFixed(2)}`,
      );
    }

    if (checkedOut > 0) {
      notifyPosRenderers(this.container, 'pos:nail-turns-updated', { orderId, checkedOut });
    }
  }

  private scheduleCacheKey(date?: string | null): string {
    const businessDate = date || new Date().toISOString().slice(0, 10);
    return `pos-schedule:${businessDate}`;
  }

  private saveScheduleCache(schedule: PosScheduleDayResponse): void {
    if (!schedule?.business_date) return;
    const updatedAt = new Date().toISOString();
    database.run(
      `INSERT OR REPLACE INTO pos_schedule_cache
        (cache_key, salon_id, business_date, payload_json, server_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        this.scheduleCacheKey(schedule.business_date),
        schedule.salon?.id ?? null,
        schedule.business_date,
        JSON.stringify(schedule),
        Number(schedule.version || 0),
        updatedAt,
      ],
    );
  }

  private getScheduleCache(date?: string | null): PosScheduleDayResponse | null {
    const row = database.get<{ payload_json: string; updated_at: string }>(
      `SELECT payload_json, updated_at
       FROM pos_schedule_cache
       WHERE cache_key = ?
       LIMIT 1`,
      [this.scheduleCacheKey(date)],
    );
    if (!row?.payload_json) return null;
    try {
      return {
        ...JSON.parse(row.payload_json),
        stale: true,
        cached_at: row.updated_at,
      };
    } catch (e: any) {
      logger.warn(`[PosModule] Failed to read POS schedule cache: ${e?.message ?? e}`);
      return null;
    }
  }

  private async fetchPosScheduleToday(date?: string): Promise<{ schedule: PosScheduleDayResponse; authMode: 'jwt' | 'agent' } | null> {
    const token = getSecureAuthToken();
    if (token) {
      try {
        const schedule = await apiClient.getPosScheduleToday(token, date);
        if (schedule) return { schedule, authMode: 'jwt' };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule JWT fetch failed, trying agent key: ${e?.message ?? e}`);
      }
    }

    const apiKey = getSecureApiKey();
    if (!apiKey) return null;
    const schedule = await apiClient.getPosScheduleTodayWithApiKey(apiKey, date);
    return schedule ? { schedule, authMode: 'agent' } : null;
  }

  private async fetchPosScheduleWeek(from?: string, days = 7): Promise<{ week: any; authMode: 'jwt' | 'agent' } | null> {
    const token = getSecureAuthToken();
    if (token) {
      try {
        const week = await apiClient.getPosScheduleWeek(token, from, days);
        if (week) return { week, authMode: 'jwt' };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule week JWT fetch failed, trying agent key: ${e?.message ?? e}`);
      }
    }

    const apiKey = getSecureApiKey();
    if (!apiKey) return null;
    const week = await apiClient.getPosScheduleWeekWithApiKey(apiKey, from, days);
    return week ? { week, authMode: 'agent' } : null;
  }

  private applyBilliardHandoffSnapshot(record: NonNullable<ReturnType<typeof billiardPosHandoffRepo.get>>, scope: ReturnType<typeof currentPosSnapshotScope>): void {
    if (!this.posStore || !samePosSnapshotScope(record.checkoutSnapshot, scope)) {
      throw new Error('Billiard checkout belongs to a different salon, user, or register.');
    }
    const configuredMode = String(getConfig().posMode || 'retail');
    if (record.checkoutSnapshot.posMode !== configuredMode) {
      throw new Error(`This checkout was frozen in ${record.checkoutSnapshot.posMode} mode. Switch POS back to that mode before resuming it.`);
    }
    assertBilliardCheckoutSnapshotIntegrity(record);
    this.posStore.dispatch({
      type: 'state/replaceCheckoutSnapshot',
      payload: { snapshot: record.checkoutSnapshot },
    });
    if (!isActiveBilliardCheckoutSnapshot(this.posStore.getState(), record.checkoutSnapshot)) {
      throw new Error('POS refused to activate the exact frozen Billiard cart.');
    }
  }

  private billiardIntent(record: NonNullable<ReturnType<typeof billiardPosHandoffRepo.get>>, recovered = false): BilliardPaymentIntent {
    const tenderOutcomeUncertain = requiresBilliardTenderReconciliation(record.state);
    return {
      checkoutId: record.checkoutId,
      sessionId: record.sessionId,
      orderId: record.orderId,
      clientAttemptId: record.clientAttemptId,
      nonce: randomUUID(),
      shouldAutoOpen: !tenderOutcomeUncertain && !record.autoOpenConsumed && record.state === 'POS_READY',
      recovered,
      tenderOutcomeUncertain: tenderOutcomeUncertain || undefined,
    };
  }

  private assertBilliardOrderLines(
    record: BilliardHandoffRecord,
    order: Record<string, any>,
    items: Array<Record<string, any>>,
  ): void {
    assertBilliardCheckoutSnapshotIntegrity(record);
    const savedCart = (record.checkoutSnapshot.state as any)?.cart;
    const expectedSubtotal = record.bundle.lines.reduce((sum, line) => sum + line.grossTotalGrosze, 0);
    if (
      String(order.id || '') !== record.orderId
      || String(order.client_attempt_id || '') !== record.clientAttemptId
      || Number(order.subtotal) !== expectedSubtotal
      || Number(order.discount || 0) !== record.bundle.discountGrosze
      || Number(order.tax || 0) !== Number(savedCart?.tax || 0)
      || Number(order.total) !== record.bundle.totalGrosze
      || items.length !== record.bundle.lines.length
    ) {
      throw new Error('Billiard order totals or identity do not match the frozen checkout.');
    }

    const byLineKey = new Map<string, Record<string, any>>();
    for (const item of items) {
      const metadata = parseBilliardJson(item.billiard_json, 'order-line');
      const lineKey = String(metadata.lineKey || '');
      if (!lineKey || byLineKey.has(lineKey)) {
        throw new Error('Billiard order contains a missing or duplicate line key.');
      }
      byLineKey.set(lineKey, item);
    }

    for (const line of record.bundle.lines) {
      const item = byLineKey.get(line.lineKey);
      if (!item) throw new Error(`Billiard order is missing frozen line ${line.lineKey}.`);
      const metadata = parseBilliardJson(item.billiard_json, 'order-line');
      const expectedMetadata = billiardLineMetadata(line);
      if (
        JSON.stringify(metadata) !== JSON.stringify(expectedMetadata)
        || String(item.id || '') !== `${record.orderId}:${line.lineKey}`
        || String(item.order_id || '') !== record.orderId
        || String(item.variant_id || '') !== line.variantId
        || String(item.name || '') !== line.displayName
        || String(item.sku ?? '') !== String(line.sku ?? '')
        || Number(item.price) !== line.unitPriceGrosze
        || Number(item.quantity) !== line.quantity
        || Number(item.sale_quantity ?? item.quantity) !== line.quantity
        || String(item.sell_by || '') !== line.sellBy
        || String(item.sale_unit || '') !== line.saleUnit
        || Number(item.total) !== line.grossTotalGrosze
        || Number(item.vat_rate) !== line.vatRate
        || String(item.inventory_policy || '') !== line.inventoryPolicy
        || String(item.refund_policy || '') !== line.refundPolicy
        || Number(item.allocated_discount || 0) !== line.allocatedDiscountGrosze
        || Number(item.payable_total) !== line.payableGrosze
      ) {
        throw new Error(`Billiard order line ${line.lineKey} differs from the frozen server snapshot.`);
      }
    }
  }

  private resolveBilliardOrderRequest(
    order: Record<string, any>,
    items: Array<Record<string, any>>,
    requireActiveCart: boolean,
  ): BilliardHandoffRecord | null {
    const hasBilliardData = Boolean(
      order?.billiard_origin_json
      || items.some((item) => item?.billiard_json),
    );
    if (!hasBilliardData) {
      if (String(order?.client_attempt_id || '').startsWith('billiard:')) {
        throw new Error('Billiard client attempt is missing its frozen order origin.');
      }
      return null;
    }

    const origin = parseBilliardJson(order?.billiard_origin_json, 'order-origin');
    if (origin.type !== 'BILLIARD_SESSION') throw new Error('Unsupported Billiard order origin.');
    const checkoutId = String(origin.checkoutId || '');
    const record = billiardPosHandoffRepo.get(checkoutId);
    if (!record) throw new Error('Billiard checkout safety journal was not found.');
    const scope = currentPosSnapshotScope(getConfig());
    if (
      record.salonId !== scope.salonId
      || record.userId !== scope.userId
      || record.registerId !== scope.registerId
      || origin.sessionId !== record.sessionId
      || Number(origin.snapshotVersion) !== record.bundle.schemaVersion
      || order.client_attempt_id !== record.clientAttemptId
    ) {
      throw new Error('Billiard order does not belong to this frozen checkout and register.');
    }
    if (record.state === 'SETTLED' && !orderRepo.getById(record.orderId)) {
      throw new Error('A settled Billiard checkout cannot create another local order.');
    }
    if (requireActiveCart) {
      if (record.state !== 'POS_TENDER_COMMITTING') {
        throw new Error(`Billiard tender is not authorized from state ${record.state}.`);
      }
      if (!this.posStore || !isActiveBilliardCheckoutSnapshot(this.posStore.getState(), record.checkoutSnapshot)) {
        throw new Error('The active POS cart does not exactly match this frozen Billiard checkout.');
      }
    }
    this.assertBilliardOrderLines(record, order, items);
    return record;
  }

  private assertExistingBilliardOrder(record: BilliardHandoffRecord): void {
    const existing = orderRepo.getById(record.orderId);
    if (!existing) throw new Error('Committed Billiard order is missing locally.');
    let origin: Record<string, any>;
    try { origin = JSON.parse(existing.billiard_origin_json || ''); }
    catch { throw new Error('Committed Billiard order has invalid origin metadata.'); }
    if (
      existing.client_attempt_id !== record.clientAttemptId
      || origin.type !== 'BILLIARD_SESSION'
      || origin.checkoutId !== record.checkoutId
      || origin.sessionId !== record.sessionId
      || Number(origin.snapshotVersion) !== record.bundle.schemaVersion
    ) {
      throw new Error('Existing local order conflicts with the Billiard checkout identity.');
    }
    this.assertBilliardOrderLines(record, existing as any, orderRepo.getItemsByOrderId(record.orderId) as any);
  }

  private assertRestoredCartOrderRequest(
    context: NonNullable<ReturnType<PosStore['getState']>['checkoutDraft']['restoredInterruption']>,
    payload: PosHoldPayload,
    order: Record<string, any>,
    items: Array<Record<string, any>>,
  ): RestoredCartCheckoutJournal {
    const journal = payload.restoredCheckout;
    if (!this.posStore || !isValidRestoredCartCheckoutJournal(journal)) {
      throw new Error('Restored-cart payment journal is invalid.');
    }
    if (!sameRestoredCartCheckoutIdentity(context, journal)) {
      throw new Error('Renderer restored-cart identity does not match the main-process journal.');
    }
    if (
      String(order.id || '') !== journal.orderId
      || String(order.client_attempt_id || '') !== journal.clientAttemptId
      || order.billiard_origin_json != null
    ) {
      throw new Error('Restored-cart order identity was not issued by Electron main.');
    }
    if (journal.state !== 'TENDER_COMMITTING') {
      throw new Error(`Restored-cart tender is not authorized from state ${journal.state}.`);
    }
    const state = this.posStore.getState();
    if (!isActiveRestoredCartSnapshot(state, payload.snapshot)) {
      throw new Error('The active restored cart does not exactly match its durable protected snapshot.');
    }
    const cart = state.cart;
    if (
      Number(order.subtotal) !== cart.subtotal
      || Number(order.discount) !== cart.discount
      || Number(order.tax) !== cart.tax
      || Number(order.total) !== cart.total
      || items.length !== cart.items.length
    ) {
      throw new Error('Restored-cart order totals do not match the main-process cart.');
    }
    cart.items.forEach((cartItem, index) => {
      const item = items[index];
      if (
        !item
        || String(item.variant_id || '') !== String(cartItem.variantId || '')
        || String(item.name || '') !== String(cartItem.name || '')
        || Number(item.price) !== cartItem.price
        || Number(item.quantity) !== cartItem.quantity
        || Number(item.total) !== cartItem.total
        || Number(item.vat_rate ?? 23) !== Number(cartItem.vatRate ?? 23)
      ) {
        throw new Error(`Restored-cart order line ${index + 1} does not match the main-process cart.`);
      }
    });
    return journal;
  }

  private assertExistingRestoredCartOrder(journal: RestoredCartCheckoutJournal): void {
    const existing = orderRepo.getById(journal.orderId);
    if (!existing || existing.client_attempt_id !== journal.clientAttemptId || existing.billiard_origin_json != null) {
      throw new Error('Existing local order conflicts with the restored-cart payment identity.');
    }
  }

  private scopedBilliardInterruptionHolds(scope = currentPosSnapshotScope(getConfig())) {
    const posMode = String(getConfig().posMode || 'retail');
    return holdOrderRepo.listDetailed().filter((held) => (
      held.payload.protected === true
      && held.payload.holdReason === 'BILLIARD_INTERRUPTION'
      && held.payload.snapshot?.posMode === posMode
      && samePosSnapshotScope(held.payload.snapshot, scope)
    ));
  }

  private discoverOwnerUncertainRestoredCart(scope: PosSnapshotScope): {
    reconciliation: RestoredCartReconciliation;
    changed: boolean;
  } | null {
    const found = holdOrderRepo.listDetailed().find((held) => {
      const journal = held.payload?.restoredCheckout;
      return held.payload?.protected === true
        && held.payload?.holdReason === 'BILLIARD_INTERRUPTION'
        && held.payload?.restoreState === 'ACTIVE_CART_BACKUP'
        && samePosSalonRegister(held.payload.snapshot, scope)
        && isValidRestoredCartCheckoutJournal(journal)
        && ['TENDER_COMMITTING', 'TENDER_UNCERTAIN'].includes(journal.state)
        && !orderRepo.getById(journal.orderId);
    });
    if (!found || !isValidRestoredCartCheckoutJournal(found.payload.restoredCheckout)) return null;

    const journal = found.payload.restoredCheckout;
    const uncertain = journal.state === 'TENDER_UNCERTAIN'
      ? journal
      : {
          ...journal,
          state: 'TENDER_UNCERTAIN' as const,
          updatedAt: new Date().toISOString(),
        };
    if (uncertain !== journal) {
      holdOrderRepo.replaceProtected(found.id, found.title, {
        ...found.payload,
        restoredCheckout: uncertain,
      });
      database.markDirty();
    }
    return {
      changed: uncertain !== journal,
      reconciliation: this.restoredCartReconciliation(
        found.id,
        String(found.payload.autoRestoreForCheckoutId || ''),
        uncertain,
      ),
    };
  }

  private createRestoredCartCheckoutJournal(): RestoredCartCheckoutJournal {
    const orderId = randomUUID();
    return {
      orderId,
      clientAttemptId: `restored:${orderId}`,
      state: 'READY',
      updatedAt: new Date().toISOString(),
    };
  }

  private configuredLocalFiscalProtocol(printer: any): string {
    const cfg = getConfig();
    const fiscalConfig = (cfg.printers || {})[PrinterType.FISCAL] as any;
    const legacyFiscalConfig = (cfg.printers || {})[PrinterType.RECEIPT] as any;
    const legacyProtocol = String(legacyFiscalConfig?.protocol || '').toUpperCase();
    const configured = String(
      fiscalConfig?.protocol
      || (['POSNET', 'ELZAB_STX'].includes(legacyProtocol) ? legacyProtocol : ''),
    ).toUpperCase();
    if (configured) return configured;

    // Legacy installs may have an instantiated driver but no migrated slot.
    // Constructor identity is used only as a compatibility fallback for the
    // same object PaymentController will actually call.
    const driverName = String(printer?.constructor?.name || '').toUpperCase();
    if (driverName.includes('POSNET')) return 'POSNET';
    if (driverName.includes('ELZAB')) return 'ELZAB_STX';
    return '';
  }

  private assertLocalTenderFiscalCompatibility(
    lines: TenderFiscalLine[],
    checkoutDiscountGrosze = 0,
  ): void {
    const localPrinter = this.getLocalPrinterForType(PrinterType.FISCAL);
    if (!localPrinter) return;
    const protocol = this.configuredLocalFiscalProtocol(localPrinter);
    if (
      hasTenderFiscalDiscount(lines, { checkoutDiscountGrosze })
      && !['POSNET', 'ELZAB_STX'].includes(protocol)
    ) {
      throw new Error(
        'FISCAL_PROTOCOL_UNKNOWN_FOR_DISCOUNT: the active local fiscal route protocol cannot be verified before payment.',
      );
    }
    assertTenderFiscalCompatibilityForProtocol(protocol, lines, { checkoutDiscountGrosze });
  }

  private async assertTenderFiscalCompatibility(
    lines: TenderFiscalLine[],
    checkoutDiscountGrosze = 0,
  ): Promise<void> {
    const localPrinter = this.getLocalPrinterForType(PrinterType.FISCAL);
    if (localPrinter) {
      this.assertLocalTenderFiscalCompatibility(lines, checkoutDiscountGrosze);
      return;
    }

    const shared = await getSharedFiscalPrinterStatus();
    if (!shared.printerId) return;
    const protocol = String(shared.protocol || '').toUpperCase();
    if (
      hasTenderFiscalDiscount(lines, { checkoutDiscountGrosze })
      && !['POSNET', 'ELZAB_STX'].includes(protocol)
    ) {
      throw new Error(
        'SHARED_FISCAL_PROTOCOL_UNKNOWN_FOR_DISCOUNT: the assigned shared fiscal printer protocol cannot be verified before payment.',
      );
    }
    assertTenderFiscalCompatibilityForProtocol(protocol, lines, { checkoutDiscountGrosze });
  }

  private ensureRestoredCartCheckoutJournal(payload: PosHoldPayload): {
    payload: PosHoldPayload;
    journal: RestoredCartCheckoutJournal;
  } {
    if (isValidRestoredCartCheckoutJournal(payload.restoredCheckout)) {
      return { payload, journal: payload.restoredCheckout };
    }
    if (payload.restoredCheckout != null) {
      throw new Error('Protected restored-cart payment journal is invalid. Reconciliation is required.');
    }
    const journal = this.createRestoredCartCheckoutJournal();
    return {
      payload: { ...payload, restoredCheckout: journal },
      journal,
    };
  }

  private restoredCartReconciliation(
    holdId: string,
    checkoutId: string,
    journal: RestoredCartCheckoutJournal,
  ): RestoredCartReconciliation {
    return {
      holdId,
      checkoutId,
      orderId: journal.orderId,
      clientAttemptId: journal.clientAttemptId,
      reason: 'TENDER_OUTCOME_UNCERTAIN',
      message: 'Payment outcome is uncertain. Do not charge this cart again. Reconcile cash/card and POS Order History with the owner.',
    };
  }

  private markLiveRestoredCart(
    held: { id: string; payload: PosHoldPayload },
    checkoutId: string,
    persistenceError?: string,
    authContext?: PosAuthContext,
  ): void {
    if (authContext && !this.isPosAuthContextCurrent(authContext)) return;
    if (!this.posStore || !isValidRestoredCartCheckoutJournal(held.payload.restoredCheckout)) return;
    this.posStore.dispatch({
      type: 'state/replaceCheckoutSnapshot',
      payload: {
        snapshot: withRestoredInterruptionMarker(
          held.payload.snapshot,
          held.id,
          checkoutId,
          held.payload.restoredCheckout,
          persistenceError,
        ),
      },
    });
  }

  private async markRestoredCartTenderUncertain(
    holdId: string,
    expectedOrderId: string,
    authContext?: PosAuthContext,
  ): Promise<{ reconciliation: RestoredCartReconciliation | null; durabilityError?: string }> {
    const held = holdOrderRepo.get(holdId);
    const payload = held?.payload as PosHoldPayload | undefined;
    const journal = payload?.restoredCheckout;
    if (!held || !payload || !isValidRestoredCartCheckoutJournal(journal) || journal.orderId !== expectedOrderId) {
      return { reconciliation: null };
    }
    const uncertain = journal.state === 'TENDER_UNCERTAIN'
      ? journal
      : {
          ...journal,
          state: 'TENDER_UNCERTAIN' as const,
          updatedAt: new Date().toISOString(),
        };
    const nextPayload: PosHoldPayload = {
      ...payload,
      restoreState: 'ACTIVE_CART_BACKUP',
      restoredCheckout: uncertain,
    };
    holdOrderRepo.replaceProtected(held.id, held.title, nextPayload);
    this.markLiveRestoredCart(
      { id: held.id, payload: nextPayload },
      String(payload.autoRestoreForCheckoutId || ''),
      undefined,
      authContext,
    );
    database.markDirty();
    const flush = await database.saveCoalesced();
    return {
      reconciliation: this.restoredCartReconciliation(
        held.id,
        String(payload.autoRestoreForCheckoutId || ''),
        uncertain,
      ),
      durabilityError: flush.success ? undefined : flush.error || 'database flush failed',
    };
  }

  /**
   * Rehydrate the full cart backup even after the Billiard handoff itself is
   * SETTLED. This is deliberately independent from the payment journal state:
   * the protected Hold owns the restored cart until its next explicit outcome.
   */
  private recoverProtectedBilliardInterruptionCart(): {
    restored: boolean;
    error?: string;
    reconciliation?: RestoredCartReconciliation;
  } {
    if (!this.posStore) return { restored: false, error: 'POS is not ready.' };
    const scope = currentPosSnapshotScope(getConfig());
    const posMode = String(getConfig().posMode || 'retail');
    const found = this.scopedBilliardInterruptionHolds(scope).find((row) => (
      row.payload.restoreState === 'ACTIVE_CART_BACKUP'
      || row.payload.restoreState === 'WAITING_FOR_BILLIARD_PAYMENT'
      || row.payload.restoreState == null
    ));
    if (!found) return { restored: false };
    let held = found;
    const checkoutId = String(held.payload.autoRestoreForCheckoutId || '');
    const sessionId = String(held.payload.sourceBilliardSessionId || '');
    const snapshot = getRestorableBilliardInterruptionSnapshot({
      payload: held.payload,
      checkoutId,
      sessionId,
      scope,
      posMode,
    });
    if (!snapshot) return { restored: false, error: 'Protected Billiard interruption Hold is invalid.' };

    if (held.payload.restoreState !== 'ACTIVE_CART_BACKUP') {
      const record = billiardPosHandoffRepo.get(checkoutId);
      if (!record || !orderRepo.getById(record.orderId)) return { restored: false };
      this.assertExistingBilliardOrder(record);
      return this.finalizeBilliardCartAfterLocalCommit(record);
    }

    const ensured = this.ensureRestoredCartCheckoutJournal(held.payload);
    if (ensured.payload !== held.payload) {
      holdOrderRepo.replaceProtected(held.id, held.title, ensured.payload);
      held = { ...held, payload: ensured.payload };
    }
    let journal = ensured.journal;
    const recoveryDisposition = restoredCartRecoveryDisposition(
      held.payload,
      orderRepo.getById(journal.orderId) != null,
    );
    if (recoveryDisposition === 'RECONCILE' && journal.state === 'TENDER_COMMITTING') {
      journal = {
        ...journal,
        state: 'TENDER_UNCERTAIN',
        updatedAt: new Date().toISOString(),
      };
      const payload = { ...held.payload, restoredCheckout: journal };
      holdOrderRepo.replaceProtected(held.id, held.title, payload);
      held = { ...held, payload };
    }
    if (recoveryDisposition === 'RECONCILE' || journal.state === 'TENDER_UNCERTAIN') {
      return {
        restored: false,
        reconciliation: this.restoredCartReconciliation(held.id, checkoutId, journal),
      };
    }
    if (recoveryDisposition !== 'RESTORE' || journal.state !== 'READY') return { restored: false };

    const current = this.posStore.getState();
    const marker = current.checkoutDraft.restoredInterruption;
    if (marker?.holdId === held.id && marker.checkoutId === checkoutId) {
      if (!sameRestoredCartCheckoutIdentity(marker, journal)) {
        return { restored: false, error: 'The active restored cart has a different durable payment identity.' };
      }
      return { restored: true };
    }
    if (current.checkoutDraft.billiard) return { restored: false };
    if (current.cart.items.length > 0 && !hasEquivalentOrdinaryCart(current, snapshot)) {
      return {
        restored: false,
        error: 'Another POS cart is active. Hold it before restoring the interrupted cart.',
      };
    }
    this.posStore.dispatch({
      type: 'state/replaceCheckoutSnapshot',
      payload: { snapshot: withRestoredInterruptionMarker(snapshot, held.id, checkoutId, journal) },
    });
    return { restored: true };
  }

  /**
   * Called synchronously after the paid order and handoff state commit in
   * sql.js. It clears only the exact frozen cart, then restores the protected
   * interruption Hold without consuming that safety row yet.
   */
  private finalizeBilliardCartAfterLocalCommit(record: BilliardHandoffRecord): { restored: boolean; restoredHoldId: string | null } {
    if (!this.posStore) throw new Error('POS is not ready.');
    const state = this.posStore.getState();
    const liveCheckoutId = state.checkoutDraft.billiard?.origin.checkoutId;
    if (liveCheckoutId) {
      if (
        liveCheckoutId !== record.checkoutId
        || !isActiveBilliardCheckoutSnapshot(state, record.checkoutSnapshot)
      ) {
        throw new Error('Refused to clear a POS cart that differs from the committed Billiard checkout.');
      }
      if (!this.posStore.markBilliardOrderCommitted(record.checkoutId, record.orderId)) {
        throw new Error('Could not authorize clearing the committed Billiard cart.');
      }
      this.posStore.dispatch({ type: 'cart/completeCheckout' });
    }

    const afterClear = this.posStore.getState();
    if (!record.interruptedHoldId) {
      return { restored: false, restoredHoldId: null };
    }
    const held = holdOrderRepo.get(record.interruptedHoldId);
    const payload = held?.payload as PosHoldPayload | undefined;
    const scope = currentPosSnapshotScope(getConfig());
    const restorableSnapshot = getRestorableBilliardInterruptionSnapshot({
      payload,
      checkoutId: record.checkoutId,
      sessionId: record.sessionId,
      scope,
      posMode: String(getConfig().posMode || 'retail'),
    });
    if (!restorableSnapshot) {
      return { restored: false, restoredHoldId: null };
    }
    if (afterClear.cart.items.length > 0 && !hasEquivalentOrdinaryCart(afterClear, restorableSnapshot)) {
      return { restored: false, restoredHoldId: null };
    }
    const ensured = this.ensureRestoredCartCheckoutJournal(payload!);
    if (ensured.journal.state !== 'READY') {
      return { restored: false, restoredHoldId: record.interruptedHoldId };
    }
    const activePayload: PosHoldPayload = {
      ...ensured.payload,
      restoreState: 'ACTIVE_CART_BACKUP',
    };
    holdOrderRepo.replaceProtected(record.interruptedHoldId, held!.title, activePayload);
    const existingMarker = afterClear.checkoutDraft.restoredInterruption;
    if (
      existingMarker?.holdId === record.interruptedHoldId
      && existingMarker.checkoutId === record.checkoutId
      && sameRestoredCartCheckoutIdentity(existingMarker, ensured.journal)
    ) {
      return { restored: true, restoredHoldId: record.interruptedHoldId };
    }
    this.posStore.dispatch({
      type: 'state/replaceCheckoutSnapshot',
      payload: {
        snapshot: withRestoredInterruptionMarker(
          restorableSnapshot,
          record.interruptedHoldId,
          record.checkoutId,
          ensured.journal,
        ),
      },
    });
    return { restored: true, restoredHoldId: record.interruptedHoldId };
  }

  private assertNewBilliardHandoffReadiness(scope: PosSnapshotScope) {
    if (!this.posStore) throw new Error('POS is not ready.');
    if (this.holdRecallInFlight) {
      throw new Error('A held cart recall is still being saved. Wait before ending the Billiard session.');
    }

    const unresolved = billiardPosHandoffRepo.getRecoverable(scope);
    const registerUncertain = billiardPosHandoffRepo.getUncertainForOwner(scope);
    if (unresolved || registerUncertain) {
      throw new Error('Another Billiard checkout is still unresolved on this register.');
    }

    const current = this.posStore.getState();
    if (current.checkoutDraft.kitchenSelfOrder?.pickupOrderId) {
      throw new Error('Finish or release the active kitchen pickup order before paying a Billiard session.');
    }
    if (current.checkoutDraft.billiard) {
      throw new Error('Another frozen Billiard checkout is already active.');
    }

    const previousRestored = current.checkoutDraft.restoredInterruption;
    const previousProtectedHold = previousRestored
      ? holdOrderRepo.get(previousRestored.holdId)
      : null;
    if (previousRestored && (
      !previousProtectedHold
      || previousProtectedHold.payload?.protected !== true
      || previousProtectedHold.payload?.restoreState !== 'ACTIVE_CART_BACKUP'
      || !isValidRestoredCartCheckoutJournal(previousProtectedHold.payload?.restoredCheckout)
      || !sameRestoredCartCheckoutIdentity(previousRestored, previousProtectedHold.payload.restoredCheckout)
      || previousProtectedHold.payload.restoredCheckout.state !== 'READY'
      || this.frozenRestoredCartHolds.has(previousRestored.holdId)
    )) {
      throw new Error('The current restored cart is not in a safe durable state for another Billiard handoff.');
    }

    if (current.cart.items.length > 0) {
      withoutRestoredInterruptionMarker(capturePosCheckoutSnapshot(
        current,
        scope,
        String(getConfig().posMode || 'retail'),
      ));
    }
    return { current, previousRestored, previousProtectedHold };
  }

  private async preflightBilliardHandoff(): Promise<void> {
    const config = getConfig();
    const scope = currentPosSnapshotScope(config);
    const authContext = this.capturePosAuthContext(scope);

    const openShift = assertLocalOpenShiftMatchesSession(database, this.posStore);
    await this.refreshServerShiftConsistencyForPayment(openShift.id);
    this.assertNewBilliardHandoffReadiness(scope);

    const fiscal = await (this.paymentController?.hasFiscalPrinter?.()
      ?? Promise.resolve({ configured: false, connected: false }));
    const localFiscalEnabled = config.printers?.FISCAL?.enabled === true;
    const fiscalPreflight = {
      allowRealFiscalPrint: config.allowRealFiscalPrint,
      fiscalOnCashSale: config.fiscalOnCashSale,
      localFiscalEnabled,
      detectedFiscalConfigured: fiscal.configured,
    };
    assertBilliardRealFiscalGate(fiscalPreflight);
    const fiscalRequired = requiresBilliardFiscalPrinterReadiness(fiscalPreflight);
    if (fiscalRequired && (!fiscal.configured || !fiscal.connected)) {
      throw new Error('The fiscal printer is not ready. Connect it before ending this Billiard session.');
    }

    // Force a no-op durability barrier while the table is still running.
    // If sql.js cannot atomically persist the current cart/shift state, the
    // server session must not be ended.
    database.markDirty();
    const flush = await database.saveCoalesced();
    if (!flush.success) {
      throw new Error(`POS safety journal is not durable: ${flush.error || 'database flush failed'}`);
    }
    if (!this.isPosAuthContextCurrent(authContext)) {
      throw new Error('POS user changed while Billiard payment readiness was being checked.');
    }
  }

  private async prepareBilliardHandoff(input: any): Promise<any> {
    const bundle = normalizeBilliardPosCheckout(input?.posCheckout);
    const existingFlight = this.billiardHandoffInFlight.get(bundle.checkoutId);
    if (existingFlight) return existingFlight;

    const work = (async () => {
      if (!this.posStore) throw new Error('POS is not ready.');
      const config = getConfig();
      const scope = currentPosSnapshotScope(config);
      const authContext = this.capturePosAuthContext(scope);
      const existing = billiardPosHandoffRepo.get(bundle.checkoutId);
      if (existing) {
        if (
          existing.salonId !== scope.salonId
          || existing.userId !== scope.userId
          || existing.registerId !== scope.registerId
          || existing.sessionId !== bundle.sessionId
          || JSON.stringify(existing.bundle) !== JSON.stringify(bundle)
        ) {
          throw new Error('This Billiard checkout ID already has a different frozen snapshot.');
        }
        assertBilliardCheckoutSnapshotIntegrity(existing);
        // A previous prepare may have changed sql.js memory but failed its
        // disk barrier. Never activate that cart until a fresh barrier wins.
        database.markDirty();
        const journalFlush = await database.saveCoalesced();
        if (!journalFlush.success) {
          throw new Error(`Billiard checkout safety journal is not durable yet: ${journalFlush.error || 'database flush failed'}`);
        }
        if (!this.isPosAuthContextCurrent(authContext)) {
          throw new Error('POS user changed while the Billiard handoff journal was being saved.');
        }
        if (orderRepo.getById(existing.orderId)) {
          this.assertExistingBilliardOrder(existing);
          if (existing.state !== 'SETTLED') {
            billiardPosHandoffRepo.markState(existing.checkoutId, 'POS_PAID_SYNC_PENDING');
          }
          database.markDirty();
          this.posStore.markBilliardOrderCommitted(existing.checkoutId, existing.orderId);
          const flush = await database.saveCoalesced();
          if (!this.isPosAuthContextCurrent(authContext)) {
            return {
              success: false,
              paymentCommitted: true,
              error: 'POS user changed while the committed Billiard order was being verified.',
            };
          }
          if (flush.success) {
            this.finalizeBilliardCartAfterLocalCommit(existing);
            database.markDirty();
            await database.saveCoalesced();
          }
          return {
            success: true,
            paymentCommitted: true,
            durabilityError: flush.success ? undefined : flush.error,
            intent: this.billiardIntent({ ...existing, state: 'POS_PAID_SYNC_PENDING' }, true),
          };
        }
        if (requiresBilliardTenderReconciliation(existing.state)) {
          return {
            success: true,
            outcomeUncertain: true,
            intent: this.billiardIntent(existing, true),
          };
        }
        const openShift = assertLocalOpenShiftMatchesSession(database, this.posStore);
        await this.refreshServerShiftConsistencyForPayment(openShift.id);
        const liveCheckout = this.posStore.getState().checkoutDraft.billiard?.origin.checkoutId;
        const liveItems = this.posStore.getState().cart.items.length;
        if (liveItems > 0 && liveCheckout !== existing.checkoutId) {
          throw new Error('Another POS cart is active. Hold it before resuming this Billiard checkout.');
        }
        if (liveCheckout === existing.checkoutId) {
          if (!isActiveBilliardCheckoutSnapshot(this.posStore.getState(), existing.checkoutSnapshot)) {
            throw new Error('The active POS cart does not exactly match the frozen Billiard checkout.');
          }
        } else {
          if (!this.isPosAuthContextCurrent(authContext)) {
            throw new Error('POS user changed before the Billiard checkout could be activated.');
          }
          this.applyBilliardHandoffSnapshot(existing, scope);
        }
        return { success: true, intent: this.billiardIntent(existing, true) };
      }

      const openShift = assertLocalOpenShiftMatchesSession(database, this.posStore);
      await this.refreshServerShiftConsistencyForPayment(openShift.id);
      const {
        current,
        previousRestored,
        previousProtectedHold,
      } = this.assertNewBilliardHandoffReadiness(scope);

      const orderId = randomUUID();
      const interruptedHoldId = current.cart.items.length > 0
        ? `billiard-interruption:${bundle.checkoutId}`
        : null;
      const posMode = String(config.posMode || 'retail');
      const interruptedSnapshot = interruptedHoldId
        ? withoutRestoredInterruptionMarker(capturePosCheckoutSnapshot(current, scope, posMode))
        : null;
      const checkoutSnapshot = buildBilliardCheckoutSnapshot({
        currentState: current,
        bundle,
        scope,
        posMode,
        orderId,
        interruptedHoldId,
        tableName: input?.tableName ? String(input.tableName) : null,
      });

      database.transaction(() => {
        if (interruptedHoldId && interruptedSnapshot) {
          const holdPayload = buildBilliardInterruptionHoldPayload({
            snapshot: interruptedSnapshot,
            sessionId: bundle.sessionId,
            checkoutId: bundle.checkoutId,
          });
          holdOrderRepo.upsert(interruptedHoldId, 'Cart interrupted by Billiard payment', holdPayload);
        }
        if (previousRestored) holdOrderRepo.remove(previousRestored.holdId, true);
        billiardPosHandoffRepo.create({
          checkoutId: bundle.checkoutId,
          sessionId: bundle.sessionId,
          orderId,
          clientAttemptId: `billiard:${bundle.checkoutId}`,
          salonId: scope.salonId,
          userId: scope.userId,
          registerId: scope.registerId,
          state: 'POS_READY',
          bundle,
          checkoutSnapshot,
          interruptedHoldId,
          autoOpenConsumed: false,
        });
      });
      database.markDirty();
      const flush = await database.saveCoalesced();
      if (!flush.success) {
        // Revert sql.js memory to the still-live cart ownership. A failed
        // atomic export leaves the previous on-disk Hold untouched as well.
        try {
          database.transaction(() => {
            database.run('DELETE FROM pos_billiard_handoffs WHERE checkout_id = ?', [bundle.checkoutId]);
            if (interruptedHoldId) holdOrderRepo.remove(interruptedHoldId, true);
            if (previousRestored && previousProtectedHold) {
              holdOrderRepo.upsert(previousRestored.holdId, previousProtectedHold.title, previousProtectedHold.payload);
            }
          });
          database.markDirty();
          void database.saveCoalesced();
        } catch {}
        throw new Error(`Could not safely hold the current POS cart: ${flush.error || 'database flush failed'}`);
      }

      if (!this.isPosAuthContextCurrent(authContext)) {
        throw new Error('POS user changed while the Billiard handoff was being saved. The old user can recover it after login.');
      }

      const record = billiardPosHandoffRepo.get(bundle.checkoutId);
      if (!record) throw new Error('Billiard checkout journal was not created.');
      this.applyBilliardHandoffSnapshot(record, scope);
      return { success: true, intent: this.billiardIntent(record) };
    })().finally(() => {
      this.billiardHandoffInFlight.delete(bundle.checkoutId);
    });
    this.billiardHandoffInFlight.set(bundle.checkoutId, work);
    return work;
  }

  registerIpcHandlers(): void {
    // State & dispatch
    ipcMain.handle('pos:get-state', (e) => {
      const state = this.posStore?.getState();
      logger.info(`[PosModule] IPC pos:get-state from window="${e.sender.getTitle?.() ?? 'unknown'}" → mode=${state?.display?.mode}`);
      return state;
    });
    ipcMain.handle('pos:dispatch', async (_e, rendererAction) => {
      let authContext: PosAuthContext;
      try { authContext = this.capturePosAuthContext(); }
      catch { return { success: false, error: 'POS authentication context is unavailable.' }; }
      const expectedRestoredHoldId = this.posStore?.getState().checkoutDraft.restoredInterruption?.holdId ?? null;
      const execute = async () => {
        if (!this.isPosAuthContextCurrent(authContext)) {
          return { success: false, error: 'POS user changed before this update could be applied.' };
        }
        let action = rendererAction;
        if (action?.type === 'state/replaceCheckoutSnapshot') {
          return { success: false, error: 'main_process_only_action' };
        }
        if (action?.type === 'checkoutDraft/update') {
          const {
            billiard: _billiard,
            restoredInterruption: _restored,
            holdRecallPending: _recallPending,
            ...rendererDraft
          } = action.payload || {};
          action = { ...action, payload: rendererDraft };
        }
        if (action?.type === 'cart/addItem') {
          const { billiard: _billiard, locked: _locked, ...rendererItem } = action.payload || {};
          action = { ...action, payload: rendererItem };
        }
        const posStore = this.posStore;
        if (!posStore) return { success: false, error: 'POS is not ready.' };
        const before = posStore.getState();
        const isNonFinancialUiAction = action?.type === 'display/setMode' || action?.type === 'session/open';
        if (this.holdRecallInFlight && !isNonFinancialUiAction) {
          return {
            success: false,
            error: 'Held cart recall is still being saved. Wait before editing or paying this cart.',
          };
        }
        const restored = before.checkoutDraft.restoredInterruption;
        if (expectedRestoredHoldId && restored?.holdId !== expectedRestoredHoldId) {
          return { success: false, error: 'Stale restored-cart edit was ignored after its ownership changed.' };
        }
        if (
          action?.type === 'session/close'
          && (before.checkoutDraft.billiard || restored)
        ) {
          return {
            success: false,
            error: 'Pay, hold, or discard the protected POS cart before closing this shift.',
          };
        }
        const protectedHold = restored ? holdOrderRepo.get(restored.holdId) : null;
        if (restored && action?.type === 'cart/completeCheckout' && protectedHold?.payload?.protected === true) {
          return { success: false, error: 'The restored cart can complete only after its order is committed.' };
        }
        if (restored && (!protectedHold
          || protectedHold.payload?.restoreState !== 'ACTIVE_CART_BACKUP'
          || !isValidRestoredCartCheckoutJournal(protectedHold.payload?.restoredCheckout)
          || !sameRestoredCartCheckoutIdentity(restored, protectedHold.payload.restoredCheckout))) {
          return { success: false, error: 'The durable backup for this restored cart is unavailable or has changed.' };
        }

        if (restored && !isNonFinancialUiAction) {
          if (this.frozenRestoredCartHolds.has(restored.holdId) || restored.persistenceError) {
            return { success: false, error: restored.persistenceError || 'Restored cart is frozen after a disk persistence failure. Restart POS before editing it.' };
          }
          if (protectedHold!.payload.restoredCheckout.state !== 'READY') {
            return { success: false, error: 'This restored cart crossed the tender boundary. Do not edit or charge it again.' };
          }
        }

        posStore.dispatch(action);
        if (!restored || isNonFinancialUiAction) return { success: true };

        const after = posStore.getState();
        if (after.cart.items.length === 0) {
          // An explicit pre-tender discard releases ownership only after the
          // protected row deletion crosses its own disk barrier.
          holdOrderRepo.remove(restored.holdId, true);
          database.markDirty();
          const flush = await database.saveCoalesced();
          if (!flush.success) {
            holdOrderRepo.upsert(restored.holdId, protectedHold!.title, protectedHold!.payload);
            const error = flush.error || 'Could not durably discard the restored cart.';
            this.frozenRestoredCartHolds.add(restored.holdId);
            this.markLiveRestoredCart(
              { id: restored.holdId, payload: protectedHold!.payload },
              restored.checkoutId,
              error,
              authContext,
            );
            database.markDirty();
            void database.saveCoalesced();
            return { success: false, error };
          }
          return { success: true };
        }

        const scope = currentPosSnapshotScope(getConfig());
        const snapshot = withoutRestoredInterruptionMarker(capturePosCheckoutSnapshot(
          after,
          scope,
          String(getConfig().posMode || 'retail'),
        ));
        const nextPayload: PosHoldPayload = {
          ...protectedHold!.payload,
          snapshot,
          restoreState: 'ACTIVE_CART_BACKUP',
        };
        holdOrderRepo.replaceProtected(restored.holdId, protectedHold!.title, nextPayload);
        database.markDirty();
        const flush = await database.saveCoalesced();
        if (!flush.success) {
          // Restored-cart IPC actions are serialized, so reverting this exact
          // before-image cannot erase a later successful edit.
          holdOrderRepo.replaceProtected(restored.holdId, protectedHold!.title, protectedHold!.payload);
          const error = flush.error || 'Could not update the restored cart backup.';
          this.frozenRestoredCartHolds.add(restored.holdId);
          this.markLiveRestoredCart(
            { id: restored.holdId, payload: protectedHold!.payload },
            restored.checkoutId,
            error,
            authContext,
          );
          database.markDirty();
          void database.saveCoalesced();
          return { success: false, error };
        }
        return { success: true };
      };

      if (!expectedRestoredHoldId) return execute();
      const queued = this.restoredCartDispatchQueue.then(execute, execute);
      this.restoredCartDispatchQueue = queued.then(() => undefined, () => undefined);
      return queued;
    });
    ipcMain.handle('pos:billiard:preflight-handoff', async () => {
      try {
        await this.preflightBilliardHandoff();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    });
    ipcMain.handle('pos:billiard:prepare-handoff', async (_e, input: any) => {
      try { return await this.prepareBilliardHandoff(input); }
      catch (error: any) { return { success: false, error: error?.message || String(error) }; }
    });
    ipcMain.handle('pos:billiard:recover-handoff', async () => {
      try {
        if (!this.posStore) return { success: false, error: 'POS is not ready.' };
        const config = getConfig();
        const scope = currentPosSnapshotScope(config);
        const authContext = this.capturePosAuthContext(scope);
        const isOwner = String(config.authUser?.role || '').toUpperCase() === 'OWNER';
        const record = billiardPosHandoffRepo.getRecoverable(scope)
          ?? (isOwner ? billiardPosHandoffRepo.getUncertainForOwner(scope) : null);
        if (!record) {
          if (isOwner) {
            const ownerRestored = this.discoverOwnerUncertainRestoredCart(scope);
            if (ownerRestored) {
              if (ownerRestored.changed) {
                const ownerRecoveryFlush = await database.saveCoalesced();
                if (!ownerRecoveryFlush.success) {
                  return {
                    success: false,
                    intent: null,
                    restoredCartReconciliation: ownerRestored.reconciliation,
                    error: ownerRecoveryFlush.error || 'Owner tender-recovery state was not made durable.',
                  };
                }
              }
              if (!this.isPosAuthContextCurrent(authContext)) {
                return { success: false, intent: null, error: 'POS user changed during owner tender discovery.' };
              }
              return {
                success: true,
                intent: null,
                outcomeUncertain: true,
                restoredCartReconciliation: ownerRestored.reconciliation,
              };
            }
          }
          const protectedRecovery = this.recoverProtectedBilliardInterruptionCart();
          if (protectedRecovery.error) {
            return { success: false, intent: null, error: protectedRecovery.error };
          }
          if (protectedRecovery.restored || protectedRecovery.reconciliation) {
            database.markDirty();
            const flush = await database.saveCoalesced();
            if (!flush.success) {
              return {
                success: false,
                intent: null,
                restoredCartReconciliation: protectedRecovery.reconciliation,
                error: flush.error || 'Restored-cart recovery state was not made durable.',
              };
            }
          }
          return {
            success: true,
            intent: null,
            restoredCart: protectedRecovery.restored,
            restoredCartReconciliation: protectedRecovery.reconciliation,
          };
        }
        assertBilliardCheckoutSnapshotIntegrity(record);
        if (orderRepo.getById(record.orderId)) {
          this.assertExistingBilliardOrder(record);
          if (record.state !== 'SETTLED') {
            billiardPosHandoffRepo.markState(record.checkoutId, 'POS_PAID_SYNC_PENDING');
          }
          database.markDirty();
          this.posStore.markBilliardOrderCommitted(record.checkoutId, record.orderId);
          const flush = await database.saveCoalesced();
          if (!this.isPosAuthContextCurrent(authContext)) {
            return { success: false, intent: null, paymentCommitted: true, error: 'POS user changed during Billiard recovery.' };
          }
          let restoredCartReconciliation: RestoredCartReconciliation | undefined;
          if (flush.success) {
            this.finalizeBilliardCartAfterLocalCommit(record);
            database.markDirty();
            await database.saveCoalesced();
            if (!this.isPosAuthContextCurrent(authContext)) {
              return { success: false, intent: null, paymentCommitted: true, error: 'POS user changed during Billiard cart recovery.' };
            }
            const protectedRecovery = this.recoverProtectedBilliardInterruptionCart();
            restoredCartReconciliation = protectedRecovery.reconciliation;
            if (restoredCartReconciliation) {
              database.markDirty();
              await database.saveCoalesced();
            }
          }
          return {
            success: true,
            paymentCommitted: true,
            durabilityError: flush.success ? undefined : flush.error,
            restoredCartReconciliation,
            intent: this.billiardIntent({ ...record, state: 'POS_PAID_SYNC_PENDING' }, true),
          };
        }
        if (record.state === 'POS_TENDER_COMMITTING') {
          if (!billiardPosHandoffRepo.markTenderUncertain(record.checkoutId)) {
            return { success: false, intent: null, error: 'Could not lock the interrupted Billiard tender for reconciliation.' };
          }
          database.markDirty();
          const uncertainFlush = await database.saveCoalesced();
          if (!this.isPosAuthContextCurrent(authContext)) {
            return { success: false, intent: null, outcomeUncertain: true, error: 'POS user changed during tender recovery.' };
          }
          const uncertainRecord = billiardPosHandoffRepo.get(record.checkoutId) || {
            ...record,
            state: 'POS_TENDER_UNCERTAIN' as const,
          };
          return {
            success: true,
            outcomeUncertain: true,
            durabilityError: uncertainFlush.success ? undefined : uncertainFlush.error,
            intent: this.billiardIntent(uncertainRecord, true),
          };
        }
        if (record.state === 'POS_TENDER_UNCERTAIN') {
          return {
            success: true,
            outcomeUncertain: true,
            intent: this.billiardIntent(record, true),
          };
        }
        const current = this.posStore.getState();
        const liveCheckout = current.checkoutDraft.billiard?.origin.checkoutId;
        if (current.cart.items.length === 0) {
          this.applyBilliardHandoffSnapshot(record, scope);
        } else if (
          liveCheckout !== record.checkoutId
          || !isActiveBilliardCheckoutSnapshot(current, record.checkoutSnapshot)
        ) {
          return {
            success: false,
            intent: null,
            error: 'Another POS cart is active. Hold it before resuming this Billiard checkout.',
          };
        }
        return { success: true, intent: this.billiardIntent(record, true) };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    });
    ipcMain.handle('pos:billiard:mark-payment-opened', async (_e, checkoutId: string) => {
      try {
        if (this.holdRecallInFlight) {
          return { success: false, error: 'A held cart recall is still being saved. Wait before opening payment.' };
        }
        const scope = currentPosSnapshotScope(getConfig());
        const authContext = this.capturePosAuthContext(scope);
        const record = billiardPosHandoffRepo.get(String(checkoutId || ''));
        if (!record || record.salonId !== scope.salonId || record.userId !== scope.userId || record.registerId !== scope.registerId) {
          return { success: false, error: 'Billiard checkout not found on this register.' };
        }
        const posStore = this.posStore;
        const preflight = await this.prepareOrdinaryPosPayment(record.orderId);
        if (!posStore || !isActiveBilliardCheckoutSnapshot(posStore.getState(), record.checkoutSnapshot)) {
          return { success: false, error: 'The active POS cart does not match this frozen Billiard checkout.' };
        }
        await this.assertTenderFiscalCompatibility(record.bundle.lines, record.bundle.discountGrosze);
        if (!billiardPosHandoffRepo.markPaymentOpened(record.checkoutId)) {
          return { success: false, error: `Billiard checkout cannot open payment from state ${record.state}.` };
        }
        database.markDirty();
        const flush = await database.saveCoalesced();
        if (!flush.success) {
          billiardPosHandoffRepo.rollbackPaymentOpenedBeforeTender(record.checkoutId);
          database.markDirty();
          const rollbackFlush = await database.saveCoalesced();
          return {
            success: false,
            error: flush.error || 'Could not persist the Billiard payment-open boundary.',
            rollbackDurabilityError: rollbackFlush.success ? undefined : rollbackFlush.error,
          };
        }
        if (!this.isPosAuthContextCurrent(authContext)) {
          return { success: false, error: 'POS user changed while Billiard payment was opening.' };
        }
        return { success: true, ...preflight };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    });
    ipcMain.handle('pos:billiard:begin-tender', async (_e, checkoutId: string, paymentPreflightToken: string) => {
      const normalizedCheckoutId = String(checkoutId || '').trim();
      if (this.billiardTenderBoundaryInFlight.has(normalizedCheckoutId)) {
        return {
          success: false,
          outcomeUncertain: true,
          error: 'This Billiard tender boundary is already being prepared. Do not collect payment twice.',
        };
      }
      this.billiardTenderBoundaryInFlight.add(normalizedCheckoutId);
      try {
        if (this.holdRecallInFlight) {
          return { success: false, error: 'A held cart recall is still being saved. Wait before starting tender.' };
        }
        const scope = currentPosSnapshotScope(getConfig());
        const authContext = this.capturePosAuthContext(scope);
        const record = billiardPosHandoffRepo.get(normalizedCheckoutId);
        if (!record || record.salonId !== scope.salonId || record.userId !== scope.userId || record.registerId !== scope.registerId) {
          return { success: false, error: 'Billiard checkout not found on this register.' };
        }
        if (orderRepo.getById(record.orderId)) {
          return { success: false, paymentCommitted: true, orderId: record.orderId, error: 'Payment is already recorded locally. Do not charge again.' };
        }
        const posStore = this.posStore;
        this.assertOrdinaryPosPaymentPreflight(paymentPreflightToken, record.orderId, authContext);
        if (!posStore || !isActiveBilliardCheckoutSnapshot(posStore.getState(), record.checkoutSnapshot)) {
          return { success: false, error: 'The active POS cart does not match this frozen Billiard checkout.' };
        }
        await this.assertTenderFiscalCompatibility(record.bundle.lines, record.bundle.discountGrosze);
        if (record.state === 'POS_TENDER_COMMITTING') {
          return {
            success: false,
            outcomeUncertain: true,
            error: 'This Billiard tender was started by an earlier process or request. Do not charge again; reconcile it.',
          };
        }
        if (!billiardPosHandoffRepo.markTenderCommitting(record.checkoutId)) {
          const latest = billiardPosHandoffRepo.get(record.checkoutId);
          const latestState = latest?.state || record.state;
          return {
            success: false,
            outcomeUncertain: requiresBilliardTenderReconciliation(latestState),
            error: `Billiard tender cannot start from state ${latestState}.`,
          };
        }
        database.markDirty();
        const flush = await database.saveCoalesced();
        if (!flush.success) {
          // Renderer has not been released past the tender boundary, so this
          // is the only safe automatic backward transition.
          billiardPosHandoffRepo.rollbackTenderBeforeCharge(record.checkoutId, true);
          database.markDirty();
          const rollbackFlush = await database.saveCoalesced();
          return {
            success: false,
            error: flush.error || 'Could not persist the Billiard tender boundary.',
            rollbackDurabilityError: rollbackFlush.success ? undefined : rollbackFlush.error,
          };
        }
        if (!this.isPosAuthContextCurrent(authContext)) {
          const rolledBack = billiardPosHandoffRepo.rollbackTenderBeforeCharge(record.checkoutId, true);
          database.markDirty();
          const rollbackFlush = await database.saveCoalesced();
          if (!rolledBack || !rollbackFlush.success) {
            billiardPosHandoffRepo.markTenderUncertainAfterRollbackFailure(record.checkoutId);
            database.markDirty();
            const uncertainFlush = await database.saveCoalesced();
            return {
              success: false,
              outcomeUncertain: true,
              error: 'POS user changed after the tender boundary was saved and its safe rollback could not be confirmed. Do not charge; owner reconciliation is required.',
              durabilityError: uncertainFlush.success ? undefined : uncertainFlush.error,
            };
          }
          return { success: false, error: 'POS user changed before tender collection. No payment was authorized.' };
        }
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      } finally {
        this.billiardTenderBoundaryInFlight.delete(normalizedCheckoutId);
      }
    });
    ipcMain.handle('pos:restored-cart:begin-tender', async (_e, holdId: string, paymentPreflightToken: string) => {
      let authContext: PosAuthContext;
      try { authContext = this.capturePosAuthContext(); }
      catch { return { success: false, error: 'POS authentication context is unavailable.' }; }
      const execute = async () => {
        try {
          if (this.holdRecallInFlight) {
            return { success: false, error: 'A held cart recall is still being saved. Wait before starting tender.' };
          }
          if (!this.isPosAuthContextCurrent(authContext)) {
            return { success: false, error: 'POS user changed before this tender could start.' };
          }
          if (!this.posStore) return { success: false, error: 'POS is not ready.' };
          const state = this.posStore.getState();
          const context = state.checkoutDraft.restoredInterruption;
          if (!context || context.holdId !== String(holdId || '')) {
            return { success: false, error: 'The active restored cart does not match this tender request.' };
          }
          const held = holdOrderRepo.get(context.holdId);
          const payload = held?.payload as PosHoldPayload | undefined;
          const journal = payload?.restoredCheckout;
          if (
            !held
            || !payload
            || payload.protected !== true
            || payload.restoreState !== 'ACTIVE_CART_BACKUP'
            || !samePosSnapshotScope(payload.snapshot, authContext.scope)
            || !isValidRestoredCartCheckoutJournal(journal)
            || !sameRestoredCartCheckoutIdentity(context, journal)
          ) {
            return { success: false, error: 'The restored cart payment journal is unavailable or has changed.' };
          }
          if (orderRepo.getById(journal.orderId)) {
            return {
              success: false,
              paymentCommitted: true,
              orderId: journal.orderId,
              error: 'Payment is already recorded locally. Do not charge again.',
            };
          }
          if (journal.state === 'TENDER_COMMITTING' || journal.state === 'TENDER_UNCERTAIN') {
            return {
              success: false,
              outcomeUncertain: true,
              error: 'This restored-cart tender already crossed the safety boundary. Do not charge again; reconcile it.',
            };
          }
          if (journal.state !== 'READY' || this.frozenRestoredCartHolds.has(held.id) || context.persistenceError) {
            return { success: false, error: context.persistenceError || 'This restored cart is not safe to tender.' };
          }
          if (!state.session.isOpen) {
            return { success: false, error: 'Open a POS shift before starting this payment.' };
          }
          this.assertOrdinaryPosPaymentPreflight(paymentPreflightToken, journal.orderId, authContext);
          if (!isActiveRestoredCartSnapshot(state, payload.snapshot)) {
            return { success: false, error: 'The active cart does not exactly match its durable protected snapshot.' };
          }
          await this.assertTenderFiscalCompatibility(state.cart.items, state.cart.discount);

          const committing: RestoredCartCheckoutJournal = {
            ...journal,
            state: 'TENDER_COMMITTING',
            updatedAt: new Date().toISOString(),
          };
          const committingPayload: PosHoldPayload = {
            ...payload,
            restoredCheckout: committing,
          };
          holdOrderRepo.replaceProtected(held.id, held.title, committingPayload);
          database.markDirty();
          const flush = await database.saveCoalesced();
          if (!flush.success) {
            // The two-step renderer has not yet instructed the cashier to
            // collect/confirm tender, so restoring READY is safe here.
            holdOrderRepo.replaceProtected(held.id, held.title, payload);
            const error = flush.error || 'Could not persist the restored-cart tender boundary.';
            this.frozenRestoredCartHolds.add(held.id);
            this.markLiveRestoredCart({ id: held.id, payload }, context.checkoutId, error, authContext);
            database.markDirty();
            const rollbackFlush = await database.saveCoalesced();
            return {
              success: false,
              error,
              rollbackDurabilityError: rollbackFlush.success ? undefined : rollbackFlush.error,
            };
          }
          if (!this.isPosAuthContextCurrent(authContext)) {
            holdOrderRepo.replaceProtected(held.id, held.title, payload);
            database.markDirty();
            const rollbackFlush = await database.saveCoalesced();
            if (!rollbackFlush.success) {
              const uncertain: RestoredCartCheckoutJournal = {
                ...journal,
                state: 'TENDER_UNCERTAIN',
                updatedAt: new Date().toISOString(),
              };
              holdOrderRepo.replaceProtected(held.id, held.title, {
                ...payload,
                restoredCheckout: uncertain,
              });
              database.markDirty();
              const uncertainFlush = await database.saveCoalesced();
              return {
                success: false,
                outcomeUncertain: true,
                error: 'POS user changed and the restored-cart tender rollback could not be confirmed. Do not charge; owner reconciliation is required.',
                durabilityError: uncertainFlush.success ? undefined : uncertainFlush.error,
              };
            }
            return { success: false, error: 'POS user changed before tender collection. No payment was authorized.' };
          }
          this.markLiveRestoredCart({ id: held.id, payload: committingPayload }, context.checkoutId, undefined, authContext);
          return { success: true };
        } catch (error: any) {
          return { success: false, error: error?.message || String(error) };
        }
      };
      const queued = this.restoredCartDispatchQueue.then(execute, execute);
      this.restoredCartDispatchQueue = queued.then(() => undefined, () => undefined);
      return queued;
    });
    ipcMain.handle('pos:billiard:resolve-uncertain-tender', async (
      _e,
      input: ResolveUncertainTenderInput,
    ) => {
      let authContext: PosAuthContext;
      try {
        const config = getConfig();
        if (String(config.authUser?.role || '').toUpperCase() !== 'OWNER') {
          return {
            success: false,
            code: 'OWNER_REQUIRED',
            error: 'Only the salon owner can resolve an uncertain payment outcome.',
          };
        }
        const ownerUserId = String(config.authUser?.id || '').trim();
        const reason = String(input?.reason || '').trim();
        if (!ownerUserId) return { success: false, error: 'Owner identity is unavailable.' };
        if (reason.length < 3 || reason.length > 500) {
          return { success: false, error: 'Resolution reason must contain 3 to 500 characters.' };
        }
        if (input?.confirmedNoPaymentRemains !== true) {
          return {
            success: false,
            error: 'Explicit confirmation that no cash/card payment remains is required.',
          };
        }
        if (this.holdRecallInFlight) {
          return { success: false, error: 'Wait for the active held cart recall to finish.' };
        }
        const scope = currentPosSnapshotScope(config);
        authContext = this.capturePosAuthContext(scope);
        const audit: TenderNoPaymentResolutionAudit = {
          ownerUserId,
          reason,
          confirmedAt: new Date().toISOString(),
          action: 'NO_PAYMENT_REMAINS',
        };

        if (input?.target?.type === 'BILLIARD') {
          const checkoutId = String(input.target.checkoutId || '').trim();
          const record = billiardPosHandoffRepo.get(checkoutId);
          if (
            !record
            || record.salonId !== scope.salonId
            || record.registerId !== scope.registerId
          ) {
            return { success: false, error: 'Uncertain Billiard checkout was not found for this owner/register.' };
          }
          if (record.state !== 'POS_TENDER_UNCERTAIN') {
            return { success: false, error: `Billiard tender cannot be resolved from state ${record.state}.` };
          }
          if (orderRepo.getById(record.orderId)) {
            return { success: false, paymentCommitted: true, error: 'A local paid order exists. Reconcile it instead of resetting tender.' };
          }
          if (!this.posStore) return { success: false, error: 'POS is not ready.' };
          const live = this.posStore.getState();
          if (
            live.cart.items.length > 0
            && !isActiveBilliardCheckoutSnapshot(live, record.checkoutSnapshot)
          ) {
              return { success: false, error: 'Another POS cart is active. Hold it before resolving this tender.' };
          }
          const interruptionBefore = record.interruptedHoldId
            ? holdOrderRepo.get(record.interruptedHoldId)
            : null;
          if (record.interruptedHoldId && (
            !interruptionBefore
            || interruptionBefore.payload?.protected !== true
            || interruptionBefore.payload?.holdReason !== 'BILLIARD_INTERRUPTION'
            || interruptionBefore.payload?.autoRestoreForCheckoutId !== record.checkoutId
            || !samePosSalonRegister(interruptionBefore.payload.snapshot, scope)
          )) {
            return { success: false, error: 'The protected interrupted cart cannot be safely adopted on this owner/register.' };
          }
          let resolved = false;
          database.transaction(() => {
            resolved = billiardPosHandoffRepo.resolveUncertainTenderAsNoPayment(checkoutId, audit, scope);
            if (resolved && interruptionBefore) {
              holdOrderRepo.replaceProtected(interruptionBefore.id, interruptionBefore.title, {
                ...interruptionBefore.payload,
                snapshot: adoptPosCheckoutSnapshotScope(interruptionBefore.payload.snapshot, scope),
              });
            }
          });
          if (!resolved) {
            return { success: false, error: 'The uncertain Billiard journal changed before it could be resolved.' };
          }
          database.markDirty();
          const flush = await database.saveCoalesced();
          if (!flush.success) {
            database.transaction(() => {
              billiardPosHandoffRepo.rollbackNoPaymentResolution(checkoutId, audit, record);
              if (interruptionBefore) {
                holdOrderRepo.replaceProtected(interruptionBefore.id, interruptionBefore.title, interruptionBefore.payload);
              }
            });
            database.markDirty();
            const rollbackFlush = await database.saveCoalesced();
            return {
              success: false,
              error: flush.error || 'Owner resolution was not made durable.',
              rollbackDurabilityError: rollbackFlush.success ? undefined : rollbackFlush.error,
            };
          }
          if (!this.isPosAuthContextCurrent(authContext)) {
            return {
              success: false,
              resolved: true,
              error: 'The owner resolution was saved, but the POS user changed. Sign in as the original owner to recover the cart.',
            };
          }
          const updated = billiardPosHandoffRepo.get(checkoutId);
          if (!updated || updated.state !== 'POS_PAYMENT_OPEN') {
            return { success: false, resolved: true, error: 'The owner resolution was saved but could not be reloaded.' };
          }
          if (this.posStore.getState().cart.items.length === 0) {
            this.applyBilliardHandoffSnapshot(updated, scope);
          }
          return {
            success: true,
            resolved: true,
            targetType: 'BILLIARD',
            audit,
            intent: this.billiardIntent(updated, true),
          };
        }

        if (input?.target?.type === 'RESTORED_CART') {
          const holdId = String(input.target.holdId || '').trim();
          const held = holdOrderRepo.get(holdId);
          const payload = held?.payload as PosHoldPayload | undefined;
          const journal = payload?.restoredCheckout;
          if (
            !held
            || !payload
            || payload.protected !== true
            || payload.holdReason !== 'BILLIARD_INTERRUPTION'
            || payload.restoreState !== 'ACTIVE_CART_BACKUP'
            || !samePosSalonRegister(payload.snapshot, scope)
            || !isValidRestoredCartCheckoutJournal(journal)
          ) {
            return { success: false, error: 'Uncertain restored cart was not found for this owner/register.' };
          }
          if (journal.state !== 'TENDER_UNCERTAIN') {
            return { success: false, error: `Restored-cart tender cannot be resolved from state ${journal.state}.` };
          }
          if (orderRepo.getById(journal.orderId)) {
            return { success: false, paymentCommitted: true, error: 'A local paid order exists. Reconcile it instead of resetting tender.' };
          }
          if (!this.posStore) return { success: false, error: 'POS is not ready.' };
          const live = this.posStore.getState();
          const liveMarker = live.checkoutDraft.restoredInterruption;
          if (
            live.cart.items.length > 0
            && (
              liveMarker?.holdId !== holdId
              || !isActiveRestoredCartSnapshot(live, payload.snapshot)
            )
          ) {
            return { success: false, error: 'Another POS cart is active. Hold it before resolving this tender.' };
          }
          const readyJournal: RestoredCartCheckoutJournal = {
            ...journal,
            state: 'READY',
            updatedAt: audit.confirmedAt,
            resolutionAudits: [...(journal.resolutionAudits ?? []), audit],
          };
          const readyPayload: PosHoldPayload = {
            ...payload,
            snapshot: adoptPosCheckoutSnapshotScope(payload.snapshot, scope),
            restoreState: 'ACTIVE_CART_BACKUP',
            restoredCheckout: readyJournal,
          };
          holdOrderRepo.replaceProtected(held.id, held.title, readyPayload);
          database.markDirty();
          const flush = await database.saveCoalesced();
          if (!flush.success) {
            holdOrderRepo.replaceProtected(held.id, held.title, payload);
            database.markDirty();
            const rollbackFlush = await database.saveCoalesced();
            return {
              success: false,
              error: flush.error || 'Owner resolution was not made durable.',
              rollbackDurabilityError: rollbackFlush.success ? undefined : rollbackFlush.error,
            };
          }
          if (!this.isPosAuthContextCurrent(authContext)) {
            return {
              success: false,
              resolved: true,
              error: 'The owner resolution was saved, but the POS user changed. Sign in as the original owner to recover the cart.',
            };
          }
          this.frozenRestoredCartHolds.delete(held.id);
          this.markLiveRestoredCart(
            { id: held.id, payload: readyPayload },
            String(payload.autoRestoreForCheckoutId || ''),
            undefined,
            authContext,
          );
          return {
            success: true,
            resolved: true,
            targetType: 'RESTORED_CART',
            restoredCart: true,
            audit,
          };
        }

        return { success: false, error: 'Unknown uncertain-tender resolution target.' };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    });
    ipcMain.handle('pos:billiard:complete-handoff', async (_e, checkoutId: string, orderId: string) => {
      try {
        if (!this.posStore) return { success: false, error: 'POS is not ready.' };
        const scope = currentPosSnapshotScope(getConfig());
        const record = billiardPosHandoffRepo.get(String(checkoutId || ''));
        if (
          !record
          || record.orderId !== orderId
          || record.salonId !== scope.salonId
          || record.userId !== scope.userId
          || record.registerId !== scope.registerId
          || !orderRepo.getById(orderId)
        ) {
          return { success: false, error: 'Committed Billiard order could not be verified.' };
        }
        this.assertExistingBilliardOrder(record);
        if (record.state !== 'SETTLED') {
          billiardPosHandoffRepo.markState(record.checkoutId, 'POS_PAID_SYNC_PENDING');
        }
        const restored = this.finalizeBilliardCartAfterLocalCommit(record);
        database.markDirty();
        const flush = await database.saveCoalesced();
        return {
          success: true,
          restored: restored.restored,
          durabilityError: flush.success ? undefined : flush.error,
        };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    });

    // Seed demo data for offline mode
    ipcMain.handle('pos:seed-demo', () => {
      seedIfEmpty();
      return { success: true };
    });

    // Customer display touch
    ipcMain.handle('display:touch', (e) => {
      logger.info(`[PosModule] IPC display:touch from window="${e.sender.getTitle?.() ?? 'unknown'}"`);
      this.posStore?.handleTouch();
      return { success: true };
    });

    // Customer display: service request
    ipcMain.handle('display:request-service', (e, serviceId: string) => {
      if (!this.allowCustomerDisplayIpc(e, 'display:request-service', 'salon_checkin')) {
        return { success: false, error: 'display_ipc_not_allowed' };
      }

      this.posStore?.handleServiceRequest(serviceId);
      // Notify POS window
      const posWindow = this.windowManager?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) {
        // Find service name from state
        const state = this.posStore?.getState();
        let serviceName = serviceId;
        for (const cat of state?.display?.serviceCategories || []) {
          const svc = cat.services.find((s: any) => s.id === serviceId);
          if (svc) { serviceName = svc.name; break; }
        }
        posWindow.webContents.send('pos:customer-request', { id: `req-${Date.now()}`, serviceName });
      }
      return { success: true };
    });

    // Customer display: get bookings for check-in
    ipcMain.handle('display:get-bookings', () => {
      const booksySync = this.container.getOptional(SERVICE_TOKENS.BOOKSY_SYNC) as any;
      return booksySync?.getBookings?.() || [];
    });

    // Customer display: check-in
    ipcMain.handle('display:check-in', async (e, data: any) => {
      if (!this.allowCustomerDisplayIpc(e, 'display:check-in', 'salon_checkin')) {
        return { success: false, error: 'display_ipc_not_allowed' };
      }

      const rawData = data && typeof data === 'object' ? data : {};
      const customerName = typeof rawData.customerName === 'string' ? rawData.customerName.trim() : '';
      if (!customerName) return { success: false, error: 'customer_name_required' };

      const services = normalizeSelectedServices(rawData.services);
      const normalizedData = {
        ...rawData,
        customerName,
        services,
        serviceName: rawData.serviceName?.trim() || deriveLegacyServiceName(services),
      };

      // Persist to checkins table
      let bookingNumber: string | undefined;
      let checkinId: string | undefined;
      try {
        bookingNumber = checkinRepo.nextBookingNumber();
        checkinId = `ci-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        checkinRepo.create({
          id: checkinId,
          booking_number: bookingNumber,
          customer_name: normalizedData.customerName,
          customer_phone: normalizedData.customerPhone,
          customer_email: normalizedData.customerEmail,
          service_name: normalizedData.serviceName,
          staff_name: normalizedData.staffName,
          booking_id: normalizedData.bookingId?.toString(),
          booking_source: normalizedData.bookingId ? 'booksy' : undefined,
          is_walkin: normalizedData.isWalkIn ? 1 : 0,
          services_json: services ? JSON.stringify(services) : undefined,
        });

        // Path B: write to sync log for outbound push
        try {
          const syncLog = this.container.getOptional<SyncLogService>(SERVICE_TOKENS.SYNC_LOG_SERVICE);
          if (syncLog && checkinId) {
            syncLog.writeLocalEntry('checkin', checkinId, 'created', {
              id: checkinId,
              bookingNumber,
              customerName: normalizedData.customerName,
              customerPhone: normalizedData.customerPhone,
              customerEmail: normalizedData.customerEmail,
              serviceName: normalizedData.serviceName,
              staffName: normalizedData.staffName,
              bookingId: normalizedData.bookingId?.toString(),
              bookingSource: normalizedData.bookingId ? 'booksy' : undefined,
              isWalkin: !!normalizedData.isWalkIn,
              status: 'WAITING',
              checkedInAt: new Date().toISOString(),
            });
          }
        } catch (e) { logger.debug('[PosModule] Sync log write failed for check-in:', e); }
        const flush = await database.save();
        if (!flush.success) {
          logger.error('[PosModule] Failed to flush check-in:', flush.error);
          return { success: false, error: 'failed_to_save_check_in' };
        }
      } catch (e) {
        logger.error('[PosModule] Failed to persist check-in:', e);
        return { success: false, error: 'failed_to_save_check_in' };
      }

      this.posStore?.handleCheckIn(normalizedData);

      // Add selected upsells to POS cart
      if (rawData.upsellsAdded?.length && this.posStore) {
        const upsellItems = this.posStore.getState().display?.upsellItems || [];
        for (const upsellId of rawData.upsellsAdded) {
          const item = upsellItems.find((u: any) => u.id === upsellId);
          if (item) {
            this.posStore.dispatch({
              type: 'cart/addItem',
              payload: {
                id: `upsell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                variantId: item.id,
                name: item.name,
                sku: '',
                price: item.price,
                quantity: 1,
                total: item.price,
              },
            });
            logger.info(`[PosModule] Added upsell "${item.name}" to cart from check-in`);
          }
        }
      }

      // Print check-in confirmation label (fire-and-forget)
      try {
        const hw = this.container.getOptional<any>(SERVICE_TOKENS.HARDWARE_MODULE);
        if (hw?.printCheckinConfirmation) {
          const printServices = (services || []).map((s: any) => ({ name: s.name, price: s.price || 0 }));
          hw.printCheckinConfirmation({
            bookingNumber,
            customerName: normalizedData.customerName,
            customerPhone: normalizedData.customerPhone,
            services: printServices.length > 0 ? printServices : normalizedData.serviceName ? [{ name: normalizedData.serviceName, price: 0 }] : [],
            staffName: normalizedData.staffName,
            checkinTime: new Date().toISOString(),
          }).catch((e: any) => logger.warn('[PosModule] Check-in print failed:', e));
        }
      } catch (e) {
        logger.warn('[PosModule] Check-in print setup failed:', e);
      }

      // Notify POS window
      const posWindow = this.windowManager?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) {
        posWindow.webContents.send('pos:customer-checkin', normalizedData);
      }
      return { success: true, bookingNumber, checkinId };
    });

    // Customer display: switch to browse services from checkin
    // Optional categoryId: if provided, SalonInteractiveView opens directly in that category.
    ipcMain.handle('display:browse-services', (_e, categoryId?: string) => {
      this.posStore?.handleBrowseFromCheckin(categoryId);
      return { success: true };
    });

    // Customer display: back from browse services to check-in hub
    ipcMain.handle('display:back-to-checkin', () => {
      this.posStore?.handleBackToCheckin();
      return { success: true };
    });

    // Customer display: back to idle/promo
    ipcMain.handle('display:back-to-idle', () => {
      this.posStore?.handleBackToIdle();
      return { success: true };
    });

    // Customer display: interaction ping (resets idle timer)
    ipcMain.handle('display:interaction-ping', () => {
      this.posStore?.handleInteractionPing();
      return { success: true };
    });

    // ── Bookings (dashboard-synced appointments) ──────────────────
    // Reads hit the local `bookings` table (populated by applyBooking
    // from sync_log). Writes apply locally + enqueue sync_log so the
    // backend receives them on the next push cycle.
    ipcMain.handle(IPC_CHANNELS.BOOKINGS_GET_TODAY, () => bookingRepo.getToday());
    ipcMain.handle(IPC_CHANNELS.BOOKINGS_GET_BY_ID, (_e, id: string) =>
      bookingRepo.getById(id),
    );
    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_GET_BY_DATE,
      (_e, dateIso: string) => {
        const start = new Date(dateIso);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + 86_400_000);
        return bookingRepo.getByDateRange(start.toISOString(), end.toISOString());
      },
    );
    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_GET_BY_DATE_RANGE,
      (_e, fromIso: string, toIso: string) =>
        bookingRepo.getByDateRange(fromIso, toIso),
    );

    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_STATUS_CHANGE,
      (_e, id: string, status: string, opts?: { note?: string }) => {
        const sync = this.container.getOptional<SyncLogService>(
          SERVICE_TOKENS.SYNC_LOG_SERVICE,
        );
        if (!sync) return { success: false, error: 'sync-unavailable' };
        try {
          writeBookingStatusChanged(sync, id, status, opts);
          return { success: true };
        } catch (err: any) {
          logger.error(`[pos.bookings.status] ${err.message}`);
          return { success: false, error: err.message };
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_CANCEL,
      (_e, id: string, reason: string) => {
        const sync = this.container.getOptional<SyncLogService>(
          SERVICE_TOKENS.SYNC_LOG_SERVICE,
        );
        if (!sync) return { success: false, error: 'sync-unavailable' };
        try {
          writeBookingCancelled(sync, id, reason || 'Cancelled at POS');
          return { success: true };
        } catch (err: any) {
          logger.error(`[pos.bookings.cancel] ${err.message}`);
          return { success: false, error: err.message };
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_UPDATE,
      (_e, id: string, patch: BookingUpdatePatch) => {
        const sync = this.container.getOptional<SyncLogService>(
          SERVICE_TOKENS.SYNC_LOG_SERVICE,
        );
        if (!sync) return { success: false, error: 'sync-unavailable' };
        try {
          writeBookingUpdated(sync, id, patch);
          return { success: true };
        } catch (err: any) {
          logger.error(`[pos.bookings.update] ${err.message}`);
          return { success: false, error: err.message };
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.BOOKINGS_CREATE,
      (_e, input: WalkInBookingInput) => {
        const sync = this.container.getOptional<SyncLogService>(
          SERVICE_TOKENS.SYNC_LOG_SERVICE,
        );
        if (!sync) return { success: false, error: 'sync-unavailable' };
        try {
          const bookingId = writeBookingCreated(sync, input);
          return { success: true, bookingId };
        } catch (err: any) {
          logger.error(`[pos.bookings.create] ${err.message}`);
          return { success: false, error: err.message };
        }
      },
    );

    // ── Services master data (read-only, fed by sync_log applicator) ─
    ipcMain.handle(IPC_CHANNELS.SERVICES_GET_ALL_ACTIVE, () =>
      serviceRepo.getAllActive(),
    );
    ipcMain.handle(
      IPC_CHANNELS.SERVICES_GET_BY_ID,
      (_e, id: string) => serviceRepo.getById(id),
    );
    ipcMain.handle(
      IPC_CHANNELS.SERVICE_RULES_GET_BY_SERVICE,
      (_e, serviceId: string) => serviceRuleRepo.getByService(serviceId),
    );

    // Products
    ipcMain.handle('pos:products:getAll', () => productRepo.getAll());
    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCTS_GET_ALL_INCLUDING_INACTIVE,
      () => productRepo.getAllIncludingInactive(),
    );
    ipcMain.handle('pos:products:getByCategory', (_e, catId: string) => productRepo.getByCategory(catId));
    ipcMain.handle('pos:products:search', (_e, query: string) => productRepo.search(query));
    ipcMain.handle('pos:products:searchByCode', (_e, query: string) => productRepo.searchByCode(query));
    ipcMain.handle('pos:products:getByBarcode', (_e, barcode: string) => productRepo.getByBarcode(barcode));
    ipcMain.handle('pos:products:getById', (_e, id: string) => productRepo.getById(id));
    ipcMain.handle('pos:categories:getAll', () => productRepo.getCategories());
    ipcMain.handle(IPC_CHANNELS.POS_CATEGORIES_GET_ALL_INCLUDING_EMPTY, () => productRepo.getAllCategories());
    ipcMain.handle('pos:local-variant-imports:listFailed', () => ({
      ok: true,
      count: localVariantImportsRepo.getFailedCount(),
      imports: localVariantImportsRepo.getFailed(),
    }));
    // Every local-import id is non-canonical for product-admin mutations.
    // SYNCED rows are aliases too: their local updated_at must never be sent as
    // the optimistic-concurrency token for the canonical server row.
    ipcMain.handle('pos:local-variant-imports:list-unresolved-ids', () => {
      try {
        return {
          ok: true,
          ids: Array.from(localVariantImportsRepo.getAdminMutationBlockedVariantIds()),
        };
      } catch (err: any) {
        return { ok: false, ids: [], error: err?.message ?? 'list-unresolved-failed' };
      }
    });
    ipcMain.handle(
      'pos:local-variant-imports:requeue',
      async (_e, payload: { variantId?: string; ean?: string; categoryId?: string | null }) => {
        const variantId = String(payload?.variantId ?? '').trim();
        const ean = normalizeScanCreateEan(payload?.ean);
        if (!variantId) return { ok: false, error: 'missing-variant-id' };
        if (!ean) return { ok: false, error: 'invalid-ean' };

        const importRow = localVariantImportsRepo.getByVariantId(variantId);
        if (!importRow || importRow.status !== 'FAILED') return { ok: false, error: 'failed-import-not-found' };

        const requestedCategoryId = String(payload?.categoryId ?? '').trim() || null;
        const exactLegacyVerification = !!requestedCategoryId
          && BACKEND_CATEGORY_ID_RE.test(requestedCategoryId)
          && isExactLegacyUncertainImportRetry(importRow, ean, requestedCategoryId);
        const savedIntentIdentity = getSavedLocalVariantImportIntentIdentity(importRow);
        const exactSavedIntentVerification = !!savedIntentIdentity
          && savedIntentIdentity.ean === ean
          && savedIntentIdentity.categoryId === requestedCategoryId;
        const categoryResolution = !!requestedCategoryId
          && BACKEND_CATEGORY_ID_RE.test(requestedCategoryId)
          && (exactLegacyVerification || exactSavedIntentVerification)
          ? { ok: true, categoryId: requestedCategoryId }
          : resolveBackendScanCategoryId(requestedCategoryId);
        if (!categoryResolution.ok) return { ok: false, error: 'invalid-category' };

        try {
          database.transaction(() => {
            // Validate/requeue the durable intent first. An uncertain
            // payload-changing retry throws before the local product row is
            // touched; the transaction also protects the reverse failure.
            localVariantImportsRepo.requeue(variantId, ean, categoryResolution.categoryId);
            productRepo.updateLocalImportIdentity(variantId, {
              ean,
              previousEan: importRow.ean,
              categoryId: categoryResolution.categoryId,
            });
          });
        } catch (err: any) {
          if (err instanceof LocalVariantImportOutcomeUncertainError
            || err?.code === 'LOCAL_VARIANT_IMPORT_OUTCOME_UNCERTAIN') {
            return {
              ok: false,
              error: 'local-import-outcome-uncertain',
              code: 'LOCAL_VARIANT_IMPORT_OUTCOME_UNCERTAIN',
            };
          }
          throw err;
        }
        database.markDirty();
        notifyPosRenderers(this.container, 'pos:products-synced');

        let syncPending = true;
        let resolvedVariant = productRepo.getById(variantId);
        try {
          const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
          await syncMod?.reconcileLocalVariantImports?.(1, variantId);
          const serverId = localVariantImportsRepo.getServerVariantId(variantId);
          if (serverId) {
            syncPending = false;
            await syncMod?.deltaSync?.();
            resolvedVariant = productRepo.getById(serverId) ?? resolvedVariant;
            notifyPosRenderers(this.container, 'pos:products-synced');
          }
        } catch (syncErr: any) {
          logger.debug(`[PosModule] requeued local variant import sync skipped: ${syncErr?.message ?? syncErr}`);
        }

        return {
          ok: true,
          syncPending,
          variant: resolvedVariant,
        };
      },
    );

    const getKitchenSelfOrderCategories = () =>
      kitchenSelfOrderCategoryPrefsRepo.applyToCategories(productRepo.getCategories());

    const emptyProductAdminCapabilities = (): ProductAdminCapabilities => ({
      version: 0,
      canCreateProduct: false,
      canUpdateProduct: false,
      canEditDisplayName: false,
      canDeactivateProduct: false,
      canAdjustStock: false,
      canCreateCategory: false,
      canUpdateCategory: false,
      canDeleteCategory: false,
      canReplaceCategoryImage: false,
      supportsCategoryImageUpload: false,
      canViewPurchasePrice: false,
      canReplaceMainImage: false,
      canReceiveStock: false,
      supportsOptimisticConcurrency: false,
      supportsPurchasePrice: false,
      supportsMainImageUpload: false,
      supportsStockLots: false,
      supportsLotReceiving: false,
    });

    ipcMain.handle(IPC_CHANNELS.POS_PRODUCT_ADMIN_CAPABILITIES, async () => {
      const token = getSecureAuthToken();
      if (!token) {
        return { ok: false, capabilities: emptyProductAdminCapabilities(), error: 'no-auth' };
      }
      try {
        const capabilities = await apiClient.getProductAdminCapabilities(token);
        return { ok: true, capabilities };
      } catch (err: any) {
        logger.debug(`[PosModule] product-admin capabilities unavailable: ${err?.message ?? err}`);
        return {
          ok: false,
          capabilities: emptyProductAdminCapabilities(),
          error: err?.message ?? 'product-admin-unavailable',
        };
      }
    });

    const toProductAdminError = <T>(err: any, fallback: string): ProductAdminIpcResult<T> => ({
      ok: false,
      error: err?.message ?? fallback,
      code: err?.code,
      status: typeof err?.status === 'number' ? err.status : undefined,
      field: err?.field,
      details: redactProductAdminPurchaseData({ details: err?.details }).details,
    });

    const isProductAdminNotFound = (result: ProductAdminIpcResult<unknown>): boolean => {
      const code = String(result.code || '').toUpperCase();
      const error = String(result.error || '').toUpperCase();
      return result.status === 404 || code === 'PRODUCT_NOT_FOUND' || error.includes('HTTP 404');
    };

    type ProductAdminSessionGuard = () => boolean;

    const refreshProductsAfterProductAdminMutation = async (
      source: string,
      isCurrentProductAdminSession: ProductAdminSessionGuard = () => true,
    ) => {
      if (!isCurrentProductAdminSession()) return;
      try {
        const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
        await syncMod?.deltaSync?.();
      } catch (syncErr: any) {
        logger.debug(`[PosModule] product-admin post-mutation sync skipped (${source}): ${syncErr?.message ?? syncErr}`);
      }
      if (!isCurrentProductAdminSession()) return;
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_CATALOG_UPDATED, { source });
    };

    const refreshProductsAfterProductAdminMutationInBackground = (
      source: string,
      isCurrentProductAdminSession: ProductAdminSessionGuard = () => true,
    ) => {
      if (!isCurrentProductAdminSession()) return;
      void refreshProductsAfterProductAdminMutation(source, isCurrentProductAdminSession);
    };

    const runProductAdminLocalMutationAfterPendingCatalogSync = async (
      source: string,
      operation: () => Promise<void> | void,
      isCurrentProductAdminSession: ProductAdminSessionGuard = () => true,
    ): Promise<void> => {
      const guardedOperation = async () => {
        if (!isCurrentProductAdminSession()) return;
        await operation();
      };
      try {
        const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
        if (typeof syncMod?.runAfterPendingCatalogSync === 'function') {
          await syncMod.runAfterPendingCatalogSync(guardedOperation);
        } else {
          await guardedOperation();
        }
      } finally {
        // Repair from canonical catalog state, even when the immediate mirror
        // fails. Public deltaSync joins the same FIFO after this callback.
        refreshProductsAfterProductAdminMutationInBackground(source, isCurrentProductAdminSession);
      }
    };

    const finiteNumber = (value: unknown): number | null => (
      typeof value === 'number' && Number.isFinite(value) ? value : null
    );

    const getProductAdminVariantPriceGrosze = (variant: ProductAdminVariant, existing?: ProductVariantRow | null): number => {
      const minor = finiteNumber(variant.priceGrossGrosze);
      if (minor !== null) return Math.max(0, Math.round(minor));

      const retailPrice = finiteNumber(variant.retailPrice);
      if (retailPrice !== null) return Math.max(0, Math.round(retailPrice * 100));

      return Math.max(0, Math.round(Number(existing?.retail_price) || 0));
    };

    const mirrorProductAdminVariant = (variant: ProductAdminVariant | undefined | null, source: string): boolean => {
      if (!variant?.id) return false;

      const existing = productRepo.getById(variant.id);
      const canonicalUpdatedAt = productAdminCanonicalUpdatedAt(variant);
      if (!shouldApplyProductAdminVariantMirror(variant, existing)) {
        logger.warn(
          `[PosModule] Skipped stale product-admin variant ${variant.id} (${source}); incoming=${canonicalUpdatedAt ?? 'missing'}, existing=${existing?.updated_at ?? 'missing'}`,
        );
        return false;
      }
      const nullableFields = mergeProductAdminNullableMirrorFields(variant, existing);
      const priceGrosze = getProductAdminVariantPriceGrosze(variant, existing);
      const totalStockQty = finiteNumber(variant.totalStockQty);
      const vatRate = finiteNumber(variant.vatRate);
      const availableQty = finiteNumber(variant.availableQty);
      const row: ProductVariantRow = {
        id: variant.id,
        template_id: nullableFields.template_id,
        name: variant.name || existing?.name || variant.id,
        sku: nullableFields.sku,
        barcode: nullableFields.barcode,
        retail_price: priceGrosze,
        category_id: nullableFields.category_id,
        image_url: Object.prototype.hasOwnProperty.call(variant, 'imageUrl')
          ? variant.imageUrl ?? null
          : existing?.image_url ?? null,
        in_stock: totalStockQty ?? existing?.in_stock ?? 0,
        vat_rate: vatRate ?? existing?.vat_rate ?? 23,
        is_active: typeof variant.isActive === 'boolean'
          ? (variant.isActive ? 1 : 0)
          : existing?.is_active ?? 1,
        updated_at: canonicalUpdatedAt ?? existing?.updated_at ?? new Date().toISOString(),
        available_qty: availableQty ?? existing?.available_qty ?? 0,
        price_gross: priceGrosze,
        price_net: existing?.price_net ?? 0,
        vat_amount: existing?.vat_amount ?? 0,
        is_on_sale: existing?.is_on_sale ?? 0,
        thumbnail_url: Object.prototype.hasOwnProperty.call(variant, 'thumbnailUrl')
          ? variant.thumbnailUrl ?? null
          : existing?.thumbnail_url ?? null,
        sale_unit: nullableFields.sale_unit,
        sell_by: nullableFields.sell_by,
        name_translations: nullableFields.name_translations,
        customer_display_enabled: existing?.customer_display_enabled ?? 1,
        customer_display_sort_order: existing?.customer_display_sort_order ?? null,
        kiosk_media_json: existing?.kiosk_media_json ?? null,
        kiosk_modifier_groups_json: existing?.kiosk_modifier_groups_json ?? null,
        kiosk_note_enabled: existing?.kiosk_note_enabled ?? 0,
        item_type: variant.itemType != null
          ? String(variant.itemType).toLowerCase()
          : existing?.item_type ?? null,
        track_inventory: typeof variant.trackInventory === 'boolean'
          ? (variant.trackInventory ? 1 : 0)
          : existing?.track_inventory ?? 1,
      };

      productRepo.upsertMany([row]);
      database.markDirty();
      logger.info(`[PosModule] Mirrored product-admin variant ${variant.id} locally (${source}, price=${priceGrosze})`);
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_CATALOG_UPDATED, { source: `${source}_local_mirror` });
      return true;
    };

    const mirrorProductAdminCategory = (
      category: ProductAdminCategory | undefined | null,
      source: string,
    ): boolean => {
      if (!category?.id) return false;
      const existing = productRepo.getCategoryById(category.id);
      if (!shouldApplyProductAdminCategoryMirror(category, existing)) {
        logger.warn(
          `[PosModule] Skipped stale product-admin category ${category.id} (${source}); `
          + `incoming=${category.updatedAt || 'missing'}, existing=${existing?.updated_at || 'missing'}`,
        );
        return false;
      }
      productRepo.upsertCategories([
        productAdminCategoryToRow(category, existing),
      ]);
      database.markDirty();
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_CATALOG_UPDATED, {
        source: `${source}_local_mirror`,
      });
      return true;
    };

    const reconcileDeletedProductAdminCategoryLocally = (
      requestedCategoryId: string,
      data: ProductAdminCategoryDeleteResponse,
    ) => {
      const deletedId = data.categoryId || data.deletedId || requestedCategoryId;
      const keepIds = new Set(
        productRepo.getAllCategories()
          .map((category) => category.id)
          .filter((id) => id !== deletedId),
      );
      const pruned = productRepo.deleteCategoriesExcept(keepIds);
      database.markDirty();
      logger.info(
        `[PosModule] Pruned deleted product-admin category ${deletedId} locally `
        + `(categories=${pruned.removed}, reassignedProducts=${data.reassignedProducts})`,
      );
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_CATALOG_UPDATED, {
        source: 'product_admin_category_delete_local_mirror',
      });
    };

    const deactivateLocalProductAdminVariant = (variantId: string, source: string) => {
      const id = String(variantId || '').trim();
      if (!id) return;
      productRepo.deactivateByIds([id]);
      database.markDirty();
      logger.info(`[PosModule] Marked product-admin variant ${id} inactive locally (${source})`);
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
      notifyPosRenderers(this.container, IPC_CHANNELS.POS_CATALOG_UPDATED, { source: `${source}_local_mirror` });
    };

    type ProductAdminCapability = keyof Pick<
      ProductAdminCapabilities,
      | 'canCreateProduct'
      | 'canUpdateProduct'
      | 'canDeactivateProduct'
      | 'canAdjustStock'
      | 'canCreateCategory'
      | 'canUpdateCategory'
      | 'canDeleteCategory'
      | 'canReplaceCategoryImage'
      | 'canReorderCategory'
      | 'canViewPurchasePrice'
      | 'canReplaceMainImage'
      | 'canReceiveStock'
      | 'supportsPurchasePrice'
      | 'supportsMainImageUpload'
      | 'supportsStockLots'
      | 'supportsLotReceiving'
    >;

    // A local-import row never owns the canonical server revision. Even after
    // reconciliation, forwarding its expectedUpdatedAt while retargeting the id
    // would mix two rows' concurrency tokens. Fail closed until the canonical
    // server row is selected from the local mirror.
    const resolveVariantIdAlias = (variantId: string): string => {
      const normalizedId = String(variantId || '').trim();
      if (!normalizedId) {
        const error = new Error('missing-variant-id') as Error & { code?: string; status?: number };
        error.code = 'PRODUCT_NOT_FOUND';
        error.status = 404;
        throw error;
      }
      try {
        if (localVariantImportsRepo.getAdminMutationBlockedVariantIds().has(normalizedId)) {
          const error = new Error('variant-import-alias-blocked') as Error & {
            code?: string;
            status?: number;
            details?: Record<string, unknown>;
          };
          error.code = 'VARIANT_IMPORT_ALIAS_BLOCKED';
          error.status = 409;
          error.details = { variantId: normalizedId };
          throw error;
        }
        return normalizedId;
      } catch (error: any) {
        if (error?.code === 'VARIANT_IMPORT_ALIAS_BLOCKED') throw error;
        const aliasError = new Error('variant-alias-resolution-unavailable') as Error & {
          code?: string;
          status?: number;
        };
        aliasError.code = 'VARIANT_ALIAS_UNAVAILABLE';
        aliasError.status = 503;
        throw aliasError;
      }
    };

    const canAccessProductPurchasePrice = (capabilities: ProductAdminCapabilities): boolean =>
      capabilities.supportsPurchasePrice === true
      && capabilities.canViewPurchasePrice === true;

    const withProductAdminCapability = async <T>(
      capability: ProductAdminCapability,
      label: string,
      action: (token: string, capabilities: ProductAdminCapabilities) => Promise<T>,
      afterSuccess?: (data: T, isCurrentProductAdminSession: ProductAdminSessionGuard) => Promise<void>,
    ): Promise<ProductAdminIpcResult<T>> => {
      const token = getSecureAuthToken();
      if (!token) return { ok: false, error: 'no-auth', code: 'UNAUTHORIZED_PRODUCT_ADMIN' };
      const requestContext = captureProductAdminSessionContext(token, getConfig());
      const isCurrentProductAdminSession = () => isProductAdminSessionContextCurrent(
        requestContext,
        getSecureAuthToken(),
        getConfig(),
      );
      try {
        const capabilities = await apiClient.getProductAdminCapabilities(token);
        if (capabilities[capability] !== true) {
          return { ok: false, error: 'unsupported-capability', code: 'UNSUPPORTED_CAPABILITY' };
        }
        if (!isCurrentProductAdminSession()) {
          return { ok: false, error: 'auth-context-changed', code: 'UNAUTHORIZED_PRODUCT_ADMIN' };
        }
        const rawData = await action(token, capabilities);
        const contextCurrentAfterAction = isCurrentProductAdminSession();
        let data = contextCurrentAfterAction && canAccessProductPurchasePrice(capabilities)
          ? rawData
          : redactProductAdminPurchaseData(rawData);
        if (!contextCurrentAfterAction) {
          logger.warn(`[PosModule] product-admin ${label} completed after auth context changed; skipped local effects`);
          return { ok: true, data };
        }
        if (afterSuccess) {
          try {
            await afterSuccess(data, isCurrentProductAdminSession);
          } catch (afterSuccessError: any) {
            logger.warn(
              `[PosModule] product-admin local after-success failed (${label}): ${afterSuccessError?.message ?? afterSuccessError}`,
            );
          }
        }
        if (!isCurrentProductAdminSession()) {
          data = redactProductAdminPurchaseData(rawData);
        }
        return { ok: true, data };
      } catch (err: any) {
        logger.warn(`[PosModule] product-admin ${label} failed: ${err?.message ?? err}`);
        return toProductAdminError<T>(err, `${label}-failed`);
      }
    };

    const currentProductAdminMutationScope = () => {
      const config = getConfig();
      return {
        serverUrl: String(config.serverUrl ?? ''),
        salonId: String(config.salonId ?? ''),
        deviceId: String(config.machineId ?? config.agentId ?? ''),
      };
    };

    const requireDurableMutationCapability = (
      capabilities: ProductAdminCapabilities,
      capability: ProductAdminCapability,
    ) => {
      if (capabilities[capability] !== true) {
        const error = new Error('unsupported-capability') as Error & { code?: string; status?: number };
        error.code = 'UNSUPPORTED_CAPABILITY';
        error.status = 403;
        throw error;
      }
    };

    const assertProductMoney = (value: unknown, allowZero: boolean, field: string) => {
      if (value === undefined || value === null) return;
      if (!isValidProductMoneyGrosze(value, { allowZero })) {
        const error = new Error(`invalid-${field}`) as Error & { code?: string; status?: number; field?: string };
        error.code = 'INVALID_PRICE';
        error.status = 400;
        error.field = field;
        throw error;
      }
    };

    const productAdminMutationOutbox = new ProductAdminMutationOutbox({
      getScope: currentProductAdminMutationScope,
      sanitizeResponse: (response) => redactProductAdminPurchaseData(response),
      dispatch: async (row, request, stagedImage) => {
        const token = getSecureAuthToken();
        if (!token) {
          const error = new Error('no-auth') as Error & { code?: string };
          error.code = 'UNAUTHORIZED_PRODUCT_ADMIN';
          throw error;
        }
        if (productAdminMutationTenantKey(currentProductAdminMutationScope()) !== row.tenant_key) {
          const error = new Error('auth-context-changed') as Error & { code?: string; status?: number };
          error.code = 'SALON_CONTEXT_MISMATCH';
          error.status = 409;
          throw error;
        }
        const capabilities = await apiClient.getProductAdminCapabilities(token);
        const payload = { ...((request.payload as Record<string, unknown> | undefined) || {}) } as any;
        const variantId = String(row.target_variant_id || request.variantId || '').trim();

        switch (row.mutation_type) {
          case 'CREATE_PRODUCT': {
            requireDurableMutationCapability(capabilities, 'canCreateProduct');
            assertProductMoney(payload.priceGrossGrosze, false, 'priceGrossGrosze');
            assertProductMoney(payload.purchasePriceGrosze, true, 'purchasePriceGrosze');
            assertProductStockQuantity(
              payload.initialStockQty ?? 0,
              classifyProductSale(payload).sellBy,
              'initialStockQty',
              true,
            );
            if (payload.purchasePriceGrosze !== undefined && !canAccessProductPurchasePrice(capabilities)) {
              const error = new Error('purchase-price-unavailable') as Error & { code?: string; status?: number };
              error.code = 'UNSUPPORTED_CAPABILITY';
              error.status = 403;
              throw error;
            }
            return apiClient.createProductVariant(token, {
              ...payload,
              idempotencyKey: row.idempotency_key || undefined,
            });
          }
          case 'CREATE_CATEGORY': {
            requireDurableMutationCapability(capabilities, 'canCreateCategory');
            const categoryPayload = sanitizeProductAdminCategoryJsonMutation(
              payload,
              capabilities,
              { allowImageRemoval: false },
            );
            return apiClient.createProductAdminCategory(token, {
              ...categoryPayload,
              idempotencyKey: row.idempotency_key || undefined,
            });
          }
          case 'ADJUST_STOCK': {
            requireDurableMutationCapability(capabilities, 'canAdjustStock');
            requireProductAdminExpectedUpdatedAt(
              capabilities,
              payload.expectedUpdatedAt,
            );
            if (payload.mode === 'receive' && capabilities.supportsLotReceiving === true) {
              const error = new Error('lot-aware-receiving-required') as Error & { code?: string; status?: number };
              error.code = 'LOT_RECEIVING_REQUIRED';
              error.status = 409;
              throw error;
            }
            const existingProduct = productRepo.getById(resolveVariantIdAlias(variantId));
            const field = payload.mode === 'recount' ? 'newQuantity' : 'quantity';
            assertProductStockQuantity(
              payload[field],
              classifyProductSale(existingProduct ?? {}).sellBy,
              field,
              payload.mode === 'recount',
            );
            return apiClient.adjustProductStock(token, variantId, {
              ...payload,
              idempotencyKey: row.idempotency_key || undefined,
            });
          }
          case 'RECEIVE_STOCK': {
            requireDurableMutationCapability(capabilities, 'canReceiveStock');
            if (capabilities.supportsLotReceiving !== true) {
              const error = new Error('lot-receiving-unavailable') as Error & { code?: string; status?: number };
              error.code = 'UNSUPPORTED_CAPABILITY';
              error.status = 409;
              throw error;
            }
            const existingProduct = productRepo.getById(resolveVariantIdAlias(variantId));
            normalizeProductReceiptInput({
              ...payload,
              idempotencyKey: row.idempotency_key || '',
              expectedUpdatedAt: payload.expectedUpdatedAt,
            }, classifyProductSale(existingProduct ?? {}).sellBy);
            requireProductAdminExpectedUpdatedAt(capabilities, payload.expectedUpdatedAt);
            if (payload.unitCostGrosze !== undefined && !canAccessProductPurchasePrice(capabilities)) {
              const error = new Error('purchase-price-unavailable') as Error & { code?: string; status?: number };
              error.code = 'UNSUPPORTED_CAPABILITY';
              error.status = 403;
              throw error;
            }
            return apiClient.receiveProductStock(token, variantId, {
              ...payload,
              idempotencyKey: row.idempotency_key || '',
            } as ProductAdminReceiveStockInput);
          }
          case 'UPLOAD_MAIN_IMAGE': {
            requireDurableMutationCapability(capabilities, 'canReplaceMainImage');
            if (capabilities.supportsMainImageUpload !== true || !stagedImage) {
              const error = new Error('main-image-upload-unavailable') as Error & { code?: string; status?: number };
              error.code = 'UNSUPPORTED_CAPABILITY';
              error.status = 409;
              throw error;
            }
            requireProductAdminExpectedUpdatedAt(
              capabilities,
              payload.expectedUpdatedAt,
            );
            return apiClient.uploadProductMainImage(token, variantId, {
              bytes: stagedImage,
              mimeType: String(payload.mimeType || ''),
              fileName: String(payload.fileName || 'product-image'),
              expectedUpdatedAt: payload.expectedUpdatedAt,
            });
          }
        }
      },
      apply: async (row: ProductAdminMutationOutboxRow, response: any) => {
        if (productAdminMutationTenantKey(currentProductAdminMutationScope()) !== row.tenant_key) {
          throw new Error('product-admin-local-apply-tenant-changed');
        }
        const isCurrentProductAdminSession = () => {
          try {
            return productAdminMutationTenantKey(currentProductAdminMutationScope()) === row.tenant_key;
          } catch {
            return false;
          }
        };
        switch (row.mutation_type) {
          case 'CREATE_PRODUCT':
            await runProductAdminLocalMutationAfterPendingCatalogSync('product_admin_create', () => {
              mirrorProductAdminVariant(response?.variant, 'product_admin_create');
            }, isCurrentProductAdminSession);
            break;
          case 'CREATE_CATEGORY':
            await runProductAdminLocalMutationAfterPendingCatalogSync('product_admin_category_create', () => {
              mirrorProductAdminCategory(response?.category, 'product_admin_category_create');
            }, isCurrentProductAdminSession);
            break;
          case 'ADJUST_STOCK':
            await runProductAdminLocalMutationAfterPendingCatalogSync('product_admin_stock_adjustment', () => {
              mirrorProductAdminVariant(response?.variant, 'product_admin_stock_adjustment');
            }, isCurrentProductAdminSession);
            notifyPosRenderers(this.container, IPC_CHANNELS.POS_STOCK_UPDATED, {
              source: 'product_admin',
              adjustment: response?.adjustment,
              variant: response?.variant,
            });
            break;
          case 'RECEIVE_STOCK':
            await runProductAdminLocalMutationAfterPendingCatalogSync('product_admin_receive_stock', () => {
              mirrorProductAdminVariant(response?.variant, 'product_admin_receive_stock');
            }, isCurrentProductAdminSession);
            notifyPosRenderers(this.container, IPC_CHANNELS.POS_STOCK_UPDATED, {
              source: 'product_admin_receipt',
              receipt: response?.receipt,
              variant: response?.variant,
            });
            break;
          case 'UPLOAD_MAIN_IMAGE':
            await runProductAdminLocalMutationAfterPendingCatalogSync('product_admin_main_image', () => {
              mirrorProductAdminVariant(response?.variant, 'product_admin_main_image');
            }, isCurrentProductAdminSession);
            break;
        }
      },
    });
    this.productAdminMutationOutbox = productAdminMutationOutbox;

    const normalizeCategoryOrderUpdates = (
      input: unknown,
    ): ProductAdminCategoryOrderUpdate[] => {
      if (!Array.isArray(input)) return [];
      const seen = new Set<string>();
      const updates: ProductAdminCategoryOrderUpdate[] = [];
      for (const raw of input) {
        const id = String((raw as any)?.id || '').trim();
        const sortOrder = Math.floor(Number((raw as any)?.sortOrder));
        const expectedUpdatedAt = String((raw as any)?.expectedUpdatedAt || '').trim() || undefined;
        if (!id || !Number.isFinite(sortOrder) || sortOrder < 0 || seen.has(id)) continue;
        seen.add(id);
        updates.push({ id, sortOrder, expectedUpdatedAt });
      }
      return updates;
    };

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CREATE_PRODUCT,
      async (_e, payload: ProductAdminCreateProductInput) => {
        const input = {
          ...(payload || {}),
          idempotencyKey: payload?.idempotencyKey || randomUUID(),
        } as ProductAdminCreateProductInput;
        const { idempotencyKey, ...requestPayload } = input;
        return withProductAdminCapability<ProductAdminProductMutationResponse>(
          'canCreateProduct',
          'create product',
          async (_token, capabilities) => {
            assertProductMoney(requestPayload.priceGrossGrosze, false, 'priceGrossGrosze');
            assertProductMoney(requestPayload.purchasePriceGrosze, true, 'purchasePriceGrosze');
            assertProductStockQuantity(
              requestPayload.initialStockQty ?? 0,
              classifyProductSale(requestPayload).sellBy,
              'initialStockQty',
              true,
            );
            if (requestPayload.purchasePriceGrosze !== undefined
              && !canAccessProductPurchasePrice(capabilities)) {
              const error = new Error('purchase-price-unavailable') as Error & { code?: string };
              error.code = 'UNSUPPORTED_CAPABILITY';
              throw error;
            }
            return productAdminMutationOutbox.execute({
              mutationType: 'CREATE_PRODUCT',
              idempotencyKey,
              request: { payload: requestPayload },
            }) as Promise<ProductAdminProductMutationResponse>;
          },
        );
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_UPDATE_VARIANT,
      async (_e, variantId: string, payload: ProductAdminUpdateVariantInput) =>
        withProductAdminCapability<ProductAdminVariantMutationResponse>(
          'canUpdateProduct',
          'update variant',
          (token, capabilities) => {
            assertProductMoney(payload?.priceGrossGrosze, true, 'priceGrossGrosze');
            assertProductMoney(payload?.purchasePriceGrosze, true, 'purchasePriceGrosze');
            const expectedUpdatedAt = requireProductAdminExpectedUpdatedAt(
              capabilities,
              payload?.expectedUpdatedAt,
            );
            const resolvedVariantId = resolveVariantIdAlias(variantId);
            const normalizedPayload = sanitizeExistingProductInventoryModeUpdate(
              { ...(payload || {}), expectedUpdatedAt },
              productRepo.getById(resolvedVariantId),
            );
            const { nameTranslations, ...legacyPayload } = normalizedPayload;
            const canSendDisplayName = capabilities.version >= 2 && capabilities.canEditDisplayName === true;
            if (nameTranslations !== undefined && !canSendDisplayName) {
              const error = new Error('display-name-editing-unavailable') as Error & { code?: string };
              error.code = 'UNSUPPORTED_CAPABILITY';
              throw error;
            }
            if (normalizedPayload.purchasePriceGrosze !== undefined
              && (capabilities.supportsPurchasePrice !== true
                || capabilities.canViewPurchasePrice !== true)) {
              const error = new Error('purchase-price-unavailable') as Error & { code?: string };
              error.code = 'UNSUPPORTED_CAPABILITY';
              throw error;
            }
            return apiClient.updateProductVariant(
              token,
              resolvedVariantId,
              canSendDisplayName ? normalizedPayload : legacyPayload,
            );
          },
          async (data, isCurrentProductAdminSession) => {
            await runProductAdminLocalMutationAfterPendingCatalogSync('product_admin_update', () => {
              mirrorProductAdminVariant(data.variant, 'product_admin_update');
            }, isCurrentProductAdminSession);
          },
        ),
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_DEACTIVATE_VARIANT,
      async (_e, variantId: string, payload: ProductAdminDeactivateVariantInput) => {
        const deactivateRequestContext = captureProductAdminSessionContext(getSecureAuthToken(), getConfig());
        const isDeactivateRequestContextCurrent = () => isProductAdminSessionContextCurrent(
          deactivateRequestContext,
          getSecureAuthToken(),
          getConfig(),
        );
        const result = await withProductAdminCapability<ProductAdminVariantMutationResponse>(
          'canDeactivateProduct',
          'deactivate variant',
          (token, capabilities) => {
            const expectedUpdatedAt = requireProductAdminExpectedUpdatedAt(
              capabilities,
              payload?.expectedUpdatedAt,
            );
            return apiClient.deactivateProductVariant(token, resolveVariantIdAlias(variantId), {
              ...(payload || {}),
              expectedUpdatedAt,
              reason: String(payload?.reason || '').trim() || 'Hidden from POS',
            });
          },
          async (data, isCurrentProductAdminSession) => {
            await runProductAdminLocalMutationAfterPendingCatalogSync('product_admin_deactivate', () => {
              const mirrorApplied = mirrorProductAdminVariant(data.variant, 'product_admin_deactivate');
              if (mirrorApplied) deactivateLocalProductAdminVariant(variantId, 'product_admin_deactivate');
            }, isCurrentProductAdminSession);
          },
        );
        if (!result.ok && isProductAdminNotFound(result) && isDeactivateRequestContextCurrent()) {
          try {
            await runProductAdminLocalMutationAfterPendingCatalogSync('product_admin_deactivate_not_found', () => {
              deactivateLocalProductAdminVariant(variantId, 'product_admin_deactivate_not_found');
            }, isDeactivateRequestContextCurrent);
          } catch (mirrorError: any) {
            logger.warn(
              `[PosModule] product-admin local not-found deactivate failed: ${mirrorError?.message ?? mirrorError}`,
            );
          }
        }
        return result;
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_ADJUST_STOCK,
      async (_e, variantId: string, payload: ProductAdminStockAdjustmentInput) => {
        const input = {
          ...(payload || {}),
          idempotencyKey: payload?.idempotencyKey || randomUUID(),
        } as ProductAdminStockAdjustmentInput;
        const { idempotencyKey, ...requestPayload } = input;
        return withProductAdminCapability<ProductAdminStockAdjustmentResponse>(
          'canAdjustStock',
          'adjust stock',
          async (_token, capabilities) => {
            const expectedUpdatedAt = requireProductAdminExpectedUpdatedAt(
              capabilities,
              requestPayload.expectedUpdatedAt,
            );
            if (requestPayload.mode === 'receive' && capabilities.supportsLotReceiving === true) {
              const error = new Error('lot-aware-receiving-required') as Error & {
                code?: string;
                status?: number;
              };
              error.code = 'LOT_RECEIVING_REQUIRED';
              error.status = 409;
              throw error;
            }
            const resolvedVariantId = resolveVariantIdAlias(variantId);
            const existingProduct = productRepo.getById(resolvedVariantId);
            const field = requestPayload.mode === 'recount' ? 'newQuantity' : 'quantity';
            assertProductStockQuantity(
              requestPayload[field],
              classifyProductSale(existingProduct ?? {}).sellBy,
              field,
              requestPayload.mode === 'recount',
            );
            return productAdminMutationOutbox.execute({
              mutationType: 'ADJUST_STOCK',
              targetVariantId: resolvedVariantId,
              idempotencyKey,
              request: { payload: { ...requestPayload, expectedUpdatedAt } },
            }) as Promise<ProductAdminStockAdjustmentResponse>;
          },
        );
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_GET_VARIANT,
      async (_e, variantId: string) =>
        withProductAdminCapability<ProductAdminVariantDetailResponse>(
          'canViewPurchasePrice',
          'get variant detail',
          (token, capabilities) => {
            if (capabilities.supportsPurchasePrice !== true) {
              const error = new Error('purchase-price-unavailable') as Error & { code?: string };
              error.code = 'UNSUPPORTED_CAPABILITY';
              throw error;
            }
            return apiClient.getProductAdminVariant(token, resolveVariantIdAlias(variantId));
          },
        ),
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_UPLOAD_MAIN_IMAGE,
      async (_e, variantId: string, payload: ProductAdminMainImageUploadInput) =>
        withProductAdminCapability<ProductAdminMainImageUploadResponse>(
          'canReplaceMainImage',
          'upload main image',
          async (_token, capabilities) => {
            if (capabilities.supportsMainImageUpload !== true) {
              const error = new Error('main-image-upload-unavailable') as Error & { code?: string };
              error.code = 'UNSUPPORTED_CAPABILITY';
              throw error;
            }
            const expectedUpdatedAt = requireProductAdminExpectedUpdatedAt(
              capabilities,
              payload?.expectedUpdatedAt,
            );
            const image = decodeProductImageDataUrl(payload);
            return productAdminMutationOutbox.execute({
              mutationType: 'UPLOAD_MAIN_IMAGE',
              targetVariantId: resolveVariantIdAlias(variantId),
              request: {
                payload: {
                  mimeType: image.mimeType,
                  fileName: image.fileName,
                  expectedUpdatedAt,
                },
              },
              stagedImage: image,
            }) as Promise<ProductAdminMainImageUploadResponse>;
          },
        ),
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_LIST_LOTS,
      async (_e, variantId: string) =>
        withProductAdminCapability<ProductAdminLotListResponse>(
          'canReceiveStock',
          'list stock lots',
          (token, capabilities) => {
            if (capabilities.supportsStockLots !== true) {
              const error = new Error('stock-lots-unavailable') as Error & { code?: string };
              error.code = 'UNSUPPORTED_CAPABILITY';
              throw error;
            }
            return apiClient.listProductStockLots(token, resolveVariantIdAlias(variantId));
          },
        ),
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_RECEIVE_STOCK,
      async (_e, variantId: string, payload: ProductAdminReceiveStockInput) => {
        return withProductAdminCapability<ProductAdminReceiveStockResponse>(
          'canReceiveStock',
          'receive stock',
          async (_token, capabilities) => {
            if (capabilities.supportsLotReceiving !== true) {
              const error = new Error('lot-receiving-unavailable') as Error & { code?: string };
              error.code = 'UNSUPPORTED_CAPABILITY';
              throw error;
            }
            const resolvedVariantId = resolveVariantIdAlias(variantId);
            const existingProduct = productRepo.getById(resolvedVariantId);
            const input = normalizeProductReceiptInput(
              payload,
              classifyProductSale(existingProduct ?? {}).sellBy,
            );
            const expectedUpdatedAt = requireProductAdminExpectedUpdatedAt(
              capabilities,
              input.expectedUpdatedAt,
            );
            if (!canAccessProductPurchasePrice(capabilities)) {
              delete input.unitCostGrosze;
            }
            const { idempotencyKey, ...requestPayload } = input;
            return productAdminMutationOutbox.execute({
              mutationType: 'RECEIVE_STOCK',
              targetVariantId: resolvedVariantId,
              idempotencyKey,
              request: { payload: { ...requestPayload, expectedUpdatedAt } },
            }) as Promise<ProductAdminReceiveStockResponse>;
          },
        );
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_LIST,
      async () => {
        const token = getSecureAuthToken();
        if (!token) {
          return { ok: false, error: 'no-auth', code: 'UNAUTHORIZED_PRODUCT_ADMIN' } as ProductAdminIpcResult<ProductAdminCategoryListResponse>;
        }
        try {
          const capabilities = await apiClient.getProductAdminCapabilities(token);
          if (!capabilities.canCreateCategory
            && !capabilities.canUpdateCategory
            && !capabilities.canDeleteCategory
            && !capabilities.canReplaceCategoryImage) {
            return { ok: false, error: 'unsupported-capability', code: 'UNSUPPORTED_CAPABILITY' } as ProductAdminIpcResult<ProductAdminCategoryListResponse>;
          }
          const data = await apiClient.listProductAdminCategories(token);
          return { ok: true, data } as ProductAdminIpcResult<ProductAdminCategoryListResponse>;
        } catch (err: any) {
          logger.warn(`[PosModule] product-admin list categories failed: ${err?.message ?? err}`);
          return toProductAdminError<ProductAdminCategoryListResponse>(err, 'list categories failed');
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_CREATE,
      async (_e, payload: ProductAdminCategoryMutationInput) => {
        const input = {
          ...(payload || {}),
          idempotencyKey: payload?.idempotencyKey || randomUUID(),
        } as ProductAdminCategoryMutationInput;
        return withProductAdminCapability<ProductAdminCategoryMutationResponse>(
          'canCreateCategory',
          'create category',
          async (_token, capabilities) => {
            const sanitizedInput = sanitizeProductAdminCategoryJsonMutation(
              input,
              capabilities,
              { allowImageRemoval: false },
            );
            const { idempotencyKey, ...requestPayload } = sanitizedInput;
            return productAdminMutationOutbox.execute({
              mutationType: 'CREATE_CATEGORY',
              idempotencyKey,
              request: { payload: requestPayload },
            }) as Promise<ProductAdminCategoryMutationResponse>;
          },
        );
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_UPDATE,
      async (_e, categoryId: string, payload: ProductAdminCategoryMutationInput) => {
        return withProductAdminCapability<ProductAdminCategoryMutationResponse>(
          'canUpdateCategory',
          'update category',
          (token, capabilities) => {
            const sanitizedPayload = sanitizeProductAdminCategoryJsonMutation(
              payload || ({} as ProductAdminCategoryMutationInput),
              capabilities,
              { allowImageRemoval: true },
            );
            if (sanitizedPayload.kitchenPrint !== undefined
              && capabilities.supportsCategoryKitchenPrint !== true) {
              const error = new Error('category-kitchen-print-unavailable') as Error & { code?: string };
              error.code = 'UNSUPPORTED_CAPABILITY';
              throw error;
            }
            const expectedUpdatedAt = requireProductAdminExpectedUpdatedAt(
              capabilities,
              sanitizedPayload.expectedUpdatedAt,
            );
            return apiClient.updateProductAdminCategory(token, categoryId, {
              ...sanitizedPayload,
              expectedUpdatedAt,
            });
          },
          async (data, isCurrentProductAdminSession) => {
            await runProductAdminLocalMutationAfterPendingCatalogSync(
              'product_admin_category_update',
              () => {
                mirrorProductAdminCategory(data.category, 'product_admin_category_update');
              },
              isCurrentProductAdminSession,
            );
          },
        );
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_UPDATE_ORDER,
      async (_e, input: ProductAdminCategoryOrderUpdate[]) => {
        const updates = normalizeCategoryOrderUpdates(input);
        if (updates.length === 0) {
          return {
            ok: true,
            data: { categories: [], updated: 0 },
          } as ProductAdminIpcResult<ProductAdminCategoryOrderUpdateResponse>;
        }

        return withProductAdminCapability<ProductAdminCategoryOrderUpdateResponse>(
          'canUpdateCategory',
          'update category order',
          async (token, capabilities) => {
            if (capabilities.canReorderCategory !== true
              || capabilities.supportsCategoryBatchUpdate !== true) {
              const error = new Error('category-batch-order-unavailable') as Error & { code?: string };
              error.code = 'UNSUPPORTED_CAPABILITY';
              throw error;
            }
            const exactUpdates = updates.map((update) => ({
              ...update,
              expectedUpdatedAt: requireProductAdminExpectedUpdatedAt(
                capabilities,
                update.expectedUpdatedAt,
              ),
            }));
            return apiClient.updateProductAdminCategoryOrder(token, exactUpdates);
          },
          async (data, isCurrentProductAdminSession) => {
            await runProductAdminLocalMutationAfterPendingCatalogSync(
              'product_admin_category_order',
              () => {
                for (const category of data.categories || []) {
                  mirrorProductAdminCategory(category, 'product_admin_category_order');
                }
                database.markDirty();
              },
              isCurrentProductAdminSession,
            );
          },
        );
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_UPLOAD_IMAGE,
      async (
        _e,
        categoryId: string,
        payload: ProductAdminCategoryImageUploadInput,
      ) =>
        withProductAdminCapability<ProductAdminCategoryImageUploadResponse>(
          'canReplaceCategoryImage',
          'upload category image',
          async (token, capabilities) => {
            if (capabilities.supportsCategoryImageUpload !== true) {
              const error = new Error('category-image-upload-unavailable') as Error & {
                code?: string;
                status?: number;
              };
              error.code = 'UNSUPPORTED_CAPABILITY';
              error.status = 409;
              throw error;
            }
            const expectedUpdatedAt = requireProductAdminExpectedUpdatedAt(
              capabilities,
              payload?.expectedUpdatedAt,
            );
            const image = decodeCategoryImageDataUrl(payload);
            return apiClient.uploadProductAdminCategoryImage(token, categoryId, {
              ...image,
              expectedUpdatedAt,
            });
          },
          async (data, isCurrentProductAdminSession) => {
            await runProductAdminLocalMutationAfterPendingCatalogSync(
              'product_admin_category_image',
              () => {
                mirrorProductAdminCategory(data.category, 'product_admin_category_image');
              },
              isCurrentProductAdminSession,
            );
          },
        ),
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_PRODUCT_ADMIN_CATEGORIES_DELETE,
      async (
        _e,
        categoryId: string,
        payload: ProductAdminCategoryDeleteInput,
      ) =>
        withProductAdminCapability<ProductAdminCategoryDeleteResponse>(
          'canDeleteCategory',
          'delete category',
          (token, capabilities) => {
            const expectedUpdatedAt = requireProductAdminExpectedUpdatedAt(
              capabilities,
              payload?.expectedUpdatedAt,
            );
            return apiClient.deleteProductAdminCategory(token, categoryId, expectedUpdatedAt);
          },
          async (data, isCurrentProductAdminSession) => {
            await runProductAdminLocalMutationAfterPendingCatalogSync(
              'product_admin_category_delete',
              () => {
                reconcileDeletedProductAdminCategoryLocally(categoryId, data);
              },
              isCurrentProductAdminSession,
            );
          },
        ),
    );

    ipcMain.handle(IPC_CHANNELS.POS_KITCHEN_CATEGORIES_GET_ALL, () => getKitchenSelfOrderCategories());

    ipcMain.handle(
      IPC_CHANNELS.POS_KITCHEN_CATEGORIES_UPDATE_ORDER,
      async (_e, input: ProductAdminCategoryOrderUpdate[]) => {
        const updates = normalizeCategoryOrderUpdates(input);
        if (updates.length === 0) {
          return {
            ok: true,
            data: { categories: [], updated: 0 },
          };
        }
        try {
          const categories = kitchenSelfOrderCategoryPrefsRepo.setSortOrders(updates);
          database.markDirty();
          notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
          notifyPosRenderers(this.container, IPC_CHANNELS.POS_CATALOG_UPDATED, {
            source: 'kitchen_self_order_category_prefs_order',
          });
          return {
            ok: true,
            data: { categories, updated: categories.length },
          };
        } catch (err: any) {
          logger.warn(`[PosModule] local kitchen category order update failed: ${err?.message ?? err}`);
          return { ok: false, error: err?.message ?? 'local-kitchen-category-order-update-failed' };
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.POS_KITCHEN_CATEGORY_SET_PRINT_ENABLED,
      async (_e, categoryId: string, enabled: boolean) => {
        const id = String(categoryId || '').trim();
        if (!id) return { ok: false, error: 'missing-category-id' };
        try {
          const pref = kitchenSelfOrderCategoryPrefsRepo.setVisible(id, enabled === true);
          // Legacy local mirror only; KSO reads the prefs table above.
          productRepo.setCategoryKitchenPrint(id, enabled === true);
          database.markDirty();
          notifyPosRenderers(this.container, IPC_CHANNELS.POS_PRODUCTS_SYNCED);
          notifyPosRenderers(this.container, IPC_CHANNELS.POS_CATALOG_UPDATED, {
            source: 'kitchen_self_order_category_prefs_visible',
          });
          return {
            ok: true,
            data: pref,
          };
        } catch (err: any) {
          logger.warn(`[PosModule] local kitchen category update failed: ${err?.message ?? err}`);
          return { ok: false, error: err?.message ?? 'local-kitchen-category-update-failed' };
        }
      },
    );

    // Draft products (server-mirrored, see DraftProductSync)
    ipcMain.handle('pos:draft-products:getAll', (_e, limit?: number) => draftProductRepo.getAll(limit));
    ipcMain.handle('pos:draft-products:getByStatus', (_e, status: string) => draftProductRepo.getByStatus(status));
    ipcMain.handle('pos:draft-products:getByBarcode', (_e, barcode: string) => draftProductRepo.getByBarcode(barcode));
    ipcMain.handle('pos:draft-products:getById', (_e, id: string) => draftProductRepo.getById(id));
    ipcMain.handle('pos:draft-products:searchByCode', (_e, query: string) => draftProductRepo.searchByCode(query));

    // Local-first import: materialize a draft into product_variants without
    // a server roundtrip so the cashier can sell immediately even when the
    // master-catalog endpoint is down. A `local_variant_imports` marker
    // tracks the row so ProductSync.deactivateExcept keeps it alive and
    // OrderSync defers pushing orders that depend on it.
    ipcMain.handle('pos:master-catalog:import-draft', async (_e, payload: {
      ean: string;
      retailPriceGrosze?: number;
      categoryId?: string;
      stockQty?: number;
    }) => {
      const ean = normalizeScanCreateEan(payload?.ean);
      if (!ean) return { ok: false, error: 'missing-ean' };
      const requestedRetailPrice = Number(payload?.retailPriceGrosze);
      const retailPriceGrosze = Number.isFinite(requestedRetailPrice)
        ? Math.round(requestedRetailPrice)
        : null;
      const categoryResolution = resolveBackendScanCategoryId(String(payload?.categoryId ?? '').trim() || null);
      if (!categoryResolution.ok) {
        return { ok: false, error: 'invalid-category' };
      }
      const categoryId = categoryResolution.categoryId;
      let initialStockQty: number;
      try {
        initialStockQty = assertProductStockQuantity(
          payload?.stockQty ?? 0,
          'PIECE',
          'stockQty',
          true,
        );
      } catch {
        return { ok: false, error: 'invalid-stock-quantity' };
      }

      const existing = productRepo.getByBarcode(ean);
      if (existing) {
        return { ok: true, outcome: 'EXISTING_VARIANT', variant: existing };
      }

      let draft = draftProductRepo.getByBarcode(ean);
      if (!draft) {
        try {
          const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
          await syncMod?.deltaSync?.();
          const syncedExisting = productRepo.getByBarcode(ean);
          if (syncedExisting) {
            return { ok: true, outcome: 'EXISTING_VARIANT', variant: syncedExisting };
          }
        } catch (syncErr: any) {
          logger.debug(`[PosModule] product sync before draft import skipped: ${syncErr?.message ?? syncErr}`);
        }
        try {
          await draftProductSync.deltaSync();
          draft = draftProductRepo.getByBarcode(ean);
        } catch (syncErr: any) {
          logger.debug(`[PosModule] draft sync before import skipped: ${syncErr?.message ?? syncErr}`);
        }
      }
      if (!draft) return { ok: false, error: 'draft-not-found' };
      if (retailPriceGrosze == null || retailPriceGrosze < 1) {
        return { ok: false, error: 'draft-missing-price' };
      }
      const importRetailPrice = retailPriceGrosze;

      try {
        // Reuse the draft's UUID as the variant id. Clean lineage — when
        // the server eventually creates its own variant for this draft we
        // can match on id (or treat it as an upsert via delta sync).
        const variantId = draft.id;
        const now = new Date().toISOString();
        const scanCreatePayload = {
          ean,
          retailPrice: importRetailPrice / 100,
          stockQty: initialStockQty,
          taxRate: draft.vat_rate,
          categoryId,
        };
        const intentIdempotencyKey = buildLocalImportMutationKey({
          variantId,
          ...scanCreatePayload,
        });

        database.transaction(() => {
          productRepo.upsertMany([{
            id: variantId,
            template_id: null,
            name: draft.name,
            sku: draft.sku,
            barcode: draft.barcode,
            retail_price: importRetailPrice,
            category_id: categoryId,
            image_url: draft.image_url,
            in_stock: initialStockQty,
            vat_rate: draft.vat_rate,
            is_active: 1,
            updated_at: now,
            available_qty: initialStockQty,
            price_gross: importRetailPrice,
            price_net: Math.round(importRetailPrice * 100 / (100 + (draft.vat_rate || 0))),
            vat_amount: importRetailPrice - Math.round(importRetailPrice * 100 / (100 + (draft.vat_rate || 0))),
            is_on_sale: 0,
            thumbnail_url: draft.image_url,
            sale_unit: null,
            sell_by: 'PIECE',
            name_translations: null,
            item_type: 'stockable',
            track_inventory: 1,
          }]);
          localVariantImportsRepo.create(
            variantId,
            draft.id,
            ean,
            categoryId,
            {
              payloadJson: JSON.stringify(scanCreatePayload),
              idempotencyKey: intentIdempotencyKey,
            },
          );
        });
        database.markDirty();

        logger.info(`[PosModule] Local import: draft ${draft.id} → variant ${variantId} (ean=${ean})`);
        notifyPosRenderers(this.container, 'pos:products-synced');
        const variant = productRepo.getById(variantId);
        let syncPending = true;
        let resolvedVariant = variant;
        try {
          const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
          await syncMod?.reconcileLocalVariantImports?.(1, variantId);
          const serverId = localVariantImportsRepo.getServerVariantId(variantId);
          if (serverId) {
            syncPending = false;
            await syncMod?.deltaSync?.();
            // Hand the renderer the SERVER row when it already exists in the
            // local mirror — opening the edit view on the draft-id alias is
            // what made every follow-up save 404 with "Variant not found".
            const serverVariant = serverId ? productRepo.getById(serverId) : null;
            resolvedVariant = serverVariant ?? variant;
            notifyPosRenderers(this.container, 'pos:products-synced');
          }
        } catch (syncErr: any) {
          logger.debug(`[PosModule] immediate online draft import skipped: ${syncErr?.message ?? syncErr}`);
        }
        return { ok: true, outcome: 'LOCAL_IMPORT', variant: resolvedVariant, syncPending };
      } catch (err: any) {
        logger.error(`[PosModule] Local draft import failed for ean=${ean}: ${err?.message ?? err}`);
        return { ok: false, error: err?.message ?? 'local-import-failed' };
      }
    });

    // Master catalog one-shot API (lookup + scan-create)
    ipcMain.handle('pos:master-catalog:lookup-by-ean', async (_e, ean: string) => {
      const token = getSecureAuthToken();
      try {
        const draft = await apiClient.lookupByEan(token, ean);
        return { ok: true, draft };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? 'lookup-failed', draft: null };
      }
    });

    ipcMain.handle('pos:master-catalog:lookup-external-by-ean', async (_e, ean: string) => {
      try {
        const product = await lookupExternalProductByEan(ean, getExternalProductLookupOptions());
        return { ok: true, product };
      } catch (err: any) {
        logger.warn(`[PosModule] external EAN lookup failed ean=${ean}: ${err?.message ?? err}`);
        return { ok: false, error: err?.message ?? 'external-lookup-failed', product: null };
      }
    });

    ipcMain.handle(
      'pos:master-catalog:import-external',
      async (_e, payload: { ean: string; retailPriceGrosze?: number; quantity?: number }) => {
        const ean = normalizeEan(payload?.ean);
        if (!ean) return { ok: false, error: 'invalid-ean' };

        const requestedRetailPrice = Number(payload?.retailPriceGrosze);
        const retailPriceGrosze = Number.isFinite(requestedRetailPrice)
          ? Math.round(requestedRetailPrice)
          : 0;
        if (!(retailPriceGrosze >= 1)) {
          return { ok: false, error: 'missing-price' };
        }

        const requestedQuantity = Number(payload?.quantity);
        const quantity = Number.isFinite(requestedQuantity) && requestedQuantity > 0
          ? requestedQuantity
          : 1;

        const existing = productRepo.getByBarcode(ean);
        if (existing) {
          return { ok: true, outcome: 'EXISTING_VARIANT', variant: existing };
        }

        const token = getSecureAuthToken();
        if (!token) return { ok: false, error: 'no-auth' };

        try {
          const externalProduct = await lookupExternalProductByEan(ean, getExternalProductLookupOptions());
          if (!externalProduct) return { ok: false, error: 'external-product-not-found' };

          const createPayload: Record<string, unknown> = {
            name: externalProduct.name,
            ean: externalProduct.ean,
          };
          if (externalProduct.imageUrl) createPayload.imageUrl = externalProduct.imageUrl;

          const prepared = await apiClient.quickAddCreate(token, createPayload, `external-ean-prepare-${externalProduct.ean}`);

          const productId = prepared.product?.id ?? prepared.productId ?? prepared.product_id;
          const variantId =
            prepared.variant?.id
            ?? prepared.variantId
            ?? prepared.variant_id
            ?? prepared.product?.variant?.id;
          if (!productId || !variantId) {
            return { ok: false, error: 'quick-add-create-returned-no-product-ids' };
          }

          const finalized = await apiClient.quickAddCreate(token, {
            productId,
            variantId,
            name: externalProduct.name,
            retailPrice: retailPriceGrosze / 100,
            quantity,
          }, `external-ean-finalize-${externalProduct.ean}-${retailPriceGrosze}`);

          const productForLocal = {
            ...(prepared.product ?? {}),
            ...(finalized.product ?? {}),
            id: finalized.product?.id ?? prepared.product?.id ?? productId,
            name: externalProduct.name,
            ean: externalProduct.ean,
            barcode: externalProduct.ean,
            imageUrl: finalized.product?.imageUrl ?? prepared.product?.imageUrl ?? externalProduct.imageUrl,
            image_url: finalized.product?.image_url ?? prepared.product?.image_url ?? externalProduct.imageUrl,
          };
          const variantForLocal = {
            ...(prepared.variant ?? {}),
            ...(finalized.variant ?? {}),
            id: finalized.variant?.id ?? prepared.variant?.id ?? variantId,
            name: externalProduct.name,
            barcode: finalized.variant?.barcode ?? prepared.variant?.barcode ?? externalProduct.ean,
            imageUrl: finalized.variant?.imageUrl ?? prepared.variant?.imageUrl ?? externalProduct.imageUrl,
            image_url: finalized.variant?.image_url ?? prepared.variant?.image_url ?? externalProduct.imageUrl,
          };
          const localVariant = toQuickAddVariantRow(productForLocal, variantForLocal, {
            retailPriceGrosze,
            quantity,
          });

          if (localVariant) {
            productRepo.upsertMany([localVariant]);
            database.markDirty();
            notifyPosRenderers(this.container, 'pos:products-synced');
          }

          let syncPending = false;
          try {
            const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
            await syncMod?.deltaSync?.();
            notifyPosRenderers(this.container, 'pos:products-synced');
          } catch (syncErr: any) {
            syncPending = true;
            logger.debug(`[PosModule] post-external-import product sync skipped: ${syncErr?.message ?? syncErr}`);
          }

          return {
            ok: true,
            outcome: 'EXTERNAL_IMPORT',
            product: finalized.product ?? prepared.product ?? null,
            variant: localVariant ?? finalized.variant ?? prepared.variant ?? null,
            source: externalProduct.source,
            syncPending,
          };
        } catch (err: any) {
          logger.error(`[PosModule] external EAN import failed ean=${ean}: ${err?.message ?? err}`);
          return { ok: false, error: err?.message ?? 'external-import-failed' };
        }
      },
    );
    ipcMain.handle(
      'pos:master-catalog:scan-create',
      async (_e, payload: {
        ean: string;
        purchasePrice?: number;
        retailPrice?: number;
        stockQty?: number;
        taxRate?: number;
        warehouseId?: string;
        categoryId?: string | null;
        idempotencyKey?: string;
      }) => {
        const token = getSecureAuthToken();
        logger.info(`[PosModule] scan-create requested ean=${payload?.ean} stockQty=${payload?.stockQty ?? 'n/a'} idk=${payload?.idempotencyKey ?? 'n/a'}`);
        try {
          const categoryResolution = resolveBackendScanCategoryId(String(payload?.categoryId ?? '').trim() || null);
          const result = await apiClient.scanCreate(token, {
            ...payload,
            categoryId: categoryResolution.ok ? categoryResolution.categoryId : null,
          });
          logger.info(`[PosModule] scan-create OK outcome=${result?.outcome} productId=${result?.productId ?? result?.product?.id ?? 'n/a'} variantId=${result?.variantId ?? result?.variant?.id ?? 'n/a'}`);
          // Pull fresh products + drafts so renderer can see the new variant.
          try {
            const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
            await syncMod?.deltaSync?.();
          } catch (syncErr: any) {
            logger.debug(`[PosModule] post-scan-create product sync skipped: ${syncErr?.message ?? syncErr}`);
          }
          try { await draftProductSync.deltaSync(); }
          catch (syncErr: any) { logger.debug(`[PosModule] post-scan-create draft sync skipped: ${syncErr?.message ?? syncErr}`); }
          return { ok: true, ...result };
        } catch (err: any) {
          logger.error(`[PosModule] scan-create FAILED ean=${payload?.ean}: ${err?.message ?? err}`);
          if (err?.serverBody) {
            logger.error(`[PosModule] scan-create server body: ${JSON.stringify(err.serverBody).slice(0, 800)}`);
          }
          return { ok: false, error: err?.message ?? 'scan-create-failed' };
        }
      },
    );

    // Absolute file:// path to the webview bridge preload, for the embedded
    // /add page panel. Computed in main (the sandboxed renderer/preload cannot
    // use `path`). dist layout: this module = dist/main/modules, preload =
    // dist/preload/addbridge-preload.js.
    ipcMain.handle('app:addbridge-preload-path', () => {
      return pathToFileURL(path.join(__dirname, '../../preload/addbridge-preload.js')).href;
    });

    // Pure recognition preview (reusable backend module). Returns structured
    // products[] (type/name/quantity/ean) for the cashier to eyeball BEFORE
    // the existing quick-add create/finalize flow runs. Does not touch stock.
    ipcMain.handle(
      'pos:recognition:analyze',
      async (_e, payload: { images: Array<{ dataUrl?: string; url?: string; mimeType?: string }>; language?: string }) => {
        try {
          if (!Array.isArray(payload?.images) || payload.images.length < 1 || payload.images.length > 5) {
            return { ok: false, error: 'Capture 1 to 5 images before recognizing' };
          }
          const result = await apiClient.recognizeProducts(payload.images, payload.language || 'vi');
          return result?.ok === false
            ? { ok: false, error: result.error || 'recognition-failed' }
            : { ok: true, products: result?.products ?? [], language: result?.language };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? 'recognition-failed' };
        }
      },
    );

    ipcMain.handle(
      'pos:recognition:scan-match',
      async (_e, payload: { images: Array<{ dataUrl?: string; url?: string; mimeType?: string }>; language?: string; limit?: number }) => {
        try {
          if (!Array.isArray(payload?.images) || payload.images.length < 1 || payload.images.length > 5) {
            return { ok: false, error: 'Capture 1 to 5 images before matching' };
          }
          const result = await apiClient.scanMatchProducts(payload.images, payload.language || 'vi', payload.limit || 5);
          const data = result?.data && typeof result.data === 'object' ? result.data : null;
          const products =
            result?.products ??
            result?.matches ??
            result?.candidates ??
            (Array.isArray(result?.data) ? result.data : undefined) ??
            data?.products ??
            data?.matches ??
            data?.candidates ??
            [];
          return result?.ok === false
            ? { ok: false, error: result.error || 'scan-match-failed' }
            : { ...result, ok: true, products: Array.isArray(products) ? products : [] };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? 'scan-match-failed' };
        }
      },
    );

    ipcMain.handle(
      'pos:voice:transcribe',
      async (_e, payload: PosVoiceTranscribePayload) => {
        const result = await transcribeWithPhoWhisper(payload || {});
        if (!result.ok) {
          logger.warn(`[PosModule] PhoWhisper transcription failed: ${result.error}`);
        }
        return result;
      },
    );

    ipcMain.handle(
      'pos:quick-add:prepare',
      async (_e, payload: { images: Array<{ dataUrl: string; mimeType?: string }>; language?: string; idempotencyKey?: string }) => {
        try {
          if (!Array.isArray(payload.images) || payload.images.length < 2 || payload.images.length > 3) {
            return { ok: false, error: 'Capture 2 or 3 images before sending' };
          }
          const token = getSecureAuthToken();
          if (!token) return { ok: false, error: 'no-auth' };

          const uploadedImages = await Promise.all(
            payload.images.map((image, index) =>
              apiClient.quickAddUploadImage(token, {
                dataUrl: image.dataUrl,
                mimeType: image.mimeType || 'image/jpeg',
                filename: `quick-add-${Date.now()}-${index + 1}.jpg`,
              }),
            ),
          );
          const images = uploadedImages.map((image, index) => ({
            url: image.url,
            mimeType: payload.images[index]?.mimeType || 'image/jpeg',
          }));
          const rawAnalysis = await apiClient.quickAddAnalyzeMultiple(token, images, payload.language || 'pl');
          const analysis = normalizeQuickAddAnalysis(rawAnalysis);
          if (!analysis.name) {
            analysis.name = fallbackQuickAddName(analysis);
            analysis.nameNeedsReview = true;
          }

          const createPayload: Record<string, unknown> = {
            name: analysis.name,
            imageUrl: images[0]?.url,
          };
          if (analysis.ean) createPayload.ean = analysis.ean;
          if (analysis.weight != null) createPayload.weight = analysis.weight;
          if (analysis.weightUnit) createPayload.weightUnit = analysis.weightUnit;

          const created = await apiClient.quickAddCreate(token, createPayload, payload.idempotencyKey);
          return {
            ok: true,
            images,
            analysis,
            product: created.product ?? null,
            variant: created.variant ?? null,
          };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? 'quick-add-prepare-failed' };
        }
      },
    );

    ipcMain.handle(
      'pos:quick-add:finalize',
      async (_e, payload: { productId: string; variantId: string; name?: string; retailPrice: number; quantity: number; idempotencyKey?: string }) => {
        try {
          if (!payload.productId || !payload.variantId) return { ok: false, error: 'Missing product or variant id' };
          if (!payload.name?.trim()) return { ok: false, error: 'Product name is required' };
          if (!(payload.retailPrice > 0)) return { ok: false, error: 'Retail price must be greater than zero' };
          if (!(payload.quantity > 0)) return { ok: false, error: 'Quantity must be greater than zero' };
          const token = getSecureAuthToken();
          if (!token) return { ok: false, error: 'no-auth' };

          const finalName = payload.name.trim();
          const result = await apiClient.quickAddCreate(token, {
            productId: payload.productId,
            variantId: payload.variantId,
            name: finalName,
            retailPrice: payload.retailPrice,
            quantity: payload.quantity,
          }, payload.idempotencyKey);

          const productForLocal = {
            ...(result.product ?? {}),
            id: result.product?.id ?? payload.productId,
            name: finalName,
          };
          const variantForLocal = result.variant
            ? { ...result.variant, name: finalName }
            : result.variant;
          const localVariant = toQuickAddVariantRow(productForLocal, variantForLocal, {
            retailPriceGrosze: Math.round(payload.retailPrice * 100),
            quantity: payload.quantity,
          });
          if (localVariant) {
            productRepo.upsertMany([localVariant]);
            database.markDirty();
            notifyPosRenderers(this.container, 'pos:products-synced');
          }

          let syncPending = false;
          try {
            const syncMod = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
            await syncMod?.deltaSync?.();
            notifyPosRenderers(this.container, 'pos:products-synced');
          } catch (syncErr: any) {
            syncPending = true;
            logger.debug(`[PosModule] post-quick-add product sync skipped: ${syncErr?.message ?? syncErr}`);
          }

          return {
            ok: true,
            product: result.product ?? null,
            variant: localVariant ?? result.variant ?? null,
            syncPending,
          };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? 'quick-add-finalize-failed' };
        }
      },
    );

    // Orders
    ipcMain.handle('pos:orders:create', async (_e, order, items) => {
      let committedBilliardRecord: BilliardHandoffRecord | null = null;
      let tenderedBilliardCart: { checkoutId: string; orderId: string } | null = null;
      let committedRestoredOrderId: string | null = null;
      let tenderedRestoredCart: { holdId: string; orderId: string } | null = null;
      let orderAuthContext: PosAuthContext | null = null;
      try {
        orderAuthContext = this.capturePosAuthContext();
        const entryState = this.posStore?.getState();
        const entryBilliardCheckoutId = entryState?.checkoutDraft.billiard?.origin.checkoutId;
        if (entryBilliardCheckoutId) {
          const entryRecord = billiardPosHandoffRepo.get(entryBilliardCheckoutId);
          if (
            entryRecord
            && entryRecord.state === 'POS_TENDER_COMMITTING'
            && entryRecord.salonId === orderAuthContext.scope.salonId
            && entryRecord.userId === orderAuthContext.scope.userId
            && entryRecord.registerId === orderAuthContext.scope.registerId
            && !orderRepo.getById(entryRecord.orderId)
          ) {
            tenderedBilliardCart = { checkoutId: entryRecord.checkoutId, orderId: entryRecord.orderId };
          }
        }
        const entryRestored = entryState?.checkoutDraft.restoredInterruption;
        if (entryRestored) {
          const entryHold = holdOrderRepo.get(entryRestored.holdId);
          const entryJournal = entryHold?.payload?.restoredCheckout;
          if (
            entryHold?.payload?.protected === true
            && isValidRestoredCartCheckoutJournal(entryJournal)
            && entryJournal.state === 'TENDER_COMMITTING'
            && sameRestoredCartCheckoutIdentity(entryRestored, entryJournal)
            && !orderRepo.getById(entryJournal.orderId)
          ) {
            tenderedRestoredCart = { holdId: entryRestored.holdId, orderId: entryJournal.orderId };
          }
        }
        if (this.holdRecallInFlight) {
          throw new Error('A held cart recall is still being saved. Do not collect payment yet.');
        }
        const normalizedOrder = { ...(order || {}) };
        const normalizedSource = String(normalizedOrder.source || 'POS').trim().toUpperCase() || 'POS';
        normalizedOrder.source = normalizedSource;
        const requiresRegisterShift = normalizedSource === 'POS' || normalizedSource === 'KITCHEN_SELF_ORDER';
        const ordinaryPaymentPreflightToken = String(normalizedOrder.payment_preflight_token || '').trim();
        delete normalizedOrder.payment_preflight_token;
        const normalizedItems = (items || []).map((item: any) => {
          const product = item.variant_id ? productRepo.getById(item.variant_id) : null;
          const sell_by = getLineSellBy({
            ...item,
            sell_by: item.sell_by ?? item.sellBy ?? product?.sell_by ?? 'PIECE',
          });
          const sale_quantity = getLineSaleQuantity({ ...item, sell_by });
          const sale_unit = getLineSaleUnit({
            ...item,
            sell_by,
            sale_unit: item.sale_unit ?? item.saleUnit ?? product?.sale_unit ?? null,
          });
          const price = Math.max(0, Math.round(Number(item.price) || 0));
          return {
            ...item,
            price,
            quantity: sale_quantity,
            sale_quantity,
            sale_unit,
            sell_by,
            total: getLineTotalGrosze({ ...item, price, quantity: sale_quantity, sale_quantity, sell_by }),
          };
        });
        assertPosPaymentAccounting(normalizedOrder);
        // Protected tenders already performed the async route-aware check
        // (including their frozen checkout-level discount) before cashier
        // collection. This post-tender commit guard must not introduce a
        // fresh network dependency; re-check the local-first route only,
        // matching PaymentController's actual selection. The ordinary
        // checkout discount is deliberately NOT passed here: the ELZAB
        // sidecar prints it as a whole-receipt discount (ReceiptEndEx), so
        // only frozen per-line Billiard allocations riding on the items can
        // make the local fiscal route unprintable at commit time.
        this.assertLocalTenderFiscalCompatibility(normalizedItems);

        const billiardRecord = this.resolveBilliardOrderRequest(normalizedOrder, normalizedItems, false);
        const restoredContext = !billiardRecord
          ? this.posStore?.getState().checkoutDraft.restoredInterruption ?? null
          : null;
        if (
          !billiardRecord
          && !restoredContext
          && requiresRegisterShift
        ) {
          this.assertOrdinaryPosPaymentPreflight(
            ordinaryPaymentPreflightToken,
            String(normalizedOrder.id || ''),
            orderAuthContext,
          );
        }
        if (billiardRecord || restoredContext) {
          assertProtectedPosPaymentMethods(normalizedOrder);
        }
        const restoredHold = restoredContext ? holdOrderRepo.get(restoredContext.holdId) : null;
        if (restoredContext && (
          !restoredHold
          || restoredHold.payload?.protected !== true
          || restoredHold.payload?.holdReason !== 'BILLIARD_INTERRUPTION'
          || !['ACTIVE_CART_BACKUP', 'PAID_TOMBSTONE'].includes(String(restoredHold.payload?.restoreState || ''))
          || restoredHold.payload?.autoRestoreForCheckoutId !== restoredContext.checkoutId
          || !samePosSnapshotScope(restoredHold.payload.snapshot, currentPosSnapshotScope(getConfig()))
          || !isValidRestoredCartCheckoutJournal(restoredHold.payload?.restoredCheckout)
          || restoredHold.payload.restoredCheckout.orderId !== restoredContext.orderId
          || restoredHold.payload.restoredCheckout.clientAttemptId !== restoredContext.clientAttemptId
        )) {
          throw new Error('The restored cart does not match its durable interruption Hold.');
        }
        let restoredJournal: RestoredCartCheckoutJournal | null = null;
        if (restoredContext && restoredHold) {
          const durableJournal = restoredHold.payload.restoredCheckout;
          if (!isValidRestoredCartCheckoutJournal(durableJournal)) {
            throw new Error('The durable restored-cart payment identity is invalid.');
          }
          restoredJournal = durableJournal;
          const existingRestoredOrder = orderRepo.getById(durableJournal.orderId);
          if (existingRestoredOrder) {
            if (
              String(normalizedOrder.id || '') !== durableJournal.orderId
              || String(normalizedOrder.client_attempt_id || '') !== durableJournal.clientAttemptId
            ) {
              throw new Error('Restored-cart retry does not match its main-process payment identity.');
            }
            this.assertExistingRestoredCartOrder(durableJournal);
            const paidJournal: RestoredCartCheckoutJournal = {
              ...durableJournal,
              state: 'PAID_TOMBSTONE',
              paidAt: durableJournal.paidAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            holdOrderRepo.replaceProtected(restoredHold.id, restoredHold.title, {
              ...restoredHold.payload,
              restoreState: 'PAID_TOMBSTONE',
              restoredCheckout: paidJournal,
            });
            this.posStore?.dispatch({ type: 'cart/completeCheckout' });
            database.markDirty();
            const duplicateFlush = await database.saveCoalesced();
            if (!this.isPosAuthContextCurrent(orderAuthContext)) {
              return {
                success: false,
                id: durableJournal.orderId,
                paymentCommitted: true,
                error: 'POS user changed while the restored-cart order was being verified.',
              };
            }
            return duplicateFlush.success
              ? { success: true, id: durableJournal.orderId, duplicate: true, paymentCommitted: true }
              : {
                  success: false,
                  id: durableJournal.orderId,
                  paymentCommitted: true,
                  durabilityError: duplicateFlush.error || 'database flush failed',
                };
          }
          restoredJournal = this.assertRestoredCartOrderRequest(
            restoredContext,
            restoredHold.payload,
            normalizedOrder,
            normalizedItems,
          );
          tenderedRestoredCart = { holdId: restoredContext.holdId, orderId: restoredJournal.orderId };
        }
        if (billiardRecord && orderRepo.getById(billiardRecord.orderId)) {
          this.assertExistingBilliardOrder(billiardRecord);
          if (billiardRecord.state !== 'SETTLED') {
            billiardPosHandoffRepo.markState(billiardRecord.checkoutId, 'POS_PAID_SYNC_PENDING');
          }
          this.posStore?.markBilliardOrderCommitted(billiardRecord.checkoutId, billiardRecord.orderId);
          database.markDirty();
          const duplicateFlush = await database.saveCoalesced();
          if (!this.isPosAuthContextCurrent(orderAuthContext)) {
            return {
              success: false,
              id: billiardRecord.orderId,
              paymentCommitted: true,
              error: 'POS user changed while the Billiard order was being verified.',
            };
          }
          if (duplicateFlush.success) {
            this.finalizeBilliardCartAfterLocalCommit(billiardRecord);
            database.markDirty();
            await database.saveCoalesced();
          }
          return duplicateFlush.success
            ? { success: true, id: billiardRecord.orderId, duplicate: true, paymentCommitted: true }
            : {
                success: false,
                id: billiardRecord.orderId,
                paymentCommitted: true,
                durabilityError: duplicateFlush.error || 'database flush failed',
              };
        }
        if (billiardRecord) {
          // A new tender may open only while the exact frozen cart is active.
          this.resolveBilliardOrderRequest(normalizedOrder, normalizedItems, true);
          tenderedBilliardCart = { checkoutId: billiardRecord.checkoutId, orderId: billiardRecord.orderId };
        }
        if (requiresRegisterShift) {
          const activeShift = database.get<{ id: string; staff_id: string | null; staff_name: string | null }>(
            'SELECT id, staff_id, staff_name FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1',
          );
          const staffMissing = !String(normalizedOrder.staff_name || '').trim();
          const staffIdMissing = !String(normalizedOrder.staff_id || '').trim();
          const shiftMissing = !normalizedOrder.shift_id;
          if (activeShift && (staffMissing || shiftMissing || staffIdMissing)) {
            normalizedOrder.shift_id = activeShift.id;
            normalizedOrder.staff_id = activeShift.staff_id;
            normalizedOrder.staff_name = activeShift.staff_name;
          }
          const requestedShiftId = String(normalizedOrder.shift_id || '').trim();
          if (!requestedShiftId || !String(normalizedOrder.staff_id || '').trim() || !String(normalizedOrder.staff_name || '').trim()) {
            throw new Error('Cannot create POS order without an active shift staff. Close and reopen the shift before payment.');
          }
          const orderShift = database.get<{ id: string; staff_id: string | null; staff_name: string | null }>(
            'SELECT id, staff_id, staff_name FROM shifts WHERE id = ? AND closed_at IS NULL',
            [requestedShiftId],
          );
          if (!orderShift) {
            throw new Error('Cannot create POS order without a local active shift. Close and reopen the shift before payment.');
          }
          if (!String(orderShift.staff_id || '').trim() || !String(orderShift.staff_name || '').trim()) {
            throw new Error('Cannot create POS order without an active shift staff. Close and reopen the shift before payment.');
          }
          normalizedOrder.shift_id = orderShift.id;
          normalizedOrder.staff_id = orderShift.staff_id;
          normalizedOrder.staff_name = orderShift.staff_name;
        }

        const id = orderRepo.create(normalizedOrder, normalizedItems, (billiardRecord || restoredContext) ? {
          afterInsertInTransaction: () => {
            if (billiardRecord && !billiardPosHandoffRepo.markState(billiardRecord.checkoutId, 'POS_PAID_SYNC_PENDING')) {
              throw new Error('Could not commit the Billiard payment safety state.');
            }
            if (restoredContext && restoredHold && restoredJournal) {
              holdOrderRepo.replaceProtected(restoredContext.holdId, restoredHold.title, {
                ...restoredHold.payload,
                restoreState: 'PAID_TOMBSTONE',
                restoredCheckout: {
                  ...restoredJournal,
                  state: 'PAID_TOMBSTONE',
                  paidAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              });
            }
          },
        } : undefined);
        if (billiardRecord) {
          committedBilliardRecord = billiardRecord;
          // Renderer cannot forge this proof or use it to clear; it only
          // prevents any subsequent tender attempt while the disk barrier is
          // pending/uncertain.
          this.posStore?.markBilliardOrderCommitted(billiardRecord.checkoutId, billiardRecord.orderId);
        }
        if (restoredContext) committedRestoredOrderId = id;

        // Settle the cashier pickup queue if this paid sale came from a kitchen
        // self-order (loaded via the list or a QR scan). Fire-and-forget with a
        // durable outbox — must never block or fail the sale.
        const pickupOrderId = this.posStore?.getState()?.checkoutDraft?.kitchenSelfOrder?.pickupOrderId;
        if (pickupOrderId) {
          const posOrderNumber = String(normalizedOrder.order_number || normalizedOrder.orderNumber || '') || undefined;
          void settlePickupOrderForSale(pickupOrderId, id, posOrderNumber);
        }

        let stockChanged = false;
        const allowNegativeStock = getConfig().allowOversell === true;
        for (const item of normalizedItems) {
          // Billiard F&B stock was consumed when it was added to the session;
          // TIME/MISC are services. Payment must never deduct any of them a
          // second time. A normal POS line has no authoritative handoff.
          if (shouldDecrementStockAtCheckout(item, Boolean(billiardRecord))) {
            productRepo.decrementStock(item.variant_id, item.quantity, { allowNegative: allowNegativeStock });
            stockChanged = true;
          }
        }
        database.markDirty();
        if (stockChanged) {
          notifyPosRenderers(this.container, 'pos:products-synced');
        }

        // Path B: write to sync log for outbound push
        try {
          const syncLog = this.container.getOptional<SyncLogService>(SERVICE_TOKENS.SYNC_LOG_SERVICE);
          if (syncLog) {
            const PM: Record<string, string> = { CASH: 'CASH', CARD: 'CARD', BLIK: 'BLIK', TRANSFER: 'BANK_TRANSFER', BANK_TRANSFER: 'BANK_TRANSFER', CREDIT: 'CREDIT', INVOICE: 'BANK_TRANSFER' };
            const dto: Record<string, any> = {
              id,
              priceType: 'brutto',
              requiresInvoice: !!normalizedOrder.customer_nip,
              items: (normalizedItems || []).filter((i: any) => i.variant_id || i.id).map((i: any) => buildBackendOrderItem(i)),
            };
            if (normalizedOrder.payment_tenders) {
              try {
                const tenders = JSON.parse(normalizedOrder.payment_tenders) as Array<{ method: string; amount: number }>;
                if (tenders.length > 0) dto.tenders = tenders.map((t: any) => ({ method: PM[t.method] || t.method, amount: t.amount / 100 }));
              } catch { /* single method fallback below */ }
            }
            if (normalizedOrder.payment_method) dto.paymentMethod = PM[normalizedOrder.payment_method] || 'CASH';
            if (normalizedOrder.staff_id) dto.staffId = normalizedOrder.staff_id;
            if (normalizedOrder.staff_name) dto.staffName = normalizedOrder.staff_name;
            if (normalizedOrder.shift_id) dto.shiftId = normalizedOrder.shift_id;
            if (normalizedOrder.customer_id) dto.customerId = normalizedOrder.customer_id;
            if (normalizedOrder.customer_nip) dto.customerNip = normalizedOrder.customer_nip;
            if (normalizedOrder.customer_name) dto.customerName = normalizedOrder.customer_name;
            if (normalizedOrder.source) dto.source = normalizedOrder.source;
            if (normalizedOrder.order_type) dto.orderType = normalizedOrder.order_type;
            if (normalizedOrder.mode) dto.mode = normalizedOrder.mode;
            if (normalizedOrder.discount > 0) dto.discountAmount = normalizedOrder.discount / 100;
            if (normalizedOrder.payment_amount > 0) dto.paymentAmount = normalizedOrder.payment_amount / 100;
            if (normalizedOrder.change_amount > 0) dto.changeAmount = normalizedOrder.change_amount / 100;
            if (normalizedOrder.tip && normalizedOrder.tip > 0) dto.tip = normalizedOrder.tip / 100;
            if (billiardRecord) {
              dto.billiardOrigin = JSON.parse(normalizedOrder.billiard_origin_json);
              dto.clientAttemptId = billiardRecord.clientAttemptId;
            } else if (restoredJournal) {
              dto.clientAttemptId = restoredJournal.clientAttemptId;
            }
            syncLog.writeLocalEntry('order', id, 'created', dto);
            }
          } catch (e) { logger.debug('[PosModule] Sync log write failed for order:', e); }

          this.syncNailTurnCheckoutForOrder(id, normalizedOrder, normalizedItems).catch((e: any) => {
            logger.warn(`[PosModule] Nail turn checkout sync failed for order ${id}: ${e?.message ?? e}`);
          });

          // A paid order must be durable immediately — the 5s auto-save loop
          // leaves a window where a crash/power-cut loses an already-fiscalized
          // sale (same pattern as the check-in flush above). Don't fail the
          // sale if the flush fails: the order is committed in memory + sync
          // log, the auto-save loop retries, and db:save-error notifies the UI.
          const flush = await database.saveCoalesced();
          const authStillCurrent = this.isPosAuthContextCurrent(orderAuthContext);
          if (!flush.success) {
            logger.error(`[PosModule] Order ${id} created but disk flush failed: ${flush.error}`);
            if (billiardRecord || restoredContext) {
              if (restoredContext && authStillCurrent) {
                // sql.js contains the order + PAID_TOMBSTONE. Even if the
                // export failed, the last durable file is COMMITTING and will
                // reconcile rather than re-offer this cart after restart.
                this.posStore?.dispatch({ type: 'cart/completeCheckout' });
              }
              return {
                success: false,
                id,
                paymentCommitted: true,
                durabilityError: flush.error || 'database flush failed',
              };
            }
          } else if (billiardRecord && authStillCurrent) {
            // Only now may the frozen cart disappear. Restore the interrupted
            // cart and mark its Hold as the active durable backup in a second,
            // independently recoverable barrier.
            this.finalizeBilliardCartAfterLocalCommit(billiardRecord);
            database.markDirty();
            const cleanupFlush = await database.saveCoalesced();
            if (!cleanupFlush.success) {
              logger.error(`[PosModule] Order ${id} is durable but post-payment cart restore cleanup failed: ${cleanupFlush.error}`);
            }
          } else if (restoredContext && authStillCurrent) {
            // The order row and removal of its protected backup crossed the
            // same disk barrier. Clear the live cart now so an items-only
            // renderer cache cannot resurrect a paid order after a crash.
            this.posStore?.dispatch({ type: 'cart/completeCheckout' });
          }

          if (!authStillCurrent && (billiardRecord || restoredContext)) {
            return {
              success: false,
              id,
              paymentCommitted: true,
              error: 'POS user changed after the protected order commit. The original user can recover it after login.',
            };
          }

          return { success: true, id, paymentCommitted: Boolean(billiardRecord || restoredContext) };
      }
      catch (e: any) {
        if (committedBilliardRecord && orderRepo.getById(committedBilliardRecord.orderId)) {
          logger.error(`[PosModule] Billiard order ${committedBilliardRecord.orderId} committed before post-commit failure: ${e?.message || e}`);
          return {
            success: false,
            id: committedBilliardRecord.orderId,
            paymentCommitted: true,
            durabilityError: e?.message || String(e),
          };
        }
        if (committedRestoredOrderId && orderRepo.getById(committedRestoredOrderId)) {
          logger.error(`[PosModule] Restored-cart order ${committedRestoredOrderId} committed before post-commit failure: ${e?.message || e}`);
          return {
            success: false,
            id: committedRestoredOrderId,
            paymentCommitted: true,
            durabilityError: e?.message || String(e),
          };
        }
        if (tenderedBilliardCart && !orderRepo.getById(tenderedBilliardCart.orderId)) {
          const current = billiardPosHandoffRepo.get(tenderedBilliardCart.checkoutId);
          const marked = current?.state === 'POS_TENDER_UNCERTAIN'
            || billiardPosHandoffRepo.markTenderUncertain(tenderedBilliardCart.checkoutId);
          database.markDirty();
          const uncertainFlush = await database.saveCoalesced();
          const uncertainRecord = billiardPosHandoffRepo.get(tenderedBilliardCart.checkoutId);
          return {
            success: false,
            outcomeUncertain: true,
            intent: uncertainRecord ? this.billiardIntent(uncertainRecord, true) : undefined,
            durabilityError: marked && uncertainFlush.success
              ? undefined
              : uncertainFlush.error || 'Could not persist the uncertain Billiard tender state.',
            error: `Billiard payment outcome is uncertain. Do not charge again. ${e?.message || String(e)}`,
          };
        }
        if (tenderedRestoredCart) {
          const uncertain = await this.markRestoredCartTenderUncertain(
            tenderedRestoredCart.holdId,
            tenderedRestoredCart.orderId,
            orderAuthContext ?? undefined,
          );
          return {
            success: false,
            outcomeUncertain: true,
            restoredCartReconciliation: uncertain.reconciliation || undefined,
            durabilityError: uncertain.durabilityError,
            error: `Restored-cart payment outcome is uncertain. Do not charge again. ${e?.message || String(e)}`,
          };
        }
        // Idempotency: kiosk/POS retries reuse the same order id, so a retry
        // racing an already-committed create (whose IPC reply was lost) hits
        // the orders.id primary key. If the row truly exists, the sale was
        // saved — report success instead of pushing the cashier to retry
        // into a duplicate order.
        const orderId = String(order?.id || '');
        if (orderId && /UNIQUE constraint failed: orders\.id/i.test(String(e?.message || '')) && orderRepo.getById(orderId)) {
          logger.warn(`[PosModule] Order ${orderId} already exists — treating duplicate create as success`);
          return { success: true, id: orderId, duplicate: true };
        }
        return { success: false, error: e.message };
      }
    });
    ipcMain.handle('pos:orders:getDailyStats', (_e, date: string, options?: { fiscalOnly?: boolean }) => {
      return orderRepo.getDailyStats(date, Boolean(options?.fiscalOnly));
    });

    ipcMain.handle('pos:orders:getHistory', (_e, filters: { from: string; to: string; paymentMethod?: string; staffName?: string; page?: number; limit?: number; fiscalOnly?: boolean }) => {
      const limit = filters.limit || 20;
      const page = filters.page || 1;
      const fiscalOnly = Boolean(filters.fiscalOnly);

      const offset = (page - 1) * limit;
      const result = orderRepo.getByDateRange(filters.from, filters.to, limit, offset, {
        fiscalOnly,
        paymentMethod: filters.paymentMethod,
        staffName: filters.staffName,
      });
      return { orders: result.orders, total: result.total, page, limit };
    });

    // Order History fiscal-visibility: which of these order ids have a
    // confirmed paragon in the LOCAL fiscal journal. Server-sourced history
    // rows don't carry the SQL-computed has_fiscal flag — the renderer asks
    // here before applying the hide-non-fiscal filter.
    ipcMain.handle('pos:orders:getConfirmedFiscalIds', (_e, orderIds: string[]) => {
      try {
        const ids = Array.isArray(orderIds)
          ? orderIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 500)
          : [];
        return fiscalAttemptRepo.getConfirmedOrderIds(ids);
      } catch {
        return [];
      }
    });

    ipcMain.handle('pos:orders:getDetail', (_e, orderId: string) => {
      const order = orderRepo.getById(orderId);
      if (!order) return null;
      const items = orderRepo.getItemsByOrderId(orderId);
      return { order, items };
    });

    ipcMain.handle('pos:orders:deleteLocal', (_e, orderId: string) => {
      try {
        const result = orderRepo.deleteLocalUnsynced(orderId);
        if (!result.deleted) return { success: false, error: 'Order not found' };
        if (result.restocked > 0) {
          notifyPosRenderers(this.container, 'pos:products-synced');
        }
        return { success: true, restocked: result.restocked };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle('pos:orders:mutate', async (_e, orderId: string, data: any) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        const mutationId = data?.mutationId || randomUUID();

        if (!order.backend_id && order.synced !== 1) {
          if (data?.type === 'void') {
            const result = orderRepo.deleteLocalUnsynced(orderId);
            if (result.restocked > 0) notifyPosRenderers(this.container, 'pos:products-synced');
            return { success: result.deleted, restocked: result.restocked };
          }
          const result = orderRepo.updateLocalUnsynced(orderId, {
            paymentMethod: data?.paymentMethod,
            paymentAmount: data?.paymentAmount,
            changeAmount: data?.changeAmount,
            items: data?.items,
          });
          if (result.stockChanged) notifyPosRenderers(this.container, 'pos:products-synced');
          // ERP-AI outbox: an order created UNPAID and finalized via this path
          // never passed through the paid branch of orderRepo.create(). Emit now;
          // emitOrderFinalized is idempotent (dedupe_key) so a re-emit of an
          // already-emitted order is a no-op.
          if (result.updated) {
            const paidOrder = orderRepo.getById(orderId);
            if (paidOrder && (paidOrder.payment_method || paidOrder.payment_tenders)) {
              posEventEmitter.emitOrderFinalized(paidOrder, orderRepo.getItemsByOrderId(orderId));
            }
          }
          return { success: result.updated, localOnly: true };
        }

        if (!order.backend_id) return { success: false, error: 'Synced order is missing backend_id' };
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        const basePayload = {
          mutationId,
          expectedVersion: data?.expectedVersion,
          reason: data?.reason,
          terminalId: getConfigValue('agentId') || 'pos-device',
          clientTimestamp: new Date().toISOString(),
        };
        let response: any | null = null;

        if (data?.type === 'payment') {
          response = await apiClient.updateOrderPayment(token, order.backend_id, {
            ...basePayload,
            paymentMethod: data.paymentMethod,
            paidAmount: (Number(data.paymentAmount) || 0) / 100,
            changeAmount: (Number(data.changeAmount) || 0) / 100,
            tenders: [{ method: data.paymentMethod, amount: (Number(data.paymentAmount) || 0) / 100 }],
          });
        } else if (data?.type === 'items') {
          response = await apiClient.updateOrder(token, order.backend_id, {
            ...basePayload,
            items: (data.items || []).map((item: any) => ({
              orderItemId: item.id,
              variantId: item.variant_id,
              sku: item.sku,
              quantity: item.quantity,
              unitPrice: (Number(item.price) || 0) / 100,
              taxRate: item.vat_rate,
            })),
            paymentMethod: data.paymentMethod ?? order.payment_method,
            paidAmount: (Number(data.paymentAmount ?? order.payment_amount) || 0) / 100,
            changeAmount: (Number(data.changeAmount ?? order.change_amount) || 0) / 100,
          });
        } else if (data?.type === 'void') {
          response = await apiClient.voidOrder(token, order.backend_id, {
            ...basePayload,
            restock: data?.restock !== false,
          });
        } else {
          return { success: false, error: 'Unknown order mutation type' };
        }

        if (response === null) {
          return {
            success: false,
            error: 'Backend does not support this order history mutation yet. Server endpoints from the SCR must be deployed first.',
          };
        }

        const canonical = response.order ?? response;
        if (data?.type === 'payment') {
          database.run(
            'UPDATE orders SET payment_method = ?, payment_amount = ?, change_amount = ?, payment_tenders = ? WHERE id = ?',
            [
              canonical.paymentMethod ?? data.paymentMethod,
              Math.round(Number(canonical.paidAmount ?? data.paymentAmount / 100) * 100),
              Math.round(Number(canonical.changeAmount ?? data.changeAmount / 100) * 100),
              JSON.stringify([{ method: canonical.paymentMethod ?? data.paymentMethod, amount: Math.round(Number(canonical.paidAmount ?? data.paymentAmount / 100) * 100) }]),
              orderId,
            ],
          );
        } else if (data?.type === 'void') {
          database.run("UPDATE orders SET status = 'CANCELLED' WHERE id = ?", [orderId]);
        }
        database.markDirty();
        // ERP-AI outbox: a synced order paid via this mutation path. Idempotent
        // emit (no-op if create() already emitted it when paid).
        if (data?.type === 'payment') {
          const paidOrder = orderRepo.getById(orderId);
          if (paidOrder && (paidOrder.payment_method || paidOrder.payment_tenders)) {
            posEventEmitter.emitOrderFinalized(paidOrder, orderRepo.getItemsByOrderId(orderId));
          }
        }
        return { success: true, order: canonical, mutation: response.mutation ?? null };
      } catch (e: any) {
        logger.error(`[PosModule] Order mutation failed for ${orderId}: ${e.message}`);
        return { success: false, error: e.message };
      }
    });

    // Tables (restaurant mode)
    ipcMain.handle('pos:tables:getAll', () => tableRepo.getAll());
    ipcMain.handle('pos:tables:getActive', () => tableRepo.getActive());
    ipcMain.handle('pos:tables:updateStatus', (_e, id: string, status: string, orderId?: string) => { tableRepo.updateStatus(id, status, orderId); return { success: true }; });
    ipcMain.handle('pos:tables:clearTable', (_e, id: string) => { tableRepo.clear(id); return { success: true }; });
    ipcMain.handle('pos:tables:setCovers', (_e, id: string, covers: number) => { tableRepo.setCovers(id, covers); return { success: true }; });

    // Customers (B2B)
    ipcMain.handle('pos:customers:getAll', () => customerRepo.getAll());
    ipcMain.handle('pos:customers:search', (_e, query: string) => customerRepo.search(query));
    ipcMain.handle('pos:customers:getById', (_e, id: string) => customerRepo.getById(id));
    ipcMain.handle('pos:customers:increaseDebt', (_e, id: string, amount: number) => { customerRepo.increaseDebt(id, amount); return { success: true }; });
    ipcMain.handle(IPC_CHANNELS.POS_LOYALTY_LOOKUP_CUSTOMER, async (_e, phone: string): Promise<PosLoyaltyLookupIpcResult> => {
      const value = String(phone || '').trim();
      if (!value) return { success: false, error: 'phone_required' };

      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, unavailable: true, error: 'auth_required' };

        const result = await apiClient.getPosCustomerLoyalty(token, value);
        if (!result) return { success: false, unavailable: true, error: 'loyalty_unavailable' };
        return { success: true, result };
      } catch (e: any) {
        logger.warn(`[PosModule] POS loyalty lookup failed: ${e?.message ?? e}`);
        return { success: false, unavailable: true, error: e?.message ?? 'loyalty_lookup_failed' };
      }
    });

    // Staff
    ipcMain.handle('pos:staff:getAll', () => staffRepo.getAll());
    ipcMain.handle('pos:staff:getAllForSettings', () => staffRepo.getAllForSettings());
    ipcMain.handle('pos:staff:create', async (_e, input: { name: string; commissionRate?: number; role?: string | null; isActive?: boolean }) => {
      try {
        const sync = this.container.getOptional<StaffSync>(SERVICE_TOKENS.STAFF_SYNC);
        if (!sync) throw new Error('Staff sync is not initialized');
        const staff = await sync.createStaff(input);
        return { success: true, staff };
      } catch (e: any) {
        return { success: false, error: e?.message ?? 'Failed to create staff' };
      }
    });
    ipcMain.handle('pos:staff:update', async (_e, id: string, input: { name: string; commissionRate?: number; role?: string | null; isActive?: boolean }) => {
      try {
        const sync = this.container.getOptional<StaffSync>(SERVICE_TOKENS.STAFF_SYNC);
        if (!sync) throw new Error('Staff sync is not initialized');
        const staff = await sync.updateStaff(id, input);
        return { success: true, staff };
      } catch (e: any) {
        return { success: false, error: e?.message ?? 'Failed to update staff' };
      }
    });
    ipcMain.handle('pos:staff:setActive', async (_e, id: string, active: boolean) => {
      try {
        const sync = this.container.getOptional<StaffSync>(SERVICE_TOKENS.STAFF_SYNC);
        if (!sync) throw new Error('Staff sync is not initialized');
        const staff = await sync.setStaffActive(id, active);
        return { success: true, staff };
      } catch (e: any) {
        return { success: false, error: e?.message ?? 'Failed to update staff status' };
      }
    });

    // Nail turn board (backend-driven module; dark-launch safe)
    ipcMain.handle('pos:nail-turns:getToday', async () => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, unavailable: true, error: 'not_authenticated' };
        const board = await apiClient.getNailTurnBoard(token);
        if (!board) return { success: false, unavailable: true, error: 'nail_turns_unavailable' };
        return { success: true, board };
      } catch (e: any) {
        logger.warn(`[PosModule] Nail turn board fetch failed: ${e?.message ?? e}`);
        return { success: false, unavailable: true, error: e?.message ?? 'nail_turns_failed' };
      }
    });

    ipcMain.handle('pos:schedule:getToday', async (_e, date?: string) => {
      try {
        const result = await this.fetchPosScheduleToday(date);
        if (!result) {
          const cached = this.getScheduleCache(date);
          if (cached) return { success: true, schedule: cached, stale: true };
          return { success: false, unavailable: true, error: 'schedule_unavailable' };
        }
        const { schedule, authMode } = result;
        this.saveScheduleCache(schedule);
        logger.info(`[PosModule] POS schedule loaded for ${schedule.business_date}: staff=${schedule.staff?.length ?? 0} bookings=${schedule.bookings?.length ?? 0} auth=${authMode}`);
        return { success: true, schedule };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule fetch failed: ${e?.message ?? e}`);
        const cached = this.getScheduleCache(date);
        if (cached) return { success: true, schedule: cached, stale: true };
        return { success: false, unavailable: true, error: e?.message ?? 'schedule_failed' };
      }
    });

    ipcMain.handle('pos:schedule:getWeek', async (_e, from?: string, days?: number) => {
      try {
        const result = await this.fetchPosScheduleWeek(from, days || 7);
        if (!result) return { success: false, unavailable: true, error: 'schedule_unavailable' };
        const { week, authMode } = result;
        for (const schedule of week.schedules || []) {
          this.saveScheduleCache(schedule);
        }
        logger.info(`[PosModule] POS schedule week loaded from ${week.from}: days=${week.days} auth=${authMode}`);
        return { success: true, week };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule week fetch failed: ${e?.message ?? e}`);
        return { success: false, unavailable: true, error: e?.message ?? 'schedule_week_failed' };
      }
    });

    ipcMain.handle('pos:schedule:setStaffStatus', async (_e, payload: PosScheduleStaffStatusPayload) => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, unavailable: true, error: 'not_authenticated' };
        if (!payload?.staffProfileId || !payload.status) {
          return { success: false, error: 'invalid_staff_status_payload' };
        }
        const schedule = await apiClient.setPosScheduleStaffStatus(
          token,
          payload.staffProfileId,
          payload.status,
          payload.idempotencyKey,
        );
        if (!schedule) return { success: false, unavailable: true, error: 'schedule_unavailable' };
        this.saveScheduleCache(schedule);
        logger.info(`[PosModule] POS schedule staff status updated: staff=${payload.staffProfileId} status=${payload.status}`);
        return { success: true, schedule };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule staff status update failed: ${e?.message ?? e}`);
        return { success: false, error: e?.message ?? 'schedule_staff_status_failed' };
      }
    });

    ipcMain.handle('pos:schedule:assignNext', async (_e, payload: PosScheduleAssignNextPayload) => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, unavailable: true, error: 'not_authenticated' };
        if (!payload?.checkinLogId) return { success: false, error: 'invalid_assign_next_payload' };
        const schedule = await apiClient.assignPosScheduleNext(token, payload.checkinLogId, payload);
        if (!schedule) return { success: false, unavailable: true, error: 'schedule_unavailable' };
        this.saveScheduleCache(schedule);
        logger.info(`[PosModule] POS schedule assign-next completed: checkin=${payload.checkinLogId}`);
        return { success: true, schedule };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule assign-next failed: ${e?.message ?? e}`);
        return { success: false, error: e?.message ?? 'schedule_assign_next_failed' };
      }
    });

    ipcMain.handle('pos:schedule:requestStaff', async (_e, payload: PosScheduleRequestStaffPayload) => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, unavailable: true, error: 'not_authenticated' };
        if (!payload?.checkinLogId || !payload.staffProfileId) {
          return { success: false, error: 'invalid_request_staff_payload' };
        }
        const schedule = await apiClient.requestPosScheduleStaff(token, payload.checkinLogId, payload);
        if (!schedule) return { success: false, unavailable: true, error: 'schedule_unavailable' };
        this.saveScheduleCache(schedule);
        logger.info(`[PosModule] POS schedule request-staff completed: checkin=${payload.checkinLogId} staff=${payload.staffProfileId}`);
        return { success: true, schedule };
      } catch (e: any) {
        logger.warn(`[PosModule] POS schedule request-staff failed: ${e?.message ?? e}`);
        return { success: false, error: e?.message ?? 'schedule_request_staff_failed' };
      }
    });

    // Hold orders — SQLite is canonical. Every destructive transition waits
    // for a disk barrier before the live cart is cleared/replaced.
    ipcMain.handle('pos:hold:create-current', async (_e, id: string, title: string) => {
      try {
        if (!this.posStore) return { success: false, error: 'POS is not ready.' };
        const state = this.posStore.getState();
        if (state.cart.items.length === 0) return { success: false, error: 'Cart is empty.' };
        if (state.checkoutDraft.billiard) return { success: false, error: 'Frozen Billiard checkout cannot be held.' };
        if (state.checkoutDraft.kitchenSelfOrder?.pickupOrderId) {
          return { success: false, error: 'Active kitchen pickup cannot be held.' };
        }
        const scope = currentPosSnapshotScope(getConfig());
        const authContext = this.capturePosAuthContext(scope);
        const restored = state.checkoutDraft.restoredInterruption;
        const protectedHold = restored ? holdOrderRepo.get(restored.holdId) : null;
        if (restored && (
          !protectedHold
          || protectedHold.payload?.protected !== true
          || protectedHold.payload?.restoreState !== 'ACTIVE_CART_BACKUP'
          || !isValidRestoredCartCheckoutJournal(protectedHold.payload?.restoredCheckout)
          || !sameRestoredCartCheckoutIdentity(restored, protectedHold.payload.restoredCheckout)
          || protectedHold.payload.restoredCheckout.state !== 'READY'
          || this.frozenRestoredCartHolds.has(restored.holdId)
        )) {
          return { success: false, error: 'This restored cart is not in a safe state to hold.' };
        }
        const captured = capturePosCheckoutSnapshot(state, scope, String(getConfig().posMode || 'retail'));
        const payload: PosHoldPayload = {
          schemaVersion: POS_CHECKOUT_SNAPSHOT_VERSION,
          holdReason: 'MANUAL',
          protected: false,
          snapshot: withoutRestoredInterruptionMarker(captured),
        };
        database.transaction(() => {
          holdOrderRepo.upsert(id, title, payload);
          if (restored) holdOrderRepo.remove(restored.holdId, true);
          holdOrderRepo.prune();
        });
        database.markDirty();
        const flush = await database.saveCoalesced();
        if (!flush.success) {
          // Restore in-memory ownership to match the still-live cart. The old
          // on-disk protected row also remains authoritative after this failed
          // barrier.
          try {
            holdOrderRepo.remove(id);
            if (restored && protectedHold) {
              holdOrderRepo.upsert(restored.holdId, protectedHold.title, protectedHold.payload);
            }
            database.markDirty();
            void database.saveCoalesced();
          } catch {}
          return { success: false, error: flush.error || 'Held cart was not saved.' };
        }
        if (!this.isPosAuthContextCurrent(authContext)) {
          return { success: false, error: 'POS user changed after the Hold was saved; the old user can recall it after login.' };
        }
        this.posStore.dispatch({ type: 'cart/clear' });
        // A protected interruption backup may have been waiting behind this
        // ordinary cart since startup. As soon as the ordinary cart is safely
        // held, restore that backup in the same UX flow—no app restart needed.
        const protectedRecovery = this.recoverProtectedBilliardInterruptionCart();
        if (protectedRecovery.restored) {
          database.markDirty();
          const recoveryFlush = await database.saveCoalesced();
          if (!this.isPosAuthContextCurrent(authContext)) {
            return { success: false, restoredProtectedCart: false, error: 'POS user changed during protected-cart recovery.' };
          }
          return {
            success: true,
            restoredProtectedCart: true,
            recoveryDurabilityError: recoveryFlush.success ? undefined : recoveryFlush.error,
          };
        }
        return { success: true, recoveryError: protectedRecovery.error };
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:hold:import-legacy', async (_e, rows: unknown) => {
      try {
        if (!this.posStore) return { success: false, error: 'POS is not ready.' };
        if (!Array.isArray(rows)) return { success: false, error: 'Legacy held carts are malformed.' };
        const scope = currentPosSnapshotScope(getConfig());
        const currentState = this.posStore.getState();
        const posMode = String(getConfig().posMode || 'retail');
        const imports: ReturnType<typeof buildLegacyHeldCartImport>[] = [];
        const errors: string[] = [];
        rows.forEach((raw, index) => {
          try {
            imports.push(buildLegacyHeldCartImport({
              raw: raw as any,
              index,
              currentState,
              scope,
              posMode,
            }));
          } catch (error: any) {
            errors.push(error?.message || `Legacy held cart ${index + 1} is invalid`);
          }
        });
        let imported = 0;
        let skipped = 0;
        database.transaction(() => {
          for (const entry of imports) {
            if (holdOrderRepo.get(entry.id)) {
              skipped++;
              continue;
            }
            holdOrderRepo.upsert(entry.id, entry.title, entry.payload);
            imported++;
          }
          // Deliberately no prune here: rollout migration must not discard
          // either an imported cart or a pre-existing durable Hold.
        });
        if (imported > 0) {
          database.markDirty();
          const flush = await database.saveCoalesced();
          if (!flush.success) {
            return {
              success: false,
              imported,
              skipped,
              errors,
              error: flush.error || 'Legacy held carts were not made durable.',
            };
          }
        }
        return {
          success: errors.length === 0,
          imported,
          skipped,
          errors,
          error: errors.length > 0 ? 'Some legacy held carts could not be imported.' : undefined,
        };
      } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
      }
    });
    ipcMain.handle('pos:hold:recall', async (_e, id: string) => {
      try {
        if (!this.posStore) return { success: false, error: 'POS is not ready.' };
        if (this.holdRecallInFlight) {
          return { success: false, error: 'Another held cart recall is still being saved.' };
        }
        if (this.posStore.getState().cart.items.length > 0) {
          return { success: false, error: 'Hold the current cart before recalling another one.' };
        }
        const held = holdOrderRepo.get(id);
        const scope = currentPosSnapshotScope(getConfig());
        const authContext = this.capturePosAuthContext(scope);
        if (!held?.payload?.snapshot || !samePosSnapshotScope(held.payload.snapshot, scope)) {
          return { success: false, error: 'Held cart does not belong to this salon, user, and register.' };
        }
        if (held.payload.protected === true) {
          return { success: false, error: 'This protected Billiard interruption cart is restored automatically after payment.' };
        }
        if (held.payload.snapshot.posMode !== String(getConfig().posMode || 'retail')) {
          return { success: false, error: `Switch POS to ${held.payload.snapshot.posMode} mode before recalling this cart.` };
        }
        const beforeSnapshot = capturePosCheckoutSnapshot(
          this.posStore.getState(),
          scope,
          String(getConfig().posMode || 'retail'),
        );
        const pendingSnapshot = JSON.parse(JSON.stringify(held.payload.snapshot));
        pendingSnapshot.state.checkoutDraft = {
          ...(pendingSnapshot.state.checkoutDraft || {}),
          holdRecallPending: { holdId: held.id },
        };
        const recallOwner = { holdId: held.id, authContext };
        this.holdRecallInFlight = recallOwner;
        try {
          this.posStore.dispatch({
            type: 'state/replaceCheckoutSnapshot',
            payload: { snapshot: pendingSnapshot },
          });
          holdOrderRepo.remove(id);
          database.markDirty();
          const flush = await database.saveCoalesced();
          if (!flush.success) {
            holdOrderRepo.upsert(held.id, held.title, held.payload);
            if (this.isPosAuthContextCurrent(authContext)) {
              this.posStore.dispatch({
                type: 'state/replaceCheckoutSnapshot',
                payload: { snapshot: beforeSnapshot },
              });
            }
            database.markDirty();
            const rollbackFlush = await database.saveCoalesced();
            return {
              success: false,
              error: flush.error || 'Held cart recall was not saved; live cart was rolled back.',
              rollbackDurabilityError: rollbackFlush.success ? undefined : rollbackFlush.error,
            };
          }
          if (!this.isPosAuthContextCurrent(authContext)) {
            holdOrderRepo.upsert(held.id, held.title, held.payload);
            database.markDirty();
            const authRollbackFlush = await database.saveCoalesced();
            return {
              success: false,
              error: 'POS user changed during Hold recall; the held cart was restored instead of opening it in another account.',
              rollbackDurabilityError: authRollbackFlush.success ? undefined : authRollbackFlush.error,
            };
          }
          this.posStore.dispatch({
            type: 'state/replaceCheckoutSnapshot',
            payload: { snapshot: held.payload.snapshot },
          });
          return { success: true };
        } finally {
          if (this.holdRecallInFlight === recallOwner) this.holdRecallInFlight = null;
        }
      } catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:hold:create', () => ({ success: false, error: 'Use createCurrent for durable Hold.' }));
    ipcMain.handle('pos:hold:list', () => {
      try {
        const scope = currentPosSnapshotScope(getConfig());
        return holdOrderRepo.list().filter((row) => {
          const held = holdOrderRepo.get(row.id);
          return held?.payload?.protected !== true
            && !!held?.payload?.snapshot
            && samePosSnapshotScope(held.payload.snapshot, scope);
        });
      } catch { return []; }
    });
    ipcMain.handle('pos:hold:get', (_e, id: string) => {
      try {
        const held = holdOrderRepo.get(id);
        const scope = currentPosSnapshotScope(getConfig());
        return held?.payload?.snapshot && samePosSnapshotScope(held.payload.snapshot, scope) ? held : null;
      } catch { return null; }
    });
    ipcMain.handle('pos:hold:remove', async (_e, id: string) => {
      try {
        if (this.holdRecallInFlight) {
          return { success: false, error: 'Wait for the active held cart recall to finish.' };
        }
        const held = holdOrderRepo.get(id);
        const scope = currentPosSnapshotScope(getConfig());
        const authContext = this.capturePosAuthContext(scope);
        if (!held?.payload?.snapshot || !samePosSnapshotScope(held.payload.snapshot, scope)) {
          return { success: false, error: 'Held cart not found on this register.' };
        }
        holdOrderRepo.remove(id);
        database.markDirty();
        const flush = await database.saveCoalesced();
        if (!flush.success) {
          holdOrderRepo.upsert(held.id, held.title, held.payload);
          database.markDirty();
          const rollbackFlush = await database.saveCoalesced();
          return {
            success: false,
            error: flush.error || 'Held cart deletion was not saved.',
            rollbackDurabilityError: rollbackFlush.success ? undefined : rollbackFlush.error,
          };
        }
        if (!this.isPosAuthContextCurrent(authContext)) {
          holdOrderRepo.upsert(held.id, held.title, held.payload);
          database.markDirty();
          const authRollbackFlush = await database.saveCoalesced();
          return {
            success: false,
            error: 'POS user changed while the held cart was being removed; deletion was rolled back.',
            rollbackDurabilityError: authRollbackFlush.success ? undefined : authRollbackFlush.error,
          };
        }
        return { success: true };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    // Quick keys
    ipcMain.handle('pos:quickkeys:list', (_e, mode?: string) => quickKeyLayoutRepo.list(mode));
    ipcMain.handle('pos:quickkeys:get', (_e, id: string) => quickKeyLayoutRepo.get(id));
    ipcMain.handle('pos:quickkeys:create', (_e, id: string, data: any) => {
      try { quickKeyLayoutRepo.create(id, data); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:quickkeys:update', (_e, id: string, data: any) => {
      try { quickKeyLayoutRepo.update(id, data); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:quickkeys:remove', (_e, id: string) => { quickKeyLayoutRepo.remove(id); database.markDirty(); return { success: true }; });
    ipcMain.handle('pos:quickkeys:assign', (_e, regId: string, mode: string, layoutId: string) => {
      try { quickKeyLayoutRepo.assign(regId, mode, layoutId); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('pos:quickkeys:getAssigned', (_e, regId: string, mode: string) => quickKeyLayoutRepo.getAssigned(regId, mode));

    // Checkin
    ipcMain.handle('checkin:getToday', () => checkinRepo.getToday());
    ipcMain.handle('checkin:getByDate', (_e, date: string) => checkinRepo.getByDate(date));
    ipcMain.handle('checkin:create', (_e, data: any) => {
      try { checkinRepo.create(data); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:updateStatus', (_e, id: string, status: string) => {
      try { checkinRepo.updateStatus(id, status); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:startService', (_e, id: string) => {
      try { checkinRepo.startService(id); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:complete', (_e, id: string) => {
      try { checkinRepo.complete(id); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:markNoShow', (_e, id: string) => {
      try { checkinRepo.markNoShow(id); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:searchPhone', (_e, phone: string) => checkinRepo.searchByPhone(phone));
    ipcMain.handle('checkin:addUpsells', (_e, id: string, upsells: string[]) => {
      try { checkinRepo.addUpsells(id, JSON.stringify(upsells)); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:updateNotes', (_e, id: string, notes: string) => {
      try { checkinRepo.updateNotes(id, notes); database.markDirty(); return { success: true }; }
      catch (e: any) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('checkin:getStats', (_e, date?: string) => checkinRepo.getStats(date));

    // Customer display: phone search
    ipcMain.handle('display:search-by-phone', (e, phone: string) => {
      if (!this.allowCustomerDisplayIpc(e, 'display:search-by-phone', 'salon_checkin')) {
        return { customers: [], bookings: [], error: 'display_ipc_not_allowed' };
      }

      // Validate phone input: must be digits only, at least 3 characters
      const sanitized = (phone || '').replace(/\D/g, '');
      if (sanitized.length < 3) return { customers: [], bookings: [] };

      const booksySync = this.container.getOptional(SERVICE_TOKENS.BOOKSY_SYNC) as any;
      const customers = booksySync?.getCustomers?.() || [];
      const matched = customers.filter((c: any) => c.cell_phone?.includes(sanitized)).slice(0, 20);
      if (!matched.length) return { customers: [], bookings: [] };
      const bookings = booksySync?.getBookings?.() || [];
      const names = new Set(matched.map((c: any) => c.full_name));
      return { customers: matched, bookings: bookings.filter((b: any) => names.has(b.customerName)) };
    });

    // Payment & shift
    ipcMain.handle('pos:print-receipt', async (_e, orderId: string) => {
      try { const printed = await this.paymentController?.printReceipt(orderId); return { success: true, receiptPrinted: printed ?? false }; }
      catch (e: any) { return { success: false, receiptPrinted: false, error: e.message }; }
    });

    ipcMain.handle('pos:print-receipt-and-open-drawer', async (_e, orderId: string) => {
      try {
        const result = await this.paymentController?.printReceiptAndOpenDrawer(orderId);
        return {
          success: true,
          receiptPrinted: result?.receiptPrinted ?? false,
          drawerOpened: result?.drawerOpened ?? false,
          error: result?.error,
        };
      } catch (e: any) {
        return { success: false, receiptPrinted: false, drawerOpened: false, error: e.message };
      }
    });

    ipcMain.handle('pos:print-fiscal-receipt', async (_e, orderId: string) => {
      try { const printed = await this.paymentController?.printFiscalReceipt(orderId); return { success: true, fiscalPrinted: printed ?? false }; }
      catch (e: any) { return { success: false, fiscalPrinted: false, error: e.message }; }
    });

    ipcMain.handle('pos:has-fiscal-printer', async () => {
      const status = await (this.paymentController?.hasFiscalPrinter?.() ?? Promise.resolve({ configured: false, connected: false }));
      return { success: true, ...status };
    });

    ipcMain.handle('pos:payment:preflight', async (_e, orderId: string) => {
      try {
        const prepared = await this.prepareOrdinaryPosPayment(orderId);
        return { success: true, ...prepared };
      } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
      }
    });

    // Surface a fiscal attempt stuck in UNKNOWN_NEEDS_RECONCILIATION so the UI
    // can offer the operator a reconcile action instead of a permanently
    // blocked reprint.
    ipcMain.handle('pos:fiscal:get-reconcilable', async (_e, orderId: string) => {
      try {
        const attempt = fiscalAttemptRepo.findReconcilableAttempt(orderId);
        return { success: true, attempt: attempt ?? null };
      } catch (e: any) {
        return { success: false, attempt: null, error: e?.message ?? String(e) };
      }
    });

    // Operator-confirmed resolution after they checked the physical printer.
    // didPrint=true → mark SUCCESS_CONFIRMED (already fiscalized, no reprint).
    // didPrint=false → mark FAILED_CONFIRMED, clearing the gate so the cashier
    // can print a fresh fiscal receipt.
    ipcMain.handle('pos:fiscal:reconcile', async (_e, orderId: string, didPrint: boolean) => {
      try {
        const resolved = fiscalAttemptRepo.resolveReconcilable(orderId, !!didPrint);
        if (!resolved) return { success: false, error: 'No unresolved fiscal attempt for this order' };
        const flush = await fiscalAttemptRepo.flush();
        if (!flush.success) {
          // Never acknowledge an operator resolution that only exists in
          // memory. Restore the blocking UNKNOWN state so this process cannot
          // reprint while the durable database still disagrees.
          fiscalAttemptRepo.markUnknown(resolved.id, 'RECONCILIATION_DURABILITY_FAILED', {
            requestedDidPrint: !!didPrint,
            error: flush.error || 'database flush failed',
          });
          await fiscalAttemptRepo.flush().catch(() => ({ success: false }));
          return {
            success: false,
            error: `Fiscal reconciliation was not saved: ${flush.error || 'database flush failed'}`,
          };
        }
        logger.info(`[PosModule] Fiscal attempt ${resolved.id} for order ${orderId} reconciled by operator: didPrint=${!!didPrint} → ${resolved.status}`);
        return { success: true, status: resolved.status };
      } catch (e: any) {
        return { success: false, error: e?.message ?? String(e) };
      }
    });

    // Print journal (which printer printed each order copy) + latest fiscal
    // attempt — Order History reads both to render per-document badges.
    ipcMain.handle('pos:print-attempts:get-by-order', async (_e, orderId: string) => {
      try {
        return { success: true, attempts: printAttemptRepo.findByOrder(orderId) };
      } catch (e: any) {
        return { success: false, attempts: [], error: e?.message ?? String(e) };
      }
    });

    ipcMain.handle('pos:fiscal:get-latest', async (_e, orderId: string) => {
      try {
        const cfg = getConfig();
        const fp = (cfg.printers as Record<string, any> | undefined)?.[PrinterType.FISCAL];
        const printer = fp
          ? { name: fp.displayName || fp.protocol || 'Fiscal', target: fp.port || fp.address || null }
          : null;
        return { success: true, attempt: fiscalAttemptRepo.findLatestByOrder(orderId) ?? null, printer };
      } catch (e: any) {
        return { success: false, attempt: null, printer: null, error: e?.message ?? String(e) };
      }
    });

    // One reprint per order at a time — POS2 cashiers hammered the button
    // while a remote job was still pending (2026-07-06) and every extra
    // attempt piled errors on top of a job that was already printing.
    const reprintsInFlight = new Set<string>();
    ipcMain.handle('pos:reprint-receipt', async (_e, orderId: string) => {
      if (reprintsInFlight.has(orderId)) {
        return { success: false, receiptPrinted: false, error: 'Reprint already in progress for this order' };
      }
      reprintsInFlight.add(orderId);
      try { const printed = await this.paymentController?.reprintReceipt(orderId); return { success: true, receiptPrinted: printed ?? false }; }
      catch (e: any) { return { success: false, receiptPrinted: false, error: e.message }; }
      finally { reprintsInFlight.delete(orderId); }
    });

    ipcMain.handle('pos:print-refund-receipt', async (_e, orderId: string) => {
      try { const printed = await this.paymentController?.printRefundReceipt(orderId); return { success: true, receiptPrinted: printed ?? false }; }
      catch (e: any) { return { success: false, receiptPrinted: false, error: e.message }; }
    });

    ipcMain.handle('pos:orders:refund', async (_e, orderId: string, data: RefundIpcPayload) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };
        if (order.status === 'REFUNDED') return { success: false, error: 'Order already fully refunded' };
        const refundRequestId = String(data?.refundRequestId || '').trim();
        if (!UUID_RE.test(refundRequestId)) {
          return { success: false, error: 'A stable refund request ID is required before refunding.' };
        }
        data = { ...data, refundRequestId };
        const refundScope = currentPosSnapshotScope(getConfig());
        const refundAuthContext = this.capturePosAuthContext(refundScope);
        if (order.status === 'PARTIAL_REFUND') {
          const alreadyRefunded = order.refund_amount ?? 0;
          const requestedAmount = data.type === 'FULL'
            ? order.total - alreadyRefunded
            : (data.lines ?? []).reduce((s, l) => s + l.refundAmount, 0);
          if (alreadyRefunded + requestedAmount > order.total) {
            return { success: false, error: `Refund would exceed order total (${order.total} grosze). Already refunded: ${alreadyRefunded}` };
          }
        }
        if (order.billiard_origin_json) {
          const sanitized = sanitizeBilliardRefundRequest({
            data,
            orderItems: orderRepo.getItemsByOrderId(orderId),
            refundLinesJson: order.refund_lines,
            alreadyRefundedGrosze: order.refund_amount,
          });
          data = {
            ...data,
            amount: sanitized.amountGrosze,
            lines: sanitized.lines,
            // Main derives tender allocation from the committed sale. A
            // renderer cannot redirect or inflate a Billiard refund tender.
            tenderAllocations: undefined,
            manualAdjustmentAmount: undefined,
          };
        }

        const activeShift = database.get<{ id: string; backend_id: string | null; staff_id: string | null }>(
          'SELECT id, backend_id, staff_id FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1',
        );
        if (!activeShift) return { success: false, error: 'Cannot refund without an active shift. Open a shift first.' };

        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        // Older app versions consumed open-shift responses as `{ shiftId }`
        // even though the backend returns `{ id }`, leaving backend_id NULL.
        // Reconcile that legacy active row once before posting the refund.
        let backendShiftId = activeShift.backend_id;
        if (!backendShiftId) {
          try {
            const configuredMachineId = String(getConfigValue('machineId') ?? '').trim();
            const serverShift = configuredMachineId
              ? await apiClient.getActiveShift(token, configuredMachineId)
              : null;
            if (!this.isPosAuthContextCurrent(refundAuthContext)) {
              return { success: false, requiresRefresh: true, error: 'POS user changed before the refund was submitted.' };
            }
            if (serverShift?.id === activeShift.id) {
              backendShiftId = serverShift.id;
              database.run(
                'UPDATE shifts SET backend_id = ?, synced = 1, sync_error = NULL WHERE id = ? AND backend_id IS NULL',
                [backendShiftId, activeShift.id],
              );
              database.markDirty();
            }
          } catch (error: any) {
            logger.warn(`[PosModule] Active shift reconciliation before refund skipped: ${error?.message ?? error}`);
          }
        }

        // Convert line amounts from grosze → PLN for backend
        const lines = (data.lines ?? []).map(l => ({
          variantId: l.variantId,
          sku: l.sku,
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice / 100,
          refundAmount: l.refundAmount / 100,
          restock: l.restock,
          vatRate: l.vatRate,
        }));

        const alreadyRefundedGrosze = order.refund_amount ?? 0;
        const requestedAmountGrosze = data.type === 'FULL'
          ? order.total - alreadyRefundedGrosze
          : data.amount ?? (data.lines ?? []).reduce((sum, l) => sum + l.refundAmount, 0);
        if (requestedAmountGrosze <= 0) {
          return { success: false, error: 'No refundable amount remains for this order' };
        }
        if (alreadyRefundedGrosze + requestedAmountGrosze > order.total) {
          return { success: false, error: `Refund would exceed order total (${order.total} grosze). Already refunded: ${alreadyRefundedGrosze}` };
        }
        const refundPayload: RefundIpcPayload = {
          ...data,
          tenderAllocations: data.tenderAllocations?.length
            ? data.tenderAllocations
            : allocateRefundTenders(order.payment_tenders, requestedAmountGrosze, order.payment_method),
        };
        const backendPayload = toRefundBackendPayload(refundPayload, {
          shiftId: backendShiftId ?? activeShift.id,
        });
        const hasLineRefund = (data.lines ?? []).length > 0;
        const hasRestock = (data.lines ?? []).some(l => l.restock);

        logger.info(`[PosModule] Refund ${order.order_number}: ${data.type}, ${lines.length} lines, payload=${JSON.stringify(backendPayload).substring(0, 300)}`);

        if (!this.isPosAuthContextCurrent(refundAuthContext)) {
          return { success: false, requiresRefresh: true, error: 'POS user changed before the refund was submitted.' };
        }
        const result = await apiClient.refundOrder(token, order.backend_id, backendPayload);
        if (result === null) return { success: false, error: 'Refund endpoint not available' };

        const summary = getRefundBackendResponseSummary(result);
        logger.info(
          `[PosModule] Refund backend response ${order.order_number}: ` +
          `status=${summary.status ?? 'unknown'} refundAmount=${summary.refundAmount ?? 'null'} ` +
          `refundedLines.length=${summary.refundedLinesLength} stockMovementIds.length=${summary.stockMovementIdsLength}`,
        );
        const expectedDeltaGroszeCandidates = getRefundExpectedDeltaCandidates(data, requestedAmountGrosze, order);
        const validation = validateRefundBackendResponse(result, {
          type: data.type,
          requestedAmountGrosze,
          orderTotalGrosze: order.total,
          alreadyRefundedGrosze,
          requireRefundedLines: hasLineRefund,
          requireStockMovement: hasRestock,
          expectedDeltaGroszeCandidates,
        });
        if (!validation.ok) {
          const error = buildRefundMutationError(validation);
          logger.error(
            `[PosModule] Refund backend response incomplete for ${order.order_number}: ${error}. ` +
            `summary=${JSON.stringify(validation.summary)}`,
          );
          if (validation.mutationDetected) {
            lockRefundMutationLocally(orderId, order, validation, error, data.reason);
            database.markDirty();
            const mutationLockFlush = await database.saveCoalesced();
            return {
              success: false,
              mutationDetected: true,
              requiresRefresh: true,
              overRefund: validation.overRefund,
              refundRequestId,
              durabilityError: mutationLockFlush.success ? undefined : mutationLockFlush.error,
              error: mutationLockFlush.success
                ? error
                : `${error} The local reconciliation lock could not be saved; do not retry with a new request ID.`,
              backendSummary: validation.summary,
            };
          }
          return { success: false, error, backendSummary: validation.summary };
        }

        // Update local DB from backend response
        const refundedAmount = validation.refundedAmountGrosze ?? 0;
        const status = result.status === 'REFUNDED' ? 'FULL' : 'PARTIAL';
        const refundReason = result.refundReason || data.reason || '';
        const refundOccurredAt = new Date().toISOString();
        const refundMethods = Array.from(new Set(
          (refundPayload.tenderAllocations ?? [])
            .map((allocation) => allocation.method)
            .filter((method): method is string => Boolean(method)),
        ));
        const refundMethod = refundMethods.length > 1
          ? 'SPLIT'
          : refundMethods[0] || order.payment_method || undefined;
        const backendRefundLinesJson = normalizeRefundLinesJson(result.refundedLines);
        const deltaRefundLines = backendRefundLinesJson
          ? JSON.parse(backendRefundLinesJson).map((line: any) => ({
              ...line,
              refundedAt: line.refundedAt || refundOccurredAt,
              refundRequestId: line.refundRequestId || data.refundRequestId,
              reason: line.reason || refundReason,
              refundMethod: line.refundMethod || refundMethod,
            }))
          : [];
        const cumulativeRefundLines = mergeRefundLines(order.refund_lines, deltaRefundLines);
        orderRepo.markRefunded(orderId, refundedAmount, refundReason, status, cumulativeRefundLines.length > 0 ? cumulativeRefundLines : undefined);
        database.markDirty();

        // ERP-AI outbox: emit the DELTA of this refund (not cumulative total).
        posEventEmitter.emitRefundIssued({
          localOrderId: orderId,
          backendOrderId: order.backend_id,
          amountMinor: validation.refundAmountGrosze ?? requestedAmountGrosze,
          method: order.payment_method,
          tenderAllocations: refundPayload.tenderAllocations,
          reason: refundReason,
          refundRequestId: data.refundRequestId,
          refundedAt: refundOccurredAt,
          shiftId: activeShift.id,
          items: deltaRefundLines,
        });
        database.markDirty();
        const refundFlush = await database.saveCoalesced();
        if (!refundFlush.success) {
          return {
            success: false,
            mutationDetected: true,
            requiresRefresh: true,
            refundRequestId,
            durabilityError: refundFlush.error || 'database flush failed',
            error: 'Refund completed on the server, but its local audit was not made durable. Do not pay out or retry with a new request ID; reconcile this refund.',
          };
        }
        if (!this.isPosAuthContextCurrent(refundAuthContext)) {
          return {
            success: false,
            mutationDetected: true,
            requiresRefresh: true,
            refundRequestId,
            error: 'Refund is durably recorded, but the POS user changed. Do not open the drawer or pay out from the new session; refresh as the original user.',
          };
        }

        // Print refund receipt
        let receiptPrinted = false;
        try {
          receiptPrinted = await this.paymentController?.printRefundReceipt(orderId, {
            amount: validation.refundAmountGrosze ?? refundedAmount,
            lines: deltaRefundLines,
            reason: refundReason,
          }) ?? false;
        } catch (e: any) {
          logger.warn(`[PosModule] Refund receipt print failed: ${e.message}`);
        }

        if (order.payment_method === 'CASH') {
          try { await this.paymentController?.openCashDrawer(); } catch {}
        }

        // Trigger product sync to refresh stock after restock
        if (lines.some(l => l.restock)) {
          const productSync = this.container.getOptional<any>(SERVICE_TOKENS.PRODUCT_SYNC);
          if (productSync) {
            try { await productSync.deltaSync(); } catch {}
          }
        }

        logger.info(`[PosModule] Order ${order.order_number} refunded: ${data.type}, backend status=${result.status}`);
        const { success: _s, ...rest } = result;
        return { success: true, receiptPrinted, ...rest };
      } catch (e: any) {
        // Surface the real cause: refund failures were logging only e.message,
        // which is empty for non-Error throws and opaque network/runtime faults,
        // making "Refund failed" undiagnosable. Capture name/code/cause/stack.
        const detail =
          e?.message
          || e?.code
          || e?.cause?.message
          || e?.cause?.code
          || e?.name
          || (typeof e === 'string' ? e : '');
        const surfaced = detail || 'Unknown refund error';
        logger.error(
          `[PosModule] Refund failed for order ${orderId}: ${surfaced}`
          + ` (name=${e?.name ?? 'n/a'} code=${e?.code ?? 'n/a'} cause=${e?.cause?.code ?? e?.cause?.message ?? 'n/a'})`,
        );
        if (e?.stack) logger.error(`[PosModule] Refund failure stack: ${e.stack}`);
        return { success: false, error: surfaced };
      }
    });

    ipcMain.handle('pos:orders:billiard-correction', async (_e, orderId: string, data: {
      correctionRequestId?: string;
      reason?: string;
    }) => {
      try {
        const config = getConfig();
        if (String(config.authUser?.role || '').toUpperCase() !== 'OWNER') {
          return { success: false, code: 'BILLIARD_CORRECTION_OWNER_REQUIRED', error: 'Only the salon owner can correct a paid Billiard order.' };
        }
        const correctionScope = currentPosSnapshotScope(config);
        const correctionAuthContext = this.capturePosAuthContext(correctionScope);

        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id || order.synced !== 1) {
          return { success: false, error: 'The Billiard order must finish syncing before owner correction.' };
        }
        if (!order.billiard_origin_json) {
          return { success: false, error: 'Owner Billiard correction is only available for Billiard POS orders.' };
        }
        if (order.customer_nip) {
          return {
            success: false,
            code: 'BILLIARD_CORRECTION_INVOICE_BLOCKED',
            error: 'This order is linked to an invoice and must be corrected through the invoice workflow.',
          };
        }

        const requestedCorrectionRequestId = String(data?.correctionRequestId || '').trim();
        const requestedReason = String(data?.reason || '').trim();
        if (!UUID_RE.test(requestedCorrectionRequestId)) {
          return { success: false, error: 'A valid correction request ID is required.' };
        }
        if (requestedReason.length < 3 || requestedReason.length > 500) {
          return { success: false, error: 'Correction reason must contain 3 to 500 characters.' };
        }

        let origin: Record<string, any>;
        try { origin = JSON.parse(order.billiard_origin_json); }
        catch { return { success: false, error: 'Stored Billiard order origin is invalid.' }; }
        if (origin?.type !== 'BILLIARD_SESSION' || !origin.sessionId || !origin.checkoutId) {
          return { success: false, error: 'Stored Billiard order origin is incomplete.' };
        }

        // The original, settled handoff owns the durable correction command.
        // If Electron died after HTTP dispatch, a new renderer UUID must never
        // create a second correction: retry the exact journaled request/body.
        const correctionSource = billiardPosHandoffRepo.getByOrderId(order.id);
        if (!correctionSource || !isBilliardCorrectionSourceForOwner(correctionSource, correctionScope, origin)) {
          return {
            success: false,
            error: 'The durable source journal for this Billiard correction is unavailable on this owner/register.',
          };
        }
        const existingCorrectionIntent = correctionSource.correctionIntent;
        if (existingCorrectionIntent && (
          existingCorrectionIntent.orderId !== order.id
          || !UUID_RE.test(existingCorrectionIntent.requestId)
          || existingCorrectionIntent.reason.length < 3
          || existingCorrectionIntent.reason.length > 500
          || !['READY', 'SERVER_CONFIRMED'].includes(existingCorrectionIntent.state)
        )) {
          return {
            success: false,
            requiresRefresh: true,
            error: 'The durable Billiard correction journal is invalid. Do not submit another correction.',
          };
        }
        const correctionCommand = resolveBilliardCorrectionCommand(existingCorrectionIntent, {
          requestId: requestedCorrectionRequestId,
          reason: requestedReason,
        });
        const correctionRequestId = correctionCommand.requestId;
        const reason = correctionCommand.reason;

        const locallyCommittedCorrectionLines = getRefundLinesForRequest(
          order.refund_lines,
          correctionRequestId,
        );
        const localCorrectionAlreadyApplied = !shouldApplyRefundRequestLocally(
          order.refund_lines,
          correctionRequestId,
        );
        const sameCommittedCorrectionDelta = locallyCommittedCorrectionLines
          .reduce((sum, line) => sum + Math.max(0, Math.round(Number(line?.refundAmount) || 0)), 0);
        if (order.status === 'REFUNDED') {
          if (sameCommittedCorrectionDelta <= 0) {
            return { success: false, error: 'This Billiard order is already fully corrected.' };
          }
        }

        if (!this.posStore) return { success: false, error: 'POS is not ready.' };
        assertBilliardCorrectionHandoffPreflight({
          state: this.posStore.getState(),
          sessionId: String(origin.sessionId),
          unresolved: billiardPosHandoffRepo.getRecoverable(correctionScope),
        });

        const activeShift = database.get<{ id: string; backend_id: string | null; staff_id: string | null }>(
          'SELECT id, backend_id, staff_id FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1',
        );
        if (!activeShift) {
          return {
            success: false,
            code: 'BILLIARD_CORRECTION_ACTIVE_SHIFT_REQUIRED',
            error: 'Open a POS shift before correcting this Billiard order.',
          };
        }

        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        let backendShiftId = activeShift.backend_id;
        if (!backendShiftId) {
          const configuredMachineId = String(config.machineId || '').trim();
          const serverShift = configuredMachineId
            ? await apiClient.getActiveShift(token, configuredMachineId)
            : null;
          if (!this.isPosAuthContextCurrent(correctionAuthContext)) {
            return {
              success: false,
              requiresRefresh: true,
              error: 'POS user changed while the active shift was being verified. No correction was submitted.',
            };
          }
          if (serverShift?.id === activeShift.id) {
            backendShiftId = serverShift.id;
            database.run(
              'UPDATE shifts SET backend_id = ?, synced = 1, sync_error = NULL WHERE id = ? AND backend_id IS NULL',
              [backendShiftId, activeShift.id],
            );
            database.markDirty();
          }
        }
        if (!backendShiftId) {
          return {
            success: false,
            code: 'BILLIARD_CORRECTION_ACTIVE_SHIFT_REQUIRED',
            error: 'The active POS shift has not synced to the server yet.',
          };
        }

        const remainingGrosze = sameCommittedCorrectionDelta > 0
          ? sameCommittedCorrectionDelta
          : Math.max(0, Number(order.total) - Number(order.refund_amount || 0));
        if (remainingGrosze <= 0) return { success: false, error: 'No paid amount remains to correct.' };
        const tenderAllocationsMinor = allocateRefundTenders(
          order.payment_tenders,
          remainingGrosze,
          order.payment_method,
        );
        let correctionIntent = existingCorrectionIntent;
        if (!correctionIntent) {
          const stagedIntent = {
            orderId: order.id,
            requestId: correctionRequestId,
            reason,
            state: 'READY' as const,
            updatedAt: new Date().toISOString(),
          };
          if (!billiardPosHandoffRepo.setCorrectionIntent(order.id, stagedIntent)) {
            return { success: false, error: 'Could not stage the durable Billiard correction command.' };
          }
          database.markDirty();
          const intentFlush = await database.saveCoalesced();
          if (!intentFlush.success) {
            return {
              success: false,
              durabilityError: intentFlush.error || 'database flush failed',
              error: 'Correction was not submitted because its request ID could not be made durable.',
            };
          }
          correctionIntent = stagedIntent;
        }
        if (!this.isPosAuthContextCurrent(correctionAuthContext)) {
          return {
            success: false,
            requiresRefresh: true,
            error: 'POS user changed after the correction command was staged. No new server request was submitted.',
          };
        }

        const result: any = correctionIntent.state === 'SERVER_CONFIRMED'
          ? correctionIntent.response
          : await apiClient.correctBilliardOrder(token, order.backend_id, {
              correctionRequestId,
              reason,
              shiftId: backendShiftId,
              tenderAllocations: tenderAllocationsMinor.map((allocation) => ({
                method: allocation.method,
                amount: moneyGroszeToPln(allocation.amount),
              })),
            });

        // The server has already crossed the financial mutation boundary here.
        // Fail closed if its response cannot safely drive local history and the
        // replacement POS handoff; the same UUID remains retryable/idempotent.
        const replacementCheckout = normalizeBilliardPosCheckout(result?.posCheckout);
        const refundedDeltaGrosze = toGrosze(result?.refundAmount);
        const totalRefundedGrosze = toGrosze(result?.totalRefundedAmount);
        const rawLines = Array.isArray(result?.refundedLines) ? result.refundedLines : [];
        const refundLineTotal = rawLines.reduce((sum: number, line: any) => sum + toGrosze(line?.refundAmount), 0);
        const responseIsSafe = result?.success === true
          && result?.status === 'REFUNDED'
          && refundedDeltaGrosze === remainingGrosze
          && totalRefundedGrosze === Number(order.total)
          && Math.abs(refundLineTotal - refundedDeltaGrosze) <= 1
          && rawLines.length > 0
          && rawLines.every((line: any) => Boolean(line?.billiardLineKey) && line?.restock === false)
          && Array.isArray(result?.stockMovementIds)
          && result.stockMovementIds.length === 0
          && replacementCheckout.sessionId === origin.sessionId
          && replacementCheckout.checkoutId !== origin.checkoutId;
        if (!responseIsSafe) {
          return {
            success: false,
            mutationDetected: true,
            requiresRefresh: true,
            error: 'The owner correction completed on the server, but its replacement checkout response was incomplete. Retry with the same request.',
          };
        }
        if (correctionIntent.state !== 'SERVER_CONFIRMED') {
          const confirmedIntent = {
            ...correctionIntent,
            state: 'SERVER_CONFIRMED' as const,
            response: result,
            updatedAt: new Date().toISOString(),
          };
          if (!billiardPosHandoffRepo.setCorrectionIntent(order.id, confirmedIntent)) {
            return {
              success: false,
              mutationDetected: true,
              requiresRefresh: true,
              error: 'The correction completed on the server, but its confirmed response could not be journaled. Retry this request only.',
            };
          }
          database.markDirty();
          const confirmedFlush = await database.saveCoalesced();
          if (!confirmedFlush.success) {
            return {
              success: false,
              mutationDetected: true,
              requiresRefresh: true,
              durabilityError: confirmedFlush.error || 'database flush failed',
              error: 'The correction completed on the server, but local response durability failed. Retry this request only.',
            };
          }
          correctionIntent = confirmedIntent;
        }
        if (!this.isPosAuthContextCurrent(correctionAuthContext)) {
          return {
            success: false,
            mutationDetected: true,
            requiresRefresh: true,
            error: 'The correction is durably journaled, but the POS user changed before local recovery. Sign in as the original owner and retry.',
          };
        }

        const refundOccurredAt = new Date().toISOString();
        const refundMethod = tenderAllocationsMinor.length > 1
          ? 'SPLIT'
          : tenderAllocationsMinor[0]?.method || order.payment_method || undefined;
        const normalizedRefundLines = normalizeRefundLinesJson(rawLines);
        const deltaRefundLines = normalizedRefundLines
          ? JSON.parse(normalizedRefundLines).map((line: any) => ({
              ...line,
              refundedAt: line.refundedAt || refundOccurredAt,
              refundRequestId: line.refundRequestId || correctionRequestId,
              reason: line.reason || reason,
              refundMethod: line.refundMethod || refundMethod,
              restock: false,
            }))
          : [];
        if (!localCorrectionAlreadyApplied) {
          const cumulativeRefundLines = mergeRefundLines(order.refund_lines, deltaRefundLines);
          orderRepo.markRefunded(order.id, totalRefundedGrosze, reason, 'FULL', cumulativeRefundLines);
          posEventEmitter.emitRefundIssued({
            localOrderId: order.id,
            backendOrderId: order.backend_id,
            amountMinor: refundedDeltaGrosze,
            method: order.payment_method,
            tenderAllocations: tenderAllocationsMinor,
            reason,
            refundRequestId: correctionRequestId,
            refundedAt: refundOccurredAt,
            shiftId: activeShift.id,
            items: deltaRefundLines,
            approvedByStaffId: config.authUser?.id ?? null,
          });
          database.markDirty();
          const saved = await database.saveCoalesced();
          if (!saved.success) {
            return {
              success: false,
              mutationDetected: true,
              requiresRefresh: true,
              durabilityError: saved.error || 'database flush failed',
              error: 'Correction is recorded on the server. Do not create another correction; retry this request to recover locally.',
            };
          }
          if (!this.isPosAuthContextCurrent(correctionAuthContext)) {
            return {
              success: false,
              mutationDetected: true,
              requiresRefresh: true,
              error: 'The correction is recorded, but the POS user changed before its replacement checkout could be opened.',
            };
          }
        }

        if (!this.isPosAuthContextCurrent(correctionAuthContext)) {
          return {
            success: false,
            mutationDetected: true,
            requiresRefresh: true,
            error: 'The correction is recorded, but the POS user changed before its replacement checkout could be prepared.',
          };
        }
        const handoff = await this.prepareBilliardHandoff({
          posCheckout: replacementCheckout,
          tableName: result.tableName ?? result.resourceName ?? null,
        });
        if (!this.isPosAuthContextCurrent(correctionAuthContext)) {
          return {
            success: false,
            mutationDetected: true,
            requiresRefresh: true,
            error: 'The correction is recorded, but the POS user changed during replacement checkout recovery.',
          };
        }
        if (!handoff?.success || !handoff?.intent) {
          return {
            success: false,
            mutationDetected: true,
            requiresRefresh: true,
            error: handoff?.error || handoff?.durabilityError || 'Correction succeeded, but the replacement Billiard checkout could not be prepared.',
          };
        }

        let correctionJournalCleanupError: string | undefined;
        if (!billiardPosHandoffRepo.setCorrectionIntent(order.id, null)) {
          correctionJournalCleanupError = 'The completed correction command could not be cleared from its source journal.';
        } else {
          database.markDirty();
          const cleanupFlush = await database.saveCoalesced();
          if (!cleanupFlush.success) {
            // The last durable image still contains SERVER_CONFIRMED and is
            // safe to replay idempotently. The replacement handoff itself was
            // already fsynced by prepareBilliardHandoff.
            correctionJournalCleanupError = cleanupFlush.error || 'database flush failed';
          }
        }

        return {
          success: true,
          status: result.status,
          refundAmount: result.refundAmount,
          totalRefundedAmount: result.totalRefundedAmount,
          refundedLines: result.refundedLines,
          correction: result.correction,
          posCheckout: replacementCheckout,
          tableName: result.tableName ?? result.resourceName ?? null,
          intent: handoff.intent,
          journalCleanupPending: correctionJournalCleanupError,
        };
      } catch (error: any) {
        const code = String(error?.code || '').trim() || undefined;
        const messageByCode: Record<string, string> = {
          BILLIARD_CORRECTION_INVOICE_BLOCKED: 'This order is linked to an invoice and must be corrected through the invoice workflow.',
          BILLIARD_CORRECTION_ACTIVE_SHIFT_REQUIRED: 'Open a synced POS shift before correcting this Billiard order.',
          BILLIARD_CORRECTION_IDEMPOTENCY_MISMATCH: 'This correction request ID was already used with different details. Change the reason to start a new correction.',
        };
        return {
          success: false,
          code,
          error: (code && messageByCode[code]) || error?.message || 'Billiard owner correction failed',
        };
      }
    });

    ipcMain.handle('pos:orders:downloadPdf', async (e, orderId: string, kind: 'receipt' | 'invoice', invoiceType?: 'VAT' | 'PROFORMA') => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };

        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        const pdf = await apiClient.getOrderPdf(token, order.backend_id, kind, invoiceType ?? 'VAT');
        if (!pdf) return { success: false, error: 'PDF not available on server' };

        const suggestedName = `${kind === 'invoice' ? 'invoice' : 'receipt'}-${order.order_number || order.id.substring(0, 8)}.pdf`;
        const parentWindow = BrowserWindow.fromWebContents(e.sender) ?? undefined;
        const result = await dialog.showSaveDialog(parentWindow!, {
          title: `Save ${kind === 'invoice' ? 'Invoice' : 'Receipt'} PDF`,
          defaultPath: path.join(app.getPath('downloads'), suggestedName),
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' };

        await fs.writeFile(result.filePath, pdf);
        shell.openPath(result.filePath).catch(() => {});
        return { success: true, filePath: result.filePath };
      } catch (err: any) {
        logger.error(`[PosModule] downloadPdf failed: ${err.message}`);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:addInvoice', async (_e, orderId: string, data: { customerNip: string; invoiceType?: 'VAT' | 'PROFORMA' }) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };

        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        const nip = (data.customerNip || '').replace(/\D/g, '');
        if (nip.length !== 10) return { success: false, error: 'NIP must be 10 digits' };

        const result = await apiClient.addInvoiceToOrder(token, order.backend_id, {
          customerNip: nip,
          invoiceType: data.invoiceType ?? 'VAT',
        });

        database.run('UPDATE orders SET customer_nip = ? WHERE id = ?', [nip, orderId]);
        database.markDirty();

        logger.info(`[PosModule] Invoice attached to order ${order.order_number} (NIP ${nip})`);
        return { success: true, order: result };
      } catch (err: any) {
        logger.error(`[PosModule] addInvoice failed: ${err.message}`);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:generateProforma', async (_e, orderId: string) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };

        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        const result = await apiClient.generateProforma(token, order.backend_id);
        logger.info(`[PosModule] Proforma generated for order ${order.order_number}`);
        return { success: true, proforma: result };
      } catch (err: any) {
        logger.error(`[PosModule] generateProforma failed: ${err.message}`);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:customers:lookupNip', async (_e, nip: string) => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        const cleanNip = (nip || '').replace(/\D/g, '');
        if (cleanNip.length !== 10) return { success: false, error: 'NIP must be 10 digits' };
        const data = await apiClient.lookupCustomerByNip(token, cleanNip);
        return { success: true, data };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:getServerHistory', async (_e, orderId: string) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced to server yet' };
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        const history = await apiClient.getOrderServerHistory(token, order.backend_id);
        return { success: true, history };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:retrySync', async (_e, orderId: string) => {
      try {
        const orderSync = this.container.getOptional<any>(SERVICE_TOKENS.ORDER_SYNC);
        if (!orderSync) return { success: false, error: 'OrderSync not initialized' };
        const reset = orderSync.resetForRetry(orderId);
        if (!reset) return { success: false, error: 'Order not in shelved state or not found' };
        const summary = await orderSync.syncPendingOrders();
        const result = summary.results.find((r: any) => r.orderId === orderId);
        return { success: true, result, summary };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:repairStockFailures', async () => {
      try {
        const orderSync = this.container.getOptional<any>(SERVICE_TOKENS.ORDER_SYNC);
        if (!orderSync) return { success: false, error: 'OrderSync not initialized' };
        const resetCount = orderSync.repairStockFailures();
        if (resetCount === 0) return { success: true, resetCount: 0, summary: null };
        const summary = await orderSync.syncPendingOrders();
        return { success: true, resetCount, summary };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:cancel', async (_e, orderId: string) => {
      try {
        const order = orderRepo.getById(orderId);
        if (!order) return { success: false, error: 'Order not found' };
        if (!order.backend_id) return { success: false, error: 'Order not synced — cannot cancel on server' };
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        await apiClient.cancelOrder(token, order.backend_id);
        database.run("UPDATE orders SET status = 'CANCELLED' WHERE id = ?", [order.id]);
        database.markDirty();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:getServerList', async (_e, params: ServerOrderListParams) => {
      const serverUrl = getConfig().serverUrl;
      if (!serverUrl) {
        return { orders: [], items: {}, total: 0, page: 1, limit: params.limit ?? 20, source: 'unconfigured' };
      }
      const token = getSecureAuthToken();
      if (!token) {
        return { orders: [], items: {}, total: 0, page: 1, limit: params.limit ?? 20, source: 'unconfigured' };
      }
      try {
        const data = await apiClient.getServerOrders(token, params);
        const itemsMap: Record<string, any[]> = {};
        const orders = data.orders.map((s: any) => {
          const adapted = adaptServerOrder(s);
          if (Array.isArray(s.items)) {
            itemsMap[adapted.id] = s.items.map((item: any) => adaptServerOrderItem(item, adapted.id, s));
          }
          return adapted;
        });
        return { orders, items: itemsMap, total: data.total, page: data.page, limit: data.limit, source: 'server' };
      } catch (err: any) {
        return { orders: [], items: {}, total: 0, page: 1, limit: params.limit ?? 20, source: 'network-error', error: err.message };
      }
    });

    ipcMain.handle('pos:orders:getTodayServer', async () => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        const orders = await apiClient.getTodayOrders(token);
        return { success: true, orders, count: orders.length };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:orders:mirrorFromServer', async (_e, orderId: string, kind: 'cash' | 'invoiced') => {
      try {
        if (!getConfig().serverUrl) return { success: false, error: 'Server URL not configured' };
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };

        let detail = await apiClient.getServerOrderDetail(token, orderId, kind);
        if (!detail) {
          const fallbackKind = kind === 'cash' ? 'invoiced' : 'cash';
          detail = await apiClient.getServerOrderDetail(token, orderId, fallbackKind);
        }
        if (!detail) return { success: false, error: 'Order not found on server' };

        const adaptedItems = detail.items;
        if (!Array.isArray(adaptedItems) || adaptedItems.length === 0) {
          return { success: false, error: 'Server response missing items array' };
        }

        const adapted = adaptServerOrder(detail);
        const items = adaptedItems.map((i: any) => adaptServerOrderItem(i, adapted.id, detail));

        const result = orderRepo.upsertFromServer(adapted, items);
        const wasSplit = detail.paymentMethod === 'SPLIT';

        logger.info(`[PosModule] Mirrored ${orderId} from server (kind=${kind})`);
        return { success: true, localOrderId: result.localOrderId, wasSplit };
      } catch (err: any) {
        logger.warn(`[PosModule] Mirror failed for ${orderId}: ${err.message}`);
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:shift:getActive', async () => {
      try {
        const token = getSecureAuthToken();
        if (!token) return { success: false, error: 'Not authenticated' };
        const shift = await apiClient.getActiveShift(token);
        return { success: true, shift };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('pos:open-cash-drawer', async () => {
      try {
        const drawerOpened = await this.paymentController?.openCashDrawer() ?? false;
        posEventEmitter.emitCashDrawerOpened({ reason: 'manual', success: drawerOpened });
        return toCashDrawerIpcResult(drawerOpened);
      } catch (e: any) {
        posEventEmitter.emitCashDrawerOpened({ reason: 'manual', success: false });
        return toCashDrawerIpcResult(false, e);
      }
    });

    ipcMain.handle('pos:payment:card', async (_e, data: { amount: number; orderId: string }) => {
      const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
      if (!socket?.isConnected()) return { success: false, error: 'Not connected to server' };

      return new Promise((resolve) => {
        let settled = false;
        const cleanup = () => {
          socket.removeListener('elavon:payment-response', onResponse);
          socket.removeListener('disconnect', onDisconnect);
          clearTimeout(timeout);
        };
        const onResponse = (response: any) => {
          if (response.orderId !== data.orderId || settled) return;
          settled = true;
          cleanup();
          resolve(response.success ? { success: true, transactionId: response.transactionId } : { success: false, error: response.error || 'Payment declined' });
        };
        const onDisconnect = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ success: false, error: 'Connection lost during payment' });
        };
        const timeout = setTimeout(() => { if (settled) return; settled = true; cleanup(); resolve({ success: false, error: 'Payment timeout (60s)' }); }, 60000);
        socket.on('elavon:payment-response', onResponse);
        socket.once('disconnect', onDisconnect);
        socket.requestElavonPayment(data);
      });
    });

    ipcMain.handle('self-checkout:finalize-print', async (_e, payload: { orderId?: string; method?: string }) => {
      const orderId = String(payload?.orderId || '').trim();
      const method = String(payload?.method || '').toUpperCase();
      if (!orderId) return { success: false, printed: false, error: 'missing_order_id' };
      if (!['CASH', 'CARD', 'BLIK'].includes(method)) {
        return { success: false, printed: false, error: 'unsupported_payment_method' };
      }

      try {
        // Polish fiscal law requires a paragon fiskalny for EVERY consumer
        // sale regardless of tender — cash and BLIK included, not just card.
        // Route all methods through the fiscal printer (local hardware or the
        // shared blocking backend job to the POS that owns the device).
        // CASH additionally opens the local cash drawer (best-effort, before
        // the print so staff can store the money even if the print fails).
        let drawerOpened = false;
        if (method === 'CASH') {
          drawerOpened = await this.paymentController?.openCashDrawer() ?? false;
        }
        const fiscalPrinted = await this.paymentController?.printFiscalReceipt(orderId) ?? false;

        // Pickup slip: when the order has kitchen items, print a short strip
        // with the big daily number right where the paragon comes out (the
        // shared SELF_CHECKOUT_RECEIPT printer; local receipt printer as
        // fallback). Best-effort — the kiosk also SHOWS the number on screen.
        const finalizedOrder = orderRepo.getById(orderId);
        const pickupNumber = finalizedOrder?.kitchen_number ?? null;
        let slipPrinted: boolean | undefined;
        if (pickupNumber) {
          const slip: KitchenTicketData = {
            orderId,
            orderNumber: finalizedOrder?.order_number || orderId.slice(0, 8),
            createdAt: finalizedOrder?.created_at || new Date().toISOString(),
            source: finalizedOrder?.source || 'SELF_CHECKOUT',
            pickupNumber,
            kind: 'PICKUP_SLIP',
            brandName: resolveKitchenSelfOrderBrandName(getConfig()),
            items: [],
          };
          try {
            const sharedSlip = await submitSharedPickupSlip(slip);
            slipPrinted = !!sharedSlip.printed;
            if (!slipPrinted) {
              const printers = this.container.getOptional<Record<string, any>>(SERVICE_TOKENS.PRINTERS) || {};
              const localReceipt = printers[PrinterType.RECEIPT];
              if (localReceipt?.isConnected?.() && typeof localReceipt.printPlainLines === 'function') {
                await localReceipt.printPlainLines(buildPickupSlipLines(slip));
                slipPrinted = true;
              }
            }
          } catch (slipErr: any) {
            logger.warn(`[PosModule] Pickup slip failed for order ${orderId}: ${slipErr?.message || slipErr}`);
            slipPrinted = false;
          }
        }

        return {
          success: fiscalPrinted,
          printed: fiscalPrinted,
          fiscalPrinted,
          receiptPrinted: fiscalPrinted,
          drawerOpened,
          route: 'FISCAL_RECEIPT',
          pickupNumber,
          slipPrinted,
        };
      } catch (e: any) {
        return {
          success: false,
          printed: false,
          receiptPrinted: false,
          fiscalPrinted: false,
          error: e?.message || String(e),
        };
      }
    });

    ipcMain.handle('kitchen-self-order:getMenu', () => buildKitchenSelfOrderMenu({
      config: getConfig(),
      categories: getKitchenSelfOrderCategories(),
      products: productRepo.getAll(),
    }));

    ipcMain.handle('kitchen-self-order:submit', async (_e, payload: KitchenSelfOrderSubmitInput) => {
      let created: KitchenSelfOrderWithItems | null = null;
      try {
        const cfg = getConfig();
        const menu = buildKitchenSelfOrderMenu({
          config: cfg,
          categories: getKitchenSelfOrderCategories(),
          products: productRepo.getAll(),
        });
        if (
          resolveKitchenSelfOrderCheckoutAction(
            menu.policies.checkoutMode,
            menu.policies.kitchenReleasePolicy,
          ) === 'REQUIRE_TERMINAL'
        ) {
          return { success: false, error: 'payment_confirmation_required' };
        }
        const customerLanguage = normalizeKitchenSelfOrderLanguage(payload?.customerLanguage);
        const fulfillmentType = normalizeKitchenSelfOrderFulfillment(payload?.fulfillmentType);
        const sourceLabel = String(payload?.sourceLabel || cfg.kitchenSelfOrderSourceLabel || '').trim();
        const brandName = resolveKitchenSelfOrderBrandName(cfg);
        const normalizedItems = (payload?.items || []).map((item) => {
          const product = menu.products.find((candidate) => candidate.id === item.variantId);
          if (!product) throw new Error('product_unavailable');
          const groups = product.modifierGroupAttachmentIds
            .map((attachmentId) => menu.modifierGroups.find((group) =>
              group.attachmentId === attachmentId))
            .filter((group): group is NonNullable<typeof group> => !!group);
          const validation = validateKitchenSelfOrderModifierSelections(groups, item.modifiers);
          if (!validation.valid) throw new Error(`invalid_modifiers:${product.id}`);
          const modifierTotalGrosze = validation.modifiers.reduce(
            (sum, modifier) => sum + modifier.priceDeltaGrosze * modifier.quantity,
            0,
          );
          return {
            variantId: product.id,
            productId: product.templateId,
            name: product.name,
            quantity: item.quantity,
            unitPriceGrosze: normalizeKitchenSelfOrderPriceGrosze(product.priceGrosze + modifierTotalGrosze),
            note: item.note || null,
            modifiers: validation.modifiers,
            options: groups.length === 0 ? item.options : [],
          };
        });
        created = kitchenSelfOrderRepo.create({
          ...payload,
          customerLanguage,
          fulfillmentType,
          sourceLabel,
          sourceMachineId: cfg.machineId || null,
          items: normalizedItems,
        });
        const qrPayload = buildKitchenSelfOrderQrPayload(created, {
          kitchenAlreadyReleased: true,
        });
        const refQr = buildKitchenSelfOrderRefQr(created.id, created.order_number);
        const ticket = buildKitchenSelfOrderTicket(created, brandName, refQr, sourceLabel);
        ticket.labelQrPayload = refQr;
        const slipPrint = await this.printKitchenSelfOrderCustomerSlip(ticket);
        const error = slipPrint.error || null;
        const finalOrder = kitchenSelfOrderRepo.markCustomerSlipResult(created.id, {
          customerSlipPrinted: slipPrint.printed,
          customerSlipRoute: slipPrint.route || null,
          error,
        }) || created;
        const success = slipPrint.printed;

        // Best-effort: register this pay-at-counter order in the backend
        // cashier pickup queue so counter POS stations can claim/charge it
        // without scanning the slip. Fire-and-forget — never blocks or fails
        // the print/QR path (the QR slip stays the offline fallback).
        const payAtCounter = menu.policies.checkoutMode === 'PAY_AT_COUNTER';
        if (payAtCounter && success) {
          void pushPickupOrderBestEffort({
            terminalId: sourceLabel,
            sourceOrderId: finalOrder.id,
            orderNumber: finalOrder.order_number,
            sequence: finalOrder.sequence_number,
            totalGrosze: finalOrder.total_grosze,
            qr: qrPayload,
            kitchenPrintStatus: 'PENDING',
          });
        }
        if (success) {
          void this.finishKitchenSelfOrderKitchenPrint(finalOrder, brandName, sourceLabel, payAtCounter);
        }

        return {
          success,
          order: finalOrder,
          orderId: finalOrder.id,
          orderNumber: finalOrder.order_number,
          kitchenPrinted: false,
          customerSlipPrinted: slipPrint.printed,
          canRetry: !success,
          canRetrySlip: !slipPrint.printed,
          kitchenPrintStatus: success ? 'PENDING' : 'FAILED',
          kitchenStatus: success ? 'PENDING' : 'NOT_STARTED',
          slipRoute: slipPrint.route,
          qrPayload,
          error,
        };
      } catch (e: any) {
        logger.error(`[PosModule] Kitchen self-order submit failed: ${e?.message || e}`);
        return {
          success: false,
          orderId: created?.id,
          orderNumber: created?.order_number,
          canRetry: !!created?.id,
          error: e?.message || String(e),
        };
      }
    });

    // === Kitchen self-order pickup queue (cashier side) ===
    const resolvePickupMachineId = (machineId?: string) =>
      (machineId && machineId.trim()) || getConfig().machineId || undefined;

    // The renderer needs its own machineId to tell "claimed by THIS station"
    // from "claimed elsewhere" in the waiting list.
    ipcMain.handle('pos:pickupOrders:machineId', () => getConfig().machineId || null);

    ipcMain.handle('pos:pickupOrders:listOpen', async () => {
      const token = getSecureAuthToken();
      if (!token) return [];
      try {
        return await apiClient.listOpenPickupOrders(token);
      } catch (err: any) {
        logger.warn(`[PickupQueue] listOpen failed: ${err?.message ?? err}`);
        return [];
      }
    });

    ipcMain.handle('pos:pickupOrders:claim', async (_e, { id, machineId }: { id: string; machineId?: string }) => {
      const token = getSecureAuthToken();
      if (!token) return { ok: false, status: 401, error: 'not_authenticated' };
      try {
        return await apiClient.claimPickupOrder(token, id, resolvePickupMachineId(machineId));
      } catch (err: any) {
        return { ok: false, status: 0, error: 'network', message: err?.message };
      }
    });

    ipcMain.handle('pos:pickupOrders:claimByRef', async (_e, ref: { sourceOrderId?: string; orderNumber?: string; machineId?: string }) => {
      const token = getSecureAuthToken();
      if (!token) return { ok: false, status: 401, error: 'not_authenticated' };
      try {
        return await apiClient.claimPickupOrderByRef(token, { ...ref, machineId: resolvePickupMachineId(ref?.machineId) });
      } catch (err: any) {
        return { ok: false, status: 0, error: 'network', message: err?.message };
      }
    });

    ipcMain.handle('pos:pickupOrders:release', async (_e, { id, machineId }: { id: string; machineId?: string }) => {
      const token = getSecureAuthToken();
      if (!token) return { ok: false, status: 401, error: 'not_authenticated' };
      try {
        return await apiClient.releasePickupOrder(token, id, resolvePickupMachineId(machineId));
      } catch (err: any) {
        return { ok: false, status: 0, error: 'network', message: err?.message };
      }
    });

    ipcMain.handle('pos:pickupOrders:settle', async (_e, { id, posOrderId, posOrderNumber, machineId }: { id: string; posOrderId: string; posOrderNumber?: string; machineId?: string }) => {
      const token = getSecureAuthToken();
      if (!token) return { ok: false, status: 401, error: 'not_authenticated' };
      try {
        return await apiClient.settlePickupOrder(token, id, { posOrderId, posOrderNumber, machineId: resolvePickupMachineId(machineId) });
      } catch (err: any) {
        return { ok: false, status: 0, error: 'network', message: err?.message };
      }
    });

    ipcMain.handle('pos:pickupOrders:cancel', async (_e, { id, reason, machineId }: { id: string; reason: string; machineId?: string }) => {
      const token = getSecureAuthToken();
      if (!token) return { ok: false, status: 401, error: 'not_authenticated' };
      try {
        return await apiClient.cancelPickupOrder(token, id, { reason, machineId: resolvePickupMachineId(machineId) });
      } catch (err: any) {
        return { ok: false, status: 0, error: 'network', message: err?.message };
      }
    });

    ipcMain.handle('kitchen-self-order:retryPrint', async (_e, orderId: string) => {
      const id = String(orderId || '').trim();
      if (!id) {
        return { success: false, error: 'missing_order_id', canRetry: false, canRetrySlip: false };
      }

      let order: KitchenSelfOrderWithItems | null = null;
      try {
        order = kitchenSelfOrderRepo.getById(id);
        if (!order) {
          return { success: false, error: 'order_not_found', canRetry: false, canRetrySlip: false };
        }

        const action = resolveKitchenSelfOrderRetryAction({
          kitchenPrinted: order.kitchen_printed,
          customerSlipPrinted: order.customer_slip_printed,
        });

        if (action === 'none') {
          return {
            success: true,
            orderId: order.id,
            orderNumber: order.order_number,
            kitchenPrinted: true,
            customerSlipPrinted: true,
            canRetry: false,
            canRetrySlip: false,
          };
        }

        const cfg = getConfig();
        const sourceLabel = String(order.source_label || cfg.kitchenSelfOrderSourceLabel || '').trim();
        const brandName = resolveKitchenSelfOrderBrandName(cfg);

        if (action === 'reprint_slip') {
          const qrPayload = buildKitchenSelfOrderQrPayload(order, { kitchenAlreadyReleased: true });
          const refQr = buildKitchenSelfOrderRefQr(order.id, order.order_number);
          const ticket = buildKitchenSelfOrderTicket(order, brandName, refQr, sourceLabel);
          ticket.labelQrPayload = refQr;
          const slipPrint = await this.printKitchenSelfOrderCustomerSlip(ticket);
          const updated = kitchenSelfOrderRepo.markCustomerSlipResult(order.id, {
            customerSlipPrinted: slipPrint.printed,
            customerSlipRoute: slipPrint.route || null,
            error: slipPrint.error || null,
          }) || order;
          if (
            slipPrint.printed
            && normalizeKitchenSelfOrderCheckoutMode(cfg.kitchenSelfOrderCheckoutMode) === 'PAY_AT_COUNTER'
          ) {
            void pushPickupOrderBestEffort({
              terminalId: sourceLabel,
              sourceOrderId: updated.id,
              orderNumber: updated.order_number,
              sequence: updated.sequence_number,
              totalGrosze: updated.total_grosze,
              qr: qrPayload,
              kitchenPrintStatus: 'PRINTED',
            });
          }

          return {
            success: slipPrint.printed,
            orderId: updated.id,
            orderNumber: updated.order_number,
            kitchenPrinted: !!updated.kitchen_printed,
            customerSlipPrinted: slipPrint.printed,
            canRetry: !slipPrint.printed,
            canRetrySlip: !slipPrint.printed,
            slipRoute: slipPrint.route,
            qrPayload,
            error: slipPrint.error || null,
          };
        }

        if (action === 'reprint_kitchen') {
          const qrPayload = buildKitchenSelfOrderQrPayload(order, { kitchenAlreadyReleased: true });
          const kitchenTicket = buildKitchenSelfOrderTicket(order, brandName, null, sourceLabel);
          const kitchenPrint = await this.printKitchenSelfOrderTicket(kitchenTicket);
          const kitchenReleased = kitchenPrint.printed || kitchenPrint.uncertain === true;
          const kitchenPrintStatus = this.kitchenSelfOrderKitchenPrintStatus(kitchenPrint);
          const error = kitchenReleased ? null : kitchenPrint.error || 'kitchen_not_printed';
          const finalOrder = kitchenSelfOrderRepo.markPrintResult(order.id, {
            kitchenPrinted: kitchenReleased,
            customerSlipPrinted: true,
            kitchenRoute: kitchenPrint.route || null,
            kitchenPrinterId: kitchenPrint.printerId || null,
            kitchenJobId: kitchenPrint.jobId || null,
            customerSlipRoute: order.customer_slip_route || null,
            error,
          }) || order;

          if (normalizeKitchenSelfOrderCheckoutMode(cfg.kitchenSelfOrderCheckoutMode) === 'PAY_AT_COUNTER') {
            void pushPickupOrderBestEffort({
              terminalId: sourceLabel,
              sourceOrderId: finalOrder.id,
              orderNumber: finalOrder.order_number,
              sequence: finalOrder.sequence_number,
              totalGrosze: finalOrder.total_grosze,
              qr: qrPayload,
              kitchenPrintStatus,
            });
            void updatePickupKitchenPrintStatusBestEffort({
              sourceOrderId: finalOrder.id,
              orderNumber: finalOrder.order_number,
              status: kitchenPrintStatus,
              error,
            });
          }

          return {
            success: kitchenReleased,
            orderId: finalOrder.id,
            orderNumber: finalOrder.order_number,
            kitchenPrinted: kitchenReleased,
            customerSlipPrinted: true,
            canRetry: !kitchenReleased,
            canRetrySlip: false,
            kitchenRoute: kitchenPrint.route,
            kitchenPrinterId: kitchenPrint.printerId,
            kitchenJobId: kitchenPrint.jobId,
            kitchenPrintStatus,
            kitchenStatus: kitchenPrint.status,
            qrPayload,
            error,
          };
        }

        const qrPayload = buildKitchenSelfOrderQrPayload(order, {
          kitchenAlreadyReleased: true,
        });
        const refQr = buildKitchenSelfOrderRefQr(order.id, order.order_number);
        const ticket = buildKitchenSelfOrderTicket(order, brandName, refQr, sourceLabel);
        ticket.labelQrPayload = refQr;
        const slipPrint = await this.printKitchenSelfOrderCustomerSlip(ticket);
        const error = slipPrint.error || null;
        const finalOrder = kitchenSelfOrderRepo.markCustomerSlipResult(order.id, {
          customerSlipPrinted: slipPrint.printed,
          customerSlipRoute: slipPrint.route || null,
          error,
        }) || order;
        const success = slipPrint.printed;

        const payAtCounter = normalizeKitchenSelfOrderCheckoutMode(cfg.kitchenSelfOrderCheckoutMode) === 'PAY_AT_COUNTER';
        if (payAtCounter && success) {
          void pushPickupOrderBestEffort({
            terminalId: sourceLabel,
            sourceOrderId: finalOrder.id,
            orderNumber: finalOrder.order_number,
            sequence: finalOrder.sequence_number,
            totalGrosze: finalOrder.total_grosze,
            qr: qrPayload,
            kitchenPrintStatus: 'PENDING',
          });
        }
        if (success) {
          void this.finishKitchenSelfOrderKitchenPrint(finalOrder, brandName, sourceLabel, payAtCounter);
        }

        return {
          success,
          orderId: finalOrder.id,
          orderNumber: finalOrder.order_number,
          kitchenPrinted: false,
          customerSlipPrinted: slipPrint.printed,
          canRetry: !success,
          canRetrySlip: !slipPrint.printed,
          kitchenPrintStatus: success ? 'PENDING' : 'FAILED',
          kitchenStatus: success ? 'PENDING' : 'NOT_STARTED',
          slipRoute: slipPrint.route,
          qrPayload,
          error,
        };
      } catch (e: any) {
        logger.error(`[PosModule] Kitchen self-order retry print failed: ${e?.message || e}`);
        return {
          success: false,
          orderId: order?.id || id,
          orderNumber: order?.order_number,
          canRetry: true,
          canRetrySlip: false,
          error: e?.message || String(e),
        };
      }
    });

    ipcMain.handle('kitchen-self-order:reprintSlip', async (_e, orderId: string) => {
      const id = String(orderId || '').trim();
      if (!id) return { success: false, error: 'missing_order_id', canRetrySlip: false };

      try {
        const order = kitchenSelfOrderRepo.getById(id);
        if (!order) return { success: false, error: 'order_not_found', canRetrySlip: false };

        const cfg = getConfig();
        const sourceLabel = String(order.source_label || cfg.kitchenSelfOrderSourceLabel || '').trim();
        const qrPayload = buildKitchenSelfOrderQrPayload(order, { kitchenAlreadyReleased: true });
        const refQr = buildKitchenSelfOrderRefQr(order.id, order.order_number);
        const ticket = buildKitchenSelfOrderTicket(order, resolveKitchenSelfOrderBrandName(cfg), refQr, sourceLabel);
        ticket.labelQrPayload = refQr;
        const slipPrint = await this.printKitchenSelfOrderCustomerSlip(ticket);
        const updated = kitchenSelfOrderRepo.markCustomerSlipResult(order.id, {
          customerSlipPrinted: slipPrint.printed,
          customerSlipRoute: slipPrint.route || null,
          error: slipPrint.error || null,
        }) || order;

        return {
          success: slipPrint.printed,
          orderId: updated.id,
          orderNumber: updated.order_number,
          kitchenPrinted: !!updated.kitchen_printed,
          customerSlipPrinted: slipPrint.printed,
          canRetrySlip: !slipPrint.printed,
          slipRoute: slipPrint.route,
          qrPayload,
          error: slipPrint.error || null,
        };
      } catch (e: any) {
        logger.error(`[PosModule] Kitchen self-order slip reprint failed: ${e?.message || e}`);
        return { success: false, error: e?.message || String(e), canRetrySlip: true };
      }
    });

    ipcMain.handle('pos:shift:open', (_e, data: { staffId: string; staffName: string; openingCash: number }) => {
      try {
        if (!this.shiftController) return { success: false, error: 'Shift controller not initialized' };
        const shiftId = this.shiftController.openShift(data.staffId, data.staffName, data.openingCash);
        this.posStore?.dispatch({ type: 'session/open', payload: { shiftId, staffId: data.staffId, staffName: data.staffName } });
        this.invalidateShiftVerification();
        this.setServerShiftMismatch(null);
        return { success: true, shiftId };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('pos:shift:close', async (_e, data: { shiftId: string; closingCash: number; fiscalOnly?: boolean }) => {
      try {
        if (!this.shiftController) return { success: false, error: 'Shift controller not initialized' };
        if (
          this.posStore?.getState().checkoutDraft.billiard
          || this.posStore?.getState().checkoutDraft.restoredInterruption
        ) {
          return {
            success: false,
            error: 'Pay, hold, or discard the protected POS cart before closing this shift.',
          };
        }

        // Check shift exists in DB — if not, clear the ghost session and return gracefully
        const shiftExists = database.get<{ id: string }>('SELECT id FROM shifts WHERE id = ? AND closed_at IS NULL', [data.shiftId]);
        if (!shiftExists) {
          logger.warn(`[PosModule] Ghost shift ${data.shiftId.substring(0, 8)} — not in DB, clearing session`);
          try {
            const token = getSecureAuthToken();
            if (token) {
              await apiClient.closePosShift(token, data.shiftId, { closingCash: data.closingCash });
              logger.info(`[PosModule] Closed server ghost shift ${data.shiftId.substring(0, 8)}`);
            }
          } catch (err: any) {
            logger.warn(`[PosModule] Failed to close server ghost shift ${data.shiftId.substring(0, 8)}: ${err?.message ?? err}`);
          }
          this.posStore?.dispatch({ type: 'session/close' });
          this.invalidateShiftVerification();
          this.setServerShiftMismatch(null);
          return { success: true, report: null };
        }

        // Attempt to sync pending orders before closing shift, but never let
        // a backend outage block the local close/Z-report flow.
        const orderSync = this.container.getOptional<any>(SERVICE_TOKENS.ORDER_SYNC);
        if (orderSync) {
          let syncFinished = false;
          const syncTimeoutMs = 2000;
          const syncPromise = orderSync.syncPendingOrders()
            .catch((err: any) => {
              logger.debug(`[PosModule] pre-close order sync failed: ${err?.message ?? err}`);
            })
            .finally(() => {
              syncFinished = true;
            });
          await Promise.race([
            syncPromise,
            new Promise((resolve) => setTimeout(resolve, syncTimeoutMs)),
          ]);
          if (!syncFinished) {
            logger.warn(`[PosModule] pre-close order sync still running after ${syncTimeoutMs}ms; closing shift locally`);
          }
        }
        const report = this.shiftController.closeShift(data.shiftId, data.closingCash, Boolean(data.fiscalOnly));
        this.posStore?.dispatch({ type: 'session/close' });
        this.invalidateShiftVerification();
        this.setServerShiftMismatch(null);
        await this.shiftController.printZReport(report);
        return { success: true, report };
      } catch (e: any) { return { success: false, error: e.message }; }
    });

    // Self-checkout kiosk: "Wezwij obsługę" round-trip. Renderer is
    // sandboxed to localStorage + window-scoped APIs, so the actual
    // backend REST calls live here in main where we have the api key
    // and can persist a stable terminal id across restarts.
    ipcMain.handle(
      'self-checkout:help-request',
      async (_e, payload: { reason: string; cartTotalGrosze?: number }) => {
        const apiKey = getSecureApiKey() || '';
        if (!apiKey) {
          return { error: 'Print Agent not paired (missing apiKey)' };
        }
        let terminalId = (getConfigValue('selfCheckoutTerminalId') as string) || '';
        if (!terminalId) {
          terminalId = `kiosk-${Math.random().toString(36).slice(2, 10)}`;
          setConfigValue('selfCheckoutTerminalId', terminalId);
        }
        const baseUrl = (getConfigValue('serverUrl') as string) || 'https://api.enail.pro';
        try {
          const r = await fetch(
            `${baseUrl}/api/v1/print-agent/self-checkout/help-request`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                apiKey,
                terminalId,
                reason: payload.reason,
                cartTotalGrosze: payload.cartTotalGrosze ?? null,
              }),
            },
          );
          const body = await r.json().catch(() => ({}));
          if (!r.ok) {
            // Backward compatibility: an older backend rejects reason codes
            // it doesn't know yet (e.g. PRINT_FAILED) with a validation 400.
            // Retry once as OTHER so the staff alert still goes out.
            if (r.status === 400 && payload.reason !== 'OTHER') {
              logger.warn(`[PosModule] Help reason ${payload.reason} rejected by backend; retrying as OTHER`);
              const retry = await fetch(
                `${baseUrl}/api/v1/print-agent/self-checkout/help-request`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    apiKey,
                    terminalId,
                    reason: 'OTHER',
                    cartTotalGrosze: payload.cartTotalGrosze ?? null,
                  }),
                },
              );
              const retryBody = await retry.json().catch(() => ({}));
              if (retry.ok) return retryBody;
            }
            return { error: body?.message || `HTTP ${r.status}` };
          }
          return body;
        } catch (e: any) {
          return { error: e?.message || 'Network error' };
        }
      },
    );

    ipcMain.handle('self-checkout:help-status', async (_e, id: string) => {
      const apiKey = getSecureApiKey() || '';
      if (!apiKey) return null;
      const baseUrl = (getConfigValue('serverUrl') as string) || 'https://api.enail.pro';

      // Preferred route: the public apiKey status endpoint. The kiosk is an
      // unattended terminal — it must not depend on a staff JWT being fresh
      // (an expired token used to make this poll fail forever, leaving
      // HelpLockedOverlay locked until the staff exit gesture).
      try {
        const r = await fetch(
          `${baseUrl}/api/v1/print-agent/self-checkout/help-request/status`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey, id }),
          },
        );
        if (r.ok) {
          const body = await r.json().catch(() => null);
          if (body?.id) {
            return {
              id: body.id,
              acknowledgedAt: body.acknowledgedAt ?? null,
              resolvedAt: body.resolvedAt ?? null,
            };
          }
        } else if (r.status === 404) {
          const body = await r.json().catch(() => null);
          // Row-level 404 (request id unknown to the backend) → unlock, same
          // as the legacy missing-from-open-list behavior. A route-level 404
          // (older backend without the endpoint) falls through to the legacy
          // Bearer-token route below.
          if (body && /help request not found/i.test(String(body.message || ''))) {
            return { id, resolvedAt: new Date().toISOString() };
          }
        }
      } catch {
        /* fall through to legacy route */
      }

      try {
        // Legacy route: the /open endpoint returns the unresolved queue;
        // finding our id there means it's still open. Missing from the list
        // means it was resolved.
        const r = await fetch(
          `${baseUrl}/api/v1/print-agent/self-checkout/help-requests/open`,
          {
            headers: {
              Authorization: `Bearer ${getSecureAuthToken() || ''}`,
            },
          },
        );
        if (!r.ok) return null;
        const list = (await r.json().catch(() => [])) as Array<any>;
        const row = Array.isArray(list) ? list.find((x) => x.id === id) : null;
        if (!row) {
          return { id, resolvedAt: new Date().toISOString() };
        }
        return {
          id,
          acknowledgedAt: row.acknowledgedAt ?? null,
          resolvedAt: row.resolvedAt ?? null,
        };
      } catch {
        return null;
      }
    });

    // Self-checkout readiness: a production kiosk must not open a customer
    // session when no fiscal route can print the paragon — local fiscal
    // hardware or the shared FISCAL_RECEIPT backend job (POS1's printer).
    // The renderer polls this on the welcome/unavailable screens and shows
    // the localized "checkout closed" screen with the failing reason.
    ipcMain.handle('self-checkout:readiness', async () => {
      try {
        const socket = this.container.getOptional<SocketClient>(SERVICE_TOKENS.SOCKET);
        const online = socket?.isConnected() ?? false;
        const fiscal = await this.paymentController?.hasFiscalPrinter()
          ?? { configured: false, connected: false };
        const reasons: string[] = [];
        if (!fiscal.configured || !fiscal.connected) {
          reasons.push(online ? 'printer_offline' : 'offline');
        }
        return { ready: reasons.length === 0, reasons };
      } catch (e: any) {
        return { ready: false, reasons: ['unknown'], error: e?.message || String(e) };
      }
    });

    logger.info('[PosModule] IPC handlers registered');
  }

  private kitchenSelfOrderKitchenPrintStatus(result: {
    printed: boolean;
    uncertain?: boolean;
  }): PickupOrderKitchenPrintStatus {
    if (result.printed) return 'PRINTED';
    if (result.uncertain === true) return 'UNCERTAIN';
    return 'FAILED';
  }

  private async finishKitchenSelfOrderKitchenPrint(
    order: KitchenSelfOrderWithItems,
    brandName: string,
    sourceLabel: string,
    updatePickupStatus: boolean,
  ): Promise<void> {
    try {
      const kitchenTicket = buildKitchenSelfOrderTicket(order, brandName, null, sourceLabel);
      const kitchenPrint = await this.printKitchenSelfOrderTicket(kitchenTicket);
      const kitchenReleased = kitchenPrint.printed || kitchenPrint.uncertain === true;
      const kitchenPrintStatus = this.kitchenSelfOrderKitchenPrintStatus(kitchenPrint);
      const error = kitchenReleased ? null : kitchenPrint.error || 'kitchen_not_printed';

      kitchenSelfOrderRepo.markPrintResult(order.id, {
        kitchenPrinted: kitchenReleased,
        customerSlipPrinted: Number(order.customer_slip_printed) === 1,
        kitchenRoute: kitchenPrint.route || null,
        kitchenPrinterId: kitchenPrint.printerId || null,
        kitchenJobId: kitchenPrint.jobId || null,
        customerSlipRoute: order.customer_slip_route || null,
        error,
      });

      if (updatePickupStatus) {
        await updatePickupKitchenPrintStatusBestEffort({
          sourceOrderId: order.id,
          orderNumber: order.order_number,
          status: kitchenPrintStatus,
          error,
        });
      }
    } catch (err: any) {
      const error = err?.message || String(err);
      logger.error(`[PosModule] Async kitchen self-order ticket failed for ${order.order_number}: ${error}`);
      const current = kitchenSelfOrderRepo.getById(order.id) || order;
      kitchenSelfOrderRepo.markPrintResult(order.id, {
        kitchenPrinted: false,
        customerSlipPrinted: Number(current.customer_slip_printed) === 1,
        customerSlipRoute: current.customer_slip_route || null,
        error,
      });
      if (updatePickupStatus) {
        await updatePickupKitchenPrintStatusBestEffort({
          sourceOrderId: order.id,
          orderNumber: order.order_number,
          status: 'FAILED',
          error,
        });
      }
    }
  }

  /**
   * Kitchen self-order ticket path: no stock, no fiscal receipt, no sales order.
   * Normal POS payment prints only the customer receipt.
   */
  private async printKitchenSelfOrderTicket(
    ticket: KitchenTicketData,
  ): Promise<{ printed: boolean; uncertain?: boolean; route?: 'LOCAL' | 'SHARED_NETWORK'; printerId?: string; jobId?: string; status?: string; error?: string }> {
    const printers = this.container.getOptional<Record<string, any>>(SERVICE_TOKENS.PRINTERS) || {};
    const localKitchen = printers[PrinterType.KITCHEN];
    if (localKitchen?.isConnected?.() && typeof localKitchen.printPlainLines === 'function') {
      try {
        await localKitchen.printPlainLines(buildKitchenTicketLines(ticket));
        logger.info(`[PosModule] Kitchen self-order ticket printed locally for ${ticket.orderNumber}`);
        return { printed: true, route: 'LOCAL' };
      } catch (err: any) {
        logger.error(`[PosModule] Local kitchen self-order ticket failed for ${ticket.orderNumber}: ${err?.message || err}`);
      }
    } else {
      logger.info(`[PosModule] No local KITCHEN printer for kitchen self-order ${ticket.orderNumber}; trying shared KITCHEN route`);
    }

    const shared = await submitSharedKitchenPrint(ticket);
    if (shared.handled && shared.printed) {
      logger.info(`[PosModule] Kitchen self-order ticket printed through shared KITCHEN route for ${ticket.orderNumber}${shared.printerId ? ` on ${shared.printerId}` : ''}`);
      return {
        printed: true,
        route: 'SHARED_NETWORK',
        printerId: shared.printerId,
        jobId: shared.jobId,
        status: shared.status,
      };
    }
    logger.warn(`[PosModule] Kitchen self-order ticket was not printed for ${ticket.orderNumber}: ${shared.error || 'no_kitchen_printer'}`);
    return {
      printed: false,
      uncertain: shared.uncertain === true,
      route: shared.handled ? 'SHARED_NETWORK' : undefined,
      printerId: shared.printerId,
      jobId: shared.jobId,
      status: shared.status,
      error: shared.error || 'no_kitchen_printer',
    };
  }

  private async printKitchenSelfOrderCustomerSlip(
    ticket: KitchenTicketData,
  ): Promise<{ printed: boolean; route?: 'LOCAL'; error?: string }> {
    const configured = String(getConfigValue('kitchenSelfOrderSlipPrinterType') || PrinterType.RECEIPT).toUpperCase();
    const printerType = configured === PrinterType.LABEL ? PrinterType.LABEL : PrinterType.RECEIPT;
    const printers = this.container.getOptional<Record<string, any>>(SERVICE_TOKENS.PRINTERS) || {};
    const printer = printers[printerType];

    const result = await printKitchenSelfOrderCustomerSlipToPrinter(ticket, printerType, printer);
    if (result.printed) {
      logger.info(`[PosModule] Kitchen self-order payment slip printed locally for ${ticket.orderNumber}`);
    } else {
      logger.warn(`[PosModule] Kitchen self-order payment slip failed for ${ticket.orderNumber}: ${result.error || 'unknown'}`);
    }
    return result;
  }

  registerEventHandlers(bus: EventBus): void {
    // Clear cart & shift on logout to prevent data leakage between accounts
    bus.on('user:logged-out', () => {
      logger.info('[PosModule] User logged out — resetting POS RAM at the auth boundary');
      this.posAuthEpoch.advance();
      this.invalidateShiftVerification();
      this.setServerShiftMismatch(null);
      this.frozenRestoredCartHolds.clear();
      this.holdRecallInFlight = null;
      this.posStore?.resetForAuthBoundary();
    });
    bus.on('user:logged-in', () => {
      this.posAuthEpoch.advance();
      let openShift: ReturnType<typeof recoverOpenShiftFromLocal> = null;
      let localShiftRecoverySafe = true;
      try {
        openShift = recoverOpenShiftFromLocal(database, this.posStore);
        if (openShift) {
          logger.info(`[PosModule] Restored open shift ${openShift.id} after login (${openShift.staff_name})`);
        }
      } catch (error: any) {
        localShiftRecoverySafe = false;
        logger.error(`[PosModule] Local shift recovery after login blocked: ${error?.message || String(error)}`);
      }
      if (localShiftRecoverySafe) this.scheduleShiftVerification(openShift?.id ?? null);
      this.replayProductAdminMutations('login');
    });
  }

  setupSocketHandlers(socket: SocketClient): void {
    socket.on('elavon:payment-status-update', (data: any) => {
      const posWindow = this.windowManager?.getWindow('pos');
      if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:elavon-status', data);
      const selfCheckoutWindow = this.windowManager?.getWindow('selfCheckout');
      if (selfCheckoutWindow && !selfCheckoutWindow.isDestroyed()) selfCheckoutWindow.webContents.send('pos:elavon-status', data);
      // Forward payment status to customer display via PosStore broadcast
      if (this.posStore) {
        const currentDisplay = this.posStore.getState().display;
        this.posStore.dispatch({
          type: 'display/setMode',
          payload: { ...currentDisplay, paymentStatus: data.status },
        });
      }
    });

    socket.on('draft-products:updated', (data: { draft: any }) => {
      if (!data?.draft) return;
      try {
        draftProductSync.applyUpdate(data.draft);
        const posWindow = this.windowManager?.getWindow('pos');
        if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:draft-products-synced');
      } catch (err: any) {
        logger.warn(`[PosModule] Failed to apply draft update: ${err?.message ?? err}`);
      }
    });

    socket.on('draft-products:deleted', (data: { id: string }) => {
      if (!data?.id) return;
      try {
        draftProductSync.applyDelete(data.id);
        const posWindow = this.windowManager?.getWindow('pos');
        if (posWindow && !posWindow.isDestroyed()) posWindow.webContents.send('pos:draft-products-synced');
      } catch (err: any) {
        logger.warn(`[PosModule] Failed to apply draft delete: ${err?.message ?? err}`);
      }
    });

    // Kitchen self-order pickup queue: relay backend queue events to the POS
    // renderer so cashier stations see the waiting list update live.
    const forwardPickupOrder = (event: string) => (data: any) => {
      // notifyPosRenderers reaches BOTH the dedicated 'pos' window AND the main
      // app window (where the POS tab lives) — getWindow('pos') alone misses
      // the main-window POS tab, so live updates never arrived there.
      notifyPosRenderers(this.container, 'pos:pickup-order', { event, data });
    };
    socket.on('pickup-order:new', forwardPickupOrder('new'));
    socket.on('pickup-order:claimed', forwardPickupOrder('claimed'));
    socket.on('pickup-order:released', forwardPickupOrder('released'));
    socket.on('pickup-order:settled', forwardPickupOrder('settled'));
    socket.on('pickup-order:cancelled', forwardPickupOrder('cancelled'));
    socket.on('pickup-order:kitchen-print-updated', forwardPickupOrder('kitchen-print-updated'));

    // Retry any pickup-order settles that didn't land while offline whenever
    // the socket (re)connects — closes the loop after a transient outage.
    socket.on('connected', () => {
      void drainPickupSettleOutbox();
      void drainPickupOutboxesInOrder();
    });
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        definition: {
          type: 'function',
          function: {
            name: 'search_products',
            description: 'Search POS products by name or barcode',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: 'Search query' } },
              required: ['query'],
            },
          },
        },
        module: this.name,
        category: 'pos',
        execute: async (args) => {
          const results = productRepo.search(args.query as string);
          if (results.length === 0) return `❌ No products found for "${args.query}"`;
          return `🔍 ${results.length} products:\n` + results.slice(0, 10).map((p: any) => `  ${p.name} - ${(p.price / 100).toFixed(2)} PLN`).join('\n');
        },
      },
    ];
  }

  private async sendFiscalReceiptSyncRow(
    row: FiscalReceiptSyncRow,
    auth: {
      apiKey: string | null | undefined;
      token: string | null | undefined;
      machineId: string | undefined;
    },
  ): Promise<void> {
    const order = orderRepo.getById(row.local_order_id);
    const body = prepareFiscalReceiptSyncBody(
      row,
      order?.backend_id,
    ) as Parameters<typeof apiClient.recordFiscalReceiptEvent>[1];
    if (auth.apiKey) {
      await apiClient.recordFiscalReceiptEventWithApiKey(auth.apiKey, body, auth.machineId);
      return;
    }

    if (!auth.token) {
      throw new Error('missing auth token and print-agent API key');
    }
    await apiClient.recordFiscalReceiptEvent(auth.token, body);
  }

  private async flushFiscalReceiptSyncQueue(reason: string): Promise<void> {
    if (this.fiscalReceiptSyncInFlight) return;
    this.fiscalReceiptSyncInFlight = true;
    try {
      const auth = {
        apiKey: getSecureApiKey(),
        token: getSecureAuthToken(),
        machineId: getConfigValue('machineId') as string | undefined,
      };
      if (!auth.apiKey && !auth.token) {
        if (reason !== 'timer') {
          logger.info('[PosModule] Deferred fiscal receipt sync until authentication is available');
        }
        return;
      }

      const rows = fiscalReceiptSyncRepo.listReady(25);
      if (rows.length === 0) return;

      for (const row of rows) {
        try {
          await this.sendFiscalReceiptSyncRow(row, auth);
          fiscalReceiptSyncRepo.markSynced(row.id);
          logger.info(`[PosModule] Synced fiscal receipt event ${row.id} for ${row.local_order_id} (${reason})`);
        } catch (err: any) {
          if (err instanceof FiscalReceiptOrderPendingSyncError) {
            if (reason !== 'timer') {
              logger.info(`[PosModule] Deferred fiscal receipt event ${row.id} until order ${row.local_order_id} syncs`);
            }
            continue;
          }
          const message = err?.message || String(err);
          fiscalReceiptSyncRepo.markFailed(row.id, message);
          logger.warn(`[PosModule] Fiscal receipt event ${row.id} pending sync for ${row.local_order_id}: ${message}`);
        }
      }
    } finally {
      this.fiscalReceiptSyncInFlight = false;
    }
  }

  private startFiscalReceiptSyncTimer(): void {
    if (this.fiscalReceiptSyncTimer) return;
    void this.flushFiscalReceiptSyncQueue('startup');
    this.fiscalReceiptSyncTimer = setInterval(() => {
      void this.flushFiscalReceiptSyncQueue('timer');
    }, 60_000);
    this.fiscalReceiptSyncTimer.unref?.();
  }

  private stopFiscalReceiptSyncTimer(): void {
    if (!this.fiscalReceiptSyncTimer) return;
    clearInterval(this.fiscalReceiptSyncTimer);
    this.fiscalReceiptSyncTimer = null;
  }

  private replayProductAdminMutations(reason: string): void {
    void this.productAdminMutationOutbox?.replayPending().catch((error: any) => {
      logger.debug(`[PosModule] Product-admin mutation replay (${reason}) deferred: ${error?.message ?? error}`);
    });
  }

  private startProductAdminMutationReplayTimer(): void {
    if (this.productAdminMutationReplayTimer) return;
    this.replayProductAdminMutations('startup');
    this.productAdminMutationReplayTimer = setInterval(() => {
      this.replayProductAdminMutations('timer');
    }, 30_000);
    this.productAdminMutationReplayTimer.unref?.();
  }

  private stopProductAdminMutationReplayTimer(): void {
    if (!this.productAdminMutationReplayTimer) return;
    clearInterval(this.productAdminMutationReplayTimer);
    this.productAdminMutationReplayTimer = null;
  }

  async start(): Promise<void> {
    this.setState(ModuleState.RUNNING);
    try {
      const backfilled = fiscalAttemptRepo.backfillFiskalColumns();
      if (backfilled > 0) {
        logger.info(`[Fiskal] backfilled ${backfilled} projections`);
      }
    } catch (err: any) {
      logger.warn(`[Fiskal] backfill failed: ${err?.message || err}`);
    }
    this.startFiscalReceiptSyncTimer();
    this.startProductAdminMutationReplayTimer();
    // Set salon display info from config
    const config = getConfig();
    const salonSlug = config.salonSlug as string | undefined;
    this.posStore?.setSalonDisplayInfo({
      salonName: (config.salonName as string | undefined) || undefined,
      bookingUrl: salonSlug ? `https://zira-ai.com/s/${salonSlug}` : undefined,
    });
  }

  async stop(): Promise<void> {
    this.stopFiscalReceiptSyncTimer();
    this.stopProductAdminMutationReplayTimer();
    this.windowManager?.destroy();
    if (this.posStore && typeof this.posStore.destroy === 'function') {
      this.posStore.destroy();
    }
    this.setState(ModuleState.STOPPED);
  }

  async destroy(): Promise<void> {
    this.stopFiscalReceiptSyncTimer();
    this.stopProductAdminMutationReplayTimer();
    this.setState(ModuleState.STOPPED);
  }
}

function normalizeSelectedServices(services?: SelectedService[]): SelectedService[] | undefined {
  const normalized = (services || [])
    .map((service) => ({
      id: service.id,
      name: service.name,
      price: service.price,
      duration: service.duration,
    }))
    .filter((service) => service.id && service.name);

  return normalized.length > 0 ? normalized : undefined;
}

function deriveLegacyServiceName(services?: SelectedService[]): string | undefined {
  const names = (services || [])
    .map((service) => service.name?.trim())
    .filter((name): name is string => !!name);

  return names.length > 0 ? names.join(', ') : undefined;
}

function normalizeQuickAddAnalysis(raw: any): Record<string, any> {
  const candidates = [
    raw?.analysis,
    raw?.data?.analysis,
    raw?.result?.analysis,
    raw?.data,
    raw?.result,
    raw,
  ].filter((candidate) => candidate && typeof candidate === 'object');

  const source = candidates.find((candidate) =>
    candidate.name ||
    candidate.productName ||
    candidate.product_name ||
    candidate.namePreferred ||
    candidate.name_preferred ||
    candidate.title ||
    candidate.label,
  ) ?? candidates[0] ?? {};

  const name = firstString(
    source.name,
    source.productName,
    source.product_name,
    source.namePreferred,
    source.name_preferred,
    source.title,
    source.label,
  );

  return {
    ...source,
    name,
    ean: firstCandidateString(candidates, ['ean', 'barcode', 'detectedEan', 'detected_ean']),
    weight: firstCandidateValue(candidates, ['weight', 'weightGrams', 'weight_grams']),
    weightUnit: firstCandidateValue(candidates, ['weightUnit', 'weight_unit']),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstCandidateString(candidates: Record<string, any>[], keys: string[]): string | undefined {
  return firstString(...candidates.flatMap((candidate) => keys.map((key) => candidate[key])));
}

function firstCandidateValue(candidates: Record<string, any>[], keys: string[]): any {
  for (const candidate of candidates) {
    for (const key of keys) {
      if (candidate[key] != null && candidate[key] !== '') return candidate[key];
    }
  }
  return undefined;
}

function fallbackQuickAddName(analysis: Record<string, any>): string {
  const ean = firstString(analysis.ean, analysis.barcode);
  if (ean) return `New product ${ean}`;
  return `New product ${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
}

function lockRefundMutationLocally(
  orderId: string,
  order: { total: number; refund_amount: number | null },
  validation: RefundBackendValidationResult,
  error: string,
  reason?: string,
): void {
  const reportedAmount = validation.refundedAmountGrosze;
  const status = validation.overRefund || (reportedAmount != null && reportedAmount >= order.total)
    ? 'REFUNDED'
    : 'PARTIAL_REFUND';

  database.run(
    `UPDATE orders
     SET status = ?,
         refund_amount = CASE WHEN ? IS NULL THEN refund_amount ELSE ? END,
         refund_reason = COALESCE(?, refund_reason),
         sync_error = ?,
         refunded_at = COALESCE(refunded_at, datetime('now'))
     WHERE id = ?`,
    [
      status,
      reportedAmount,
      reportedAmount,
      reason ?? 'Backend refund response incomplete',
      error,
      orderId,
    ],
  );
}
