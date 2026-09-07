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
  /**
   * Fires when a background sync has just written sheets to this machine.
   *
   * Without it the panel reads the list once when it opens and never again:
   * the first login after a fresh install shows an empty tab, because the
   * sheets land a second or two later and nothing asks for them. Returns the
   * unsubscribe function.
   */
  onSynced: (callback: () => void) => () => void;
}

export const PRINT_ORDER_CHANNELS = {
  list: 'pos:label-print-orders:list',
  save: 'pos:label-print-orders:save',
  remove: 'pos:label-print-orders:remove',
  sync: 'pos:label-print-orders:sync',
  /** Sent by the main process, not invoked — see notifyPosRenderers. */
  onSynced: 'pos:label-print-orders-synced',
} as const satisfies Record<keyof PrintOrdersBridge, string>;

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** The two halves of ipcRenderer this bridge needs, named so the shared file
 *  does not depend on Electron's types. */
export interface PrintOrderEvents {
  on: (channel: string, listener: () => void) => void;
  off: (channel: string, listener: () => void) => void;
}

export function createPrintOrdersBridge(
  invoke: Invoke,
  events: PrintOrderEvents,
): PrintOrdersBridge {
  return {
    list: () => invoke(PRINT_ORDER_CHANNELS.list) as Promise<StoredPrintOrder[]>,
    save: (order) => invoke(PRINT_ORDER_CHANNELS.save, order) as Promise<StoredPrintOrder[]>,
    remove: (id) => invoke(PRINT_ORDER_CHANNELS.remove, id) as Promise<StoredPrintOrder[]>,
    sync: () => invoke(PRINT_ORDER_CHANNELS.sync) as Promise<StoredPrintOrder[]>,
    onSynced: (callback) => {
      const listener = () => callback();
      events.on(PRINT_ORDER_CHANNELS.onSynced, listener);
      return () => events.off(PRINT_ORDER_CHANNELS.onSynced, listener);
    },
  };
}
