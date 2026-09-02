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
} from '../src/renderer/components/label/print-order-storage';
import { createEmptyOrder } from '../src/shared/label-print-order';

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
    rows: [{ id: 'r1', colorName: 'CZEKOLADA', code: 'SP006290', quantities: { s: 40 } }],
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

describe('saved orders let staff reprint without retyping', () => {
  it('stores and lists an order', () => {
    saveOrder('order-1', sample());
    const saved = listSavedOrders();
    expect(saved).toHaveLength(1);
    expect(saved[0].order.customerName).toBe('MoonCollection');
    expect(saved[0].savedAt).toBeTruthy();
  });

  it('replaces an order saved under the same id rather than duplicating it', () => {
    saveOrder('order-1', sample());
    saveOrder('order-1', { ...sample(), customerName: 'H&M' });
    const saved = listSavedOrders();
    expect(saved).toHaveLength(1);
    expect(saved[0].order.customerName).toBe('H&M');
  });

  it('keeps the newest first', () => {
    saveOrder('a', sample());
    saveOrder('b', { ...sample(), customerName: 'Second' });
    expect(listSavedOrders().map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('caps the list so storage cannot grow without bound', () => {
    for (let i = 0; i < SAVED_ORDER_LIMIT + 5; i++) saveOrder(`order-${i}`, sample());
    expect(listSavedOrders()).toHaveLength(SAVED_ORDER_LIMIT);
  });

  it('deletes one order', () => {
    saveOrder('a', sample());
    saveOrder('b', sample());
    expect(deleteSavedOrder('a').map((s) => s.id)).toEqual(['b']);
  });

  it('drops malformed entries instead of rendering them', () => {
    localStorage.setItem(
      'zira.labelPrintOrder.saved',
      JSON.stringify([{ id: 'ok', order: {} }, null, { id: 42 }, { order: {} }]),
    );
    expect(listSavedOrders().map((s) => s.id)).toEqual(['ok']);
  });

  it('survives a corrupt saved list', () => {
    localStorage.setItem('zira.labelPrintOrder.saved', '[[[');
    expect(listSavedOrders()).toEqual([]);
  });
});

describe('describeOrder', () => {
  it('names an order by customer and style', () => {
    expect(describeOrder(sample())).toBe('MoonCollection · KURTKA 114');
  });

  it('copes with a half-filled header', () => {
    expect(describeOrder({ ...createEmptyOrder(), customerName: 'MoonCollection' })).toBe(
      'MoonCollection',
    );
  });

  it('never returns an empty name', () => {
    expect(describeOrder(createEmptyOrder())).toBeTruthy();
  });
});

describe('the draft remembers which saved order it is', () => {
  it('starts with no order attached', () => {
    expect(loadDraftId()).toBeNull();
  });

  it('round-trips the id, so Save after a restart overwrites the same order', () => {
    saveDraftId('order-7');
    expect(loadDraftId()).toBe('order-7');
  });

  it('lets go of the order when the sheet is cleared for a new one', () => {
    saveDraftId('order-7');
    clearDraft();
    expect(loadDraftId()).toBeNull();
  });

  it('treats a corrupt or empty stored id as no order', () => {
    localStorage.setItem('zira.labelPrintOrder.draftId', '""');
    expect(loadDraftId()).toBeNull();
    localStorage.setItem('zira.labelPrintOrder.draftId', '{not json');
    expect(loadDraftId()).toBeNull();
    localStorage.setItem('zira.labelPrintOrder.draftId', '42');
    expect(loadDraftId()).toBeNull();
  });

  it('keeps working when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveDraftId('order-7')).not.toThrow();
    expect(loadDraftId()).toBeNull();
  });
});
