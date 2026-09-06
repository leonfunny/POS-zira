/**
 * Keeps print orders so staff do not retype an A4 sheet to reprint it.
 *
 * The saved sheets belong to the salon and live on the server, mirrored into
 * the app database; browser storage still holds what belongs to the machine
 * doing the typing — the draft, the run in progress, and the lists this
 * machine has been taught.
 */
import type {
  PrintOrdersBridge,
  StoredPrintOrder,
} from '../../../shared/label-print-order-ipc';
import {
  LABEL_PRINT_ORDER_LIMITS,
  LabelPrintOrder,
  MAX_SIZE_LABEL_CHARS,
  SIZE_SUGGESTIONS,
  STYLE_SUGGESTIONS,
  createEmptyOrder,
} from '../../../shared/label-print-order';

const DRAFT_KEY = 'zira.labelPrintOrder.draft';
const SAVED_KEY = 'zira.labelPrintOrder.saved';
/**
 * Which saved order the draft on screen belongs to. Without it, reopening the
 * app forgets the link and Save files a second copy under the same name, which
 * is what staff hit after editing an order the next morning.
 */
const DRAFT_ID_KEY = 'zira.labelPrintOrder.draftId';
/**
 * How far the last run got. One record, not one per order: the machine has one
 * operator and one pair of printers, so only the run that was interrupted is
 * worth remembering.
 */
const PROGRESS_KEY = 'zira.labelPrintOrder.progress';
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

export interface PrintProgressRecord {
  orderId: string;
  /**
   * Steps handed to the printer. Not "printed": the printer takes a batch and
   * can jam on it afterwards, which is why the panel makes the operator count
   * the labels rather than carrying on by itself.
   */
  completedIds: string[];
  /** Epoch ms, so a stale record can be shown with its age if that ever helps. */
  at: number;
}

/** Written after every batch — a jam that ends in the app being closed never
 *  reaches the end of the run. */
export function saveProgress(orderId: string, completedIds: string[]): void {
  if (!orderId || completedIds.length === 0) return;
  write(PROGRESS_KEY, { orderId, completedIds, at: Date.now() });
}

/** Only for the order asked about: another order's run says nothing here. */
export function loadProgress(orderId: string): PrintProgressRecord | null {
  const raw = read<Partial<PrintProgressRecord> | null>(PROGRESS_KEY, null);
  if (!raw || raw.orderId !== orderId || !Array.isArray(raw.completedIds)) return null;
  const completedIds = raw.completedIds.filter((id): id is string => typeof id === 'string');
  if (completedIds.length === 0) return null;
  return { orderId, completedIds, at: typeof raw.at === 'number' ? raw.at : 0 };
}

export function clearProgress(): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(PROGRESS_KEY);
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

/**
 * A short list this machine has been taught, on top of a built-in one: size
 * columns, style names. A shop that works in "3XL" or "KOMPLET DRESOWY" types
 * it once and gets it offered afterwards.
 *
 * Kept out of the order and out of clearDraft on purpose: it belongs to the
 * machine, not to the sheet being typed, so starting a new order does not make
 * the shop teach it again.
 */
export const LEARNED_LIMIT = 24;

interface LearnedList {
  load(): string[];
  /** Teach one. Returns the list as it now stands. */
  remember(value: string): string[];
  /** Forget one — how a typo gets off the list. */
  forget(value: string): string[];
}

function learnedList(
  key: string,
  builtIn: readonly string[],
  maxChars: number,
): LearnedList {
  const clean = (value: string) => value.trim().toUpperCase().slice(0, maxChars);

  const load = (): string[] => {
    const stored = read<unknown>(key, []);
    if (!Array.isArray(stored)) return [];
    const seen = new Set<string>();
    const values: string[] = [];
    for (const entry of stored) {
      if (typeof entry !== 'string') continue;
      const value = clean(entry);
      // A hand-edited or older store can hold a built-in or a duplicate; both
      // would show up twice in the same list.
      if (!value || seen.has(value) || builtIn.includes(value)) continue;
      seen.add(value);
      values.push(value);
    }
    return values.slice(0, LEARNED_LIMIT);
  };

  return {
    load,
    remember(value: string): string[] {
      const next = clean(value);
      const current = load();
      if (!next || current.includes(next) || builtIn.includes(next)) return current;
      // Oldest out when full: a typo taught once should not hold a slot forever.
      const grown = [...current, next].slice(-LEARNED_LIMIT);
      write(key, grown);
      return grown;
    },
    forget(value: string): string[] {
      const next = load().filter((entry) => entry !== value);
      write(key, next);
      return next;
    },
  };
}

const sizes = learnedList(
  'zira.labelPrintOrder.learnedSizes',
  SIZE_SUGGESTIONS,
  MAX_SIZE_LABEL_CHARS,
);
export const loadLearnedSizes = sizes.load;
export const rememberSize = sizes.remember;
export const forgetSize = sizes.forget;

/**
 * Style names. Learned when an order is saved or printed rather than while it
 * is typed: a free-text field has no moment where the operator says "done", and
 * learning on every keystroke would fill the list with "K", "KU", "KUR".
 */
const styles = learnedList(
  'zira.labelPrintOrder.learnedStyles',
  STYLE_SUGGESTIONS,
  LABEL_PRINT_ORDER_LIMITS.textChars,
);
export const loadLearnedStyles = styles.load;
export const rememberStyle = styles.remember;
export const forgetStyle = styles.forget;

/**
 * Which category each style name was last filed into, keyed the way
 * `resolveOrderCategory` reads it. Learned when a sheet is filed, not when a
 * category is picked: the pick may be a slip, the filing is the decision.
 * Bounded like the other learned lists — oldest key out when full.
 */
const STYLE_CATEGORY_KEY = 'zira.labelPrintOrder.styleCategories';
export const STYLE_CATEGORY_LIMIT = 48;

export function loadStyleCategories(): Record<string, string> {
  const stored = read<unknown>(STYLE_CATEGORY_KEY, {});
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const entries = Object.entries(stored as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && entry[1].trim().length > 0 && entry[0].trim().length > 0,
  );
  return Object.fromEntries(entries.slice(-STYLE_CATEGORY_LIMIT));
}

export function rememberStyleCategory(
  styleKey: string,
  categoryId: string,
): Record<string, string> {
  const key = styleKey.trim();
  const id = categoryId.trim();
  const current = loadStyleCategories();
  if (!key || !id) return current;
  // Re-inserted at the end so a style filed again counts as recent.
  const { [key]: _previous, ...rest } = current;
  const entries = [...Object.entries(rest), [key, id] as [string, string]].slice(
    -STYLE_CATEGORY_LIMIT,
  );
  const next = Object.fromEntries(entries);
  write(STYLE_CATEGORY_KEY, next);
  return next;
}


/**
 * The saved sheets live on the server now, mirrored into the app database, so
 * a broken machine is no longer a retyped catalogue. Browser storage stays as
 * the fallback for anything running without the bridge — a browser, the tests
 * — and as the place the sheets typed before this change are read from once,
 * on the way up.
 */
function bridge(): PrintOrdersBridge | null {
  try {
    return window.electronAPI?.pos?.labelPrintOrders ?? null;
  } catch {
    return null;
  }
}

function toSaved(entry: StoredPrintOrder): SavedPrintOrder {
  return { id: entry.id, savedAt: entry.savedAt, order: entry.order as unknown as LabelPrintOrder };
}

function localSavedOrders(): SavedPrintOrder[] {
  const stored = read<SavedPrintOrder[]>(SAVED_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (entry): entry is SavedPrintOrder =>
      !!entry && typeof entry.id === 'string' && !!entry.order && typeof entry.order === 'object',
  );
}

/**
 * Hand the sheets typed on this machine before the move to the server, then
 * forget them locally.
 *
 * The key is cleared only after every one of them has been handed over and
 * comes back in the list. Clearing it on the way would lose the shop's whole
 * catalogue if the app closed mid-migration — these are exactly the sheets
 * that exist nowhere else.
 */
async function migrateLegacyOrders(api: PrintOrdersBridge): Promise<void> {
  const legacy = localSavedOrders();
  if (legacy.length === 0) return;
  let list: StoredPrintOrder[] = [];
  for (const entry of legacy) {
    list = await api.save({
      id: entry.id,
      name: describeOrder(entry.order),
      savedAt: entry.savedAt ?? new Date().toISOString(),
      order: entry.order as unknown as Record<string, unknown>,
    });
  }
  const stored = new Set(list.map((entry) => entry.id));
  if (legacy.every((entry) => stored.has(entry.id))) {
    const s = store();
    try {
      s?.removeItem(SAVED_KEY);
    } catch {
      /* ignore */
    }
  }
}

export async function listSavedOrders(): Promise<SavedPrintOrder[]> {
  const api = bridge();
  if (!api) return localSavedOrders();
  await migrateLegacyOrders(api);
  return (await api.list()).map(toSaved);
}

/**
 * Store an order under `id`, replacing any earlier version of it, newest first.
 * The answer comes from this machine's copy, so saving is instant and works
 * with the line down; the sheet goes up to the server behind it.
 */
export async function saveOrder(id: string, order: LabelPrintOrder): Promise<SavedPrintOrder[]> {
  const savedAt = new Date().toISOString();
  const api = bridge();
  if (api) {
    const list = await api.save({
      id,
      name: describeOrder(order),
      savedAt,
      order: order as unknown as Record<string, unknown>,
    });
    return list.map(toSaved);
  }
  const entry: SavedPrintOrder = { id, savedAt, order };
  const rest = localSavedOrders().filter((saved) => saved.id !== id);
  const next = [entry, ...rest].slice(0, SAVED_ORDER_LIMIT);
  write(SAVED_KEY, next);
  return next;
}

export async function deleteSavedOrder(id: string): Promise<SavedPrintOrder[]> {
  const api = bridge();
  if (api) return (await api.remove(id)).map(toSaved);
  const next = localSavedOrders().filter((saved) => saved.id !== id);
  write(SAVED_KEY, next);
  return next;
}

/** A readable name for the saved list: "MoonCollection · KURTKA 114". */
export function describeOrder(order: LabelPrintOrder): string {
  const style = [order.styleName, order.styleCode].map((v) => v.trim()).filter(Boolean).join(' ');
  return [order.customerName.trim(), style].filter(Boolean).join(' · ') || 'Bez nazwy';
}
