import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  SAVED_ORDER_LIMIT,
  clearDraft,
  deleteSavedOrder,
  describeOrder,
  listSavedOrders,
  loadDraft,
  saveDraft,
  saveOrder,
  loadDraftId,
  saveDraftId,
  LEARNED_LIMIT,
  forgetSize,
  forgetStyle,
  loadLearnedSizes,
  loadLearnedStyles,
  rememberSize,
  rememberStyle,
  saveProgress,
  loadProgress,
  clearProgress,
  STYLE_CATEGORY_LIMIT,
  loadStyleCategories,
  rememberStyleCategory,
} from '../src/renderer/components/label/print-order-storage';
import {
  MAX_SIZE_LABEL_CHARS,
  SIZE_SUGGESTIONS,
  STYLE_SUGGESTIONS,
  createEmptyOrder,
} from '../src/shared/label-print-order';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sample() {
  return {
    ...createEmptyOrder(),
    customerName: 'MoonCollection',
    styleName: 'KURTKA',
    styleCode: '114',
    sizes: [{ id: 's', label: 'S' }],
    rows: [{ id: 'r1', colorName: 'CZEKOLADA', quantities: { s: 40 } }],
  };
}

describe('the draft survives an app restart', () => {
  it('returns an empty order when nothing was saved', () => {
    expect(loadDraft()).toEqual(createEmptyOrder());
  });

  it('round-trips a draft', () => {
    saveDraft(sample());
    expect(loadDraft().rows[0].quantities.s).toBe(40);
  });

  it('is cleared on request', () => {
    saveDraft(sample());
    clearDraft();
    expect(loadDraft()).toEqual(createEmptyOrder());
  });

  it('falls back to an empty order when the stored value is corrupt', () => {
    localStorage.setItem('zira.labelPrintOrder.draft', '{not json');
    expect(loadDraft()).toEqual(createEmptyOrder());
  });

  it('fills in fields a draft from an older shape is missing', () => {
    localStorage.setItem(
      'zira.labelPrintOrder.draft',
      JSON.stringify({ customerName: 'MoonCollection' }),
    );
    const draft = loadDraft();
    expect(draft.customerName).toBe('MoonCollection');
    expect(draft.rows).toEqual([]);
    expect(draft.sizes).toEqual([]);
    expect(draft.printStickers).toBe(true);
  });

  it('repairs a draft whose list fields are the wrong type', () => {
    localStorage.setItem(
      'zira.labelPrintOrder.draft',
      JSON.stringify({ rows: 'nonsense', sizes: null, materials: 3 }),
    );
    const draft = loadDraft();
    expect(draft.rows).toEqual([]);
    expect(draft.sizes).toEqual([]);
    expect(draft.materials).toEqual([]);
  });

  it('keeps working when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveDraft(sample())).not.toThrow();
    expect(loadDraft()).toEqual(createEmptyOrder());
  });

  it('keeps working when storage throws on write', () => {
    const throwing = memoryStorage();
    throwing.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    vi.stubGlobal('localStorage', throwing);
    expect(() => saveDraft(sample())).not.toThrow();
  });
});

describe('saved orders without the bridge fall back to browser storage', () => {
  it('stores and lists an order', async () => {
    await saveOrder('order-1', sample());
    const saved = await listSavedOrders();
    expect(saved).toHaveLength(1);
    expect(saved[0].order.customerName).toBe('MoonCollection');
    expect(saved[0].savedAt).toBeTruthy();
  });

  it('replaces an order saved under the same id rather than duplicating it', async () => {
    await saveOrder('order-1', sample());
    await saveOrder('order-1', { ...sample(), customerName: 'H&M' });
    const saved = await listSavedOrders();
    expect(saved).toHaveLength(1);
    expect(saved[0].order.customerName).toBe('H&M');
  });

  it('keeps the newest first', async () => {
    await saveOrder('a', sample());
    await saveOrder('b', { ...sample(), customerName: 'Second' });
    expect((await listSavedOrders()).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('caps the list so storage cannot grow without bound', async () => {
    for (let i = 0; i < SAVED_ORDER_LIMIT + 5; i++) await saveOrder(`order-${i}`, sample());
    expect(await listSavedOrders()).toHaveLength(SAVED_ORDER_LIMIT);
  });

  it('deletes one order', async () => {
    await saveOrder('a', sample());
    await saveOrder('b', sample());
    expect((await deleteSavedOrder('a')).map((s) => s.id)).toEqual(['b']);
  });

  it('drops malformed entries instead of rendering them', async () => {
    localStorage.setItem(
      'zira.labelPrintOrder.saved',
      JSON.stringify([{ id: 'ok', order: {} }, null, { id: 42 }, { order: {} }]),
    );
    expect((await listSavedOrders()).map((s) => s.id)).toEqual(['ok']);
  });

  it('survives a corrupt saved list', async () => {
    localStorage.setItem('zira.labelPrintOrder.saved', '[[[');
    expect(await listSavedOrders()).toEqual([]);
  });
});

/**
 * With the bridge present the sheets belong to the salon, not to the machine.
 * These tests stand in for the app database with an in-memory bridge and check
 * the two things that would cost the shop its catalogue: that the sheets typed
 * before this change are handed over, and that they are not dropped locally
 * until they have been.
 */
describe('saved orders with the bridge go to the server copy', () => {
  function fakeBridge(overrides: Partial<Record<string, unknown>> = {}) {
    const rows = new Map<string, { id: string; name: string; savedAt: string; order: unknown }>();
    const bridge = {
      list: vi.fn(async () => [...rows.values()].reverse()),
      save: vi.fn(async (entry: any) => {
        rows.delete(entry.id);
        rows.set(entry.id, entry);
        return [...rows.values()].reverse();
      }),
      remove: vi.fn(async (id: string) => {
        rows.delete(id);
        return [...rows.values()].reverse();
      }),
      sync: vi.fn(async () => [...rows.values()].reverse()),
      ...overrides,
    };
    vi.stubGlobal('window', { electronAPI: { pos: { labelPrintOrders: bridge } } });
    return { bridge, rows };
  }

  it('saves through the bridge instead of browser storage', async () => {
    const { bridge } = fakeBridge();
    await saveOrder('order-1', sample());
    expect(bridge.save).toHaveBeenCalledTimes(1);
    expect(bridge.save.mock.calls[0][0].order.customerName).toBe('MoonCollection');
    expect(localStorage.getItem('zira.labelPrintOrder.saved')).toBeNull();
  });

  it('carries a name, so the saved list does not have to open the sheet', async () => {
    const { bridge } = fakeBridge();
    await saveOrder('order-1', { ...sample(), styleName: 'KURTKA', styleCode: '114' });
    expect(bridge.save.mock.calls[0][0].name).toBe('MoonCollection · KURTKA 114');
  });

  it('hands over the sheets typed before the move, then forgets them locally', async () => {
    localStorage.setItem(
      'zira.labelPrintOrder.saved',
      JSON.stringify([
        { id: 'old-1', savedAt: '2026-09-01T10:00:00.000Z', order: sample() },
        { id: 'old-2', savedAt: '2026-09-02T10:00:00.000Z', order: sample() },
      ]),
    );
    const { bridge } = fakeBridge();
    const listed = await listSavedOrders();
    expect(bridge.save).toHaveBeenCalledTimes(2);
    expect(listed.map((s) => s.id).sort()).toEqual(['old-1', 'old-2']);
    expect(localStorage.getItem('zira.labelPrintOrder.saved')).toBeNull();
  });

  it('keeps the old sheets on the machine when the hand-over does not finish', async () => {
    localStorage.setItem(
      'zira.labelPrintOrder.saved',
      JSON.stringify([{ id: 'old-1', savedAt: '2026-09-01T10:00:00.000Z', order: sample() }]),
    );
    // A server that accepts the call but stores nothing: clearing the key here
    // would lose the only copy of the shop's catalogue.
    fakeBridge({ save: vi.fn(async () => []) });
    await listSavedOrders();
    expect(localStorage.getItem('zira.labelPrintOrder.saved')).not.toBeNull();
  });

  it('deletes through the bridge', async () => {
    const { bridge } = fakeBridge();
    await saveOrder('a', sample());
    await saveOrder('b', sample());
    expect((await deleteSavedOrder('a')).map((s) => s.id)).toEqual(['b']);
    expect(bridge.remove).toHaveBeenCalledWith('a');
  });
});
