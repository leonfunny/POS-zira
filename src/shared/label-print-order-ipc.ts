/**
 * The saved print sheets, as the renderer reaches them.
 *
 * A sheet is carried as an opaque record: its shape belongs to the label
 * module (`LabelPrintOrder`), and the main process only stores and forwards
 * it. Naming the fields here would mean editing three processes every time the
 * sheet grows one.
 */
export interface StoredPrintOrder {
  id: string;
  /** Display name, so the saved list does not have to open the sheet. */
  name: string;
  /** ISO 8601. The server's stamp once synced, this machine's until then. */
  savedAt: string;
  order: Record<string, unknown>;
}

export interface PrintOrdersBridge {
  list: () => Promise<StoredPrintOrder[]>;
  save: (order: StoredPrintOrder) => Promise<StoredPrintOrder[]>;
  remove: (id: string) => Promise<StoredPrintOrder[]>;
  /**
   * Push what this machine wrote while offline, then pull what the others
   * wrote. Returns the list as it stands afterwards. Never rejects on a
   * network failure — a workshop with no internet still prints.
   */
  sync: () => Promise<StoredPrintOrder[]>;
}

export const PRINT_ORDER_CHANNELS = {
  list: 'pos:label-print-orders:list',
  save: 'pos:label-print-orders:save',
  remove: 'pos:label-print-orders:remove',
  sync: 'pos:label-print-orders:sync',
} as const satisfies Record<keyof PrintOrdersBridge, string>;

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createPrintOrdersBridge(invoke: Invoke): PrintOrdersBridge {
  return {
    list: () => invoke(PRINT_ORDER_CHANNELS.list) as Promise<StoredPrintOrder[]>,
    save: (order) => invoke(PRINT_ORDER_CHANNELS.save, order) as Promise<StoredPrintOrder[]>,
    remove: (id) => invoke(PRINT_ORDER_CHANNELS.remove, id) as Promise<StoredPrintOrder[]>,
    sync: () => invoke(PRINT_ORDER_CHANNELS.sync) as Promise<StoredPrintOrder[]>,
  };
}
