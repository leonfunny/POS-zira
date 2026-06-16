export type KitchenSelfOrderLanguage = 'pl' | 'vi' | 'en';
export type KitchenSelfOrderFulfillment = 'DINE_IN' | 'TAKEAWAY';
export type KitchenSelfOrderCheckoutMode = 'PAY_AT_COUNTER' | 'KIOSK_TERMINAL' | 'ORDER_ONLY';
export type KitchenSelfOrderReleasePolicy = 'ON_SUBMIT' | 'ON_PAYMENT_CONFIRMED';
export type KitchenSelfOrderModifierSelectionMode = 'SINGLE' | 'MULTIPLE';
export type KitchenSelfOrderCheckoutAction = 'SUBMIT_ORDER' | 'REQUIRE_TERMINAL';
export type KitchenSelfOrderStatus =
  | 'SUBMITTED'
  | 'PRINTED'
  | 'PARTIAL_PRINT'
  | 'PRINT_FAILED'
  | 'CANCELLED';

export const KITCHEN_SELF_ORDER_QR_PREFIX = 'KSO1:';

export interface KitchenSelfOrderModifierOption {
  id: string;
  name: string;
  nameTranslations?: string | null;
  priceDeltaGrosze: number;
  isDefault: boolean;
  isAvailable: boolean;
  maxQuantity?: number | null;
}

export interface KitchenSelfOrderModifierGroup {
  /** View-model attachment key. Catalog identity remains in `id`. */
  attachmentId?: string;
  id: string;
  name: string;
  nameTranslations?: string | null;
  selectionMode: KitchenSelfOrderModifierSelectionMode;
  minSelections: number;
  maxSelections: number;
  displayOrder: number;
  allowOptionQuantity?: boolean;
  options: KitchenSelfOrderModifierOption[];
}

export interface KitchenSelfOrderModifierSnapshot {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  quantity: number;
  priceDeltaGrosze: number;
}

export interface KitchenSelfOrderProductMedia {
  url: string | null;
  fit: 'COVER' | 'CONTAIN';
  focalPoint: { x: number; y: number } | null;
  zoom: number;
}

export interface KitchenSelfOrderMenuCategory {
  id: string;
  name: string;
  nameTranslations?: string | null;
  displayOrder: number;
}

export interface KitchenSelfOrderMenuProduct {
  id: string;
  templateId: string | null;
  categoryId: string | null;
  name: string;
  nameTranslations?: string | null;
  priceGrosze: number;
  media: KitchenSelfOrderProductMedia;
  modifierGroupAttachmentIds: string[];
  noteEnabled: boolean;
}

export interface KitchenSelfOrderMenu {
  version: 1;
  brand: {
    name: string;
    logoUrl: string | null;
    accentColor: string;
  };
  policies: {
    checkoutMode: KitchenSelfOrderCheckoutMode;
    kitchenReleasePolicy: KitchenSelfOrderReleasePolicy;
    fulfillmentOptions: KitchenSelfOrderFulfillment[];
  };
  categories: KitchenSelfOrderMenuCategory[];
  products: KitchenSelfOrderMenuProduct[];
  modifierGroups: KitchenSelfOrderModifierGroup[];
}

export interface KitchenSelfOrderItemInput {
  variantId?: string | null;
  productId?: string | null;
  name: string;
  quantity: number;
  unitPriceGrosze?: number | null;
  note?: string | null;
  options?: string[] | null;
  modifiers?: KitchenSelfOrderModifierSnapshot[] | null;
}

export interface KitchenSelfOrderSubmitInput {
  customerLanguage: KitchenSelfOrderLanguage;
  fulfillmentType: KitchenSelfOrderFulfillment;
  sourceLabel?: string | null;
  items: KitchenSelfOrderItemInput[];
}

export interface KitchenSelfOrderQrItem {
  variantId?: string | null;
  productId?: string | null;
  name?: string | null;
  quantity: number;
  note?: string | null;
  options?: string[];
  unitPriceGrosze?: number | null;
  lineTotalGrosze?: number | null;
}

export interface KitchenSelfOrderQrPayload {
  type: 'KSO';
  version: 1;
  orderNumber: string;
  orderId?: string;
  createdAt?: string;
  fulfillmentType?: KitchenSelfOrderFulfillment;
  customerLanguage?: KitchenSelfOrderLanguage;
  sourceLabel?: string | null;
  kitchenAlreadyReleased?: boolean;
  items: KitchenSelfOrderQrItem[];
}

export type KitchenSelfOrderCheckoutPriceSource = 'CATALOG' | 'QR_SNAPSHOT' | 'NONE';

export function normalizeKitchenSelfOrderLanguage(value: unknown): KitchenSelfOrderLanguage {
  return value === 'vi' || value === 'en' ? value : 'pl';
}

export function normalizeKitchenSelfOrderFulfillment(value: unknown): KitchenSelfOrderFulfillment {
  return value === 'TAKEAWAY' ? 'TAKEAWAY' : 'DINE_IN';
}

interface KitchenSelfOrderBrandConfig {
  kitchenSelfOrderBrandName?: string | null;
  kitchenSelfOrderLogoUrl?: string | null;
  kitchenSelfOrderAccentColor?: string | null;
  kitchenSelfOrderCheckoutMode?: string | null;
  kitchenSelfOrderReleasePolicy?: string | null;
  salonName?: string | null;
  authUser?: { salonName?: string | null } | null;
}

export function resolveKitchenSelfOrderBrandName(config: KitchenSelfOrderBrandConfig | null | undefined): string {
  const candidates = [
    config?.kitchenSelfOrderBrandName,
    config?.salonName,
    config?.authUser?.salonName,
  ];
  for (const value of candidates) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 48);
  }
  return 'Zira POS';
}

export function normalizeKitchenSelfOrderCheckoutMode(value: unknown): KitchenSelfOrderCheckoutMode {
  return value === 'KIOSK_TERMINAL' || value === 'ORDER_ONLY' ? value : 'PAY_AT_COUNTER';
}

export function normalizeKitchenSelfOrderReleasePolicy(value: unknown): KitchenSelfOrderReleasePolicy {
  return value === 'ON_PAYMENT_CONFIRMED' ? value : 'ON_SUBMIT';
}

export function resolveKitchenSelfOrderCheckoutAction(
  checkoutMode: KitchenSelfOrderCheckoutMode,
  releasePolicy: KitchenSelfOrderReleasePolicy = 'ON_SUBMIT',
): KitchenSelfOrderCheckoutAction {
  return checkoutMode === 'KIOSK_TERMINAL' || releasePolicy === 'ON_PAYMENT_CONFIRMED'
    ? 'REQUIRE_TERMINAL'
    : 'SUBMIT_ORDER';
}

export function normalizeKitchenSelfOrderAccentColor(value: unknown): string {
  const text = String(value ?? '').trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(text)) return '#DA7756';
  const channels = [1, 3, 5].map((index) => {
    const raw = Number.parseInt(text.slice(index, index + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  return contrastWithWhite >= 3 ? text : '#DA7756';
}

export function formatKitchenSelfOrderNumber(sequenceNumber: number): string {
  const safe = Math.max(1, Math.floor(Number(sequenceNumber) || 1));
  return `K-${String(safe).padStart(3, '0')}`;
}

export function businessDateFromIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

export function normalizeKitchenSelfOrderQuantity(value: unknown): number {
  return Math.min(99, Math.max(1, Math.floor(Number(value) || 1)));
}

export function normalizeKitchenSelfOrderPriceGrosze(value: unknown): number {
  const amount = Math.round(Number(value) || 0);
  return Math.max(0, Math.min(9_999_999, amount));
}

export function resolveKitchenSelfOrderCheckoutUnitPrice(
  catalogPriceGrosze: unknown,
  snapshotUnitPriceGrosze: unknown,
): { unitPriceGrosze: number; source: KitchenSelfOrderCheckoutPriceSource } {
  const catalog = normalizeKitchenSelfOrderPriceGrosze(catalogPriceGrosze);
  if (catalog > 0) {
    return { unitPriceGrosze: catalog, source: 'CATALOG' };
  }

  const snapshot = normalizeKitchenSelfOrderPriceGrosze(snapshotUnitPriceGrosze);
  if (snapshot > 0) {
    return { unitPriceGrosze: snapshot, source: 'QR_SNAPSHOT' };
  }

  return { unitPriceGrosze: 0, source: 'NONE' };
}

export function sanitizeKitchenSelfOrderNote(value: unknown): string | null {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, 180);
}

export function sanitizeKitchenSelfOrderOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = sanitizeKitchenSelfOrderNote(item);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= 8) break;
  }
  return out;
}

function sanitizeKitchenSelfOrderId(value: unknown): string {
  return String(value ?? '').trim().slice(0, 80);
}

function normalizeModifierQuantity(value: unknown): number {
  return Math.min(9, Math.max(1, Math.floor(Number(value) || 1)));
}

function normalizePriceDeltaGrosze(value: unknown): number {
  const amount = Math.round(Number(value) || 0);
  return Math.min(100_000, Math.max(-100_000, amount));
}

export function sanitizeKitchenSelfOrderModifiers(value: unknown): KitchenSelfOrderModifierSnapshot[] {
  if (!Array.isArray(value)) return [];
  const out: KitchenSelfOrderModifierSnapshot[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Partial<KitchenSelfOrderModifierSnapshot>;
    const groupId = sanitizeKitchenSelfOrderId(candidate.groupId);
    const optionId = sanitizeKitchenSelfOrderId(candidate.optionId);
    const groupName = sanitizeKitchenSelfOrderNote(candidate.groupName);
    const optionName = sanitizeKitchenSelfOrderNote(candidate.optionName);
    if (!groupId || !optionId || !groupName || !optionName) continue;
    const key = `${groupId}\u0000${optionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      groupId,
      groupName,
      optionId,
      optionName,
      quantity: normalizeModifierQuantity(candidate.quantity),
      priceDeltaGrosze: normalizePriceDeltaGrosze(candidate.priceDeltaGrosze),
    });
    if (out.length >= 32) break;
  }
  return out;
}

export function serializeKitchenSelfOrderOptions(
  modifiers: unknown,
  legacyOptions: unknown,
): string | null {
  const sanitizedModifiers = sanitizeKitchenSelfOrderModifiers(modifiers);
  if (sanitizedModifiers.length > 0) {
    return JSON.stringify({ version: 1, modifiers: sanitizedModifiers });
  }
  const sanitizedLegacy = sanitizeKitchenSelfOrderOptions(legacyOptions);
  return sanitizedLegacy.length > 0 ? JSON.stringify(sanitizedLegacy) : null;
}

export function parseKitchenSelfOrderOptionsJson(value: string | null | undefined): {
  modifiers: KitchenSelfOrderModifierSnapshot[];
  legacyOptions: string[];
} {
  if (!value) return { modifiers: [], legacyOptions: [] };
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return { modifiers: [], legacyOptions: sanitizeKitchenSelfOrderOptions(parsed) };
    }
    if (parsed && typeof parsed === 'object') {
      return {
        modifiers: sanitizeKitchenSelfOrderModifiers((parsed as { modifiers?: unknown }).modifiers),
        legacyOptions: [],
      };
    }
  } catch {
    /* invalid persisted options are ignored */
  }
  return { modifiers: [], legacyOptions: [] };
}

export function formatKitchenSelfOrderModifierLabels(
  modifiers: KitchenSelfOrderModifierSnapshot[],
  legacyOptions: string[] = [],
): string[] {
  return [
    ...sanitizeKitchenSelfOrderModifiers(modifiers).map((modifier) =>
      `${modifier.groupName}: ${modifier.optionName}${modifier.quantity > 1 ? ` x${modifier.quantity}` : ''}`),
    ...sanitizeKitchenSelfOrderOptions(legacyOptions),
  ];
}

export interface KitchenSelfOrderModifierValidationError {
  groupId: string;
  code: 'MIN_SELECTIONS' | 'MAX_SELECTIONS' | 'INVALID_OPTION' | 'MAX_QUANTITY';
  required?: number;
  allowed?: number;
}

export function validateKitchenSelfOrderModifierSelections(
  groups: KitchenSelfOrderModifierGroup[],
  value: unknown,
): {
  valid: boolean;
  errors: KitchenSelfOrderModifierValidationError[];
  modifiers: KitchenSelfOrderModifierSnapshot[];
  modifierTotalGrosze: number;
} {
  const requested = sanitizeKitchenSelfOrderModifiers(value);
  const normalized: KitchenSelfOrderModifierSnapshot[] = [];
  const errors: KitchenSelfOrderModifierValidationError[] = [];

  for (const group of groups) {
    const selected = requested.filter((item) => item.groupId === group.id);
    if (selected.length < group.minSelections) {
      errors.push({ groupId: group.id, code: 'MIN_SELECTIONS', required: group.minSelections });
      continue;
    }
    if (selected.length > group.maxSelections) {
      errors.push({ groupId: group.id, code: 'MAX_SELECTIONS', allowed: group.maxSelections });
      continue;
    }

    for (const selection of selected) {
      const option = group.options.find((candidate) =>
        candidate.id === selection.optionId && candidate.isAvailable !== false);
      if (!option) {
        errors.push({ groupId: group.id, code: 'INVALID_OPTION' });
        continue;
      }
      const maxQuantity = group.allowOptionQuantity
        ? Math.max(1, Math.floor(Number(option.maxQuantity) || 9))
        : 1;
      if (selection.quantity > maxQuantity) {
        errors.push({ groupId: group.id, code: 'MAX_QUANTITY', allowed: maxQuantity });
        continue;
      }
      normalized.push({
        groupId: group.id,
        groupName: group.name,
        optionId: option.id,
        optionName: option.name,
        quantity: selection.quantity,
        priceDeltaGrosze: option.priceDeltaGrosze,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    modifiers: normalized,
    modifierTotalGrosze: normalized.reduce(
      (sum, modifier) => sum + modifier.priceDeltaGrosze * modifier.quantity,
      0,
    ),
  };
}
