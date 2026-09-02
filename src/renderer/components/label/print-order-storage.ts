/**
 * Keeps print orders on the machine so staff do not retype an A4 sheet to
 * reprint it. Browser storage, not the app database: this is deliberately the
 * smallest thing that survives an app restart, and it can be lifted into a
 * table once the shape has settled against real sheets.
 */
import { LabelPrintOrder, createEmptyOrder } from '../../../shared/label-print-order';

const DRAFT_KEY = 'zira.labelPrintOrder.draft';
const SAVED_KEY = 'zira.labelPrintOrder.saved';
/**
 * Which saved order the draft on screen belongs to. Without it, reopening the
 * app forgets the link and Save files a second copy under the same name, which
 * is what staff hit after editing an order the next morning.
 */
const DRAFT_ID_KEY = 'zira.labelPrintOrder.draftId';
export const SAVED_ORDER_LIMIT = 50;

export interface SavedPrintOrder {
  id: string;
  savedAt: string;
  order: LabelPrintOrder;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage can throw outright when site data is blocked.
    return null;
  }
}

function read<T>(key: string, fallback: T): T {
  const s = store();
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : (parsed as T);
  } catch {
    // A half-written or hand-edited value must not take the panel down.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or blocked storage: the order stays usable in memory */
  }
}

/** Merge onto a fresh order so a stored draft from an older shape still loads. */
export function loadDraft(): LabelPrintOrder {
  const stored = read<Partial<LabelPrintOrder> | null>(DRAFT_KEY, null);
  if (!stored || typeof stored !== 'object') return createEmptyOrder();
  const base = createEmptyOrder();
  return {
    ...base,
    ...stored,
    materials: Array.isArray(stored.materials) ? stored.materials : base.materials,
    careSymbols: Array.isArray(stored.careSymbols) ? stored.careSymbols : base.careSymbols,
    sizes: Array.isArray(stored.sizes) ? stored.sizes : base.sizes,
    rows: Array.isArray(stored.rows) ? stored.rows : base.rows,
  };
}

export function saveDraft(order: LabelPrintOrder): void {
  write(DRAFT_KEY, order);
}

export function clearDraft(): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(DRAFT_KEY);
    s.removeItem(DRAFT_ID_KEY);
  } catch {
    /* ignore */
  }
}

/** Remembers which saved order the draft is, so Save overwrites it. */
export function saveDraftId(id: string): void {
  write(DRAFT_ID_KEY, id);
}

export function loadDraftId(): string | null {
  const stored = read<unknown>(DRAFT_ID_KEY, null);
  return typeof stored === 'string' && stored ? stored : null;
}

export function listSavedOrders(): SavedPrintOrder[] {
  const stored = read<SavedPrintOrder[]>(SAVED_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (entry): entry is SavedPrintOrder =>
      !!entry && typeof entry.id === 'string' && !!entry.order && typeof entry.order === 'object',
  );
}

/**
 * Store an order under `id`, replacing any earlier version of it, newest first.
 */
export function saveOrder(id: string, order: LabelPrintOrder): SavedPrintOrder[] {
  const entry: SavedPrintOrder = { id, savedAt: new Date().toISOString(), order };
  const rest = listSavedOrders().filter((saved) => saved.id !== id);
  const next = [entry, ...rest].slice(0, SAVED_ORDER_LIMIT);
  write(SAVED_KEY, next);
  return next;
}

export function deleteSavedOrder(id: string): SavedPrintOrder[] {
  const next = listSavedOrders().filter((saved) => saved.id !== id);
  write(SAVED_KEY, next);
  return next;
}

/** A readable name for the saved list: "MoonCollection · KURTKA 114". */
export function describeOrder(order: LabelPrintOrder): string {
  const style = [order.styleName, order.styleCode].map((v) => v.trim()).filter(Boolean).join(' ');
  return [order.customerName.trim(), style].filter(Boolean).join(' · ') || 'Bez nazwy';
}
