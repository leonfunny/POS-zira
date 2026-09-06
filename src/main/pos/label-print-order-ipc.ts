import type { IpcMain } from 'electron';
import {
  PRINT_ORDER_CHANNELS,
  type StoredPrintOrder,
} from '../../shared/label-print-order-ipc';

/** A sheet is a document, not a blob store; this is well past the worst real one. */
export const PRINT_ORDER_LIMITS = {
  id: 64,
  name: 200,
  /** Serialised sheet, in characters. A sheet carries a photo as a data URL. */
  payload: 4_000_000,
} as const;

export interface PrintOrderRepository {
  list(): StoredPrintOrder[];
  save(order: StoredPrintOrder): void;
  remove(id: string, at: string): void;
}

export interface PrintOrderSyncer {
  sync(): Promise<number>;
}

type IpcHandleRegistrar = Pick<IpcMain, 'handle'>;

export function parsePrintOrderId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('Invalid print order id: expected a non-empty string');
  }
  if (value.length > PRINT_ORDER_LIMITS.id) {
    throw new TypeError(`Invalid print order id: at most ${PRINT_ORDER_LIMITS.id} characters`);
  }
  return value;
}

/**
 * Validate renderer input before it reaches SQLite. The sheet itself is kept
 * whole on purpose — its fields belong to the label module — but it still has
 * to be an object that survives a round trip through JSON, because a value
 * that does not is a row the list can never read back.
 */
export function parsePrintOrderInput(value: unknown): StoredPrintOrder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid print order payload: expected an object');
  }
  const record = value as Record<string, unknown>;
  const id = parsePrintOrderId(record.id);

  const name = typeof record.name === 'string' ? record.name.slice(0, PRINT_ORDER_LIMITS.name) : '';

  const order = record.order;
  if (typeof order !== 'object' || order === null || Array.isArray(order)) {
    throw new TypeError('Invalid print order: expected an object');
  }
  const serialised = JSON.stringify(order);
  if (serialised === undefined) {
    throw new TypeError('Invalid print order: not serialisable');
  }
  if (serialised.length > PRINT_ORDER_LIMITS.payload) {
    throw new TypeError('Invalid print order: too large to store');
  }

  const savedAt =
    typeof record.savedAt === 'string' && !Number.isNaN(Date.parse(record.savedAt))
      ? record.savedAt
      : new Date().toISOString();

  return { id, name, savedAt, order: order as Record<string, unknown> };
}

/**
 * The sync is started but not waited for, and an unhandled rejection in the
 * main process is a crash report nobody asked for. `PrintOrderSync.sync`
 * already swallows its own failures; this does not rely on it.
 */
function syncInBackground(syncer: PrintOrderSyncer): void {
  void Promise.resolve()
    .then(() => syncer.sync())
    .catch(() => undefined);
}

export function registerPrintOrderIpcHandlers(
  ipc: IpcHandleRegistrar,
  repository: PrintOrderRepository,
  syncer: PrintOrderSyncer,
): void {
  ipc.handle(PRINT_ORDER_CHANNELS.list, () => repository.list());

  ipc.handle(PRINT_ORDER_CHANNELS.save, (_event, input: unknown) => {
    repository.save(parsePrintOrderInput(input));
    // The list is answered from the local copy first, so the panel updates at
    // once whether or not the shop has a line to the server right now.
    const list = repository.list();
    syncInBackground(syncer);
    return list;
  });

  ipc.handle(PRINT_ORDER_CHANNELS.remove, (_event, id: unknown) => {
    repository.remove(parsePrintOrderId(id), new Date().toISOString());
    const list = repository.list();
    syncInBackground(syncer);
    return list;
  });

  ipc.handle(PRINT_ORDER_CHANNELS.sync, async () => {
    await syncer.sync();
    return repository.list();
  });
}
